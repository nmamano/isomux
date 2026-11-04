import {
  ASK_CREATE_PLAIN_TEXT_PARAMS,
  ASK_EDIT_PLAIN_TEXT_PARAMS,
  ASK_REPLY_PLAIN_TEXT_PARAMS,
  INBOX_PLAIN_TEXT_PARAMS,
  MESSAGE_PLAIN_TEXT_PARAMS,
  type PlainTextParams,
} from "../../shared/plain-text-form.ts";
import type { AppWidgetStatus } from "../../shared/contract-shapes.ts";
import {
  resourceTargets,
  createdResource,
  namedResource,
  selectedTargets,
} from "./audit.ts";
import type { RouteHandlerContext, HandlerResult } from "./executor.ts";
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
import type { RouteTokenArea } from "../../shared/api-token-limits.ts";
import type { RouteAuthz } from "../identity/dispatch.ts";
import {
  authenticated,
  operationalAuthenticated,
  agentReferenceReader,
  agentTokenSender,
  apiTokenInboxSelf,
  selfOrOwner,
  proxyMemberPrompt,
  memberSharesRoom,
  selfUserOrApi,
  userOrApi,
  selfOrEnvOwner,
  officeOwner,
  officeSettingsOwner,
  auditOwner,
  officeEnvOwner,
  integrationOfficeOwner,
  integrationOfficeReader,
  integrationSelfOrOwner,
  ownerProxyMemberCreate,
  userScope,
  memberScope,
  requiresRoomAccess,
  agentParamMustEqualTokenAgent,
  agentManagerMatch,
  agentDirectoryReader,
  agentFilesRead,
  agentFilesUpload,
  messageSend,
  agentAbort,
  scheduledMessagesOwner,
  conversationReset,
  logSearchAccess,
  liveAgentReadAccess,
  queueCancelAccess,
  cronjobOwnerOrOfficeOwner,
  appOwnerOrOfficeOwner,
  appScope,
  agentManagerOwner,
  webhookOwnerOrOfficeOwner,
  webhookMakerAgent,
  hasOwningUser,
  runParamMustEqualTokenRun,
  taskDelete,
  agentKill,
  notApp,
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
  PagerEntry,
  CronjobListWire,
  CronjobRun,
  ScheduledMessageEntry,
  QueuedMessageView,
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
  MembersChatMessage,
  AskMemberWire,
  GithubLinkWire,
} from "../../shared/types.ts";
import type { GithubLinkInput } from "../github-sync.ts";
import type {
  SpawnReq,
  AgentSystemPromptPreviewReq,
  EditAgentReq,
  SetPrivilegedReq,
  SetAgentAccessReq,
  SetManagerReq,
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
  AffordanceBrowserReq,
  AffordanceBrowserResp,
  AgentContextUsageResp,
  AgentSubscriptionUsageResp,
  LogsResp,
  EditorSaveReq,
  RoomCreateReq,
  RoomRenameReq,
  RoomSettingsRes,
  ViewOrderReq,
  ShownRoomsReq,
  TuckedRoomsReq,
  PushRoomsReq,
  NotifRoomsReq,
  MeRoomsRes,
  PreferencesReq,
  ApiTokenCreateReq,
  ApiTokenCreateRes,
  ApiTokenListRes,
  ApiTokenInboxDrainReq,
  ApiTokenInboxDrainRes,
  ApiTokenInboxSendReq,
  ApiTokenInboxSendRes,
  RecoveryMintReq,
  UserCreateReq,
  UserUpdateReq,
  SetAccessReq,
  UserEnvNamesRes,
  OfficeEnvNamesRes,
  AgentConnectionsRes,
  ConnectionsListRes,
  UserEnvReplaceReq,
  UserEnvSetReq,
  UserEnvRes,
  SecretCreateReq,
  SecretListRes,
  OfficeSecretListRes,
  SecretRes,
  SecretValueRes,
  McpServerCreateReq,
  McpServerListRes,
  OfficeMcpServerListRes,
  McpServerRes,
  AgentMcpServerListRes,
  AgentMcpServerRes,
  McpServerSignInRes,
  ConnectionTestRes,
  McpServerUpdateReq,
  SecretRotateReq,
  SecretUpdateReq,
  SecretRequestReq,
  AskCreateReq,
  AskEditReq,
  AskReplyReq,
  AskDismissReq,
  AskSimplifyReq,
  AskFileTaskReq,
  AskAgentWire,
  AskClosedWire,
  AskHistoryRes,
  AskEventsRes,
  SecretRequestRes,
  SecretRequestSaveReq,
  SecretRequestAnswerRes,
  SudoRequestReq,
  SudoRequestRes,
  SudoRequestRunReq,
  SudoRequestAnswerRes,
  PagerSettingsReq,
  MemberVoiceReq,
  MemberVoiceRes,
  IntegrationChangesRes,
  PagerSettingsRes,
  PagerTestRes,
  PushDevice,
  PushDeviceReq,
  PushDevicesRes,
  PushTestRes,
  InviteMintReq,
  AccessSettingsReq,
  AccessSettings,
  OfficeSettingsReq,
  OfficeSettingsRes,
  OfficeUsageStatusRes,
  ValidateCwdReq,
  ValidateEnvReq,
  TaskCreateReq,
  TaskUpdateReq,
  TaskClaimReq,
  MembersChatPageRes,
  FloorsListRes,
  FloorAddReq,
  FloorAddRes,
  FloorNameRes,
  MembersChatPostReq,
  MembersChatEditReq,
  MembersChatThumbsUpReq,
  MembersChatPinReq,
  MembersChatReadReq,
  MembersChatReadRes,
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
  SkillCatalogRes,
  SkillFileRes,
  SkillSaveReq,
  SkillDeleteReq,
  SkillSaveRes,
  SkillCreateReq,
  CronCreateReq,
  CronUpdateReq,
  CronRunMessageReq,
  InstructionsReq,
  InstructionsRes,
  UserSelfWire,
  UserAdminWire,
  RemovedMemberListRes,
  MemberRestoreReq,
  MemberRestoreRes,
  StorageUsageWire,
  UsageReportWire,
  StoragePruneReq,
  StorageCompressReq,
  StorageCompressRes,
  BackupSettingsReq,
  BackupSettingsRes,
  StoragePruneRes,
  BackupStatusWire,
  WebhookCreateReq,
  WebhookCreateRes,
  WebhookDeliveriesRes,
  WebhookDryRunReq,
  WebhookDryRunRes,
  WebhookSecretRes,
  WebhookUpdateReq,
  WebhookWire,
  TerminalReadRes,
  TerminalRecordingsListRes,
} from "../../shared/contract-shapes.ts";
import type {
  VoiceSpeakReq,
  VoiceStatusRes,
  VoiceTranscribeRes,
} from "../../shared/voice.ts";

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
  | "userDeleteNotLastOwner"
  // webhooks.create / webhooks.update: the caller may point the hook at its
  // target, checked on the WHOLE record after a PATCH merge, also when the
  // request does not name the target. Reads live agents, rooms and cronjobs.
  | "webhookTargetAllowed";

export interface RouteDef<Req = unknown, Res = unknown> {
  audit?:
    | { owner: "none"; reason: string }
    | { owner: "store" }
    | {
        owner: "executor";
        targets: (ctx: RouteHandlerContext, result: HandlerResult) => string[];
      };
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
  // "binary": the executor does not read or JSON-parse the body; the handler
  // reads ctx.req itself. Absent means a JSON body.
  body?: "binary";
  // The route also takes a text/plain body: the body is the `text` field and
  // each listed query parameter is one more field (shared/plain-text-form.ts).
  // Absent means JSON only.
  plainText?: { params: PlainTextParams<Req> };
  // The route's area in a limited API token's limits (shared/api-token-limits.ts).
  // Every route an API token passes stage 1 on declares one; a limited token is
  // refused a route without one.
  tokenArea?: RouteTokenArea;
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
// Capability-free agent routes also use this shorthand. An APP passes only with
// a live owner agent, whose room reach it has; remote-member API identities use
// their issuing user's room projection.
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
  // API-token senders only: the office's own timestamp on this message, the
  // same value its `to_agent` log entry carries. A client outside the office
  // reads when the office took the message from the send itself, instead of
  // draining the log to find out.
  sentAt?: number;
  // API-token senders only: the sequence of that `to_agent` log entry, a
  // cursor for the drain.
  sequence?: number;
};
// Schedule-branch ack (agents.sendMessage with deliverAt): the scheduled-entry
// handle plus the normalized (UTC RFC3339) delivery time - never a fake empty
// messageId.
type ScheduledAck = { scheduledId: string; deliverAt: string };
type ScheduledMessagesListRes = { scheduled: ScheduledMessageEntry[] };
type QueueReadRes = { queue: QueuedMessageView[] };
type AgentEnvelope = { agent: AgentInfo };
// agents.readInstructions: the agent's instructions + their concurrency token -
// the read half of the read-then-write flow that agents.setInstructions and
// agents.update's version guard expect.
type AgentInstructionsRes = InstructionsRes;
type AgentSystemPromptRes = { prompt: string };
type CronjobSystemPromptRes = {
  systemPrompt: string;
  firstUserMessage: string;
};
type OkTrue = { ok: true };
type InteractionResponseReq = { value: string };
type InteractionResponseRes = {
  interactionId: string;
  status: "settled" | "canceled";
};

