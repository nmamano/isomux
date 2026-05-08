import { createContext, useContext, useReducer, useEffect, useRef, useState, useCallback, type ReactNode, type Dispatch } from "react";
import type { AgentInfo, LogEntry, SessionInfo, ServerMessage, SkillInfo, TaskItem, OfficeSettings, RoomWire, SettingsSaveResponse, SettingsValidationResponse, Cronjob, CronjobRun, UserRecord } from "../shared/types.ts";
import { connect, send } from "./ws.ts";
import { type Features, PRODUCTION_FEATURES } from "../shared/features.ts";
import { getUsername, readLegacyUserPrefs, clearLegacyUserPrefs, shouldNotifyRoom } from "./device-settings.ts";

export interface AppState {
  agents: AgentInfo[];
  logs: Map<string, LogEntry[]>; // streamId → entries (streamId = agentId or cronrun-<runId>)
  logEntryIds: Map<string, Set<string>>; // streamId → set of seen entry ids (for O(1) dedupe)
  focusedAgentId: string | null;
  connected: boolean;
  isMobile: boolean;
  mobileViewMode: "list" | "office"; // which view to show on mobile
  needsAttention: Set<string>; // agentIds with unread state changes
  sessionsList: Map<string, { sessions: SessionInfo[]; currentSessionId: string | null }>; // agentId → available sessions
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
  slashCommands: Map<string, { commands: { name: string; description?: string }[]; skills: SkillInfo[] }>; // agentId → available commands
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
  // current device's user is whichever record matches localStorage's
  // isomux-username; null if that key is unset or the record hasn't loaded.
  users: Map<string, UserRecord>;
  usersLoaded: boolean;
}

type Action =
  | { type: "full_state"; agents: AgentInfo[]; recentCwds: string[]; office: OfficeSettings; rooms: RoomWire[] }
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "focus"; agentId: string | null }
  | { type: "connected" }
  | { type: "sessions_list"; agentId: string; sessions: SessionInfo[]; currentSessionId: string | null }
  | { type: "set_draft"; agentId: string; text: string }
  | { type: "set_side_panel"; agentId: string; panel: "terminal" | "editor" | null }
  | { type: "slash_commands"; agentId: string; commands: { name: string; description?: string }[]; skills: SkillInfo[] }
  | { type: "clear_logs"; agentId: string }
  | { type: "set_mobile"; isMobile: boolean }
  | { type: "toggle_mobile_view" }
  | { type: "office_settings_updated"; prompt: string | null; envFile: string | null }
  | { type: "tasks"; tasks: TaskItem[] }
  | { type: "set_current_room"; room: number }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null }
  | { type: "rooms_reordered"; order: string[] }
  | { type: "users_list"; users: UserRecord[] }
  | { type: "user_updated"; user: UserRecord; prevName?: string }
  | SettingsSaveResponse
  | SettingsValidationResponse
  | { type: "update_status"; updateAvailable: boolean; current: { sha: string; message: string; date: string }; latest: { sha: string; message: string; date: string } }
  | { type: "cronjobs_state"; cronjobs: Cronjob[]; cronjobsPrompt: string | null }
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
        const me = username ? state.users.get(username.toLowerCase()) : undefined;
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
        currentRoom,
        logs: new Map(),
        logEntryIds: new Map(),
        needsAttention: new Set(),
        slashCommands: new Map(),
        stateChangedAt: new Map(action.agents.filter((a) => a.state !== "idle" && a.state !== "stopped").map((a) => [a.id, Date.now()])),
      };
    }
    case "agent_added":
      return { ...state, agents: [...state.agents, action.agent] };
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
        focusedAgentId: state.focusedAgentId === action.agentId ? null : state.focusedAgentId,
      };
    }
    case "agent_updated": {
      const newAgents = state.agents.map((a) =>
        a.id === action.agentId ? { ...a, ...action.changes } : a
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
          // Sound: bump seq and capture roomId so the effect can filter on
          // the device's per-room notification preference.
          const roomId = state.rooms[prevAgent.room]?.id ?? null;
          soundTrigger = { seq: state.soundTrigger.seq + 1, roomId };
          // Badge: only when not viewing this agent
          if (state.focusedAgentId !== action.agentId) {
            needsAttention.add(action.agentId);
          }
        }
        return { ...state, agents: newAgents, needsAttention, soundTrigger, stateChangedAt };
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
    case "sessions_list": {
      const sessionsList = new Map(state.sessionsList);
      sessionsList.set(action.agentId, { sessions: action.sessions, currentSessionId: action.currentSessionId });
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
      slashCommands.set(action.agentId, { commands: action.commands, skills: action.skills });
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
      if (typeof localStorage !== "undefined") localStorage.setItem("isomux-mobile-view", next);
      return { ...state, mobileViewMode: next };
    }
    case "office_settings_updated":
      return { ...state, office: { prompt: action.prompt, envFile: action.envFile } };
    case "tasks":
      return { ...state, tasks: action.tasks, tasksLoaded: true };
    case "set_current_room":
      return { ...state, currentRoom: action.room };
    case "room_created":
      return { ...state, rooms: [...state.rooms, action.room] };
    case "update_status":
      return { ...state, updateAvailable: action.updateAvailable, updateCurrent: action.current, updateLatest: action.latest };
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
      const newRooms = state.rooms.map((r) => r.id === action.roomId ? { ...r, name: action.name } : r);
      return { ...state, rooms: newRooms };
    }
    case "room_settings_updated": {
      const newRooms = state.rooms.map((r) => r.id === action.roomId ? { ...r, prompt: action.prompt } : r);
      return { ...state, rooms: newRooms };
    }
    case "users_list": {
      const users = new Map(action.users.map((u) => [u.name.toLowerCase(), u]));
      return { ...state, users, usersLoaded: true };
    }
    case "user_updated": {
      const users = new Map(state.users);
      // On rename, drop the old key so the map doesn't accumulate ghosts.
      if (action.prevName && action.prevName.toLowerCase() !== action.user.name.toLowerCase()) {
        users.delete(action.prevName.toLowerCase());
      }
      users.set(action.user.name.toLowerCase(), action.user);
      return { ...state, users };
    }
    case "cronjobs_state":
      return { ...state, cronjobs: action.cronjobs, cronjobsPrompt: action.cronjobsPrompt, cronjobsLoaded: true };
    case "cronjob_added":
      return { ...state, cronjobs: [...state.cronjobs, action.cronjob] };
    case "cronjob_updated":
      return {
        ...state,
        cronjobs: state.cronjobs.map((c) => c.id === action.cronjob.id ? action.cronjob : c),
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
      const next = idx >= 0
        ? existing.map((r) => r.id === action.run.id ? action.run : r)
        : [...existing, action.run];
      cronjobRunsByJob.set(action.run.cronjobId, next);
      return { ...state, cronjobRunsByJob };
    }
    case "rooms_reordered": {
      // action.order is the new ordering of roomIds
      const idToOldIdx = new Map(state.rooms.map((r, i) => [r.id, i]));
      const newRooms = action.order.map((id) => state.rooms[idToOldIdx.get(id)!]).filter(Boolean);
      // Recompute currentRoom: find where the previously-current room landed
      const prevId = state.rooms[state.currentRoom]?.id;
      const newCurrentRoom = prevId ? Math.max(0, action.order.indexOf(prevId)) : 0;
      // Remap agents' numeric room index to the new positions
      const idToNewIdx = new Map(newRooms.map((r, i) => [r.id, i]));
      const newAgents = state.agents.map((a) => {
        const oldId = state.rooms[a.room]?.id;
        if (!oldId) return a;
        const newIdx = idToNewIdx.get(oldId) ?? a.room;
        return newIdx !== a.room ? { ...a, room: newIdx } : a;
      });
      return { ...state, rooms: newRooms, agents: newAgents, currentRoom: newCurrentRoom };
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
  mobileViewMode: (typeof localStorage !== "undefined" && localStorage.getItem("isomux-mobile-view") === "list") ? "list" : "office",
  needsAttention: new Set(),
  sessionsList: new Map(),
  soundTrigger: { seq: 0, roomId: null },
  drafts: new Map(),
  sidePanels: new Map(),
  recentCwds: [],
  slashCommands: new Map(),
  stateChangedAt: new Map(),
  office: { prompt: null, envFile: null },
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
  document.addEventListener("click", () => ensureAudioContext(), { once: true });
}

