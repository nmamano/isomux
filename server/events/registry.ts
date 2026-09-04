// Event registry. The single typed registry of every outbound WS
// event. Audience is a FIRST-CLASS attribute of the event TYPE (not of a route),
// because many sensitive events have no owning HTTP route (backend stream,
// terminal IO, presence, scheduler-fired cronjobs, auth expiry, subprocess
// lifecycle). See internal-docs/generic-runtime-refactor.md → "Event registry".
//
// `projectionKey` is EXECUTABLE (the emit
// helper derives the recipient subject from it - server/events/emit.ts), not a
// decorative comment. An event whose audience cannot be computed from its
// declared projectionKey is a bug the registry surfaces.
//
// TARGET union, NOT today's ServerMessage: this is the post-refactor event set.
// Deltas vs the live wire (all intentional, enumerated by the contract test):
//   - tasks_changed (domain) → `tasks` (wire shape)
//   - NEW `cron_run_log_entry` (no current wire member)
//   - office_settings_updated drops `envFile` (owner-only via office.getSettings)
//   - users_list / user_updated carry UserPublicWire, never UserRecord; owners
//     get full records via users_admin_list / user_admin_updated, and the
//     subject gets their own full record via user_self_updated
//   - agent_removed carries `roomId`; agent_updated-move carries old/new room ids
//   - RETIRED (fold into HTTP responses, absent here): the `*_response` family,
//     sessions_list, cronjob_runs(_complete), invite_minted, the *_blocked
//     family, editor_content/editor_open_error, rooms_reordered. `pong` is
//     transport keepalive, not an event.
//
// The emit helper delegates to the projection logic so the live wire stays
// byte-identical.

import type {
  LogEntry,
  AgentInfo,
  AgentChoiceInteraction,
  KilledAgentSummary,
  RoomWire,
  SessionContext,
  PresenceInfo,
  OfficeWire,
  TaskItem,
  AppListWire,
  Cronjob,
  CronjobRun,
  InviteWire,
  SessionWire,
  SkillInfo,
  UpdateStatusWire,
  ProviderAccountWire,
} from "../../shared/types.ts";
import type {
  UserPublicWire,
  UserAdminWire,
  UserSelfWire,
} from "../../shared/contract-shapes.ts";

// The fan-out lattice. The registry currently assigns from {all, owners,
// room-ACL, recipient-scoped}; `by-user` and `none` are reserved (no current
// event uses them) and a contract test pins that - so a future event must
// declare its strategy deliberately rather than inherit a default.
export type AudienceStrategy =
  | "all"
  | "owners"
  | "room-ACL"
  | "recipient-scoped"
  | "by-user"
  | "none";

// The payload/ctx field(s) from which the emit helper computes recipients. Its
// presence is what makes an audience AUDITABLE. `path` is a dotted access into
// the event payload (e.g. ["entry","agentId"]); the emit helper walks it and
// FAILS CLOSED when the declared input is absent - a delete/move event that
// forgot to carry its pre-mutation room id selects NOBODY rather than leaking.
export type ProjectionKey =
  // Office-wide / owners / non-observable - no payload-derived subject.
  | { kind: "all" }
  | { kind: "owners" }
  | { kind: "none" }
  // recipient-scoped: a single socket, keyed by the connectionId in the emit ctx.
  | { kind: "connectionId" }
  // recipient-scoped (by-user flavor): every socket of the userId in the ctx.
  | { kind: "userId" }
  // room-ACL: payload at `path` is a roomId carried in the event (static or
  // delete/relocate events whose live room lookup would be wrong post-mutation).
  | { kind: "carriedRoomId"; path: readonly string[] }
  // room-ACL: payload at `path` is an agentId, resolved to its CURRENT room via
  // deps.roomIdForAgent (live events; the agent still exists in state).
  | { kind: "agentLookup"; path: readonly string[] }
  // room-ACL: payload at `path` is an AgentInfo; its `.id` resolves to its room.
  | { kind: "agentInfoLookup"; path: readonly string[] }
  // room-ACL move: if changes carries BOTH old+new room ids, audience is their
  // union (both must be present - fail closed if only one is); otherwise a
  // non-room update falls back to an agentLookup on `agentPath`.
  | {
      kind: "agentMove";
      agentPath: readonly string[];
      oldPath: readonly string[];
      newPath: readonly string[];
    };

export interface RegistryEvent {
  audience: AudienceStrategy;
  projectionKey: ProjectionKey;
}

