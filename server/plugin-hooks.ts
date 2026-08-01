/**
 * Plugin hook bus + the central `runAgentTurn` helper.
 *
 * `runAgentTurn` is the single entry point for every send-and-await-turn
 * path: sendMessage, flushQueue, executeSkill, editMessage. It owns:
 *
 *   1. Awaiting the previous turn's afterTurnPromise (so memory writes
 *      from the prior turn land before this turn's beforeTurn retrieval).
 *      A stale promise can't poison future turns - see runAfterTurn for
 *      the self-clearing wrapper.
 *   2. Running every enabled plugin's `beforeTurn` in parallel against the
 *      same context. Per-plugin 5s race; on throw or timeout the plugin
 *      contributes no prefix and the failure goes to plugins.jsonl.
 *   3. Assembling the outbound envelope: built-in blocks first (currently just
 *      the context-fullness notice - server coordination, NOT a plugin), then
 *      per-plugin prefix blocks in alphabetical id order, each delimiter-
 *      wrapped, prepended to the outgoing text with a `User message:` separator.
 *      stripOutboundEnvelope is the exact inverse (used by edit-to-fork
 *      matching).
 *   4. beginTurn + createTurnDeferred + session.send + await turn.
 *   5. Snapshotting logCache after the caller's onSendAccepted callback
 *      runs but before the agent's turn output lands, so user_message
 *      entries logged by the caller are excluded from newLogEntries.
 *   6. Firing afterTurn for every plugin in parallel AFTER session.send
 *      was attempted, with status reflecting the post-send outcome
 *      (completed / failed / interrupted). Per-plugin 10s race. The
 *      aggregate promise is stored on `managed.afterTurnPromise` and
 *      self-clears on settle. A turn cancelled DURING plugin retrieval
 *      (Stop / session swap before session.send) skips afterTurn - the
 *      cancel-token check throws SessionSwappedError above the send
 *      lifecycle, so no afterTurn fires for a turn the backend never saw.
 *
 * Each call site keeps its own catch block because the error semantics
 * differ (SessionSwappedError on session swap, BackendNotConfiguredError
 * for setup issues, edit-fork rollback in editMessage, queue retention
 * in flushQueue). `runAgentTurn` re-throws so the caller's catch handles
 * them; the internal cleanup (rejecting the deferred if session.send threw
 * before await turn ran) is symmetric with the pre-refactor patterns in
 * each call site.
 */

import type { Attachment, LogEntry } from "../shared/types.ts";
import type {
  IsomuxPlugin,
  PluginAfterTurnInput,
  PluginTurnContext,
} from "../shared/plugin-types.ts";
import { SessionSwappedError, type ManagedAgent } from "./internal-types.ts";
import { getEnabledPlugins, logPluginFailure } from "./plugins.ts";

const BEFORE_TURN_TIMEOUT_MS = 5000;
const AFTER_TURN_TIMEOUT_MS = 10000;

export type TurnOrigin = "user" | "queued" | "skill" | "edit-fork";

export interface RunAgentTurnOpts {
  managed: ManagedAgent;
  /** What the user typed verbatim (e.g. "/grill"). For plugin context only;
   *  not sent. */
  visibleText: string;
  /** Semantic user input WITHOUT sender prefix or plugin prefix blocks. For
   *  normal sends it's the raw user text; for skills it's the expanded
   *  skill prompt; for queued flushes it's the per-item bodies joined.
   *  This is what plugins should query against / store as "the user's
   *  message" - sender prefixes like `[Nil (Phone)]` are isomux routing
   *  noise, not intent. */
  originalText: string;
  /** Pre-prefix outgoing text, with sender prefix already applied. Plugin
   *  prefix blocks (if any) get prepended; the result is what session.send
   *  actually receives. */
  sdkText: string;
  attachments?: Attachment[];
  origin: TurnOrigin;
  humanInput: boolean;
  /** Called synchronously after session.send resolves and BEFORE the
   *  newLogEntries snapshot is taken. Use this for "log only on send-
   *  accepted" patterns - flushQueue uses it to write user_message entries
   *  and drain its queue once the backend has accepted the prompt. Any
   *  entries logged here land BEFORE the snapshot and are therefore
   *  excluded from `PluginAfterTurnInput.newLogEntries`. */
  onSendAccepted?: () => void;
}

