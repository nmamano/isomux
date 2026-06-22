import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
  type Dispatch,
} from "react";
import { KILLED_AGENT_CHIP_CAP } from "../shared/types.ts";
import type {
  AgentInfo,
  KilledAgentSummary,
  LogEntry,
  SessionInfo,
  ServerMessage,
  SkillInfo,
  TaskItem,
  OfficeSettings,
  RoomWire,
  SettingsSaveResponse,
  SettingsValidationResponse,
  Cronjob,
  CronjobRun,
  PresenceInfo,
  UserRecord,
  SessionContext,
  InviteWire,
  SessionWire,
} from "../shared/types.ts";
import { connect, send } from "./ws.ts";
import { type Features, PRODUCTION_FEATURES } from "../shared/features.ts";
import {
  getUsername,
  readLegacyUserPrefs,
  clearLegacyUserPrefs,
  shouldNotifyRoom,
} from "./device-settings.ts";
import {
  DEFAULT_THEME_ID,
  getThemeById,
  THEMES,
  type Theme,
  type ThemeMode,
} from "./themes.ts";

export interface AppState {
  agents: AgentInfo[];
  logs: Map<string, LogEntry[]>; // streamId → entries (streamId = agentId or cronrun-<runId>)
  logEntryIds: Map<string, Set<string>>; // streamId → set of seen entry ids (for O(1) dedupe)
  focusedAgentId: string | null;
  connected: boolean;
  isMobile: boolean;
  mobileViewMode: "list" | "office"; // which view to show on mobile
  needsAttention: Set<string>; // agentIds with unread state changes
  sessionsList: Map<
    string,
    { sessions: SessionInfo[]; currentSessionId: string | null }
  >; // agentId → available sessions
  // seq increments when any agent finishes work (for sound regardless of focus);
  // roomId is the id of the room the triggering agent was in, used to filter
  // per-room notification preferences. null if the room couldn't be resolved.
  soundTrigger: { seq: number; roomId: string | null };
  drafts: Map<string, string>; // agentId → unsent chat input
  // agentId → which side panel was open (terminal/editor) when the user last
  // viewed this agent. Persists across LogView remount on agent switch so
  // the panel reopens automatically when the boss returns. `undefined` means
  // never opened a panel; missing entries default to closed.
  sidePanels: Map<string, "terminal" | "editor">;
  recentCwds: string[]; // persisted recent working directories
  slashCommands: Map<
    string,
    { commands: { name: string; description?: string }[]; skills: SkillInfo[] }
  >; // agentId → available commands
  stateChangedAt: Map<string, number>; // agentId → timestamp when agent state last changed
  office: OfficeSettings;
  rooms: RoomWire[];
  tasks: TaskItem[];
  tasksLoaded: boolean;
  cronjobs: Cronjob[];
  cronjobsLoaded: boolean;
  cronjobsPrompt: string | null;
  cronjobRunsByJob: Map<string, CronjobRun[]>; // jobId → run list (loaded on demand)
  cronjobRunsLoaded: boolean;
  currentRoom: number; // 0-based room index (view selection only)
  updateAvailable: boolean;
  updateCurrent: { sha: string; message: string; date: string };
  updateLatest: { sha: string; message: string; date: string };
  // Server-stored boss profiles. `users` is keyed by lowercase(name). The
  // current device's user is identified by `sessionContext.username`, which
  // the server sends right after WS open from the session cookie. Pre-auth
  // setups have null until the server emits session_context.
  users: Map<string, UserRecord>;
  usersLoaded: boolean;
  // Owner-only access state. Both maps stay empty (and the corresponding
  // owner UI is hidden) for members and unauthenticated states.
  sessionContext: SessionContext | null;
  // Owner-only: unfiltered global rooms list, used by the Allowed Rooms
  // editor in UserManagementModal so an owner with a restricted
  // allowedRooms can still grant other users access to rooms outside
  // their own subset. Empty (and the editor falls back to `rooms`)
  // for members and pre-auth states.
  allRooms: RoomWire[];
  invitesList: InviteWire[];
  invitesLoaded: boolean;
  activeSessions: SessionWire[];
  activeSessionsLoaded: boolean;
  // When the per-message session recheck fails (server emits
  // session_expired), the UI surfaces a banner and queues a reload so the
  // user lands back at the bootstrap/login flow on the next tick.
  sessionExpired: boolean;
  // Monotonic: false until the first full_state arrives, then true forever.
  // Lets components suppress negative UI (empty-state overlays, reconnect
  // banner) during the brief pre-hydration window without overloading
  // `connected`, which is deliberately tied to full_state arrival.
  hasReceivedInitialState: boolean;
  // Live-avatars: other connections' presence in the office scene.
  // Pre-filtered by the server for the current session's allowedRooms
  // and sorted by connectionId. The client renders one Ghost per entry
  // whose currentRoom matches state.currentRoom (rooms render
  // independently). Self entry (matching state.sessionContext.
  // connectionId, per-WS not per-cookie) is hidden client-side
  // unconditionally — the boss never sees their own avatar. The
  // server still sends it so OTHER tabs/devices of the same user
  // remain visible as their own ghosts (each with its own
  // connectionId).
  presences: PresenceInfo[];
  // Distinct online userIds across the WHOLE office (server counts ALL
  // presence entries including off-scene sessions). Same value for
  // every recipient — answers "who is online anywhere", not "who is in
  // a room I can see". Renders as the total chip in RoomTabBar.
  totalOnlineUsers: number;
  // ACL-filtered list of currently-killed agents available to revive
  // from the spawn menu. Server-capped (12) and ACL-filtered per
  // session; the UI just renders the array as chips sorted killedAt
  // desc. Server pushes additions/removals via killed_agent_added /
  // killed_agent_removed events as kills and revivals happen.
  killedAgents: KilledAgentSummary[];
}