// Each maps an event id to the payload an emit caller passes (WITHOUT the `type`
// discriminant - emit stamps that). These are the post-refactor shapes; see the
// deltas note in the file header.
export interface EventPayloads {
  log_entry: { entry: LogEntry };
  // Fence at the end of the connect-time transcript replay. Recipient-scoped
  // rather than room-ACL despite following room-ACL'd log_entry frames: it
  // terminates ONE socket's replay and carries nothing to project.
  log_replay_complete: Record<string, never>;
  // rollback marks a restore-of-prior-timeline clear (failed edit-fork
  // rollback), not a conversation boundary; clients keep the unread dot.
  clear_logs: { agentId: string; rollback?: boolean };
  slash_commands: {
    agentId: string;
    commands: { name: string; description?: string; aliasFor?: string }[];
    skills: SkillInfo[];
  };
  agent_added: { agent: AgentInfo };
  // Carries the pre-removal roomId so the audience is computable after the
  // agent is gone from state. LIVE: the wire event carries it.
  agent_removed: { agentId: string; roomId: string };
  // TARGET: a move sets oldRoomId+newRoomId on `changes` so emit selects the
  // union of both rooms (departing + arriving sessions both refresh).
  agent_updated: {
    agentId: string;
    changes: Partial<AgentInfo> & { oldRoomId?: string; newRoomId?: string };
  };
  interaction_added: { interaction: AgentChoiceInteraction };
  interaction_removed: { interactionId: string; agentId: string };
  killed_agent_added: { agent: KilledAgentSummary };
  killed_agent_removed: { agentId: string; lastRoomId: string };
  terminal_output: { agentId: string; data: string };
  terminal_status: { agentId: string; process: string; shell: boolean };
  terminal_exit: { agentId: string; exitCode: number };
  room_created: { room: RoomWire };
  // pre-close access snapshot: the roomId is carried; the audience is whoever
  // had access before cleanup (snapshot capture is a wiring detail).
  room_closed: { roomId: string };
  room_renamed: { roomId: string; name: string };
  room_settings_updated: { roomId: string; prompt: string | null };

  session_context: { context: SessionContext };
  full_state: {
    agents: AgentInfo[];
    recentCwds: string[];
    office: OfficeWire;
    rooms: RoomWire[];
    killedAgents: KilledAgentSummary[];
    interactions: AgentChoiceInteraction[];
  };
  all_rooms_list: { rooms: RoomWire[] };
  // recipient-scoped per connectionId: each socket gets its OWN dense-remapped
  // payload. emit() sends this once per socket in a loop (deliver() shapes per
  // recipient) - it is NOT a broadcast event, despite reaching many sockets.
  // onlineUserIds (and its derived count totalOnlineUsers) are the same
  // all-audience aggregate for every recipient; only `entries` is projected.
  presence_list: {
    entries: PresenceInfo[];
    totalOnlineUsers: number;
    onlineUserIds: string[];
  };
  editor_external_change: {
    agentId: string;
    path: string;
    mtime: number;
    rev: number;
  };
  editor_file_deleted: { agentId: string; path: string };
  session_expired: Record<string, never>;

  // Office-wide events carry reduced projections only.
  users_list: { users: UserPublicWire[] };
  user_updated: { user: UserPublicWire; prevName?: string };
  // Owners-audience: the FULL admin record (UserAdminWire). SEPARATE ids so the
  // all-audience users_list/user_updated stay UserPublicWire - no recipient-
  // dependent payload behind a single id (cleaner registry audit).
  users_admin_list: { users: UserAdminWire[] };
  user_admin_updated: { user: UserAdminWire; prevName?: string };
  // Recipient-scoped (by userId): the subject's OWN full record (UserSelfWire),
  // delivered to every socket of that user - incl. at connect hydration, since
  // the now-public users_list can no longer carry the caller's own grants/view.
  user_self_updated: { user: UserSelfWire; prevName?: string };
  provider_accounts_updated: { accounts: ProviderAccountWire[] };
  tasks: { tasks: TaskItem[] };
  // One task created/changed and visible to this recipient; one task gone from
  // this recipient's board (deleted, or re-filed out of their rooms). Both are
  // per-recipient decisions - see server/events/task-delta.ts.
  task_upserted: { task: TaskItem };
  task_deleted: { taskId: string };
  // Apps: owner- or creator-room-visible, so per-recipient like task deltas. See
  // server/events/app-delta.ts for the visibility rule and why a recipient who
  // cannot see an app is told nothing rather than sent an empty frame.
  app_upserted: { app: AppListWire };
  app_deleted: { name: string };
  cronjobs_state: { cronjobs: Cronjob[]; cronjobsPrompt: string | null };
  cronjob_added: { cronjob: Cronjob };
  cronjob_updated: { cronjob: Cronjob };
  cronjob_deleted: { id: string };
  cronjobs_prompt_updated: { value: string | null };
  cronjob_run_updated: { run: CronjobRun };
  // NEW. Live cron-run transcript stream; entry.agentId = synthetic
  // `cronrun-<runId>`. Office-wide today (the accepted cron exposure); tightens
  // to cron:read under Follow-up 3. AGENT scope still cannot read STORED
  // transcripts (that read is not in the agent capability set).
  cron_run_log_entry: { entry: LogEntry };
  // TARGET: public office metadata only; `envFile` is owner-only via
  // office.getSettings and never rides this `all` event.
  office_settings_updated: { name: string | null; prompt: string | null };
  update_status: UpdateStatusWire;