// Dependency injection: agent-manager owns beginTurn / createTurnDeferred /
// logCache / officeState as module-private state. Rather than re-export and
// pull plugin-hooks into a cycle, we wire them in once at boot.
type PluginHooksDeps = {
  beginTurn: (agentId: string, opts: { humanInput: boolean }) => void;
  createTurnDeferred: (managed: ManagedAgent) => Promise<void>;
  getLogCache: (agentId: string) => LogEntry[] | undefined;
  // Phase 3c: looked up by the agent's authoritative roomId, not a dense index.
  getRoom: (roomId: string) => { id: string; name: string } | null;
};

let deps: PluginHooksDeps | null = null;

export function configurePluginHooks(d: PluginHooksDeps): void {
  deps = d;
}

/** Owns the entire send-and-await-turn lifecycle, including plugin hooks.
 *  Throws through whatever the underlying turn threw so callers' catch
 *  blocks continue to handle SessionSwappedError / BackendNotConfiguredError
 *  / etc. with their existing semantics. */
export async function runAgentTurn(opts: RunAgentTurnOpts): Promise<void> {
  if (!deps) {
    throw new Error(
      "plugin-hooks not configured; call configurePluginHooks at boot",
    );
  }

  const {
    managed,
    sdkText,
    originalText,
    visibleText,
    attachments,
    origin,
    humanInput,
    onSendAccepted,
  } = opts;
  const agentId = managed.info.id;

  // 1. Claim the turn lifecycle immediately, BEFORE any await. The
  // afterTurnPromise gate (up to 10s) plus per-plugin beforeTurn (up to 5s
  // each) would otherwise leave the agent in idle / waiting_for_response
  // state for the duration - concurrent ingress (sendMessage, executeSkill,
  // enqueueMessage's "isQueueIdleState" branch) would see the agent as
  // not-busy and skip the queue, leading to either a deferred supersession
  // or two send() calls racing into the same backend session.
  //
  // beginTurn is idempotent on state ("thinking" → early-return), so
  // sendMessage's existing early-echo beginTurn at the top of the function
  // remains harmless when runAgentTurn re-enters from the bottom of the
  // same call.
  deps.beginTurn(agentId, { humanInput });

  // Snapshot the cancel token immediately after beginTurn. Any control-plane
  // action that would normally cancel an in-flight turn (abort, kill,
  // replaceSession via /clear / /resume / /model / /effort / edit-fork)
  // bumps this counter. We re-check after each await during the pre-send
  // window and bail with SessionSwappedError if it changed - pendingTurn
  // isn't installed yet, so the usual rejection path can't reach us.
  const cancelTokenAtEntry = managed.turnCancelToken;
  const checkCancelled = () => {
    if (managed.turnCancelToken !== cancelTokenAtEntry) {
      throw new SessionSwappedError("Turn cancelled during plugin retrieval.");
    }
  };

  // 2. Gate on the previous turn's afterTurn. The promise stored on
  // `managed.afterTurnPromise` self-clears via runAfterTurn's .finally
  // hook, so even a previously timed-out afterTurn doesn't block this turn.
  if (managed.afterTurnPromise) {
    try {
      await managed.afterTurnPromise;
    } catch {
      // runAfterTurn catches plugin throws internally; defensive in case a
      // future hook here is added that can throw.
    }
    checkCancelled();
  }

  // 3. Build the plugin context. getRoom may return null if the agent's
  // roomId somehow names no live room (shouldn't happen, but defensive).
  const room = deps.getRoom(managed.info.roomId);
  const ctx: PluginTurnContext = {
    agentId,
    agentName: managed.info.name,
    roomId: room?.id ?? "",
    roomName: room?.name ?? "",
    sessionId: managed.sessionId,
    cwd: managed.info.cwd,
    username: managed.info.username,
    userId: managed.info.userId,
    visibleText,
    originalText,
    sdkText,
  };

  // 4. Run beforeTurn for every enabled plugin in parallel. getEnabledPlugins
  // already returns entries sorted by id; we preserve that order in the
  // assembled prefix.
  const loaded = getEnabledPlugins();
  const prefixes: Array<{ id: string; prefix: string }> = [];
  if (loaded.length > 0) {
    const results = await Promise.all(
      loaded.map(async ({ plugin }) => {
        const prefix = await runOneBeforeTurn(plugin, ctx, origin);
        return prefix ? { id: plugin.id, prefix } : null;
      }),
    );
    for (const r of results) {
      if (r) prefixes.push(r);
    }
    // beforeTurn could have taken up to BEFORE_TURN_TIMEOUT_MS per plugin;
    // re-check the cancel token before committing to send.
    checkCancelled();
  }

  // 4b. Built-in outbound blocks (server coordination, NOT plugins - no
  // enable/disable coupling, absent from plugin discovery + failure
  // accounting): the context-fullness notice and the session-start memory-size
  // notice. Computed after the plugin loop so the just-finished turn's
  // fire-and-forget sample has the most time to land; the bounded await inside
  // caps the added latency (~500ms worst case, and only on turns where a sample
  // is still in flight).
  const contextNotice = await buildContextNoticeBlock(managed);
  // The await above can straddle a Stop / session swap.
  checkCancelled();
  // Read AFTER that await for the same reason: a session swap in the window
  // re-arms the slot, and we want the value we are actually about to send.
  // `gen` is captured with it, for the same send-accept guard the context
  // notice uses - everything from here to session.send() is synchronous.
  const memoryNotice = managed.memoryNotice
    ? { block: managed.memoryNotice, gen: managed.contextGen }
    : null;

  // 5. Assemble the outbound envelope: built-in blocks first, then plugin
  // blocks in sorted order, then the user payload. Built-ins get their own
  // reserved `isomux:` delimiter (NOT a fake plugin id) so stripOutboundEnvelope
  // round-trips them for edit-to-fork matching.
  const envelopeBlocks: string[] = [];
  if (contextNotice) {
    envelopeBlocks.push(
      `--- begin isomux: context-check ---\n${contextNotice.block}\n--- end isomux: context-check ---`,
    );
  }
  if (memoryNotice) {
    envelopeBlocks.push(
      `--- begin isomux: memory-check ---\n${memoryNotice.block}\n--- end isomux: memory-check ---`,
    );
  }
  for (const { id, prefix } of prefixes) {
    envelopeBlocks.push(
      `--- begin plugin: ${id} ---\n${prefix}\n--- end plugin: ${id} ---`,
    );
  }
  let finalText = sdkText;
  if (envelopeBlocks.length > 0) {
    finalText = `${envelopeBlocks.join("\n\n")}${USER_MESSAGE_SEPARATOR}${sdkText}`;
  }

  // Final pre-send cancel check. Catches a Stop/swap that fires after the
  // beforeTurn loop returned but before createTurnDeferred runs - small
  // window but legitimately reachable since assembling the prefix yields
  // the microtask queue.
  checkCancelled();

  // 6. Install the per-turn deferred. Held close to session.send so we don't
  // park a pendingTurn through the plugin retrieval phase - the state gate
  // above is what serializes turns; pendingTurn is what makes session.send /
  // await turn cancellable on session swap.
  const turn = deps.createTurnDeferred(managed);
  const ownPending = managed.pendingTurn;

  // 7. Send. Snapshot the logCache AFTER onSendAccepted runs but BEFORE the
  // agent's turn output starts arriving via processNormalizedEvent - that's
  // the window in which "new entries produced by this turn" is well-defined.
  let snapshotIdx = 0;
  let status: PluginAfterTurnInput["status"] = "completed";
  let thrown: unknown = undefined;

  try {
    if (!managed.session) {
      throw new Error("Cannot send: agent has no session.");
    }
    await managed.session.send(
      finalText,
      attachments && attachments.length > 0 ? attachments : undefined,
    );
    // Send accepted: consume the fullness notice NOW (never before send, so a
    // failed send doesn't burn a once-per-generation notice). The sample-commit
    // path never touches this set, so runAgentTurn is its sole mutator - see
    // internal-types.ts firedAgentThresholds.
    //
    // Generation guard: `session.send()` can straddle a replaceSession swap
    // (/clear, resume-to-different-id, edit-fork). If the OLD session's send
    // resolves AFTER a reset, the live set is the NEW generation's fresh one -
    // marking it here would burn its notice. Only mark when the generation is
    // unchanged. We guard on `contextGen`, NOT session identity or the cancel
    // token: a model/effort restart swaps the session (and bumps the cancel
    // token) but CONTINUES the same conversation, keeping the same fired-set -
    // there the notice really did go out on the old session's now-resumed
    // transcript, so marking is correct and a session/token guard would wrongly
    // let it re-fire next turn. `contextGen` bumps iff the conversation reset,
    // which is exactly iff the fired-set was replaced.
    if (contextNotice && managed.contextGen === contextNotice.gen) {
      markContextThresholdFired(managed, contextNotice.threshold);
    }
    // Same never-before-send rule for the memory notice: a failed send must not
    // burn it. Generation guard for the same reason as above, and it has to be
    // the generation rather than a comparison against the slot's current text:
    // strings compare BY VALUE, so a /clear during the send that re-armed an
    // identically-worded notice would look like the one we just sent and burn a
    // notice that never went out.
    if (memoryNotice && managed.contextGen === memoryNotice.gen) {
      managed.memoryNotice = null;
      managed.memoryNoticeFired = true;
    }
    if (onSendAccepted) {
      try {
        onSendAccepted();
      } catch (err) {
        // onSendAccepted is caller-controlled (typically log entries +
        // queue drain). A throw here would be a caller bug - the turn is
        // already in flight on the backend, so we log and continue.
        console.error(`[runAgentTurn] onSendAccepted threw:`, err);
      }
    }
    snapshotIdx = deps.getLogCache(agentId)?.length ?? 0;
    await turn;
  } catch (err) {
    thrown = err;
    // Symmetric with the pre-refactor patterns in sendMessage / flushQueue /
    // executeSkill / editMessage: if session.send (or anything before
    // `await turn`) threw, the deferred we installed is still parked in
    // managed.pendingTurn - reject + clear only when we still own it so
    // awaiting callers don't hang and concurrent abort/state logic doesn't
    // observe a phantom in-flight turn.
    if (ownPending && managed.pendingTurn === ownPending) {
      managed.pendingTurn = null;
      try {
        ownPending.reject(err);
      } catch {
        // Already-rejected deferred - fine.
      }
    }
    // SessionSwappedError = user-initiated swap (abort, /resume, /model,
    // /effort, /clear, editMessage fork install) OR a pre-send cancel
    // detected by checkCancelled above. Map to "interrupted" so plugins
    // can distinguish from real failures.
    status = err instanceof SessionSwappedError ? "interrupted" : "failed";
  }

  // 8. Fire afterTurn for every plugin. Even on failure / interruption -
  // memory plugins may want to observe the boundary, audit plugins always
  // want the record, etc. The aggregate promise self-clears on settle.
  if (loaded.length > 0) {
    const allEntries = deps.getLogCache(agentId) ?? [];
    const newLogEntries = allEntries.slice(snapshotIdx);
    const input: PluginAfterTurnInput = {
      status,
      userTextSent: finalText,
      assistantText: assistantTextFromEntries(newLogEntries),
      newLogEntries,
    };
    managed.afterTurnPromise = runAfterTurn(
      loaded.map((lp) => lp.plugin),
      ctx,
      input,
      origin,
      managed,
    );
  }

  if (thrown !== undefined) {
    // Re-throw whatever the underlying turn threw so the caller's catch
    // handles its own error semantics. Cast through Error: every realistic
    // throw site (session.send / await turn / pre-send guards) produces an
    // Error subclass.
    throw thrown as Error;
  }
}