type Action =
  | {
      type: "full_state";
      agents: AgentInfo[];
      recentCwds: string[];
      office: OfficeSettings;
      rooms: RoomWire[];
      killedAgents: KilledAgentSummary[];
    }
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "killed_agent_added"; agent: KilledAgentSummary }
  | { type: "killed_agent_removed"; agentId: string; lastRoomId: string }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "focus"; agentId: string | null }
  | { type: "connected" }
  | { type: "disconnected" }
  | {
      type: "sessions_list";
      agentId: string;
      sessions: SessionInfo[];
      currentSessionId: string | null;
    }
  | { type: "set_draft"; agentId: string; text: string }
  | {
      type: "set_side_panel";
      agentId: string;
      panel: "terminal" | "editor" | null;
    }
  | {
      type: "slash_commands";
      agentId: string;
      commands: { name: string; description?: string; aliasFor?: string }[];
      skills: SkillInfo[];
    }
  | { type: "clear_logs"; agentId: string }
  | { type: "set_mobile"; isMobile: boolean }
  | { type: "toggle_mobile_view" }
  | {
      type: "office_settings_updated";
      prompt: string | null;
      envFile: string | null;
      name: string | null;
    }
  | { type: "tasks"; tasks: TaskItem[] }
  | { type: "set_current_room"; room: number }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null }
  | { type: "users_list"; users: UserRecord[] }
  | { type: "user_updated"; user: UserRecord; prevName?: string }
  | { type: "session_context"; context: SessionContext }
  | {
      type: "presence_list";
      entries: PresenceInfo[];
      totalOnlineUsers: number;
    }
  | { type: "all_rooms_list"; rooms: RoomWire[] }
  | { type: "invites_list"; invites: InviteWire[] }
  | { type: "sessions_active_list"; sessions: SessionWire[] }
  | {
      type: "invite_minted";
      requestId?: string;
      ok: boolean;
      url?: string;
      invite?: InviteWire;
      error?: string;
    }
  | { type: "invite_revoked"; tokenPrefix: string }
  | { type: "session_revoked"; sessionPrefix: string }
  | { type: "session_expired" }
  | SettingsSaveResponse
  | SettingsValidationResponse
  | {
      type: "update_status";
      updateAvailable: boolean;
      current: { sha: string; message: string; date: string };
      latest: { sha: string; message: string; date: string };
    }
  | {
      type: "cronjobs_state";
      cronjobs: Cronjob[];
      cronjobsPrompt: string | null;
    }
  | { type: "cronjob_added"; cronjob: Cronjob }
  | { type: "cronjob_updated"; cronjob: Cronjob }
  | { type: "cronjob_deleted"; id: string }
  | { type: "cronjobs_prompt_updated"; value: string | null }
  | { type: "cronjob_runs"; cronjobId: string; runs: CronjobRun[] }
  | { type: "cronjob_runs_complete" }
  | { type: "cronjob_run_updated"; run: CronjobRun };

