// The message queue: accepting a message (enqueueMessage), its durable
// mirror in message-queues.json, the sender labels the receiver reads, and the
// delivery of steers at tool boundaries. Moved out of createAgentManager
// (server/agent-manager.ts), which wires it and keeps the flush.
import type {
  AgentState,
  AskRef,
  Attachment,
  LogEntry,
  QueuedMessage,
} from "../shared/types.ts";
import { belowStandard } from "../shared/agent-access.ts";
import { errMessage } from "../shared/errors.ts";
import { msg, type LogText } from "../shared/i18n/log-message.ts";
import {
  defuseSenderLabels,
  formatAgentSenderPrefix,
  formatAppSenderPrefix,
  formatCronjobSenderPrefix,
  formatPrefix,
  formatWebhookSenderPrefix,
  isRepliesOnlyApiTokenDevice,
  type AgentSenderTrust,
} from "../shared/identity.ts";
import type { ManagerDeps } from "./agent-manager.ts";
import { askReplyNote } from "./asks.ts";
import {
  formatAttachmentLines,
  resolveAttachmentNotices,
} from "./attachment-prompt.ts";
import type { BackendSession } from "./backends/types.ts";
import { getAgentTokenIdentity } from "./identity/tokens.ts";
import {
  inMultiStepFlow,
  type AgentEvent,
  type EnqueueResult,
  type ManagedAgent,
  type SendNowResult,
} from "./internal-types.ts";
import { loadMessageQueuesRaw, saveMessageQueues } from "./persistence.ts";

export const TOOL_BOUNDARY_NOTE =
  "[Isomux: delivered during your turn; nothing was interrupted.]";

export interface MessageQueueDeps {
  agents: Map<string, ManagedAgent>;
  getBackend: ManagerDeps["resolveBackend"];
  emit: (event: AgentEvent) => void;
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
  ) => unknown;
  buildUserMeta: (
    username?: string,
    device?: string,
  ) => Record<string, unknown> | undefined;
  getCurrentSessionId: (agentId: string) => string | null;
  maybeFillTopic: (agentId: string, managed: ManagedAgent) => void;
  pickAutoResumeSessionId: (managed: ManagedAgent) => string | null;
  enqueueCapRefusal: (
    managed: ManagedAgent,
    sender: QueuedMessage["sender"],
  ) => EnqueueResult | null;
  flushQueue: (agentId: string) => Promise<void>;
  sendNow: (
    agentId: string,
    cause: NonNullable<QueuedMessage["interruptCause"]>,
  ) => SendNowResult;
  releaseBackendHold: (agentId: string, managed: ManagedAgent) => void;
  resume: (agentId: string, sessionId: string) => Promise<unknown>;
}

