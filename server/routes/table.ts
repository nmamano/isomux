// Typed route table. The single source of truth for route declarations. Each
// route declares { opId, method, path, auth, emits } plus its request/response
// TYPES. See
// internal-docs/generic-runtime-refactor.md → "Server API Spec" → REST route table.
//
// This data is contract-tested for structural invariants: unique opId, unique
// method+path, every emit resolves to a registry event, a valid capability +
// guard on every capability route, and NO public route is ever fed to
// authorize().
//
// Boundaries deliberately kept OUT of the resourceGuard (the core op enforces
// them against LIVE state, not pure authz) are declared as the TYPED
// `preconditions` field (see RoutePrecondition) and pinned by a contract test,
// NOT left as prose: agents.revive's lastRoomId access; invites.revoke /
// sessions.revoke member-own scoping + not-last-owner lockout; validate.env's
// body-sourced self subject; agents.sendMessage's recipient-existence +
// pendingPermission-binds-:id. The TARGET-room access etc. that CAN be a pure
// guard still is one; only the live-state checks are preconditions.

import type { Capability } from "../identity/index.ts";
import type { RouteAuthz } from "../identity/dispatch.ts";
import {
  authenticated,
  operationalAuthenticated,
  agentTokenSender,
  apiTokenInboxSelf,
  selfOrOwner,
  selfUserOrApi,
  officeOwner,
  officeEnvOwner,
  userScope,
  requiresRoomAccess,
  agentParamMustEqualTokenAgent,
  agentManagerMatch,
  messageSend,
  scheduledMessagesOwner,
  conversationReset,
  logSearchAccess,
  cronjobOwnerOrOfficeOwner,
  appOwnerOrOfficeOwner,
  appScope,
  hasOwningUser,
  runParamMustEqualTokenRun,
  taskDelete,
  and,
  or,
  type Guard,
} from "../identity/guards.ts";
import type { EventId } from "../events/registry.ts";
import type { SteerDeclineReason } from "../internal-types.ts";
import type {
  AgentInfo,
  RoomWire,
  TaskItem,
  Cronjob,
  CronjobRun,
  ScheduledMessageEntry,
  SessionInfo,
  SessionWire,
  InviteWire,
  Attachment,
  BackendModelWire,
  ProviderAccountsWire,
  ProviderLoginStartReq,
  ProviderLoginStartRes,
  ProviderLoginCallbackReq,
  ProviderLoginCancelReq,
  ProviderDisconnectReq,
  LogEntry,
  UpdateStatusWire,
} from "../../shared/types.ts";
import type {
  SpawnReq,
  EditAgentReq,
  SetPrivilegedReq,
  ReviveReq,
  MoveAgentReq,
  SwapDesksReq,
  SendMessageReq,
  EditMessageReq,
  ResumeReq,
  NewConversationReq,
  HandoffReq,
  TopicReq,
  AffordanceReadFileReq,
  AffordanceEditFileReq,
  AffordanceDiffReq,
  AffordanceTerminalCmdReq,
  AffordancePreviewUrlReq,
  AgentContextUsageResp,
  LogsResp,
  EditorSaveReq,
  RoomCreateReq,
  RoomRenameReq,
  RoomSettingsReq,
  RoomSettingsRes,
  ViewOrderReq,
  ShownRoomsReq,
  NotifRoomsReq,
  MeRoomsRes,
  PreferencesReq,
  ApiTokenCreateReq,
  ApiTokenCreateRes,
  ApiTokenListRes,
  ApiTokenInboxDrainRes,
  ApiTokenInboxSendReq,
  ApiTokenInboxSendRes,
  RecoveryMintReq,
  UserUpdateReq,
  SetAccessReq,
  UserEnvNamesRes,
  UserEnvReplaceReq,
  UserEnvRes,
  InviteMintReq,
  AccessSettingsReq,
  AccessSettings,
  OfficeSettingsReq,
  OfficeSettingsRes,
  ValidateCwdReq,
  ValidateEnvReq,
  TaskCreateReq,
  TaskUpdateReq,
  TaskClaimReq,
  AppLogsRes,
  AppMessageReq,
  AppRegisterReq,
  AppUpdateReq,
  AppListWire,
  AppWire,
  MemoryCreateReq,
  MemoryReplaceReq,
  MemoryReadRes,
  MemoryAppendRes,
  MemoryWriteRes,
  SkillUsageCountsRes,
  CronCreateReq,
  CronUpdateReq,
  CronRunMessageReq,
  CronPromptReq,
  UserSelfWire,
  UserAdminWire,
  StorageUsageWire,
  UsageReportWire,
  StoragePruneReq,
  StoragePruneRes,
  BackupStatusWire,
} from "../../shared/contract-shapes.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// A route's authorization, as a discriminated union so the caution is
// STRUCTURAL: a `public` route carries no resourceGuard, so by TYPE
// it cannot be passed to authorize() (which 401s on a null identity); an
// `authenticated` route needs identity but no capability (e.g. logout). A
// contract test pins that no public route reaches authorize() and that every
// capability route has a valid cap + guard.
export type RouteAuth =
  | ({ kind: "capability" } & RouteAuthz)
  | { kind: "authenticated"; resourceGuard: Guard }
  | { kind: "public" };

// Route-contract PRECONDITIONS: semantic checks the core op MUST enforce
// against LIVE state, deliberately kept OUT of the pure resourceGuard (a guard
// has no live-state dependency). Encoded as TYPED DATA, not prose, so the audit
// surface can ENUMERATE them and a contract test can pin each route's set -
// comments alone are too easy to forget.
export type RoutePrecondition =
  // agents.revive: caller must also have access to the killed agent's lastRoomId.
  // The resourceGuard covers only the TARGET room (body.roomId); lastRoomId is
  // live-state (the killed agent's last room), with no RoomRef kind.
  | "reviveLastRoomAccess"
  // invites.revoke: owner may revoke any invite; a member only their own (needs
  // the invite-owner lookup, not in GuardDeps).
  | "inviteOwnerOrSelf"
  // sessions.revoke: owner may revoke any session; a member only their own.
  | "sessionOwnerOrSelf"
  // sessions.revoke / sessions.logout: refuse if it would leave the office with
  // no owner holding an active session (shell-recovery lockout; live owner-count).
  | "notLastOwnerLockout"
  // validate.env: the self subject is body.username (not a path param), so the
  // self/office-owner branch maps off the body, not selfUser's params.username.
  | "validateEnvBodySelfSubject"
  // agents.sendMessage (AGENT scope): the recipient agent must exist - a cross-
  // room delivery check that must NEVER become an ACL existence leak.
  | "messageRecipientExists"
  // agents.sendMessage: while a pendingPermission is set for :id, the next
  // message to THAT agent is its allow/deny - interpretation binds to :id.
  | "messagePendingPermissionBindsParam"
  | "apiTokenInboxTargetAvailable"
  // users.delete: an owner may not delete their OWN record (would brick in-browser
  // recovery; sign out / transfer ownership instead). Runs after selfOrOwner.
  | "userDeleteNotSelfOwner"
  // users.delete: refuse a delete that would leave the office with no owner record
  // (defense-in-depth; same invariant as the session-revoke lockout).
  | "userDeleteNotLastOwner";