// ---------------------------------------------------------------------------
// stripOutboundEnvelope - inverse of the wrap built in runAgentTurn step 5
// ---------------------------------------------------------------------------

const USER_MESSAGE_SEPARATOR = "\n\nUser message:\n";

// Boundary between the final envelope block and the user payload, anchored on
// the full closing line of EITHER a built-in (`isomux`) or plugin block so we
// don't false-strip on a `---` substring that happens to precede the separator
// inside a block body (e.g. a stored memory that ends with `---`). Plugin ids
// are constrained to `[a-z0-9_-]+` in persistence.ts:726; the built-in ids
// (`context-check`, `memory-check`) match the same grammar. Requiring the
// separator right after the closing line is also what makes this find the LAST
// block when several fire on the same turn.
const END_ENVELOPE_AND_SEPARATOR =
  /(?:^|\n)--- end (?:isomux|plugin): [a-z0-9_-]+ ---\n\nUser message:\n/;

/** Recover the unwrapped `sdkText` from a backend-recorded user message.
 *
 *  When at least one built-in block (the context-fullness notice) or a
 *  `beforeTurn` plugin returned a non-empty prefix, `runAgentTurn` rewrites the
 *  outgoing text as `${blocks}${USER_MESSAGE_SEPARATOR}${sdkText}` (see step 5
 *  above). The backend persists the wrapped form into its session transcript,
 *  but the isomux log entry only carries the unwrapped `sdkText`. Edit-message
 *  matching needs the two to line up, so this helper strips the wrap back off.
 *
 *  Returns the input unchanged when no wrap is present (no built-in block fired,
 *  no plugin contributed a prefix this turn, or the text isn't a user message at
 *  all). Two guards keep regular user text safe from accidental stripping:
 *    1. The text must start with `--- begin isomux: ` or `--- begin plugin: ` -
 *       a user whose message happens to contain the separator pattern but didn't
 *       open with a begin marker is left alone.
 *    2. The boundary regex matches the FULL `--- end (isomux|plugin): <id> ---`
 *       closing line shape (not just three dashes), so a block body containing
 *       `---` immediately before a stray separator can't short-circuit the split.
 *  The FIRST match wins, which is the structural boundary - anything that looks
 *  like the pattern in the user payload comes later in the string. Old
 *  transcripts (plugin-only wraps) strip identically: the plugin grammar is
 *  unchanged, strictly extended with the `isomux` alternative. */
