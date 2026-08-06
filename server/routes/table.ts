// Typed route table (skeleton) - Phase 2.3. The single source of truth that, in
// Phase 3, REPLACES the ~1,940-line dispatchCommand switch + the ad-hoc HTTP
// handlers. Each route declares { opId, method, path, auth, emits } plus its
// request/response TYPES (type-level only in 2.3 - no runtime validation lib;
// that lands with handler migration in Phase 3). See
// internal-docs/generic-runtime-refactor.md → "Server API Spec" → REST route table.
//
// ADDITIVE: this is data + types, contract-tested for structural invariants
// (unique opId, unique method+path, every emit resolves to a registry event, a
// valid capability + guard on every capability route, and - the carried-forward
// 2.2 caution - NO public route is ever fed to authorize()). It is NOT wired
// into the live HTTP server in 2.3.
//
// Boundaries deliberately kept OUT of the resourceGuard (the core op enforces
// them against LIVE state in Phase 3, not pure authz - same posture as
// messageSend's recipient-existence in 2.2) are declared as the TYPED
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
  selfOrOwner,
  officeOwner,
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
  SlideDeckRes,
  EnsureSlideReq,
  EnsureSlideRes,
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
  RecoveryMintReq,
  UserUpdateReq,
  SetAccessReq,
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
  StoragePruneReq,
  StoragePruneRes,
  BackupStatusWire,
} from "../../shared/contract-shapes.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// A route's authorization, as a discriminated union so the carried-forward 2.2
// caution is STRUCTURAL: a `public` route carries no resourceGuard, so by TYPE
// it cannot be passed to authorize() (which 401s on a null identity); an
// `authenticated` route needs identity but no capability (e.g. logout). A
// contract test pins that no public route reaches authorize() and that every
// capability route has a valid cap + guard.
export type RouteAuth =
  | ({ kind: "capability" } & RouteAuthz)
  | { kind: "authenticated"; resourceGuard: Guard }
  | { kind: "public" };

// Route-contract PRECONDITIONS: semantic checks the Phase-3 core op MUST enforce
// against LIVE state, deliberately kept OUT of the pure resourceGuard (a guard
// has no live-state dependency - the same boundary 2.2 drew for messageSend's
// recipient-existence). Encoded as TYPED DATA, not prose, so the audit surface
// (Reviewer4) and Phase 3 can ENUMERATE them and a contract test can pin each
// route's set - comments alone are too easy to forget.
export type RoutePrecondition =
  // agents.revive: caller must also have access to the killed agent's lastRoomId.
  // The resourceGuard covers only the TARGET room (body.roomId); lastRoomId is
  // live-state (the killed agent's last room), with no RoomRef kind in 2.2.
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
  // Live-state semantic preconditions the Phase-3 handler must enforce (NOT pure
  // authz; see RoutePrecondition). Absent ⇒ none. Pinned by a contract test.
  preconditions?: readonly RoutePrecondition[];
  // Phantom type carriers (no runtime presence): bind the request/response types
  // for Phase-3 handler typing. defineRoute<Req,Res> attaches them.
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

// --- auth shorthands --------------------------------------------------------
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

// --- room-ref shorthands ----------------------------------------------------
const roomParam = (name: string): Guard =>
  requiresRoomAccess({ kind: "paramRoomId", name });
const agentParam = (name: string): Guard =>
  requiresRoomAccess({ kind: "paramAgentId", name });
const bodyRoom = (name: string): Guard =>
  requiresRoomAccess({ kind: "bodyRoomId", name });

// Common no-content / small response shapes.
type NoContent = void;
type MessageAck = { messageId: string };
// agents.sendMessage's own ack (task 425facdd). `queued` answers the question the
// sender cannot otherwise see: true = the message is parked behind the receiver's
// in-flight turn and lands when that turn ends; false = it went straight into a
// turn. Optional because only the AGENT branch knows: the USER branch is
// fire-and-forget (empty messageId, no enqueue result), and a deduped retry is an
// ack for the ORIGINAL send, whose queued/delivered answer this call never
// learned. A point-in-time fact about THIS send, not receiver state.
// `steered` / `steerDeclined` (task 80b2bb08) ride the same rule and appear only
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
// agents.readInstructions (task 68891fa1): the customInstructions blob + its
// concurrency token - the read half of the read-then-PATCH flow that
// agents.update's version guard (44a2c98d) expects. Field names match
// EditAgentReq exactly so a caller reads, edits, and echoes the version back.
type AgentInstructionsRes = {
  customInstructions: string | null;
  customInstructionsVersion: string;
};
type OkTrue = { ok: true };

