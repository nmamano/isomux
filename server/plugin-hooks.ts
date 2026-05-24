/**
 * Plugin hook bus + the central `runAgentTurn` helper.
 *
 * `runAgentTurn` is the single entry point for every send-and-await-turn
 * path: sendMessage, flushQueue, executeSkill, editMessage. It owns:
 *
 *   1. Awaiting the previous turn's afterTurnPromise (so memory writes
 *      from the prior turn land before this turn's beforeTurn retrieval).
 *      A stale promise can't poison future turns — see runAfterTurn for
 *      the self-clearing wrapper.
 *   2. Running every enabled plugin's `beforeTurn` in parallel against the
 *      same context. Per-plugin 5s race; on throw or timeout the plugin
 *      contributes no prefix and the failure goes to plugins.jsonl.
 *   3. Assembling per-plugin prefix blocks in alphabetical id order,
 *      delimiter-wrapped, and prepending them to the outgoing text with
 *      a `User message:` separator.
 *   4. beginTurn + createTurnDeferred + session.send + await turn.
 *   5. Snapshotting logCache after the caller's onSendAccepted callback
 *      runs but before the agent's turn output lands, so user_message
 *      entries logged by the caller are excluded from newLogEntries.
 *   6. Firing afterTurn for every plugin in parallel AFTER session.send
 *      was attempted, with status reflecting the post-send outcome
 *      (completed / failed / interrupted). Per-plugin 10s race. The
 *      aggregate promise is stored on `managed.afterTurnPromise` and
 *      self-clears on settle. A turn cancelled DURING plugin retrieval
 *      (Stop / session swap before session.send) skips afterTurn — the
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
   *  message" — sender prefixes like `[Nil (Phone)]` are isomux routing
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
   *  accepted" patterns — flushQueue uses it to write user_message entries
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
  getRoom: (roomIdx: number) => { id: string; name: string } | null;
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
  // state for the duration — concurrent ingress (sendMessage, executeSkill,
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
  // window and bail with SessionSwappedError if it changed — pendingTurn
  // isn't installed yet, so the usual rejection path can't reach us.
  const cancelTokenAtEntry = managed.turnCancelToken;
  const checkCancelled = () => {
    if (managed.turnCancelToken !== cancelTokenAtEntry) {
      throw new SessionSwappedError(
        "Turn cancelled during plugin retrieval.",
      );
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

  // 3. Build the plugin context. roomLookup may return null if the agent's
  // room index is somehow out of range (shouldn't happen, but defensive).
  const room = deps.getRoom(managed.info.room);
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

  // 5. Assemble the final outgoing text.
  let finalText = sdkText;
  if (prefixes.length > 0) {
    const blocks = prefixes
      .map(
        ({ id, prefix }) =>
          `--- begin plugin: ${id} ---\n${prefix}\n--- end plugin: ${id} ---`,
      )
      .join("\n\n");
    finalText = `${blocks}\n\nUser message:\n${sdkText}`;
  }

  // Final pre-send cancel check. Catches a Stop/swap that fires after the
  // beforeTurn loop returned but before createTurnDeferred runs — small
  // window but legitimately reachable since assembling the prefix yields
  // the microtask queue.
  checkCancelled();

  // 6. Install the per-turn deferred. Held close to session.send so we don't
  // park a pendingTurn through the plugin retrieval phase — the state gate
  // above is what serializes turns; pendingTurn is what makes session.send /
  // await turn cancellable on session swap.
  const turn = deps.createTurnDeferred(managed);
  const ownPending = managed.pendingTurn;

  // 7. Send. Snapshot the logCache AFTER onSendAccepted runs but BEFORE the
  // agent's turn output starts arriving via processNormalizedEvent — that's
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
    if (onSendAccepted) {
      try {
        onSendAccepted();
      } catch (err) {
        // onSendAccepted is caller-controlled (typically log entries +
        // queue drain). A throw here would be a caller bug — the turn is
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
    // managed.pendingTurn — reject + clear only when we still own it so
    // awaiting callers don't hang and concurrent abort/state logic doesn't
    // observe a phantom in-flight turn.
    if (ownPending && managed.pendingTurn === ownPending) {
      managed.pendingTurn = null;
      try {
        ownPending.reject(err);
      } catch {
        // Already-rejected deferred — fine.
      }
    }
    // SessionSwappedError = user-initiated swap (abort, /resume, /model,
    // /effort, /clear, editMessage fork install) OR a pre-send cancel
    // detected by checkCancelled above. Map to "interrupted" so plugins
    // can distinguish from real failures.
    status = err instanceof SessionSwappedError ? "interrupted" : "failed";
  }

  // 8. Fire afterTurn for every plugin. Even on failure / interruption —
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
// beforeTurn — per-plugin race with timeout
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
 *  A malformed shape — non-object return, or `promptPrefix` that isn't a
 *  string — must NOT crash the turn (the spec is explicit: plugin errors
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
// afterTurn — per-plugin race, self-clearing aggregate promise
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

  // Wrap with a self-clearing finally — a timed-out plugin must not leave a
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

