// Agents - conversation resource handlers - Phase 3d slice 6a. The
// send/edit/cancel/sendNow/newConversation/resume/listSessions surface moves off
// the WS command bus to REST. EXPAND+CUT in one slice (like slices 6/7): the rows
// were table-declared but never handler-registered, so this slice BUILDS the
// handlers AND deletes the WS cases (+ the legacy POST /agents/:id/message).
//
// STREAMING, not response-returning: send/edit/sendNow/newConversation/resume are
// FIRE-AND-FORGET on the turn - the index dep closures void-discard the manager
// promise and the handler returns only an ack; the log_entry / approval_request /
// clear_logs events STREAM over the WS as the turn runs (the double-signal: HTTP
// acks, WS streams). An awaited HTTP response would block on the whole turn.
//
// sendMessage is UNIFIED + OVERLOADED across the two identity branches the
// messageSend guard authorizes:
//   - USER (cookie, agent:converse)      -> sendAsUser  (agentManager.sendMessage;
//     the user-chat path. The approval-reply OVERLOAD lives INSIDE sendMessage -
//     while a pendingPermission is set for :id, the next message is the allow/deny
//     reply, so calling the same core preserves it for free).
//   - AGENT (bearer, agent:send-as-self) -> sendAsAgent (enqueueMessage with a
//     server-derived structured sender; the inter-agent path the retired legacy
//     POST /agents/:id/message used). Programmatic callers get an explicit HTTP
//     failure (the manager's documented asymmetry); the USER path is permissive
//     (errors surface as streamed log entries, never an HTTP error).
//
// LEAF over the injected ConversationDeps (the EMIT/CALL-IN-DEP closures own every
// agent-manager touch; these handlers parse, branch on scope, and map outcomes).

import { ok, noContent, fail, type RouteHandler } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type {
  Attachment,
  ScheduledMessageEntry,
  SessionInfo,
  AgentBackendType,
} from "../../../shared/types.ts";
import type {
  SendMessageReq,
  EditMessageReq,
  ResumeReq,
  NewConversationReq,
  HandoffReq,
} from "../../../shared/contract-shapes.ts";
import type {
  SendNowResult,
  SteerDeclineReason,
  UserSendAcceptance,
} from "../../internal-types.ts";
// Pure format parser (no state) - safe for a leaf handler module to import.
import { parseDeliverAt } from "../../scheduled-messages.ts";
import type { ScheduleResult, CancelResult } from "../../scheduled-messages.ts";
import { formatApiTokenDevice } from "../../../shared/identity.ts";

// The AGENT (inter-agent) send outcome. The failure carries the status + stable
// code directly (self-send/unknown-sender from the dep's checks; otherwise
// enqueueMessage's own status + error code passed through verbatim), so the
// handler stays a thin mapper and the legacy POST /agents/:id/message contract
// (400 self/unknown, 404 unknown-receiver, 409 agent_error/agent_stopped, 429
// queue_full) is preserved bit-for-bit. 500 persist_failed is new with durable
// queues (task 9870b472): the durable write failed, the message was rolled
// back, and the sender should retry.
// `queued` (task 425facdd) is the enqueue outcome for THIS send: true = parked
// behind the receiver's in-flight turn, false = handed straight to a turn.
// Undefined when this call never learned the answer (a deduped retry acks the
// original send), and the ack then omits the field rather than guessing false.
// `steered` / `steerDeclined` (task 80b2bb08) answer the second question a
// steering sender has - was a turn actually interrupted, and if not, which guard
// rail refused. Both undefined unless this call asked to steer.
export type SendAsAgentResult =
  | {
      ok: true;
      messageId?: string;
      queued?: boolean;
      steered?: boolean;
      steerDeclined?: SteerDeclineReason;
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 429 | 500;
      code: string;
      message: string;
    };

// The self-handoff outcome (task 8883e45d). Mirrors SendAsAgentResult's failure
// shape: the reset always runs, but the brief's transactional enqueue can fail
// (persist_failed 500 / agent_stopped 409 / queue_full 429 / agent-gone 404), so
// the handler maps a failure to a real HTTP error instead of a false {ok:true}.
export type HandoffResult =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 404 | 409 | 429 | 500;
      code: string;
      message: string;
    };