export function createMessageQueue(deps: MessageQueueDeps) {
  const {
    agents,
    getBackend,
    emit,
    addLogEntry,
    buildUserMeta,
    getCurrentSessionId,
    maybeFillTopic,
    pickAutoResumeSessionId,
    enqueueCapRefusal,
    flushQueue,
    sendNow,
    releaseBackendHold,
    resume,
  } = deps;

  const QUEUE_MAX = 50;
  const QUEUE_DEDUPE_TTL_MS = 5 * 60_000;
  // Agent-initiated steering: how many times other agents may
  // interrupt one receiver's turns within a rolling window before further
  // steers degrade to a plain queue. Three per minute leaves room for a
  // correction and a follow-up while stopping a pair of agents from steering
  // each other in a loop, where every abort throws away in-flight work. The
  // message is still accepted either way, so the limit only ever delays it to
  // the receiver's next turn boundary.
  const STEER_RATE_LIMIT = 3;
  const STEER_RATE_WINDOW_MS = 60_000;

  function senderMeta(
    sender: QueuedMessage["sender"],
  ): Record<string, unknown> | undefined {
    switch (sender.kind) {
      case "user":
        return buildUserMeta(sender.username, sender.device);
      case "agent":
        return {
          sender_agent_id: sender.agentId,
          sender_agent_name: sender.agentName,
          sender_agent_room: sender.roomName,
        };
      case "cronjob":
        return {
          sender_cronjob_id: sender.cronjobId,
          sender_cronjob_name: sender.cronjobName,
        };
      case "app":
        return { sender_app_name: sender.appName };
      case "webhook":
        return {
          sender_webhook_id: sender.webhookId,
          sender_webhook_name: sender.webhookName,
        };
      default: {
        const _exhaustive: never = sender;
        throw new Error(
          `unhandled sender kind: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }

  // The label marker for an agent sender, from the sender's live token and the
  // receiver's manager at delivery. A sender with no live token (killed, or gone
  // before its scheduled message fired) and a side with no manager get none.
  function agentSenderTrust(
    senderAgentId: string,
    receiverAgentId: string,
  ): AgentSenderTrust | undefined {
    const sender = getAgentTokenIdentity(senderAgentId);
    if (sender && belowStandard(sender.access)) return "limited";
    const receiverUserId = agents.get(receiverAgentId)?.info.userId;
    if (!sender?.userId || sender.userId !== receiverUserId) return undefined;
    return sender.privileged ? "same-manager-privileged" : "same-manager";
  }

  function senderPrefixText(
    sender: QueuedMessage["sender"],
    receiverAgentId: string,
  ): string {
    switch (sender.kind) {
      case "user":
        return formatPrefix({
          username: sender.username,
          device: sender.device,
        });
      case "agent":
        return `${formatAgentSenderPrefix(
          sender.agentId,
          sender.agentName,
          sender.roomName,
          agentSenderTrust(sender.agentId, receiverAgentId),
        )} `;
      case "cronjob":
        return `${formatCronjobSenderPrefix(sender.cronjobName)} `;
      // An app the receiving agent registered, speaking with its own token. The
      // name is all the label needs: the system prompt carries the rule about
      // what an app's message is worth, exactly where it carries the same rule
      // for agent-to-agent messages.
      case "app":
        return `${formatAppSenderPrefix(sender.appName)} `;
      // A delivery from outside the office. The data block in the text says
      // what the JSON is worth; the label says where it came from.
      case "webhook":
        return `${formatWebhookSenderPrefix(sender.webhookName)} `;
      default: {
        const _exhaustive: never = sender;
        throw new Error(
          `unhandled sender kind: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }

  // Per-item flush prefix. Plain messages get the bare sender prefix; a
  // SCHEDULED message (scheduledFor set by scheduled-messages.ts at fire time)
  // is explicitly marked so the receiver doesn't read it as a live
  // conversational turn: a self-addressed one reads as coming from the agent's
  // own past self (no reply expected), and a gone sender is called out because
  // scheduled messages always deliver - the
  // receiver decides what the sender's absence means.
  function queuedItemPrefix(m: QueuedMessage, receiverAgentId: string): string {
    // A self-handoff brief (POST /api/agents/:id/handoff):
    // injected into the agent's OWN freshly-reset session, so mark it as coming
    // from its previous session. The fresh copy reads it as its own brief and
    // carries the work forward instead of replying to a sender.
    if (
      m.handoff &&
      m.sender.kind === "agent" &&
      m.sender.agentId === receiverAgentId
    ) {
      return `[Handoff from your previous session] `;
    }
    // The resume after a usage limit, and the wake after a server restart,
    // are whole messages of their own.
    if (
      (m.limitResume || m.restartWake || m.fallbackContinue) &&
      m.sender.kind === "agent" &&
      m.sender.agentId === receiverAgentId
    ) {
      return "";
    }
    // An office notice is a whole message too, from no one the agent talks to.
    if (m.notice) return "";
    if (m.ask && m.sender.kind === "user") {
      return `${senderPrefixText(m.sender, receiverAgentId)}${askReplyNote(m.ask, getCurrentSessionId(receiverAgentId))}`;
    }
    if (m.scheduledFor === undefined || m.sender.kind !== "agent") {
      return senderPrefixText(m.sender, receiverAgentId);
    }
    const when = new Date(m.scheduledFor).toISOString();
    if (m.sender.agentId === receiverAgentId) {
      return `[Scheduled message from your own past self, scheduled for delivery at ${when}] `;
    }
    const gone = m.scheduledSenderGone
      ? " The sender agent no longer exists, so it will not see a reply."
      : "";
    return `${senderPrefixText(m.sender, receiverAgentId)}[This message was scheduled by the sender for delivery at ${when}.${gone}] `;
  }

  // What the receiver's model reads for one queued item. Shared by the flush
  // and the tool-boundary delivery so the two cannot drift.
  function queuedItemText(m: QueuedMessage, receiverAgentId: string): string {
    // sdkText is set for pre-expanded slash commands (e.g. an /subagent-review
    // queued while the agent was mid-turn): chat shows m.text "/subagent-review",
    // but the SDK needs the full skill prompt. A body from anyone but a member
    // or the receiver itself is defused, so no line of it reads as a
    // server-written agent or member label. A member already has member
    // authority, and keeps the bytes the immediate path sends; the receiver's
    // own handoff brief or scheduled note is its own text. A replies-only API
    // token does not have member authority.
    const body = m.sdkText ?? m.text;
    const own =
      (m.sender.kind === "user" &&
        !isRepliesOnlyApiTokenDevice(m.sender.device)) ||
      (m.sender.kind === "agent" && m.sender.agentId === receiverAgentId);
    return `${queuedItemPrefix(m, receiverAgentId)}${own ? body : defuseSenderLabels(body)}`;
  }

  // Delivered items become chat entries. Shared by the flush (after the backend
  // accepts the send) and the tool-boundary delivery (when its hook returns).
  function logDeliveredItems(
    agentId: string,
    managed: ManagedAgent,
    items: readonly QueuedMessage[],
    extraMeta?: Record<string, unknown>,
  ): void {
    for (const m of items) {
      // Carry sdkText into the log metadata so editMessage can match
      // this entry against the SDK session (the SDK saw the expanded
      // prompt, not m.text). Same shape executeSkill uses on the
      // immediate path.
      let meta = senderMeta(m.sender);
      if (m.sdkText) meta = { ...(meta ?? {}), sdkText: m.sdkText };
      // Scheduled-delivery provenance (see scheduled-messages.ts):
      // mirrors the flush-prefix marker into the persisted log entry.
      if (m.scheduledFor !== undefined) {
        meta = {
          ...(meta ?? {}),
          scheduled_for: m.scheduledFor,
          ...(m.scheduledSenderGone ? { scheduled_sender_gone: true } : {}),
        };
      }
      // Self-handoff provenance: mirror the flush-prefix
      // marker into the persisted log entry, matching the scheduled path.
      if (m.handoff) meta = { ...(meta ?? {}), handoff: true };
      // The chat's link back to the ask this message answers.
      if (m.ask) meta = { ...(meta ?? {}), ask: m.ask };
      if (extraMeta) meta = { ...(meta ?? {}), ...extraMeta };
      // The chat already shows a direct send that a swap cut and that was
      // queued again.
      if (m.echoed) continue;
      // The resume after a usage limit: the member reads a system line, not
      // a message from the agent to itself.
      if (m.limitResume) {
        addLogEntry(
          agentId,
          "system",
          msg("systemEntries.limitResume.resumed"),
        );
        continue;
      }
      if (m.restartWake) {
        addLogEntry(
          agentId,
          "system",
          msg("systemEntries.restartWake.resumed"),
        );
        continue;
      }
      // The continue on the office sign-in: the switch line already says it.
      // An office notice: its system line is already in the chat.
      if (m.fallbackContinue || m.notice) {
        continue;
      }
      addLogEntry(agentId, "user_message", m.text, meta, m.attachments);
    }
    // Trigger topic generation only after the user_message log entries
    // land in logCache. generateTopic reads the first user message
    // synchronously before its first await - running it earlier (e.g.
    // before the send) on a fresh conversation finds an empty cache
    // and bails out, leaving topic null. Matches the sendMessage path
    // which also logs before triggering.
    maybeFillTopic(agentId, managed);
  }

  // Remove delivered items from the live queue and from disk.
  function drainQueueItems(
    agentId: string,
    managed: ManagedAgent,
    items: ReadonlySet<QueuedMessage>,
  ): void {
    managed.messageQueue = managed.messageQueue.filter((m) => !items.has(m));
    emitQueueUpdate(agentId, managed);
    // Best-effort durable removal. A crash between the
    // backend accepting the send and this write replays the items on
    // next boot - at-least-once, mirroring scheduled-messages'
    // enqueue-then-persist-removal decision.
    persistQueueState(agentId, managed);
  }

  const NO_CLAIM: ReadonlySet<QueuedMessage> = new Set();

  // Items the INSTALLED session delivered at a tool boundary. A claim whose
  // session was closed, swapped or released is stale: its items are ordinary
  // queued items again and the next flush redelivers them (at-least-once).
  function liveClaimed(managed: ManagedAgent): ReadonlySet<QueuedMessage> {
    const claim = managed.boundaryClaim;
    if (!claim) return NO_CLAIM;
    if (claim.session !== managed.sessionManager.session) {
      managed.boundaryClaim = undefined;
      return NO_CLAIM;
    }
    return claim.items;
  }

  // The queue minus items already delivered inside the running turn: what the
  // UI shows, what a flush sends, and what a boundary delivery may take.
  function unclaimedQueue(managed: ManagedAgent): QueuedMessage[] {
    const claimed = liveClaimed(managed);
    return claimed.size === 0
      ? [...managed.messageQueue]
      : managed.messageQueue.filter((m) => !claimed.has(m));
  }

  // Machine traffic that the flush would send as plain prefixed text. A member
  // message, an expanded skill, a handoff or a resume after a usage limit
  // keeps the whole queue on the flush path, where it becomes a backend user
  // message (edit/fork map onto those).
  function boundaryEligible(m: QueuedMessage): boolean {
    return (
      m.sender.kind !== "user" &&
      !m.sdkText &&
      !m.handoff &&
      !m.limitResume &&
      !m.restartWake &&
      !m.fallbackContinue &&
      !m.native
    );
  }

  // Whether `session` may take the queue inside its running turn now: it is
  // the installed session, a turn is running and nothing is switching it.
  function boundaryTakeable(
    managed: ManagedAgent,
    session: BackendSession,
  ): boolean {
    const sm = managed.sessionManager;
    return !(
      sm.session !== session ||
      !sm.pendingTurn ||
      sm.aborting ||
      sm.abortPromise ||
      managed.info.sessionSwapping ||
      (managed.info.state !== "thinking" &&
        managed.info.state !== "tool_executing") ||
      inMultiStepFlow(managed) ||
      // The brief turn must not take the queue the fresh session gets.
      managed.autoHandoffPhase ||
      // Nor the old session's last tool batch a held queue.
      managed.queueHolds.size > 0
    );
  }

  // The unclaimed queue when a boundary delivery may take it: it holds a
  // steer and every item is eligible. Null otherwise.
  function boundaryBatch(managed: ManagedAgent): QueuedMessage[] | null {
    const items = unclaimedQueue(managed);
    if (!items.some((m) => m.steer) || !items.every(boundaryEligible))
      return null;
    return items;
  }

  // What the model reads for a boundary delivery, from either path.
  function boundaryText(agentId: string, items: QueuedMessage[]): string {
    const parts = [TOOL_BOUNDARY_NOTE];
    for (const m of items) {
      const lines = m.attachments
        ? formatAttachmentLines(
            resolveAttachmentNotices(agentId, m.attachments),
          )
        : [];
      parts.push([queuedItemText(m, agentId), ...lines].join("\n"));
    }
    return parts.join("\n\n");
  }

  // The claim of `session`, created when the installed claim belongs to
  // another session or there is none.
  function claimFor(
    managed: ManagedAgent,
    session: BackendSession,
  ): NonNullable<ManagedAgent["boundaryClaim"]> {
    return managed.boundaryClaim?.session === session
      ? managed.boundaryClaim
      : { session, items: new Set<QueuedMessage>() };
  }

  // The PostToolBatch callback (backends/claude.ts toolBoundaryHooks), bound to
  // the session it was created with. When the queue holds a steer and the whole
  // queue is eligible, it claims the queue, logs the items, and returns the text
  // the model reads before its next request. The items stay queued (and on
  // disk) until that session's turn_completed drains them. Must not throw: a
  // failure releases what it claimed and delivers nothing.
  function takeToolBoundaryMessage(
    agentId: string,
    session: BackendSession | null,
  ): string | null {
    const managed = agents.get(agentId);
    if (!managed || !session || !boundaryTakeable(managed, session))
      return null;
    const items = boundaryBatch(managed);
    if (!items) return null;
    const claim = claimFor(managed, session);
    try {
      const text = boundaryText(agentId, items);
      for (const m of items) claim.items.add(m);
      managed.boundaryClaim = claim;
      logDeliveredItems(agentId, managed, items, { delivery: "tool_boundary" });
      emitQueueUpdate(agentId, managed);
      return text;
    } catch (err) {
      for (const m of items) claim.items.delete(m);
      console.error(
        `Tool-boundary delivery failed for ${agentId}; the queue waits for the turn to end:`,
        errMessage(err),
      );
      return null;
    }
  }

  // Push sessions (BackendSession.steer, Codex): offer the eligible queue to
  // the running turn. The items are claimed as pending under a fresh steer id
  // and logged only when the engine records them (onSteerDelivered); a
  // refusal releases them for the turn-end flush. Called when a steer is
  // queued and at each main-thread tool call, so a steer the engine could not
  // take yet (no turn id) is offered again. Must not throw.
  function pushBoundarySteer(agentId: string): void {
    const managed = agents.get(agentId);
    const session = managed?.sessionManager.session;
    if (
      !managed ||
      !session ||
      typeof session.steer !== "function" ||
      !boundaryTakeable(managed, session)
    )
      return;
    const items = boundaryBatch(managed);
    if (!items) return;
    const claim = claimFor(managed, session);
    const steerId = `isomux-steer-${crypto.randomUUID()}`;
    let sent: Promise<boolean>;
    try {
      const text = boundaryText(agentId, items);
      for (const m of items) claim.items.add(m);
      (claim.pending ??= new Map()).set(steerId, items);
      managed.boundaryClaim = claim;
      emitQueueUpdate(agentId, managed);
      sent = session.steer(text, steerId);
    } catch (err) {
      releasePendingSteer(agentId, managed, claim, steerId);
      console.error(
        `Steer push failed for ${agentId}; the queue waits for the turn to end:`,
        errMessage(err),
      );
      return;
    }
    void sent.then(
      (ok) => {
        if (!ok) releasePendingSteer(agentId, managed, claim, steerId);
      },
      () => releasePendingSteer(agentId, managed, claim, steerId),
    );
  }

  // The engine refused a pushed steer: its items are ordinary queued items
  // again. A no-op once the claim was drained or replaced (the turn ended, the
  // session changed) or the steer was recorded: the answer came too late to
  // touch items a flush or a later push now holds.
  function releasePendingSteer(
    agentId: string,
    managed: ManagedAgent,
    claim: NonNullable<ManagedAgent["boundaryClaim"]>,
    steerId: string,
  ): void {
    const items = claim.pending?.get(steerId);
    if (!items || managed.boundaryClaim !== claim) return;
    claim.pending!.delete(steerId);
    for (const m of items) claim.items.delete(m);
    emitQueueUpdate(agentId, managed);
  }

  // The engine recorded the pending steer `steerId` in the running turn: log
  // its items as the hook path does. No busy-turn gate: an interrupt can
  // already have moved the state while the engine still recorded the text.
  // Only the installed session's claim counts; an unknown or released steer
  // id logs nothing.
  function onSteerDelivered(
    agentId: string,
    managed: ManagedAgent,
    steerId: string,
  ): void {
    if (liveClaimed(managed).size === 0) return;
    const claim = managed.boundaryClaim!;
    const items = claim.pending?.get(steerId);
    if (!items) return;
    claim.pending!.delete(steerId);
    logDeliveredItems(agentId, managed, items, { delivery: "tool_boundary" });
  }

  // turn_completed of the installed session: its boundary deliveries are done.
  // Pushed steers the engine never recorded were dropped with the turn: they
  // are released, and the flush that follows delivers them.
  function drainBoundaryClaim(agentId: string, managed: ManagedAgent): void {
    const claimed = new Set(liveClaimed(managed));
    const pending = managed.boundaryClaim?.pending;
    managed.boundaryClaim = undefined;
    let released = false;
    for (const items of pending?.values() ?? [])
      for (const m of items) released = claimed.delete(m) || released;
    if (claimed.size > 0) drainQueueItems(agentId, managed, claimed);
    else if (released) emitQueueUpdate(agentId, managed);
  }

  function emitQueueUpdate(agentId: string, managed: ManagedAgent) {
    emit({
      type: "agent_updated",
      agentId,
      changes: { queue: unclaimedQueue(managed) },
    });
  }

  // The live queue + dedupe window are mirrored to ~/.isomux/message-queues.json
  // and replayed at boot so a restart no longer drops queued messages.
  // Acceptance (enqueueMessage) persists TRANSACTIONALLY (throw → roll back →
  // 500 persist_failed, so the sender knows to retry); every post-accept
  // mutation persists best-effort via persistQueueState - the backend already
  // accepted (or the user explicitly cleared), so stale disk merely widens
  // at-least-once replay. emitQueueUpdate stays free of disk I/O on purpose;
  // each mutation site calls the persist helper explicitly.

  let queueStoreCache: Record<string, unknown> | null = null;
  function queueStore(): Record<string, unknown> {
    if (!queueStoreCache) queueStoreCache = loadMessageQueuesRaw();
    return queueStoreCache;
  }

  // Narrow an unknown loaded item to a QueuedMessage. Strict on the fields the
  // flush path reads (id/text/queuedAt/sender shape); parity-loose on optional
  // extras (sdkText/attachments/scheduledFor), matching the boundary style of
  // malformedSendFields.
  function isValidQueuedMessage(v: unknown): v is QueuedMessage {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.text !== "string" ||
      typeof r.queuedAt !== "number"
    )
      return false;
    // The flush prefix reads an ask's id and prompt.
    if (r.ask !== undefined) {
      const a = r.ask as Record<string, unknown> | null;
      if (
        typeof a !== "object" ||
        a === null ||
        typeof a.id !== "string" ||
        typeof a.prompt !== "string"
      )
        return false;
    }
    const s = r.sender as Record<string, unknown> | null | undefined;
    if (typeof s !== "object" || s === null) return false;
    if (s.kind === "user") return true;
    if (s.kind === "agent")
      return (
        typeof s.agentId === "string" &&
        typeof s.agentName === "string" &&
        typeof s.roomName === "string"
      );
    if (s.kind === "cronjob")
      return (
        typeof s.cronjobId === "string" && typeof s.cronjobName === "string"
      );
    // An app's message survives a restart like any other queued item. This arm
    // is the persistence boundary: without it a queued app message would be
    // dropped as malformed on boot replay, silently, which is why it is tested
    // through a real reload rather than only against the live queue.
    if (s.kind === "app") return typeof s.appName === "string";
    if (s.kind === "webhook")
      return (
        typeof s.webhookId === "string" && typeof s.webhookName === "string"
      );
    return false;
  }

  // Snapshot the agent's durable record, or null when there is nothing worth
  // keeping (empty queue, no unexpired dedupe keys).
  function buildQueueRecord(
    managed: ManagedAgent,
  ): { queue: QueuedMessage[]; dedupe: Record<string, number> } | null {
    const now = Date.now();
    const dedupe: Record<string, number> = {};
    for (const [k, v] of managed.queueDedupe) if (v > now) dedupe[k] = v;
    if (managed.messageQueue.length === 0 && Object.keys(dedupe).length === 0)
      return null;
    return { queue: [...managed.messageQueue], dedupe };
  }

  // THROWS - the transactional acceptance path in enqueueMessage.
  // COPY-ON-SUCCESS (review-pinned): mutate a copy, write it, and only commit
  // the copy to the cache after the write succeeds. Mutating the live cache
  // before a failed save would leave a phantom record that the NEXT successful
  // save (for any agent) silently resurrects - a message whose sender was told
  // 500 would come back from the dead on the following restart. The cache must
  // always mirror the last successfully-persisted disk state.
  function persistQueueStateThrow(agentId: string, managed: ManagedAgent) {
    const next = { ...queueStore() };
    const rec = buildQueueRecord(managed);
    if (rec === null) delete next[agentId];
    else next[agentId] = rec;
    saveMessageQueues(next);
    queueStoreCache = next;
  }

  // Best-effort - every post-accept mutation site.
  function persistQueueState(agentId: string, managed: ManagedAgent) {
    try {
      persistQueueStateThrow(agentId, managed);
    } catch (err) {
      console.error(
        `Failed to persist message queue for ${agentId} (durability degraded; live delivery unaffected):`,
        errMessage(err),
      );
    }
  }

  // Best-effort removal - kill(). Copy-on-success, same rationale as above.
  function removeQueueRecord(agentId: string) {
    try {
      if (!(agentId in queueStore())) return;
      const next = { ...queueStore() };
      delete next[agentId];
      saveMessageQueues(next);
      queueStoreCache = next;
    } catch (err) {
      console.error(
        `Failed to remove persisted message queue for ${agentId}:`,
        errMessage(err),
      );
    }
  }

  // Boot-replay read: validate one persisted record. Invalid items are dropped
  // with a log line; expired dedupe keys are dropped silently.
  function readPersistedQueueRecord(
    agentId: string,
  ): { queue: QueuedMessage[]; dedupe: Map<string, number> } | null {
    const raw = queueStore()[agentId];
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const queue: QueuedMessage[] = [];
    if (Array.isArray(r.queue)) {
      for (const item of r.queue) {
        if (isValidQueuedMessage(item)) queue.push(item);
        else
          console.error(
            `Dropping invalid persisted queued message for ${agentId}:`,
            JSON.stringify(item)?.slice(0, 200),
          );
      }
    }
    const dedupe = new Map<string, number>();
    const now = Date.now();
    if (
      typeof r.dedupe === "object" &&
      r.dedupe !== null &&
      !Array.isArray(r.dedupe)
    ) {
      for (const [k, v] of Object.entries(
        r.dedupe as Record<string, unknown>,
      )) {
        if (typeof v === "number" && Number.isFinite(v) && v > now)
          dedupe.set(k, v);
      }
    }
    if (queue.length === 0 && dedupe.size === 0) return null;
    return { queue, dedupe };
  }

  function generateQueuedId(existing: QueuedMessage[]): string {
    const ids = new Set(existing.map((m) => m.id));
    for (;;) {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      const id = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (!ids.has(id)) return id;
    }
  }

  function isQueueIdleState(s: AgentState): boolean {
    return s === "idle" || s === "waiting_for_response";
  }

  // Steer rate limit. Prunes the receiver's window in place and
  // reports whether another interruption fits. Called only on the path that is
  // about to interrupt, so the pruning cost is bounded by the limit itself.
  function steerRateLimited(managed: ManagedAgent): boolean {
    const cutoff = Date.now() - STEER_RATE_WINDOW_MS;
    managed.recentSteers = managed.recentSteers.filter((t) => t > cutoff);
    return managed.recentSteers.length >= STEER_RATE_LIMIT;
  }

  function recordDedupe(managed: ManagedAgent, clientMessageId: string) {
    const now = Date.now();
    // Lazy prune only when the map has grown past a small threshold so the
    // common (small) case stays O(1). Drops expired entries to bound steady-
    // state memory; the queue cap of QUEUE_MAX provides the true upper bound
    // on accepted distinct ids per minute.
    if (managed.queueDedupe.size > 100) {
      for (const [k, v] of managed.queueDedupe) {
        if (v < now) managed.queueDedupe.delete(k);
      }
    }
    managed.queueDedupe.set(clientMessageId, now + QUEUE_DEDUPE_TTL_MS);
  }

  // Single entry point for human (via sendMessage) and agent (via HTTP) senders.
  // Decides whether to queue, send-immediately, or reject based on agent state.
  // `state === "stopped"` is rejected with 409. An inbound message to an
  // errored agent is accepted into the durable queue and resumes the current
  // session once; the error -> waiting transition flushes every queued item.
  function enqueueMessage(
    agentId: string,
    msg: {
      sender: QueuedMessage["sender"];
      text: string;
      sdkText?: string;
      // QueuedMessage.native.
      native?: boolean;
      attachments?: Attachment[];
      clientMessageId?: string;
      // Set by the scheduled-message scheduler at fire time (see
      // scheduled-messages.ts). Copied onto the queued item below - dropping
      // the copy would silently lose the scheduled marker in the flush prefix.
      scheduledFor?: number;
      scheduledSenderGone?: boolean;
      // Set by the self-handoff dep when injecting a brief into
      // the sender's own freshly-reset session. Copied below so the flush prefix
      // marks it as a handoff from the previous session (no reply-to-self).
      handoff?: boolean;
      // A direct send a swap cut before the backend took it
      // (requeueSwappedSend). Not marked as queued during a busy turn: it was
      // sent before that turn. `echoed`: the chat already shows it.
      resend?: { echoed: boolean };
      // QueuedMessage.ask.
      ask?: AskRef;
      // QueuedMessage.limitResume.
      limitResume?: boolean;
      // QueuedMessage.limitResumeMemberIds.
      limitResumeMemberIds?: string[];
      // QueuedMessage.restartWake.
      restartWake?: boolean;
      // QueuedMessage.fallbackContinue.
      fallbackContinue?: boolean;
      // QueuedMessage.notice.
      notice?: boolean;
    },
    // Agent-initiated steering. Set by the inter-agent send
    // route when the sender passed "steer":true. Deliberately an option on THIS
    // call rather than a second request: the decision uses the same `state` read
    // that picks flush-vs-queue below, in the same synchronous block as the
    // queue push, so the receiver cannot go idle (and swallow the message into
    // an ordinary flush) between the enqueue and the interrupt.
    opts?: { steer?: boolean },
  ): EnqueueResult {
    const managed = agents.get(agentId);
    if (!managed) return { ok: false, error: "agent not found", status: 404 };
    // Inbound traffic counts as activity so a dormant agent that just woke (or a
    // busy one mid-conversation) isn't demoted out from under the next message.
    managed.lastActiveAt = Date.now();

    const state = managed.info.state;
    if (state === "stopped") {
      return { ok: false, error: `agent_${state}`, status: 409 };
    }
    const autoResumeSessionId =
      state === "error" ? pickAutoResumeSessionId(managed) : null;
    if (state === "error" && autoResumeSessionId === null) {
      return { ok: false, error: "agent_error", status: 409 };
    }

    // Idempotency check first; record only after a successful accept below so
    // a 429-rejected retry doesn't poison the dedup map.
    if (msg.clientMessageId && managed.queueDedupe.has(msg.clientMessageId)) {
      return { ok: true, queued: false, deduped: true };
    }

    if (managed.messageQueue.length >= QUEUE_MAX) {
      return { ok: false, error: "queue_full", status: 429 };
    }

    const capRefusal = enqueueCapRefusal(managed, msg.sender);
    if (capRefusal) return capRefusal;

    const id = generateQueuedId(managed.messageQueue);
    // The continue on the office sign-in is queued by the stopped turn's
    // own end, so no reply came before it.
    const queuedDuringBusyTurn =
      state !== "error" &&
      !isQueueIdleState(state) &&
      !msg.resend &&
      !msg.fallbackContinue &&
      !msg.notice;
    // A steer at a busy receiver whose backend delivers at tool boundaries
    // waits for the running tool batch instead of aborting the turn
    // (internal-docs/steer-delivery-design.md). Decided here, against the same
    // state read as the rest of this call, and marked on the item itself so a
    // cancelled item takes its steer with it.
    const boundarySteer =
      opts?.steer === true &&
      queuedDuringBusyTurn &&
      !inMultiStepFlow(managed) &&
      !managed.autoHandoffPhase &&
      managed.queueHolds.size === 0 &&
      getBackend(managed.info.agentType).toolBoundaryDelivery === true;
    managed.messageQueue.push({
      id,
      sender: msg.sender,
      text: msg.text,
      ...(msg.sdkText ? { sdkText: msg.sdkText } : {}),
      ...(msg.native ? { native: true } : {}),
      ...(queuedDuringBusyTurn ? { queuedDuringBusyTurn: true } : {}),
      ...(msg.scheduledFor !== undefined
        ? { scheduledFor: msg.scheduledFor }
        : {}),
      ...(msg.scheduledSenderGone ? { scheduledSenderGone: true } : {}),
      ...(msg.handoff ? { handoff: true } : {}),
      ...(msg.limitResume ? { limitResume: true } : {}),
      ...(msg.restartWake ? { restartWake: true } : {}),
      ...(msg.fallbackContinue ? { fallbackContinue: true } : {}),
      ...(msg.notice ? { notice: true } : {}),
      ...(msg.limitResumeMemberIds?.length
        ? { limitResumeMemberIds: msg.limitResumeMemberIds }
        : {}),
      ...(msg.ask ? { ask: msg.ask } : {}),
      ...(msg.resend?.echoed ? { echoed: true } : {}),
      ...(boundarySteer ? { steer: true } : {}),
      attachments: msg.attachments,
      queuedAt: Date.now(),
    });
    // Transactional acceptance: item + dedupe key land in
    // memory, then ONE combined durable write. On failure both are rolled back
    // and the request fails - acking a message the disk never saw would be
    // silent loss on restart, hiding the retry signal from the sender.
    // (recordDedupe's lazy pruning of OTHER expired keys needn't roll back;
    // only the submitted key must.) Emit/flush happen only after the persist.
    if (msg.clientMessageId) recordDedupe(managed, msg.clientMessageId);
    try {
      persistQueueStateThrow(agentId, managed);
    } catch (err) {
      managed.messageQueue.pop();
      if (msg.clientMessageId) managed.queueDedupe.delete(msg.clientMessageId);
      console.error(
        `Failed to persist queued message for ${agentId}; rejecting the send:`,
        errMessage(err),
      );
      return { ok: false, error: "persist_failed", status: 500 };
    }
    emitQueueUpdate(agentId, managed);
    // A new message retries a queue kept after a backend failure.
    releaseBackendHold(agentId, managed);

    const steerRequested = opts?.steer === true;

    // Claim the recovery synchronously with acceptance. The state remains
    // `error` until replaceSession completes, so without this flag a second
    // send in the same tick could start an overlapping resume of the same
    // transcript. Later sends only join the queue.
    if (state === "error") {
      if (!managed.autoResumeInProgress) {
        managed.autoResumeInProgress = true;
        void resume(agentId, autoResumeSessionId!).finally(() => {
          managed.autoResumeInProgress = false;
        });
      }
      return {
        ok: true,
        queued: true,
        messageId: id,
        ...(steerRequested ? { steered: false } : {}),
      };
    }

    // Idle/waiting_for_response with no multi-step in flight: kick off a flush
    // immediately. flushQueue is gated by flushInProgress and re-checks state
    // post-defer, so this is safe to call unconditionally.
    if (isQueueIdleState(state) && !inMultiStepFlow(managed)) {
      flushQueue(agentId).catch((err: unknown) => {
        console.error(
          `flushQueue (idle) failed for ${agentId}:`,
          errMessage(err),
        );
      });
      // A steer at a receiver that wasn't running a turn interrupts nothing -
      // reported as steered:false rather than declined, since no guard rail
      // refused it and the message is being delivered now either way.
      return {
        ok: true,
        queued: false,
        messageId: id,
        ...(steerRequested ? { steered: false } : {}),
      };
    }
    if (steerRequested) {
      // Guard rails, in refusal order. Both leave the message queued (the
      // sender is told which one fired) rather than failing the send.
      // Multi-step first: aborting an agent that is answering a pick would end
      // its turn and still not deliver, since flushQueue declines to run there.
      if (inMultiStepFlow(managed)) {
        return {
          ok: true,
          queued: true,
          messageId: id,
          steered: false,
          steerDeclined: "multi_step_flow",
        };
      }
      // A conversation change is under way: it ends the running turn itself,
      // and the message goes to the next session when the hold is released.
      if (managed.queueHolds.size > 0) {
        return { ok: true, queued: true, messageId: id, steered: false };
      }
      // A handoff is under way: the message goes to the fresh session, and
      // interrupting the brief turn would only cancel it.
      if (managed.autoHandoffPhase) {
        return {
          ok: true,
          queued: true,
          messageId: id,
          steered: false,
          steerDeclined: managed.autoHandoffPhase.manual
            ? "handoff"
            : "auto_handoff",
        };
      }
      // Nothing is interrupted, so the rate limit (which protects the
      // receiver's ability to finish a turn) neither applies nor counts it.
      // The next main-thread tool batch delivers it, or the turn-end flush.
      if (boundarySteer) {
        pushBoundarySteer(agentId);
        return { ok: true, queued: false, messageId: id, steered: true };
      }
      if (steerRateLimited(managed)) {
        return {
          ok: true,
          queued: true,
          messageId: id,
          steered: false,
          steerDeclined: "rate_limited",
        };
      }
      managed.recentSteers.push(Date.now());
      // Same call the composer's Ctrl/Cmd+Enter makes (sendMessage's sendNow
      // branch): abort the in-flight turn, then flush. Fire-and-forget, like
      // both existing call sites - sendNow owns its own state handling, and the
      // ack must not wait on a session replacement. The queue is non-empty (we
      // just pushed), so sendNow's empty-queue no-op cannot fire.
      void sendNow(agentId, "agent_steer");
      // queued:false: the receiver's current turn is being cut short precisely
      // so this message does NOT wait for it, which is what queued reports.
      return { ok: true, queued: false, messageId: id, steered: true };
    }
    return { ok: true, queued: true, messageId: id };
  }

  // Restore's prune of stale records writes the cache after its own save.
  function setQueueStoreCache(next: Record<string, unknown>): void {
    queueStoreCache = next;
  }

  return {
    queuedItemText,
    logDeliveredItems,
    drainQueueItems,
    liveClaimed,
    unclaimedQueue,
    takeToolBoundaryMessage,
    pushBoundarySteer,
    onSteerDelivered,
    drainBoundaryClaim,
    emitQueueUpdate,
    queueStore,
    setQueueStoreCache,
    persistQueueStateThrow,
    persistQueueState,
    removeQueueRecord,
    readPersistedQueueRecord,
    generateQueuedId,
    isQueueIdleState,
    steerRateLimited,
    enqueueMessage,
  };
}
