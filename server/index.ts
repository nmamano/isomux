import type { ServerWebSocket } from "bun";
import type {
  ServerMessage,
  ClientCommand,
  BackendModelWire,
  AgentInfo,
  RoomWire,
  NotifRoomsSetting,
  PresenceInfo,
  UserRecord,
} from "../shared/types.ts";
import {
  listAllPresence,
  refreshPresenceForUser,
  removePresence,
  setPresence,
} from "./presence.ts";
import type { AgentEvent } from "./internal-types.ts";
import { runPreUseridBackupIfNeeded } from "./migrations.ts";
import * as AgentManager from "./agent-manager.ts";
import { getBackend } from "./backends/index.ts";
import * as CronjobManager from "./cronjob-manager.ts";
import {
  loadRecentCwds,
  saveRecentCwd,
  getFilePath,
  saveFile,
  loadServerConfig,
} from "./persistence.ts";
import type { Attachment } from "../shared/types.ts";
import {
  startUpdateChecker,
  getUpdateStatus,
  onUpdateChange,
} from "./update-checker.ts";
import { startBackupScheduler, getBackupStatus } from "./backup.ts";
import { logCodexVersionAtBoot } from "./backends/codex/version-check.ts";
import { resolveCwd } from "./cwd-utils.ts";
import type { TaskItem } from "../shared/types.ts";
import {
  CODEX_MODELS,
  isValidStatus,
  isValidPriority,
  type AgentOutfit,
} from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import {
  listUsers,
  getUser,
  getUserById,
  claimUser,
  pruneStaleRoomRefs,
  updateUser,
  updateUserById,
  deleteUser,
  wouldDeleteLeaveNoOwner,
} from "./users.ts";
import { watchFile, stopWatch, type FileWatcher } from "./file-editor.ts";
import { mimeTypeForFilename } from "./mime-types.ts";
import { join } from "path";
import {
  authenticate,
  checkOrigin,
  securityHeaders,
  setOnBootstrapAccepted,
  tryHandleAuthRoute,
} from "./auth-middleware.ts";
import {
  buildPublicOrigin,
  ensureBootstrapInvite,
  evictSessionsForUserId,
  hasUnconsumedBootstrapInvite,
  listActiveSessions,
  listActiveSessionsForUserId,
  listInvites,
  listInvitesForUsername,
  logoutBySessionHash,
  mintInvite,
  readSessionCookie,
  registerSocket,
  resolveSessionHashByPrefix,
  revalidateByHash,
  revokeActiveSessionByPrefixForUserId,
  revokeInviteByPrefix,
  revokeOutstandingInviteByPrefixForUsername,
  revokeSessionByPrefix,
  sessionContextFor,
  setOnInviteConsumed,
  setOnSessionsChanged,
  setPublicOriginFallback,
  setRoomsSnapshotProvider,
  unregisterSocket,
  validateSession,
  wouldRevokeLeaveOfficeUnreachable,
  type SessionLookup,
} from "./auth.ts";
import { lowercaseKey } from "../shared/identity.ts";

// Pre-userid backup must run before any user/session/agent/cronjob state
// touches disk. The state modules above lazy-load (no top-level disk
// reads), so this top-of-body call is in time — but it is fragile to
// future eager-load refactors. Keep this near the top of the module body
// and audit if any imported module starts loading eagerly.
runPreUseridBackupIfNeeded();

// Register the office-config.json `publicOrigin` fallback before any
// auth/origin code runs. Order matters: the local-only-mode log below and
// the bootstrap invite URL both read buildPublicOrigin(); without this
// call, a config-file-written publicOrigin would be ignored on first boot.
setPublicOriginFallback(loadServerConfig().publicOrigin);

// Inject the room snapshot provider auth.ts uses when seeding a new
// owner's allowedRooms at invite-acceptance time. The provider closes
// over AgentManager.getRooms() rather than auth.ts importing
// agent-manager directly — keeps the dependency graph one-way.
setRoomsSnapshotProvider(() => AgentManager.getRooms().map((r) => r.id));

// When an invite is consumed (typically via HTTP POST /auth/accept,
// which never touches the WS dispatch loop), fan out an updated
// invites_list to every owner WS so their Access pane re-renders in
// real time. Without this hook, a browser that minted an invite while a
// *separate* browser opened the /i/ URL would have to reconnect to see
// the consumed invite drop off the Outstanding list.
setOnInviteConsumed(() => {
  pushInvitesListToEachWs();
  pushSessionsListToEachWs();
});

// Owner AccessPane sessions table stays fresh on any server-initiated
// session invalidation: revoke, logout, delete-user fanout, and the
// hot-path expiry / orphan branches in validateByHash. Without this,
// e.g. deleting a member silently leaves their row in the table until
// the owner reloads. Per-WS pushers also keep the member's
// "My devices" sessions table consistent on the same events.
setOnSessionsChanged(() => {
  pushSessionsListToEachWs();
});

// First-install onboarding: pre-spawn one Claude and one Codex welcome agent
// so the new owner can try whichever backend they're set up for. Spawn is
// always allowed (no CLI install check); the other backend surfaces a
// chat-visible error on first message — missing CLI, missing auth, all the
// same UX. Per-spawn try/catch is defense in depth against any unexpected
// throw. Awaited so both agents are in officeState before the redirected
// browser reads `full_state`. Guarded so an owner-recovery on an existing
// office doesn't double-seed.
function welcomeAgentPrompt(agentType: "claude" | "codex"): string {
  const selfName =
    agentType === "claude" ? "Claude Welcome Agent" : "Codex Welcome Agent";
  const selfFamily = agentType === "claude" ? "Claude" : "Codex";
  const otherName =
    agentType === "claude" ? "Codex Welcome Agent" : "Claude Welcome Agent";
  const otherFamily = agentType === "claude" ? "Codex" : "Claude";
  return `You are the ${selfName} in this user's new Isomux office. Isomux is a persistent office of AI agents reachable from any device; each agent lives at a desk in a room with its own chat. New offices come preset with two welcome agents — you (a ${selfFamily} agent) and "${otherName}" (a ${otherFamily} agent). If the user messages you without a specific request, welcome them to the office and offer to walk them through spawning their first agent or to showcase agent-to-agent communication. If they ask for the showcase, check ~/.isomux/agents-summary.json to confirm the other welcome agent is present and then send them a message asking for a message back. Be brief, friendly, and focus on what the user asks. For deeper Isomux questions, use https://github.com/nmamano/isomux/blob/main/README.md or https://isomux.com as references.`;
}

// Fixed outfits so both welcome agents have a recognizable, friendly look on
// every fresh install instead of the random palette new spawns get. Claude =
// blue/glasses, Codex = pink/tie — visually distinct so the user can tell
// them apart at a glance from the desk view.
const CLAUDE_WELCOME_OUTFIT: AgentOutfit = {
  hat: "bow",
  color: "#45B7D1",
  hair: "#6C5CE7",
  hairStyle: "long",
  skin: "#FDEBD0",
  beard: "none",
  accessory: "glasses",
};
const CODEX_WELCOME_OUTFIT: AgentOutfit = {
  hat: "none",
  color: "#E85D75",
  hair: "#E84393",
  hairStyle: "ponytail",
  skin: "#FDEBD0",
  beard: "stubble",
  accessory: "tie",
};

async function spawnWelcomeAgent(
  name: string,
  agentType: "claude" | "codex",
  modelFamily: string,
  permissionMode: "auto" | "on-request",
  outfit: AgentOutfit,
  username: string,
): Promise<void> {
  try {
    const created = await AgentManager.spawn(
      name,
      "~",
      permissionMode,
      undefined,
      welcomeAgentPrompt(agentType),
      undefined,
      outfit,
      modelFamily,
      undefined,
      username,
      agentType,
      undefined,
      undefined,
    );
    if (!created) {
      console.warn(
        `[bootstrap] ${name} spawn returned null (duplicate name or full room?)`,
      );
    }
  } catch (err) {
    console.warn(`[bootstrap] ${name} spawn threw:`, err);
  }
}

setOnBootstrapAccepted(async ({ username }) => {
  if (AgentManager.getAllAgents().length > 0) return;
  await spawnWelcomeAgent(
    "Claude Welcome Agent",
    "claude",
    "opus",
    "auto",
    CLAUDE_WELCOME_OUTFIT,
    username,
  );
  await spawnWelcomeAgent(
    "Codex Welcome Agent",
    "codex",
    CODEX_MODELS[0].value,
    "on-request",
    CODEX_WELCOME_OUTFIT,
    username,
  );
});

// Each WS carries the session it was authenticated with at upgrade time. The
// session reference is used per-message (so revoke kicks in on the next msg)
// and to attribute writes to the right user without trusting client-supplied
// `username` fields. The `connectionId` is a per-WS identifier (NOT per
// auth session) — multiple tabs of the same user share `session.sessionIdHash`
// but get distinct `connectionId`s, so live-avatars presence keyed by
// connectionId gives one ghost per tab (the design contract).
interface WsData {
  session: SessionLookup;
  connectionId: string;
}

let connectionIdCounter = 0;
function nextConnectionId(): string {
  connectionIdCounter++;
  // Timestamp-prefixed counter: unique within a process lifetime even if
  // the same WS hash reconnects rapidly; the counter ticks per upgrade.
  // Not security-sensitive (the auth boundary is the cookie); just needs
  // to be unique across concurrent connections.
  return `c${Date.now().toString(36)}-${connectionIdCounter.toString(36)}`;
}

const browsers = new Set<ServerWebSocket<WsData>>();

// Per-WS editor file watchers. Each open file gets one fs.watch handle keyed
// by `${agentId}\0${absPath}` so the same path can be watched independently
// across agents. Watchers close on editor_close or WS disconnect.
const editorWatchers = new WeakMap<
  ServerWebSocket<WsData>,
  Map<string, FileWatcher>
>();

function editorKey(agentId: string, absPath: string): string {
  return `${agentId}\0${absPath}`;
}

function getWatcherMap(ws: ServerWebSocket<WsData>): Map<string, FileWatcher> {
  let map = editorWatchers.get(ws);
  if (!map) {
    map = new Map();
    editorWatchers.set(ws, map);
  }
  return map;
}

// Owner-scoped fan-out for messages that carry full-office Access state
// (per-prefix events like invite_revoked/session_revoked, and the
// owner-only full invites/sessions lists). Members don't render the
// owner Access pane, but a plain broadcast() would still seed those
// rows into their reducer state — leaking other users' token prefixes,
// usernames, expiry timestamps, and user-agent strings. Routing only
// the owner-WS subset preserves the owner-only design contract.
function broadcastToOwners(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    if (ws.data.session.role === "owner") {
      ws.send(data);
    }
  }
}

// Push an invites_list to every WS using the right scope for the
// receiving session: owners get the full list; members get just the
// invites bound to their own username (driving the member "My devices"
// pane). Used after every mutation that could change either scope.
function pushInvitesListToEachWs() {
  for (const ws of browsers) {
    const s = ws.data.session;
    if (s.role === "owner") {
      ws.send(JSON.stringify({ type: "invites_list", invites: listInvites() }));
    } else {
      const me = getUserById(s.userId);
      const list = me ? listInvitesForUsername(me.name) : [];
      ws.send(JSON.stringify({ type: "invites_list", invites: list }));
    }
  }
}

// Companion to pushInvitesListToEachWs for active sessions. Owners get
// every active session; members get sessions whose userId matches their
// own — the rename-stable filter.
function pushSessionsListToEachWs() {
  for (const ws of browsers) {
    const s = ws.data.session;
    if (s.role === "owner") {
      ws.send(
        JSON.stringify({
          type: "sessions_active_list",
          sessions: listActiveSessions(),
        }),
      );
    } else {
      ws.send(
        JSON.stringify({
          type: "sessions_active_list",
          sessions: listActiveSessionsForUserId(s.userId),
        }),
      );
    }
  }
}

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    ws.send(data);
  }
}