export interface ConversationDeps {
  // Token-derived attribution (username from identity, NEVER the body) for the
  // USER chat + edit paths - the WS cases used session.username, not a body field.
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  // USER chat send. Void - sendMessage owns the echo / queue / recovery / slash /
  // approval-reply overload and streams the turn over WS; there is no queued id
  // to ack (the UI ignores the body and consumes the stream).
  sendAsUser(
    agentId: string,
    text: string,
    username: string | undefined,
    device: string | undefined,
    attachments: Attachment[] | undefined,
    sendNow: boolean,
  ): void;
  // API-token human send. Resolves at the queue-or-direct acceptance decision,
  // never at turn completion.
  sendAsApi(
    agentId: string,
    text: string,
    username: string | undefined,
    device: string,
  ): Promise<UserSendAcceptance>;
  // AGENT inter-agent send. Builds the structured sender server-side (blocks
  // prefix-injection / identity spoof) and enqueues; returns the discriminated
  // outcome above.
  sendAsAgent(
    receiverId: string,
    senderAgentId: string,
    text: string,
    clientMessageId: string | undefined,
    // Interrupt the receiver's in-flight turn so this message lands now
    // (task 80b2bb08). Enqueue + interrupt happen inside one manager call.
    steer: boolean,
  ): SendAsAgentResult;
  // CRON-RUN send. The dependency resolves the live job and constructs its
  // sender attribution; the request body cannot name or impersonate a sender.
  sendAsCron(
    receiverId: string,
    cronjobId: string,
    text: string,
    clientMessageId: string | undefined,
  ): SendAsAgentResult;
  // AGENT send with deliverAt: store a durable scheduled entry instead of
  // enqueueing now (fired later by scheduled-messages.ts). Self-send IS
  // allowed here - a future self-message is the reminder/wake-up use case the
  // immediate path's self_send rejection exists to prevent looping on.
  scheduleMessage(
    receiverId: string,
    senderAgentId: string,
    text: string,
    deliverAt: number,
    clientMessageId: string | undefined,
  ): ScheduleResult;
  // The sender's pending scheduled-message outbox (soonest first).
  listScheduledMessages(senderAgentId: string): ScheduledMessageEntry[];
  cancelScheduledMessage(
    senderAgentId: string,
    scheduledId: string,
  ): CancelResult;
  // Edit a prior message. Void / streaming, same shape as sendAsUser.
  editMessage(
    agentId: string,
    logEntryId: string,
    newText: string,
    username: string | undefined,
    device: string | undefined,
  ): void;
  cancelQueued(agentId: string, messageId: string): void;
  // Returns the outcome rather than void: "flush started" and "cannot flush"
  // are different answers and the caller has to be able to tell them apart
  // (task 5dcb0a02). Synchronous - it decides, then kicks the delivery off.
  sendNow(agentId: string): SendNowResult;
  newConversation(agentId: string, agentType?: AgentBackendType): void;
  // Self-handoff (task 8883e45d): reset the agent's session then deliver `text`
  // into the fresh session as a self-handoff brief. The manager guards to one
  // in-flight handoff per agent (a concurrent second is rejected). AWAITED (not
  // fire-and-forget) so the brief's transactional enqueue failure surfaces as a
  // real HTTP error rather than a false success.
  handoff(agentId: string, text: string): Promise<HandoffResult>;
  resume(agentId: string, sessionId: string): void;
  listSessions(agentId: string): {
    sessions: SessionInfo[];
    currentSessionId: string | null;
  };
}

// One attachment spec, element-validated. The container check below is not
// enough on its own: the fields flow straight into resolveAttachmentNotices ->
// getFilePath(agentId, filename) (path.join throws on a non-string) and into the
// notice line's formatSize(size), so a hand-crafted element would throw or
// render garbage mid-turn, long after the request was acked. `size` must be a
// nonnegative safe integer - a byte count that is negative, fractional, or past
// 2^53 is not a real upload.
function malformedAttachmentSpec(a: unknown): boolean {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return true;
  const spec = a as Record<string, unknown>;
  if (typeof spec.filename !== "string" || spec.filename.length === 0)
    return true;
  if (typeof spec.originalName !== "string") return true;
  if (typeof spec.mediaType !== "string") return true;
  if (!Number.isSafeInteger(spec.size) || (spec.size as number) < 0)
    return true;
  return false;
}