export function stripOutboundEnvelope(text: string): string {
  if (
    !text.startsWith("--- begin isomux: ") &&
    !text.startsWith("--- begin plugin: ")
  ) {
    return text;
  }
  const m = END_ENVELOPE_AND_SEPARATOR.exec(text);
  if (!m) return text;
  return text.slice(m.index + m[0].length);
}

// ---------------------------------------------------------------------------
// Built-in context-fullness notices (task 50392514)
//
// Design: internal-docs/context-fullness-visibility.md §2. The server injects a
// one-line fullness notice into the agent's NEXT outbound message the first time
// the conversation crosses each threshold, so system-prompt rules like "wrap up
// past 200k" fire even when the agent never thinks to poll GET .../context.
// Reads live on ManagedAgent (contextUsage / contextSampleInFlight /
// firedAgentThresholds) - no dependency injection needed; the fired-set is
// reset/restored by resetContextUsage in agent-manager at conversation
// boundaries.
// ---------------------------------------------------------------------------

// How long the pre-send step waits for the just-finished turn's fire-and-forget
// sample to land before proceeding with whatever snapshot is already committed.
// A notice delayed by one turn beats delaying every send.
const CONTEXT_NOTICE_SAMPLE_WAIT_MS = 500;

// Fullness thresholds (raw percentage), ascending. Once each per conversation
// generation, per audience: the agent-facing injected notice here, and the
// boss-facing ephemeral chat line (agent-manager's maybeEmitUiContextNotice)
// share the SAME bands but separate fired-sets. Kept in step with the UI color
// bands in the design doc §3 (50 = orange/plan-around-it, 75 = red/wrap-up).
export const CONTEXT_NOTICE_THRESHOLDS = [50, 75] as const;