// States that warrant attention
const ATTENTION_STATES = new Set(["idle", "error", "waiting_for_response"]);

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "full_state": {
      // Apply the user's default room only on the first full_state (when we
      // haven't seen any rooms yet). Subsequent full_states (e.g. after a
      // server reconnect) preserve whichever room the user was viewing.
      let currentRoom = state.currentRoom;
      if (state.rooms.length === 0) {
        const username = getUsername();
        const me = username
          ? state.users.get(username.toLowerCase())
          : undefined;
        const defaultId = me?.defaultRoomId ?? null;
        if (defaultId) {
          const idx = action.rooms.findIndex((r) => r.id === defaultId);
          if (idx >= 0) currentRoom = idx;
        }
      }
      currentRoom = Math.min(currentRoom, Math.max(0, action.rooms.length - 1));
      return {
        ...state,
        agents: action.agents,
        recentCwds: action.recentCwds,
        office: action.office,
        rooms: action.rooms,
        killedAgents: action.killedAgents,
        currentRoom,
        logs: new Map(),
        logEntryIds: new Map(),
        needsAttention: new Set(),
        slashCommands: new Map(),
        stateChangedAt: new Map(
          action.agents
            .filter((a) => a.state !== "idle" && a.state !== "stopped")
            .map((a) => [a.id, Date.now()]),
        ),
        hasReceivedInitialState: true,
      };
    }
    case "agent_added":
      return { ...state, agents: [...state.agents, action.agent] };
    case "killed_agent_added": {
      // De-dupe in case the server re-emits (defensive) and prepend so the
      // newest kill is left-most in the chip row. Server-side cap (12) is
      // a soft limit; we slice here too in case multi-emit pushes past it.
      const existing = state.killedAgents.filter(
        (k) => k.id !== action.agent.id,
      );
      return {
        ...state,
        killedAgents: [action.agent, ...existing].slice(
          0,
          KILLED_AGENT_CHIP_CAP,
        ),
      };
    }
    case "killed_agent_removed":
      return {
        ...state,
        killedAgents: state.killedAgents.filter((k) => k.id !== action.agentId),
      };
    case "agent_removed": {
      const logs = new Map(state.logs);
      logs.delete(action.agentId);
      const logEntryIds = new Map(state.logEntryIds);
      logEntryIds.delete(action.agentId);
      const needsAttention = new Set(state.needsAttention);
      needsAttention.delete(action.agentId);
      const sidePanels = new Map(state.sidePanels);
      sidePanels.delete(action.agentId);
      return {
        ...state,
        agents: state.agents.filter((a) => a.id !== action.agentId),
        logs,
        logEntryIds,
        needsAttention,
        sidePanels,
        focusedAgentId:
          state.focusedAgentId === action.agentId ? null : state.focusedAgentId,
      };
    }
    case "agent_updated": {
      const newAgents = state.agents.map((a) =>
        a.id === action.agentId ? { ...a, ...action.changes } : a,
      );
      const needsAttention = new Set(state.needsAttention);
      // Track when state changes for elapsed time display
      const stateChangedAt = action.changes.state
        ? new Map(state.stateChangedAt).set(action.agentId, Date.now())
        : state.stateChangedAt;
      // Mark as needing attention if state changed to an attention state
      // and the user is not currently viewing this agent
      if (action.changes.state && ATTENTION_STATES.has(action.changes.state)) {
        const prevAgent = state.agents.find((a) => a.id === action.agentId);
        const wasWorking = prevAgent && !ATTENTION_STATES.has(prevAgent.state);
        let soundTrigger = state.soundTrigger;
        if (wasWorking) {
          // Sound: only fire when the turn that's ending originated from a
          // human message. Pure agent-to-agent traffic (one agent pings
          // another, the receiver answers and idles) stays silent — see
          // turnHadHumanInput on the server side.
          if (prevAgent.turnHadHumanInput) {
            const roomId = state.rooms[prevAgent.room]?.id ?? null;
            soundTrigger = { seq: state.soundTrigger.seq + 1, roomId };
          }
          // Badge: only when not viewing this agent. Set regardless of input
          // source — the dot is a "this agent stopped, you might want to
          // look" cue, distinct from the audible nudge.
          if (state.focusedAgentId !== action.agentId) {
            needsAttention.add(action.agentId);
          }
        }
        return {
          ...state,
          agents: newAgents,
          needsAttention,
          soundTrigger,
          stateChangedAt,
        };
      }
      return { ...state, agents: newAgents, needsAttention, stateChangedAt };
    }
    case "log_entry": {
      // Per-stream id Set for dedupe. Cloned (not mutated) so the reducer
      // stays pure — future consumers comparing Set identity won't see
      // stale references. Set.add returns the Set, so the chained form
      // works for the new-Set case.
      const streamId = action.entry.agentId;
      const seen = state.logEntryIds.get(streamId);
      if (seen?.has(action.entry.id)) return state;
      const logs = new Map(state.logs);
      const logEntryIds = new Map(state.logEntryIds);
      logEntryIds.set(streamId, new Set(seen).add(action.entry.id));
      const entries = logs.get(streamId) ?? [];
      logs.set(streamId, [...entries, action.entry]);
      return { ...state, logs, logEntryIds };
    }
    case "focus": {
      const needsAttention = new Set(state.needsAttention);
      if (action.agentId) {
        needsAttention.delete(action.agentId);
      }
      return { ...state, focusedAgentId: action.agentId, needsAttention };
    }
    case "connected":
      return { ...state, connected: true };
    case "disconnected":
      return { ...state, connected: false };
    case "sessions_list": {
      const sessionsList = new Map(state.sessionsList);
      sessionsList.set(action.agentId, {
        sessions: action.sessions,
        currentSessionId: action.currentSessionId,
      });
      return { ...state, sessionsList };
    }
    case "set_draft": {
      const drafts = new Map(state.drafts);
      if (action.text) {
        drafts.set(action.agentId, action.text);
      } else {
        drafts.delete(action.agentId);
      }
      return { ...state, drafts };
    }
    case "set_side_panel": {
      const sidePanels = new Map(state.sidePanels);
      if (action.panel === null) {
        sidePanels.delete(action.agentId);
      } else {
        sidePanels.set(action.agentId, action.panel);
      }
      return { ...state, sidePanels };
    }
    case "slash_commands": {
      const slashCommands = new Map(state.slashCommands);
      slashCommands.set(action.agentId, {
        commands: action.commands,
        skills: action.skills,
      });
      return { ...state, slashCommands };
    }
    case "clear_logs": {
      const logs = new Map(state.logs);
      logs.set(action.agentId, []);
      const logEntryIds = new Map(state.logEntryIds);
      logEntryIds.set(action.agentId, new Set());
      return { ...state, logs, logEntryIds };
    }
    case "set_mobile":
      return { ...state, isMobile: action.isMobile };
    case "toggle_mobile_view": {
      const next = state.mobileViewMode === "list" ? "office" : "list";
      if (typeof localStorage !== "undefined")
        localStorage.setItem("isomux-mobile-view", next);
      return { ...state, mobileViewMode: next };
    }
    case "office_settings_updated":
      return {
        ...state,
        office: {
          prompt: action.prompt,
          envFile: action.envFile,
          name: action.name,
        },
      };
    case "tasks":
      return { ...state, tasks: action.tasks, tasksLoaded: true };
    case "set_current_room":
      return { ...state, currentRoom: action.room };
    case "room_created":
      return { ...state, rooms: [...state.rooms, action.room] };
    case "update_status":
      return {
        ...state,
        updateAvailable: action.updateAvailable,
        updateCurrent: action.current,
        updateLatest: action.latest,
      };
    case "room_closed": {
      const idx = state.rooms.findIndex((r) => r.id === action.roomId);
      if (idx < 0) return state;
      const newRooms = [...state.rooms];
      newRooms.splice(idx, 1);
      let currentRoom = state.currentRoom;
      if (currentRoom === idx) currentRoom = 0;
      else if (currentRoom > idx) currentRoom--;
      return { ...state, rooms: newRooms, currentRoom };
    }
    case "room_renamed": {
      const newRooms = state.rooms.map((r) =>
        r.id === action.roomId ? { ...r, name: action.name } : r,
      );
      return { ...state, rooms: newRooms };
    }
    case "room_settings_updated": {
      const newRooms = state.rooms.map((r) =>
        r.id === action.roomId ? { ...r, prompt: action.prompt } : r,
      );
      return { ...state, rooms: newRooms };
    }
    case "users_list": {
      const users = new Map(action.users.map((u) => [u.name.toLowerCase(), u]));
      return { ...state, users, usersLoaded: true };
    }
    case "user_updated": {
      const users = new Map(state.users);
      // On rename, drop the old key so the map doesn't accumulate ghosts.
      if (
        action.prevName &&
        action.prevName.toLowerCase() !== action.user.name.toLowerCase()
      ) {
        users.delete(action.prevName.toLowerCase());
      }
      users.set(action.user.name.toLowerCase(), action.user);
      return { ...state, users };
    }
    case "presence_list":
      return {
        ...state,
        presences: action.entries,
        totalOnlineUsers: action.totalOnlineUsers,
      };
    case "session_context":
      // session_context arrives as the first message on every WS open,
      // including reconnects. Reset the owner-only loaded flags so the
      // AccessPane re-requests fresh lists; otherwise a mint/revoke on
      // another client wouldn't reach a client that disconnected and came
      // back. We keep the cached arrays in place so the UI doesn't flicker
      // to "Loading…" while the refresh is in flight.
      return {
        ...state,
        sessionContext: action.context,
        invitesLoaded: false,
        activeSessionsLoaded: false,
      };
    case "all_rooms_list":
      // Owner-only payload. Members never receive this; the case is
      // still reachable via the dispatcher type union so no special
      // guard is needed.
      return { ...state, allRooms: action.rooms };
    case "invites_list":
      return { ...state, invitesList: action.invites, invitesLoaded: true };
    case "sessions_active_list":
      return {
        ...state,
        activeSessions: action.sessions,
        activeSessionsLoaded: true,
      };
    case "invite_minted": {
      // Surfacing the URL is handled by the AccessPane via a one-shot raw
      // listener; the reducer only needs to keep the optimistic invite list
      // fresh. The server also broadcasts a fresh invites_list, so this is
      // belt-and-suspenders.
      if (action.ok && action.invite) {
        return { ...state, invitesList: [action.invite, ...state.invitesList] };
      }
      return state;
    }
    case "invite_revoked":
      return {
        ...state,
        invitesList: state.invitesList.filter(
          (i) => i.tokenPrefix !== action.tokenPrefix,
        ),
      };
    case "session_revoked":
      return {
        ...state,
        activeSessions: state.activeSessions.filter(
          (s) => s.sessionPrefix !== action.sessionPrefix,
        ),
      };
    case "session_expired":
      return { ...state, sessionExpired: true };
    case "cronjobs_state":
      return {
        ...state,
        cronjobs: action.cronjobs,
        cronjobsPrompt: action.cronjobsPrompt,
        cronjobsLoaded: true,
      };
    case "cronjob_added":
      return { ...state, cronjobs: [...state.cronjobs, action.cronjob] };
    case "cronjob_updated":
      return {
        ...state,
        cronjobs: state.cronjobs.map((c) =>
          c.id === action.cronjob.id ? action.cronjob : c,
        ),
      };
    case "cronjob_deleted":
      return {
        ...state,
        cronjobs: state.cronjobs.filter((c) => c.id !== action.id),
      };
    case "cronjobs_prompt_updated":
      return { ...state, cronjobsPrompt: action.value };
    case "cronjob_runs": {
      const cronjobRunsByJob = new Map(state.cronjobRunsByJob);
      cronjobRunsByJob.set(action.cronjobId, action.runs);
      return { ...state, cronjobRunsByJob };
    }
    case "cronjob_runs_complete":
      return { ...state, cronjobRunsLoaded: true };
    case "cronjob_run_updated": {
      const cronjobRunsByJob = new Map(state.cronjobRunsByJob);
      const existing = cronjobRunsByJob.get(action.run.cronjobId) ?? [];
      const idx = existing.findIndex((r) => r.id === action.run.id);
      const next =
        idx >= 0
          ? existing.map((r) => (r.id === action.run.id ? action.run : r))
          : [...existing, action.run];
      cronjobRunsByJob.set(action.run.cronjobId, next);
      return { ...state, cronjobRunsByJob };
    }
    default:
      return state;
  }
}