// Build the per-recipient presence_list. Remaps each entry's
// currentRoomId (stored as a global room id) into the recipient's
// dense visible room index via visibleRoomProjection, the same
// projection used for AgentInfo.room. Entries whose room isn't visible
// to the recipient are omitted; off-scene entries (currentRoomId =
// null) are also omitted from the wire per design (UI noise + privacy).
// The recipient's own session is included on the same currentRoomId
// gate; "self hidden in LogView" is a client-local concern.
function buildPresenceListFor(session: SessionLookup): PresenceInfo[] {
  const projection = visibleRoomProjection(session);
  const rooms = AgentManager.getRooms();
  // Pre-index global roomId → global index for O(1) lookup per entry.
  const roomIdToGlobalIdx = new Map<string, number>();
  for (let i = 0; i < rooms.length; i++) {
    roomIdToGlobalIdx.set(rooms[i].id, i);
  }
  const out: PresenceInfo[] = [];
  for (const p of listAllPresence()) {
    if (p.currentRoomId === null) continue;
    const globalIdx = roomIdToGlobalIdx.get(p.currentRoomId);
    if (globalIdx === undefined) continue;
    const visibleIdx = projection.globalToVisible[globalIdx];
    if (visibleIdx === undefined || visibleIdx < 0) continue;
    out.push({
      connectionId: p.connectionId,
      userId: p.userId,
      username: p.username,
      avatarColor: p.avatarColor,
      avatarVariant: p.avatarVariant,
      currentRoom: visibleIdx,
      focusedAgentId: p.focusedAgentId,
      viewMode: p.viewMode,
    });
  }
  // Deterministic order so client renders don't reshuffle on every
  // broadcast. connectionId is per-WS, stable while the connection
  // lives, and reconnects produce a fresh id (replacing the old entry
  // entirely, not reshuffling the existing ones).
  out.sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  return out;
}

function sendPresenceListTo(ws: ServerWebSocket<WsData>) {
  ws.send(
    JSON.stringify({
      type: "presence_list",
      entries: buildPresenceListFor(ws.data.session),
    }),
  );
}

function pushPresenceListToEachWs() {
  for (const ws of browsers) {
    sendPresenceListTo(ws);
  }
}

// ---------------------------------------------------------------------------
// Per-WS room ACL projection
//
// Members can be restricted to a subset of rooms via UserRecord.allowedRooms.
// Owners and members with "all" are not restricted. The wire contract uses
// numeric `room` indices on AgentInfo and on tab-bar order, so when we hide
// rooms from a member we must rewrite those indices into a dense visible
// space. Otherwise the member's UI iterates over a global rooms array with
// holes and `agent.room === currentRoom` checks miss.
//
// Helpers below are the single source of truth for those translations;
// per-WS event routing and the connect-time full_state both go through
// them.

// Visibility is fully encoded in UserRecord.allowedRooms. There is no
// per-room "private" flag and no "all" sentinel — the literal list IS
// the access control. "Private to creator + owners" is an emergent
// behavior of the create_room handler adding the new roomId to those
// users' lists at creation time. Future rooms are added explicitly to
// every owner + the creator.
//
// A session has "full access" when its user's allowedRooms covers
// every current room id — that's the only state where the routing
// fast-path can skip the projection. Owners with a self-imposed
// restriction (allowedRooms missing some room ids) lose full access
// just like restricted members would.
function sessionHasFullRoomAccess(session: SessionLookup): boolean {
  const user = getUserById(session.userId);
  if (!user) return false;
  for (const r of AgentManager.getRooms()) {
    if (!user.allowedRooms.includes(r.id)) return false;
  }
  return true;
}

function roomAllowedForSession(
  session: SessionLookup,
  roomId: string,
): boolean {
  const user = getUserById(session.userId);
  if (!user) return false;
  return user.allowedRooms.includes(roomId);
}

interface VisibleRoomProjection {
  rooms: RoomWire[];
  // global room index → dense visible index, or -1 if hidden for this session
  globalToVisible: number[];
  // dense visible index → global room index
  visibleToGlobal: number[];
}

function visibleRoomProjection(session: SessionLookup): VisibleRoomProjection {
  const all = AgentManager.getRooms();
  if (sessionHasFullRoomAccess(session)) {
    // Identity projection; avoid per-room allocations on the fast path.
    const identity: number[] = all.map((_, i) => i);
    return { rooms: all, globalToVisible: identity, visibleToGlobal: identity };
  }
  const rooms: RoomWire[] = [];
  const globalToVisible: number[] = new Array(all.length).fill(-1);
  const visibleToGlobal: number[] = [];
  for (let i = 0; i < all.length; i++) {
    if (roomAllowedForSession(session, all[i].id)) {
      globalToVisible[i] = rooms.length;
      visibleToGlobal.push(i);
      rooms.push(all[i]);
    }
  }
  return { rooms, globalToVisible, visibleToGlobal };
}

// Returns a fresh AgentInfo with `room` rewritten to the dense visible
// index, or null if the agent's current room isn't visible to this
// session. Callers must never mutate the shared AgentInfo from
// AgentManager — we always shallow-copy.
function projectAgentForSession(
  session: SessionLookup,
  agent: AgentInfo,
  projection?: VisibleRoomProjection,
): AgentInfo | null {
  const proj = projection ?? visibleRoomProjection(session);
  const visible = proj.globalToVisible[agent.room];
  if (visible === undefined || visible < 0) return null;
  if (visible === agent.room) return agent; // identity (full-access fast path)
  return { ...agent, room: visible };
}

// True if a given agentId currently lives in a room visible to this
// session. Looks up the agent's room from AgentManager — caller doesn't
// need to know it. Used by per-agent event routing (log_entry,
// slash_commands, terminal_*) and write-side enforcement.
function agentVisibleForSession(
  session: SessionLookup,
  agentId: string,
): boolean {
  if (sessionHasFullRoomAccess(session)) return true;
  const agent = AgentManager.getAllAgents().find((a) => a.id === agentId);
  if (!agent) return false;
  const rooms = AgentManager.getRooms();
  const roomId = rooms[agent.room]?.id;
  if (!roomId) return false;
  return roomAllowedForSession(session, roomId);
}

// Build and send the full_state payload for a given WS using the session's
// projected room/agent view. Used at connect time and as the targeted
// refresh after any change that could shift this session's visible set
// (allowedRooms changes, agent moves across rooms, room close/rename/
// reorder when explicit-list members are connected). Mid-session callers
// pass replayLogsForVisible=true to also resend cached log entries for
// agents the session can now see; without that flag, newly visible agents
// would render in the UI with no history until the next reload.
function sendProjectedFullState(
  ws: ServerWebSocket<WsData>,
  options?: { replayLogsForVisible?: boolean },
) {
  const session = ws.data.session;
  const proj = visibleRoomProjection(session);
  const agents: AgentInfo[] = [];
  for (const a of AgentManager.getAllAgents()) {
    const projected = projectAgentForSession(session, a, proj);
    if (projected) agents.push(projected);
  }
  ws.send(
    JSON.stringify({
      type: "full_state",
      agents,
      recentCwds: loadRecentCwds(),
      office: AgentManager.getOfficeSettings(),
      rooms: proj.rooms,
    }),
  );
  if (options?.replayLogsForVisible) {
    for (const a of agents) {
      const logs = AgentManager.getAgentLogs(a.id);
      for (const entry of logs) {
        ws.send(JSON.stringify({ type: "log_entry", entry }));
      }
      const cmds = AgentManager.getAgentCommands(a.id);
      if (cmds.commands.length > 0 || cmds.skills.length > 0) {
        ws.send(
          JSON.stringify({
            type: "slash_commands",
            agentId: a.id,
            commands: cmds.commands,
            skills: cmds.skills,
          }),
        );
      }
    }
  }
}

// Push a fresh projected full_state to every WS owned by a specific
// userId. Called after a successful update_user that changed allowedRooms
// — every device that user is connected from gets the new view applied
// without a reconnect. Users whose allowedRooms already covers every
// room get the identity projection, so the call is cheap; we don't
// need to branch on role.
function pushProjectedFullStateForUserId(userId: string) {
  for (const ws of browsers) {
    if (ws.data.session.userId === userId) {
      sendProjectedFullState(ws, { replayLogsForVisible: true });
    }
  }
}

// Push the unfiltered global rooms list to every owner WS. Used after
// any change to the global rooms array so the owner-only admin view
// (currently: the Allowed Rooms editor in UserManagementModal) keeps
// in sync. Owners with an explicit allowedRooms still see only their
// subset in the main UI; this channel is purely for the admin surface
// where they grant/revoke other users' room access. Members never
// receive this — leaking the full room list across visibility lines
// would defeat the per-user ACL.
function pushAllRoomsListToOwners() {
  const data = JSON.stringify({
    type: "all_rooms_list",
    rooms: AgentManager.getRooms(),
  });
  for (const ws of browsers) {
    if (ws.data.session.role === "owner") {
      ws.send(data);
    }
  }
}

// Per-WS dispatch for events that touch a specific room or agent.
// Sessions whose allowedRooms covers every current room id take the
// fast path and receive the event verbatim. Sessions with partial
// coverage get either:
//   - a projected event (rewriting agent.room index), or
//   - a suppressed event (the room/agent isn't visible), or
//   - a fresh projected full_state when the event would have shifted
//     their dense room index (room close/rename/reorder, or agent move
//     across rooms).
//
// The full_state-on-shift approach is heavy-handed but keeps the UI's
// existing positional contract intact. log entries are replayed for
// agents that become newly visible inside the same call.
function routeAgentEvent(event: AgentEvent) {
  for (const ws of browsers) {
    routeAgentEventToWs(ws, event);
  }
}