  session_revoked: { sessionPrefix: string };
  invite_revoked: { tokenPrefix: string };
  invites_list: { invites: InviteWire[] };
  sessions_active_list: { sessions: SessionWire[] };
}

export type EventId = keyof EventPayloads;

// Exactly the spec's event ids + audiences. `satisfies` pins the value to
// Record<EventId, RegistryEvent> so a missing/extra id fails to COMPILE.
export const EVENT_REGISTRY = {
  log_entry: {
    audience: "room-ACL",
    projectionKey: { kind: "agentLookup", path: ["entry", "agentId"] },
  },
  log_replay_complete: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  clear_logs: {
    audience: "room-ACL",
    projectionKey: { kind: "agentLookup", path: ["agentId"] },
  },
  slash_commands: {
    audience: "room-ACL",
    projectionKey: { kind: "agentLookup", path: ["agentId"] },
  },
  agent_added: {
    audience: "room-ACL",
    projectionKey: { kind: "agentInfoLookup", path: ["agent"] },
  },
  agent_removed: {
    audience: "room-ACL",
    projectionKey: { kind: "carriedRoomId", path: ["roomId"] },
  },
  agent_updated: {
    audience: "room-ACL",
    projectionKey: {
      kind: "agentMove",
      agentPath: ["agentId"],
      oldPath: ["changes", "oldRoomId"],
      newPath: ["changes", "newRoomId"],
    },
  },
  interaction_added: {
    audience: "room-ACL",
    projectionKey: {
      kind: "agentLookup",
      path: ["interaction", "agentId"],
    },
  },
  interaction_removed: {
    audience: "room-ACL",
    projectionKey: { kind: "agentLookup", path: ["agentId"] },
  },
  killed_agent_added: {
    audience: "room-ACL",
    projectionKey: { kind: "carriedRoomId", path: ["agent", "lastRoomId"] },
  },
  killed_agent_removed: {
    audience: "room-ACL",
    projectionKey: { kind: "carriedRoomId", path: ["lastRoomId"] },
  },
  terminal_output: {
    audience: "room-ACL",
    projectionKey: { kind: "agentLookup", path: ["agentId"] },
  },
  terminal_status: {
    audience: "room-ACL",
    projectionKey: { kind: "agentLookup", path: ["agentId"] },
  },
  terminal_exit: {
    audience: "room-ACL",
    projectionKey: { kind: "agentLookup", path: ["agentId"] },
  },
  room_created: {
    audience: "room-ACL",
    projectionKey: { kind: "carriedRoomId", path: ["room", "id"] },
  },
  room_closed: {
    audience: "room-ACL",
    projectionKey: { kind: "carriedRoomId", path: ["roomId"] },
  },
  room_renamed: {
    audience: "room-ACL",
    projectionKey: { kind: "carriedRoomId", path: ["roomId"] },
  },
  room_settings_updated: {
    audience: "room-ACL",
    projectionKey: { kind: "carriedRoomId", path: ["roomId"] },
  },

  session_context: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  full_state: {
    audience: "recipient-scoped",
    projectionKey: { kind: "userId" },
  },
  all_rooms_list: {
    audience: "owners",
    projectionKey: { kind: "owners" },
  },
  presence_list: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  editor_external_change: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  editor_file_deleted: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  session_expired: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },

  users_list: { audience: "all", projectionKey: { kind: "all" } },
  user_updated: { audience: "all", projectionKey: { kind: "all" } },
  users_admin_list: { audience: "owners", projectionKey: { kind: "owners" } },
  user_admin_updated: { audience: "owners", projectionKey: { kind: "owners" } },
  user_self_updated: {
    audience: "recipient-scoped",
    projectionKey: { kind: "userId" },
  },
  provider_accounts_updated: {
    audience: "recipient-scoped",
    projectionKey: { kind: "userId" },
  },
  // Room-scoped board: each socket gets its OWN task list projected to the
  // rooms its user can access (∪ office-global tasks), so this is per-recipient,
  // NOT an all-audience broadcast. Delivered by an explicit per-socket loop
  // (sendTasksTo), same model as presence_list - never a uniform `all` payload.
  // connectionId is the concrete recipient key. `tasks` is HYDRATION only now
  // (connect + room-access change); a mutation rides the two deltas below.
  tasks: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  // Also per-recipient, and for the same reason as `tasks`: one mutation can be
  // an upsert for one socket, a delete for another, and nothing at all for a
  // third. Delivered by pushTaskDeltaToEachWs.
  task_upserted: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  task_deleted: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  // Visibility-scoped board, delivered by an explicit per-socket loop over
  // appDeltaFor. Owner projections may include management fields; creator-room
  // viewers receive launch fields only.
  app_upserted: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  app_deleted: {
    audience: "recipient-scoped",
    projectionKey: { kind: "connectionId" },
  },
  cronjobs_state: { audience: "all", projectionKey: { kind: "all" } },
  cronjob_added: { audience: "all", projectionKey: { kind: "all" } },
  cronjob_updated: { audience: "all", projectionKey: { kind: "all" } },
  cronjob_deleted: { audience: "all", projectionKey: { kind: "all" } },
  cronjobs_prompt_updated: { audience: "all", projectionKey: { kind: "all" } },
  cronjob_run_updated: { audience: "all", projectionKey: { kind: "all" } },
  cron_run_log_entry: { audience: "all", projectionKey: { kind: "all" } },
  office_settings_updated: { audience: "all", projectionKey: { kind: "all" } },
  update_status: { audience: "all", projectionKey: { kind: "all" } },

  session_revoked: { audience: "owners", projectionKey: { kind: "owners" } },
  invite_revoked: { audience: "owners", projectionKey: { kind: "owners" } },
  invites_list: {
    audience: "recipient-scoped",
    projectionKey: { kind: "userId" },
  },
  sessions_active_list: {
    audience: "recipient-scoped",
    projectionKey: { kind: "userId" },
  },
} satisfies Record<EventId, RegistryEvent>;