export const API_ROUTES: readonly RouteDef[] = [
  defineRoute({
    opId: "audit.list",
    method: "GET",
    path: "/api/audit-log",
    auth: cap("audit:read", auditOwner),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  // Terminal recordings (task 749cb7fd): the audit log's readers.
  defineRoute<void, TerminalRecordingsListRes>({
    opId: "terminalRecordings.list",
    method: "GET",
    path: "/api/terminal-recordings",
    auth: cap("audit:read", auditOwner),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  defineRoute({
    opId: "terminalRecordings.get",
    method: "GET",
    path: "/api/terminal-recordings/:id",
    auth: cap("audit:read", auditOwner),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  defineRoute({
    opId: "tasks.history",
    method: "GET",
    path: "/api/tasks/:id/history",
    auth: cap("task:read", operationalAuthenticated),
    tokenArea: { area: "tasks", level: "read" },
    emits: [],
  }),
  defineRoute({
    opId: "tasks.restore",
    method: "POST",
    path: "/api/tasks/:id/restore",
    auth: cap("audit:read", auditOwner),
    tokenArea: { area: "tasks", level: "write" },
    emits: ["tasks"],
    audit: { owner: "store" },
  }),

  defineRoute<
    void,
    { version: string; topics: { topic: string; description: string }[] }
  >({
    opId: "agentReference.list",
    method: "GET",
    path: "/api/agent-reference",
    auth: authn(agentReferenceReader),
    tokenArea: "always",
    emits: [],
  }),
  defineRoute<void, { version: string; topic: string; markdown: string }>({
    opId: "agentReference.get",
    method: "GET",
    path: "/api/agent-reference/:topic",
    auth: authn(agentReferenceReader),
    tokenArea: "always",
    emits: [],
  }),
  // The office directory. Path outside /api on purpose: every agent, skill
  // and prompt calls /agents.
  defineRoute<void, unknown>({
    opId: "agents.discovery",
    method: "GET",
    path: "/agents",
    auth: authn(agentDirectoryReader),
    tokenArea: { area: "agents", level: "read" },
    emits: [],
  }),
  // An agent's face as an image, for apps and any page that shows agents. The
  // identities GET /agents serves, for an agent in a room they reach.
  defineRoute<void, Uint8Array>({
    opId: "agents.avatar",
    method: "GET",
    path: "/api/agents/:id/avatar.svg",
    auth: authn(
      and(
        agentDirectoryReader,
        requiresRoomAccess({ kind: "paramAgentId", name: "id" }),
      ),
    ),
    tokenArea: { area: "agents", level: "read" },
    emits: [],
  }),
  defineRoute<SpawnReq, AgentEnvelope>({
    opId: "agents.spawn",
    audit: { owner: "executor", targets: createdResource("agent") },
    method: "POST",
    path: "/api/agents",
    // Every agent spawns (agent:spawn), into its manager's rooms; the handler
    // applies the spawn limits to an agent without agent:manage.
    auth: cap(["agent:manage", "agent:spawn"], bodyRoom("roomId")),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: ["agent_added"],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.kill",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/agents/:id",
    // agent:spawn kills only an agent this agent spawned (agentKill).
    auth: cap(
      ["agent:manage", "agent:spawn"],
      and(agentParam("id"), agentKill),
    ),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: ["agent_removed", "killed_agent_added"],
  }),
  defineRoute<ReviveReq, AgentEnvelope>({
    opId: "agents.revive",
    audit: { owner: "executor", targets: createdResource("agent") },
    method: "POST",
    path: "/api/agents/:id/revive",
    // Guard: access to the TARGET room (body.roomId). The ∧ lastRoomId access
    // check is a typed precondition (killed-agent last room is live-state).
    auth: cap("agent:manage", bodyRoom("roomId")),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: ["agent_added", "killed_agent_removed"],
    preconditions: ["reviveLastRoomAccess"],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.abort",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/abort",
    // An operator stops any agent it can reach; every agent stops any agent it
    // may message (see agentAbort).
    auth: cap(["agent:manage", "agent:send-as-self"], agentAbort),
    tokenArea: { area: "agents", level: "write", reply: true },
    emits: [],
  }),
  defineRoute<EditAgentReq, AgentEnvelope>({
    opId: "agents.update",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/agents/:id",
    auth: cap("agent:manage", agentParam("id")),
    tokenArea: { area: "agentManagement", level: "write" },
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
    tokenArea: { area: "agents", level: "read" },
    emits: [],
  }),
  // The write half: same auth as agents.update, which also takes the text.
  defineRoute<InstructionsReq, InstructionsRes>({
    opId: "agents.setInstructions",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/agents/:id/instructions",
    auth: cap("agent:manage", agentParam("id")),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: ["agent_updated"],
  }),
  defineRoute<void, AgentSystemPromptRes>({
    opId: "agents.readSystemPrompt",
    method: "GET",
    path: "/api/agents/:id/system-prompt",
    auth: authn(agentParam("id")),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  defineRoute<AgentSystemPromptPreviewReq, AgentSystemPromptRes>({
    opId: "agents.previewSystemPrompt",
    audit: {
      owner: "none",
      reason: "Computes a preview without changing state.",
    },
    method: "POST",
    path: "/api/agents/system-prompt-preview",
    auth: authn(bodyRoom("roomId")),
    tokenArea: { area: "logs", level: "read" },
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
    tokenArea: { area: "agentManagement", level: "write" },
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/agents/:id/privileged",
    auth: cap(
      "agent:privilege",
      and(userScope, or(officeOwner, agentManagerMatch("id"))),
    ),
    emits: ["agent_updated"],
  }),
  // The access slider (shared/agent-access.ts): the same double gate as
  // agents.setPrivileged, which stays as the Standard/Privileged switch. This
  // route is the one way to a stop below Standard and back up from one.
  defineRoute<SetAgentAccessReq, AgentEnvelope>({
    opId: "agents.setAccess",
    tokenArea: { area: "agentManagement", level: "write" },
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/agents/:id/access",
    auth: cap(
      "agent:privilege",
      and(userScope, or(officeOwner, agentManagerMatch("id"))),
    ),
    emits: ["agent_updated"],
  }),
  // Manager transfer (task 6a9deaba). An office owner's reach (Nil,
  // 2026-10-26): an owner by cookie session, a privileged agent whose manager
  // is an office owner (or its app), or an owner's API token. A transfer makes
  // the agent run on the new manager's credentials, so a caller with this
  // reach can put an agent on any member's credentials. No manager-match
  // branch: a member cannot give an agent away.
  defineRoute<SetManagerReq, AgentEnvelope>({
    opId: "agents.setManager",
    audit: {
      owner: "executor",
      targets: selectedTargets({ body: ["userId"] }),
    },
    method: "PUT",
    path: "/api/agents/:id/manager",
    auth: cap("agent:manage", agentManagerOwner),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: [
      "agent_updated",
      "clear_logs",
      "app_upserted",
      "cronjob_updated",
      "webhook_upserted",
    ],
  }),
  defineRoute<MoveAgentReq, AgentEnvelope>({
    opId: "agents.move",
    audit: {
      owner: "executor",
      targets: selectedTargets({ body: ["targetRoomId"] }),
    },
    method: "POST",
    path: "/api/agents/:id/move",
    auth: cap("agent:manage", and(agentParam("id"), bodyRoom("targetRoomId"))),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: ["agent_updated"],
  }),
  defineRoute<TopicReq, NoContent>({
    opId: "agents.setTopic",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/agents/:id/topic",
    auth: cap("agent:manage", agentParam("id")),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: ["agent_updated"],
  }),
  // DELETE regenerates the topic from the conversation (the LogView refresh
  // button); the current topic stays until the new one replaces it. A PUT with
  // a blank topic clears it.
  defineRoute<void, NoContent>({
    opId: "agents.regenerateTopic",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/agents/:id/topic",
    auth: cap("agent:manage", agentParam("id")),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: ["agent_updated"],
  }),
  defineRoute<SwapDesksReq, NoContent>({
    opId: "rooms.swapDesks",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/rooms/:roomId/swap-desks",
    auth: cap("agent:manage", roomParam("roomId")),
    tokenArea: { area: "agentManagement", level: "write" },
    emits: ["agent_updated"], // ×2 at runtime; one registry id
  }),

  defineRoute<SendMessageReq, AgentMessageAck | ScheduledAck>({
    opId: "agents.sendMessage",
    audit: {
      owner: "executor",
      targets: selectedTargets({ result: ["messageId", "scheduledId"] }),
    },
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
    plainText: { params: MESSAGE_PLAIN_TEXT_PARAMS },
    tokenArea: { area: "agents", level: "write", reply: true },
    emits: ["log_entry", "interaction_added", "agent_updated"],
    preconditions: [
      "messageRecipientExists",
      "messagePendingPermissionBindsParam",
    ],
  }),
  defineRoute<InteractionResponseReq, InteractionResponseRes>({
    opId: "agents.respondInteraction",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/interactions/:interactionId/respond",
    // The same operator-vs-self policy as conversation reset. It allows a
    // human operator (or a privileged agent with agent:converse) to answer a
    // reachable agent, while an ordinary agent cannot use its spawning user's
    // room grants as a confused deputy.
    auth: cap(
      ["agent:converse", "self:affordance"],
      and(notApp, conversationReset),
    ),
    tokenArea: { area: "agents", level: "write" },
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
    tokenArea: { area: "agents", level: "read" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.cancelScheduledMessage",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/agents/:id/scheduled-messages/:scheduledId",
    auth: cap(["agent:converse", "agent:send-as-self"], scheduledMessagesOwner),
    tokenArea: { area: "agents", level: "write" },
    emits: [],
  }),
  defineRoute<EditMessageReq, MessageAck>({
    opId: "agents.editMessage",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/agents/:id/messages/:logEntryId",
    auth: cap("agent:converse", and(notApp, agentParam("id"))),
    tokenArea: { area: "agents", level: "write" },
    emits: ["log_entry"],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.cancelQueued",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/agents/:id/queue/:messageId",
    // Every agent may take back a message it sent; cancelling anything else
    // needs queueCancelAny's reach, which the handler checks.
    auth: cap(["agent:converse", "agent:send-as-self"], queueCancelAccess),
    tokenArea: { area: "agents", level: "write", reply: true },
    emits: [],
  }),
  // The receiver's waiting messages, as the chat's queue chips show them. Same
  // reach as the session list.
  defineRoute<void, QueueReadRes>({
    opId: "agents.readQueue",
    method: "GET",
    path: "/api/agents/:id/queue",
    auth: cap("log:read", liveAgentReadAccess),
    tokenArea: { area: "agents", level: "read" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.sendNow",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/send-now",
    auth: cap("agent:converse", and(notApp, agentParam("id"))),
    tokenArea: { area: "agents", level: "write" },
    emits: ["log_entry"],
  }),
  // Clear the session and start a fresh conversation. Operators (users +
  // privileged agents holding agent:converse) clear any agent in an accessible
  // room; an ordinary agent may clear ITSELF (self:affordance), so it can reset
  // its own session. conversationReset enforces the operator-vs-self split.
  defineRoute<NewConversationReq, NoContent>({
    opId: "agents.newConversation",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/new-conversation",
    auth: cap(["agent:converse", "self:affordance"], conversationReset),
    tokenArea: { area: "agents", level: "write" },
    emits: ["clear_logs"],
  }),
  // Instant self-handoff: reset the session (like
  // new-conversation) AND deliver {text} into the fresh session as the agent's
  // own brief, in one call - an agent's self-handoff (a member's /handoff runs
  // the same reset server-side, agent-manager handoffBody). One handoff at a time per agent
  // (a concurrent second gets 409 handoff_in_progress, so the running one can't
  // be clobbered into a false success); the enqueue is transactional, so a
  // delivery failure surfaces as an HTTP error, not a false ack. Same auth split
  // as new-conversation (conversationReset): an operator
  // hands off any reachable agent, an ordinary agent only itself. Emits
  // clear_logs (the reset) then the fresh turn's log_entry (the injected brief).
  defineRoute<HandoffReq, { ok: true }>({
    opId: "agents.handoff",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/handoff",
    auth: cap(
      ["agent:converse", "self:affordance"],
      and(notApp, conversationReset),
    ),
    tokenArea: { area: "agents", level: "write" },
    emits: ["clear_logs", "log_entry"],
  }),
  defineRoute<ResumeReq, NoContent>({
    opId: "agents.resume",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/resume",
    auth: cap("agent:converse", agentParam("id")),
    tokenArea: { area: "agents", level: "write" },
    emits: ["log_entry"],
  }),
  defineRoute<
    void,
    { sessions: SessionInfo[]; currentSessionId: string | null }
  >({
    opId: "agents.listSessions",
    method: "GET",
    path: "/api/agents/:id/sessions",
    auth: cap("log:read", liveAgentReadAccess),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  defineRoute<void, TerminalReadRes>({
    opId: "agents.terminal",
    method: "GET",
    path: "/api/agents/:id/terminal",
    auth: cap("log:read", liveAgentReadAccess),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),

  defineRoute<AffordanceReadFileReq, OkTrue>({
    opId: "agents.readFile",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/read-file",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "files", level: "write" },
    emits: ["log_entry"],
  }),
  defineRoute<AffordanceDiffReq, OkTrue>({
    opId: "agents.diff",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/diff",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "files", level: "write" },
    emits: ["log_entry"],
  }),
  defineRoute<AffordanceEditFileReq, OkTrue>({
    opId: "agents.editFile",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/edit-file",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "files", level: "write" },
    emits: ["log_entry"],
  }),
  defineRoute<AffordanceTerminalCmdReq, OkTrue>({
    opId: "agents.terminalCommand",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/terminal-command",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "files", level: "write" },
    emits: ["log_entry"],
  }),
  // Secret requests (secrets loop, B4): the agent asks for itself, and the
  // request waits as an ask; the member answers in the ask's masked form.
  // The core checks who may answer (askVisibleTo): the agent's manager for a
  // personal secret, an office owner for an office one. Audit rows name the
  // agent, the request and the secret, never a value.
  defineRoute<SecretRequestReq, SecretRequestRes>({
    opId: "agents.secretRequest",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/secret-requests",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "environment", level: "write" },
    emits: ["ask_upserted"],
  }),
  defineRoute<SecretRequestSaveReq, SecretRequestAnswerRes>({
    opId: "secretRequests.save",
    audit: { owner: "executor", targets: namedResource },
    method: "POST",
    path: "/api/agents/:id/secret-requests/:requestId/save",
    auth: cap("user:env", memberScope),
    tokenArea: { area: "environment", level: "write" },
    emits: ["log_entry", "ask_removed"],
  }),
  defineRoute<void, SecretRequestAnswerRes>({
    opId: "secretRequests.decline",
    audit: { owner: "executor", targets: namedResource },
    method: "POST",
    path: "/api/agents/:id/secret-requests/:requestId/decline",
    auth: cap("user:env", memberScope),
    tokenArea: { area: "environment", level: "write" },
    emits: ["log_entry", "ask_removed"],
  }),
  // Sudo requests (task 43a28eed): the agent asks for itself, and the
  // request waits as an ask for the office owner it names, who types the
  // box account's password to run the command. user:admin admits browser
  // sessions only: no API token or agent answers. Audit rows name the body's
  // fields, never the password.
  defineRoute<SudoRequestReq, SudoRequestRes>({
    opId: "agents.sudoRequest",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/sudo-requests",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "files", level: "write" },
    emits: ["ask_upserted"],
  }),
  defineRoute<SudoRequestRunReq, SudoRequestAnswerRes>({
    opId: "sudoRequests.run",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/sudo-requests/:requestId/run",
    auth: cap("user:admin", officeOwner),
    tokenArea: { area: "files", level: "write" },
    emits: ["log_entry", "ask_removed"],
  }),
  defineRoute<void, SudoRequestAnswerRes>({
    opId: "sudoRequests.decline",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/sudo-requests/:requestId/decline",
    auth: cap("user:admin", officeOwner),
    tokenArea: { area: "files", level: "write" },
    emits: ["log_entry", "ask_removed"],
  }),
  // Asks (internal-docs/asks-design.md): the agent manages its
  // own list (self:affordance, :id must be the token's agent); the member the
  // ask is for answers it. The handlers check that member and its room
  // access against live state, the same 404 for anyone else.
  defineRoute<AskCreateReq, AskAgentWire>({
    opId: "agents.createAsk",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/asks",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    plainText: { params: ASK_CREATE_PLAIN_TEXT_PARAMS },
    tokenArea: { area: "asks", level: "write" },
    emits: ["ask_upserted", "others_ask_upserted"],
  }),
  defineRoute<void, AskAgentWire[]>({
    opId: "agents.listAsks",
    method: "GET",
    path: "/api/agents/:id/asks",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "asks", level: "write" },
    emits: [],
  }),
  defineRoute<void, AskAgentWire>({
    opId: "agents.getAsk",
    method: "GET",
    path: "/api/agents/:id/asks/:askId",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "asks", level: "write" },
    emits: [],
  }),
  // An agent's closed asks (task ff590b5e), with the reach of its logs: every
  // field of a closed ask - the prompt, the options, the member's answer - is
  // already in that agent's log (the create call and the member's reply
  // message), so this reach shows nothing a log reader cannot read; it only
  // makes the calls queryable. logSearchAccess also admits a killed agent's
  // owner, so the handler needs no live agent. A read by id with this reach is
  // asks.get.
  defineRoute<void, AskHistoryRes>({
    opId: "agents.askHistory",
    method: "GET",
    path: "/api/agents/:id/asks/history",
    auth: cap("log:read", logSearchAccess),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  // An agent's ask log (task 302e7ea4): each create, edit, simplify request
  // and close of its asks, open or closed, as they happen. The history's
  // reach, for the same reason: every event is in the agent's log.
  defineRoute<void, AskEventsRes>({
    opId: "agents.askEvents",
    method: "GET",
    path: "/api/agents/:id/asks/events",
    auth: cap("log:read", logSearchAccess),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  defineRoute<AskEditReq, AskAgentWire>({
    opId: "agents.editAsk",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/agents/:id/asks/:askId",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    plainText: { params: ASK_EDIT_PLAIN_TEXT_PARAMS },
    tokenArea: { area: "asks", level: "write" },
    emits: ["ask_upserted", "others_ask_upserted"],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.deleteAsk",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/agents/:id/asks/:askId",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "asks", level: "write" },
    emits: ["ask_removed", "others_ask_removed"],
  }),
  defineRoute<void, AskMemberWire[]>({
    opId: "asks.list",
    method: "GET",
    path: "/api/asks",
    auth: cap(["agent:converse", "api:send-message"], memberScope),
    tokenArea: { area: "asks", level: "read" },
    emits: [],
  }),
  // Other members' open asks, for an office owner (askShownToOwnerAsOther);
  // 403 for anyone else. The answer routes admit the owner too.
  defineRoute<void, AskAgentWire[]>({
    opId: "asks.listOthers",
    method: "GET",
    path: "/api/asks/others",
    auth: cap(["agent:converse", "api:send-message"], memberScope),
    tokenArea: { area: "asks", level: "read" },
    emits: [],
  }),
  // Any agent's ask by its id, open or closed, for a caller with the reach of
  // that agent's logs (task 03f5c534): the id is on the ask card, so a member
  // can point another agent at an ask. The handler checks the reach against
  // the ask's agent, the same 404 as an unknown id.
  defineRoute<void, AskAgentWire | AskClosedWire>({
    opId: "asks.get",
    method: "GET",
    path: "/api/asks/:askId",
    auth: cap("log:read", operationalAuthenticated),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  defineRoute<AskReplyReq, NoContent>({
    opId: "asks.reply",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/asks/:askId/reply",
    auth: cap(["agent:converse", "api:send-message"], memberScope),
    plainText: { params: ASK_REPLY_PLAIN_TEXT_PARAMS },
    tokenArea: { area: "asks", level: "write" },
    emits: [
      "ask_removed",
      "others_ask_removed",
      "log_entry",
      "interaction_added",
      "agent_updated",
    ],
  }),
  defineRoute<AskDismissReq, NoContent>({
    opId: "asks.dismiss",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/asks/:askId/dismiss",
    auth: cap(["agent:converse", "api:send-message"], memberScope),
    tokenArea: { area: "asks", level: "write" },
    emits: [
      "ask_removed",
      "others_ask_removed",
      "log_entry",
      "interaction_added",
      "agent_updated",
    ],
  }),
  // The member asks the agent to rewrite the ask in plain words; the ask
  // stays open.
  defineRoute<AskSimplifyReq, NoContent>({
    opId: "asks.simplify",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/asks/:askId/simplify",
    auth: cap(["agent:converse", "api:send-message"], memberScope),
    tokenArea: { area: "asks", level: "write" },
    emits: [
      "ask_upserted",
      "others_ask_upserted",
      "log_entry",
      "interaction_added",
      "agent_updated",
    ],
  }),
  // The member withdraws a simplify request the agent has not acted on yet;
  // the ask stays open.
  defineRoute<AskSimplifyReq, NoContent>({
    opId: "asks.simplifyUndo",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/asks/:askId/simplify/undo",
    auth: cap(["agent:converse", "api:send-message"], memberScope),
    tokenArea: { area: "asks", level: "write" },
    emits: [
      "ask_upserted",
      "others_ask_upserted",
      "log_entry",
      "interaction_added",
      "agent_updated",
    ],
  }),
  // A file an ask references in place (a video or audio file), for the
  // member the ask is for.
  defineRoute<void, unknown>({
    opId: "asks.getFile",
    method: "GET",
    path: "/api/asks/:askId/files/:filename",
    auth: cap(["agent:converse", "api:send-message"], memberScope),
    tokenArea: { area: "asks", level: "read" },
    emits: [],
  }),
  defineRoute<AskFileTaskReq, TaskItem>({
    opId: "asks.fileTask",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/asks/:askId/file-task",
    auth: cap(["agent:converse", "api:send-message"], memberScope),
    tokenArea: { area: "asks", level: "write" },
    emits: [
      "ask_removed",
      "others_ask_removed",
      "log_entry",
      "interaction_added",
      "agent_updated",
      "tasks",
    ],
  }),
  defineRoute<AffordancePreviewUrlReq, OkTrue>({
    opId: "agents.previewUrl",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/preview-url",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "files", level: "write" },
    emits: ["log_entry"],
  }),
  // Drive a page in the manager's desktop Chrome (internal-docs/
  // browser-extension.md). Same self:affordance gate as preview-url. It
  // emits only for the screenshot action, which puts a card in the chat; the
  // read and interaction actions answer the caller and leave the chat alone.
  defineRoute<AffordanceBrowserReq, AffordanceBrowserResp>({
    opId: "agents.browser",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/agents/:id/browser",
    auth: cap("self:affordance", agentParamMustEqualTokenAgent),
    tokenArea: { area: "files", level: "write" },
    emits: ["log_entry"],
  }),
  // Context-window fullness check (internal-docs/
  // context-fullness-visibility.md): the target agent's latest fullness sample.
  // Read-only - nothing lands in chat, so no log_entry emit.
  defineRoute<void, AgentContextUsageResp>({
    opId: "agents.contextUsage",
    method: "GET",
    path: "/api/agents/:id/context",
    auth: cap("log:read", logSearchAccess),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),

  defineRoute<void, AgentSubscriptionUsageResp>({
    opId: "agents.subscriptionUsage",
    method: "GET",
    path: "/api/agents/:id/subscription",
    auth: cap("log:read", logSearchAccess),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),

  // Conversation-log search + retrieval. ONE route
  // with three modes, chosen by the query: ?q= searches, ?session= retrieves,
  // neither lists the agent's sessions. Read-only, so nothing is emitted.
  //
  // Its OWN capability (`log:read`) rather than office:read, which plain agent
  // tokens do not carry - see the Capability union in identity/index.ts. The
  // guard widens an AGENT's reach past its own chat to any agent in a room its
  // member can access; logSearchAccess documents why that is sound for a read.
  defineRoute<void, LogsResp>({
    opId: "agents.logs",
    method: "GET",
    path: "/api/agents/:id/logs",
    auth: cap("log:read", logSearchAccess),
    tokenArea: { area: "logs", level: "read" },
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
    tokenArea: { area: "files", level: "read" },
    emits: ["editor_external_change"], // pushed async to the watching session
  }),
  defineRoute<EditorSaveReq, { ok: true; mtime: number }>({
    opId: "agents.saveFile",
    audit: { owner: "executor", targets: selectedTargets({ body: ["path"] }) },
    method: "PUT",
    path: "/api/agents/:id/file",
    auth: cap("editor:use", agentParam("id")),
    tokenArea: { area: "files", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "agents.closeFile",
    audit: { owner: "executor", targets: selectedTargets({ body: ["path"] }) },
    method: "DELETE",
    path: "/api/agents/:id/file/watch",
    auth: cap("editor:use", agentParam("id")),
    tokenArea: { area: "files", level: "write" },
    emits: [],
  }),

  defineRoute<unknown, { attachments: Attachment[] }>({
    opId: "agents.upload",
    audit: { owner: "store" },
    method: "POST",
    path: "/api/agents/:id/uploads",
    auth: cap("file:upload", agentParam("id")),
    tokenArea: { area: "agents", level: "write" },
    emits: [],
  }),
  defineRoute<void, unknown>({
    opId: "agents.getFile",
    method: "GET",
    path: "/api/agents/:id/files/:filename",
    auth: cap("office:read", agentParam("id")),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),

  // Chat attachments, the paths the chat UI links. App and API tokens stay
  // out (`authenticated`); opening them is a separate decision.
  defineRoute<unknown, { attachments: Attachment[] }>({
    opId: "chatFiles.upload",
    audit: { owner: "store" },
    method: "POST",
    path: "/api/upload/:id",
    auth: authn(and(authenticated, agentFilesUpload)),
    tokenArea: { area: "agents", level: "write" },
    emits: [],
  }),
  defineRoute<void, unknown>({
    opId: "chatFiles.get",
    method: "GET",
    path: "/api/files/:id/:filename",
    auth: authn(and(authenticated, agentFilesRead)),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  // Older transcripts link images here.
  defineRoute<void, unknown>({
    opId: "chatFiles.getImage",
    method: "GET",
    path: "/api/images/:id/:filename",
    auth: authn(and(authenticated, agentFilesRead)),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),

  // Members chat: the humans-only stream on the Lobby tab. One capability,
  // chat:members, is the whole gate - held by a cookie user, an API token and a
  // privileged agent, never by an ordinary agent, a cron run or an app. Ownership
  // (edit your own; delete your own, or any as an office owner) is a live check
  // in the handler against the stored author. The two mutations fan out the
  // all-audience members_chat_* events; markRead reaches only the caller's own
  // sockets.
  defineRoute<void, MembersChatPageRes>({
    opId: "membersChat.page",
    method: "GET",
    path: "/api/members-chat",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "read" },
    emits: [],
  }),
  defineRoute<MembersChatPostReq, MembersChatMessage>({
    opId: "membersChat.post",
    audit: {
      owner: "executor",
      targets: selectedTargets({ result: ["messageId"] }),
    },
    method: "POST",
    path: "/api/members-chat",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "write" },
    emits: ["members_chat_message"],
  }),
  defineRoute<MembersChatPinReq, MembersChatMessage>({
    opId: "membersChat.pin",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/members-chat/:id/pin",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "write" },
    emits: ["members_chat_message"],
  }),
  defineRoute<MembersChatThumbsUpReq, MembersChatMessage>({
    opId: "membersChat.thumbsUp",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/members-chat/:id/thumbs-up",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "write" },
    emits: ["members_chat_message"],
  }),
  defineRoute<MembersChatEditReq, MembersChatMessage>({
    opId: "membersChat.edit",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/members-chat/:id",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "write" },
    emits: ["members_chat_message"],
  }),
  defineRoute<void, NoContent>({
    opId: "membersChat.delete",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/members-chat/:id",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "write" },
    emits: ["members_chat_deleted"],
  }),
  defineRoute<MembersChatReadReq, MembersChatReadRes>({
    opId: "membersChat.markRead",
    audit: { owner: "none", reason: "Read markers are internal bookkeeping." },
    method: "POST",
    path: "/api/members-chat/read",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "write" },
    emits: ["members_chat_read"],
  }),
  defineRoute<unknown, { attachments: Attachment[] }>({
    opId: "membersChat.upload",
    audit: { owner: "store" },
    method: "POST",
    path: "/api/members-chat/uploads",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "write" },
    emits: [],
  }),
  defineRoute<void, unknown>({
    opId: "membersChat.getFile",
    method: "GET",
    path: "/api/members-chat/files/:filename",
    auth: cap("chat:members", operationalAuthenticated),
    tokenArea: { area: "membersChat", level: "read" },
    emits: [],
  }),

  // Floors: the lobby elevator's links to other offices (shared/floors.ts).
  // Any member, with the same reach as rooms.create. floors.add probes the
  // other office's public card on the server before it saves anything.
  defineRoute<void, FloorsListRes>({
    opId: "floors.list",
    method: "GET",
    path: "/api/floors",
    auth: cap("office:read", operationalAuthenticated),
    tokenArea: { area: "office", level: "read" },
    emits: [],
  }),
  defineRoute<FloorAddReq, FloorAddRes>({
    opId: "floors.add",
    audit: { owner: "executor", targets: createdResource("floor") },
    method: "POST",
    path: "/api/floors",
    auth: cap("room:manage", operationalAuthenticated),
    tokenArea: { area: "rooms", level: "write" },
    emits: ["floors_updated"],
  }),
  defineRoute<void, FloorNameRes>({
    opId: "floors.name",
    method: "GET",
    path: "/api/floors/name",
    auth: cap("room:manage", operationalAuthenticated),
    tokenArea: { area: "rooms", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "floors.remove",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/floors/:id",
    auth: cap("room:manage", operationalAuthenticated),
    tokenArea: { area: "rooms", level: "write" },
    emits: ["floors_updated"],
  }),

  defineRoute<RoomCreateReq, { room: RoomWire }>({
    opId: "rooms.create",
    audit: { owner: "executor", targets: createdResource("room") },
    method: "POST",
    path: "/api/rooms",
    auth: cap("room:manage", operationalAuthenticated),
    tokenArea: { area: "rooms", level: "write" },
    emits: ["room_created"],
  }),
  defineRoute<void, NoContent>({
    opId: "rooms.close",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/rooms/:roomId",
    auth: cap("room:manage", roomParam("roomId")),
    // room_closed is the structure delta; closing also strips the dead roomId
    // from every user's allowedRooms/notifRooms, fanning out the representative
    // public user events (user_updated per touched record + users_list). Declared
    // for ACL/projection honesty (presence is out-of-band, never route-declared).
    tokenArea: { area: "rooms", level: "write" },
    emits: ["room_closed", "user_updated", "users_list"],
  }),
  // Partial update over the room's fields: the body carries `name`, `pet`,
  // `skin`, `decor`, `cwd`, or any mix, and each is applied only when present.
  // A `backRoom` key, the setting older clients send, is ignored. The opId
  // still reads "rooms.rename" because it namespaces idempotency keys and the
  // handler map; renaming it would be a rename across two test tables for a
  // cosmetic gain.
  defineRoute<RoomRenameReq, NoContent>({
    opId: "rooms.rename",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/rooms/:roomId",
    auth: cap("room:manage", roomParam("roomId")),
    tokenArea: { area: "rooms", level: "write" },
    emits: [
      "room_renamed",
      "room_pet_updated",
      "room_skin_updated",
      "room_decor_updated",
      "room_cwd_updated",
    ],
  }),
  // The room's look, for reading before a PATCH: same ACL as the PATCH.
  defineRoute<void, RoomSettingsRes>({
    opId: "rooms.getSettings",
    method: "GET",
    path: "/api/rooms/:roomId/settings",
    auth: cap("room:manage", roomParam("roomId")),
    tokenArea: { area: "rooms", level: "read" },
    emits: [],
  }),
  // A room's GitHub issue link (task 7fc83592): an office owner's reach, so
  // the owner's agents too. The handler 404s an unknown room.
  defineRoute<void, { link: GithubLinkWire | null }>({
    opId: "githubSync.get",
    method: "GET",
    path: "/api/rooms/:roomId/github-link",
    auth: cap("task:read", integrationOfficeOwner),
    tokenArea: { area: "tasks", level: "read" },
    emits: [],
  }),
  defineRoute<GithubLinkInput, { link: GithubLinkWire }>({
    opId: "githubSync.set",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/rooms/:roomId/github-link",
    auth: cap("task:write", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "githubSync.delete",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/rooms/:roomId/github-link",
    auth: cap("task:write", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // The room's instructions.
  defineRoute<void, InstructionsRes>({
    opId: "rooms.readInstructions",
    method: "GET",
    path: "/api/rooms/:roomId/instructions",
    auth: cap("room:manage", roomParam("roomId")),
    tokenArea: { area: "rooms", level: "read" },
    emits: [],
  }),
  defineRoute<InstructionsReq, InstructionsRes>({
    opId: "rooms.setInstructions",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/rooms/:roomId/instructions",
    auth: cap("room:manage", roomParam("roomId")),
    tokenArea: { area: "rooms", level: "write" },
    emits: ["room_settings_updated"],
  }),
  // View preferences affect visibility only; they never grant or deny access.
  defineRoute<ViewOrderReq, NoContent>({
    opId: "view.setOrder",
    tokenArea: "always",
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "PUT",
    path: "/api/me/view/order",
    auth: cap("view:manage", authenticated),
    emits: ["full_state"],
  }),
  defineRoute<ShownRoomsReq, NoContent>({
    opId: "view.setShown",
    tokenArea: "always",
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "PUT",
    path: "/api/me/view/shown",
    auth: cap("view:manage", authenticated),
    // full_state for the hidden change; user_updated when the notifRooms
    // re-clamp (hiding a notified room) changes the record.
    emits: ["full_state", "user_updated"],
  }),
  defineRoute<NotifRoomsReq, NoContent>({
    opId: "view.setNotifRooms",
    tokenArea: "always",
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "PUT",
    path: "/api/me/view/notif-rooms",
    auth: cap("view:manage", authenticated),
    emits: ["user_updated"],
  }),
  defineRoute<TuckedRoomsReq, NoContent>({
    opId: "view.setTucked",
    tokenArea: "always",
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "PUT",
    path: "/api/me/view/tucked",
    auth: cap("view:manage", authenticated),
    // Tucked is a private record field, not in full_state.
    emits: ["user_admin_updated", "user_self_updated"],
  }),
  defineRoute<PushRoomsReq, NoContent>({
    opId: "view.setPushRooms",
    tokenArea: "always",
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "PUT",
    path: "/api/me/view/push-rooms",
    auth: cap("view:manage", authenticated),
    // pushRooms is a private record field, like tucked.
    emits: ["user_admin_updated", "user_self_updated"],
  }),
  // Self-scoped accessible-rooms read: id+name for every room
  // the caller can ACCESS, hidden included - the read that makes re-show
  // possible for members (projected full_state excludes hidden rooms and
  // all_rooms_list is owner-only). Pure read, no emits.
  defineRoute<void, MeRoomsRes>({
    opId: "view.listRooms",
    tokenArea: "always",
    method: "GET",
    path: "/api/me/rooms",
    auth: cap("view:manage", authenticated),
    emits: [],
  }),

  defineRoute({
    opId: "browser.download",
    tokenArea: { area: "agents", level: "read" },
    method: "GET",
    path: "/api/me/browser/extension.zip",
    auth: cap("user:self", authenticated),
    emits: [],
  }),
  defineRoute({
    opId: "browser.get",
    tokenArea: { area: "agents", level: "read" },
    method: "GET",
    path: "/api/me/browser",
    auth: cap("user:self", authenticated),
    emits: [],
  }),
  defineRoute({
    opId: "browser.pair",
    tokenArea: { area: "agents", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "POST",
    path: "/api/me/browser/pair",
    auth: cap("user:self", authenticated),
    emits: [],
  }),
  defineRoute({
    opId: "browser.revoke",
    tokenArea: { area: "agents", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "DELETE",
    path: "/api/me/browser",
    auth: cap("user:self", authenticated),
    emits: [],
  }),
  defineRoute({
    opId: "browser.revokeOne",
    tokenArea: { area: "agents", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "DELETE",
    path: "/api/me/browser/browsers/:id",
    auth: cap("user:self", authenticated),
    emits: [],
  }),
  defineRoute({
    opId: "browser.reload",
    tokenArea: { area: "agents", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "POST",
    path: "/api/me/browser/browsers/:id/reload",
    auth: cap("user:self", authenticated),
    emits: [],
  }),

  // Settings that follow a member across devices (reply language, voice).
  // Sibling of the view.* surface rather than a field on users.update,
  // because users.update is selfOrOwner and the language is deliberately NOT
  // something an owner sets for a member (see routes/handlers/users.ts); the
  // voice part also has memberVoice.update, which an owner reaches. user:self
  // keeps agents out: it is absent from AGENT_CAPABILITIES and
  // PRIVILEGED_AGENT_CAPABILITIES.
  defineRoute<PreferencesReq, NoContent>({
    opId: "prefs.update",
    tokenArea: "always",
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "PATCH",
    path: "/api/me/preferences",
    auth: cap("user:self", authenticated),
    // SCOPED events only, like users.setAccess: neither preference appears in
    // UserPublicWire, so a public user_updated / users_list would carry no
    // observable change and would only broadcast the TIMING of a private edit.
    // Owners get the full record on the admin channel, the subject on its own.
    emits: ["user_admin_updated", "user_self_updated"],
  }),

  // Voice input and read aloud through OpenAI (task 4481e64b). Each call
  // spends the caller's user's voice key (server/voice-key.ts): a member's
  // own, an agent's manager's. The status names only where the key comes
  // from, never a value.
  defineRoute<void, VoiceStatusRes>({
    opId: "voice.status",
    method: "GET",
    path: "/api/voice",
    auth: cap("voice:use", operationalAuthenticated),
    tokenArea: { area: "voice", level: "read" },
    emits: [],
  }),
  defineRoute<unknown, VoiceTranscribeRes>({
    opId: "voice.transcribe",
    audit: {
      owner: "none",
      reason: "Turns audio into text without changing state.",
    },
    method: "POST",
    path: "/api/voice/transcribe",
    auth: cap("voice:use", operationalAuthenticated),
    tokenArea: { area: "voice", level: "write" },
    emits: [],
  }),
  defineRoute<VoiceSpeakReq, unknown>({
    opId: "voice.speak",
    audit: {
      owner: "none",
      reason: "Turns text into audio without changing state.",
    },
    method: "POST",
    path: "/api/voice/speak",
    auth: cap("voice:use", operationalAuthenticated),
    tokenArea: { area: "voice", level: "write" },
    emits: [],
  }),

  // A member's voice choices on their path (task 7a3b4114): the secrets gate,
  // so the member or an office owner (their API token, their privileged
  // agent) reads and sets them. The key line is the SUBJECT's, never a value.
  defineRoute<void, MemberVoiceRes>({
    opId: "memberVoice.get",
    method: "GET",
    path: "/api/users/:username/voice",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "voice", level: "read" },
    emits: [],
  }),
  defineRoute<MemberVoiceReq, NoContent>({
    opId: "memberVoice.update",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/users/:username/voice",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "voice", level: "write" },
    // The same scoped pair as prefs.update: the subject's tabs get their
    // record, owners the admin copy.
    emits: ["user_admin_updated", "user_self_updated"],
  }),

  // Managed per-user environment. Cleartext values stay self-only, but a
  // durable API identity has the same reach as its issuing user.
  defineRoute<void, UserEnvRes>({
    opId: "userEnv.get",
    method: "GET",
    path: "/api/users/:username/env",
    auth: cap("user:env", selfUserOrApi),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<UserEnvReplaceReq, NoContent>({
    opId: "userEnv.replace",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/users/:username/env",
    auth: cap("user:env", selfUserOrApi),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // One variable at a time, for the member or an office owner for any member
  // (Nil, 2026-10-13), by cookie, API token or privileged agent (Nil,
  // 2026-10-14). The owner manages a member's variables without reading
  // them: the values stay with userEnv.get, self-only, because members kept
  // tokens there before Secrets. Creates or replaces; 204, no body.
  defineRoute<UserEnvSetReq, NoContent>({
    opId: "userEnv.set",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/users/:username/env/:name",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "userEnv.remove",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/users/:username/env/:name",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // Names and notes without values: an office owner reads WHICH managed
  // variables a user has set, so they can see who is still unconfigured. The
  // subject is someone else, and the caller must be an office owner, by
  // cookie, API token or privileged agent. A member's cookie, token and
  // agents get the uniform 403, and so does every non-privileged agent.
  defineRoute<void, UserEnvNamesRes>({
    opId: "userEnv.names",
    method: "GET",
    path: "/api/users/:username/env/names",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  // The office variables' names and notes, read-only, for members too (Nil,
  // 2026-10-13). The values stay with officeEnv.get, owner-only.
  defineRoute<void, OfficeEnvNamesRes>({
    opId: "officeEnv.names",
    method: "GET",
    path: "/api/office/env/names",
    auth: cap("integration:manage", integrationOfficeReader),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<void, UserEnvRes>({
    opId: "officeEnv.get",
    method: "GET",
    path: "/api/office/env",
    auth: cap("user:env", officeEnvOwner),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<UserEnvReplaceReq, NoContent>({
    opId: "officeEnv.replace",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PUT",
    path: "/api/office/env",
    auth: cap("user:env", officeEnvOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // One office variable at a time, as userEnv.set and userEnv.remove: an
  // owner, or an owner's API token or privileged agent, sets or removes it
  // without reading the other values.
  defineRoute<UserEnvSetReq, NoContent>({
    opId: "officeEnv.set",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PUT",
    path: "/api/office/env/:name",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "officeEnv.remove",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "DELETE",
    path: "/api/office/env/:name",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // Secrets (internal-docs/secrets-design.md, section 1). The same gates as
  // the variables above; no response but Show carries a value, and the audit
  // rows name the secret and the body's field names only. No events: the list
  // reloads after its own change, as the variables editor does.
  defineRoute<void, SecretListRes>({
    opId: "secrets.list",
    method: "GET",
    path: "/api/users/:username/secrets",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<SecretCreateReq, SecretRes>({
    opId: "secrets.create",
    audit: { owner: "executor", targets: selectedTargets({ body: ["name"] }) },
    method: "POST",
    path: "/api/users/:username/secrets",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<SecretRotateReq, SecretRes>({
    opId: "secrets.rotate",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/users/:username/secrets/:name/value",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // Show: the value, to the secret's own member only. An office owner manages
  // a member's secrets but never reads one (Nil, 2026-10-13), so the guard is
  // selfUserOrApi, not integrationSelfOrOwner. secret:show is held by no
  // agent scope.
  // A GET, so the handler writes the audit row: the secret's name, never the
  // value.
  defineRoute<void, SecretValueRes>({
    opId: "secrets.reveal",
    method: "GET",
    path: "/api/users/:username/secrets/:name/value",
    auth: cap("secret:show", selfUserOrApi),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<SecretUpdateReq, SecretRes>({
    opId: "secrets.update",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/users/:username/secrets/:name",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "secrets.delete",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/users/:username/secrets/:name",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // A new placeholder for a secret (the generation goes up).
  defineRoute<void, SecretRes>({
    opId: "secrets.reissue",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/users/:username/secrets/:name/reissue",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // The Test button (integrations A3): the server checks the secret against
  // its service's identity endpoint. Audited like pagerSettings.test.
  defineRoute<void, ConnectionTestRes>({
    opId: "secrets.test",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/users/:username/secrets/:name/test",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // Members read the office secrets too, as names, hosts and notes only
  // (OfficeSecretSummaryWire); an owner gets the full rows.
  defineRoute<void, OfficeSecretListRes>({
    opId: "officeSecrets.list",
    method: "GET",
    path: "/api/office/secrets",
    auth: cap("integration:manage", integrationOfficeReader),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<SecretCreateReq, SecretRes>({
    opId: "officeSecrets.create",
    audit: {
      owner: "executor",
      targets: selectedTargets({ body: ["name"], fixed: "office" }),
    },
    method: "POST",
    path: "/api/office/secrets",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<SecretRotateReq, SecretRes>({
    opId: "officeSecrets.rotate",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PUT",
    path: "/api/office/secrets/:name/value",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, SecretValueRes>({
    opId: "officeSecrets.reveal",
    method: "GET",
    path: "/api/office/secrets/:name/value",
    auth: cap("secret:show", officeEnvOwner),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<SecretUpdateReq, SecretRes>({
    opId: "officeSecrets.update",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PATCH",
    path: "/api/office/secrets/:name",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "officeSecrets.delete",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "DELETE",
    path: "/api/office/secrets/:name",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, SecretRes>({
    opId: "officeSecrets.reissue",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "POST",
    path: "/api/office/secrets/:name/reissue",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, ConnectionTestRes>({
    opId: "officeSecrets.test",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "POST",
    path: "/api/office/secrets/:name/test",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // Remote MCP servers (integrations loop, A2). The same gates as the
  // secrets above. Audit rows name the server and the body's field names,
  // never the URL, whose path can carry a token.
  // An agent caller gets the host in place of the URL (AgentMcpServerWire).
  defineRoute<void, McpServerListRes | AgentMcpServerListRes>({
    opId: "mcpServers.list",
    method: "GET",
    path: "/api/users/:username/mcp-servers",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<McpServerCreateReq, McpServerRes | AgentMcpServerRes>({
    opId: "mcpServers.create",
    audit: { owner: "executor", targets: selectedTargets({ body: ["name"] }) },
    method: "POST",
    path: "/api/users/:username/mcp-servers",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<McpServerUpdateReq, McpServerRes | AgentMcpServerRes>({
    opId: "mcpServers.update",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/users/:username/mcp-servers/:name",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "mcpServers.delete",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/users/:username/mcp-servers/:name",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // The Test button (integrations A3): initialize, then tools/list.
  defineRoute<void, ConnectionTestRes>({
    opId: "mcpServers.test",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/users/:username/mcp-servers/:name/test",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // The MCP authorization flow (integrations A2b): the authorization URL
  // for the member's browser. user:env, so no agent starts it.
  defineRoute<void, McpServerSignInRes>({
    opId: "mcpServers.signIn",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/users/:username/mcp-servers/:name/sign-in",
    auth: cap("user:env", selfOrEnvOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // Members read the office servers too, as names, hosts and notes only
  // (OfficeMcpServerSummaryWire); an owner gets the full rows.
  defineRoute<void, OfficeMcpServerListRes>({
    opId: "officeMcpServers.list",
    method: "GET",
    path: "/api/office/mcp-servers",
    auth: cap("integration:manage", integrationOfficeReader),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),
  defineRoute<McpServerCreateReq, McpServerRes | AgentMcpServerRes>({
    opId: "officeMcpServers.create",
    audit: {
      owner: "executor",
      targets: selectedTargets({ body: ["name"], fixed: "office" }),
    },
    method: "POST",
    path: "/api/office/mcp-servers",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<McpServerUpdateReq, McpServerRes | AgentMcpServerRes>({
    opId: "officeMcpServers.update",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PATCH",
    path: "/api/office/mcp-servers/:name",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "officeMcpServers.delete",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "DELETE",
    path: "/api/office/mcp-servers/:name",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, ConnectionTestRes>({
    opId: "officeMcpServers.test",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "POST",
    path: "/api/office/mcp-servers/:name/test",
    auth: cap("integration:manage", integrationOfficeOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  defineRoute<void, McpServerSignInRes>({
    opId: "officeMcpServers.signIn",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "POST",
    path: "/api/office/mcp-servers/:name/sign-in",
    auth: cap("user:env", officeEnvOwner),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // The authorization server sends the member's browser back here. A human
  // session only, and the member who started the flow (the state names
  // them). A GET, so the handler writes its own audit row.
  defineRoute<void, void>({
    opId: "mcpOAuth.callback",
    method: "GET",
    path: "/api/mcp-oauth/callback",
    auth: cap("user:env", userScope),
    tokenArea: { area: "environment", level: "write" },
    emits: [],
  }),
  // Where the member's pages go (a Discord webhook). The secrets gate (task
  // 7a3b4114): the member or an office owner, by cookie, API token or
  // privileged agent. The URL is a credential: the responses carry only its
  // masked form, as the secrets routes carry no value.
  defineRoute<void, PagerSettingsRes>({
    opId: "pagerSettings.get",
    method: "GET",
    path: "/api/users/:username/pager-settings",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "pager", level: "read" },
    emits: [],
  }),
  defineRoute<PagerSettingsReq, PagerSettingsRes>({
    opId: "pagerSettings.update",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/users/:username/pager-settings",
    auth: cap("integration:manage", integrationSelfOrOwner),
    // A save re-arms the member's open pages; any delivery result it causes
    // emits from the store.
    tokenArea: { area: "pager", level: "write" },
    emits: ["pager_upserted"],
  }),
  defineRoute<void, PagerTestRes>({
    opId: "pagerSettings.test",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/users/:username/pager-settings/test",
    auth: cap("integration:manage", integrationSelfOrOwner),
    tokenArea: { area: "pager", level: "write" },
    emits: [],
  }),

  // The devices where the member turned on notifications for their pages
  // (Web Push). Same self-only gate as pagerSettings: an endpoint is where
  // the server sends, so no agent scope reaches these routes.
  defineRoute<void, PushDevicesRes>({
    opId: "pushDevices.list",
    method: "GET",
    path: "/api/users/:username/push-devices",
    auth: cap("user:env", selfUserOrApi),
    tokenArea: { area: "pager", level: "read" },
    emits: [],
  }),
  defineRoute<PushDeviceReq, PushDevice>({
    opId: "pushDevices.add",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/users/:username/push-devices",
    auth: cap("user:env", selfUserOrApi),
    tokenArea: { area: "pager", level: "write" },
    emits: [],
  }),
  defineRoute<void, void>({
    opId: "pushDevices.remove",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/users/:username/push-devices/:id",
    auth: cap("user:env", selfUserOrApi),
    tokenArea: { area: "pager", level: "write" },
    emits: [],
  }),
  defineRoute<void, PushTestRes>({
    opId: "pushDevices.test",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/users/:username/push-devices/:id/test",
    auth: cap("user:env", selfUserOrApi),
    tokenArea: { area: "pager", level: "write" },
    emits: [],
  }),

  // "Changed for you" (task 7a3b4114): the Integrations changes someone else
  // made for the caller, from the audit log. The caller's own cookie or API
  // token; no agent, so an owner's agent cannot read a member's list.
  defineRoute<void, IntegrationChangesRes>({
    opId: "integrationChanges.list",
    method: "GET",
    path: "/api/me/integration-changes",
    auth: cap("user:env", userOrApi),
    tokenArea: { area: "environment", level: "read" },
    emits: [],
  }),

  // Personal durable API credentials. Management is cookie USER-only: an API
  // token can never mint, list, or revoke API tokens, including itself.
  defineRoute<void, ApiTokenListRes>({
    opId: "apiTokens.list",
    tokenArea: "always",
    method: "GET",
    path: "/api/me/api-tokens",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  defineRoute<void, ProviderAccountsWire>({
    opId: "providerAccounts.list",
    tokenArea: { area: "environment", level: "read" },
    method: "GET",
    path: "/api/me/provider-accounts",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  // The integrations list: names of variables, connected sign-ins and the
  // claude.ai connectors each Claude sign-in carries. Never a variable value.
  // Same gate as providerAccounts.list, whose data it includes; office
  // variable names follow officeEnv.get's owner rule inside the handler.
  defineRoute<void, ConnectionsListRes>({
    opId: "connections.list",
    tokenArea: "always",
    method: "GET",
    path: "/api/me/connections",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  // The connections the calling agent gets, with their usage notes
  // (integrations A4). Agent tokens only; the scope is the token's member.
  // Read by agents: no capability, as the agent holds none of user:env.
  defineRoute<void, AgentConnectionsRes>({
    opId: "agentConnections.list",
    method: "GET",
    path: "/api/agent-connections",
    auth: authn(agentTokenSender),
    tokenArea: { area: "agents", level: "read" },
    emits: [],
  }),
  defineRoute<ProviderLoginStartReq, ProviderLoginStartRes>({
    opId: "providerAccounts.start",
    tokenArea: { area: "environment", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "POST",
    path: "/api/me/provider-accounts/:provider/login",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<ProviderLoginCallbackReq, { submitted: true }>({
    opId: "providerAccounts.callback",
    tokenArea: { area: "environment", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "POST",
    path: "/api/me/provider-accounts/:provider/callback",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<void, ProviderAccountsWire>({
    opId: "providerAccounts.refresh",
    tokenArea: { area: "environment", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "POST",
    path: "/api/me/provider-accounts/refresh",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<ProviderLoginCancelReq, { canceled: true }>({
    opId: "providerAccounts.cancel",
    tokenArea: { area: "environment", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "POST",
    path: "/api/me/provider-accounts/:provider/cancel",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<ProviderDisconnectReq, ProviderAccountsWire>({
    opId: "providerAccounts.disconnect",
    tokenArea: { area: "environment", level: "write" },
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "POST",
    path: "/api/me/provider-accounts/:provider/disconnect",
    auth: cap("user:self", userScope),
    emits: ["provider_accounts_updated"],
  }),
  defineRoute<ApiTokenCreateReq, ApiTokenCreateRes>({
    opId: "apiTokens.mint",
    tokenArea: "always",
    audit: { owner: "executor", targets: createdResource("apiToken", "id") },
    method: "POST",
    path: "/api/me/api-tokens",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "apiTokens.revoke",
    tokenArea: "always",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/me/api-tokens/:id",
    auth: cap("user:self", userScope),
    emits: [],
  }),
  defineRoute<ApiTokenInboxSendReq, ApiTokenInboxSendRes>({
    opId: "apiTokenInbox.send",
    audit: {
      owner: "executor",
      targets: selectedTargets({ result: ["messageId"] }),
    },
    method: "POST",
    path: "/api/api-token-inboxes/:tokenId/messages",
    auth: cap("agent:send-to-api-token", agentTokenSender),
    plainText: { params: INBOX_PLAIN_TEXT_PARAMS },
    tokenArea: { area: "agents", level: "write" },
    emits: ["log_entry"],
    preconditions: ["apiTokenInboxTargetAvailable"],
  }),
  defineRoute<ApiTokenInboxDrainReq, ApiTokenInboxDrainRes>({
    opId: "apiTokenInbox.drain",
    audit: {
      owner: "none",
      reason: "Polling read advances only the inbox cursor.",
    },
    method: "POST",
    path: "/api/me/api-token-inbox/drain",
    auth: cap("api:drain-inbox", apiTokenInboxSelf),
    tokenArea: "always",
    emits: [],
  }),

  // An owner creates a member up front; sign-in links (invites.mint) only
  // target existing members. The record starts with pendingSignIn. An owner's
  // privileged agent or API token may create a member (no owner role; room
  // grants allowed); it still cannot mint the sign-in link.
  defineRoute<UserCreateReq, { user: UserAdminWire }>({
    opId: "users.create",
    audit: { owner: "executor", targets: createdResource("user", "id") },
    method: "POST",
    path: "/api/users",
    auth: cap(
      ["user:admin", "user:create"],
      or(officeOwner, ownerProxyMemberCreate),
    ),
    tokenArea: { area: "office", level: "write" },
    emits: ["users_list"],
  }),
  // The member's instructions. Anyone who shares a room with the member reads
  // them, as their memory (memberSharesRoom); that covers the member, their
  // agents and tokens, and an owner's reach. The PUT writes only the text, so
  // a proxy agent needs no body-key check.
  defineRoute<void, InstructionsRes>({
    opId: "users.readInstructions",
    method: "GET",
    path: "/api/users/:username/instructions",
    auth: authn(memberSharesRoom("username")),
    tokenArea: { area: "office", level: "read" },
    emits: [],
  }),
  defineRoute<InstructionsReq, InstructionsRes>({
    opId: "users.setInstructions",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/users/:username/instructions",
    auth: cap(
      ["user:self", "user:admin", "user:prompt"],
      or(selfOrOwner, proxyMemberPrompt),
    ),
    tokenArea: { area: "office", level: "write" },
    emits: ["user_updated", "users_list"],
  }),
  // Humans only: { user: UserSelfWire | UserAdminWire } (same UserRecord
  // shape). Agents and API tokens write a member's instructions through
  // users.setInstructions.
  defineRoute<UserUpdateReq, { user: UserSelfWire }>({
    opId: "users.update",
    tokenArea: "always",
    audit: { owner: "executor", targets: createdResource("user", "id") },
    method: "PATCH",
    path: "/api/users/:username",
    auth: cap(["user:self", "user:admin"], selfOrOwner),
    // Record fields (name/role/avatar). emitUserUpdated + emitUsersList;
    // a role change also re-projects the subject's rooms (full_state) through
    // the users.ts access hook. Access grants and view prefs are not editable here.
    emits: ["user_updated", "users_list", "full_state"],
  }),
  defineRoute<SetAccessReq, { user: UserAdminWire }>({
    opId: "users.setAccess",
    audit: { owner: "executor", targets: resourceTargets },
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
    tokenArea: "always",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/users/:username",
    auth: cap(["user:self", "user:admin"], selfOrOwner),
    // The delete also revokes the member's outstanding sign-in links.
    emits: ["users_list", "session_expired", "invites_list"],
    preconditions: ["userDeleteNotSelfOwner", "userDeleteNotLastOwner"],
  }),
  // Removed members (task 321e7b8e): a removal keeps the member for 30 days,
  // and an office owner restores them or deletes them at once. USER-only, as
  // users.delete.
  defineRoute<void, RemovedMemberListRes>({
    opId: "users.removedList",
    method: "GET",
    path: "/api/removed-members",
    auth: cap("user:admin", officeOwner),
    emits: [],
  }),
  defineRoute<MemberRestoreReq, MemberRestoreRes>({
    opId: "users.restore",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/removed-members/:id/restore",
    auth: cap("user:admin", officeOwner),
    emits: ["users_list", "removed_members"],
  }),
  defineRoute<void, NoContent>({
    opId: "users.purge",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/removed-members/:id",
    auth: cap("user:admin", officeOwner),
    emits: ["removed_members"],
  }),
  // An office owner lists and revokes one member's personal API tokens.
  // officeOwner is cookie USER-only, so no API token or agent reaches these.
  defineRoute<void, ApiTokenListRes>({
    opId: "apiTokens.adminList",
    method: "GET",
    path: "/api/users/:username/api-tokens",
    auth: cap("user:admin", officeOwner),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "apiTokens.adminRevoke",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/users/:username/api-tokens/:id",
    auth: cap("user:admin", officeOwner),
    emits: [],
  }),

  // A sign-in link for an EXISTING member, by stable userId. Invites never
  // create members (users.create does). Ungated on current sessions: the same
  // link signs in a new member for the first time or a member locked out of
  // every device.
  defineRoute<InviteMintReq, { url: string; invite: InviteWire }>({
    opId: "invites.mint",
    audit: {
      owner: "executor",
      targets: createdResource("invite", "tokenPrefix"),
    },
    method: "POST",
    path: "/api/invites",
    auth: cap("invite:manage", officeOwner),
    emits: ["invites_list"],
  }),
  defineRoute<void, { url: string; invite: InviteWire }>({
    opId: "invites.mintSelf",
    tokenArea: "always",
    audit: {
      owner: "executor",
      targets: createdResource("invite", "tokenPrefix"),
    },
    method: "POST",
    path: "/api/invites/self",
    auth: cap("invite:manage", authenticated),
    emits: ["invites_list"],
  }),
  // Permanent alias of invites.mint (same handler). deploy/install.sh and the
  // control plane call it on offices of every version.
  defineRoute<RecoveryMintReq, { url: string; invite: InviteWire }>({
    opId: "invites.mintRecovery",
    audit: {
      owner: "executor",
      targets: createdResource("invite", "tokenPrefix"),
    },
    method: "POST",
    path: "/api/invites/recovery",
    auth: cap("invite:manage", officeOwner),
    emits: ["invites_list"],
  }),
  defineRoute<void, { invites: InviteWire[] }>({
    opId: "invites.list",
    tokenArea: "always",
    method: "GET",
    path: "/api/invites",
    auth: cap("invite:manage", authenticated),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "invites.revoke",
    tokenArea: "always",
    audit: { owner: "executor", targets: resourceTargets },
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
    tokenArea: "always",
    method: "GET",
    path: "/api/sessions",
    auth: cap("session:manage", authenticated),
    emits: [],
  }),
  defineRoute<void, NoContent>({
    opId: "sessions.revoke",
    tokenArea: "always",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/sessions/:sessionPrefix",
    // Owner global / member self: typed precondition. The not-last-owner
    // lockout runs inside the auth mutex (server/auth.ts), not here.
    auth: cap("session:manage", authenticated),
    emits: ["session_revoked", "sessions_active_list", "session_expired"],
    preconditions: ["sessionOwnerOrSelf"],
  }),
  defineRoute<void, NoContent>({
    opId: "sessions.logout",
    audit: { owner: "executor", targets: selectedTargets({ self: true }) },
    method: "DELETE",
    path: "/api/sessions/current",
    // Cap is `authenticated` in the spec: any identity with a current session,
    // no specific capability. The not-last-owner lockout runs inside the auth
    // mutex (server/auth.ts).
    auth: authn(authenticated),
    tokenArea: { area: "office", level: "write" },
    emits: ["session_expired"],
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
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
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
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "POST",
    path: "/api/office/update",
    auth: cap("office:admin", officeOwner),
    emits: [],
  }),

  defineRoute<void, OfficeSettingsRes>({
    opId: "office.getSettings",
    method: "GET",
    path: "/api/office/settings",
    auth: cap("office:settings", officeSettingsOwner),
    tokenArea: { area: "office", level: "read" },
    emits: [],
  }),
  // The member usage cap's status lines, read from the providers. Apart from
  // the settings so that read does not wait on them.
  defineRoute<void, OfficeUsageStatusRes>({
    opId: "office.getMemberUsageStatus",
    method: "GET",
    path: "/api/office/member-usage-status",
    auth: cap("office:settings", officeSettingsOwner),
    tokenArea: { area: "office", level: "read" },
    emits: [],
  }),
  defineRoute<OfficeSettingsReq, NoContent>({
    opId: "office.setSettings",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PUT",
    path: "/api/office/settings",
    auth: cap("office:settings", officeSettingsOwner),
    tokenArea: { area: "office", level: "write" },
    emits: ["office_settings_updated"],
  }),
  // The office instructions. Their version covers the text only.
  defineRoute<void, InstructionsRes>({
    opId: "office.readInstructions",
    method: "GET",
    path: "/api/office/instructions",
    auth: cap("office:settings", officeSettingsOwner),
    tokenArea: { area: "office", level: "read" },
    emits: [],
  }),
  defineRoute<InstructionsReq, InstructionsRes>({
    opId: "office.setInstructions",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PUT",
    path: "/api/office/instructions",
    auth: cap("office:settings", officeSettingsOwner),
    tokenArea: { area: "office", level: "write" },
    emits: ["office_settings_updated"],
  }),
  defineRoute<ValidateCwdReq, { ok: boolean; error?: string }>({
    opId: "validate.cwd",
    audit: {
      owner: "none",
      reason: "Validates a path without changing state.",
    },
    method: "POST",
    path: "/api/validate/cwd",
    auth: cap("agent:manage", operationalAuthenticated),
    tokenArea: { area: "agentManagement", level: "read" },
    emits: [],
  }),
  defineRoute<
    ValidateEnvReq,
    { ok: boolean; keyCount?: number; error?: string }
  >({
    opId: "validate.env",
    audit: {
      owner: "none",
      reason: "Validates an environment without changing state.",
    },
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
    tokenArea: { area: "agentManagement", level: "read" },
    emits: [],
    preconditions: ["validateEnvBodySelfSubject"],
  }),
  // A POST, not a GET: listing models can start the member's backend and, for
  // OpenCode, load the project config of cwd, so a page on another site must
  // not trigger it (authenticate() checks Origin only on unsafe methods).
  defineRoute<
    { cwd: string; includeHidden?: boolean },
    { models: BackendModelWire[]; error?: string; authError?: boolean }
  >({
    opId: "backends.listModels",
    audit: {
      owner: "none",
      reason: "Listing a backend's models writes no office record.",
    },
    method: "POST",
    path: "/api/backends/:agentType/models",
    auth: cap("agent:manage", operationalAuthenticated),
    tokenArea: { area: "agentManagement", level: "read" },
    emits: [],
  }),

  defineRoute<void, TaskItem[]>({
    opId: "tasks.list",
    method: "GET",
    path: "/api/tasks",
    auth: cap("task:read", operationalAuthenticated),
    tokenArea: { area: "tasks", level: "read" },
    emits: [],
  }),
  defineRoute<void, TaskItem>({
    opId: "tasks.get",
    method: "GET",
    path: "/api/tasks/:id",
    auth: cap("task:read", operationalAuthenticated),
    tokenArea: { area: "tasks", level: "read" },
    emits: [],
  }),
  // Task attribution comes from the caller token, never the request body.
  defineRoute<TaskCreateReq, TaskItem>({
    opId: "tasks.create",
    audit: { owner: "store" },
    method: "POST",
    path: "/api/tasks",
    auth: cap("task:write", operationalAuthenticated),
    tokenArea: { area: "tasks", level: "write" },
    emits: ["tasks"],
  }),
  defineRoute<TaskUpdateReq, TaskItem>({
    opId: "tasks.update",
    audit: { owner: "store" },
    method: "PATCH",
    path: "/api/tasks/:id",
    auth: cap("task:write", operationalAuthenticated),
    tokenArea: { area: "tasks", level: "write" },
    emits: ["tasks"],
  }),
  defineRoute<TaskClaimReq, TaskItem>({
    opId: "tasks.claim",
    audit: { owner: "store" },
    method: "POST",
    path: "/api/tasks/:id/claim",
    auth: cap("task:write", operationalAuthenticated),
    tokenArea: { area: "tasks", level: "write" },
    emits: ["tasks"],
  }),
  defineRoute<void, TaskItem>({
    opId: "tasks.done",
    audit: { owner: "store" },
    method: "POST",
    path: "/api/tasks/:id/done",
    auth: cap("task:write", operationalAuthenticated),
    tokenArea: { area: "tasks", level: "write" },
    emits: ["tasks"],
  }),
  defineRoute<void, NoContent>({
    opId: "tasks.delete",
    audit: { owner: "store" },
    method: "DELETE",
    path: "/api/tasks/:id",
    // taskDelete, not `authenticated`: task:write is one coarse capability, and
    // a cron run holds it only for the create/complete affordance in its prompt.
    auth: cap("task:write", taskDelete),
    tokenArea: { area: "tasks", level: "write" },
    emits: ["tasks"],
  }),

  // The pager (internal-docs/pager-design.md). Source and target come from the
  // raising agent's token; pager:raise is held by agents and apps, and
  // operationalAuthenticated keeps apps on their own routes (pager.appRaise).
  // Reads and the ack/resolve verbs follow room access in the handler, like
  // tasks; an app page is also open to the app owner and office owners.
  defineRoute<{ title: string; body?: string; key?: string }, PagerEntry>({
    opId: "pager.raise",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/pager",
    auth: cap("pager:raise", and(notApp, operationalAuthenticated)),
    tokenArea: { area: "pager", level: "write" },
    emits: ["pager_upserted"],
  }),
  defineRoute<void, PagerEntry[]>({
    opId: "pager.list",
    method: "GET",
    path: "/api/pager",
    auth: cap("pager:read", operationalAuthenticated),
    tokenArea: { area: "pager", level: "read" },
    emits: [],
  }),
  defineRoute<void, PagerEntry>({
    opId: "pager.get",
    method: "GET",
    path: "/api/pager/:id",
    auth: cap("pager:read", operationalAuthenticated),
    tokenArea: { area: "pager", level: "read" },
    emits: [],
  }),
  defineRoute<void, PagerEntry>({
    opId: "pager.ack",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/pager/:id/ack",
    auth: cap("pager:write", operationalAuthenticated),
    tokenArea: { area: "pager", level: "write" },
    emits: ["pager_upserted"],
  }),
  defineRoute<void, PagerEntry>({
    opId: "pager.resolve",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/pager/:id/resolve",
    auth: cap("pager:write", operationalAuthenticated),
    tokenArea: { area: "pager", level: "write" },
    emits: ["pager_upserted"],
  }),

  // The app sign-in mint (server/app-auth.ts): a signed-in member's browser
  // gets a single-use code for one app hostname. Cookie users only.
  defineRoute<void, unknown>({
    opId: "apps.mintSignIn",
    method: "GET",
    path: "/auth/app",
    auth: authn(userScope),
    tokenArea: { area: "apps", level: "write" },
    emits: [],
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
    tokenArea: { area: "apps", level: "read" },
    emits: [],
  }),
  defineRoute<void, AppWidgetStatus>({
    opId: "apps.widget",
    method: "GET",
    path: "/api/apps/:name/widget",
    auth: cap("app:read", memberScope),
    tokenArea: { area: "apps", level: "read" },
    emits: [],
  }),
  // The manifest the app's short-link page links (crossorigin
  // use-credentials, so the member's cookie comes with it).
  defineRoute<void, Uint8Array>({
    opId: "apps.manifest",
    method: "GET",
    path: "/api/apps/:name/manifest",
    auth: cap("app:read", memberScope),
    tokenArea: { area: "apps", level: "read" },
    emits: [],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.get",
    method: "GET",
    path: "/api/apps/:name",
    auth: cap("app:read", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "read" },
    emits: [],
  }),
  // The thumbnail is served to everyone who can see the app, as the list is:
  // operationalAuthenticated here, and the handler checks visibility so that a
  // caller who cannot see the app gets the same 404 as for an unknown name.
  defineRoute<void, Uint8Array>({
    opId: "apps.getThumbnail",
    method: "GET",
    path: "/api/apps/:name/thumbnail",
    auth: cap("app:read", operationalAuthenticated),
    tokenArea: { area: "apps", level: "read" },
    emits: [],
  }),
  // A raw PNG, JPEG or WebP body, or JSON {path} from an agent, so the
  // executor leaves the body to the handler (body: "binary").
  defineRoute<Uint8Array, AppWire>({
    opId: "apps.setThumbnail",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PUT",
    path: "/api/apps/:name/thumbnail",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
    body: "binary",
  }),
  defineRoute<AppRegisterReq, AppWire>({
    opId: "apps.register",
    audit: { owner: "executor", targets: namedResource },
    method: "POST",
    path: "/api/apps",
    // hasOwningUser, not bare `authenticated`: an app must belong to a user, and
    // an agent token can carry a null userId. See the guard for why an ownerless
    // app is worse than a refusal.
    auth: cap("app:write", and(operationalAuthenticated, hasOwningUser)),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
  }),
  // The only mutable fields are command, cwd and description. Name and port are
  // the app's address for as long as it lives, so there is no verb for them
  // anywhere.
  defineRoute<AppUpdateReq, AppWire>({
    opId: "apps.update",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/apps/:name",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
  }),
  defineRoute<void, NoContent>({
    opId: "apps.delete",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/apps/:name",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_deleted"],
  }),
  defineRoute<void, AppLogsRes>({
    opId: "apps.logs",
    method: "GET",
    path: "/api/apps/:name/logs",
    auth: cap("app:read", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  // The recovery verbs. app:write rather than app:read because they change what
  // is running on the box, and an app that has come to rest in `failed` has no
  // other cure than DELETE, which costs it its port and its data directory.
  defineRoute<void, AppWire>({
    opId: "apps.start",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/apps/:name/start",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.stop",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/apps/:name/stop",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.restart",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/apps/:name/restart",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.reload",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/apps/:name/reload",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
  }),
  // One shared flag per app; start and restart clear it.
  defineRoute<void, AppWire>({
    opId: "apps.archive",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/apps/:name/archive",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
  }),
  defineRoute<void, AppWire>({
    opId: "apps.unarchive",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/apps/:name/unarchive",
    auth: cap("app:write", appOwnerOrOfficeOwner("name")),
    tokenArea: { area: "apps", level: "write" },
    emits: ["app_upserted"],
  }),

  // Singular `/api/app` on purpose: everything under /api/apps/:name is the
  // OWNER's management surface, and this is one of the three routes only an
  // app reaches. It carries no :name - the token says which app is speaking.
  // An optional body targetAgentId picks another recipient, for an app with a
  // live owner agent. The whole-table parity test in routes-table.test.ts pins
  // what else an app reaches.
  defineRoute<AppMessageReq, AgentMessageAck>({
    opId: "apps.sendMessage",
    audit: {
      owner: "executor",
      targets: selectedTargets({ result: ["messageId"] }),
    },
    method: "POST",
    path: "/api/app/message",
    // app:message is held by APP scope alone, so the capability already excludes
    // every other caller; appScope is the second, independent fact (see the
    // guard).
    auth: cap("app:message", appScope),
    emits: ["log_entry"],
  }),
  // The app raises and resolves its own pages (internal-docs/pager-design.md),
  // so a health app can page when the agent it would message is down. Source
  // and target come from the token and the registry, as for the message route.
  // pager:raise is also an agent capability, so appScope is what keeps agents
  // off these routes.
  defineRoute<{ title: string; body?: string; key?: string }, PagerEntry>({
    opId: "pager.appRaise",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/app/pager",
    auth: cap("pager:raise", appScope),
    tokenArea: { area: "pager", level: "write" },
    emits: ["pager_upserted"],
  }),
  defineRoute<{ id?: string; key?: string }, PagerEntry>({
    opId: "pager.appResolve",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/app/pager/resolve",
    auth: cap("pager:raise", appScope),
    tokenArea: { area: "pager", level: "write" },
    emits: ["pager_upserted"],
  }),
  // The app opens asks in the name of its message target agent
  // (internal-docs/asks-design.md, "App asks"): the ask is that agent's, and
  // the member's answer goes to it. The app reaches only the asks its own
  // registration opened, wherever its target has moved since.
  defineRoute<AskCreateReq, AskAgentWire>({
    opId: "asks.appCreate",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/app/asks",
    auth: cap("app:ask", appScope),
    plainText: { params: ASK_CREATE_PLAIN_TEXT_PARAMS },
    emits: ["ask_upserted", "others_ask_upserted"],
  }),
  defineRoute<void, AskAgentWire[]>({
    opId: "asks.appList",
    method: "GET",
    path: "/api/app/asks",
    auth: cap("app:ask", appScope),
    emits: [],
  }),
  defineRoute<void, AskAgentWire>({
    opId: "asks.appGet",
    method: "GET",
    path: "/api/app/asks/:askId",
    auth: cap("app:ask", appScope),
    emits: [],
  }),
  defineRoute<AskEditReq, AskAgentWire>({
    opId: "asks.appEdit",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/app/asks/:askId",
    auth: cap("app:ask", appScope),
    plainText: { params: ASK_EDIT_PLAIN_TEXT_PARAMS },
    emits: ["ask_upserted", "others_ask_upserted"],
  }),
  defineRoute<void, NoContent>({
    opId: "asks.appDelete",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/app/asks/:askId",
    auth: cap("app:ask", appScope),
    emits: ["ask_removed", "others_ask_removed"],
  }),

  // Webhooks (internal-docs/webhooks-design.md section 7). Ownership is the
  // USER's, as for apps. The reads (list, get, deliveries, dry-run) follow the
  // hook's room, as for cronjobs, and are checked per caller in the handler
  // (server/webhook-visibility.ts). Writes stay with the owner and office
  // owners. Create and update also check the target against live state
  // (webhookTargetAllowed). Create answers with the secret once, to every
  // creator. The read secret route admits a human session only; the rotate
  // route also admits the agent that made the hook (webhookMakerAgent).
  defineRoute<void, WebhookWire[]>({
    opId: "webhooks.list",
    method: "GET",
    path: "/api/webhooks",
    auth: cap("webhook:read", operationalAuthenticated),
    tokenArea: { area: "webhooks", level: "read" },
    emits: [],
  }),
  defineRoute<void, WebhookWire>({
    opId: "webhooks.get",
    method: "GET",
    path: "/api/webhooks/:id",
    auth: cap("webhook:read", operationalAuthenticated),
    tokenArea: { area: "webhooks", level: "read" },
    emits: [],
  }),
  defineRoute<WebhookCreateReq, WebhookCreateRes>({
    opId: "webhooks.create",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/webhooks",
    auth: cap("webhook:write", and(operationalAuthenticated, hasOwningUser)),
    tokenArea: { area: "webhooks", level: "write" },
    emits: ["webhook_upserted"],
    preconditions: ["webhookTargetAllowed"],
  }),
  defineRoute<WebhookUpdateReq, WebhookWire>({
    opId: "webhooks.update",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/webhooks/:id",
    auth: cap("webhook:write", webhookOwnerOrOfficeOwner("id")),
    tokenArea: { area: "webhooks", level: "write" },
    emits: ["webhook_upserted"],
    preconditions: ["webhookTargetAllowed"],
  }),
  defineRoute<void, NoContent>({
    opId: "webhooks.delete",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/webhooks/:id",
    auth: cap("webhook:write", webhookOwnerOrOfficeOwner("id")),
    tokenArea: { area: "webhooks", level: "write" },
    emits: ["webhook_deleted"],
  }),
  defineRoute<void, WebhookDeliveriesRes>({
    opId: "webhooks.deliveries",
    method: "GET",
    path: "/api/webhooks/:id/deliveries",
    auth: cap("webhook:read", operationalAuthenticated),
    tokenArea: { area: "webhooks", level: "read" },
    emits: [],
  }),
  defineRoute<WebhookDryRunReq, WebhookDryRunRes>({
    opId: "webhooks.dryRun",
    audit: {
      owner: "none",
      reason: "Plans a delivery without dispatch or persistence.",
    },
    method: "POST",
    path: "/api/webhooks/:id/dry-run",
    auth: cap("webhook:read", operationalAuthenticated),
    tokenArea: { area: "webhooks", level: "read" },
    emits: [],
  }),
  defineRoute<void, WebhookSecretRes>({
    opId: "webhooks.readSecret",
    method: "GET",
    path: "/api/webhooks/:id/secret",
    auth: cap("webhook:write", and(userScope, webhookOwnerOrOfficeOwner("id"))),
    tokenArea: { area: "webhooks", level: "write" },
    emits: [],
  }),
  defineRoute<void, WebhookSecretRes>({
    opId: "webhooks.rotateSecret",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/webhooks/:id/secret",
    auth: cap(
      "webhook:write",
      and(
        or(userScope, webhookMakerAgent("id")),
        webhookOwnerOrOfficeOwner("id"),
      ),
    ),
    tokenArea: { area: "webhooks", level: "write" },
    emits: ["webhook_upserted"],
  }),

  // Three verbs: READ (whole file + version), APPEND (one server-stamped line),
  // REPLACE (whole-file overwrite, version-guarded). All scopes; access by scope
  // follows the rooms and is checked in the handler (handlers/memory.ts).
  defineRoute<void, MemoryReadRes>({
    opId: "memory.read",
    method: "GET",
    path: "/api/memory",
    auth: cap("memory:read", operationalAuthenticated),
    tokenArea: { area: "memory", level: "read" },
    emits: [],
  }),
  defineRoute<MemoryCreateReq, MemoryAppendRes>({
    opId: "memory.append",
    audit: { owner: "store" },
    method: "POST",
    path: "/api/memory",
    auth: cap("memory:write", operationalAuthenticated),
    tokenArea: { area: "memory", level: "write" },
    emits: [],
  }),
  defineRoute<MemoryReplaceReq, MemoryWriteRes>({
    opId: "memory.replace",
    audit: { owner: "store" },
    method: "PUT",
    path: "/api/memory",
    auth: cap("memory:write", operationalAuthenticated),
    tokenArea: { area: "memory", level: "write" },
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
    tokenArea: { area: "skills", level: "read" },
    emits: [],
  }),

  // The skills page. Skills are files under the server user's home that every
  // agent on the box runs, so reading the catalog and a listed SKILL.md needs
  // only an operational identity (an agent can read them with its own tools
  // anyway). Saving, deleting and creating change those files, so they take editor:use,
  // the capability behind the editor panel's save. The handlers limit read and
  // mutations to paths the caller's own catalog lists. Mutations re-read the
  // agents' skills; the slash_commands refresh reaches each agent's viewers.
  defineRoute<void, SkillCatalogRes>({
    opId: "skills.catalog",
    method: "GET",
    path: "/api/skills",
    auth: authn(operationalAuthenticated),
    tokenArea: { area: "skills", level: "read" },
    emits: [],
  }),
  defineRoute<void, SkillFileRes>({
    opId: "skills.readFile",
    method: "GET",
    path: "/api/skills/file",
    auth: authn(operationalAuthenticated),
    tokenArea: { area: "skills", level: "read" },
    emits: [],
  }),
  defineRoute<SkillSaveReq, SkillSaveRes>({
    opId: "skills.saveFile",
    audit: { owner: "executor", targets: selectedTargets({ body: ["path"] }) },
    method: "PUT",
    path: "/api/skills/file",
    auth: cap("editor:use", operationalAuthenticated),
    tokenArea: { area: "skills", level: "write" },
    emits: ["slash_commands"],
  }),
  defineRoute<SkillDeleteReq, void>({
    opId: "skills.deleteFile",
    audit: { owner: "executor", targets: selectedTargets({ body: ["path"] }) },
    method: "DELETE",
    path: "/api/skills/file",
    auth: cap("editor:use", operationalAuthenticated),
    tokenArea: { area: "skills", level: "write" },
    emits: ["slash_commands"],
  }),
  defineRoute<SkillCreateReq, SkillFileRes>({
    opId: "skills.create",
    audit: {
      owner: "executor",
      targets: selectedTargets({ result: ["path"] }),
    },
    method: "POST",
    path: "/api/skills",
    auth: cap("editor:use", operationalAuthenticated),
    tokenArea: { area: "skills", level: "write" },
    emits: ["slash_commands"],
  }),

  defineRoute<void, CronjobListWire[]>({
    opId: "cron.list",
    method: "GET",
    path: "/api/cronjobs",
    auth: cap(["cron:read", "cron:own"], operationalAuthenticated),
    tokenArea: { area: "schedules", level: "read" },
    emits: [],
  }),
  defineRoute<void, CronjobListWire>({
    opId: "cron.get",
    method: "GET",
    path: "/api/cronjobs/:id",
    auth: cap(["cron:read", "cron:own"], operationalAuthenticated),
    tokenArea: { area: "schedules", level: "read" },
    emits: [],
  }),
  defineRoute<void, CronjobSystemPromptRes>({
    opId: "cron.readSystemPrompt",
    method: "GET",
    path: "/api/cronjobs/:id/system-prompt",
    auth: cap(["cron:read", "cron:own"], operationalAuthenticated),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  defineRoute<CronCreateReq, CronjobListWire>({
    opId: "cron.create",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/cronjobs",
    auth: cap(
      ["cron:manage", "cron:own"],
      and(notApp, operationalAuthenticated),
    ),
    tokenArea: { area: "schedules", level: "write" },
    emits: ["cronjob_added"],
  }),
  defineRoute<CronUpdateReq, CronjobListWire>({
    opId: "cron.update",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/cronjobs/:id",
    auth: cap(["cron:manage", "cron:own"], cronjobOwnerOrOfficeOwner("id")),
    tokenArea: { area: "schedules", level: "write" },
    emits: ["cronjob_updated"],
  }),
  defineRoute<void, NoContent>({
    opId: "cron.delete",
    audit: { owner: "executor", targets: resourceTargets },
    method: "DELETE",
    path: "/api/cronjobs/:id",
    auth: cap(["cron:manage", "cron:own"], cronjobOwnerOrOfficeOwner("id")),
    tokenArea: { area: "schedules", level: "write" },
    emits: ["cronjob_deleted"],
  }),
  defineRoute<void, { runId: string }>({
    opId: "cron.runNow",
    audit: {
      owner: "executor",
      targets: selectedTargets({ result: ["runId"] }),
    },
    method: "POST",
    path: "/api/cronjobs/:id/runs",
    auth: cap(
      ["cron:manage", "cron:own"],
      and(notApp, cronjobOwnerOrOfficeOwner("id")),
    ),
    tokenArea: { area: "schedules", level: "write" },
    emits: ["cronjob_run_updated"],
  }),
  // The instructions every schedule run gets, off the :id namespace to avoid
  // shadowing /api/cronjobs/:id. The version guards one owner's tab against
  // another's.
  defineRoute<void, InstructionsRes>({
    opId: "cron.readInstructions",
    method: "GET",
    path: "/api/cron-instructions",
    auth: cap("cron:manage", officeOwner),
    tokenArea: { area: "schedules", level: "read" },
    emits: [],
  }),
  defineRoute<InstructionsReq, InstructionsRes>({
    opId: "cron.setInstructions",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PUT",
    path: "/api/cron-instructions",
    auth: cap("cron:manage", officeOwner),
    tokenArea: { area: "schedules", level: "write" },
    emits: ["cronjobs_prompt_updated"],
  }),
  defineRoute<void, { runs: CronjobRun[] }>({
    opId: "cron.listRuns",
    method: "GET",
    path: "/api/cronjobs/:id/runs",
    auth: cap(["cron:read", "cron:own"], operationalAuthenticated),
    tokenArea: { area: "schedules", level: "read" },
    emits: [],
  }),
  defineRoute<void, { jobs: { cronjobId: string; runs: CronjobRun[] }[] }>({
    opId: "cron.listAllRuns",
    method: "GET",
    path: "/api/cron-runs",
    auth: cap(["cron:read", "cron:own"], operationalAuthenticated),
    tokenArea: { area: "schedules", level: "read" },
    emits: [],
  }),
  defineRoute<void, { run: CronjobRun; entries: LogEntry[] }>({
    opId: "cron.getRun",
    method: "GET",
    path: "/api/cronjobs/:id/runs/:runId",
    auth: cap(["cron:read", "cron:own"], operationalAuthenticated),
    tokenArea: { area: "logs", level: "read" },
    emits: [],
  }),
  defineRoute<CronRunMessageReq, MessageAck>({
    opId: "cron.runMessage",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/cronjobs/:id/runs/:runId/messages",
    auth: cap(
      ["cron:manage", "cron:own"],
      and(notApp, cronjobOwnerOrOfficeOwner("id")),
    ),
    tokenArea: { area: "schedules", level: "write" },
    emits: ["cron_run_log_entry"],
  }),
  defineRoute<EditMessageReq, MessageAck>({
    opId: "cron.editRunMessage",
    audit: { owner: "executor", targets: resourceTargets },
    method: "PATCH",
    path: "/api/cronjobs/:id/runs/:runId/messages/:logEntryId",
    auth: cap(
      ["cron:manage", "cron:own"],
      and(notApp, cronjobOwnerOrOfficeOwner("id")),
    ),
    tokenArea: { area: "schedules", level: "write" },
    emits: ["cron_run_log_entry"],
  }),
  defineRoute<AffordanceReadFileReq, OkTrue>({
    opId: "cron.runReadFile",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/cronjobs/:id/runs/:runId/read-file",
    auth: cap("self:affordance", runParamMustEqualTokenRun),
    tokenArea: { area: "files", level: "write" },
    emits: ["cron_run_log_entry"],
  }),
  defineRoute<AffordanceDiffReq, OkTrue>({
    opId: "cron.runDiff",
    audit: { owner: "executor", targets: resourceTargets },
    method: "POST",
    path: "/api/cronjobs/:id/runs/:runId/diff",
    auth: cap("self:affordance", runParamMustEqualTokenRun),
    tokenArea: { area: "files", level: "write" },
    emits: ["cron_run_log_entry"],
  }),

  defineRoute<void, BackupStatusWire>({
    opId: "system.backupStatus",
    method: "GET",
    path: "/api/backup/status",
    auth: cap("office:read", operationalAuthenticated),
    tokenArea: { area: "office", level: "read" },
    emits: [],
  }),
  // How often, how many copies, which folder. Owner-only, like storage.prune.
  defineRoute<BackupSettingsReq, BackupSettingsRes>({
    opId: "system.setBackupSettings",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "PUT",
    path: "/api/backup/settings",
    auth: cap("office:admin", officeOwner),
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
    tokenArea: { area: "office", level: "read" },
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
    tokenArea: { area: "office", level: "read" },
    emits: [],
  }),
  // Structured counterpart to /isomux-usage. The handler derives the audience
  // from the authenticated caller; no query or body field can widen it.
  defineRoute<void, UsageReportWire>({
    opId: "usage.read",
    method: "GET",
    path: "/api/usage",
    auth: cap("office:read", operationalAuthenticated),
    tokenArea: { area: "office", level: "read" },
    emits: [],
  }),
  // Manual prune. Owner-only and DRY RUN unless the body says apply:true; no
  // scheduler ever calls it (server/storage-prune.ts).
  defineRoute<StoragePruneReq, StoragePruneRes>({
    opId: "storage.prune",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "POST",
    path: "/api/storage/prune",
    auth: cap("office:admin", officeOwner),
    emits: [],
  }),
  // Manual lossless compression of old transcripts. Owner-only and DRY RUN
  // unless the body says apply:true (server/storage-compress.ts).
  defineRoute<StorageCompressReq, StorageCompressRes>({
    opId: "storage.compress",
    audit: { owner: "executor", targets: selectedTargets({ fixed: "office" }) },
    method: "POST",
    path: "/api/storage/compress",
    auth: cap("office:admin", officeOwner),
    emits: [],
  }),
];

// Public login / static surface (NOT /api). Represented here as bypass metadata
// so the "no public route reaches authorize()" invariant is testable over one
// table. These stay bespoke origin-checked handlers in production (the
// cookie-minting browser surface); they are never dispatched through authorize().
export const PUBLIC_ROUTES: readonly RouteDef[] = [
  // Browser-only first-frame authentication; never passed to office auth.
  defineRoute({
    opId: "browser.socket",
    method: "GET",
    path: "/browser-extension/ws",
    auth: pub,
    emits: [],
  }),
  defineRoute({
    opId: "auth.loginPage",
    method: "GET",
    path: "/",
    auth: pub,
    emits: [],
  }),
  defineRoute({
    opId: "auth.setupPage",
    method: "GET",
    path: "/setup",
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
  // The public office card (server/office-card.ts): another office reads it
  // before it adds this one as a floor. Answered before the auth wall, with
  // the office name only; rate-limited like /readyz.
  defineRoute({
    opId: "system.officeCard",
    method: "GET",
    path: "/.well-known/isomux-office",
    auth: pub,
    emits: [],
  }),
  // The public webhook delivery route (internal-docs/webhooks-design.md
  // section 1). The signature over the raw body is the only gate; buildServer
  // answers it before the auth wall, on the office host only.
  defineRoute({
    opId: "hooks.deliver",
    method: "POST",
    path: "/hooks/:id",
    auth: pub,
    emits: [],
  }),
];

export const ALL_ROUTES: readonly RouteDef[] = [
  ...API_ROUTES,
  ...PUBLIC_ROUTES,
];