function routeAgentEventToWs(ws: ServerWebSocket<WsData>, event: AgentEvent) {
  const session = ws.data.session;

  if (sessionHasFullRoomAccess(session)) {
    ws.send(JSON.stringify(event));
    return;
  }

  switch (event.type) {
    case "agent_added": {
      const projected = projectAgentForSession(session, event.agent);
      if (projected) {
        ws.send(JSON.stringify({ type: "agent_added", agent: projected }));
      }
      break;
    }
    case "agent_removed": {
      // Idempotent on the receiver — fine to deliver even if they never
      // saw the agent.
      ws.send(JSON.stringify(event));
      break;
    }
    case "agent_updated": {
      if (event.changes.room !== undefined) {
        // Room move: visibility could be entering, leaving, or staying
        // (with a shifted dense index). Cheapest correct play is a
        // targeted full_state refresh — but the UI's full_state reducer
        // clears logs/slashCommands, so we must replay them for every
        // currently-visible agent or the member loses transcripts.
        sendProjectedFullState(ws, { replayLogsForVisible: true });
      } else if (agentVisibleForSession(session, event.agentId)) {
        // No room index in the change — non-room fields are safe to
        // forward verbatim.
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "room_created": {
      if (roomAllowedForSession(session, event.room.id)) {
        // New room is at the end of the global rooms array → also at
        // the end of this session's visible array. No index shift.
        ws.send(JSON.stringify(event));
      }
      // If the room is not allowed, the member's visible list is
      // unchanged.
      break;
    }
    case "room_closed":
    case "room_renamed":
    case "room_settings_updated": {
      const roomId = event.roomId;
      if (!roomAllowedForSession(session, roomId)) {
        // Room isn't visible — closing/renaming/settings-updating it has
        // no effect on the member's view.
        break;
      }
      // Closing a visible room shifts dense indices below it; rename and
      // settings_updated don't. Cheaper to always refresh than to special-
      // case rename, which would still need a stable currentRoom check.
      // The refresh replays logs/slashCommands for currently-visible
      // agents — full_state clears them in the client reducer, so a bare
      // refresh would wipe every visible transcript.
      if (event.type === "room_closed") {
        sendProjectedFullState(ws, { replayLogsForVisible: true });
      } else {
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "rooms_reordered": {
      // Global order changed; the dense visible projection may have
      // shifted in arbitrary ways. Refresh + replay so the member's
      // transcripts survive the index re-mapping.
      sendProjectedFullState(ws, { replayLogsForVisible: true });
      break;
    }
    case "log_entry": {
      if (agentVisibleForSession(session, event.entry.agentId)) {
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "clear_logs":
    case "slash_commands":
    case "terminal_output":
    case "terminal_exit": {
      if (agentVisibleForSession(session, event.agentId)) {
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "office_settings_updated":
    case "tasks_changed": {
      // No room scope — everyone sees these.
      ws.send(JSON.stringify(event));
      break;
    }
  }
}

// Wire AgentManager events to WebSocket broadcasts
AgentManager.onEvent((event) => {
  // Task mutations carry the full list as a domain event; the wire still
  // uses the legacy `{type:"tasks", tasks}` shape so the UI doesn't change.
  if (event.type === "tasks_changed") {
    broadcast({ type: "tasks", tasks: event.tasks });
    return;
  }
  // Office settings are not room-scoped — same payload for everyone.
  if (event.type === "office_settings_updated") {
    broadcast(event);
    return;
  }
  // All remaining events touch a specific room or agent — route per-WS so
  // restricted members get a projected view (or suppression).
  routeAgentEvent(event);
  // Any mutation of the global rooms list also refreshes the owner-only
  // admin view of all rooms (used by UserManagementModal). Done here
  // (rather than inside routeAgentEvent) so the all_rooms_list message
  // doesn't fan out per-event-type; one shot per mutation.
  if (
    event.type === "room_created" ||
    event.type === "room_closed" ||
    event.type === "room_renamed" ||
    event.type === "rooms_reordered" ||
    event.type === "room_settings_updated"
  ) {
    pushAllRoomsListToOwners();
  }
});

// Wire CronjobManager events to WebSocket broadcasts
CronjobManager.onCronjobEvent((event) => {
  broadcast(event);
});

async function handleCommand(cmd: ClientCommand, ws: ServerWebSocket<WsData>) {
  const session = ws.data.session;
  try {
    await dispatchCommand(cmd, ws, session);
  } catch (err) {
    // Top-level guard for async throws the per-case logic doesn't catch
    // (most relevant: persistence failures from auth mutations). Surface a
    // typed error response when the command carried a requestId so the UI
    // can react; otherwise log so the operator sees the failure.
    const msg = errMessage(err);
    console.error(`[handleCommand] ${cmd.type} failed:`, err);
    surfaceCommandError(cmd, ws, msg);
  }
}

function surfaceCommandError(
  cmd: ClientCommand,
  ws: ServerWebSocket<WsData>,
  errorMsg: string,
): void {
  // Each case maps a failed command to its response shape so the requesting
  // client can stop waiting on a reply that would otherwise never arrive.
  switch (cmd.type) {
    case "mint_invite":
      ws.send(
        JSON.stringify({
          type: "invite_minted",
          requestId: cmd.requestId,
          ok: false,
          error: errorMsg,
        }),
      );
      return;
    case "spawn":
    case "edit_agent":
      if (cmd.requestId) {
        ws.send(
          JSON.stringify({
            type: "agent_save_response",
            requestId: cmd.requestId,
            ok: false,
            error: errorMsg,
          }),
        );
      }
      return;
    case "update_user":
    case "request_settings_validation":
      if (cmd.requestId) {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: false,
            error: errorMsg,
          }),
        );
      }
      return;
    default:
      // Fire-and-forget commands (revoke_*, logout, list_*, send_message,
      // etc.) don't have a response shape we can reach for; we already
      // logged above.
      return;
  }
}

async function dispatchCommand(
  cmd: ClientCommand,
  ws: ServerWebSocket<WsData>,
  session: SessionLookup,
) {
  // The wire still carries `username` on several command types, but the
  // server-side authority is always session.username. Trusting cmd.username
  // would let a member spoof another member's display name on messages.
  switch (cmd.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      break;
    case "presence_update": {
      // Live-avatars: the sender tells us where their ghost should
      // appear. Resolve the dense visible room index they sent through
      // their OWN visibleRoomProjection back to a global room id; an
      // out-of-bounds index or a room that's not in their allowedRooms
      // gets clamped to null (sanitize, don't reject — most common
      // cause is a race with an allowedRooms change). Self user record
      // supplies avatarColor + avatarVariant so the wire payload is
      // self-contained and the recipients don't need to join.
      const user = getUserById(session.userId);
      if (!user) break;
      const projection = visibleRoomProjection(session);
      const rooms = AgentManager.getRooms();
      let roomId: string | null = null;
      if (
        cmd.currentRoom !== null &&
        Number.isInteger(cmd.currentRoom) &&
        cmd.currentRoom >= 0 &&
        cmd.currentRoom < projection.visibleToGlobal.length
      ) {
        const globalIdx = projection.visibleToGlobal[cmd.currentRoom];
        const r = rooms[globalIdx];
        if (r && user.allowedRooms.includes(r.id)) {
          roomId = r.id;
        }
      }
      // Clamp focusedAgentId: must reference a real agent whose room
      // matches the claimed roomId (so a stale cross-room focus claim
      // becomes null server-side instead of degrading to lobby on the
      // recipient). Membership in user.allowedRooms is implicit in the
      // roomId === agentRoomId check, since roomId was already
      // sanitized against allowedRooms above.
      let focusedAgentId: string | null = null;
      if (
        typeof cmd.focusedAgentId === "string" &&
        cmd.focusedAgentId &&
        roomId !== null
      ) {
        const agent = AgentManager.getAllAgents().find(
          (a) => a.id === cmd.focusedAgentId,
        );
        const agentRoomId =
          agent !== undefined ? (rooms[agent.room]?.id ?? null) : null;
        if (agentRoomId === roomId) {
          focusedAgentId = cmd.focusedAgentId;
        }
      }
      const viewMode: "office" | "log" | "away" =
        cmd.viewMode === "log" || cmd.viewMode === "away"
          ? cmd.viewMode
          : "office";
      const changed = setPresence({
        connectionId: ws.data.connectionId,
        userId: session.userId,
        username: user.name,
        avatarColor: user.avatarColor,
        avatarVariant: user.avatarVariant,
        currentRoomId: roomId,
        focusedAgentId,
        viewMode,
        lastSeenAt: Date.now(),
      });
      if (changed) {
        pushPresenceListToEachWs();
      }
      break;
    }
    case "spawn": {
      // ACL gate: spawn target room must be visible to this session.
      // cmd.roomId is optional on the wire — for restricted sessions we
      // can't trust the AgentManager fallback (which lands the agent in
      // global room 0), so resolve to the first visible room and pass
      // that down explicitly. Owners / "all"-access members preserve the
      // legacy behavior of passing undefined through.
      let resolvedRoomId: string | undefined = cmd.roomId;
      if (resolvedRoomId !== undefined) {
        if (!roomAllowedForSession(session, resolvedRoomId)) {
          if (cmd.requestId) {
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: false,
                error: "You don't have access to that room.",
              }),
            );
          }
          break;
        }
      } else if (!sessionHasFullRoomAccess(session)) {
        const visible = visibleRoomProjection(session).rooms;
        if (visible.length === 0) {
          if (cmd.requestId) {
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: false,
                error: "You have no visible rooms in this office.",
              }),
            );
          }
          break;
        }
        resolvedRoomId = visible[0].id;
      }
      try {
        AgentManager.validateCwd(cmd.cwd);
      } catch (err) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Invalid directory"),
            }),
          );
        }
        break;
      }
      saveRecentCwd(cmd.cwd);
      try {
        const created = await AgentManager.spawn(
          cmd.name,
          cmd.cwd,
          cmd.permissionMode,
          cmd.desk,
          cmd.customInstructions,
          resolvedRoomId,
          cmd.outfit,
          cmd.modelFamily,
          cmd.effort,
          session.username,
          cmd.agentType,
          cmd.codexSandbox,
          session.userId,
        );
        if (cmd.requestId) {
          if (created) {
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: true,
              }),
            );
          } else {
            // spawn() returns null on duplicate name or full room — neither
            // throws, so without this branch we'd report ok:true on logical
            // failure and the UI would close the dialog as if it worked.
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: false,
                error:
                  "Cannot create agent: name may be taken or the target room has no free desks.",
              }),
            );
          }
        }
      } catch (err) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Spawn failed"),
            }),
          );
        }
      }
      break;
    }
    case "kill":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      await AgentManager.kill(cmd.agentId);
      break;
    case "abort":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      await AgentManager.abort(cmd.agentId);
      break;
    case "send_message":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      // Don't await — let it stream in the background. Username comes from the
      // session so a member can't spoof another member's display name in chat.
      void AgentManager.sendMessage(
        cmd.agentId,
        cmd.text,
        session.username,
        cmd.device,
        cmd.attachments,
      );
      break;
    case "cancel_queued":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      AgentManager.cancelQueued(cmd.agentId, cmd.messageId);
      break;
    case "send_now":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      void AgentManager.sendNow(cmd.agentId);
      break;
    case "new_conversation":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      await AgentManager.newConversation(cmd.agentId);
      break;
    case "resume":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      await AgentManager.resume(cmd.agentId, cmd.sessionId);
      break;
    case "edit_agent": {
      if (!agentVisibleForSession(session, cmd.agentId)) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: "You don't have access to that agent.",
            }),
          );
        }
        break;
      }
      if (cmd.cwd) {
        try {
          AgentManager.validateCwd(cmd.cwd);
        } catch (err) {
          if (cmd.requestId) {
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: false,
                error: errMessage(err, "Invalid directory"),
              }),
            );
          }
          break;
        }
        saveRecentCwd(cmd.cwd);
      }
      try {
        await AgentManager.editAgent(cmd.agentId, {
          name: cmd.name,
          cwd: cmd.cwd,
          outfit: cmd.outfit,
          customInstructions: cmd.customInstructions,
          modelFamily: cmd.modelFamily,
          effort: cmd.effort,
          permissionMode: cmd.permissionMode,
          codexSandbox: cmd.codexSandbox,
        });
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: true,
            }),
          );
        }
      } catch (err) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Edit failed"),
            }),
          );
        }
      }
      break;
    }
    case "swap_desks":
      if (!roomAllowedForSession(session, cmd.roomId)) break;
      AgentManager.swapDesks(cmd.deskA, cmd.deskB, cmd.roomId);
      break;
    case "set_topic":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      AgentManager.setTopic(cmd.agentId, cmd.topic);
      break;
    case "reset_topic":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      AgentManager.resetTopic(cmd.agentId);
      break;
    case "list_sessions": {
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      const sessions = AgentManager.listSessions(cmd.agentId);
      const currentSessionId = AgentManager.getCurrentSessionId(cmd.agentId);
      // Fan out per-WS, only to sessions that can see this agent.
      // A plain broadcast() would leak session metadata (ids, topics,
      // timestamps) for a hidden agent to every restricted member —
      // even if their UI doesn't render it without the agent row, the
      // payload would still cross the wire to them.
      const data = JSON.stringify({
        type: "sessions_list",
        agentId: cmd.agentId,
        sessions,
        currentSessionId,
      });
      for (const subscriber of browsers) {
        if (agentVisibleForSession(subscriber.data.session, cmd.agentId)) {
          subscriber.send(data);
        }
      }
      break;
    }
    case "terminal_open": {
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      const opened = AgentManager.openTerminal(cmd.agentId);
      if (opened) {
        // Replay buffered output so the browser catches up
        const buffer = AgentManager.getTerminalBuffer(cmd.agentId);
        if (buffer) {
          broadcast({
            type: "terminal_output",
            agentId: cmd.agentId,
            data: buffer,
          });
        }
      }
      break;
    }
    case "terminal_input":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      AgentManager.terminalInput(cmd.agentId, cmd.data);
      break;
    case "terminal_resize":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      AgentManager.terminalResize(cmd.agentId, cmd.cols, cmd.rows);
      break;
    case "terminal_close":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      AgentManager.closeTerminal(cmd.agentId);
      break;
    case "editor_open": {
      if (!agentVisibleForSession(session, cmd.agentId)) {
        ws.send(
          JSON.stringify({
            type: "editor_open_error",
            agentId: cmd.agentId,
            path: cmd.path,
            reason: "io_error",
            message: "agent not found",
          }),
        );
        break;
      }
      const probe = AgentManager.openEditorFile(cmd.agentId, cmd.path);
      if (!probe.ok) {
        ws.send(
          JSON.stringify({
            type: "editor_open_error",
            agentId: cmd.agentId,
            path: cmd.path,
            reason: probe.error === "not_agent" ? "io_error" : "bad_path",
            message:
              probe.error === "not_agent" ? "agent not found" : undefined,
          }),
        );
        break;
      }
      const r = probe.result;
      if (r.kind !== "ok") {
        ws.send(
          JSON.stringify({
            type: "editor_open_error",
            agentId: cmd.agentId,
            path: r.path,
            reason: r.kind,
            message: r.kind === "io_error" ? r.message : undefined,
            size: r.kind === "too_large" ? r.size : undefined,
          }),
        );
        break;
      }
      ws.send(
        JSON.stringify({
          type: "editor_content",
          agentId: cmd.agentId,
          path: r.path,
          content: r.content,
          mtime: r.mtime,
          language: r.language,
          size: r.size,
        }),
      );
      // Install (or replace) the per-WS watcher so external edits surface as
      // `editor_external_change`. Replacing collapses duplicate opens.
      const map = getWatcherMap(ws);
      const key = editorKey(cmd.agentId, r.path);
      const old = map.get(key);
      if (old) stopWatch(old);
      const watcher = watchFile(r.path, cmd.agentId, (mtime) => {
        ws.send(
          JSON.stringify({
            type: "editor_external_change",
            agentId: cmd.agentId,
            path: r.path,
            mtime,
          }),
        );
      });
      if (watcher) map.set(key, watcher);
      break;
    }
    case "editor_save": {
      if (!agentVisibleForSession(session, cmd.agentId)) {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: cmd.path,
            ok: false,
            error: "agent not found",
          }),
        );
        break;
      }
      // Resolve against the agent's cwd in case the client sent a relative
      // path (it shouldn't, but the resolution is cheap and matches open).
      const abs = AgentManager.resolveEditorPathForAgent(cmd.agentId, cmd.path);
      if (!abs) {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: cmd.path,
            ok: false,
            error: "agent not found",
          }),
        );
        break;
      }
      const result = AgentManager.saveEditorFile(
        abs,
        cmd.content,
        cmd.expectedMtime,
        cmd.force ?? false,
      );
      if (result.kind === "ok") {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: result.path,
            ok: true,
            mtime: result.mtime,
          }),
        );
      } else if (result.kind === "stale") {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: result.path,
            ok: false,
            reason: "stale",
            currentMtime: result.currentMtime,
            error: "File changed on disk since you opened it.",
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: result.path,
            ok: false,
            error: result.message,
          }),
        );
      }
      break;
    }
    case "editor_close": {
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      const abs = AgentManager.resolveEditorPathForAgent(cmd.agentId, cmd.path);
      if (!abs) break;
      const map = getWatcherMap(ws);
      const key = editorKey(cmd.agentId, abs);
      const w = map.get(key);
      if (w) {
        stopWatch(w);
        map.delete(key);
      }
      break;
    }
    case "update_office_settings": {
      // Office-wide settings (prompt, envFile, display name) are
      // owner-only. Defense-in-depth: the UI also renders read-only for
      // members, but the server is the authority.
      if (session.role !== "owner") {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: false,
            error: "Only owners can edit office settings.",
          }),
        );
        break;
      }
      const envFile =
        cmd.envFile && cmd.envFile.trim() ? cmd.envFile.trim() : null;
      if (envFile) {
        try {
          AgentManager.validateEnvPath(envFile);
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Invalid env file"),
            }),
          );
          break;
        }
      }
      // Distinguish "field omitted" from "field set to null/empty". A stale
      // client tab from before the name field existed sends no `name`
      // property; treating undefined as null would clear an existing name
      // when the user saves prompt/envFile from that tab. Explicit null or
      // empty string still clears.
      const rawName =
        cmd.name === undefined
          ? AgentManager.getOfficeSettings().name
          : cmd.name && cmd.name.trim()
            ? cmd.name.trim()
            : null;
      if (rawName && rawName.length > 60) {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: false,
            error: "Office name must be 60 characters or fewer",
          }),
        );
        break;
      }
      AgentManager.setOfficeSettings(cmd.prompt, envFile, rawName);
      ws.send(
        JSON.stringify({
          type: "settings_save_response",
          requestId: cmd.requestId,
          ok: true,
        }),
      );
      break;
    }
    case "update_room_settings": {
      if (!roomAllowedForSession(session, cmd.roomId)) {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: false,
            error: "You don't have access to that room.",
          }),
        );
        break;
      }
      const ok = AgentManager.setRoomSettings(cmd.roomId, cmd.prompt);
      if (!ok) {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: false,
            error: "Room not found",
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      }
      break;
    }
    case "request_cwd_validation": {
      try {
        AgentManager.validateCwd(cmd.cwd);
        ws.send(
          JSON.stringify({
            type: "cwd_validation",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "cwd_validation",
            requestId: cmd.requestId,
            ok: false,
            error: errMessage(err, "Invalid directory"),
          }),
        );
      }
      break;
    }
    case "list_backend_models": {
      // Resolves the env file stack the same way a real spawn would, so
      // OPENAI_API_KEY / CHATGPT_LOGIN overrides from office or user files
      // are reflected in the model list. cwd validation is best-effort —
      // codex model/list itself doesn't require the cwd to be a real dir,
      // but we pass the requested cwd through so the subprocess inherits
      // it (matches what'll be used at spawn time).
      try {
        const backend = getBackend(cmd.agentType);
        const env = AgentManager.buildEnvForUserId(session.userId);
        const models = await backend.listModels({
          // The codex subprocess's cwd must be a real directory or posix_spawn
          // fails with ENOENT before our error path can clean up — resolve `~`
          // here the same way AgentManager.spawn does before persisting.
          cwd: resolveCwd(cmd.cwd),
          env,
          includeHidden: cmd.includeHidden,
        });
        const wire: BackendModelWire[] = models.map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description,
          isDefault: m.isDefault,
          hidden: m.hidden,
          supportedEfforts: m.supportedEfforts,
          defaultEffort: m.defaultEffort,
        }));
        ws.send(
          JSON.stringify({
            type: "list_backend_models_response",
            requestId: cmd.requestId,
            ok: true,
            models: wire,
          }),
        );
      } catch (err) {
        const message = errMessage(err);
        // Auth-error flag lets the UI render a login-instructions message
        // instead of a generic "failed to load" — same pattern the
        // orchestrator uses for in-session auth detection.
        const authError = (() => {
          try {
            return getBackend(cmd.agentType).detectAuthError(message);
          } catch {
            return false;
          }
        })();
        ws.send(
          JSON.stringify({
            type: "list_backend_models_response",
            requestId: cmd.requestId,
            ok: false,
            error: message,
            authError,
          }),
        );
      }
      break;
    }
    case "request_settings_validation": {
      // Members can only validate their own envFile. Owners can validate any
      // user's envFile and the office envFile.
      if (cmd.scope === "office" && session.role !== "owner") {
        ws.send(
          JSON.stringify({
            type: "settings_validation",
            requestId: cmd.requestId,
            scope: cmd.scope,
            username: cmd.username,
            envFile: null,
            ok: false,
            error: "Only the office owner can validate office settings.",
          }),
        );
        break;
      }
      if (
        cmd.scope === "user" &&
        cmd.username &&
        lowercaseKey(cmd.username) !== lowercaseKey(session.username) &&
        session.role !== "owner"
      ) {
        ws.send(
          JSON.stringify({
            type: "settings_validation",
            requestId: cmd.requestId,
            scope: cmd.scope,
            username: cmd.username,
            envFile: null,
            ok: false,
            error: "Only the office owner can validate another user's env.",
          }),
        );
        break;
      }
      let envFile: string | null = null;
      if (cmd.scope === "office") {
        envFile = AgentManager.getOfficeSettings().envFile;
      } else if (cmd.scope === "user" && cmd.username) {
        envFile = getUser(cmd.username)?.envFile ?? null;
      }
      if (!envFile) {
        ws.send(
          JSON.stringify({
            type: "settings_validation",
            requestId: cmd.requestId,
            scope: cmd.scope,
            username: cmd.username,
            envFile: null,
            ok: true,
          }),
        );
        break;
      }
      try {
        const keyCount = AgentManager.validateEnvPath(envFile);
        ws.send(
          JSON.stringify({
            type: "settings_validation",
            requestId: cmd.requestId,
            scope: cmd.scope,
            username: cmd.username,
            envFile,
            ok: true,
            keyCount,
          }),
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "settings_validation",
            requestId: cmd.requestId,
            scope: cmd.scope,
            username: cmd.username,
            envFile,
            ok: false,
            error: errMessage(err, "Invalid env file"),
          }),
        );
      }
      break;
    }
    case "add_task": {
      AgentManager.addTask(cmd.title, session.username, {
        description: cmd.description,
        priority:
          cmd.priority && isValidPriority(cmd.priority)
            ? cmd.priority
            : undefined,
        assignee: cmd.assignee,
        username: session.username,
      });
      break;
    }
    case "update_task": {
      const c = cmd.changes;
      const changes: Partial<
        Pick<
          TaskItem,
          "title" | "description" | "priority" | "status" | "assignee"
        >
      > = {};
      if (c.title !== undefined) changes.title = String(c.title);
      if (c.description !== undefined)
        changes.description = c.description ? String(c.description) : undefined;
      if (c.assignee !== undefined)
        changes.assignee = c.assignee ? String(c.assignee) : undefined;
      if (c.status !== undefined && isValidStatus(c.status))
        changes.status = c.status;
      if (c.priority !== undefined && isValidPriority(c.priority))
        changes.priority = c.priority;
      AgentManager.updateTask(cmd.id, changes);
      break;
    }
    case "delete_task": {
      AgentManager.deleteTask(cmd.id);
      break;
    }
    case "create_room": {
      // Anyone can create rooms. Access control is the literal
      // allowedRooms list — no per-room flag, no sentinel. The handler
      // seeds the right users explicitly:
      //   - The creator (sees their own creation).
      //   - Every current owner (owners always see every room; the
      //     model materializes that invariant on every room creation
      //     rather than encoding it in a sentinel).
      // Members other than the creator are NOT auto-added; they
      // become visible only when an owner grants them via the Allowed
      // Rooms editor.
      const newRoomId = AgentManager.createRoom(cmd.name);
      const usersToUpdate: UserRecord[] = [];
      const seen = new Set<string>();
      const creator = getUserById(session.userId);
      if (creator) {
        usersToUpdate.push(creator);
        seen.add(creator.id);
      }
      for (const u of listUsers()) {
        if (u.role === "owner" && !seen.has(u.id)) {
          usersToUpdate.push(u);
          seen.add(u.id);
        }
      }
      let anyUpdate = false;
      for (const u of usersToUpdate) {
        if (u.allowedRooms.includes(newRoomId)) continue;
        // Mirror auto-add on notifRooms so the prune invariant holds:
        // a user's notif list always tracks the rooms they can see.
        // No-op when the room is somehow already present.
        const notifPatch: { notifRooms?: NotifRoomsSetting } = {};
        if (!u.notifRooms.includes(newRoomId)) {
          notifPatch.notifRooms = [...u.notifRooms, newRoomId];
        }
        const result = updateUserById(u.id, {
          allowedRooms: [...u.allowedRooms, newRoomId],
          ...notifPatch,
        });
        if (result.ok) {
          broadcast({ type: "user_updated", user: result.user });
          // The `room_created` event was already filtered out for this
          // user's WSes at fan-out time (their allowedRooms didn't
          // include the new id yet). A projected full_state catches
          // them up; logs/slashCommands are replayed for visible
          // agents inside the helper.
          pushProjectedFullStateForUserId(u.id);
          anyUpdate = true;
        }
      }
      if (anyUpdate) {
        broadcast({ type: "users_list", users: listUsers() });
      }
      break;
    }
    case "close_room": {
      if (!roomAllowedForSession(session, cmd.roomId)) break;
      const closed = AgentManager.closeRoom(cmd.roomId);
      if (closed) {
        // Strip the closed roomId from every user's allowedRooms /
        // notifRooms so stale references don't accumulate. Without
        // this the User Settings summary will keep counting closed
        // rooms, and any future close_room/create_room sequence
        // could grow the on-disk lists indefinitely.
        let touched = false;
        for (const u of listUsers()) {
          const inAllowed = u.allowedRooms.includes(cmd.roomId);
          const inNotif = u.notifRooms.includes(cmd.roomId);
          if (!inAllowed && !inNotif) continue;
          const changes: { allowedRooms?: string[]; notifRooms?: string[] } =
            {};
          if (inAllowed) {
            changes.allowedRooms = u.allowedRooms.filter(
              (id) => id !== cmd.roomId,
            );
          }
          if (inNotif) {
            changes.notifRooms = u.notifRooms.filter((id) => id !== cmd.roomId);
          }
          const r = updateUserById(u.id, changes);
          if (r.ok) {
            broadcast({ type: "user_updated", user: r.user });
            touched = true;
          }
        }
        if (touched) {
          broadcast({ type: "users_list", users: listUsers() });
        }
      }
      break;
    }
    case "rename_room":
      if (!roomAllowedForSession(session, cmd.roomId)) break;
      AgentManager.renameRoom(cmd.roomId, cmd.name);
      break;
    case "move_agent": {
      // Source and target rooms must both be visible to the session.
      // agentVisibleForSession looks up the agent's current global room.
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      if (!roomAllowedForSession(session, cmd.targetRoomId)) break;
      AgentManager.moveAgent(cmd.agentId, cmd.targetRoomId);
      break;
    }
    case "reorder_rooms":
      // Reorder shapes the office's global room order. Sessions whose
      // allowedRooms doesn't cover every current room see only a slice
      // of the office and can't author a coherent reorder of the
      // global list. sessionHasFullRoomAccess encodes that test.
      if (!sessionHasFullRoomAccess(session)) break;
      AgentManager.reorderRooms(cmd.order);
      break;
    case "edit_message":
      if (!agentVisibleForSession(session, cmd.agentId)) break;
      // Don't await — let it stream in the background (like send_message)
      void AgentManager.editMessage(
        cmd.agentId,
        cmd.logEntryId,
        cmd.newText,
        session.username,
        cmd.device,
      );
      break;
    case "add_cronjob": {
      try {
        AgentManager.validateCwd(cmd.cwd);
      } catch (err) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Invalid directory"),
            }),
          );
        }
        break;
      }
      saveRecentCwd(cmd.cwd);
      CronjobManager.addCronjob({
        name: cmd.name,
        schedule: cmd.schedule,
        prompt: cmd.prompt,
        cwd: cmd.cwd,
        agentType: cmd.agentType ?? "claude",
        modelFamily: cmd.modelFamily,
        effort: cmd.effort,
        permissionMode: cmd.permissionMode,
        codexSandbox: cmd.codexSandbox,
        username: session.username,
        userId: session.userId,
      });
      if (cmd.requestId) {
        ws.send(
          JSON.stringify({
            type: "agent_save_response",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      }
      break;
    }
    case "update_cronjob": {
      if (cmd.changes.cwd) {
        try {
          AgentManager.validateCwd(cmd.changes.cwd);
        } catch (err) {
          if (cmd.requestId) {
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: false,
                error: errMessage(err, "Invalid directory"),
              }),
            );
          }
          break;
        }
        saveRecentCwd(cmd.changes.cwd);
      }
      CronjobManager.updateCronjob(cmd.id, cmd.changes);
      if (cmd.requestId) {
        ws.send(
          JSON.stringify({
            type: "agent_save_response",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      }
      break;
    }
    case "delete_cronjob":
      CronjobManager.deleteCronjob(cmd.id);
      break;
    case "run_cronjob_now":
      CronjobManager.runCronjobNow(cmd.id, session.username);
      break;
    case "update_cronjobs_prompt":
      CronjobManager.setCronjobsPrompt(cmd.value);
      ws.send(
        JSON.stringify({
          type: "settings_save_response",
          requestId: cmd.requestId,
          ok: true,
        }),
      );
      break;
    case "list_cronjob_runs": {
      const runs = CronjobManager.getRunsForCronjob(cmd.cronjobId);
      ws.send(
        JSON.stringify({
          type: "cronjob_runs",
          cronjobId: cmd.cronjobId,
          runs,
        }),
      );
      break;
    }
    case "list_all_cronjob_runs": {
      // Returns runs for every cronjob dir on disk (including deleted ones)
      // so the Runs tab can surface historical runs after a cronjob is gone.
      for (const { jobId, runs } of CronjobManager.getAllRunsByJob()) {
        ws.send(
          JSON.stringify({
            type: "cronjob_runs",
            cronjobId: jobId,
            runs,
          }),
        );
      }
      // Sentinel so the client can flip its "runs loaded" flag even when no
      // cronjob has ever fired (no run dirs on disk = zero cronjob_runs sent).
      ws.send(JSON.stringify({ type: "cronjob_runs_complete" }));
      break;
    }
    case "load_cronjob_run": {
      // Client passes jobId from the run row it just clicked, so no scan
      // needed. Works for runs from deleted cronjobs too: getRunTranscript
      // reads from disk regardless of whether the cronjob config still exists.
      const { entries } = CronjobManager.getRunTranscript(
        cmd.cronjobId,
        cmd.runId,
      );
      for (const entry of entries) {
        ws.send(JSON.stringify({ type: "log_entry", entry }));
      }
      break;
    }
    case "send_cronjob_run_message":
      // Don't await — let it stream in the background (matches send_message).
      void CronjobManager.sendRunMessage(
        cmd.cronjobId,
        cmd.runId,
        cmd.text,
        session.username,
        cmd.device,
      );
      break;
    case "edit_cronjob_run_message":
      // Don't await — let it stream in the background (matches edit_message).
      void CronjobManager.editRunMessage(
        cmd.cronjobId,
        cmd.runId,
        cmd.logEntryId,
        cmd.newText,
        session.username,
        cmd.device,
      );
      break;
    case "claim_user": {
      // Post-auth, the session cookie is authoritative for username.
      // claim_user becomes a preferences-update path. Reject mismatched
      // usernames so a client can't reach for someone else's record.
      if (lowercaseKey(cmd.username) !== lowercaseKey(session.username)) {
        break;
      }
      const user = claimUser(session.username, {
        defaultRoomId: cmd.defaultRoomId,
        notifRooms: cmd.notifRooms,
      });
      broadcast({ type: "user_updated", user });
      broadcast({ type: "users_list", users: listUsers() });
      break;
    }
    case "update_user": {
      // Members can edit only their own record. Owners can edit any user's
      // preferences but cannot change the `role` field through this path
      // (role changes go through an admin/CLI path, not in V1).
      const targetIsSelf =
        lowercaseKey(cmd.username) === lowercaseKey(session.username);
      if (!targetIsSelf && session.role !== "owner") {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: "Only the office owner can edit other users.",
            }),
          );
        }
        break;
      }
      // Field-level gate: only owners can mutate allowedRooms, even on
      // self-edit. Without this a member could send
      // `changes.allowedRooms = "all"` and grant themselves full access.
      if (cmd.changes.allowedRooms !== undefined && session.role !== "owner") {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: "Only owners can change room access.",
            }),
          );
        }
        break;
      }
      // Validate envFile if present.
      if (cmd.changes.envFile && cmd.changes.envFile.trim()) {
        try {
          AgentManager.validateEnvPath(cmd.changes.envFile.trim());
        } catch (err) {
          if (cmd.requestId) {
            ws.send(
              JSON.stringify({
                type: "settings_save_response",
                requestId: cmd.requestId,
                ok: false,
                error: errMessage(err, "Invalid env file"),
              }),
            );
          }
          break;
        }
      }
      // Runtime-validate allowedRooms + notifRooms shapes on the wire.
      // Both are now strict string[]; a stale tab from before either
      // refactor could still send the legacy "all" sentinel, and
      // treating a string as a string[] in the auto-prune logic below
      // would expand it to per-char garbage. Reject malformed values
      // explicitly so the user sees an error rather than silently
      // corrupting their record.
      const effectiveChanges = { ...cmd.changes };
      const isStringArray = (v: unknown): boolean =>
        Array.isArray(v) && v.every((x) => typeof x === "string");
      if (
        effectiveChanges.allowedRooms !== undefined &&
        !isStringArray(effectiveChanges.allowedRooms)
      ) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error:
                "Invalid allowedRooms (must be an array of room ids). Reload the page and retry.",
            }),
          );
        }
        break;
      }
      if (
        effectiveChanges.notifRooms !== undefined &&
        !isStringArray(effectiveChanges.notifRooms)
      ) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error:
                "Invalid notifRooms (must be an array of room ids). Reload the page and retry.",
            }),
          );
        }
        break;
      }
      // Enforce notifRooms ⊆ allowedRooms whenever either field is in
      // the change set. A room you can't see can't deliver
      // notifications, so the two settings can't disagree without
      // leaving dead entries in users.json. Runs even when only
      // notifRooms is being updated, so a stale or crafted client
      // can't drift the invariant past this handler. Computed once
      // so a single updateUser call applies both atomically and the
      // user_updated broadcast picks up the consistent shape.
      if (
        effectiveChanges.allowedRooms !== undefined ||
        effectiveChanges.notifRooms !== undefined
      ) {
        const targetUser = getUser(cmd.username);
        const newAllowed =
          effectiveChanges.allowedRooms ?? targetUser?.allowedRooms ?? [];
        const baselineNotif =
          effectiveChanges.notifRooms ?? targetUser?.notifRooms ?? [];
        effectiveChanges.notifRooms = baselineNotif.filter((id) =>
          newAllowed.includes(id),
        );
      }
      const result = updateUser(cmd.username, effectiveChanges);
      if (!result.ok) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: result.error,
            }),
          );
        }
        break;
      }
      if (cmd.requestId) {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      }
      // Tell the client the old key when a re-key rename happened, so it can
      // drop the stale entry from its keyed map without waiting for the
      // follow-up users_list rebroadcast.
      const renamed =
        cmd.username.toLowerCase() !== result.user.name.toLowerCase();
      broadcast({
        type: "user_updated",
        user: result.user,
        ...(renamed ? { prevName: cmd.username } : {}),
      });
      broadcast({ type: "users_list", users: listUsers() });
      // If the owner changed this user's allowedRooms, push a fresh
      // projected full_state (with log replay) to every WS that user is
      // connected from — their visible rooms/agents and conversation
      // history reflect the new access without a reload.
      if (cmd.changes.allowedRooms !== undefined) {
        pushProjectedFullStateForUserId(result.user.id);
      }
      // Live-avatars: keep denormalized presence fields (display name,
      // avatarColor, avatarVariant) in sync, and sanitize currentRoomId
      // against any new allowedRooms. Rebroadcast only if anything
      // actually changed; common case (name-only edit on a user with no
      // active ghost) is a no-op.
      const allowedSet =
        cmd.changes.allowedRooms !== undefined
          ? new Set(result.user.allowedRooms)
          : undefined;
      const presenceTouched = refreshPresenceForUser(
        result.user.id,
        {
          name: result.user.name,
          avatarColor: result.user.avatarColor,
          avatarVariant: result.user.avatarVariant,
        },
        allowedSet,
      );
      if (presenceTouched) {
        pushPresenceListToEachWs();
      }
      break;
    }
    case "delete_user": {
      // Owners can delete any user (except themselves; deleting your own
      // owner record while it's the only owner would brick the office).
      // Members can delete only their own record.
      //
      // Every refusal path emits delete_user_blocked so the client can
      // surface a reason and clear its pending state. Silent breaks here
      // would hang the panel (handleDelete waits for either blocked or
      // users_list-with-target-absent before clearing pendingDeleteReqRef).
      const targetIsSelf =
        lowercaseKey(cmd.username) === lowercaseKey(session.username);
      if (!targetIsSelf && session.role !== "owner") {
        ws.send(
          JSON.stringify({
            type: "delete_user_blocked",
            requestId: cmd.requestId,
            username: cmd.username,
            reason: "Refused: only owners can delete other users.",
          }),
        );
        break;
      }
      if (targetIsSelf && session.role === "owner") {
        // Refuse to let the current session erase its own owner record. If
        // the boss wants to transfer ownership they'll go through the (V2)
        // role-change flow.
        ws.send(
          JSON.stringify({
            type: "delete_user_blocked",
            requestId: cmd.requestId,
            username: cmd.username,
            reason:
              "Refused: an owner can't delete their own user record. " +
              "Sign out from this session or transfer ownership first.",
          }),
        );
        break;
      }
      // Lockout-prevention: refuse deletion that would leave the office
      // without any owner record on disk. Without this, deleting the last
      // owner brings the office to a state where hasOwner() stays true on
      // restart (well, would be false here, but the deletion itself
      // already finished). Defense in depth: same invariant as the
      // session-revoke check, applied to user records.
      const targetUser = getUser(cmd.username);
      if (targetUser && wouldDeleteLeaveNoOwner(targetUser.id)) {
        console.warn(
          `[auth] delete_user "${cmd.username}" refused: would leave office with no owners`,
        );
        ws.send(
          JSON.stringify({
            type: "delete_user_blocked",
            requestId: cmd.requestId,
            username: cmd.username,
            reason:
              "Refused: this is the last owner record. Promote another " +
              "user to owner first, then retry.",
          }),
        );
        break;
      }
      // deleteUser is a no-op when the username doesn't exist; the
      // broadcast below still fires so the client's users_list-watcher
      // sees the target absent and resolves the pending delete cleanly.
      deleteUser(cmd.username);
      broadcast({ type: "users_list", users: listUsers() });
      // Evict any sessions the deleted user still had open: their
      // browsers get session_expired + close so they land on the login
      // wall instead of looping reconnect against a now-orphaned cookie.
      // Covers both self-delete (member) and owner-deletes-member; the
      // owner-deletes-self path was already refused above.
      if (targetUser) {
        await evictSessionsForUserId(targetUser.id);
      }
      break;
    }
    case "mint_invite": {
      if (session.role !== "owner") {
        ws.send(
          JSON.stringify({
            type: "invite_minted",
            requestId: cmd.requestId,
            ok: false,
            error:
              "Only owners can mint invites. Use mint_self_invite to add another of your own devices.",
          }),
        );
        break;
      }
      const r = await mintInvite({
        username: cmd.username,
        role: cmd.role,
        createdBy: session.username,
        allowExisting: !!cmd.allowExisting,
      });
      if (!r.ok) {
        ws.send(
          JSON.stringify({
            type: "invite_minted",
            requestId: cmd.requestId,
            ok: false,
            error: r.error,
          }),
        );
        break;
      }
      const { origin } = buildPublicOrigin();
      const url = `${origin}/i/${r.rawToken}`;
      ws.send(
        JSON.stringify({
          type: "invite_minted",
          requestId: cmd.requestId,
          ok: true,
          url,
          invite: {
            tokenPrefix: r.invite.tokenPrefix,
            username: r.invite.username,
            role: r.invite.role,
            createdBy: r.invite.createdBy,
            createdAt: r.invite.createdAt,
            expiresAt: r.invite.expiresAt,
          },
        }),
      );
      // Owner-issued invites can land in a member's "My devices" pane
      // when they're bound to that member's name (the existing
      // "additional invite for this identity" flow), so push scoped
      // lists to every WS rather than only owners.
      pushInvitesListToEachWs();
      break;
    }
    case "mint_self_invite": {
      // Tailscale-style "additional device" flow. The command carries
      // no overridable knobs — the server binds the invite to the
      // caller's own user record (via stable session.userId, so a
      // rename mid-flow doesn't matter), mirrors the caller's current
      // role (members mint member invites, owners mint owner invites),
      // and uses the tighter self-invite TTL (SELF_INVITE_TTL_MS in
      // auth.ts — currently 1h; the legitimate flow is "both devices
      // are with me, click it now"). replacePriorForUsername enforces
      // the 1-outstanding-per-user rule atomically AND is the marker
      // mintInvite uses to pick the self-invite TTL. Available to any
      // authenticated session — members reach this from the My
      // devices pane; owners could surface a quick-add path on top of
      // the same handler.
      const me = getUserById(session.userId);
      if (!me) {
        ws.send(
          JSON.stringify({
            type: "invite_minted",
            requestId: cmd.requestId,
            ok: false,
            error: "Your user record is missing; reload and try again.",
          }),
        );
        break;
      }
      const r = await mintInvite({
        username: me.name,
        role: me.role === "owner" ? "owner" : "member",
        createdBy: session.username,
        allowExisting: true,
        replacePriorForUsername: true,
      });
      if (!r.ok) {
        ws.send(
          JSON.stringify({
            type: "invite_minted",
            requestId: cmd.requestId,
            ok: false,
            error: r.error,
          }),
        );
        break;
      }
      const { origin } = buildPublicOrigin();
      const url = `${origin}/i/${r.rawToken}`;
      ws.send(
        JSON.stringify({
          type: "invite_minted",
          requestId: cmd.requestId,
          ok: true,
          url,
          invite: {
            tokenPrefix: r.invite.tokenPrefix,
            username: r.invite.username,
            role: r.invite.role,
            createdBy: r.invite.createdBy,
            createdAt: r.invite.createdAt,
            expiresAt: r.invite.expiresAt,
          },
        }),
      );
      pushInvitesListToEachWs();
      break;
    }
    case "list_invites": {
      if (session.role === "owner") {
        ws.send(
          JSON.stringify({ type: "invites_list", invites: listInvites() }),
        );
      } else {
        const me = getUserById(session.userId);
        const list = me ? listInvitesForUsername(me.name) : [];
        ws.send(JSON.stringify({ type: "invites_list", invites: list }));
      }
      break;
    }
    case "revoke_invite": {
      // Owners use the unrestricted revoker; members route through the
      // scoped mutator so authorization and the state change happen in
      // a single mutate() — no TOCTOU window between "is this mine?"
      // and "delete it". A unique prefix that isn't theirs returns
      // "not_found" silently so we don't reveal the foreign row's
      // existence.
      let result: "ok" | "not_found" | "ambiguous";
      if (session.role === "owner") {
        result = await revokeInviteByPrefix(cmd.tokenPrefix);
      } else {
        const me = getUserById(session.userId);
        if (!me) break;
        result = await revokeOutstandingInviteByPrefixForUsername(
          cmd.tokenPrefix,
          me.name,
        );
      }
      if (result === "ok") {
        broadcastToOwners({
          type: "invite_revoked",
          tokenPrefix: cmd.tokenPrefix,
        });
        pushInvitesListToEachWs();
      } else if (result === "ambiguous") {
        console.warn(
          `[auth] ambiguous invite prefix ${cmd.tokenPrefix} — refused revoke`,
        );
      }
      break;
    }
    case "list_active_sessions": {
      if (session.role === "owner") {
        ws.send(
          JSON.stringify({
            type: "sessions_active_list",
            sessions: listActiveSessions(),
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "sessions_active_list",
            sessions: listActiveSessionsForUserId(session.userId),
          }),
        );
      }
      break;
    }
    case "revoke_session": {
      // Branch on role BEFORE any prefix-based check. The owner path
      // runs its lockout precheck against the global session set
      // (owners can revoke anyone's session, so they're allowed to
      // know that a given prefix is the last owner session). The
      // member path must not run that precheck on the unscoped set,
      // because a divergent "blocked" reason for a foreign prefix
      // would leak the existence of an owner session at that prefix.
      // Instead, the scoped mutator folds the lockout check inside its
      // own scope-confirmed branch — so "would_strand_office" only
      // ever surfaces for a row the caller actually owns.
      const lockoutReason =
        "Refused: this is the last active owner session in the office. " +
        "Mint an additional invite for an owner first, accept it on " +
        "another device, then retry.";
      if (session.role === "owner") {
        const targetHash = resolveSessionHashByPrefix(cmd.sessionPrefix);
        if (targetHash && wouldRevokeLeaveOfficeUnreachable(targetHash)) {
          ws.send(
            JSON.stringify({
              type: "revoke_blocked",
              sessionPrefix: cmd.sessionPrefix,
              reason: lockoutReason,
            }),
          );
          break;
        }
        const result = await revokeSessionByPrefix(cmd.sessionPrefix);
        if (result === "ok") {
          broadcastToOwners({
            type: "session_revoked",
            sessionPrefix: cmd.sessionPrefix,
          });
          pushSessionsListToEachWs();
        } else if (result === "ambiguous") {
          console.warn(
            `[auth] ambiguous session prefix ${cmd.sessionPrefix} — refused revoke`,
          );
        }
        break;
      }
      const result = await revokeActiveSessionByPrefixForUserId(
        cmd.sessionPrefix,
        session.userId,
      );
      if (result === "ok") {
        broadcastToOwners({
          type: "session_revoked",
          sessionPrefix: cmd.sessionPrefix,
        });
        pushSessionsListToEachWs();
      } else if (result === "would_strand_office") {
        ws.send(
          JSON.stringify({
            type: "revoke_blocked",
            sessionPrefix: cmd.sessionPrefix,
            reason: lockoutReason,
          }),
        );
      } else if (result === "ambiguous") {
        console.warn(
          `[auth] ambiguous session prefix ${cmd.sessionPrefix} — refused revoke`,
        );
      }
      break;
    }
    case "logout": {
      // Self-logout: revoke current session, then close socket. The HTTP
      // /auth/logout path mirrors this for the browser cookie-clear case;
      // both paths converge on the same revoke logic.
      //
      // Lockout-prevention: refuse if this is the office's last active
      // owner session. Operator must mint an additional invite first to
      // preserve the recovery path. Cookie stays valid; socket stays
      // open; the UI surfaces the reason inline.
      if (wouldRevokeLeaveOfficeUnreachable(session.sessionIdHash)) {
        ws.send(
          JSON.stringify({
            type: "logout_blocked",
            reason:
              "You're the only owner with an active session. Sign out " +
              "would lock the office out of in-browser recovery. Mint " +
              "an additional invite for yourself (Issue invite → your " +
              'name → tick "additional invite for this identity") and ' +
              "accept it on another device first.",
          }),
        );
        break;
      }
      // We catch persistence failures here (rather than relying on the
      // outer guard) so we never close the socket on a failed logout —
      // the rollback inside logoutBySessionHash restored the in-memory
      // session, and closing the WS would mislead the user into thinking
      // they were signed out when their cookie still works.
      try {
        await logoutBySessionHash(session.sessionIdHash);
        ws.close();
      } catch (err) {
        console.error("[auth] logout persist failed; session preserved:", err);
      }
      break;
    }
  }
}