export function formatContextNotice(
  threshold: number,
  snap: { totalTokens: number; maxTokens: number; percentage: number },
): string {
  const pct = Math.round(snap.percentage);
  const used = snap.totalTokens.toLocaleString("en-US");
  const max = snap.maxTokens.toLocaleString("en-US");
  const advice =
    threshold >= 75
      ? "Wrap up: finish or hand off current work; tell the boss a /clear is advisable."
      : "Budget accordingly.";
  return `[context check: ${pct}% full - ${used} / ${max} tokens. ${advice}]`;
}

// ---------------------------------------------------------------------------
// Built-in session-start memory-size notice (task f1a08f05)
//
// Auto-loaded memory is capped per scope (memory-store MEMORY_CAPS) and
// renderCapped omits the OLDEST lines of an over-cap scope. That is not silent
// - it appends OVER_CAP_NOTICE to the rendered layer - but it is a passive line
// in the system prompt, delivered only once the cap is already exceeded. This
// notice arrives as a MESSAGE, which asks for a decision, and it fires BEFORE
// the cap is reached so the trimming can happen while nothing is being left
// out yet. A message rather than a prompt line is also deliberate: a size
// figure in the system prompt would change on every write, which is the kind of
// per-agent variability the prompt keeps out (task 46f86536).
//
// Armed by agent-manager at session creation (it already renders memory there)
// and consumed here on the first accepted send of the conversation.
// ---------------------------------------------------------------------------

