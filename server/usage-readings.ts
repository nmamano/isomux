// The context-window and subscription-allowance readings of each agent: the
// samples, their commit protocol, the member notice, and the wire broadcast.
// Moved out of createAgentManager (server/agent-manager.ts), which wires it.
import type {
  ContextUsageWire,
  LogEntry,
  ProviderAccountProvider,
  SubscriptionUsageWire,
  SubscriptionWindowWire,
} from "../shared/types.ts";
import type {
  AgentContextUsageResp,
  AgentSubscriptionUsageResp,
} from "../shared/contract-shapes.ts";
import type { OfficeState } from "../shared/office-state.ts";
import { msg, type LogText } from "../shared/i18n/log-message.ts";
import { getSessionClaudeConfigDir } from "./persistence.ts";
import { autoHandoffPossible } from "./auto-handoff.ts";
import {
  freshTurnFlags,
  type AgentEvent,
  type ContextUsageSnapshot,
  type ManagedAgent,
} from "./internal-types.ts";
import type {
  BackendSession,
  ContextUsage,
  SubscriptionUsage,
  SubscriptionUsageResult,
} from "./backends/types.ts";
import { buildEnvForUserId } from "./env-loader.ts";
import { CONTEXT_NOTICE_BANDS } from "./agent-turn.ts";
import { getAgentHost } from "./agent-host.ts";
import { usageAccountKey, usageKeyOnDirectory } from "./usage-account.ts";

export interface UsageReadingsDeps {
  agents: Map<string, ManagedAgent>;
  officeState: OfficeState;
  emit: (event: AgentEvent) => void;
  armMemoryNotice: (managed: ManagedAgent) => void;
  dropLimitResume: (agentId: string, managed: ManagedAgent) => void;
  evaluateAutoHandoff: (
    managed: ManagedAgent,
    turnStatus: "completed" | "interrupted" | "failed" | undefined,
  ) => void;
  emitEphemeralLog: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
  ) => void;
}

