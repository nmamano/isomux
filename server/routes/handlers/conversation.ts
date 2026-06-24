// Agents — conversation resource handlers — Phase 3d slice 6a. The
// send/edit/cancel/sendNow/newConversation/resume/listSessions surface moves off
// the WS command bus to REST. EXPAND+CUT in one slice (like slices 6/7): the rows
// were table-declared but never handler-registered, so this slice BUILDS the
// handlers AND deletes the WS cases (+ the legacy POST /agents/:id/message).
//
// STREAMING, not response-returning: send/edit/sendNow/newConversation/resume are
// FIRE-AND-FORGET on the turn — the index dep closures void-discard the manager
// promise and the handler returns only an ack; the log_entry / approval_request /
// clear_logs events STREAM over the WS as the turn runs (the double-signal: HTTP
// acks, WS streams). An awaited HTTP response would block on the whole turn.
//
// sendMessage is UNIFIED + OVERLOADED across the two identity branches the
// messageSend guard authorizes:
//   - USER (cookie, agent:converse)      -> sendAsUser  (agentManager.sendMessage;
//     the user-chat path. The approval-reply OVERLOAD lives INSIDE sendMessage —
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
  SessionInfo,
  AgentBackendType,
} from "../../../shared/types.ts";
import type {
  SendMessageReq,
  EditMessageReq,
  ResumeReq,
  NewConversationReq,
} from "../../../shared/contract-shapes.ts";

// The AGENT (inter-agent) send outcome. The failure carries the status + stable
// code directly (self-send/unknown-sender from the dep's checks; otherwise
// enqueueMessage's own status + error code passed through verbatim), so the
// handler stays a thin mapper and the legacy POST /agents/:id/message contract
// (400 self/unknown, 404 unknown-receiver, 409 agent_error/agent_stopped, 429
// queue_full) is preserved bit-for-bit.
export type SendAsAgentResult =
  | { ok: true; messageId?: string }
  | { ok: false; status: 400 | 404 | 409 | 429; code: string; message: string };

export interface ConversationDeps {
  // Token-derived attribution (username from identity, NEVER the body) for the
  // USER chat + edit paths — the WS cases used session.username, not a body field.
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  // USER chat send. Void — sendMessage owns the echo / queue / recovery / slash /
  // approval-reply overload and streams the turn over WS; there is no queued id
  // to ack (the UI ignores the body and consumes the stream).
  sendAsUser(
    agentId: string,
    text: string,
    username: string | undefined,
    device: string | undefined,
    attachments: Attachment[] | undefined,
  ): void;
  // AGENT inter-agent send. Builds the structured sender server-side (blocks
  // prefix-injection / identity spoof) and enqueues; returns the discriminated
  // outcome above.
  sendAsAgent(
    receiverId: string,
    senderAgentId: string,
    text: string,
    clientMessageId: string | undefined,
  ): SendAsAgentResult;
  // Edit a prior message. Void / streaming, same shape as sendAsUser.
  editMessage(
    agentId: string,
    logEntryId: string,
    newText: string,
    username: string | undefined,
    device: string | undefined,
  ): void;
  cancelQueued(agentId: string, messageId: string): void;
  sendNow(agentId: string): void;
  newConversation(agentId: string, agentType?: AgentBackendType): void;
  resume(agentId: string, sessionId: string): void;
  listSessions(agentId: string): {
    sessions: SessionInfo[];
    currentSessionId: string | null;
  };
}

// Reject a present-but-wrong-typed optional field at the boundary. A direct REST
// caller can POST {text:"x", attachments:{}} — truthy but non-iterable — which the
// USER path would queue and flushQueue would later spread
// (allAttachments.push(...m.attachments)), throwing mid-turn; a non-string device
// / clientMessageId would corrupt log metadata / the dedupe key. Mirrors slice
// 7b's malformedAgentFields: strict on the container TYPE, parity-loose on element
// shape (the WS command never element-validated either).
function malformedSendFields(b: Record<string, unknown>): boolean {
  if (b.device !== undefined && typeof b.device !== "string") return true;
  if (b.clientMessageId !== undefined && typeof b.clientMessageId !== "string")
    return true;
  if (b.attachments !== undefined && !Array.isArray(b.attachments)) return true;
  return false;
}

export function conversationHandlers(
  deps: ConversationDeps,
): Record<string, RouteHandler> {
  return {
    "agents.sendMessage": (ctx) => {
      const b = (ctx.body ?? {}) as Partial<SendMessageReq>;
      // 400 (not 422) on the text checks + the AGENT-branch reasons below mirrors
      // the legacy POST /agents/:id/message status codes that queue.test.ts pins
      // as "today's status codes" — this route REPLACES that endpoint, so it must
      // not silently drift the agent-facing contract.
      if (typeof b.text !== "string") {
        return fail(400, "invalid_text", "text is required");
      }
      if (malformedSendFields(b)) {
        return fail(
          422,
          "invalid_request",
          "device and clientMessageId must be strings; attachments must be an array",
        );
      }
      if (ctx.identity.scope === "agent") {
        // messageSend's senderMustEqualTokenAgent branch already proved the
        // agent identity; agentId is a present non-empty string here.
        const senderAgentId = ctx.identity.agentId ?? "";
        if (b.text.length === 0) {
          return fail(400, "invalid_text", "text is required");
        }
        const r = deps.sendAsAgent(
          ctx.params.id,
          senderAgentId,
          b.text,
          b.clientMessageId,
        );
        if (r.ok) return ok({ messageId: r.messageId ?? "" });
        return fail(r.status, r.code, r.message);
      }
      // USER path: fire-and-forget. Empty text is allowed when attachments carry
      // the content (the composer sends an image with no caption). The ack body
      // is "" — there is no single queued id (sendMessage may echo, queue, or
      // recover); the UI ignores it and consumes the WS stream (double-signal).
      deps.sendAsUser(
        ctx.params.id,
        b.text,
        deps.attributionFor(ctx.identity).username,
        b.device,
        b.attachments,
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

    "agents.sendNow": (ctx) => {
      deps.sendNow(ctx.params.id);
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