// Reject a present-but-wrong-typed optional field at the boundary. A direct REST
// caller can POST {text:"x", attachments:{}} - truthy but non-iterable - which the
// USER path would queue and flushQueue would later spread
// (allAttachments.push(...m.attachments)), throwing mid-turn; a non-string device
// / clientMessageId would corrupt log metadata / the dedupe key. Mirrors slice
// 7b's malformedAgentFields on the container TYPE, and additionally validates
// each attachment ELEMENT (the WS command never element-validated; the REST
// surface is the one a hand-crafted body reaches).
function malformedSendFields(b: Record<string, unknown>): boolean {
  if (b.device !== undefined && typeof b.device !== "string") return true;
  if (b.clientMessageId !== undefined && typeof b.clientMessageId !== "string")
    return true;
  if (b.attachments !== undefined) {
    if (!Array.isArray(b.attachments)) return true;
    if (b.attachments.some(malformedAttachmentSpec)) return true;
  }
  // deliverAt must be a STRING (RFC3339): a bare epoch number is rejected here
  // rather than parsed, so a seconds-vs-ms confusion can never silently
  // schedule for 1970 (which would fire immediately and mask the bug).
  if (b.deliverAt !== undefined && typeof b.deliverAt !== "string") return true;
  if (b.sendNow !== undefined && typeof b.sendNow !== "boolean") return true;
  if (b.steer !== undefined && typeof b.steer !== "boolean") return true;
  return false;
}

