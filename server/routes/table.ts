// Typed route table (skeleton) — Phase 2.3. The single source of truth that, in
// Phase 3, REPLACES the ~1,940-line dispatchCommand switch + the ad-hoc HTTP
// handlers. Each route declares { opId, method, path, auth, emits } plus its
// request/response TYPES (type-level only in 2.3 — no runtime validation lib;
// that lands with handler migration in Phase 3). See
// internal-docs/generic-runtime-refactor.md → "Server API Spec" → REST route table.
//
// ADDITIVE: this is data + types, contract-tested for structural invariants
// (unique opId, unique method+path, every emit resolves to a registry event, a
// valid capability + guard on every capability route, and — the carried-forward
// 2.2 caution — NO public route is ever fed to authorize()). It is NOT wired
// into the live HTTP server in 2.3.
//
// Boundaries deliberately kept OUT of the resourceGuard (the core op enforces
// them against LIVE state in Phase 3, not pure authz — same posture as
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
  cronjobOwnerOrOfficeOwner,
  runParamMustEqualTokenRun,
  and,
  or,
  type Guard,
} from "../identity/guards.ts";
import type { EventId } from "../events/registry.ts";
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
  TopicReq,
  AffordanceReadFileReq,
  AffordanceEditFileReq,
  AffordanceDiffReq,
  AffordanceTerminalCmdReq,
  AffordancePreviewUrlReq,
  AgentContextUsageResp,
  EditorSaveReq,
  RoomCreateReq,
  RoomRenameReq,
  RoomSettingsReq,
  RoomSettingsRes,
  ViewOrderReq,
  NotifRoomsReq,
  DefaultRoomReq,
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
  MemoryCreateReq,
  MemoryReplaceReq,
  MemoryReadRes,
  MemoryAppendRes,
  MemoryWriteRes,
  CronCreateReq,
  CronUpdateReq,
  CronRunMessageReq,
  CronPromptReq,
  UserSelfWire,
  UserAdminWire,
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
// has no live-state dependency — the same boundary 2.2 drew for messageSend's
// recipient-existence). Encoded as TYPED DATA, not prose, so the audit surface
// (Reviewer4) and Phase 3 can ENUMERATE them and a contract test can pin each
// route's set — comments alone are too easy to forget.
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
  // agents.sendMessage (AGENT scope): the recipient agent must exist — a cross-
  // room delivery check that must NEVER become an ACL existence leak.
  | "messageRecipientExists"
  // agents.sendMessage: while a pendingPermission is set for :id, the next
  // message to THAT agent is its allow/deny — interpretation binds to :id.
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
// <Req,Res> at each call site IS the type-level schema — a typo'd type name
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
// Schedule-branch ack (agents.sendMessage with deliverAt): the scheduled-entry
// handle plus the normalized (UTC RFC3339) delivery time — never a fake empty
// messageId.
type ScheduledAck = { scheduledId: string; deliverAt: string };
type ScheduledMessagesListRes = { scheduled: ScheduledMessageEntry[] };
type AgentEnvelope = { agent: AgentInfo };
// agents.readInstructions (task 68891fa1): the customInstructions blob + its
// concurrency token — the read half of the read-then-PATCH flow that
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
  // --- Agents — lifecycle ---------------------------------------------------
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
  // it can see — privilege gates the WRITE (agents.update), and the version
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
  // DOUBLE-GATED so no agent — privileged or not — can ever flip the flag:
  // stage-1 cap `agent:privilege` is absent from both the AGENT and the
  // privileged-agent capability sets (only USER scope holds it), and stage-2
  // `userScope` blocks any non-user scope. CONFERRAL SCOPE is (i-b), Nil-ruled:
  // an office owner toggles any agent; a member toggles ONLY agents they manage
  // (manager-match on AgentInfo.userId) — NOT mere room co-membership, which
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

  // --- Agents — conversation ------------------------------------------------
  defineRoute<SendMessageReq, MessageAck | ScheduledAck>({
    opId: "agents.sendMessage",
    method: "POST",
    path: "/api/agents/:id/messages",
    // any-of so a USER (converse) and an AGENT (send-as-self) both clear stage 1
    // and reach messageSend's scope-specific stage-2 branch.
    // With body.deliverAt (AGENT branch only) the send becomes a SCHEDULED
    // message: stored durably, fired later by scheduled-messages.ts; the ack is
    // ScheduledAck instead of MessageAck. Same route on purpose — one send
    // surface, one new field (design-pinned, task 8ff369b5).
    auth: cap(["agent:converse", "agent:send-as-self"], messageSend),
    emits: ["log_entry"],
    preconditions: [
      "messageRecipientExists",
      "messagePendingPermissionBindsParam",
    ],
  }),
  // --- Agents — scheduled messages (task 8ff369b5) ---------------------------
  // `:id` is the SENDER here (the outbox being managed) — the deliberate
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
  defineRoute<NewConversationReq, NoContent>({
    opId: "agents.newConversation",
    method: "POST",
    path: "/api/agents/:id/new-conversation",
    auth: cap("agent:converse", agentParam("id")),
    emits: ["clear_logs"],
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

  // --- Agents — self-affordances (AGENT scope, own chat) --------------------
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
  // Read-only — nothing lands in chat, so no log_entry emit.
  defineRoute<void, AgentContextUsageResp>({
    opId: "agents.contextUsage",
    method: "GET",
    path: "/api/agents/:id/context",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    emits: [],
  }),

  // --- Agents — editor (browser) --------------------------------------------
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

  // --- Agents — uploads / file serving --------------------------------------
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
  // (agents previously had no sanctioned read — the prompt only rode the WS
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
  defineRoute<NotifRoomsReq, NoContent>({
    opId: "view.setNotifRooms",
    method: "PUT",
    path: "/api/me/view/notif-rooms",
    auth: cap("view:manage", authenticated),
    emits: ["user_updated"],
  }),
  defineRoute<DefaultRoomReq, NoContent>({
    opId: "view.setDefaultRoom",
    method: "PUT",
    path: "/api/me/view/default-room",
    auth: cap("view:manage", authenticated),
    emits: ["user_updated"],
  }),

  // --- Users ----------------------------------------------------------------
  // Response is UserSelfWire (self) or UserAdminWire (owner) — same UserRecord
  // shape; the audience distinction is enforced by the handler, not the type.
  defineRoute<UserUpdateReq, { user: UserSelfWire }>({
    opId: "users.update",
    method: "PATCH",
    path: "/api/users/:username",
    auth: cap(["user:self", "user:admin"], selfOrOwner),
    // Option A (Nil-gated): record fields only (name/env/prompt/avatar).
    // emitUserUpdated + emitUsersList; NO full_state — access/view prefs are not
    // editable here, so nothing re-projects the subject's rooms.
    emits: ["user_updated", "users_list"],
  }),
  defineRoute<SetAccessReq, { user: UserAdminWire }>({
    opId: "users.setAccess",
    method: "PUT",
    path: "/api/users/:username/access",
    auth: cap("user:admin", officeOwner),
    // allowedRooms + the atomic notif/default prune-clamp — a PRIVATE-only change,
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
    // the precondition could run — do not reinstate it.)
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
    auth: cap("task:write", authenticated),
    emits: ["tasks"],
  }),

  // --- Memory (isomux-memory; durable shared facts) -------------------------
  // Three verbs: READ (whole file + version), APPEND (one server-stamped line),
  // REPLACE (whole-file overwrite, version-guarded). All scopes; authenticated +
  // target-existence gated (permissive on every verb, no per-scope access gate —
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
    // owner ([behavior-change]; today has no role check) — enforced in Phase 3.
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
  defineRoute<
    void,
    {
      lastRunAt: number | null;
      ok: boolean;
      error: string | null;
      retention: number;
      destDir: string;
    }
  >({
    opId: "system.backupStatus",
    method: "GET",
    path: "/api/backup/status",
    auth: cap("office:read", authenticated),
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
];

// The full table the contract tests sweep.
export const ALL_ROUTES: readonly RouteDef[] = [
  ...API_ROUTES,
  ...PUBLIC_ROUTES,
];