const initialState: AppState = {
  agents: [],
  logs: new Map(),
  logEntryIds: new Map(),
  focusedAgentId: null,
  connected: false,
  isMobile: typeof window !== "undefined" ? window.innerWidth < 768 : false,
  mobileViewMode:
    typeof localStorage !== "undefined" &&
    localStorage.getItem("isomux-mobile-view") === "list"
      ? "list"
      : "office",
  needsAttention: new Set(),
  sessionsList: new Map(),
  soundTrigger: { seq: 0, roomId: null },
  drafts: new Map(),
  sidePanels: new Map(),
  recentCwds: [],
  slashCommands: new Map(),
  stateChangedAt: new Map(),
  office: { prompt: null, envFile: null, name: null },
  rooms: [],
  tasks: [],
  tasksLoaded: false,
  cronjobs: [],
  cronjobsLoaded: false,
  cronjobsPrompt: null,
  cronjobRunsByJob: new Map(),
  cronjobRunsLoaded: false,
  currentRoom: 0,
  updateAvailable: false,
  updateCurrent: { sha: "", message: "", date: "" },
  updateLatest: { sha: "", message: "", date: "" },
  users: new Map(),
  usersLoaded: false,
  sessionContext: null,
  allRooms: [],
  invitesList: [],
  invitesLoaded: false,
  activeSessions: [],
  activeSessionsLoaded: false,
  sessionExpired: false,
  hasReceivedInitialState: false,
  presences: [],
  totalOnlineUsers: 0,
  killedAgents: [],
};