export function createUsageReadings(deps: UsageReadingsDeps) {
  const {
    agents,
    officeState,
    emit,
    armMemoryNotice,
    dropLimitResume,
    evaluateAutoHandoff,
    emitEphemeralLog,
  } = deps;

  // Design: internal-docs/context-fullness-visibility.md. A parallel read path
  // to usage ACCOUNTING (accumulateSessionUsage): fullness is window occupancy
  // of the current conversation, accounting is cumulative spend. Keep separate.

  // Reset the conversation's fullness state at semantic conversation
  // boundaries - see the lifecycle matrix in the design doc. Must be called
  // SYNCHRONOUSLY with the identity change (never after an await), with one
  // audited exception: the typed /clear handler calls it right after its
  // replaceSession await resolves - safe because the new session is already
  // installed, so the session-identity check orphans every old in-flight
  // sample even before the gen bump lands. `restore` serves edit-fork rollback,
  // which puts the stashed pre-fork measurement AND fired-notice sets back
  // instead of clearing them (the rolled-back conversation keeps its already-
  // fired notices so they don't re-fire).
  function resetContextUsage(
    managed: ManagedAgent,
    restore: {
      snapshot: ContextUsageSnapshot | null;
      fired: Set<number>;
      firedUi: Set<number>;
      memoryFired: boolean;
      autoHandoffSpent: boolean;
    } | null = null,
  ): void {
    managed.contextGen++;
    managed.contextUsage = restore ? restore.snapshot : null;
    managed.firedAgentThresholds = restore ? restore.fired : new Set();
    managed.firedUiThresholds = restore ? restore.firedUi : new Set();
    // Memory notice: same rule for the flag, then RE-ARM from it. Arming has to
    // happen here as well as at session build because the paths that start a
    // conversation disagree on the order: /clear resets and builds the session
    // lazily afterwards, while a different-session resume, a successful
    // edit-fork, and the Codex new-thread system_init all build the session
    // FIRST and reset after. Arming is a pure function of (flag, memory files),
    // so running it at both points is idempotent and the last one is right
    // whichever that is.
    managed.memoryNoticeFired = restore ? restore.memoryFired : false;
    armMemoryNotice(managed);
    // Wake notice: DROP it, never restore it. It describes a specific
    // interrupted transcript, so once the conversation boundary moves the
    // warning is about a transcript the agent is no longer reading - and it
    // says "just above". The contextGen guard in runAgentTurn stops an old
    // send from clearing a new generation's slot, but it can't empty a slot
    // whose notice was armed and then never consumed (send failed, then
    // /clear), which is exactly how a stale warning would ride into a fresh
    // conversation. Unconditional, including the edit-fork rollback path: at
    // worst an agent loses a warning, which beats being handed a false one.
    managed.wakeNotice = null;
    // Same for the stop notice: the stop it explains is in the old transcript.
    managed.stopNotice = null;
    // And the settings notice: the restart it explains is in the old transcript.
    managed.settingsNotice = null;
    // Automatic handoff: a running attempt belongs to the old conversation.
    // Its brief turn, if any, ends with the session swap; its owner sees the
    // phase gone and leaves quietly. The rollback restores whether the
    // conversation spent its attempt, like the fired-notice sets.
    managed.autoHandoffPhase = null;
    managed.autoHandoffSpent = restore ? restore.autoHandoffSpent : false;
    managed.autoHandoffOpened = false;
    managed.autoHandoffNotice = null;
    // A resume after a usage limit continues the old conversation, so it
    // goes with it, the edit-fork rollback included. So do the turn's flags.
    // This also runs mid-turn, at a system_init with a new session id, which
    // comes before any usage_limit_stop of that turn.
    managed.turnFlags = freshTurnFlags();
    dropLimitResume(managed.info.id, managed);
    managed.pendingFreshRecoveryNotice = false;
    // Null the slot so nothing ever waits on an orphaned old-conversation
    // request (it still self-discards at commit via the gen check).
    managed.contextSampleInFlight = null;
    // Clear (or restore) the UI indicator to match. Idempotent: a no-op when
    // both the new and last-broadcast values are already absent.
    broadcastContextUsage(managed);
  }

  // Model changes invalidate the MEASUREMENT but not the conversation: a
  // sample taken against the old model's window isn't actionable, but the
  // transcript continues, so contextGen stays put. In-flight samples from the
  // pre-change session self-discard via the session-identity check at commit
  // (every model change goes through a session replace).
  function invalidateContextMeasurement(managed: ManagedAgent): void {
    managed.contextUsage = null;
    managed.contextSampleInFlight = null;
    broadcastContextUsage(managed);
  }

  // Snapshot -> wire shape (drops the internal `source`). A missing snapshot
  // maps to null, NOT undefined: the wire clear must survive JSON.stringify
  // (which drops undefined-valued keys), or the client's spread-merge keeps
  // the previous conversation's stale reading after /clear.
  function contextUsageWire(
    snap: ContextUsageSnapshot | null,
  ): ContextUsageWire | null {
    if (!snap) return null;
    return {
      model: snap.model,
      totalTokens: snap.totalTokens,
      maxTokens: snap.maxTokens,
      percentage: snap.percentage,
      sampledAtMs: snap.sampledAtMs,
    };
  }

  // Whether two samples differ in any DISPLAYED value (model, window, the
  // rounded integer percentage the pill shows, or the token count the popover
  // shows). Used to throttle the Codex usage_update broadcast path; the raw
  // float still drives the stored snapshot and the threshold notices.
  function displayedContextChanged(
    prev: ContextUsageWire | null | undefined,
    next: ContextUsageSnapshot,
  ): boolean {
    if (!prev) return true;
    return (
      prev.model !== next.model ||
      prev.maxTokens !== next.maxTokens ||
      Math.round(prev.percentage) !== Math.round(next.percentage) ||
      prev.totalTokens !== next.totalTokens
    );
  }

  // Push the current fullness snapshot to the UI over agent_updated. The wire
  // copy lives on managed.info.contextUsage (mirrored by officeState.updateAgent)
  // and is the last-broadcast baseline for the usage_update throttle. Skips the
  // fully-redundant clear-when-already-clear case so the many reset call sites
  // don't emit dead agent_updated events.
  function broadcastContextUsage(managed: ManagedAgent): void {
    const wire = contextUsageWire(managed.contextUsage);
    if (wire === null && managed.info.contextUsage == null) return;
    for (const event of officeState.updateAgent(managed.info.id, {
      contextUsage: wire,
    }))
      emit(event);
  }

  // The engine's own compaction point, for the automatic handoff: an
  // adapter's internal compactAtTokens, else Claude's SDK threshold while its
  // auto-compact is on.
  function engineCompactAt(ctx: ContextUsage): number | undefined {
    if (ctx.compactAtTokens !== undefined && ctx.compactAtTokens > 0)
      return ctx.compactAtTokens;
    if (
      ctx.isAutoCompactEnabled === true &&
      typeof ctx.autoCompactThreshold === "number" &&
      ctx.autoCompactThreshold > 0
    )
      return ctx.autoCompactThreshold;
    return undefined;
  }

  // Commit an async sample iff it still belongs to the current conversation
  // (gen), the session object that produced it (identity), and nothing newer
  // has landed (seq). Returns whether it committed.
  function commitContextSample(
    managed: ManagedAgent,
    token: { gen: number; session: BackendSession; seq: number },
    ctx: ContextUsage,
    source: ContextUsageSnapshot["source"],
    // The status of the turn whose end took this sample (turn_completed
    // samples only). Only a completed turn arms the automatic handoff.
    turnStatus?: "completed" | "interrupted" | "failed",
  ): boolean {
    if (managed.contextGen !== token.gen) return false;
    if (managed.sessionManager.session !== token.session) return false;
    if (token.seq <= managed.contextUsageCommittedSeq) return false;
    managed.contextUsageCommittedSeq = token.seq;
    const snapshot: ContextUsageSnapshot = {
      model: ctx.model,
      totalTokens: ctx.totalTokens,
      maxTokens: ctx.maxTokens,
      percentage: ctx.percentage,
      sampledAtMs: Date.now(),
      source,
      ...(engineCompactAt(ctx) !== undefined
        ? { compactAtTokens: engineCompactAt(ctx) }
        : {}),
    };
    // turn_completed / on_demand broadcast every commit (turn-boundary cadence
    // is already low). Only the Codex usage_update path is throttled, and on
    // displayed values, so a burst of notifications for one turn doesn't spam
    // the WS. Compare against the last-broadcast wire BEFORE overwriting it.
    const shouldBroadcast =
      source !== "usage_update" ||
      displayedContextChanged(managed.info.contextUsage, snapshot);
    managed.contextUsage = snapshot;
    if (shouldBroadcast) broadcastContextUsage(managed);
    // Before the member notice, which stays quiet while an automatic attempt
    // is still possible (a pause makes it possible no more).
    evaluateAutoHandoff(managed, turnStatus);
    // Commit side effects, per the design doc: store → broadcast → evaluate
    // the MEMBER-facing threshold notice. Independent of the broadcast throttle
    // (uses the raw float, and the fired-set already dedups). The agent-facing
    // fired-set is never touched here - runAgentTurn owns it.
    maybeEmitUiContextNotice(managed);
    return true;
  }

  // Member-facing fullness notice (design doc §3): the first time a conversation
  // crosses each threshold band, surface ONE ephemeral system line in the
  // chat. A distinct audience from the agent-facing injected notice - separate
  // fired-set, so one audience firing never suppresses the other. Emitted from
  // the sample-commit path because the server is the single authority: multiple
  // connected clients or reconnects cannot duplicate it. Ephemeral (not
  // persisted): gone after a server restart, matching the snapshot itself. If
  // the first committed sample already clears both bands (e.g. lands at 87%),
  // only the HIGHEST band emits a line; all bands ≤ it are consumed.
  function maybeEmitUiContextNotice(managed: ManagedAgent): void {
    // Keep this member-facing guard aligned with buildContextNoticeBlock. Codex
    // compacts itself; OpenCode is opted out by default
    // because its harness owns compaction and this lane did not establish when
    // /clear or /handoff advice is useful. Its measured connected-model windows
    // span 200k-1,048,576 tokens; band sizing already handles that variation.
    if (
      managed.info.agentType === "codex" ||
      managed.info.agentType === "opencode"
    )
      return;
    // The automatic handoff stands in for this advice while it can still run.
    // Nothing is marked fired, so a failed or paused attempt brings it back.
    if (autoHandoffPossible(managed)) return;
    const snap = managed.contextUsage;
    if (!snap) return;
    let chosen: number | null = null;
    for (const band of CONTEXT_NOTICE_BANDS) {
      if (snap.maxTokens < band.minWindowTokens) continue;
      if (
        snap.percentage >= band.pct &&
        !managed.firedUiThresholds.has(band.pct)
      )
        chosen = band.pct;
    }
    if (chosen === null) return;
    for (const band of CONTEXT_NOTICE_BANDS) {
      if (band.pct <= chosen) managed.firedUiThresholds.add(band.pct);
    }
    const pct = Math.round(snap.percentage);
    // Same copy at every band; the band machinery
    // only controls WHEN it fires (once per threshold per generation).
    emitEphemeralLog(
      managed.info.id,
      "system",
      msg("systemEntries.contextFull", { percent: pct }),
    );
  }

  // Fire-and-forget refresh, initiated from the (synchronous) normalized-event
  // handler at turn boundaries (all backends) and on Codex's cumulative-usage
  // notifications (a free cache read - freshness bonus, not a timing
  // guarantee). Claude pays one control-request RPC per turn_completed. The
  // capture-then-commit protocol makes the async resolution safe against
  // /clear, resume, fork, and out-of-order arrivals.
  function refreshContextUsage(
    managed: ManagedAgent,
    source: ContextUsageSnapshot["source"],
    turnStatus?: "completed" | "interrupted" | "failed",
  ): void {
    const session = managed.sessionManager.session;
    if (!session) return;
    const token = {
      gen: managed.contextGen,
      session,
      seq: ++managed.contextSampleSeq,
    };
    const inFlight: Promise<void> = (async () => {
      try {
        const ctx = await session.getContextUsage();
        if (ctx) commitContextSample(managed, token, ctx, source, turnStatus);
      } catch {
        // Best-effort: an unavailable reading is represented by the absence
        // of a fresher snapshot, never by an error state.
      }
    })().finally(() => {
      // Identity guard: an older promise's finally must not evict a newer one.
      if (managed.contextSampleInFlight === inFlight) {
        managed.contextSampleInFlight = null;
      }
    });
    managed.contextSampleInFlight = inFlight;
  }

  // A THIRD read path, distinct from both fullness and accounting: how much of
  // the signed-in ACCOUNT's plan allowance is spent. Account-scoped, so unlike
  // fullness it deliberately survives /clear, fork and resume - the quota
  // doesn't reset when a conversation does.
  //
  // Refresh cadence is deliberately NOT policed here. Backends are asked on
  // every turn boundary and every cumulative-usage event (many per turn, which
  // is what makes a runaway retry loop visible while it's still running), and
  // each backend decides what that costs it: Codex reads rate limits its
  // app-server already pushed, Claude throttles its control RPC internally.

  // Which window the pill's NUMBER comes from: the one closest to its limit.
  // The alternative (always the weekly window) can read green while a 5-hour
  // or per-model window sits at 95%, which is precisely the situation the pill
  // exists to surface. Ties go to the earlier window in the backend's display
  // order, so the choice is stable across samples. The popover still lists
  // every window, and the pill's accessible name says which one it's showing.
  function pickPrimaryWindow(windows: SubscriptionWindowWire[]): number {
    let best = 0;
    for (let i = 1; i < windows.length; i++) {
      if (windows[i].usedPercent > windows[best].usedPercent) best = i;
    }
    return best;
  }

  // Whether two readings differ in anything the pill or its popover DISPLAY
  // (plan, which window leads, labels and tags, rounded percentages, reset times). Used
  // to skip dead agent_updated events on the high-frequency usage_update path.
  function displayedSubscriptionChanged(
    prev: SubscriptionUsageWire | null | undefined,
    next: SubscriptionUsageWire,
  ): boolean {
    if (!prev) return true;
    if (prev.plan !== next.plan) return true;
    if (prev.primaryIndex !== next.primaryIndex) return true;
    if (prev.windows.length !== next.windows.length) return true;
    return prev.windows.some((w, i) => {
      const n = next.windows[i];
      return (
        w.label !== n.label ||
        w.shortLabel !== n.shortLabel ||
        Math.round(w.usedPercent) !== Math.round(n.usedPercent) ||
        w.resetsAtMs !== n.resetsAtMs
      );
    });
  }

  function broadcastSubscriptionUsage(managed: ManagedAgent): void {
    const wire = managed.subscriptionUsage;
    if (wire === null && managed.info.subscriptionUsage == null) return;
    for (const event of officeState.updateAgent(managed.info.id, {
      subscriptionUsage: wire,
    }))
      emit(event);
  }

  // Drop the reading and orphan every in-flight read, because the agent's
  // backend now talks to a DIFFERENT account: engine switch (Claude <-> Codex)
  // and cross-engine resume. Must be called synchronously with the identity
  // change, like resetContextUsage - the gen bump is what stops a read issued
  // against the old account from landing on the new one.
  //
  // A same-engine model change deliberately does NOT call this: swapping Opus
  // for Sonnet leaves the claude.ai account, and therefore the allowance,
  // exactly where it was.
  function resetSubscriptionUsage(managed: ManagedAgent): void {
    managed.subscriptionGen++;
    // The engine's keys go with it; the next use derives the new engine's.
    managed.launchedUsageKey = undefined;
    managed.idleUsageKey = undefined;
    clearSubscriptionUsage(managed);
  }

  // Clear the displayed reading without touching the generation - used both by
  // the identity reset above and by an authoritative "no allowance here"
  // answer from a backend that is still the same account.
  function clearSubscriptionUsage(managed: ManagedAgent): void {
    managed.subscriptionUsage = null;
    broadcastSubscriptionUsage(managed);
  }

  // The latest reading per usage account (server/usage-account.ts), or an
  // authoritative "no allowance here" (wire null), so every agent on the
  // account shows it (task 967a09d1). `atMs` orders them: the provider
  // observation time of a reading, the commit time of a clear.
  const accountUsage = new Map<
    string,
    { wire: SubscriptionUsageWire | null; atMs: number }
  >();

  // The usage account of the agent: the installed session's launch key, else
  // the account its next session would run under. No side effects and never
  // throws - buildSessionEnv would probe and pin a session root.
  function usageKeyOf(managed: ManagedAgent): string | null {
    if (
      managed.sessionManager.session &&
      managed.launchedUsageKey !== undefined
    )
      return managed.launchedUsageKey;
    const sessionId = managed.sessionManager.sessionId ?? null;
    if (managed.idleUsageKey?.sessionId === sessionId)
      return managed.idleUsageKey.key;
    const agentType = managed.info.agentType;
    let key: string | null;
    try {
      const env =
        buildEnvForUserId(managed.info.userId) ?? getAgentHost().baseEnv();
      if (agentType === "claude" && sessionId) {
        // A legacy session with no recorded root resumes on whichever root
        // holds it: no guess.
        const dir = getSessionClaudeConfigDir(managed.info.id, sessionId);
        key = dir
          ? usageAccountKey(agentType, { ...env, CLAUDE_CONFIG_DIR: dir })
          : null;
      } else {
        key = usageAccountKey(agentType, env);
      }
    } catch {
      // Not cached: an env that cannot load now is retried at the next use.
      return null;
    }
    managed.idleUsageKey = { sessionId, key };
    return key;
  }

  // Point the agent at its current usage account (`key`, default derived).
  // Another account than the one its reading belongs to orphans every read in
  // flight and shows that account's reading, or none.
  function syncUsageKey(
    managed: ManagedAgent,
    key: string | null = usageKeyOf(managed),
  ): string | null {
    if (managed.subscriptionKey === key) return key;
    const first = managed.subscriptionKey === undefined;
    managed.subscriptionKey = key;
    if (!first) managed.subscriptionGen++;
    if (key === null) {
      // An engine without shared readings keeps its own.
      if (!first) clearSubscriptionUsage(managed);
      return key;
    }
    const entry = accountUsage.get(key);
    if (entry) showSubscriptionReading(managed, entry.wire, false);
    else if (!first) clearSubscriptionUsage(managed);
    return key;
  }

  // Show a committed reading, or clear it when `wire` is null. `always`
  // broadcasts an unchanged reading too, so the popover's age stays true.
  function showSubscriptionReading(
    managed: ManagedAgent,
    wire: SubscriptionUsageWire | null,
    always: boolean,
  ): void {
    if (!wire) {
      // Skip the broadcast when nothing was shown.
      if (managed.subscriptionUsage !== null) clearSubscriptionUsage(managed);
      return;
    }
    const shouldBroadcast =
      always ||
      displayedSubscriptionChanged(managed.info.subscriptionUsage, wire);
    managed.subscriptionUsage = wire;
    if (shouldBroadcast) broadcastSubscriptionUsage(managed);
  }

  // A sign-in or sign-out at `dir` (ProviderAccountManager.onAccountChanged):
  // the directory may now hold another account, so no reading taken before
  // is its. A personal one also moves the member's next sessions.
  function providerAccountChanged(
    provider: ProviderAccountProvider,
    dir: string,
  ): void {
    for (const key of [...accountUsage.keys()])
      if (usageKeyOnDirectory(key, provider, dir)) accountUsage.delete(key);
    for (const managed of agents.values()) {
      managed.idleUsageKey = undefined;
      const key = syncUsageKey(managed);
      if (key === null || !usageKeyOnDirectory(key, provider, dir)) continue;
      managed.subscriptionGen++;
      clearSubscriptionUsage(managed);
    }
  }

  // Fire-and-forget refresh. A sample commits only if BOTH guards still hold:
  // the account-identity generation and the monotonic seq. There is
  // deliberately no session-identity guard - the reading belongs to the
  // ACCOUNT, so a late resolution from a session that has since been replaced
  // is still true; only a switch to a different account invalidates it, which
  // is what the generation catches.
  //
  // The three backend answers are handled differently, which is the whole
  // point of the tri-state (see SubscriptionUsageResult): a reading commits,
  // an AUTHORITATIVE "no plan allowance here" clears the pill, and "we learned
  // nothing this time" leaves the last reading standing so one failed RPC
  // can't blank a valid number.
  function refreshSubscriptionUsage(
    managed: ManagedAgent,
    source: "turn_completed" | "usage_update",
  ): void {
    const session = managed.sessionManager.session;
    if (!session) return;
    const token = {
      gen: managed.subscriptionGen,
      seq: ++managed.subscriptionSampleSeq,
    };
    void (async () => {
      let result: SubscriptionUsageResult;
      try {
        result = await session.getSubscriptionUsage();
      } catch {
        // Backends are contracted to resolve rather than reject; this is
        // belt-and-braces so a surprise can't reject an unawaited promise.
        return;
      }
      if (result.kind === "unknown") return;
      commitSubscriptionSample(
        managed,
        token,
        result.kind === "usage" ? result.usage : null,
        source,
        result.kind === "usage" ? result.observedAtMs : undefined,
      );
    })();
  }

  // Commit a reading, or an authoritative clear when `usage` is null. Both go
  // through the same two guards, so neither an older in-flight sample nor one
  // belonging to a previous ACCOUNT can undo a newer reading in either
  // direction. There is deliberately NO session-identity guard: a reading that
  // resolves after a session replacement is still true of the same account,
  // which is the whole reason this value outlives conversations.
  function commitSubscriptionSample(
    managed: ManagedAgent,
    token: { gen: number; seq: number },
    usage: SubscriptionUsage | null,
    source: "turn_completed" | "usage_update" | "on_demand",
    observedAtMs?: number,
  ): void {
    if (managed.subscriptionGen !== token.gen) return;
    if (token.seq <= managed.subscriptionCommittedSeq) return;
    managed.subscriptionCommittedSeq = token.seq;
    const key = syncUsageKey(managed);
    // The agent moved to another account while the read was out.
    if (managed.subscriptionGen !== token.gen) return;
    const wire =
      usage && usage.windows.length > 0
        ? subscriptionWire(usage, observedAtMs)
        : null;
    // Turn-boundary samples ALWAYS broadcast, even when every displayed value
    // is unchanged: the popover tells the user how old the reading is, and a
    // deduped broadcast would freeze that timestamp while the number quietly
    // stayed fresh. Only the high-frequency usage_update path dedupes, and it
    // can afford to - a turn boundary follows soon after. Same split the
    // fullness sampler uses, for the same reason.
    const always = source !== "usage_update";
    if (key === null) {
      showSubscriptionReading(managed, wire, always);
      return;
    }
    // A reading older than the account's latest (another agent's, or a
    // clear) loses; that one is already on every agent of the account.
    const atMs = wire ? wire.observedAtMs : Date.now();
    const latest = accountUsage.get(key);
    if (latest && latest.atMs > atMs) return;
    accountUsage.set(key, { wire, atMs });
    for (const other of agents.values())
      if (syncUsageKey(other) === key)
        showSubscriptionReading(other, wire, always);
  }

  function subscriptionWire(
    usage: SubscriptionUsage,
    observedAtMs: number | undefined,
  ): SubscriptionUsageWire {
    const windows: SubscriptionWindowWire[] = usage.windows.map((w) => ({
      label: w.label,
      shortLabel: w.shortLabel,
      // Clamp again at the wire boundary: the adapters clamp too, but a
      // malformed reading must never paint a negative or overflowing gauge.
      usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
      resetsAtMs: w.resetsAtMs,
    }));
    const committedAtMs = Date.now();
    return {
      plan: usage.plan,
      windows,
      primaryIndex: pickPrimaryWindow(windows),
      sampledAtMs: committedAtMs,
      observedAtMs: observedAtMs ?? committedAtMs,
    };
  }

  async function getAgentSubscriptionUsage(
    agentId: string,
  ): Promise<AgentSubscriptionUsageResp> {
    const managed = agents.get(agentId);
    if (!managed) return { available: false, reason: "no_session" };
    syncUsageKey(managed);
    const session = managed.sessionManager.session;
    if (!session) {
      const snap = managed.subscriptionUsage;
      if (!snap) {
        return {
          available: false,
          reason: managed.sessionManager.sessionId
            ? "not_yet_measured"
            : "no_session",
        };
      }
      return {
        available: true,
        ...snap,
        ageMs: Math.max(0, Date.now() - snap.observedAtMs),
        freshness: "cached",
        staleReason: "no_session",
      };
    }

    const refreshStartedAtMs = Date.now();
    const token = {
      gen: managed.subscriptionGen,
      seq: ++managed.subscriptionSampleSeq,
    };
    let result: SubscriptionUsageResult = { kind: "unknown" };
    try {
      result = await session.getSubscriptionUsage({ forceRefresh: true });
    } catch {
      // Treat an unexpected rejection as a transient failed refresh.
    }
    const accountChanged = managed.subscriptionGen !== token.gen;
    if (!accountChanged && result.kind !== "unknown") {
      commitSubscriptionSample(
        managed,
        token,
        result.kind === "usage" ? result.usage : null,
        "on_demand",
        result.kind === "usage" ? result.observedAtMs : undefined,
      );
    }
    if (!accountChanged && result.kind === "unavailable") {
      return { available: false, reason: "provider_unavailable" };
    }
    const snap = managed.subscriptionUsage;
    if (!snap) return { available: false, reason: "not_yet_measured" };
    const fresh =
      result.kind === "usage" &&
      !accountChanged &&
      (result.refreshed === true ||
        (result.refreshed === undefined &&
          (result.observedAtMs ?? snap.sampledAtMs) >= refreshStartedAtMs));
    return fresh
      ? {
          available: true,
          ...snap,
          ageMs: Math.max(0, Date.now() - snap.observedAtMs),
          freshness: "fresh",
        }
      : {
          available: true,
          ...snap,
          ageMs: Math.max(0, Date.now() - snap.observedAtMs),
          freshness: "cached",
          staleReason: "refresh_failed",
        };
  }

  // GET /api/agents/:id/context - the agent-facing self-check op. Tries a live
  // reading first (also refreshing the stored snapshot through the same commit
  // protocol, so it loses cleanly to newer samples or a conversation swap that
  // happens mid-await), then serves whatever snapshot is committed.
  async function getAgentContextUsage(
    agentId: string,
  ): Promise<AgentContextUsageResp> {
    const managed = agents.get(agentId);
    if (!managed) return { available: false, reason: "no_session" };
    const session = managed.sessionManager.session;
    if (session) {
      const token = {
        gen: managed.contextGen,
        session,
        seq: ++managed.contextSampleSeq,
      };
      try {
        const ctx = await session.getContextUsage();
        if (ctx) commitContextSample(managed, token, ctx, "on_demand");
      } catch {
        // Fall through to the stored snapshot.
      }
    }
    const snap = managed.contextUsage;
    if (snap) {
      return {
        available: true,
        model: snap.model,
        totalTokens: snap.totalTokens,
        maxTokens: snap.maxTokens,
        percentage: snap.percentage,
        sampledAtMs: snap.sampledAtMs,
      };
    }
    // No committed measurement: distinguish "nothing to measure" (blank/fresh
    // conversation) from "a conversation exists but no sample landed yet"
    // (Codex pre-first-turn, right after a server restart, live call failed).
    return {
      available: false,
      reason:
        managed.sessionManager.session || managed.sessionManager.sessionId
          ? "not_yet_measured"
          : "no_session",
    };
  }

  return {
    resetContextUsage,
    invalidateContextMeasurement,
    maybeEmitUiContextNotice,
    refreshContextUsage,
    resetSubscriptionUsage,
    syncUsageKey,
    providerAccountChanged,
    refreshSubscriptionUsage,
    getAgentSubscriptionUsage,
    getAgentContextUsage,
  };
}
