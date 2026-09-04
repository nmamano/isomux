/**
 * Central `runAgentTurn` helper and outbound server notices.
 *
 * `runAgentTurn` is the single entry point for every send-and-await-turn
 * path: sendMessage, flushQueue, executeSkill, editMessage. It owns:
 *
 *   1. Assembling the outbound envelope from built-in blocks (the wake,
 *      context-fullness and memory-size notices - server coordination, NOT
 *      plugins), prepended to the outgoing text with a `User message:` separator.
 *      stripOutboundEnvelope is the exact inverse (used by edit-to-fork
 *      matching).
 *   2. beginTurn + createTurnDeferred + session.send + await turn.
 *
 * Each call site keeps its own catch block because the error semantics
 * differ (SessionSwappedError on session swap, BackendNotConfiguredError
 * for setup issues, edit-fork rollback in editMessage, queue retention
 * in flushQueue). `runAgentTurn` re-throws so the caller's catch handles
 * them; the internal cleanup (rejecting the deferred if session.send threw
 * before await turn ran) is symmetric with the pre-refactor patterns in
 * each call site.
 */

import type { Attachment } from "../shared/types.ts";
import { SessionSwappedError, type ManagedAgent } from "./internal-types.ts";

export interface RunAgentTurnOpts {
  managed: ManagedAgent;
  /** Outgoing text with sender prefix already applied. */
  sdkText: string;
  attachments?: Attachment[];
  humanInput: boolean;
  /** Called synchronously after session.send resolves. Use this for "log only
   *  on send-accepted" patterns - flushQueue uses it to write user_message
   *  entries and drain its queue once the backend accepts the prompt. */
  onSendAccepted?: () => void;
}

// Dependency injection: agent-manager owns beginTurn and createTurnDeferred as
// module-private state. Rather than re-export and pull this module into a cycle,
// we wire them in once at boot.
type AgentTurnDeps = {
  beginTurn: (agentId: string, opts: { humanInput: boolean }) => void;
  createTurnDeferred: (managed: ManagedAgent) => Promise<void>;
  contextNoticeSampleWaitMs: number;
};

let deps: AgentTurnDeps | null = null;

export function configureAgentTurn(d: AgentTurnDeps): void {
  deps = d;
}

/** Owns the entire send-and-await-turn lifecycle.
 *  Throws through whatever the underlying turn threw so callers' catch
 *  blocks continue to handle SessionSwappedError / BackendNotConfiguredError
 *  / etc. with their existing semantics. */