// A scope this full (fraction of its cap) is worth telling the agent about.
// At 1.0 the oldest facts are already being dropped; 0.8 gives the boss a
// chance to curate before that happens.
export const MEMORY_NOTICE_FILL_RATIO = 0.8;

/** The session-start memory notice, or null when every scope is comfortably
 *  under its cap. Scopes are listed fullest first, and only the ones at or over
 *  the ratio are named - the point is what to trim, not an inventory. */
export function formatMemoryNotice(
  measurements: readonly {
    label: string;
    contentChars: number;
    cap: number;
  }[],
): string | null {
  const full = measurements
    .map((m) => ({ label: m.label, fill: m.contentChars / m.cap }))
    .filter((m) => m.fill >= MEMORY_NOTICE_FILL_RATIO)
    .sort((a, b) => b.fill - a.fill);
  if (full.length === 0) return null;
  const listed = full
    .map((m) => `${m.label} at ${Math.round(m.fill * 100)}% of cap`)
    .join(", ");
  return (
    `[memory check: auto-loaded memory is near its size limit - ${listed}. ` +
    `When a scope exceeds its cap, its oldest facts are omitted from your context. ` +
    `Mention this to the boss and offer to propose specific trims; ` +
    `apply them through the memory READ + PUT API only after approval. ` +
    `The boss can also edit memory in Settings.]`
  );
}

/** The highest fullness threshold newly reached (percentage >= threshold) but
 *  not yet fired this generation, or null. Pure read - never mutates the fired
 *  set. Uses the raw float percentage, never a rounded display value. */
export function pickContextThreshold(managed: ManagedAgent): number | null {
  const snap = managed.contextUsage;
  if (!snap) return null;
  let chosen: number | null = null;
  for (const t of CONTEXT_NOTICE_THRESHOLDS) {
    if (snap.percentage >= t && !managed.firedAgentThresholds.has(t))
      chosen = t;
  }
  return chosen;
}

/** Bounded-await the in-flight sample so the notice reflects the just-finished
 *  turn, then evaluate thresholds against the current snapshot (re-read AFTER
 *  the await, so a mid-await conversation reset degrades cleanly to null). If
 *  the first sample clears multiple bands at once (e.g. lands at 87%), only the
 *  HIGHEST newly-reached band is emitted. Does NOT mark the threshold fired -
 *  that happens only once the send is accepted, so a failed/swapped send never
 *  burns a notice. Captures `contextGen` for the send-accept guard: everything
 *  from here to `session.send()` is synchronous, so this equals the generation
 *  in effect at send time - a reset during the send await bumps `contextGen`
 *  (and replaces the fired-set), and the guard then skips the stale mark. */