const StateCtx = createContext<AppState>(initialState);
const DispatchCtx = createContext<Dispatch<Action>>(() => {});

// Notification sound — AudioContext initialized on first user interaction
let audioCtx: AudioContext | null = null;

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

// Initialize audio on first click anywhere
if (typeof document !== "undefined") {
  document.addEventListener("click", () => ensureAudioContext(), {
    once: true,
  });
}

function playNotificationSound() {
  try {
    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.setValueAtTime(600, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {}
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let legacyMigrated = false;
    connect(
      (msg: ServerMessage) => {
        dispatch(msg as Action);
        if (msg.type === "full_state") dispatch({ type: "connected" });
        // Once both session_context and users_list have arrived, mirror any
        // legacy localStorage prefs (defaultRoomId, notifRooms) into the user
        // record — but only if the server hasn't recorded values for them yet.
        // The session cookie is authoritative for the username; we don't try
        // to coerce the device's old localStorage name onto the session.
        if (msg.type === "session_context" && !legacyMigrated) {
          const legacy = readLegacyUserPrefs();
          if (legacy.defaultRoomId || legacy.notifRooms) {
            send({
              type: "claim_user",
              username: msg.context.username,
              defaultRoomId: legacy.defaultRoomId,
              notifRooms: legacy.notifRooms,
            });
            clearLegacyUserPrefs();
          }
          // Keep localStorage's name aligned to the session so other UI bits
          // that still read getUsername() agree with the cookie identity.
          try {
            localStorage.setItem("isomux-username", msg.context.username);
          } catch {}
          legacyMigrated = true;
        }
      },
      (isConnected: boolean) => {
        if (!isConnected) dispatch({ type: "disconnected" });
      },
    );
  }, []);

  // session_expired: the per-message WS recheck found the session revoked or
  // expired. Reload the page so the next navigation goes through the auth
  // gate and lands the user on the login / bootstrap-invite page.
  useEffect(() => {
    if (!state.sessionExpired) return;
    const id = setTimeout(() => window.location.reload(), 800);
    return () => clearTimeout(id);
  }, [state.sessionExpired]);

  // Track mobile viewport
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function handleResize() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        dispatch({ type: "set_mobile", isMobile: window.innerWidth < 768 });
      }, 150);
    }
    window.addEventListener("resize", handleResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  // Sound notification when tab is hidden and any agent finishes work, gated
  // by the user's per-room notification preference (server-stored).
  const prevSoundTriggerSeq = useRef(0);
  useEffect(() => {
    if (
      state.soundTrigger.seq > prevSoundTriggerSeq.current &&
      document.hidden
    ) {
      const username = getUsername();
      const me = username ? state.users.get(username.toLowerCase()) : undefined;
      const notifRooms = me?.notifRooms ?? [];
      if (shouldNotifyRoom(state.soundTrigger.roomId, notifRooms)) {
        playNotificationSound();
      }
    }
    prevSoundTriggerSeq.current = state.soundTrigger.seq;
  }, [state.soundTrigger, state.users]);

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useAppState() {
  return useContext(StateCtx);
}

export function useDispatch() {
  return useContext(DispatchCtx);
}

// Theme management — persisted to localStorage, applied via data-theme +
// data-theme-mode attributes on <html>. `theme` is the registered id;
// `mode` is the resolved 'dark'|'light' from the THEMES table and drives
// the handful of mode-dependent CSS rules (lamp glow, neon, diff2html).
interface ThemeContextValue {
  theme: string;
  mode: ThemeMode;
  setTheme: (id: string) => void;
  toggleTheme: () => void;
}

const ThemeCtx = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME_ID,
  mode: "dark",
  setTheme: () => {},
  toggleTheme: () => {},
});