function playNotificationSound() {
  try {
    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") ctx.resume();
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
    let claimed = false;
    connect((msg: ServerMessage) => {
      dispatch(msg as Action);
      if (msg.type === "full_state") dispatch({ type: "connected" });
      // After the server's users_list arrives, ensure our localStorage
      // username is registered server-side. If the record already exists the
      // server treats this as a no-op; otherwise it creates the record using
      // any legacy localStorage prefs we might have.
      if (msg.type === "users_list" && !claimed) {
        const username = getUsername();
        if (username) {
          const key = username.toLowerCase();
          const exists = msg.users.some((u) => u.name.toLowerCase() === key);
          if (!exists) {
            const legacy = readLegacyUserPrefs();
            send({ type: "claim_user", username, defaultRoomId: legacy.defaultRoomId, notifRooms: legacy.notifRooms });
          }
          // Whether the record was just created or already existed, the
          // legacy localStorage keys are now redundant. Drop them so they
          // don't drift if the user later edits server-side prefs.
          clearLegacyUserPrefs();
          claimed = true;
        }
      }
    });
  }, []);

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
    if (state.soundTrigger.seq > prevSoundTriggerSeq.current && document.hidden) {
      const username = getUsername();
      const me = username ? state.users.get(username.toLowerCase()) : undefined;
      const notifRooms = me?.notifRooms ?? "all";
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

// Theme management — persisted to localStorage, applied via data-theme attribute on <html>
type Theme = "dark" | "light";
const ThemeCtx = createContext<{ theme: Theme; toggleTheme: () => void }>({ theme: "dark", toggleTheme: () => {} });

function getInitialTheme(): Theme {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem("isomux-theme");
    if (saved === "light" || saved === "dark") return saved;
  }
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("isomux-theme", theme);
    const color = theme === "dark" ? "#0a0e16" : "#f0f2f6";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = color;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return <ThemeCtx.Provider value={{ theme, toggleTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}

// Feature flags context — production defaults, demo overrides
const FeaturesCtx = createContext<Features>(PRODUCTION_FEATURES);

export function FeaturesProvider({ features, children }: { features: Features; children: ReactNode }) {
  return <FeaturesCtx.Provider value={features}>{children}</FeaturesCtx.Provider>;
}

export function useFeatures() {
  return useContext(FeaturesCtx);
}