export function conversationHandlers(
  deps: ConversationDeps,
): Record<string, RouteHandler> {
  return {
    "agents.sendMessage": async (ctx) => {
      const b = (ctx.body ?? {}) as Partial<SendMessageReq>;
      // 400 (not 422) on the text checks + the AGENT-branch reasons below mirrors
      // the legacy POST /agents/:id/message status codes that queue.test.ts pins
      // as "today's status codes" - this route REPLACES that endpoint, so it must
      // not silently drift the agent-facing contract.
      if (typeof b.text !== "string") {
        return fail(400, "invalid_text", "text is required");
      }
      if (malformedSendFields(b)) {
        return fail(
          422,
          "invalid_request",
          "device, clientMessageId, and deliverAt must be strings; attachments must be an array of {filename, originalName, mediaType} strings plus a nonnegative integer size; sendNow and steer must be booleans",
        );
      }
      // sendNow is USER-branch only (the composer's Ctrl/Cmd+Enter). Rejected
      // loudly for agent senders - mirrors the deliverAt style below (never
      // silently ignore a delivery-affecting flag); agents pass steer instead
      // (POST /api/agents/:id/send-now is privileged-only, so it was never the
      // answer for an ordinary agent).
      if (b.sendNow !== undefined && ctx.identity.scope !== "user") {
        return fail(
          400,
          "send_now_not_supported",
          ctx.identity.scope === "agent"
            ? "sendNow is only supported for user senders; agents pass steer:true instead."
            : "sendNow is only supported for user senders.",
        );
      }
      // steer is the mirror image: AGENT-branch only. A user with the same
      // intent has sendNow, which is not rate-limited and not refused mid
      // multi-step flow - a person deciding to interrupt their own agent is not
      // the thing the steer guard rails protect against.
      if (b.steer !== undefined && ctx.identity.scope !== "agent") {
        return fail(
          400,
          "steer_not_supported",
          "steer is only supported for agent (bearer-token) senders; user senders pass sendNow.",
        );
      }
      // Scheduling is AGENT-branch only. A USER-scope deliverAt is REJECTED,
      // never silently sent immediately (review-pinned): a boss who typed a
      // future time must not have the message land now without noticing.
      if (b.deliverAt !== undefined && ctx.identity.scope !== "agent") {
        return fail(
          400,
          "deliver_at_not_supported",
          "deliverAt is only supported for agent (bearer-token) senders.",
        );
      }
      if (ctx.identity.scope === "cron-run" && b.attachments !== undefined) {
        return fail(
          400,
          "attachments_not_supported",
          "attachments are not supported for cron job senders.",
        );
      }
      if (
        ctx.identity.scope === "api" &&
        (b.device !== undefined ||
          b.attachments !== undefined ||
          b.senderAgentId !== undefined)
      ) {
        return fail(
          400,
          "api_attribution_not_supported",
          "device, attachments, and senderAgentId are not supported for API token senders.",
        );
      }
      if (ctx.identity.scope === "cron-run" && b.senderAgentId !== undefined) {
        return fail(
          400,
          "sender_agent_not_supported",
          "senderAgentId is not supported for cron job senders.",
        );
      }
      if (ctx.identity.scope === "agent") {
        // messageSend's senderMustEqualTokenAgent branch already proved the
        // agent identity; agentId is a present non-empty string here.
        const senderAgentId = ctx.identity.agentId ?? "";
        if (b.text.length === 0) {
          return fail(400, "invalid_text", "text is required");
        }
        if (b.deliverAt !== undefined) {
          // A scheduled steer would have to decide, minutes or days later,
          // whether interrupting is still what the sender wanted. Out of this
          // slice, so the combination is refused rather than silently dropping
          // one of the two flags.
          if (b.steer !== undefined) {
            return fail(
              400,
              "steer_with_deliver_at",
              "steer cannot be combined with deliverAt; a scheduled message is always delivered as a plain queue.",
            );
          }
          const deliverAtMs = parseDeliverAt(b.deliverAt);
          if (deliverAtMs === null) {
            return fail(
              400,
              "invalid_deliver_at",
              "deliverAt must be RFC3339 with an explicit 'Z' or numeric UTC offset (e.g. 2026-07-12T09:30:00Z).",
            );
          }
          const r = deps.scheduleMessage(
            ctx.params.id,
            senderAgentId,
            b.text,
            deliverAtMs,
            b.clientMessageId,
          );
          if (!r.ok) return fail(r.status, r.code, r.message);
          // Normalized UTC echo (not the caller's original string) so the ack
          // is unambiguous regardless of the offset the caller used. A deduped
          // retry returns the ORIGINAL entry's id and time.
          return ok({
            scheduledId: r.entry.id,
            deliverAt: new Date(r.entry.deliverAt).toISOString(),
          });
        }
        const r = deps.sendAsAgent(
          ctx.params.id,
          senderAgentId,
          b.text,
          b.clientMessageId,
          b.steer === true,
        );
        if (r.ok)
          return ok({
            messageId: r.messageId ?? "",
            ...(r.queued === undefined ? {} : { queued: r.queued }),
            ...(r.steered === undefined ? {} : { steered: r.steered }),
            ...(r.steerDeclined === undefined
              ? {}
              : { steerDeclined: r.steerDeclined }),
          });
        return fail(r.status, r.code, r.message);
      }
      if (ctx.identity.scope === "cron-run") {
        if (b.text.length === 0) {
          return fail(400, "invalid_text", "text is required");
        }
        const r = deps.sendAsCron(
          ctx.params.id,
          ctx.identity.cronjobId ?? "",
          b.text,
          b.clientMessageId,
        );
        if (r.ok)
          return ok({
            messageId: r.messageId ?? "",
            ...(r.queued === undefined ? {} : { queued: r.queued }),
          });
        return fail(r.status, r.code, r.message);
      }
      if (ctx.identity.scope === "api") {
        if (b.text.length === 0) {
          return fail(400, "invalid_text", "text is required");
        }
        // A personal token is the issuing human, not a separate machine
        // principal. Keeping the user sender kind preserves human-input
        // completion notifications; only the server-derived device differs.
        const r = await deps.sendAsApi(
          ctx.params.id,
          b.text,
          deps.attributionFor(ctx.identity).username,
          formatApiTokenDevice(ctx.identity.apiTokenName ?? "unknown"),
        );
        if (!r.ok) return fail(r.status, r.code, r.message);
        return ok({ messageId: "" });
      }
      // USER path: fire-and-forget. Empty text is allowed when attachments carry
      // the content (the composer sends an image with no caption). The ack body
      // is "" - there is no single queued id (sendMessage may echo, queue, or
      // recover); the UI ignores it and consumes the WS stream (double-signal).
      deps.sendAsUser(
        ctx.params.id,
        b.text,
        deps.attributionFor(ctx.identity).username,
        b.device,
        b.attachments,
        b.sendNow === true,
      );
      return ok({ messageId: "" });
    },

    "agents.editMessage": (ctx) => {
      const b = (ctx.body ?? {}) as Partial<EditMessageReq>;
      if (typeof b.newText !== "string" || b.newText.length === 0) {
        return fail(422, "invalid_text", "newText is required");
      }
      if (b.device !== undefined && typeof b.device !== "string") {
        return fail(422, "invalid_request", "device must be a string");
      }
      // Streaming / fire-and-forget like sendMessage: the corrected turn streams
      // over WS, so the ack is empty and the UI ignores it.
      deps.editMessage(
        ctx.params.id,
        ctx.params.logEntryId,
        b.newText,
        deps.attributionFor(ctx.identity).username,
        b.device,
      );
      return ok({ messageId: "" });
    },

    "agents.cancelQueued": (ctx) => {
      deps.cancelQueued(ctx.params.id, ctx.params.messageId);
      return noContent();
    },

    // Scheduled-message outbox (task 8ff369b5). `:id` is the SENDER here; the
    // scheduledMessagesOwner guard already proved the caller may manage that
    // sender's outbox (the agent itself, or a user with room access to it).
    "agents.listScheduledMessages": (ctx) =>
      ok({ scheduled: deps.listScheduledMessages(ctx.params.id) }),

    "agents.cancelScheduledMessage": (ctx) => {
      const r = deps.cancelScheduledMessage(
        ctx.params.id,
        ctx.params.scheduledId,
      );
      if (!r.ok) return fail(r.status, r.code, r.message);
      return noContent();
    },

    // Reports refusals instead of swallowing them (task 5dcb0a02). The common
    // one is an agent in `error` after its backend died: every queue-flush
    // trigger is gated on an idle state, so the flush silently does nothing,
    // and the old unconditional 204 was indistinguishable from a delivery.
    "agents.sendNow": (ctx) => {
      const r = deps.sendNow(ctx.params.id);
      if (!r.ok) return fail(r.status, r.code, r.message);
      return noContent();
    },

    "agents.newConversation": (ctx) => {
      const b = (ctx.body ?? {}) as Partial<NewConversationReq>;
      // Narrow to the known engines; ignore anything else so a stale/hand-crafted
      // client can't push an unknown agentType into the switch.
      const agentType =
        b.agentType === "claude" || b.agentType === "codex"
          ? b.agentType
          : undefined;
      deps.newConversation(ctx.params.id, agentType);
      return noContent();
    },

    // Instant self-handoff (task 8883e45d): reset the session then deliver the
    // brief into the fresh session, in one call. Same auth split as
    // newConversation (conversationReset). 422 on empty/missing text - a handoff
    // with no brief is useless, and matches resume's required-field style. AWAITS
    // the reset+enqueue and maps an enqueue failure to a real HTTP error, so the
    // caller never gets a false {ok:true} when the brief was not
    // persisted/delivered. The caller's own turn is typically aborted by its
    // reset mid-request; the handler still runs to completion server-side.
    "agents.handoff": async (ctx) => {
      const b = (ctx.body ?? {}) as Partial<HandoffReq>;
      if (typeof b.text !== "string" || b.text.length === 0) {
        return fail(422, "invalid_text", "text is required");
      }
      const r = await deps.handoff(ctx.params.id, b.text);
      if (!r.ok) return fail(r.status, r.code, r.message);
      return ok({ ok: true });
    },

    "agents.resume": (ctx) => {
      const b = (ctx.body ?? {}) as Partial<ResumeReq>;
      if (typeof b.sessionId !== "string" || b.sessionId.length === 0) {
        return fail(422, "invalid_request", "sessionId is required");
      }
      deps.resume(ctx.params.id, b.sessionId);
      return noContent();
    },

    "agents.listSessions": (ctx) => ok(deps.listSessions(ctx.params.id)),
  };
}