export interface RouteDef<Req = unknown, Res = unknown> {
  opId: string;
  method: HttpMethod;
  path: string;
  auth: RouteAuth;
  // Declared contribution to shared state; every id must exist in the event
  // registry (enforced by the `EventId[]` type + a contract test). The HTTP
  // response is separate (the caller's outcome).
  emits: readonly EventId[];
  // Live-state semantic preconditions the handler must enforce (NOT pure
  // authz; see RoutePrecondition). Absent ⇒ none. Pinned by a contract test.
  preconditions?: readonly RoutePrecondition[];
  // Phantom type carriers (no runtime presence): bind the request/response types
  // for handler typing. defineRoute<Req,Res> attaches them.
  readonly __req?: Req;
  readonly __res?: Res;
}

// Attach request/response types to a route without a runtime field. The explicit
// <Req,Res> at each call site IS the type-level schema - a typo'd type name
// fails to compile, the `satisfies`-equivalent the design calls for.
export function defineRoute<Req = void, Res = void>(
  def: Omit<RouteDef<Req, Res>, "__req" | "__res">,
): RouteDef<Req, Res> {
  return def;
}

function cap(
  requiredCapability: Capability | readonly Capability[],
  resourceGuard: Guard,
): RouteAuth {
  return { kind: "capability", requiredCapability, resourceGuard };
}
function authn(resourceGuard: Guard): RouteAuth {
  return { kind: "authenticated", resourceGuard };
}
const pub: RouteAuth = { kind: "public" };

const roomParam = (name: string): Guard =>
  requiresRoomAccess({ kind: "paramRoomId", name });
// Capability-free agent routes also use this shorthand. APP stays outside;
// remote-boss API identities use their issuing user's room projection.
const agentParam = (name: string): Guard => {
  const roomAccess = requiresRoomAccess({ kind: "paramAgentId", name });
  return (ctx) => {
    const identityGate = operationalAuthenticated(ctx);
    return identityGate.ok ? roomAccess(ctx) : identityGate;
  };
};
const bodyRoom = (name: string): Guard =>
  requiresRoomAccess({ kind: "bodyRoomId", name });

type NoContent = void;
type MessageAck = { messageId: string };
// agents.sendMessage's own ack. `queued` answers the question the
// sender cannot otherwise see: true = the message is parked behind the receiver's
// in-flight turn and lands when that turn ends; false = it went straight into a
// turn. Optional because only the AGENT branch knows: the USER branch is
// fire-and-forget (empty messageId, no enqueue result), and a deduped retry is an
// ack for the ORIGINAL send, whose queued/delivered answer this call never
// learned. A point-in-time fact about THIS send, not receiver state.
// `steered` / `steerDeclined` ride the same rule and appear only
// when the send asked to steer: steered:true = an in-flight turn was interrupted
// for this message; steered:false with no reason = there was no turn to
// interrupt; steerDeclined = a guard rail refused, and the message is queued.
type AgentMessageAck = {
  messageId: string;
  queued?: boolean;
  steered?: boolean;
  steerDeclined?: SteerDeclineReason;
};
// Schedule-branch ack (agents.sendMessage with deliverAt): the scheduled-entry
// handle plus the normalized (UTC RFC3339) delivery time - never a fake empty
// messageId.
type ScheduledAck = { scheduledId: string; deliverAt: string };
type ScheduledMessagesListRes = { scheduled: ScheduledMessageEntry[] };
type AgentEnvelope = { agent: AgentInfo };
// agents.readInstructions: the customInstructions blob + its
// concurrency token - the read half of the read-then-PATCH flow that
// agents.update's version guard expects. Field names match
// EditAgentReq exactly so a caller reads, edits, and echoes the version back.
type AgentInstructionsRes = {
  customInstructions: string | null;
  customInstructionsVersion: string;
};
type OkTrue = { ok: true };
type InteractionResponseReq = { value: string };
type InteractionResponseRes = {
  interactionId: string;
  status: "settled" | "canceled";
};