// ---------------------------------------------------------------------------
// The /api route table
// ---------------------------------------------------------------------------
export const API_ROUTES: readonly RouteDef[] = [
  // --- Agents - lifecycle ---------------------------------------------------
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
    // check is a typed Phase-3 precondition (killed-agent last room is live-state).
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
  // Read an agent's customInstructions blob + version token (task 68891fa1).
  // `authenticated` (no capability), Nil-ruled: EVERY agent may read any agent
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
  // `userScope` blocks any non-user scope. CONFERRAL SCOPE is (i-b), Nil-ruled:
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

  // --- Agents - conversation ------------------------------------------------
  defineRoute<SendMessageReq, AgentMessageAck | ScheduledAck>({
    opId: "agents.sendMessage",
    method: "POST",
    path: "/api/agents/:id/messages",
    // any-of so a USER (converse) and an AGENT (send-as-self) both clear stage 1
    // and reach messageSend's scope-specific stage-2 branch.
    // With body.deliverAt (AGENT branch only) the send becomes a SCHEDULED
    // message: stored durably, fired later by scheduled-messages.ts; the ack is
    // ScheduledAck instead of MessageAck. Same route on purpose - one send
    // surface, one new field (design-pinned, task 8ff369b5).
    auth: cap(["agent:converse", "agent:send-as-self"], messageSend),
    emits: ["log_entry"],
    preconditions: [
      "messageRecipientExists",
      "messagePendingPermissionBindsParam",
    ],
  }),
  // --- Agents - scheduled messages (task 8ff369b5) ---------------------------
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
  // Instant self-handoff (task 8883e45d): reset the session (like
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

  // --- Agents - self-affordances (AGENT scope, own chat) --------------------
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

  // Conversation-log search + retrieval (tasks da7b2899, b6d07978). ONE route
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

  // --- Agents - Slide Mode (browser; design: internal-docs/slide-mode-design.md)
  // Boss-session read surface: anyone who can see the chat (office:read + room
  // access) can fetch its slides and drive on-demand generation. The ensure
  // route's generation is fire-and-forget server-side; the slide arrives on the
  // room-ACL `slide_ready` WS push.
  defineRoute<void, SlideDeckRes>({
    opId: "agents.getSlides",
    method: "GET",
    path: "/api/agents/:id/slides",
    auth: cap("office:read", agentParam("id")),
    emits: [],
  }),
  defineRoute<EnsureSlideReq, EnsureSlideRes>({
    opId: "agents.ensureSlide",
    method: "POST",
    path: "/api/agents/:id/slides/:entryId",
    auth: cap("office:read", agentParam("id")),
    // async: fired when generation resolves, not inline - ready on success,
    // failed when the formatter errors or breaks the slide contract.
    emits: ["slide_ready", "slide_failed"],
  }),

  // --- Agents - editor (browser) --------------------------------------------
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

  // --- Agents - uploads / file serving --------------------------------------
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

  // --- Rooms ----------------------------------------------------------------
  defineRoute<RoomCreateReq, { room: RoomWire }>({
    opId: "rooms.create",
    method: "POST",
    path: "/api/rooms",
    auth: cap("room:manage", authenticated),
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
  defineRoute<RoomRenameReq, NoContent>({
    opId: "rooms.rename",
    method: "PATCH",
    path: "/api/rooms/:roomId",
    auth: cap("room:manage", roomParam("roomId")),
    emits: ["room_renamed"],
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
  // --- View preferences (per-user; visibility, never security) --------------
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
    // re-clamp (hiding a notified room) changes the record. Restored by task
    // 9301d0f4 (removed as callerless in the Phase 4 close-out).
    emits: ["full_state", "user_updated"],
  }),
  defineRoute<NotifRoomsReq, NoContent>({
    opId: "view.setNotifRooms",
    method: "PUT",
    path: "/api/me/view/notif-rooms",
    auth: cap("view:manage", authenticated),
    emits: ["user_updated"],
  }),
  // Self-scoped accessible-rooms read (task 9301d0f4): id+name for every room
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

  // --- Personal preferences (per-user; self-only) ---------------------------
  // Task 49d4e2f6. Settings that follow a boss across devices (reply language,
  // Slide Mode gate). Sibling of the view.* surface rather than a field on
  // users.update, because users.update is selfOrOwner and personal preferences
  // are deliberately NOT something an owner sets for a member (the Option A
  // split - see routes/handlers/users.ts). user:self keeps agents out: it is
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

  // --- Users ----------------------------------------------------------------
  // Response is UserSelfWire (self) or UserAdminWire (owner) - same UserRecord
  // shape; the audience distinction is enforced by the handler, not the type.
  defineRoute<UserUpdateReq, { user: UserSelfWire }>({
    opId: "users.update",
    method: "PATCH",
    path: "/api/users/:username",
    auth: cap(["user:self", "user:admin"], selfOrOwner),
    // Option A (Nil-gated): record fields only (name/env/prompt/avatar).
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
    // its own user_self_updated. (Option A boundary.)
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

  // --- Sessions, invites, access (auth surface) -----------------------------
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
  // Owner recovery for an EXISTING user locked out of every device (task
  // eb3354e6 final revision): a device link minted by the owner, targeted by
  // stable userId. Kept as its OWN op - invites.mint stays new-user only, so
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
    // owner unrestricted; member own-only is a typed Phase-3 precondition
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
    // owner global / member self + not-last-owner lockout: typed Phase-3 preconditions.
    auth: cap("session:manage", authenticated),
    emits: ["session_revoked", "sessions_active_list", "session_expired"],
    preconditions: ["sessionOwnerOrSelf", "notLastOwnerLockout"],
  }),
  defineRoute<void, NoContent>({
    opId: "sessions.logout",
    method: "DELETE",
    path: "/api/sessions/current",
    // Cap is `authenticated` in the spec: any identity with a current session,
    // no specific capability. not-last-owner lockout is a typed Phase-3 precondition.
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

  // --- Office settings, validation, backends --------------------------------
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
    auth: cap("agent:manage", authenticated),
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
    // already excludes AGENT scope. (A prior or(officeOwner, selfUser) collapsed
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
    auth: cap("agent:manage", authenticated),
    emits: [],
  }),

  // --- Tasks (global shared board; attribution from token) ------------------
  defineRoute<void, TaskItem[]>({
    opId: "tasks.list",
    method: "GET",
    path: "/api/tasks",
    auth: cap("task:read", authenticated),
    emits: [],
  }),
  defineRoute<void, TaskItem>({
    opId: "tasks.get",
    method: "GET",
    path: "/api/tasks/:id",
    auth: cap("task:read", authenticated),
    emits: [],
  }),
  defineRoute<TaskCreateReq, TaskItem>({
    opId: "tasks.create",
    method: "POST",
    path: "/api/tasks",
    auth: cap("task:write", authenticated),
    emits: ["tasks"],
  }),
  defineRoute<TaskUpdateReq, TaskItem>({
    opId: "tasks.update",
    method: "PATCH",
    path: "/api/tasks/:id",
    auth: cap("task:write", authenticated),
    emits: ["tasks"],
  }),
  defineRoute<TaskClaimReq, TaskItem>({
    opId: "tasks.claim",
    method: "POST",
    path: "/api/tasks/:id/claim",
    auth: cap("task:write", authenticated),
    emits: ["tasks"],
  }),
  defineRoute<void, TaskItem>({
    opId: "tasks.done",
    method: "POST",
    path: "/api/tasks/:id/done",
    auth: cap("task:write", authenticated),
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

  // --- Apps (agent-built web apps isomux runs) ------------------------------
  // The registry: register an app by name, isomux allocates the port. Ownership
  // is the USER's, so reads/deletes are owner-or-office-owner - the cronjob
  // rule, cronjobs being the precedent for "a thing isomux runs that is not an
  // agent". apps.list has no :name to gate on and is filtered per-caller in the
  // handler. The mutating routes emit a per-recipient app delta; the reads emit
  // nothing, and the Apps tab fetches the list when it opens.
  defineRoute<void, AppWire[]>({
    opId: "apps.list",
    method: "GET",
    path: "/api/apps",
    auth: cap("app:read", authenticated),
    emits: [],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.get",
    method: "GET",
    path: "/api/apps/:name",
    auth: cap("app:read", appOwnerOrOfficeOwner("name")),
    emits: [],
  }),
  defineRoute<AppRegisterReq, AppWire>({
    opId: "apps.register",
    method: "POST",
    path: "/api/apps",
    // hasOwningUser, not bare `authenticated`: an app must belong to a user, and
    // an agent token can carry a null userId. See the guard for why an ownerless
    // app is worse than a refusal.
    auth: cap("app:write", and(authenticated, hasOwningUser)),
    emits: ["app_upserted"],
  }),
  // The only mutable fields are command, cwd and description. Name and port are
  // the app's identity and its permanent tombstone, so there is no verb for
  // them anywhere.
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
  // other cure than DELETE, which retires its name forever.
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

  // --- The app-SELF surface (an app speaking for itself) --------------------
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

  // --- Memory (isomux-memory; durable shared facts) -------------------------
  // Three verbs: READ (whole file + version), APPEND (one server-stamped line),
  // REPLACE (whole-file overwrite, version-guarded). All scopes; authenticated +
  // target-existence gated (permissive on every verb, no per-scope access gate -
  // Nil's product decision; restraint lives in the system-prompt affordance).
  defineRoute<void, MemoryReadRes>({
    opId: "memory.read",
    method: "GET",
    path: "/api/memory",
    auth: cap("memory:read", authenticated),
    emits: [],
  }),
  defineRoute<MemoryCreateReq, MemoryAppendRes>({
    opId: "memory.append",
    method: "POST",
    path: "/api/memory",
    auth: cap("memory:write", authenticated),
    emits: [],
  }),
  defineRoute<MemoryReplaceReq, MemoryWriteRes>({
    opId: "memory.replace",
    method: "PUT",
    path: "/api/memory",
    auth: cap("memory:write", authenticated),
    emits: [],
  }),

  // --- Skill usage (per-user Sk-menu sort counts; task f1769b1a) ------------
  // The CALLER's own skill-use counters (keyed off the token/cookie userId,
  // never a param - one user cannot read another's counts through this route).
  // office:read keeps plain agent tokens out (they lack it); the Sk popover is
  // the intended consumer.
  defineRoute<void, SkillUsageCountsRes>({
    opId: "skills.usageCounts",
    method: "GET",
    path: "/api/skill-usage",
    auth: cap("office:read", authenticated),
    emits: [],
  }),

  // --- Cronjobs -------------------------------------------------------------
  defineRoute<void, Cronjob[]>({
    opId: "cron.list",
    method: "GET",
    path: "/api/cronjobs",
    auth: cap("cron:read", authenticated),
    emits: [],
  }),
  defineRoute<void, Cronjob>({
    opId: "cron.get",
    method: "GET",
    path: "/api/cronjobs/:id",
    auth: cap("cron:read", authenticated),
    emits: [],
  }),
  defineRoute<CronCreateReq, Cronjob>({
    opId: "cron.create",
    method: "POST",
    path: "/api/cronjobs",
    auth: cap("cron:manage", authenticated),
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
    // off the :id namespace to avoid shadowing /api/cronjobs/:id. Tightened to
    // owner ([behavior-change]; today has no role check) - enforced in Phase 3.
    auth: cap("cron:manage", officeOwner),
    emits: ["cronjobs_prompt_updated"],
  }),
  defineRoute<void, { runs: CronjobRun[] }>({
    opId: "cron.listRuns",
    method: "GET",
    path: "/api/cronjobs/:id/runs",
    auth: cap("cron:read", authenticated),
    emits: [],
  }),
  defineRoute<void, { jobs: { cronjobId: string; runs: CronjobRun[] }[] }>({
    opId: "cron.listAllRuns",
    method: "GET",
    path: "/api/cron-runs",
    auth: cap("cron:read", authenticated),
    emits: [],
  }),
  defineRoute<void, { run: CronjobRun; entries: LogEntry[] }>({
    opId: "cron.getRun",
    method: "GET",
    path: "/api/cronjobs/:id/runs/:runId",
    auth: cap("cron:read", authenticated),
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

  // --- System ---------------------------------------------------------------
  defineRoute<void, BackupStatusWire>({
    opId: "system.backupStatus",
    method: "GET",
    path: "/api/backup/status",
    auth: cap("office:read", authenticated),
    emits: [],
  }),
  // Deployment version identity (release-channel slice C1). Any authenticated
  // caller, agents included (Nil 2026-07-19): version identity is harmless
  // metadata and agents legitimately reason about what's deployed.
  defineRoute<
    void,
    { version: string | null; commit: string | null; release: string | null }
  >({
    opId: "system.version",
    method: "GET",
    path: "/api/version",
    auth: authn(authenticated),
    emits: [],
  }),

  // --- Storage (task 2366ccb0) ----------------------------------------------
  // Disk-usage breakdown of the office footprint. Same posture as
  // backupStatus - office:read + authenticated: every human, plus PRIVILEGED
  // agents (a plain agent token lacks office:read and gets 403). The handler
  // strips the per-agent detail AND every filesystem path for non-owners, since
  // the detail enumerates log dirs for agents in rooms the caller may not see.
  defineRoute<void, StorageUsageWire>({
    opId: "storage.usage",
    method: "GET",
    path: "/api/storage/usage",
    auth: cap("office:read", authenticated),
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

// ---------------------------------------------------------------------------
// Public login / static surface (NOT /api). Represented here as bypass metadata
// so the "no public route reaches authorize()" invariant is testable over one
// table. These stay bespoke origin-checked handlers in production (the
// cookie-minting browser surface); they are never dispatched through authorize().
// ---------------------------------------------------------------------------
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

// The full table the contract tests sweep.
export const ALL_ROUTES: readonly RouteDef[] = [
  ...API_ROUTES,
  ...PUBLIC_ROUTES,
];