export async function runAgentTurn(opts: RunAgentTurnOpts): Promise<void> {
  if (!deps) {
    throw new Error(
      "agent turn runner not configured; call configureAgentTurn at boot",
    );
  }

  const { managed, sdkText, attachments, humanInput, onSendAccepted } = opts;
  const agentId = managed.info.id;

  // 1. Claim the turn lifecycle immediately. Concurrent ingress (sendMessage,
  // executeSkill, enqueueMessage's "isQueueIdleState" branch) would see the agent as
  // not-busy and skip the queue, leading to either a deferred supersession
  // or two send() calls racing into the same backend session.
  //
  // beginTurn is idempotent on state ("thinking" → early-return), so
  // sendMessage's existing early-echo beginTurn at the top of the function
  // remains harmless when runAgentTurn re-enters from the bottom of the
  // same call.
  deps.beginTurn(agentId, { humanInput });

  // Snapshot the cancel token immediately after beginTurn. Built-in notice
  // assembly can await a context sample before pendingTurn is installed.
  const cancelTokenAtEntry = managed.turnCancelToken;
  const checkCancelled = () => {
    if (managed.turnCancelToken !== cancelTokenAtEntry) {
      throw new SessionSwappedError("Turn cancelled before send.");
    }
  };

  // 2. Build the context-fullness, session-start memory-size, and wake notices.
  // The bounded await inside
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
  // Read in the same window and for the same reason. Armed by the dormant-wake
  // paths when the previous session died to a restart or an unexpected backend
  // death (task e06b7e23); this is the only way the warning reaches the agent,
  // since isomux log entries never re-enter a prompt.
  const wakeNotice = managed.wakeNotice
    ? { block: managed.wakeNotice, gen: managed.contextGen }
    : null;

  // 3. Assemble the outbound envelope, then the user payload. The reserved
  // `isomux:` delimiter lets stripOutboundEnvelope round-trip the notices for
  // edit-to-fork matching.
  const envelopeBlocks: string[] = [];
  // First block: it describes the transcript the agent is about to read back,
  // so it belongs ahead of the housekeeping notices.
  if (wakeNotice) {
    envelopeBlocks.push(
      `--- begin isomux: wake-notice ---\n${wakeNotice.block}\n--- end isomux: wake-notice ---`,
    );
  }
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
  let finalText = sdkText;
  if (envelopeBlocks.length > 0) {
    finalText = `${envelopeBlocks.join("\n\n")}${USER_MESSAGE_SEPARATOR}${sdkText}`;
  }

  // Final pre-send cancel check. Catches a Stop/swap that fires after the
  // notice assembly returned but before createTurnDeferred runs - small
  // window but legitimately reachable since assembling the prefix yields
  // the microtask queue.
  checkCancelled();

  // 4. Install the per-turn deferred. pendingTurn makes session.send /
  // await turn cancellable on session swap.
  const turn = deps.createTurnDeferred(managed);
  const ownPending = managed.pendingTurn;

  // 5. Send.
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
    // One-shot, and never before send: a failed send keeps the note so the
    // retry still tells the agent what happened to its interrupted command.
    // Same generation guard as above - if a /clear landed during the send, the
    // slot we would clear may already hold the NEW conversation's wake note.
    if (wakeNotice && managed.contextGen === wakeNotice.gen) {
      managed.wakeNotice = null;
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
    // detected by checkCancelled above.
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
// the full closing line so we don't false-strip on a `---` substring that
// happens to precede the separator inside a block body. Requiring the
// separator right after the closing line is also what makes this find the LAST
// block when several fire on the same turn.
const END_ENVELOPE_AND_SEPARATOR =
  /(?:^|\n)--- end isomux: [a-z0-9_-]+ ---\n\nUser message:\n/;

/** Recover the unwrapped `sdkText` from a backend-recorded user message.
 *
 *  When at least one built-in block fires, `runAgentTurn` rewrites the
 *  outgoing text as `${blocks}${USER_MESSAGE_SEPARATOR}${sdkText}` (see step 5
 *  above). The backend persists the wrapped form into its session transcript,
 *  but the isomux log entry only carries the unwrapped `sdkText`. Edit-message
 *  matching needs the two to line up, so this helper strips the wrap back off.
 *
 *  Returns the input unchanged when no wrap is present. Two guards keep regular
 *  user text safe from accidental stripping:
 *    1. The text must start with `--- begin isomux: `.
 *    2. The boundary regex matches the FULL `--- end isomux: <id> ---`
 *       closing line shape (not just three dashes), so a block body containing
 *       `---` immediately before a stray separator can't short-circuit the split.
 *  The FIRST match wins, which is the structural boundary - anything that looks
 *  like the pattern in the user payload comes later in the string. */
export function stripOutboundEnvelope(text: string): string {
  if (!text.startsWith("--- begin isomux: ")) {
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
export const CONTEXT_NOTICE_SAMPLE_WAIT_MS = 500;

// Fullness bands (raw percentage), ascending. Once each per conversation
// generation, per audience: the agent-facing injected notice here, and the
// boss-facing ephemeral chat line (agent-manager's maybeEmitUiContextNotice)
// share the SAME bands but separate fired-sets. Kept in step with the UI color
// bands in the design doc §3 (50 = orange/plan-around-it, 75 = red/wrap-up).
//
// minWindowTokens gates a band on the REPORTED window size: the 50 band is an
// early budget warning that on a small window (e.g. Codex's ~250k) fires
// within a few turns of normal work and reads as noise, while the 75 wrap-up
// band stays useful at any size (task 73a23f7c). Keyed on maxTokens, not the
// backend, so it self-adjusts if window sizes change.
export const CONTEXT_NOTICE_BANDS = [
  { pct: 50, minWindowTokens: 500_000 },
  { pct: 75, minWindowTokens: 0 },
] as const;

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
// Auto-loaded memory is capped per scope (memory-store MEMORY_CAPS) and the
// caps are HARD: a save that would push a scope over is refused at write time
// (fail loud and early - Nil, 2026-08-01); nothing is ever silently dropped
// from the prompt. This notice arrives as a MESSAGE, which asks for a decision,
// and it fires BEFORE the cap is reached so the trimming can happen while
// saves still succeed. A message rather than a prompt line is also deliberate:
// a size figure in the system prompt would change on every write, which is the
// kind of per-agent variability the prompt keeps out (task 46f86536).
//
// Armed by agent-manager at session creation (it already renders memory there)
// and consumed here on the first accepted send of the conversation.
// ---------------------------------------------------------------------------

// A scope this full (fraction of its cap) is worth telling the agent about.
// At 1.0 new saves to the scope are refused; 0.8 gives the boss a chance to
// curate before that happens. Fills above 1 exist only on legacy files written
// before caps were write-enforced.
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
    .map((m) =>
      m.fill >= 1
        ? `${m.label} at ${Math.round(m.fill * 100)}% (at or over its cap; saves to it fail until it is trimmed)`
        : `${m.label} at ${Math.round(m.fill * 100)}% of its cap`,
    )
    .join(", ");
  return (
    `[memory check: auto-loaded memory is close to its size cap - ${listed}. ` +
    `Caps are hard: a save that would put a scope over its cap is refused. ` +
    `Offer the boss specific trims, applying them through the memory READ + PUT API after approval. ` +
    `Let the boss know they can also edit memory in Settings.]`
  );
}

/** The highest fullness threshold newly reached (percentage >= threshold) but
 *  not yet fired this generation, or null. Bands whose minWindowTokens exceeds
 *  the reported window are skipped. Pure read - never mutates the fired set.
 *  Uses the raw float percentage, never a rounded display value. */
export function pickContextThreshold(managed: ManagedAgent): number | null {
  const snap = managed.contextUsage;
  if (!snap) return null;
  let chosen: number | null = null;
  for (const band of CONTEXT_NOTICE_BANDS) {
    if (snap.maxTokens < band.minWindowTokens) continue;
    if (
      snap.percentage >= band.pct &&
      !managed.firedAgentThresholds.has(band.pct)
    )
      chosen = band.pct;
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
  // Codex compacts its own thread, so /clear or /handoff advice is wrong.
  // OpenCode is also opted out by default (Nil, 2026-08-31): its six connected
  // models measured 200k-1,048,576-token windows, but this lane did not prove
  // when its harness-owned compaction makes the advice useful. The bands below
  // already handle different and unknown window sizes without this guard.
  if (
    managed.info.agentType === "codex" ||
    managed.info.agentType === "opencode"
  )
    return null;
  const inFlight = managed.contextSampleInFlight;
  if (inFlight) {
    await Promise.race([
      inFlight,
      new Promise<void>((res) =>
        setTimeout(res, deps!.contextNoticeSampleWaitMs),
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
  for (const band of CONTEXT_NOTICE_BANDS) {
    if (band.pct <= threshold) managed.firedAgentThresholds.add(band.pct);
  }
}
