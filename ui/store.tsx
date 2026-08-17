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
  SlideFailureReason,
  SlideRecord,
  TaskItem,
  AppWire,
  OfficeSettings,
  OfficeWire,
  RoomWire,
  Cronjob,
  CronjobRun,
  PresenceInfo,
  UserRecord,
  UserPublicWire,
  SessionContext,
  InviteWire,
  SessionWire,
  UpdateStatusWire,
} from "../shared/types.ts";
import {
  type UserView,
  upsertUserView,
  rebuildUserViews,
} from "./user-merge.ts";
import { resolveSelectedRoomId, applyRoomClose } from "./roomSelection.ts";
import { connect } from "./ws.ts";
import { apiFetch } from "./api.ts";
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
  type Theme,
  type ThemeMode,
} from "./themes.ts";

export interface AppState {
  agents: AgentInfo[];
  logs: Map<string, LogEntry[]>; // streamId → entries (streamId = agentId or cronrun-<runId>)
  logEntryIds: Map<string, Set<string>>; // streamId → set of seen entry ids (for O(1) dedupe)
  // Reconnect replay window, or null outside one. Every WS (re)connect sends
  // full_state and then replays each visible agent's cached transcript one
  // log_entry frame at a time. While this is set those frames land HERE
  // instead of in `logs`, so the view keeps showing the conversation it
  // already had; the server's `log_replay_complete` fence swaps the buffer in
  // atomically. See the full_state case for why the swap replaces rather than
  // merges.
  logsReplay: {
    logs: Map<string, LogEntry[]>;
    logEntryIds: Map<string, Set<string>>;
    seq: number; // identifies the window (bumped when one opens)
  } | null;
  // Slide Mode: agentId → (turn entryId → generated slide). Seeded by the
  // slides GET on deck open, updated live by `slide_ready` pushes, cleared for
  // an agent on a conversation-boundary clear_logs. See DeckView.
  slides: Map<string, Map<string, SlideRecord>>;
  // Slide Mode: agentId → turn entryIds whose generation FAILED terminally. The
  // deck renders its raw-answer fallback for exactly these, so what the viewer
  // sees is a reported server outcome rather than a guess from elapsed time. An
  // entry leaves the set when a slide lands for it or the viewer retries.
  slideFailed: Map<string, Set<string>>;
  focusedAgentId: string | null;
  connected: boolean;
  // Bumped on every full_state, i.e. every time the store is rehydrated from
  // scratch. This, not `connected`, is the reliable "everything you were
  // holding was just dropped" signal: ws.ts's onVisible() reconnects a frozen
  // mobile socket directly (dead socket, ping throw, pong timeout) without
  // ever calling connHandler(false), so `connected` can stay true straight
  // through a reconnect. Views that cache server data outside the replay set
  // key their refetch on this (CronjobRunView).
  hydrationEpoch: number;
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
  // Agent-built apps. Fetched by AppsView when the tab opens (an app list costs
  // a systemd read on the server, so no session pays for a tab it never opens)
  // and kept fresh by the app_upserted / app_deleted deltas. full_state does
  // NOT carry apps and must never clear this slice - AppsView re-fetches on
  // hydrationEpoch instead.
  apps: AppWire[];
  appsLoaded: boolean;
  // Bumped by every app delta. A list GET is a snapshot of the moment it was
  // ISSUED, so a slow one can land after a delta that supersedes it and
  // resurrect an app somebody just deleted. AppsView captures this when it
  // starts a fetch and hands it back on apps_loaded; a replacement whose
  // revision has moved is refused. Ordering GETs against each other is not
  // enough - the race is a GET against a DELTA.
  appsRevision: number;
  cronjobs: Cronjob[];
  cronjobsLoaded: boolean;
  cronjobsPrompt: string | null;
  cronjobRunsByJob: Map<string, CronjobRun[]>; // jobId → run list (loaded on demand)
  cronjobRunsLoaded: boolean;
  currentRoomId: string | null; // selected room id (view selection only; null when no rooms visible)
  updateAvailable: boolean;
  // Full mode-discriminated status behind the banner (null until the first
  // update_status arrives). "commit" = source-checkout notice (release +
  // main-drift context), "release" = a new release on an updater-managed box.
  updateInfo: UpdateStatusWire | null;
  // Server-stored boss profiles. `users` is keyed by lowercase(name). The
  // current device's user is identified by `sessionContext.username`, which
  // the server sends right after WS open from the session cookie. Pre-auth
  // setups have null until the server emits session_context.
  users: Map<string, UserView>;
  usersLoaded: boolean;
  // Owner-only access state. Both maps stay empty (and the corresponding
  // owner UI is hidden) for members and unauthenticated states.
  sessionContext: SessionContext | null;
  // Owner-only: unfiltered global rooms list, used by the Allowed Rooms
  // editor in UserSettingsView so an owner with a restricted
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
  // whose currentRoomId matches state.currentRoomId (rooms render
  // independently). Self entry (matching state.sessionContext.
  // connectionId, per-WS not per-cookie) is hidden client-side
  // unconditionally - the boss never sees their own avatar. The
  // server still sends it so OTHER tabs/devices of the same user
  // remain visible as their own ghosts (each with its own
  // connectionId).
  presences: PresenceInfo[];
  // Distinct online userIds across the WHOLE office (server counts ALL
  // presence entries including off-scene sessions). Same value for
  // every recipient - answers "who is online anywhere", not "who is in
  // a room I can see". Renders as the total chip in RoomTabBar.
  totalOnlineUsers: number;
  // The id set behind totalOnlineUsers (same all-audience aggregate, same
  // broadcast cadence). Backs the per-user online dot on the Users page
  // roster - `presences` can't answer it (room-filtered per recipient,
  // off-scene sessions omitted).
  onlineUserIds: string[];
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
      office: OfficeWire;
      rooms: RoomWire[];
      killedAgents: KilledAgentSummary[];
    }
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string; roomId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "killed_agent_added"; agent: KilledAgentSummary }
  | { type: "killed_agent_removed"; agentId: string; lastRoomId: string }
  | { type: "log_entry"; entry: LogEntry }
  // CLIENT-LOCAL (not a ServerMessage): CronjobRunView dispatches this after the
  // REST cron.getRun fetch to merge the historical run transcript into the same
  // logs stream that live `log_entry` events feed during an active run. Reuses
  // the per-stream id dedupe (logEntryIds), so it is equivalent to replaying
  // each entry as a `log_entry` - just one reducer pass instead of N.
  | { type: "log_entries_batch"; entries: LogEntry[] }
  // Slide Mode: a single slide finished generating (WS push).
  | {
      type: "slide_ready";
      agentId: string;
      sessionId: string;
      entryId: string;
      slide: SlideRecord;
    }
  // Slide Mode: a slide generation failed terminally (WS push). The deck stops
  // waiting on it - this is the signal that a pending slide is never coming.
  | {
      type: "slide_failed";
      agentId: string;
      sessionId: string;
      entryId: string;
      reason: SlideFailureReason;
    }
  // CLIENT-LOCAL: DeckView dispatches this when it (re)requests a slide, to drop
  // an earlier failure mark so the retry shows the spinner instead of the stale
  // fallback. Also covers the ↻ control.
  | { type: "slide_retry"; agentId: string; entryId: string }
  // CLIENT-LOCAL: DeckView dispatches this after the slides GET to seed the
  // per-agent slide map from cached slides.
  | {
      type: "slides_loaded";
      agentId: string;
      slides: Record<string, SlideRecord>;
    }
  // CLIENT-LOCAL: DeckView drops a cached slide the server reported it is
  // regenerating (a stale placeholder whose turn gained text), so the deck shows
  // the Generating spinner until the fresh slide_ready arrives. Compare-and-
  // delete: `prevSlide` is the record seen at request time; the reducer removes
  // it ONLY if it is still the current record, so a slide_ready that raced in
  // first (WS/HTTP ordering isn't guaranteed) is never clobbered.
  | {
      type: "slide_invalidate";
      agentId: string;
      entryId: string;
      prevSlide: SlideRecord;
    }
  | { type: "focus"; agentId: string | null }
  | { type: "connected" }
  | { type: "disconnected" }
  // CLIENT-LOCAL (no longer a ServerMessage): ContextMenu dispatches this after
  // the REST agents.listSessions fetch (GET /api/agents/:id/sessions) to seed the
  // per-agent sessions map. The WS sessions_list push it replaced was retired in
  // Phase 3d slice 6a.
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
      commands: {
        name: string;
        description?: string;
        aliasFor?: string;
        autoRun?: boolean;
      }[];
      skills: SkillInfo[];
    }
  | { type: "clear_logs"; agentId: string; rollback?: boolean }
  // Ends a reconnect replay window and swaps the buffered transcripts in. Sent
  // by the server after the last replayed frame; StoreProvider also synthesizes
  // one on a timeout, for the window where a fresh UI build is talking to a
  // server old enough not to send it (UI builds go live before a restart).
  | { type: "log_replay_complete" }
  | { type: "set_mobile"; isMobile: boolean }
  | { type: "toggle_mobile_view" }
  | {
      type: "office_settings_updated";
      prompt: string | null;
      name: string | null;
    }
  | { type: "tasks"; tasks: TaskItem[] }
  | { type: "task_upserted"; task: TaskItem }
  | { type: "task_deleted"; taskId: string }
  // CLIENT-LOCAL (not a ServerMessage): AppsView dispatches this after its REST
  // apps.list fetch. The fetch REPLACES the slice, which is what converges the
  // list after a missed delta or a state change systemd made on its own.
  | { type: "apps_loaded"; apps: AppWire[]; revision: number }
  | { type: "app_upserted"; app: AppWire }
  | { type: "app_deleted"; name: string }
  | { type: "set_current_room"; roomId: string }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null }
  | { type: "users_list"; users: UserPublicWire[] }
  | { type: "user_updated"; user: UserPublicWire; prevName?: string }
  | { type: "users_admin_list"; users: UserRecord[] }
  | { type: "user_admin_updated"; user: UserRecord; prevName?: string }
  | { type: "user_self_updated"; user: UserRecord; prevName?: string }
  | { type: "session_context"; context: SessionContext }
  | {
      type: "presence_list";
      entries: PresenceInfo[];
      totalOnlineUsers: number;
      onlineUserIds: string[];
    }
  | { type: "all_rooms_list"; rooms: RoomWire[] }
  | { type: "invites_list"; invites: InviteWire[] }
  | { type: "sessions_active_list"; sessions: SessionWire[] }
  | { type: "invite_revoked"; tokenPrefix: string }
  | { type: "session_revoked"; sessionPrefix: string }
  | { type: "session_expired" }
  | ({ type: "update_status" } & UpdateStatusWire)
  | {
      type: "cronjobs_state";
      cronjobs: Cronjob[];
      cronjobsPrompt: string | null;
    }
  | { type: "cronjob_added"; cronjob: Cronjob }
  | { type: "cronjob_updated"; cronjob: Cronjob }
  | { type: "cronjob_deleted"; id: string }
  | { type: "cronjobs_prompt_updated"; value: string | null }
  // cronjob_runs + cronjob_runs_loaded are CLIENT-LOCAL actions (NOT
  // ServerMessage members): CronjobsView dispatches them after the REST
  // cron.listRuns / cron.listAllRuns fetches to seed cronjobRunsByJob. Live
  // cronjob_run_updated events (still on the wire) merge into the same map.
  | { type: "cronjob_runs"; cronjobId: string; runs: CronjobRun[] }
  | {
      type: "cronjob_runs_loaded";
      jobs: { cronjobId: string; runs: CronjobRun[] }[];
    }
  | { type: "cronjob_run_updated"; run: CronjobRun };