// Resolve the OS / browser color-scheme preference. Used as the default when
// the user hasn't picked a theme yet (and when they switch back to following
// system later, via the media-query listener below).
function getSystemThemeId(): string {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return DEFAULT_THEME_ID;
}

const USER_PICK_KEY = "isomux-theme";

function hasUserPickedTheme(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(USER_PICK_KEY) != null;
}

function getInitialThemeId(): string {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(USER_PICK_KEY);
    if (saved) {
      const resolved = getThemeById(saved);
      // If the stored id isn't a known theme, getThemeById falls back to
      // the default — return the canonical id so we don't keep round-
      // tripping the stale value.
      return resolved.id;
    }
  }
  // No explicit user choice: follow the OS preference.
  return getSystemThemeId();
}

const LAST_THEME_KEY = {
  dark: "isomux-theme-dark",
  light: "isomux-theme-light",
} as const;

// Remembers the most recent theme picked within each mode so the moon/sun
// toggle can return the user to their preferred Nord (dark) or Solarized
// Light (light) instead of always reverting to the canonical pair.
function getLastModeTheme(mode: ThemeMode): string {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(LAST_THEME_KEY[mode]);
    if (saved) {
      const resolved = getThemeById(saved);
      if (resolved.mode === mode) return resolved.id;
    }
  }
  return THEMES.find((t) => t.mode === mode)?.id ?? DEFAULT_THEME_ID;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<string>(getInitialThemeId);
  // Track whether the current theme came from an explicit user pick or from
  // the OS preference. While following the OS, we don't persist anything and
  // we live-react to `prefers-color-scheme` changes. Once the user picks a
  // theme (via ThemePicker or the moon/sun toggle), it sticks.
  const [userPicked, setUserPicked] = useState<boolean>(hasUserPickedTheme);
  const resolved: Theme = getThemeById(themeId);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved.id);
    document.documentElement.setAttribute("data-theme-mode", resolved.mode);
    if (userPicked) {
      localStorage.setItem(USER_PICK_KEY, resolved.id);
      localStorage.setItem(LAST_THEME_KEY[resolved.mode], resolved.id);
    }
    const color = resolved.vars["--bg-base"];
    let meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = color;
  }, [resolved, userPicked]);

  // While we're following the OS preference (no explicit pick), swap the
  // theme live if the system flips between dark and light. Stops listening
  // once the user picks something explicit, since their choice should win.
  useEffect(() => {
    if (userPicked) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setThemeId(getSystemThemeId());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [userPicked]);

  // Cross-window sync. Fires when another window on the same origin writes
  // to our localStorage key — covers the landing's theme toggle updating
  // the embedded /demo iframe (this is where isomux.com/demo renders), and
  // the reverse (clicking the wall moon inside the demo updates the
  // landing's palette).
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (e.key !== USER_PICK_KEY && e.key !== null) return;
      if (e.newValue) {
        setUserPicked(true);
        setThemeId(getThemeById(e.newValue).id);
      } else {
        // Key was cleared in another window — go back to following the OS.
        setUserPicked(false);
        setThemeId(getSystemThemeId());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((id: string) => {
    setUserPicked(true);
    setThemeId(getThemeById(id).id);
  }, []);

  // The moon/sun nav button (and the wall sun/moon Easter egg) flip between
  // modes. We jump to the user's most recently picked theme in the opposite
  // mode rather than the canonical Dark/Light pair, so someone using Nord +
  // Solarized Light gets ferried between their two preferred themes.
  const toggleTheme = useCallback(() => {
    setUserPicked(true);
    setThemeId((current) => {
      const currentMode = getThemeById(current).mode;
      const oppositeMode: ThemeMode = currentMode === "dark" ? "light" : "dark";
      return getLastModeTheme(oppositeMode);
    });
  }, []);

  return (
    <ThemeCtx.Provider
      value={{ theme: resolved.id, mode: resolved.mode, setTheme, toggleTheme }}
    >
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeCtx);
}

// Feature flags context — production defaults, demo overrides
const FeaturesCtx = createContext<Features>(PRODUCTION_FEATURES);

export function FeaturesProvider({
  features,
  children,
}: {
  features: Features;
  children: ReactNode;
}) {
  return (
    <FeaturesCtx.Provider value={features}>{children}</FeaturesCtx.Provider>
  );
}

export function useFeatures() {
  return useContext(FeaturesCtx);
}