// Resolve UI dist path
const UI_DIST = join(import.meta.dir, "..", "ui", "dist");

// Escape a string for safe inclusion as text inside an HTML element (e.g. <title>).
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Serve index.html with the office name substituted into the <title>. The UI
// has `<title>__OFFICE_TITLE__</title>`; we replace that placeholder per-request
// so the tab title is correct before the WS connects (and on the auth page).
async function serveIndexHtml(): Promise<Response> {
  const raw = await Bun.file(join(UI_DIST, "index.html")).text();
  const officeName = AgentManager.getOfficeSettings().name;
  const title = officeName ? `${escapeHtml(officeName)} | Isomux` : "Isomux";
  const html = raw.replace("__OFFICE_TITLE__", title);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ...securityHeaders(),
    },
  });
}

const PORT = parseInt(process.env.PORT || "4000");

const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade — authenticated and origin-checked. The upgrade
    // carries the session into ws.data so per-message handlers can attribute
    // writes without trusting client-supplied username fields.
    if (url.pathname === "/ws") {
      const wsCookie = readSessionCookie(req);
      const wsSession = validateSession(wsCookie);
      if (!wsSession) {
        return new Response("unauthenticated", { status: 401 });
      }
      if (!checkOrigin(req)) {
        return new Response("bad origin", { status: 403 });
      }
      const upgraded = server.upgrade(req, {
        data: { session: wsSession, connectionId: nextConnectionId() },
      });
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // /auth/* and /i/<token> routes. These must run before the gating check
    // because unauthenticated visitors transition to authenticated through
    // them. Pass the office name so pre-auth pages render the same tab
    // title format (`<name> | Isomux — ...`) the SPA shell uses.
    const officeName = AgentManager.getOfficeSettings().name;
    const authResponse = await tryHandleAuthRoute(req, url, officeName);
    if (authResponse) return authResponse;

    // PWA manifest + app icons: iOS Safari fetches these out-of-band when
    // "Add to Home Screen" runs, and the apple-touch-icon fetch in particular
    // can happen without the page's cookies. If 401'd here the PWA tile
    // shows a generic icon and the manifest's name/colors don't apply.
    // Whitelisted unauthenticated; they're public marketing-grade assets
    // baked at build time and contain no deployment state. URL.pathname is
    // normalized by the parser so path-traversal via .. can't escape /icons/.
    if (
      req.method === "GET" &&
      (url.pathname === "/manifest.json" || url.pathname.startsWith("/icons/"))
    ) {
      const f = Bun.file(join(UI_DIST, url.pathname));
      if (await f.exists()) {
        return new Response(f, {
          headers: {
            "Content-Type": mimeTypeForFilename(url.pathname),
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }
      // fall through to the 404 path below if the asset isn't on disk
    }

    // Loopback bypass is intentionally narrow: it only applies to API paths
    // agents legitimately hit from the same box (POST /tasks, /cronjobs read
    // routes, /agents/:id/* in-process actions). The SPA shell still requires
    // an authenticated cookie even from localhost, so a same-host browser is
    // pushed through the bootstrap-invite flow instead of getting a half-
    // functional page where HTTP works but WS rejects.
    const isAgentApiPath =
      url.pathname.startsWith("/tasks") ||
      url.pathname.startsWith("/cronjobs") ||
      url.pathname.startsWith("/agents/") ||
      url.pathname === "/backup/status";
    const auth = authenticate(req, server, {
      allowLoopback: isAgentApiPath,
      officeName,
    });
    if (auth.kind === "rejected") return auth.response;

    // CORS preflight for task API
    if (req.method === "OPTIONS" && url.pathname.startsWith("/tasks")) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // CORS preflight for cronjobs API
    if (req.method === "OPTIONS" && url.pathname.startsWith("/cronjobs")) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Cronjobs HTTP API (read-only — mutations go through WebSocket, except
    // POST /cronjobs/:id/runs/:runId/read-file which lets an in-flight run
    // surface a file in its transcript — the cronjob equivalent of POST
    // /agents/:id/read-file).
    if (url.pathname.startsWith("/cronjobs")) {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      };
      const parts = url.pathname.split("/").filter(Boolean); // ["cronjobs"] or ["cronjobs", id] or ["cronjobs", id, "runs"] or ["cronjobs", id, "runs", runId, ...]
      // POST /cronjobs/:jobId/runs/:runId/read-file — copy a file into the
      // run's files dir and emit a `file-view` log entry so the run's
      // transcript renders it inline (images) or as a clickable file chip.
      // Body: { path }.
      if (
        req.method === "POST" &&
        parts.length === 5 &&
        parts[2] === "runs" &&
        parts[4] === "read-file"
      ) {
        const jobId = parts[1];
        const runId = parts[3];
        let path: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.path === "string") path = body.path;
        } catch {}
        if (!path) {
          return new Response(JSON.stringify({ error: "missing path" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const result = CronjobManager.emitCronjobRunReadFile(
          jobId,
          runId,
          path,
        );
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /cronjobs/:jobId/runs/:runId/diff — emit a styled diff card
      // into the run transcript. Mirrors POST /agents/:id/diff. Optional
      // body fields: { dir, commit } — see the agent endpoint for the
      // accepted commit syntax.
      if (
        req.method === "POST" &&
        parts.length === 5 &&
        parts[2] === "runs" &&
        parts[4] === "diff"
      ) {
        const jobId = parts[1];
        const runId = parts[3];
        let dir: string | undefined;
        let commit: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.dir === "string") dir = body.dir;
          if (body && typeof body.commit === "string") commit = body.commit;
        } catch {}
        const result = CronjobManager.emitCronjobRunDiff(
          jobId,
          runId,
          dir,
          commit,
        );
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      if (req.method !== "GET") {
        return new Response(JSON.stringify({ error: "method not allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }
      const cronjobs = CronjobManager.listCronjobs();
      // GET /cronjobs
      if (parts.length === 1) {
        return new Response(JSON.stringify(cronjobs), { headers: corsHeaders });
      }
      const jobId = parts[1];
      const cronjob = cronjobs.find((c) => c.id === jobId);
      if (!cronjob)
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      // GET /cronjobs/:id
      if (parts.length === 2) {
        return new Response(JSON.stringify(cronjob), { headers: corsHeaders });
      }
      // GET /cronjobs/:id/runs
      if (parts[2] === "runs" && parts.length === 3) {
        const runs = CronjobManager.getRunsForCronjob(jobId);
        return new Response(JSON.stringify(runs), { headers: corsHeaders });
      }
      // GET /cronjobs/:id/runs/:runId
      if (parts[2] === "runs" && parts.length === 4) {
        const { run, entries } = CronjobManager.getRunTranscript(
          jobId,
          parts[3],
        );
        if (!run)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ run, entries }), {
          headers: corsHeaders,
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Task HTTP API
    if (url.pathname.startsWith("/tasks")) {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      };
      const parts = url.pathname.split("/").filter(Boolean); // ["tasks"] or ["tasks", id] or ["tasks", id, action]
      const taskId = parts[1];
      const action = parts[2]; // "claim" or "done"

      // DELETE blocked at HTTP level
      if (req.method === "DELETE") {
        return new Response(
          JSON.stringify({ error: "DELETE not allowed via HTTP" }),
          { status: 405, headers: corsHeaders },
        );
      }

      // GET /tasks — list (excludes done and backlog by default)
      if (req.method === "GET" && !taskId) {
        const status = url.searchParams.get("status");
        const assignee = url.searchParams.get("assignee");
        const titleFilter = url.searchParams.get("title");
        let filtered = AgentManager.getTasks();
        if (!status) {
          filtered = filtered.filter(
            (t) => t.status !== "done" && t.status !== "backlog",
          );
        } else if (status !== "all") {
          filtered = filtered.filter((t) => t.status === status);
        }
        if (assignee) {
          filtered = filtered.filter((t) => t.assignee === assignee);
        }
        if (titleFilter) {
          const q = titleFilter.toLowerCase();
          filtered = filtered.filter((t) => t.title.toLowerCase().includes(q));
        }
        return new Response(JSON.stringify(filtered), { headers: corsHeaders });
      }

      // GET /tasks/:id — detail
      if (req.method === "GET" && taskId && !action) {
        const task = AgentManager.getTasks().find((t) => t.id === taskId);
        if (!task)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks — create
      if (req.method === "POST" && !taskId) {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        if (
          typeof body.title !== "string" ||
          typeof body.createdBy !== "string"
        ) {
          return new Response(
            JSON.stringify({ error: "title and createdBy required" }),
            { status: 400, headers: corsHeaders },
          );
        }
        if (body.priority !== undefined && !isValidPriority(body.priority)) {
          return new Response(
            JSON.stringify({ error: "invalid priority, must be P0-P3" }),
            { status: 400, headers: corsHeaders },
          );
        }
        const task = AgentManager.addTask(body.title, body.createdBy, {
          description:
            typeof body.description === "string" ? body.description : undefined,
          priority: body.priority,
          assignee:
            typeof body.assignee === "string" ? body.assignee : undefined,
          username:
            typeof body.username === "string" ? body.username : undefined,
        });
        return new Response(JSON.stringify(task), {
          status: 201,
          headers: corsHeaders,
        });
      }

      // PATCH /tasks/:id — update
      if (req.method === "PATCH" && taskId && !action) {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        if (body.status !== undefined && !isValidStatus(body.status)) {
          return new Response(
            JSON.stringify({
              error: "invalid status, must be open|in_progress|backlog|done",
            }),
            { status: 400, headers: corsHeaders },
          );
        }
        if (body.priority !== undefined && !isValidPriority(body.priority)) {
          return new Response(
            JSON.stringify({ error: "invalid priority, must be P0-P3" }),
            { status: 400, headers: corsHeaders },
          );
        }
        const changes: Partial<
          Pick<
            TaskItem,
            "title" | "description" | "priority" | "status" | "assignee"
          >
        > = {};
        if (typeof body.title === "string") changes.title = body.title;
        if (body.description !== undefined)
          changes.description =
            typeof body.description === "string" ? body.description : undefined;
        if (body.status !== undefined) changes.status = body.status;
        if (body.priority !== undefined)
          changes.priority = body.priority ? body.priority : undefined;
        if (body.assignee !== undefined)
          changes.assignee =
            typeof body.assignee === "string" ? body.assignee : undefined;
        const task = AgentManager.updateTask(taskId, changes);
        if (!task)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks/:id/claim
      if (req.method === "POST" && taskId && action === "claim") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const changes: Partial<Pick<TaskItem, "status" | "assignee">> = {
          status: "in_progress",
        };
        if (typeof body.assignee === "string") changes.assignee = body.assignee;
        const task = AgentManager.updateTask(taskId, changes);
        if (!task)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks/:id/done
      if (req.method === "POST" && taskId && action === "done") {
        // Agents send `curl -d '{}'` — consume the body so Bun doesn't warn
        try {
          await req.json();
        } catch {}
        const task = AgentManager.updateTask(taskId, { status: "done" });
        if (!task)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // GET /backup/status — last-run timestamp, ok/error, retention, dest dir.
    if (url.pathname === "/backup/status" && req.method === "GET") {
      return new Response(JSON.stringify(getBackupStatus()), {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      });
    }

    // POST /agents/:id/diff — emit a styled diff card into the agent's chat,
    // matching the /isomux-diff slash command. Lets an agent surface a diff
    // when the boss asks "show me your changes". Optional body fields:
    //   { dir } — target a different directory (defaults to agent cwd)
    //   { commit } — a single ref (SHA, branch, tag) or a range using `..` /
    //                `...` (e.g. "08dbbe2", "main..feature", "HEAD~3..HEAD").
    //                When set, the diff shows that commit/range's changes
    //                instead of the working tree.
    if (url.pathname.startsWith("/agents/") && req.method === "POST") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 3 && parts[2] === "diff") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const agentId = parts[1];
        let dir: string | undefined;
        let commit: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.dir === "string") dir = body.dir;
          if (body && typeof body.commit === "string") commit = body.commit;
        } catch {}
        const result = AgentManager.emitAgentDiff(agentId, dir, commit);
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /agents/:id/edit-file — emit an `edit-request` card so the boss
      // can open the file in the editor side panel. Mirrors /diff. Body: { path }.
      if (parts.length === 3 && parts[2] === "edit-file") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const agentId = parts[1];
        let path: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.path === "string") path = body.path;
        } catch {}
        if (!path) {
          return new Response(JSON.stringify({ error: "missing path" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const result = AgentManager.emitAgentEditRequest(agentId, path);
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /agents/:id/read-file — copy a file into the agent's files dir
      // and emit a `file-view` card so the boss sees the file (images render
      // inline, others render as a clickable file chip). Replaces the older
      // "Read tool on an image → SDK extracts bytes" convention; works for
      // both Claude and Codex agents. Body: { path }.
      if (parts.length === 3 && parts[2] === "read-file") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const agentId = parts[1];
        let path: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.path === "string") path = body.path;
        } catch {}
        if (!path) {
          return new Response(JSON.stringify({ error: "missing path" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const result = AgentManager.emitAgentReadFile(agentId, path);
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /agents/:id/terminal-command — emit a `terminal-command` card so
      // the boss can prefill the terminal panel with this command. Mirrors
      // /edit-file. Body: { command }. Single-line; not auto-executed.
      if (parts.length === 3 && parts[2] === "terminal-command") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const agentId = parts[1];
        let command: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.command === "string") command = body.command;
        } catch {}
        if (!command) {
          return new Response(JSON.stringify({ error: "missing command" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const result = AgentManager.emitAgentTerminalCommand(agentId, command);
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /agents/:id/message — queue a message into the receiving agent's
      // chat. The sender's identity (name + room) is looked up server-side
      // from senderAgentId so callers can't spoof identity or inject
      // prefix-delimiter characters into the prompt the receiver sees.
      // Body: { text, senderAgentId, clientMessageId? }
      if (parts.length === 3 && parts[2] === "message") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const receiverId = parts[1];
        let body: Record<string, unknown> | null = null;
        try {
          body = (await req.json()) as Record<string, unknown> | null;
        } catch {}
        if (!body) {
          return new Response(JSON.stringify({ error: "invalid JSON body" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const text = typeof body.text === "string" ? body.text : null;
        const senderAgentId =
          typeof body.senderAgentId === "string" ? body.senderAgentId : null;
        const clientMessageId =
          typeof body.clientMessageId === "string"
            ? body.clientMessageId
            : undefined;
        if (!text || !senderAgentId) {
          return new Response(
            JSON.stringify({ error: "required: text, senderAgentId" }),
            { status: 400, headers: corsHeaders },
          );
        }
        if (senderAgentId === receiverId) {
          return new Response(
            JSON.stringify({ error: "cannot send to self" }),
            { status: 400, headers: corsHeaders },
          );
        }
        const senderInfo = AgentManager.getAgentDisplay(senderAgentId);
        if (!senderInfo) {
          return new Response(
            JSON.stringify({ error: "senderAgentId is not a known agent" }),
            { status: 400, headers: corsHeaders },
          );
        }
        const result = AgentManager.enqueueMessage(receiverId, {
          sender: {
            kind: "agent",
            agentId: senderAgentId,
            agentName: senderInfo.name,
            roomName: senderInfo.roomName,
          },
          text,
          clientMessageId,
        });
        if (!result.ok) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        }
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }
    }

    // File upload endpoint: POST /api/upload/{agentId}
    if (url.pathname.startsWith("/api/upload/") && req.method === "POST") {
      const agentId = url.pathname.split("/")[3];
      if (!agentId || !AgentManager.getAgent(agentId)) {
        return new Response(JSON.stringify({ error: "agent not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const formData = await req.formData();
        const attachments: Attachment[] = [];
        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
        const MAX_FILES = 5;
        const MAX_TOTAL = 40 * 1024 * 1024; // 40MB
        let totalSize = 0;
        let fileCount = 0;

        for (const [, value] of formData) {
          if (!(value instanceof File)) continue;
          fileCount++;
          if (fileCount > MAX_FILES) {
            return new Response(
              JSON.stringify({
                error: `Maximum ${MAX_FILES} files per upload`,
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (value.size > MAX_FILE_SIZE) {
            return new Response(
              JSON.stringify({
                error: `File "${value.name}" exceeds 20MB limit`,
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          totalSize += value.size;
          if (totalSize > MAX_TOTAL) {
            return new Response(
              JSON.stringify({ error: "Total upload exceeds 40MB limit" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          const buffer = Buffer.from(await value.arrayBuffer());
          const att = saveFile(
            agentId,
            buffer,
            value.type || "application/octet-stream",
            value.name,
          );
          if (att) attachments.push(att);
        }
        return new Response(JSON.stringify({ attachments }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: errMessage(err, "Upload failed") }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // File serving endpoint (also handles legacy /api/images/ URLs)
    if (
      url.pathname.startsWith("/api/files/") ||
      url.pathname.startsWith("/api/images/")
    ) {
      const parts = url.pathname.split("/").filter(Boolean); // ["api", "files"|"images", agentId, filename]
      const agentId = parts[2];
      const filename = parts[3];
      if (!agentId || !filename) {
        return new Response("Not found", { status: 404 });
      }
      const filePath = getFilePath(agentId, filename);
      if (!filePath) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(Bun.file(filePath), {
        headers: {
          "Content-Type": mimeTypeForFilename(filename),
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    // Static file serving
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    if (filePath === "/index.html") {
      return serveIndexHtml();
    }
    const file = Bun.file(join(UI_DIST, filePath));
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Cache-Control": "no-cache" },
      });
    }
    // SPA fallback
    return serveIndexHtml();
  },
  websocket: {
    open(ws) {
      browsers.add(ws);
      registerSocket(ws.data.session.sessionIdHash, ws);
      // Send session context FIRST so the client knows the authenticated
      // identity and role before any reducer touches state. connectionId
      // is per-WS (live-avatars) so the client can identify its OWN
      // ghost in presence_list — same auth session can be running in
      // multiple tabs and each tab has a distinct connectionId.
      ws.send(
        JSON.stringify({
          type: "session_context",
          context: sessionContextFor(ws.data.session, ws.data.connectionId),
        }),
      );
      // Send users (boss profiles) so the full_state reducer can apply
      // the current user's defaultRoomId from server-stored prefs.
      ws.send(
        JSON.stringify({
          type: "users_list",
          users: listUsers(),
        }),
      );
      // Send projected full_state (rooms + agents filtered to the
      // session's allowedRooms; sessions whose allowedRooms covers
      // every current room get the identity projection).
      sendProjectedFullState(ws);
      // Owners also receive the unfiltered global rooms list so the
      // admin surface (UserManagementModal's Allowed Rooms editor) can
      // grant access to rooms the owner has hidden from their own view.
      if (ws.data.session.role === "owner") {
        ws.send(
          JSON.stringify({
            type: "all_rooms_list",
            rooms: AgentManager.getRooms(),
          }),
        );
      }
      // Send tasks
      ws.send(
        JSON.stringify({
          type: "tasks",
          tasks: AgentManager.getTasks(),
        }),
      );
      // Send cronjobs + cronjobsPrompt
      ws.send(
        JSON.stringify({
          type: "cronjobs_state",
          cronjobs: CronjobManager.listCronjobs(),
          cronjobsPrompt: CronjobManager.getCronjobsPrompt(),
        }),
      );
      // Send update status
      const update = getUpdateStatus();
      if (update.updateAvailable) {
        ws.send(
          JSON.stringify({
            type: "update_status",
            updateAvailable: true,
            current: update.current,
            latest: update.latest,
          }),
        );
      }
      // Send cached log history and slash commands for each agent the
      // session can see. agentVisibleForSession short-circuits to true
      // for full-access sessions so the gate is free on the fast path.
      const session = ws.data.session;
      for (const agent of AgentManager.getAllAgents()) {
        if (!agentVisibleForSession(session, agent.id)) continue;
        const logs = AgentManager.getAgentLogs(agent.id);
        for (const entry of logs) {
          ws.send(JSON.stringify({ type: "log_entry", entry }));
        }
        const cmds = AgentManager.getAgentCommands(agent.id);
        if (cmds.commands.length > 0 || cmds.skills.length > 0) {
          ws.send(
            JSON.stringify({
              type: "slash_commands",
              agentId: agent.id,
              commands: cmds.commands,
              skills: cmds.skills,
            }),
          );
        }
      }
      // Live-avatars: send the current presence snapshot (filtered to
      // rooms this session can see) so the new client renders existing
      // ghosts immediately rather than waiting for the next
      // presence_update from someone else.
      sendPresenceListTo(ws);
    },
    message(ws, data) {
      // Per-message session recheck. Revoke kicks in here without a reconnect:
      // revalidateByHash hits the same in-memory map and returns null if the
      // session has been deleted (revoke), expired, or its user removed.
      const fresh = revalidateByHash(ws.data.session.sessionIdHash);
      if (!fresh) {
        ws.send(JSON.stringify({ type: "session_expired" }));
        ws.close();
        return;
      }
      ws.data.session = fresh;
      try {
        const cmd = JSON.parse(data as string) as ClientCommand;
        void handleCommand(cmd, ws);
      } catch (e) {
        console.error("Invalid command:", e);
      }
    },
    close(ws) {
      browsers.delete(ws);
      unregisterSocket(ws.data.session.sessionIdHash, ws);
      // Drop any per-WS editor watchers on disconnect.
      const map = editorWatchers.get(ws);
      if (map) {
        for (const w of map.values()) stopWatch(w);
        editorWatchers.delete(ws);
      }
      // Live-avatars cleanup. Idempotent: removePresence returns true
      // only if an entry existed. Key is the per-WS connectionId, NOT
      // the auth session hash — that distinction is what makes
      // reconnects and same-cookie multi-tab work: when a tab reconnects
      // it gets a NEW connectionId, and the OLD close handler here
      // removes only the OLD id, never racing with the new tab's entry.
      if (removePresence(ws.data.connectionId)) {
        pushPresenceListToEachWs();
      }
    },
  },
});

// The public origin is the canonical URL the server expects browsers to hit.
// We compare it against the Origin header on WS upgrades and unsafe HTTP
// requests, and bake it into invite URLs. Resolution precedence is env >
// office-config.json `publicOrigin` > localhost fallback. Log one
// informational line so the operator knows which mode they're in; localhost
// is a valid configuration for single-user setups, not a mistake.
{
  const resolved = buildPublicOrigin();
  if (resolved.source === "env") {
    console.log(
      `[auth] using ISOMUX_PUBLIC_ORIGIN from env: ${resolved.origin}`,
    );
  } else if (resolved.source === "config") {
    console.log(
      `[auth] using publicOrigin from office-config.json: ${resolved.origin}`,
    );
  } else {
    console.log(
      `[auth] local-only mode: no public origin configured, using ${resolved.origin}. See docs/access-and-invites.md for the Tailscale Funnel agent prompt or other remote-access options.`,
    );
  }
}

// Bootstrap invite. If no owner exists in users.json we print an owner-tagged
// invite URL once (or reuse an existing unconsumed one); the owner clicks it,
// chooses a display name, and lands in the office. The CLI flag
// --regenerate-bootstrap invalidates a prior unconsumed bootstrap invite and
// mints a fresh one, for the case where the owner lost the original URL.
const REGENERATE_BOOTSTRAP = process.argv.includes("--regenerate-bootstrap");

void (async () => {
  try {
    const minted = await ensureBootstrapInvite({
      regenerate: REGENERATE_BOOTSTRAP,
    });
    if (minted) {
      const { origin } = buildPublicOrigin();
      const url = `${origin}/i/${minted.rawToken}`;
      const expiresIn = Math.round((minted.expiresAt - Date.now()) / 3600_000);
      console.log("");
      console.log(
        "================================================================",
      );
      console.log(
        "  Isomux: no owner exists yet. Bootstrap invite (one-time):",
      );
      console.log("  " + url);
      console.log(
        `  Valid for ~${expiresIn}h. Open this URL in your browser to`,
      );
      console.log(
        "  claim ownership. This URL is printed once; if you lose it,",
      );
      console.log("  restart the server with --regenerate-bootstrap.");
      console.log(
        "================================================================",
      );
      console.log("");
    } else if (hasUnconsumedBootstrapInvite()) {
      console.log(
        "Isomux: an unconsumed bootstrap invite already exists, but the raw URL " +
          "is only printed once. Run with --regenerate-bootstrap to mint a fresh one.",
      );
    }
  } catch (err) {
    // Bootstrap mint failed (disk write error, etc.). Log loudly; server
    // keeps running so the operator can fix permissions/disk and retry
    // with --regenerate-bootstrap. Crashing here would mask the cause.
    console.error(
      "[auth] failed to mint bootstrap invite; the server is up but " +
        "no one can sign in. Resolve the disk/permissions issue and " +
        "restart with --regenerate-bootstrap:",
      err,
    );
  }
})();

// Start update checker
onUpdateChange((status) => {
  broadcast({
    type: "update_status",
    updateAvailable: status.updateAvailable,
    current: status.current,
    latest: status.latest,
  });
});
startUpdateChecker();

// Restore persisted agents on startup
void AgentManager.restoreAgents().then((restored) => {
  if (restored.length > 0) {
    console.log(
      `Restored ${restored.length} agent(s): ${restored.map((a) => a.name).join(", ")}`,
    );
  }
  // One-time hygiene pass: remove any stale roomIds from users'
  // allowedRooms / notifRooms that don't match a currently-existing
  // room. Catches references left behind by close_room calls from
  // earlier versions that didn't prune user records inline. Cheap
  // no-op once a deployment has converged.
  const validIds = AgentManager.getRooms().map((r) => r.id);
  const pruned = pruneStaleRoomRefs(validIds);
  if (pruned > 0) {
    console.log(
      `[startup] pruned stale room refs from ${pruned} user record(s)`,
    );
    broadcast({ type: "users_list", users: listUsers() });
  }
});

// Boot cronjob scheduler (loads configs, reconciles stale "running" rows, starts tick).
CronjobManager.startCronjobScheduler();

// Daily ~/.isomux/ backup tarball with N=7 retention. See server/backup.ts.
startBackupScheduler();

// Codex CLI version check. Logs ok/mismatch/not-installed to the server log.
// Doesn't block startup — Claude agents are independent. Codex agent spawn
// (step 8) will refuse if this check failed.
void logCodexVersionAtBoot();

console.log(`Isomux running at http://localhost:${server.port}`);