// States that warrant attention
const ATTENTION_STATES = new Set(["idle", "error", "waiting_for_response"]);

// Slide Mode: drop one turn's failure mark, returning the map unchanged when
// there was nothing to clear (so an unrelated slide_ready doesn't rerender every
// deck consumer).
function withoutFailure(
  slideFailed: Map<string, Set<string>>,
  agentId: string,
  entryId: string,
): Map<string, Set<string>> {
  const forAgent = slideFailed.get(agentId);
  if (!forAgent?.has(entryId)) return slideFailed;
  const next = new Map(slideFailed);
  const updated = new Set(forAgent);
  updated.delete(entryId);
  next.set(agentId, updated);
  return next;
}

// Silent fallback for a `log_replay_complete` that never arrives. The one case
// that actually happens: a UI build goes live on main as soon as it is built,
// while the server it talks to only picks up its own changes on restart - so
// there is a window where a new client is talking to a server that does not
// send the fence. Also covers a dropped frame. Runs from the moment the window
// opens; when the fence does arrive this never fires.
const LOG_REPLAY_FALLBACK_MS = 3000;

// Apply a clear (or removal) of one stream to a replay buffer in flight, so
// the eventual commit agrees with what already happened to the live logs.
// Outside a replay window this is a no-op.
function clearStreamInReplay(
  replay: AppState["logsReplay"],
  streamId: string,
  mode: "clear" | "delete" = "clear",
): AppState["logsReplay"] {
  if (!replay) return replay;
  const logs = new Map(replay.logs);
  const logEntryIds = new Map(replay.logEntryIds);
  if (mode === "delete") {
    logs.delete(streamId);
    logEntryIds.delete(streamId);
  } else {
    logs.set(streamId, []);
    logEntryIds.set(streamId, new Set());
  }
  return { ...replay, logs, logEntryIds };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "full_state": {
      // Keep whichever room the user was viewing if it still exists (e.g.
      // across a server reconnect); otherwise fall back to the first visible
      // room. The Default Room preference was removed - reload view-restore
      // (App.tsx / loadSavedView) reopens the last room on a page reload, and
      // this first-visible fallback covers a genuinely fresh session.
      const currentRoomId = resolveSelectedRoomId(
        action.rooms,
        state.currentRoomId,
      );
      // Wiping `logs` here is what made the conversation blank out and rebuild
      // on every mobile app switch: a backgrounded phone's socket freezes, the
      // resume ping in ws.ts reconnects, and the server answers with
      // full_state followed by a frame-per-entry replay of every visible
      // agent's transcript. So when we already have entries, keep rendering
      // them and buffer the replay instead (see AppState.logsReplay).
      //
      // The eventual swap REPLACES rather than merges, which is what the wipe
      // was protecting: a client that was disconnected across a /clear, a
      // resume, or an edit-fork never saw that clear_logs, and merging would
      // concatenate two conversations. The replayed set is the server's, so
      // taking it wholesale is correct in both cases.
      //
      // Only the FOCUSED agent's transcript is ever on screen (App.tsx renders
      // logs.get(focusedAgent.id), and no other AGENT stream is rendered
      // anywhere - CronjobRunView reads its own cronrun-<runId> stream, which
      // the server's agent-only replay never covers either way), so that is the
      // only one worth holding across the window. Every other
      // stream is dropped right here as before, which keeps the transient
      // double-hold to one conversation instead of every visible agent's -
      // transcripts run to megabytes and phones are where this matters.
      //
      // Nothing cached for it (a genuinely fresh connect, or no agent open)
      // means nothing to protect - stay on the straight-through path so a cold
      // start paints as it goes.
      const focusedId = state.focusedAgentId;
      const heldLogs = focusedId ? state.logs.get(focusedId) : undefined;
      const holding = focusedId != null && (heldLogs?.length ?? 0) > 0;
      return {
        ...state,
        agents: action.agents,
        recentCwds: action.recentCwds,
        office: {
          prompt: action.office.prompt,
          name: action.office.name,
          // OfficeWire omits envFile for members; coerce to null for the
          // store's OfficeSettings shape. Owners carry the real value.
          envFile: action.office.envFile ?? null,
        },
        rooms: action.rooms,
        killedAgents: action.killedAgents,
        currentRoomId,
        logs:
          holding && focusedId
            ? new Map([[focusedId, heldLogs ?? []]])
            : new Map(),
        logEntryIds:
          holding && focusedId
            ? new Map([
                [focusedId, state.logEntryIds.get(focusedId) ?? new Set()],
              ])
            : new Map(),
        logsReplay: holding
          ? {
              logs: new Map(),
              logEntryIds: new Map(),
              seq: (state.logsReplay?.seq ?? 0) + 1,
            }
          : null,
        hydrationEpoch: state.hydrationEpoch + 1,
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
      // Same reason as clear_logs: a buffered replay must not resurrect the
      // transcript of an agent that is gone.
      const logsReplay = clearStreamInReplay(
        state.logsReplay,
        action.agentId,
        "delete",
      );
      const needsAttention = new Set(state.needsAttention);
      needsAttention.delete(action.agentId);
      const sidePanels = new Map(state.sidePanels);
      sidePanels.delete(action.agentId);
      return {
        ...state,
        agents: state.agents.filter((a) => a.id !== action.agentId),
        logs,
        logEntryIds,
        logsReplay,
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
          // another, the receiver answers and idles) stays silent - see
          // turnHadHumanInput on the server side.
          if (prevAgent.turnHadHumanInput) {
            const roomId = prevAgent.roomId;
            soundTrigger = { seq: state.soundTrigger.seq + 1, roomId };
          }
          // Badge: only when not viewing this agent. Set regardless of input
          // source - the dot is a "this agent stopped, you might want to
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
      // stays pure - future consumers comparing Set identity won't see
      // stale references. Set.add returns the Set, so the chained form
      // works for the new-Set case.
      // Inside a reconnect replay window the entry goes to the buffer instead
      // of the rendered logs, and stays invisible until the fence commits it.
      const replay = state.logsReplay;
      const srcLogs = replay ? replay.logs : state.logs;
      const srcIds = replay ? replay.logEntryIds : state.logEntryIds;
      const streamId = action.entry.agentId;
      const seen = srcIds.get(streamId);
      if (seen?.has(action.entry.id)) return state;
      const logs = new Map(srcLogs);
      const logEntryIds = new Map(srcIds);
      logEntryIds.set(streamId, new Set(seen).add(action.entry.id));
      const entries = logs.get(streamId) ?? [];
      logs.set(streamId, [...entries, action.entry]);
      if (replay) {
        return {
          ...state,
          logsReplay: { ...replay, logs, logEntryIds },
        };
      }
      return { ...state, logs, logEntryIds };
    }
    case "log_entries_batch": {
      // Merge a fetched historical batch into the per-stream logs, reusing the
      // log_entry dedupe (logEntryIds Set, keyed by entry.agentId). Behaviorally
      // identical to dispatching log_entry per entry, but clones each touched
      // stream's Set + array once instead of N times. Unseen entries append;
      // already-seen ids are skipped, so live entries that overlap the batch are
      // neither dropped nor duplicated. Render-time sorting (in the view) orders
      // the merged stream by timestamp.
      // Inside a reconnect replay window the batch merges into the buffer, on
      // the same terms as a single log_entry.
      const replay = state.logsReplay;
      const srcLogs = replay ? replay.logs : state.logs;
      const srcIds = replay ? replay.logEntryIds : state.logEntryIds;
      const seenByStream = new Map<string, Set<string>>();
      const arrByStream = new Map<string, LogEntry[]>();
      let changed = false;
      for (const entry of action.entries) {
        const streamId = entry.agentId;
        let seen = seenByStream.get(streamId);
        let arr = arrByStream.get(streamId);
        if (seen === undefined || arr === undefined) {
          seen = new Set(srcIds.get(streamId) ?? []);
          arr = [...(srcLogs.get(streamId) ?? [])];
          seenByStream.set(streamId, seen);
          arrByStream.set(streamId, arr);
        }
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        arr.push(entry);
        changed = true;
      }
      if (!changed) return state;
      const logs = new Map(srcLogs);
      const logEntryIds = new Map(srcIds);
      for (const [streamId, seen] of seenByStream)
        logEntryIds.set(streamId, seen);
      for (const [streamId, arr] of arrByStream) logs.set(streamId, arr);
      if (replay) {
        return {
          ...state,
          logsReplay: { ...replay, logs, logEntryIds },
        };
      }
      return { ...state, logs, logEntryIds };
    }
    case "slide_ready": {
      const slides = new Map(state.slides);
      const forAgent = new Map(slides.get(action.agentId) ?? []);
      forAgent.set(action.entryId, action.slide);
      slides.set(action.agentId, forAgent);
      // A slide landing supersedes any earlier failure for that turn (a retry
      // succeeded), so the deck stops showing the fallback.
      return {
        ...state,
        slides,
        slideFailed: withoutFailure(
          state.slideFailed,
          action.agentId,
          action.entryId,
        ),
      };
    }
    case "slide_failed": {
      // A turn that already has a RENDERED slide keeps it: this is a regenerate
      // that failed, and the standing slide is a better answer than the raw text.
      //
      // A PLACEHOLDER record is not that. It is a stale record being reconciled,
      // and the pending ensure response deletes it (slide_invalidate) - so
      // dropping the failure here would lose it: WS can beat HTTP, and then the
      // invalidate leaves the turn with neither a slide nor a mark, spinning and
      // re-failing every watchdog window. Record it; the placeholder still wins
      // on screen while it is there, and the mark takes over when it goes.
      const existing = state.slides.get(action.agentId)?.get(action.entryId);
      if (existing && !existing.placeholder) return state;
      const slideFailed = new Map(state.slideFailed);
      const forAgent = new Set(slideFailed.get(action.agentId) ?? []);
      forAgent.add(action.entryId);
      slideFailed.set(action.agentId, forAgent);
      return { ...state, slideFailed };
    }
    case "slide_retry": {
      return {
        ...state,
        slideFailed: withoutFailure(
          state.slideFailed,
          action.agentId,
          action.entryId,
        ),
      };
    }
    case "slides_loaded": {
      const slides = new Map(state.slides);
      // Merge (not replace): a live slide_ready that raced ahead of the GET must
      // not be clobbered by the older cached snapshot.
      const forAgent = new Map(slides.get(action.agentId) ?? []);
      for (const [entryId, rec] of Object.entries(action.slides)) {
        if (!forAgent.has(entryId)) forAgent.set(entryId, rec);
      }
      slides.set(action.agentId, forAgent);
      return { ...state, slides };
    }
    case "slide_invalidate": {
      const forAgent = state.slides.get(action.agentId);
      // Compare-and-delete by reference: only drop the exact record the client
      // saw at request time. If a fresher slide_ready already replaced it, keep
      // the new one - never delete a record we didn't request the drop of.
      if (forAgent?.get(action.entryId) !== action.prevSlide) return state;
      const slides = new Map(state.slides);
      const next = new Map(forAgent);
      next.delete(action.entryId);
      slides.set(action.agentId, next);
      return { ...state, slides };
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
      // Mirror into a replay buffer in flight, or the commit would put the
      // just-cleared conversation back a moment later.
      const logsReplay = clearStreamInReplay(state.logsReplay, action.agentId);
      // A conversation boundary (new-conversation/clear, resume, edit-fork)
      // retires the unread dot everywhere: the dot points at a turn that just
      // got wiped/replaced. Server-broadcast, so ALL connected clients clear
      // in lockstep - previously only the clearing client's dot went away
      // (via its own focus), and everyone else kept a stale dot. A rollback
      // clear (failed edit-fork restoring the PRIOR timeline) is not a
      // boundary - the old unseen result comes back, so the dot stays.
      if (action.rollback) return { ...state, logs, logEntryIds, logsReplay };
      const needsAttention = new Set(state.needsAttention);
      needsAttention.delete(action.agentId);
      // A new conversation replaces the deck: drop this agent's cached slides
      // (and any failure marks) so stale state can't bleed into the fresh turns'
      // positions.
      const slides = new Map(state.slides);
      slides.delete(action.agentId);
      const slideFailed = new Map(state.slideFailed);
      slideFailed.delete(action.agentId);
      return {
        ...state,
        logs,
        logEntryIds,
        logsReplay,
        needsAttention,
        slides,
        slideFailed,
      };
    }
    case "log_replay_complete": {
      if (!state.logsReplay) return state;
      return {
        ...state,
        logs: state.logsReplay.logs,
        logEntryIds: state.logsReplay.logEntryIds,
        logsReplay: null,
      };
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
      // envFile is owner-only and no longer rides this all-audience event
      // (3b.5). PRESERVE the existing office.envFile (an owner's loaded value)
      // and update only the public fields, so the event never blanks it.
      return {
        ...state,
        office: { ...state.office, prompt: action.prompt, name: action.name },
      };
    // Whole-board hydration (connect, or this user's room access changed).
    case "tasks":
      return { ...state, tasks: action.tasks, tasksLoaded: true };
    // One task arrived: replace it in place if we already hold it, otherwise
    // append. Both cases are real - an update to a task we know, and a task
    // becoming visible for the first time (a re-file into a room we can access,
    // or a fresh create). Row order doesn't matter: the board sorts client-side.
    case "task_upserted": {
      const idx = state.tasks.findIndex((t) => t.id === action.task.id);
      const tasks =
        idx === -1
          ? [...state.tasks, action.task]
          : state.tasks.map((t) => (t.id === action.task.id ? action.task : t));
      return { ...state, tasks };
    }
    // Drop a task: deleted, or re-filed out of our reach. Unknown ids are a
    // no-op rather than an error - the server only sends this to recipients who
    // could see the task, but a race against hydration shouldn't break the board.
    case "task_deleted": {
      if (!state.tasks.some((t) => t.id === action.taskId)) return state;
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== action.taskId),
      };
    }
    // Whole-list replace, not a merge: this is the poll/refetch result, so an
    // app that has gone from it is gone, and stale rows must not survive.
    //
    // Unless a delta landed while it was in flight, in which case the snapshot
    // is older than what we already hold and replacing would undo it. Refused,
    // not merged - the deltas are authoritative and the next poll converges the
    // rest. appsLoaded still flips: the fetch DID succeed, and leaving the tab
    // on its loading state over a won race would be its own bug.
    case "apps_loaded":
      if (action.revision !== state.appsRevision) {
        return { ...state, appsLoaded: true };
      }
      return { ...state, apps: action.apps, appsLoaded: true };
    // Keyed by NAME - an app has no separate id, and a name is bound to one app
    // forever. Same upsert reasoning as tasks: for a recipient this can be the
    // first time they see the app, so replace-or-append rather than two events.
    case "app_upserted": {
      const idx = state.apps.findIndex((a) => a.name === action.app.name);
      const apps =
        idx === -1
          ? [...state.apps, action.app]
          : state.apps.map((a) =>
              a.name === action.app.name ? action.app : a,
            );
      return { ...state, apps, appsRevision: state.appsRevision + 1 };
    }
    // Unknown names are a no-op: the server only tells recipients who could see
    // the app, but a delta racing the tab's first fetch shouldn't break the list.
    case "app_deleted": {
      // The revision moves even for a name we do not hold: an in-flight list
      // GET may well carry that app, and letting it land would resurrect it.
      if (!state.apps.some((a) => a.name === action.name)) {
        return { ...state, appsRevision: state.appsRevision + 1 };
      }
      return {
        ...state,
        apps: state.apps.filter((a) => a.name !== action.name),
        appsRevision: state.appsRevision + 1,
      };
    }
    case "set_current_room":
      return { ...state, currentRoomId: action.roomId };
    case "room_created":
      // Select the new room only when nothing is currently selected (e.g. a
      // member whose visible rooms were all closed, then gains a freshly
      // created room via room_created with no intervening full_state). When a
      // room is already selected, creating another doesn't switch to it.
      return {
        ...state,
        rooms: [...state.rooms, action.room],
        currentRoomId: state.currentRoomId ?? action.room.id,
      };
    case "update_status": {
      // Rebuild the wire union without the WS `type` tag.
      const updateInfo: UpdateStatusWire =
        action.mode === "commit"
          ? {
              mode: "commit",
              updateAvailable: action.updateAvailable,
              current: action.current,
              latest: action.latest,
              releaseStanding: action.releaseStanding,
              mainAhead: action.mainAhead,
            }
          : {
              mode: "release",
              updateAvailable: action.updateAvailable,
              current: action.current,
              latest: action.latest,
              securityUpdate: action.securityUpdate,
            };
      return {
        ...state,
        updateAvailable: action.updateAvailable,
        updateInfo,
      };
    }
    case "room_closed": {
      const result = applyRoomClose(
        state.rooms,
        action.roomId,
        state.currentRoomId,
      );
      if (!result) return state;
      return {
        ...state,
        rooms: result.rooms,
        currentRoomId: result.currentRoomId,
      };
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
    case "users_list":
      // Public roster (audience all). Authoritative membership: rebuild from it
      // (drops removed users) while preserving any sensitive fields already
      // held for survivors (self via user_self_updated, admin via users_admin_*).
      return {
        ...state,
        users: rebuildUserViews(state.users, action.users),
        usersLoaded: true,
      };
    case "users_admin_list":
      // Owners-audience FULL roster. Also authoritative membership; full records
      // win over any public-only entry held for the same user.
      return {
        ...state,
        users: rebuildUserViews(state.users, action.users),
        usersLoaded: true,
      };
    case "user_updated":
    case "user_admin_updated":
    case "user_self_updated":
      // One merge core for all three: a public wire refreshes public columns
      // only (sensitive fields preserved); a full (admin/self) record overwrites
      // every column. Rename carries sensitive fields across the key migration.
      return {
        ...state,
        users: upsertUserView(state.users, action.user, action.prevName),
      };
    case "presence_list":
      return {
        ...state,
        presences: action.entries,
        totalOnlineUsers: action.totalOnlineUsers,
        onlineUserIds: action.onlineUserIds,
      };
    case "session_context":
      // session_context arrives as the first message on every WS open,
      // including reconnects. Reset the owner-only loaded flags so the
      // account panes re-request fresh lists; otherwise a mint/revoke on
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
    // Client-local seed for a single job (cron.listRuns REST fetch).
    case "cronjob_runs": {
      const cronjobRunsByJob = new Map(state.cronjobRunsByJob);
      cronjobRunsByJob.set(action.cronjobId, action.runs);
      return { ...state, cronjobRunsByJob };
    }
    // Client-local seed for the all-runs fetch (cron.listAllRuns REST). Per-job
    // set (NOT a wholesale replace), so a job absent from the payload keeps its
    // existing entry - preserving the old per-job cronjob_runs stream behavior.
    case "cronjob_runs_loaded": {
      const cronjobRunsByJob = new Map(state.cronjobRunsByJob);
      for (const { cronjobId, runs } of action.jobs) {
        cronjobRunsByJob.set(cronjobId, runs);
      }
      return { ...state, cronjobRunsByJob, cronjobRunsLoaded: true };
    }
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

export const initialState: AppState = {
  agents: [],
  logs: new Map(),
  logEntryIds: new Map(),
  logsReplay: null,
  slides: new Map(),
  slideFailed: new Map(),
  focusedAgentId: null,
  connected: false,
  hydrationEpoch: 0,
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
  apps: [],
  appsLoaded: false,
  appsRevision: 0,
  cronjobs: [],
  cronjobsLoaded: false,
  cronjobsPrompt: null,
  cronjobRunsByJob: new Map(),
  cronjobRunsLoaded: false,
  currentRoomId: null,
  updateAvailable: false,
  updateInfo: null,
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
  onlineUserIds: [],
  killedAgents: [],
};

const StateCtx = createContext<AppState>(initialState);
const DispatchCtx = createContext<Dispatch<Action>>(() => {});

// Notification sound - AudioContext initialized on first user interaction
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
        // legacy localStorage notifRooms pref into the user record - but only
        // if the server hasn't recorded a value yet. The session cookie is
        // authoritative for the username; we don't try to coerce the device's
        // old localStorage name onto the session. (Legacy defaultRoom prefs are
        // no longer migrated - the Default Room setting was removed.)
        if (msg.type === "session_context" && !legacyMigrated) {
          const legacy = readLegacyUserPrefs();
          // One-shot localStorage->server migration of legacy view prefs (the
          // former claim_user). A PRESENT value goes to its self-only view.*
          // route; an absent/empty value is "nothing to migrate" (no request),
          // never a clear-to-[], so a reload with no legacy keys can't wipe
          // server-side prefs. Fire-and-forget; the server clamps to the
          // caller's accessible rooms.
          const hasLegacy = legacy.notifRooms.length > 0;
          if (legacy.notifRooms.length > 0) {
            apiFetch("PUT", "/api/me/view/notif-rooms", {
              notifRooms: legacy.notifRooms,
            }).catch(() => {});
          }
          if (hasLegacy) {
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

  // Nothing normally closes a replay window here - the server's
  // `log_replay_complete` does, straight through the reducer. This is only the
  // fallback for a server too old to send it (see LOG_REPLAY_FALLBACK_MS).
  // Deps are the boolean and the window id, not `state.logsReplay` itself: the
  // object is replaced on every buffered entry, which would restart the clock.
  const replaying = state.logsReplay !== null;
  const replaySeq = state.logsReplay?.seq ?? 0;
  useEffect(() => {
    if (!replaying) return;
    const id = setTimeout(
      () => dispatch({ type: "log_replay_complete" }),
      LOG_REPLAY_FALLBACK_MS,
    );
    return () => clearTimeout(id);
  }, [replaying, replaySeq]);

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

// Theme management - persisted to localStorage, applied via data-theme +
// data-theme-mode attributes on <html>. `theme` is the registered id;
// `mode` is the resolved 'dark'|'light' from the THEMES table and drives
// the handful of mode-dependent CSS rules (lamp glow, neon, diff2html).
interface ThemeContextValue {
  theme: string;
  mode: ThemeMode;
  setTheme: (id: string) => void;
  cycleTheme: () => void;
}

const ThemeCtx = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME_ID,
  mode: "dark",
  setTheme: () => {},
  cycleTheme: () => {},
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
      // the default - return the canonical id so we don't keep round-
      // tripping the stale value.
      return resolved.id;
    }
  }
  // No explicit user choice: follow the OS preference.
  return getSystemThemeId();
}

// The wall sun/moon walks this loop, in Nil's chosen order.
const THEME_CYCLE_ORDER = [
  "light",
  "solarized-light",
  "nord",
  "solarized-dark",
  "dracula",
  "dark",
] as const;

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
  // to our localStorage key - covers the landing's theme toggle updating
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
        // Key was cleared in another window - go back to following the OS.
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

  // The wall sun/moon Easter egg steps through every theme, lightest to
  // darkest, wrapping at the end.
  const cycleTheme = useCallback(() => {
    setUserPicked(true);
    setThemeId((current) => {
      const at = THEME_CYCLE_ORDER.indexOf(
        getThemeById(current).id as (typeof THEME_CYCLE_ORDER)[number],
      );
      return THEME_CYCLE_ORDER[(at + 1) % THEME_CYCLE_ORDER.length];
    });
  }, []);

  return (
    <ThemeCtx.Provider
      value={{ theme: resolved.id, mode: resolved.mode, setTheme, cycleTheme }}
    >
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeCtx);
}

// Feature flags context - production defaults, demo overrides
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