// Office-wide events are the easiest leak class, so the set is FROZEN and
// reviewed explicitly. A contract test asserts the registry's audience:"all"
// set is exactly this allowlist - adding an `all` event without updating this
// list (a deliberate, reviewed act) fails the test. Each is justified as
// reduced office-wide metadata (no UserRecord/OfficeSettings envFile/access/
// prompt rides an `all` channel). The task board LEFT this class when it became
// room-scoped - it is now per-recipient projected (see the `tasks` entry).
export const ALL_AUDIENCE_ALLOWLIST: ReadonlySet<EventId> = new Set<EventId>([
  "users_list",
  "user_updated",
  "cronjobs_state",
  "cronjob_added",
  "cronjob_updated",
  "cronjob_deleted",
  "cronjobs_prompt_updated",
  "cronjob_run_updated",
  "cron_run_log_entry",
  "office_settings_updated",
  "update_status",
]);

// Enumerates how the TARGET registry differs from today's ServerMessage so
// nobody mistakes this registry for live wire coverage. The contract test reads
// these to assert the delta is exactly as designed.
export const REGISTRY_RENAMED_FROM_WIRE: ReadonlyArray<{
  event: EventId;
  note: string;
}> = [
  { event: "tasks", note: "domain tasks_changed → wire `tasks`" },
  {
    event: "task_upserted",
    note: "NEW; domain tasks_changed → per-recipient delta (was a whole-board `tasks` rebroadcast)",
  },
  {
    event: "task_deleted",
    note: "NEW; domain tasks_changed → per-recipient delta, incl. a re-file out of the recipient's rooms",
  },
  {
    event: "cron_run_log_entry",
    note: "NEW; no current ServerMessage member (live cron-run transcript stream)",
  },
];

// Wire messages that are intentionally NOT registry events (folded into HTTP
// responses, or transport keepalive). The contract test asserts none of these
// leaked into EVENT_REGISTRY.
export const RETIRED_WIRE_MESSAGES: readonly string[] = [
  "sessions_list",
  "editor_content",
  "editor_open_error",
  "editor_save_response",
  "settings_save_response",
  "settings_validation",
  "agent_save_response",
  "cwd_validation",
  "list_backend_models_response",
  "invite_minted",
  "access_settings",
  "access_settings_updated",
  "delete_user_blocked",
  "revoke_blocked",
  "logout_blocked",
  "cronjob_runs",
  "cronjob_runs_complete",
  "rooms_reordered",
  "pong",
];

export function isEventId(id: string): id is EventId {
  return Object.prototype.hasOwnProperty.call(EVENT_REGISTRY, id);
}