async function buildContextNoticeBlock(
  managed: ManagedAgent,
): Promise<{ threshold: number; block: string; gen: number } | null> {
  const inFlight = managed.contextSampleInFlight;
  if (inFlight) {
    await Promise.race([
      inFlight,
      new Promise<void>((res) =>
        setTimeout(res, CONTEXT_NOTICE_SAMPLE_WAIT_MS),
      ),
    ]);
  }
  const threshold = pickContextThreshold(managed);
  // pickContextThreshold returns non-null only when contextUsage is present.
  if (threshold === null || !managed.contextUsage) return null;
  return {
    threshold,
    block: formatContextNotice(threshold, managed.contextUsage),
    gen: managed.contextGen,
  };
}

/** Mark `threshold` and every lower threshold fired for this generation. When a
 *  first sample clears multiple bands, only the highest emitted a notice, but
 *  all lower ones are consumed here so they never fire redundantly on a later
 *  turn. The set is reset with the conversation generation (resetContextUsage). */
export function markContextThresholdFired(
  managed: ManagedAgent,
  threshold: number,
): void {
  for (const t of CONTEXT_NOTICE_THRESHOLDS) {
    if (t <= threshold) managed.firedAgentThresholds.add(t);
  }
}

// ---------------------------------------------------------------------------
// beforeTurn - per-plugin race with timeout
// ---------------------------------------------------------------------------

async function runOneBeforeTurn(
  p: IsomuxPlugin,
  ctx: PluginTurnContext,
  origin: TurnOrigin,
): Promise<string | null> {
  if (!p.beforeTurn) return null;

  const start = Date.now();
  // `timedOut` lets the underlying work's catch suppress its log if the race
  // already resolved with timeout. Avoids a double-log when both the timeout
  // AND a late throw fire.
  let timedOut = false;

  // Wrap the underlying work so a late rejection after the race resolves
  // doesn't become an unhandledRejection.
  const work = (async () => {
    try {
      const r = await p.beforeTurn!(ctx);
      return r ?? null;
    } catch (err) {
      if (!timedOut) {
        logPluginFailure({
          pluginId: p.id,
          hook: "beforeTurn",
          agentId: ctx.agentId,
          roomId: ctx.roomId,
          origin,
          durationMs: Date.now() - start,
          error: err,
        });
      }
      return null;
    }
  })();

  const winner = await Promise.race([
    work.then((r) => ({ kind: "ok" as const, r })),
    new Promise<{ kind: "timeout" }>((res) =>
      setTimeout(() => res({ kind: "timeout" }), BEFORE_TURN_TIMEOUT_MS),
    ),
  ]);

  if (winner.kind === "timeout") {
    timedOut = true;
    logPluginFailure({
      pluginId: p.id,
      hook: "beforeTurn",
      agentId: ctx.agentId,
      roomId: ctx.roomId,
      origin,
      durationMs: BEFORE_TURN_TIMEOUT_MS,
      error: new Error(
        `beforeTurn timed out after ${BEFORE_TURN_TIMEOUT_MS}ms`,
      ),
    });
    return null;
  }

  return normalizeBeforeTurnResult(p, winner.r, ctx, origin, start);
}

/** Validate a plugin's beforeTurn return value and extract the prefix string.
 *  A malformed shape - non-object return, or `promptPrefix` that isn't a
 *  string - must NOT crash the turn (the spec is explicit: plugin errors
 *  never fail the turn). Instead we log the malformation to plugins.jsonl
 *  and return null, dropping the plugin's contribution for this turn. The
 *  isolation boundary lives here so callers can't accidentally route an
 *  unsafe value into the prompt-assembly path.
 *
 *  Accepts: null/undefined (no contribution), `{}` (no contribution),
 *  `{ promptPrefix: string }` (the canonical shape), `{ promptPrefix: null }`
 *  (treated as no contribution).
 *  Rejects-with-log: primitives, arrays, `{ promptPrefix: <non-string> }`. */