export const API_ROUTES: readonly RouteDef[] = [
  defineRoute<SpawnReq, AgentEnvelope>({
    opId: "agents.spawn",
    method: "POST",
    path: "/api/agents",
    auth: cap("agent:manage", bodyRoom("roomId")),
    emits: ["agent_added"],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.kill",
    method: "DELETE",
    path: "/api/agents/:id",
    auth: cap("agent:manage", agentParam("id")),
    emits: ["agent_removed", "killed_agent_added"],
  }),
  defineRoute<ReviveReq, AgentEnvelope>({
    opId: "agents.revive",
    method: "POST",
    path: "/api/agents/:id/revive",
    // Guard: access to the TARGET room (body.roomId). The ∧ lastRoomId access
    // check is a typed precondition (killed-agent last room is live-state).
    auth: cap("agent:manage", bodyRoom("roomId")),
    emits: ["agent_added", "killed_agent_removed"],
    preconditions: ["reviveLastRoomAccess"],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.abort",
    method: "POST",
    path: "/api/agents/:id/abort",
    auth: cap("agent:manage", agentParam("id")),
    emits: [],
  }),
  defineRoute<EditAgentReq, AgentEnvelope>({
    opId: "agents.update",
    method: "PATCH",
    path: "/api/agents/:id",
    auth: cap("agent:manage", agentParam("id")),
    emits: ["agent_updated"],
  }),
  // Read an agent's customInstructions blob + version token.
  // `authenticated` (no capability): EVERY agent may read any agent
  // it can see - privilege gates the WRITE (agents.update), and the version
  // token is a lost-update/race guard, NOT an authorization mechanism. The
  // agentParam guard matches the roster's room-access VISIBILITY (who you can
  // read; the payload is deliberately narrower than the roster's): an
  // inaccessible or nonexistent :id is a uniform 403 (no existence oracle).
  defineRoute<void, AgentInstructionsRes>({
    opId: "agents.readInstructions",
    method: "GET",
    path: "/api/agents/:id/instructions",
    auth: authn(agentParam("id")),
    emits: [],
  }),
  // Owner-administrative privilege toggle. Its OWN route (not a field on
  // agents.update), mirroring users.setAccess vs users.update: editing normal
  // props is agent:manage, but conferring privilege needs higher authority and a
  // heavy side effect (token re-mint + session-swap) that earns its own handler.
  // DOUBLE-GATED so no agent - privileged or not - can ever flip the flag:
  // stage-1 cap `agent:privilege` is absent from both the AGENT and the
  // privileged-agent capability sets (only USER scope holds it), and stage-2
  // `userScope` blocks any non-user scope. CONFERRAL SCOPE:
  // an office owner toggles any agent; a member toggles ONLY agents they manage
  // (manager-match on AgentInfo.userId) - NOT mere room co-membership, which
  // would let a member elevate another member's agent (cross-user confused
  // deputy). `userScope` stays OUTERMOST so an agent whose userId coincides with
  // the target's manager still can't pass the manager-match branch.
  defineRoute<SetPrivilegedReq, AgentEnvelope>({
    opId: "agents.setPrivileged",
    method: "PUT",
    path: "/api/agents/:id/privileged",
    auth: cap(
      "agent:privilege",
      and(userScope, or(officeOwner, agentManagerMatch("id"))),
    ),
    emits: ["agent_updated"],
  }),
  defineRoute<MoveAgentReq, AgentEnvelope>({
    opId: "agents.move",
    method: "POST",
    path: "/api/agents/:id/move",
    auth: cap("agent:manage", and(agentParam("id"), bodyRoom("targetRoomId"))),
    emits: ["agent_updated"],
  }),
  defineRoute<TopicReq, NoContent>({
    opId: "agents.setTopic",
    method: "PUT",
    path: "/api/agents/:id/topic",
    auth: cap("agent:manage", agentParam("id")),
    emits: ["agent_updated"],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.clearTopic",
    method: "DELETE",
    path: "/api/agents/:id/topic",
    auth: cap("agent:manage", agentParam("id")),
    emits: ["agent_updated"],
  }),
  defineRoute<SwapDesksReq, NoContent>({
    opId: "rooms.swapDesks",
    method: "POST",
    path: "/api/rooms/:roomId/swap-desks",
    auth: cap("agent:manage", roomParam("roomId")),
    emits: ["agent_updated"], // ×2 at runtime; one registry id
  }),

  defineRoute<SendMessageReq, AgentMessageAck | ScheduledAck>({
    opId: "agents.sendMessage",
    method: "POST",
    path: "/api/agents/:id/messages",
    // any-of so a USER (converse) and an AGENT (send-as-self) both clear stage 1
    // and reach messageSend's scope-specific stage-2 branch.
    // With body.deliverAt (AGENT branch only) the send becomes a SCHEDULED
    // message: stored durably, fired later by scheduled-messages.ts; the ack is
    // ScheduledAck instead of MessageAck. Same route on purpose - one send
    // surface, one new field.
    auth: cap(
      [
        "agent:converse",
        "agent:send-as-self",
        "agent:send-as-cron",
        "api:send-message",
      ],
      messageSend,
    ),
    emits: ["log_entry", "interaction_added", "agent_updated"],
    preconditions: [
      "messageRecipientExists",
      "messagePendingPermissionBindsParam",
    ],
  }),
  defineRoute<InteractionResponseReq, InteractionResponseRes>({
    opId: "agents.respondInteraction",
    method: "POST",
    path: "/api/agents/:id/interactions/:interactionId/respond",
    // The same operator-vs-self policy as conversation reset. It allows a
    // human operator (or a privileged agent with agent:converse) to answer a
    // reachable agent, while an ordinary agent cannot use its spawning user's
    // room grants as a confused deputy.
    auth: cap(["agent:converse", "self:affordance"], conversationReset),
    emits: ["interaction_removed", "agent_updated", "log_entry", "clear_logs"],
  }),
  // `:id` is the SENDER here (the outbox being managed) - the deliberate
  // asymmetry with the send route above, where `:id` is the recipient. See
  // scheduledMessagesOwner for the scope-switched authority rules.
  defineRoute<void, ScheduledMessagesListRes>({
    opId: "agents.listScheduledMessages",
    method: "GET",
    path: "/api/agents/:id/scheduled-messages",
    auth: cap(["agent:converse", "agent:send-as-self"], scheduledMessagesOwner),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.cancelScheduledMessage",
    method: "DELETE",
    path: "/api/agents/:id/scheduled-messages/:scheduledId",
    auth: cap(["agent:converse", "agent:send-as-self"], scheduledMessagesOwner),
    emits: [],
  }),
  defineRoute<EditMessageReq, MessageAck>({
    opId: "agents.editMessage",
    method: "PATCH",
    path: "/api/agents/:id/messages/:logEntryId",
    auth: cap("agent:converse", agentParam("id")),
    emits: ["log_entry"],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.cancelQueued",
    method: "DELETE",
    path: "/api/agents/:id/queue/:messageId",
    auth: cap("agent:converse", agentParam("id")),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.sendNow",
    method: "POST",
    path: "/api/agents/:id/send-now",
    auth: cap("agent:converse", agentParam("id")),
    emits: ["log_entry"],
  }),
  // Clear the session and start a fresh conversation. Operators (users +
  // privileged agents holding agent:converse) clear any agent in an accessible
  // room; an ordinary agent may clear ITSELF (self:affordance), which is what
  // lets the /isomux-self-handoff skill schedule a wake-up then reset its own
  // session. conversationReset enforces the operator-vs-self split.
  defineRoute<NewConversationReq, NoContent>({
    opId: "agents.newConversation",
    method: "POST",
    path: "/api/agents/:id/new-conversation",
    auth: cap(["agent:converse", "self:affordance"], conversationReset),
    emits: ["clear_logs"],
  }),
  // Instant self-handoff: reset the session (like
  // new-conversation) AND deliver {text} into the fresh session as the agent's
  // own brief, in one call - the fast path the /handoff skill uses instead of the
  // up-to-30s deliverAt + separate reset detour. One handoff at a time per agent
  // (a concurrent second gets 409 handoff_in_progress, so the running one can't
  // be clobbered into a false success); the enqueue is transactional, so a
  // delivery failure surfaces as an HTTP error, not a false ack. Same auth split
  // as new-conversation (conversationReset): an operator
  // hands off any reachable agent, an ordinary agent only itself. Emits
  // clear_logs (the reset) then the fresh turn's log_entry (the injected brief).
  defineRoute<HandoffReq, { ok: true }>({
    opId: "agents.handoff",
    method: "POST",
    path: "/api/agents/:id/handoff",
    auth: cap(["agent:converse", "self:affordance"], conversationReset),
    emits: ["clear_logs", "log_entry"],
  }),
  defineRoute<ResumeReq, NoContent>({
    opId: "agents.resume",
    method: "POST",
    path: "/api/agents/:id/resume",
    auth: cap("agent:converse", agentParam("id")),
    emits: ["log_entry"],
  }),
  defineRoute<
    void,
    { sessions: SessionInfo[]; currentSessionId: string | null }
  >({
    opId: "agents.listSessions",
    method: "GET",
    path: "/api/agents/:id/sessions",
    auth: cap("office:read", agentParam("id")),
    emits: [],
  }),

  defineRoute<AffordanceReadFileReq, OkTrue>({
    opId: "agents.readFile",
    method: "POST",
    path: "/api/agents/:id/read-file",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    emits: ["log_entry"],
  }),
  defineRoute<AffordanceDiffReq, OkTrue>({
    opId: "agents.diff",
    method: "POST",
    path: "/api/agents/:id/diff",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    emits: ["log_entry"],
  }),
  defineRoute<AffordanceEditFileReq, OkTrue>({
    opId: "agents.editFile",
    method: "POST",
    path: "/api/agents/:id/edit-file",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    emits: ["log_entry"],
  }),
  defineRoute<AffordanceTerminalCmdReq, OkTrue>({
    opId: "agents.terminalCommand",
    method: "POST",
    path: "/api/agents/:id/terminal-command",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    emits: ["log_entry"],
  }),
  defineRoute<AffordancePreviewUrlReq, OkTrue>({
    opId: "agents.previewUrl",
    method: "POST",
    path: "/api/agents/:id/preview-url",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    emits: ["log_entry"],
  }),
  // Context-window fullness self-check (internal-docs/
  // context-fullness-visibility.md): the agent's own latest fullness sample.
  // Read-only - nothing lands in chat, so no log_entry emit.
  defineRoute<void, AgentContextUsageResp>({
    opId: "agents.contextUsage",
    method: "GET",
    path: "/api/agents/:id/context",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    emits: [],
  }),

  // Conversation-log search + retrieval. ONE route
  // with three modes, chosen by the query: ?q= searches, ?session= retrieves,
  // neither lists the agent's sessions. Read-only, so nothing is emitted.
  //
  // Its OWN capability (`log:read`) rather than office:read, which plain agent
  // tokens do not carry - see the Capability union in identity/index.ts. The
  // guard widens an AGENT's reach past its own chat to any agent in a room its
  // boss can access; logSearchAccess documents why that is sound for a read.
  defineRoute<void, LogsResp>({
    opId: "agents.logs",
    method: "GET",
    path: "/api/agents/:id/logs",
    auth: cap("log:read", logSearchAccess),
    emits: [],
  }),

  defineRoute<
    void,
    // `path` is the RESOLVED absolute path (the client opens by a possibly-relative
    // path but keys the tab + matches editor_external_change by the resolved one,
    // exactly as the retired editor_content event echoed it back).
    {
      path: string;
      content: string;
      mtime: number;
      language: string;
      size: number;
    }
  >({
    opId: "agents.openFile",
    method: "GET",
    path: "/api/agents/:id/file",
    auth: cap("editor:use", agentParam("id")),
    emits: ["editor_external_change"], // pushed async to the watching session
  }),
  defineRoute<EditorSaveReq, { ok: true; mtime: number }>({
    opId: "agents.saveFile",
    method: "PUT",
    path: "/api/agents/:id/file",
    auth: cap("editor:use", agentParam("id")),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.closeFile",
    method: "DELETE",
    path: "/api/agents/:id/file/watch",
    auth: cap("editor:use", agentParam("id")),
    emits: [],
  }),

  defineRoute<unknown, { attachments: Attachment[] }>({
    opId: "agents.upload",
    method: "POST",
    path: "/api/agents/:id/uploads",
    auth: cap("file:upload", agentParam("id")),
    emits: [],
  }),
  defineRoute<void, unknown>({
    opId: "agents.getFile",
    method: "GET",
    path: "/api/agents/:id/files/:filename",
    auth: cap("office:read", agentParam("id")),
    emits: [],
  }),

  defineRoute<RoomCreateReq, { room: RoomWire }>({
    opId: "rooms.create",
    method: "POST",
    path: "/api/rooms",
    auth: cap("room:manage", operationalAuthenticated),
    emits: ["room_created"],
  }),
  defineRoute<void, NoContent>({
    opId: "rooms.close",
    method: "DELETE",
    path: "/api/rooms/:roomId",
    auth: cap("room:manage", roomParam("roomId")),
    // room_closed is the structure delta; closing also strips the dead roomId
    // from every user's allowedRooms/notifRooms, fanning out the representative
    // public user events (user_updated per touched record + users_list). Declared
    // for ACL/projection honesty (presence is out-of-band, never route-declared).
    emits: ["room_closed", "user_updated", "users_list"],
  }),
  // Partial update over the room's cosmetic fields: the body carries `name`,
  // `pet`, or both, and each is applied only when present. The opId still reads
  // "rooms.rename" because it namespaces idempotency keys and the handler map;
  // renaming it would be a rename across two test tables for a cosmetic gain.
  defineRoute<RoomRenameReq, NoContent>({
    opId: "rooms.rename",
    method: "PATCH",
    path: "/api/rooms/:roomId",
    auth: cap("room:manage", roomParam("roomId")),
    emits: ["room_renamed", "room_pet_updated"],
  }),
  // Read side of the settings pair: same ACL as the PUT below, so anyone who
  // can rewrite a room prompt can first read what they'd be overwriting
  // (agents previously had no sanctioned read - the prompt only rode the WS
  // office state). Returns the prompt + its version; the PUT requires that
  // version back (optimistic concurrency, mirroring memory READ→REPLACE).
  defineRoute<void, RoomSettingsRes>({
    opId: "rooms.getSettings",
    method: "GET",
    path: "/api/rooms/:roomId/settings",
    auth: cap("room:manage", roomParam("roomId")),
    emits: [],
  }),
  defineRoute<RoomSettingsReq, NoContent>({
    opId: "rooms.setSettings",
    method: "PUT",
    path: "/api/rooms/:roomId/settings",
    auth: cap("room:manage", roomParam("roomId")),
    emits: ["room_settings_updated"],
  }),
  // View preferences affect visibility only; they never grant or deny access.
  defineRoute<ViewOrderReq, NoContent>({
    opId: "view.setOrder",
    method: "PUT",
    path: "/api/me/view/order",
    auth: cap("view:manage", authenticated),
    emits: ["full_state"],
  }),
  defineRoute<ShownRoomsReq, NoContent>({
    opId: "view.setShown",
    method: "PUT",
    path: "/api/me/view/shown",
    auth: cap("view:manage", authenticated),
    // full_state for the hidden change; user_updated when the notifRooms
    // re-clamp (hiding a notified room) changes the record.
    emits: ["full_state", "user_updated"],
  }),
  defineRoute<NotifRoomsReq, NoContent>({
    opId: "view.setNotifRooms",
    method: "PUT",
    path: "/api/me/view/notif-rooms",
    auth: cap("view:manage", authenticated),
    emits: ["user_updated"],
  }),
  // Self-scoped accessible-rooms read: id+name for every room
  // the caller can ACCESS, hidden included - the read that makes re-show
  // possible for members (projected full_state excludes hidden rooms and
  // all_rooms_list is owner-only). Pure read, no emits.
  defineRoute<void, MeRoomsRes>({
    opId: "view.listRooms",
    method: "GET",
    path: "/api/me/rooms",
    auth: cap("view:manage", authenticated),
    emits: [],
  }),

  // Settings that follow a boss across devices (reply language). Sibling of
  // the view.* surface rather than a field on
  // users.update, because users.update is selfOrOwner and personal preferences
  // are deliberately NOT something an owner sets for a member (see
  // routes/handlers/users.ts). user:self keeps agents out: it is
  // absent from AGENT_CAPABILITIES and PRIVILEGED_AGENT_CAPABILITIES.
  defineRoute<PreferencesReq, NoContent>({
    opId: "prefs.update",
    method: "PATCH",
    path: "/api/me/preferences",
    auth: cap("user:self", authenticated),
    // SCOPED events only, like users.setAccess: neither preference appears in
    // UserPublicWire, so a public user_updated / users_list would carry no
    // observable change and would only broadcast the TIMING of a private edit.
    // Owners get the full record on the admin channel, the subject on its own.
    emits: ["user_admin_updated", "user_self_updated"],
  }),

  // Managed per-user environment. Cleartext values stay self-only, but a
  // durable API identity has the same reach as its issuing user.
  defineRoute<void, UserEnvRes>({
    opId: "userEnv.get",
    method: "GET",
    path: "/api/users/:username/env",
    auth: cap("user:env", selfUserOrApi),
    emits: [],
  }),
  defineRoute<UserEnvReplaceReq, NoContent>({
    opId: "userEnv.replace",
    method: "PUT",
    path: "/api/users/:username/env",
    auth: cap("user:env", selfUserOrApi),
    emits: [],
  }),
  // Names without values: an office owner reads WHICH managed variables a user
  // has set, so they can see who is still unconfigured. officeEnvOwner rather
  // than selfUserOrApi - the subject is someone else, and the caller must be an
  // office owner, by cookie or by their own API token. A member's cookie and
  // every agent token get the uniform 403.
  defineRoute<void, UserEnvNamesRes>({
    opId: "userEnv.names",
    method: "GET",
    path: "/api/users/:username/env/names",
    auth: cap("user:env", officeEnvOwner),
    emits: [],
  }),
  defineRoute<void, UserEnvRes>({
    opId: "officeEnv.get",
    method: "GET",
    path: "/api/office/env",
    auth: cap("user:env", officeEnvOwner),
    emits: [],
  }),
  defineRoute<UserEnvReplaceReq, NoContent>({
    opId: "officeEnv.replace",
    method: "PUT",
    path: "/api/office/env",
    auth: cap("user:env", officeEnvOwner),
    emits: [],
  }),

  // Personal durable API credentials. Management is cookie USER-only: an API
  // token can never mint, list, or revoke API tokens, including itself.
  defineRoute<void, ApiTokenListRes>({
    opId: "apiTokens.list",
    method: "GET",
    path: "/api/me/api-tokens",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  defineRoute<void, ProviderAccountsWire>({
    opId: "providerAccounts.list",
    method: "GET",
    path: "/api/me/provider-accounts",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  defineRoute<ProviderLoginStartReq, ProviderLoginStartRes>({
    opId: "providerAccounts.start",
    method: "POST",
    path: "/api/me/provider-accounts/:provider/login",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<ProviderLoginCallbackReq, { submitted: true }>({
    opId: "providerAccounts.callback",
    method: "POST",
    path: "/api/me/provider-accounts/:provider/callback",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<void, ProviderAccountsWire>({
    opId: "providerAccounts.refresh",
    method: "POST",
    path: "/api/me/provider-accounts/refresh",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<ProviderLoginCancelReq, { canceled: true }>({
    opId: "providerAccounts.cancel",
    method: "POST",
    path: "/api/me/provider-accounts/:provider/cancel",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<ProviderDisconnectReq, ProviderAccountsWire>({
    opId: "providerAccounts.disconnect",
    method: "POST",
    path: "/api/me/provider-accounts/:provider/disconnect",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<ApiTokenCreateReq, ApiTokenCreateRes>({
    opId: "apiTokens.mint",
    method: "POST",
    path: "/api/me/api-tokens",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "apiTokens.revoke",
    method: "DELETE",
    path: "/api/me/api-tokens/:id",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  defineRoute<ApiTokenInboxSendReq, ApiTokenInboxSendRes>({
    opId: "apiTokenInbox.send",
    method: "POST",
    path: "/api/api-token-inboxes/:tokenId/messages",
    auth: cap("agent:send-to-api-token", agentTokenSender),
    emits: ["log_entry"],
    preconditions: ["apiTokenInboxTargetAvailable"],
  }),
  defineRoute<void, ApiTokenInboxDrainRes>({
    opId: "apiTokenInbox.drain",
    method: "POST",
    path: "/api/me/api-token-inbox/drain",
    auth: cap("api:drain-inbox", apiTokenInboxSelf),
    emits: [],
  }),

  // Response is UserSelfWire (self) or UserAdminWire (owner) - same UserRecord
  // shape; the audience distinction is enforced by the handler, not the type.
  defineRoute<UserUpdateReq, { user: UserSelfWire }>({
    opId: "users.update",
    method: "PATCH",
    path: "/api/users/:username",
    auth: cap(["user:self", "user:admin"], selfOrOwner),
    // Record fields only (name/env/prompt/avatar).
    // emitUserUpdated + emitUsersList; NO full_state - access/view prefs are not
    // editable here, so nothing re-projects the subject's rooms.
    emits: ["user_updated", "users_list"],
  }),
  defineRoute<SetAccessReq, { user: UserAdminWire }>({
    opId: "users.setAccess",
    method: "PUT",
    path: "/api/users/:username/access",
    auth: cap("user:admin", officeOwner),
    // allowedRooms + the atomic notif/default prune-clamp - a PRIVATE-only change,
    // so SCOPED events only (no public user_updated/users_list): owners see the
    // new grants via user_admin_updated, the target re-projects via full_state +
    // its own user_self_updated.
    emits: ["user_admin_updated", "user_self_updated", "full_state"],
  }),
  defineRoute<void, NoContent>({
    opId: "users.delete",
    method: "DELETE",
    path: "/api/users/:username",
    auth: cap(["user:self", "user:admin"], selfOrOwner),
    emits: ["users_list", "session_expired"],
    preconditions: ["userDeleteNotSelfOwner", "userDeleteNotLastOwner"],
  }),

  defineRoute<InviteMintReq, { url: string; invite: InviteWire }>({
    opId: "invites.mint",
    method: "POST",
    path: "/api/invites",
    auth: cap("invite:manage", officeOwner),
    emits: ["invites_list"],
  }),
  defineRoute<void, { url: string; invite: InviteWire }>({
    opId: "invites.mintSelf",
    method: "POST",
    path: "/api/invites/self",
    auth: cap("invite:manage", authenticated),
    emits: ["invites_list"],
  }),
  // Owner recovery for an EXISTING user locked out of every device: a device
  // link minted by the owner, targeted by stable userId. Kept as its OWN op -
  // invites.mint stays new-user only, so
  // the wire semantics read "invites create users; recovery links restore
  // access". Ungated on current sessions (an owner may pre-empt a lockout).
  defineRoute<RecoveryMintReq, { url: string; invite: InviteWire }>({
    opId: "invites.mintRecovery",
    method: "POST",
    path: "/api/invites/recovery",
    auth: cap("invite:manage", officeOwner),
    emits: ["invites_list"],
  }),
  defineRoute<void, { invites: InviteWire[] }>({
    opId: "invites.list",
    method: "GET",
    path: "/api/invites",
    auth: cap("invite:manage", authenticated),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "invites.revoke",
    method: "DELETE",
    path: "/api/invites/:tokenPrefix",
    // owner unrestricted; member own-only is a typed precondition
    // (invite-owner lookup, not in GuardDeps).
    auth: cap("invite:manage", authenticated),
    emits: ["invite_revoked", "invites_list"],
    preconditions: ["inviteOwnerOrSelf"],
  }),
  defineRoute<void, { sessions: SessionWire[] }>({
    opId: "sessions.list",
    method: "GET",
    path: "/api/sessions",
    auth: cap("session:manage", authenticated),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "sessions.revoke",
    method: "DELETE",
    path: "/api/sessions/:sessionPrefix",
    // Owner global / member self + not-last-owner lockout: typed preconditions.
    auth: cap("session:manage", authenticated),
    emits: ["session_revoked", "sessions_active_list", "session_expired"],
    preconditions: ["sessionOwnerOrSelf", "notLastOwnerLockout"],
  }),
  defineRoute<void, NoContent>({
    opId: "sessions.logout",
    method: "DELETE",
    path: "/api/sessions/current",
    // Cap is `authenticated` in the spec: any identity with a current session,
    // no specific capability. not-last-owner lockout is a typed precondition.
    auth: authn(authenticated),
    emits: ["session_expired"],
    preconditions: ["notLastOwnerLockout"],
  }),
  defineRoute<void, AccessSettings>({
    opId: "office.getAccess",
    method: "GET",
    path: "/api/office/access",
    auth: cap("office:admin", officeOwner),
    emits: [],
  }),
  defineRoute<
    AccessSettingsReq,
    { signInUrl: string | null; restartRequired: boolean }
  >({
    opId: "office.setAccess",
    method: "PUT",
    path: "/api/office/access",
    auth: cap("office:admin", officeOwner),
    emits: ["invites_list"],
  }),
  // In-UI update trigger (release channel). Owner-only like the rest of the
  // office-admin surface: an update restarts the server and interrupts every
  // agent. The POST launches the installed updater DETACHED (systemd unit, not
  // a child process); progress is out-of-band (the restart itself). No emits -
  // the update_status WS event is fed by the checker, not by these routes.
  defineRoute<
    void,
    {
      managed: boolean;
      serviceKind: "system" | "user" | null;
      busyAgents: number;
      status: UpdateStatusWire;
    }
  >({
    opId: "office.updateInfo",
    method: "GET",
    path: "/api/office/update",
    auth: cap("office:admin", officeOwner),
    emits: [],
  }),
  defineRoute<
    { tag: string },
    { ok: true; via: "system" | "user"; tag: string }
  >({
    opId: "office.triggerUpdate",
    method: "POST",
    path: "/api/office/update",
    auth: cap("office:admin", officeOwner),
    emits: [],
  }),

  defineRoute<void, OfficeSettingsRes>({
    opId: "office.getSettings",
    method: "GET",
    path: "/api/office/settings",
    auth: cap("office:admin", officeOwner),
    emits: [],
  }),
  defineRoute<OfficeSettingsReq, NoContent>({
    opId: "office.setSettings",
    method: "PUT",
    path: "/api/office/settings",
    auth: cap("office:admin", officeOwner),
    emits: ["office_settings_updated"],
  }),
  defineRoute<ValidateCwdReq, { ok: boolean; error?: string }>({
    opId: "validate.cwd",
    method: "POST",
    path: "/api/validate/cwd",
    auth: cap("agent:manage", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<
    ValidateEnvReq,
    { ok: boolean; keyCount?: number; error?: string }
  >({
    opId: "validate.env",
    method: "POST",
    path: "/api/validate/env",
    // Object-level policy (office or another user ⇒ officeOwner; own user ⇒
    // self) lives ENTIRELY in the validateEnvBodySelfSubject precondition, NOT
    // the guard: this route's subject is body.username (scope:"user") and there
    // is NO :username path param, so the params-based selfUser guard could never
    // match it. The guard is therefore just `authenticated`; stage-1 office:read
    // excludes API scope because environment validation supports user settings,
    // not remote operation. (A prior or(officeOwner, selfUser) collapsed
    // to officeOwner and wrongly denied a member validating their OWN env before
    // the precondition could run - do not reinstate it.)
    auth: cap("office:read", authenticated),
    emits: [],
    preconditions: ["validateEnvBodySelfSubject"],
  }),
  defineRoute<
    void,
    { models: BackendModelWire[]; error?: string; authError?: boolean }
  >({
    opId: "backends.listModels",
    method: "GET",
    path: "/api/backends/:agentType/models",
    auth: cap("agent:manage", operationalAuthenticated),
    emits: [],
  }),

  defineRoute<void, TaskItem[]>({
    opId: "tasks.list",
    method: "GET",
    path: "/api/tasks",
    auth: cap("task:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<void, TaskItem>({
    opId: "tasks.get",
    method: "GET",
    path: "/api/tasks/:id",
    auth: cap("task:read", operationalAuthenticated),
    emits: [],
  }),
  // Task attribution comes from the caller token, never the request body.
  defineRoute<TaskCreateReq, TaskItem>({
    opId: "tasks.create",
    method: "POST",
    path: "/api/tasks",
    auth: cap("task:write", operationalAuthenticated),
    emits: ["tasks"],
  }),
  defineRoute<TaskUpdateReq, TaskItem>({
    opId: "tasks.update",
    method: "PATCH",
    path: "/api/tasks/:id",
    auth: cap("task:write", operationalAuthenticated),
    emits: ["tasks"],
  }),
  defineRoute<TaskClaimReq, TaskItem>({
    opId: "tasks.claim",
    method: "POST",
    path: "/api/tasks/:id/claim",
    auth: cap("task:write", operationalAuthenticated),
    emits: ["tasks"],
  }),
  defineRoute<void, TaskItem>({
    opId: "tasks.done",
    method: "POST",
    path: "/api/tasks/:id/done",
    auth: cap("task:write", operationalAuthenticated),
    emits: ["tasks"],
  }),
  defineRoute<void, NoContent>({
    opId: "tasks.delete",
    method: "DELETE",
    path: "/api/tasks/:id",
    // taskDelete, not `authenticated`: task:write is one coarse capability, and
    // a cron run holds it only for the create/complete affordance in its prompt.
    auth: cap("task:write", taskDelete),
    emits: ["tasks"],
  }),

  // The registry: register an app by name, isomux allocates the port. Ownership
  // is the USER's, so reads/deletes are owner-or-office-owner - the cronjob
  // rule, cronjobs being the precedent for "a thing isomux runs that is not an
  // agent". apps.list has no :name to gate on and is filtered per-caller in the
  // handler. The mutating routes emit a per-recipient app delta; the reads emit
  // nothing, and the Apps tab fetches the list when it opens.
  defineRoute<void, AppListWire[]>({
    opId: "apps.list",
    method: "GET",
    path: "/api/apps",
    auth: cap("app:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.get",
    method: "GET",
    path: "/api/apps/:name",
    auth: cap("app:read", appOwnerOrOfficeOwner("name")),
    emits: [],
  }),
  defineRoute<void, Uint8Array>({
    opId: "apps.preview",
    method: "POST",
    path: "/api/apps/:name/preview",
    auth: cap("app:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<AppRegisterReq, AppWire>({
    opId: "apps.register",
    method: "POST",
    path: "/api/apps",
    // hasOwningUser, not bare `authenticated`: an app must belong to a user, and
    // an agent token can carry a null userId. See the guard for why an ownerless
    // app is worse than a refusal.
    auth: cap("app:write", and(operationalAuthenticated, hasOwningUser)),
    emits: ["app_upserted"],
  }),
  // The only mutable fields are command, cwd and description. Name and port are
  // the app's address for as long as it lives, so there is no verb for them
  // anywhere.
  defineRoute<AppUpdateReq, AppWire>({
    opId: "apps.update",
    method: "PATCH",
    path: "/api/apps/:name",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    emits: ["app_upserted"],
  }),
  defineRoute<void, NoContent>({
    opId: "apps.delete",
    method: "DELETE",
    path: "/api/apps/:name",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    emits: ["app_deleted"],
  }),
  defineRoute<void, AppLogsRes>({
    opId: "apps.logs",
    method: "GET",
    path: "/api/apps/:name/logs",
    auth: cap("app:read", appOwnerOrOfficeOwner("name")),
    emits: [],
  }),
  // The recovery verbs. app:write rather than app:read because they change what
  // is running on the box, and an app that has come to rest in `failed` has no
  // other cure than DELETE, which costs it its port and its data directory.
  defineRoute<void, AppWire>({
    opId: "apps.start",
    method: "POST",
    path: "/api/apps/:name/start",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    emits: ["app_upserted"],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.stop",
    method: "POST",
    path: "/api/apps/:name/stop",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    emits: ["app_upserted"],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.restart",
    method: "POST",
    path: "/api/apps/:name/restart",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    emits: ["app_upserted"],
  }),

  // Singular `/api/app` on purpose: everything under /api/apps/:name is the
  // OWNER's management surface, and this is the one route the app itself
  // reaches. It carries no :name and no recipient - the token says which app is
  // speaking and the registry says which agent built it, so neither is a
  // parameter a caller could lie about.
  //
  // The ONLY route an app identity authorizes, pinned by the whole-table
  // reachability test in routes-table.test.ts.
  defineRoute<AppMessageReq, AgentMessageAck>({
    opId: "apps.sendMessage",
    method: "POST",
    path: "/api/app/message",
    // app:message is held by APP scope alone, so the capability already excludes
    // every other caller; appScope is the second, independent fact (see the
    // guard).
    auth: cap("app:message", appScope),
    emits: ["log_entry"],
  }),

  // Three verbs: READ (whole file + version), APPEND (one server-stamped line),
  // REPLACE (whole-file overwrite, version-guarded). All scopes; authenticated +
  // target-existence gated (permissive on every verb, no per-scope access gate;
  // restraint lives in the system-prompt affordance).
  defineRoute<void, MemoryReadRes>({
    opId: "memory.read",
    method: "GET",
    path: "/api/memory",
    auth: cap("memory:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<MemoryCreateReq, MemoryAppendRes>({
    opId: "memory.append",
    method: "POST",
    path: "/api/memory",
    auth: cap("memory:write", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<MemoryReplaceReq, MemoryWriteRes>({
    opId: "memory.replace",
    method: "PUT",
    path: "/api/memory",
    auth: cap("memory:write", operationalAuthenticated),
    emits: [],
  }),

  // The CALLER's own skill-use counters order the skill menu. They are keyed off
  // the token/cookie userId, never a param - one user cannot read another's
  // counts through this route.
  // office:read keeps plain agent tokens out (they lack it); the Sk popover is
  // the intended consumer.
  defineRoute<void, SkillUsageCountsRes>({
    opId: "skills.usageCounts",
    method: "GET",
    path: "/api/skill-usage",
    auth: cap("office:read", operationalAuthenticated),
    emits: [],
  }),

  defineRoute<void, Cronjob[]>({
    opId: "cron.list",
    method: "GET",
    path: "/api/cronjobs",
    auth: cap("cron:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<void, Cronjob>({
    opId: "cron.get",
    method: "GET",
    path: "/api/cronjobs/:id",
    auth: cap("cron:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<CronCreateReq, Cronjob>({
    opId: "cron.create",
    method: "POST",
    path: "/api/cronjobs",
    auth: cap("cron:manage", operationalAuthenticated),
    emits: ["cronjob_added"],
  }),
  defineRoute<CronUpdateReq, Cronjob>({
    opId: "cron.update",
    method: "PATCH",
    path: "/api/cronjobs/:id",
    auth: cap("cron:manage", cronjobOwnerOrOfficeOwner("id")),
    emits: ["cronjob_updated"],
  }),
  defineRoute<void, NoContent>({
    opId: "cron.delete",
    method: "DELETE",
    path: "/api/cronjobs/:id",
    auth: cap("cron:manage", cronjobOwnerOrOfficeOwner("id")),
    emits: ["cronjob_deleted"],
  }),
  defineRoute<void, { runId: string }>({
    opId: "cron.runNow",
    method: "POST",
    path: "/api/cronjobs/:id/runs",
    auth: cap("cron:manage", cronjobOwnerOrOfficeOwner("id")),
    emits: ["cronjob_run_updated"],
  }),
  defineRoute<CronPromptReq, NoContent>({
    opId: "cron.setPrompt",
    method: "PUT",
    path: "/api/cron-prompt",
    // off the :id namespace to avoid shadowing /api/cronjobs/:id.
    auth: cap("cron:manage", officeOwner),
    emits: ["cronjobs_prompt_updated"],
  }),
  defineRoute<void, { runs: CronjobRun[] }>({
    opId: "cron.listRuns",
    method: "GET",
    path: "/api/cronjobs/:id/runs",
    auth: cap("cron:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<void, { jobs: { cronjobId: string; runs: CronjobRun[] }[] }>({
    opId: "cron.listAllRuns",
    method: "GET",
    path: "/api/cron-runs",
    auth: cap("cron:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<void, { run: CronjobRun; entries: LogEntry[] }>({
    opId: "cron.getRun",
    method: "GET",
    path: "/api/cronjobs/:id/runs/:runId",
    auth: cap("cron:read", operationalAuthenticated),
    emits: [],
  }),
  defineRoute<CronRunMessageReq, MessageAck>({
    opId: "cron.runMessage",
    method: "POST",
    path: "/api/cronjobs/:id/runs/:runId/messages",
    auth: cap("cron:manage", cronjobOwnerOrOfficeOwner("id")),
    emits: ["cron_run_log_entry"],
  }),
  defineRoute<EditMessageReq, MessageAck>({
    opId: "cron.editRunMessage",
    method: "PATCH",
    path: "/api/cronjobs/:id/runs/:runId/messages/:logEntryId",
    auth: cap("cron:manage", cronjobOwnerOrOfficeOwner("id")),
    emits: ["cron_run_log_entry"],
  }),
  defineRoute<AffordanceReadFileReq, OkTrue>({
    opId: "cron.runReadFile",
    method: "POST",
    path: "/api/cronjobs/:id/runs/:runId/read-file",
    auth: cap("self:affordance", runParamMustEqualTokenRun),
    emits: ["cron_run_log_entry"],
  }),
  defineRoute<AffordanceDiffReq, OkTrue>({
    opId: "cron.runDiff",
    method: "POST",
    path: "/api/cronjobs/:id/runs/:runId/diff",
    auth: cap("self:affordance", runParamMustEqualTokenRun),
    emits: ["cron_run_log_entry"],
  }),

  defineRoute<void, BackupStatusWire>({
    opId: "system.backupStatus",
    method: "GET",
    path: "/api/backup/status",
    auth: cap("office:read", operationalAuthenticated),
    emits: [],
  }),
  // Deployment version identity. Any authenticated caller, agents included:
  // version identity is harmless
  // metadata and agents legitimately reason about what's deployed.
  defineRoute<
    void,
    { version: string | null; commit: string | null; release: string | null }
  >({
    opId: "system.version",
    method: "GET",
    path: "/api/version",
    auth: authn(operationalAuthenticated),
    emits: [],
  }),

  // Disk-usage breakdown of the office footprint. Same posture as
  // backupStatus - office:read + authenticated: every human, plus PRIVILEGED
  // agents (a plain agent token lacks office:read and gets 403). The handler
  // strips the per-agent detail AND every filesystem path for non-owners, since
  // the detail enumerates log dirs for agents in rooms the caller may not see.
  defineRoute<void, StorageUsageWire>({
    opId: "storage.usage",
    method: "GET",
    path: "/api/storage/usage",
    auth: cap("office:read", operationalAuthenticated),
    emits: [],
  }),
  // Structured counterpart to /isomux-usage. The handler derives the audience
  // from the authenticated caller; no query or body field can widen it.
  defineRoute<void, UsageReportWire>({
    opId: "usage.read",
    method: "GET",
    path: "/api/usage",
    auth: cap("office:read", operationalAuthenticated),
    emits: [],
  }),
  // Manual prune. Owner-only and DRY RUN unless the body says apply:true; no
  // scheduler ever calls it (server/storage-prune.ts).
  defineRoute<StoragePruneReq, StoragePruneRes>({
    opId: "storage.prune",
    method: "POST",
    path: "/api/storage/prune",
    auth: cap("office:admin", officeOwner),
    emits: [],
  }),
];

// Public login / static surface (NOT /api). Represented here as bypass metadata
// so the "no public route reaches authorize()" invariant is testable over one
// table. These stay bespoke origin-checked handlers in production (the
// cookie-minting browser surface); they are never dispatched through authorize().
export const PUBLIC_ROUTES: readonly RouteDef[] = [
  defineRoute({
    opId: "auth.loginPage",
    method: "GET",
    path: "/",
    auth: pub,
    emits: [],
  }),
  defineRoute({
    opId: "auth.claim",
    method: "POST",
    path: "/auth/claim",
    auth: pub,
    emits: [],
  }),
  defineRoute({
    opId: "auth.invitePage",
    method: "GET",
    path: "/i/:token",
    auth: pub,
    emits: [],
  }),
  defineRoute({
    opId: "auth.accept",
    method: "POST",
    path: "/auth/accept",
    auth: pub,
    emits: [],
  }),
  defineRoute({
    opId: "auth.logout",
    method: "POST",
    path: "/auth/logout",
    auth: pub,
    emits: [],
  }),
  defineRoute({
    opId: "auth.loginBg",
    method: "GET",
    path: "/auth/login-bg.png",
    auth: pub,
    emits: [],
  }),
  // Unauthenticated readiness probe (release-channel slice C1). Answered 200
  // once the listener is up - which the boot sequence only reaches after the
  // startup migrations (startServer: bootPrelude + migrateOwnersToRuleBased-
  // Access run before buildServer binds). Minimal body, no deployment state;
  // rate-limited for non-loopback callers (server/ready-limiter.ts).
  defineRoute({
    opId: "system.readyz",
    method: "GET",
    path: "/readyz",
    auth: pub,
    emits: [],
  }),
];

export const ALL_ROUTES: readonly RouteDef[] = [
  ...API_ROUTES,
  ...PUBLIC_ROUTES,
];