function normalizeBeforeTurnResult(
  p: IsomuxPlugin,
  value: unknown,
  ctx: PluginTurnContext,
  origin: TurnOrigin,
  startMs: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    logPluginFailure({
      pluginId: p.id,
      hook: "beforeTurn",
      agentId: ctx.agentId,
      roomId: ctx.roomId,
      origin,
      durationMs: Date.now() - startMs,
      error: new Error(
        `beforeTurn must return an object or void; got ${Array.isArray(value) ? "array" : typeof value}`,
      ),
    });
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!("promptPrefix" in obj)) return null;
  const prefix = obj.promptPrefix;
  if (prefix === undefined || prefix === null) return null;
  if (typeof prefix !== "string") {
    logPluginFailure({
      pluginId: p.id,
      hook: "beforeTurn",
      agentId: ctx.agentId,
      roomId: ctx.roomId,
      origin,
      durationMs: Date.now() - startMs,
      error: new Error(
        `beforeTurn promptPrefix must be a string; got ${typeof prefix}`,
      ),
    });
    return null;
  }
  const trimmed = prefix.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// afterTurn - per-plugin race, self-clearing aggregate promise
// ---------------------------------------------------------------------------

function runAfterTurn(
  plugins: IsomuxPlugin[],
  ctx: PluginTurnContext,
  input: PluginAfterTurnInput,
  origin: TurnOrigin,
  managed: ManagedAgent,
): Promise<void> {
  // The settled aggregate of all per-plugin races. runOneAfterTurn catches
  // throws and timeouts internally, so this never rejects.
  const settled: Promise<void> = Promise.all(
    plugins.map((p) => runOneAfterTurn(p, ctx, input, origin)),
  ).then(() => undefined);

  // Wrap with a self-clearing finally - a timed-out plugin must not leave a
  // stale promise blocking every future turn. Identity-compare via the
  // wrapping `self` so we only null the slot if it still points at this
  // turn's promise (a later turn may have overwritten it).
  const self: Promise<void> = settled.finally(() => {
    if (managed.afterTurnPromise === self) {
      managed.afterTurnPromise = null;
    }
  });

  return self;
}

async function runOneAfterTurn(
  p: IsomuxPlugin,
  ctx: PluginTurnContext,
  input: PluginAfterTurnInput,
  origin: TurnOrigin,
): Promise<void> {
  if (!p.afterTurn) return;

  const start = Date.now();
  let timedOut = false;

  const work = (async () => {
    try {
      await p.afterTurn!(ctx, input);
    } catch (err) {
      if (!timedOut) {
        logPluginFailure({
          pluginId: p.id,
          hook: "afterTurn",
          agentId: ctx.agentId,
          roomId: ctx.roomId,
          origin,
          durationMs: Date.now() - start,
          error: err,
        });
      }
    }
  })();

  const winner = await Promise.race([
    work.then(() => "ok" as const),
    new Promise<"timeout">((res) =>
      setTimeout(() => res("timeout"), AFTER_TURN_TIMEOUT_MS),
    ),
  ]);

  if (winner === "timeout") {
    timedOut = true;
    logPluginFailure({
      pluginId: p.id,
      hook: "afterTurn",
      agentId: ctx.agentId,
      roomId: ctx.roomId,
      origin,
      durationMs: AFTER_TURN_TIMEOUT_MS,
      error: new Error(`afterTurn timed out after ${AFTER_TURN_TIMEOUT_MS}ms`),
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concatenate all `text` log entries from the turn's slice, in chronological
 *  order, joined with blank-line separators. Tool-using turns emit text →
 *  tool_call → text patterns, and a memory/audit plugin needs the agent's
 *  full natural-language output, not just the last span. Empty/whitespace-
 *  only entries are dropped so the join doesn't produce stray blank lines.
 *  Returns empty string when no text entry landed (failed/interrupted
 *  turns before any assistant text streamed). */
function assistantTextFromEntries(entries: LogEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.kind !== "text") continue;
    if (typeof e.content !== "string") continue;
    const trimmed = e.content.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }
  return parts.join("\n\n");
}
