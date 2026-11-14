import { recentMembersChatPins } from "../shared/members-chat.ts";
import {
  initialUpdateWatch,
  watchOnClicked,
  watchOnLaunching,
  watchOnHide,
  watchOnStatus,
  type UpdateScreen,
  type UpdateWatch,
} from "./update-watch.ts";
import type { RoomPet } from "../shared/pets.ts";
import type { RoomSkin } from "../shared/room-skins.ts";
import type { RoomDecor } from "../shared/room-decor.ts";
import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
  type Dispatch,
} from "react";
import {
  deriveRoomList,
  RoomListCtx,
  RoomListProvider,
  type RoomList,
} from "./office/room-list.tsx";
import { selfTuckedRooms } from "./office/room-cycle.ts";
import { KILLED_AGENT_CHIP_CAP, ordinaryRooms } from "../shared/types.ts";
import type { WhatsAppStatus } from "../shared/whatsapp.ts";
import type { DiscordBot } from "../shared/discord.ts";
import type { Floor } from "../shared/floors.ts";
import {
  ATTENTION_STATES,
  endsTurn,
  turnEndMembers,
} from "../shared/turn-end.ts";
import { humanChatId, type HumanChatKey } from "./human-chat.ts";
import { dmsFromSummaries, reduceMemberDm } from "./member-dms-reducer.ts";
import type {
  AgentInfo,
  AgentState,
  AgentChoiceInteraction,
  KilledAgentSummary,
  LogEntry,
  MembersChatSummary,
  MemberDmSummary,
  SessionInfo,
  ServerMessage,
  SkillInfo,
  TaskItem,
  AppListWire,
  AskMemberWire,
  AskCommandRun,
  OfficeSettings,
  OfficeWire,
  RoomWire,
  CronjobListWire,
  CronjobRun,
  WebhookWire,
  PresenceInfo,
  UserRecord,
  UserPublicWire,
  SessionContext,
  InviteWire,
  SessionWire,
  UpdateStatusWire,
  ProviderAccountWire,
  MembersChatMessage,
  UnavailableEngines,
  UnavailableFeatures,
} from "../shared/types.ts";
import { cronjobRunStreamId } from "../shared/types.ts";
import {
  type UserView,
  upsertUserView,
  rebuildUserViews,
} from "./user-merge.ts";
import { resolveSelectedRoomId, applyRoomClose } from "./roomSelection.ts";
import type {
  AskAgentWire,
  CompressResultWire,
  PruneResultWire,
  PruneTarget,
  RemovedMemberWire,
} from "../shared/contract-shapes.ts";
import { connect, disconnect, socketGeneration } from "./ws.ts";
import { acknowledgeAttempts, acknowledgedSendIds } from "./log-view/outbox.ts";
import { apiFetch } from "./api.ts";
import { type Features, PRODUCTION_FEATURES } from "../shared/features.ts";
import { anyRoomSounds } from "../shared/notif-rooms.ts";
import { isClosedTask } from "../shared/task-board.ts";
import { runSucceeded } from "../shared/runnable-command.ts";
import { createNotificationSound } from "./notification-sound.ts";
import { syncPanel } from "./elevator-panel-store.ts";
import { loadLastSavedView } from "./view-persistence.ts";
import { AsksClosedHere } from "./ask-closed.ts";
import { appendBlockToDraft } from "./log-view/draft-append.ts";
import type {
  DraftAttachment,
  DraftAttachmentAction,
} from "./log-view/draft-attachments.ts";
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

export interface MembersChatState {
  pinned?: MembersChatMessage[];
  pinsRevision?: number;
  pinsStale?: boolean;
  messages: MembersChatMessage[];
  hasMore: boolean;
  loaded: boolean;
  readPointer: string | null;
  unread: number;
}

// One 1:1 chat (task 019e4d7c): the members chat slice without pins, plus the
// summary the sidebar lists (MemberDmSummary).
export interface MemberDmState extends MembersChatState {
  peerName: string;
  removed: boolean;
  lastAt: number | null;
}

// What an action ask's Apply made (task e3d1bc63, part 4): a sign-in link
// for a member, or a personal API token. `target` names it: the member, or
// the token's name. `agentId` is the agent that asked. `forSelf`: a link for
// the device of the member who made it, not one to send to someone else.
export type AskResult =
  | {
      kind: "sign-in-link" | "api-token";
      agentId: string;
      target: string;
      value: string;
      forSelf: boolean;
    }
  // What a storage cleanup did: the member's only receipt, as on the page.
  | {
      kind: "storage-prune";
      agentId: string;
      target: PruneTarget;
      applied: PruneResultWire;
    }
  | { kind: "storage-compress"; agentId: string; applied: CompressResultWire }
  // The runs of an ask that closed on their success (task c3b91695): the
  // output and exit codes stay on screen until Close.
  | { kind: "command-run"; agentId: string; runs: AskCommandRun[] }
  // Another member answered a shared ask first (task 9461c464), while this
  // member's answer was held or on its way: it was not sent.
  | { kind: "answered-first"; agentId: string; by: string };

// An ask that closed with every command run and succeeded (task c3b91695):
// the result that keeps the output on screen.
function commandRunResult(entry: AskMemberWire | undefined): AskResult | null {
  const commands = entry?.commands ?? [];
  if (!entry || commands.length === 0) return null;
  const runs = commands.map((command) =>
    entry.runs?.find((r) => r.command === command),
  );
  return runs.every(runSucceeded)
    ? {
        kind: "command-run",
        agentId: entry.agentId,
        runs: runs as AskCommandRun[],
      }
    : null;
}

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
  // The newest live log_entry frame with `open: true`: the chat on screen
  // (LogView) opens its card's panel once. `seq` bumps on each one, so the
  // view can ignore a request that arrived before it mounted.
  autoOpen: {
    seq: number;
    agentId: string;
    entryId: string;
    target:
      { kind: "editor"; path: string } | { kind: "terminal"; command: string };
  } | null;
  focusedAgentId: string | null;
  connected: boolean;
  // Bumped on every full_state, i.e. every time the store is rehydrated from
  // scratch. This, not `connected`, is the "everything you were holding was
  // just dropped" signal: it names the full_state itself, while `connected`
  // also goes true and false around it. Views that cache server data outside
  // the replay set key their refetch on this (CronjobRunView).
  hydrationEpoch: number;
  isMobile: boolean;
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
  // agentId → the attachments of that unsent draft (draft-attachments.ts).
  draftAttachments: Map<string, DraftAttachment[]>;
  // askId → the member's reply draft. No entry: the field still shows the
  // untouched default. "" is a kept value (the member cleared the field).
  askDrafts: Map<string, string>;
  // agentId → which side panel was open (terminal/editor) when the user last
  // viewed this agent. Persists across LogView remount on agent switch so
  // the panel reopens automatically when the member returns. `undefined` means
  // never opened a panel; missing entries default to closed.
  sidePanels: Map<string, "terminal" | "editor">;
  // agentId → the path the editor panel opens next, and the command the
  // terminal panel types next. Set by a chat or ask card (open_in_editor,
  // copy_to_terminal, which also open the panel); the panel clears it when
  // it has used it (editor_path_opened, terminal_command_handled).
  pendingEditorPaths: Map<string, string>;
  pendingTerminalCommands: Map<string, string>;
  // agentIds whose pending command came from an agent's auto-open: the
  // terminal panel types it without taking keyboard focus.
  quietTerminalCommands: Set<string>;
  // agentId → where the chat input's caret goes when LogView next focuses it.
  // Set by an ask card's "Discuss in chat" button (append_ask_to_draft) at
  // the end of the draft; LogView clears it once it has run
  // (composer_focus_handled).
  pendingComposerFocus: Map<string, number>;
  recentCwds: string[]; // persisted recent working directories
  slashCommands: Map<
    string,
    { commands: { name: string; description?: string }[]; skills: SkillInfo[] }
  >; // agentId → available commands
  stateChangedAt: Map<string, number>; // agentId → timestamp when agent state last changed
  // agentId → when the agent's current unbroken working stretch began, as this
  // client saw it. Unlike stateChangedAt it survives the thinking ↔
  // tool_executing flips inside a turn; an agent not working has no entry.
  workingSince: Map<string, number>;
  office: OfficeSettings;
  rooms: RoomWire[];
  tasks: TaskItem[];
  // The members chat (humans-only stream). Hydrated by a REST
  // page fetch while a chat panel is open, kept live by the members_chat_*
  // wire events. `loaded` drops on every full_state so an open panel
  // refetches; `unread` is the server's count after the caller's read pointer,
  // from full_state or a page, bumped locally for a new message from someone
  // else until the next markRead answer.
  membersChat: MembersChatState;
  // The 1:1 chats, by the peer's user id. Hydrated by full_state's summaries
  // and a REST page fetch while the chat is open, kept live by dm_* events.
  memberDms: Record<string, MemberDmState>;
  // The human chat open full screen in the main pane, or null. CLIENT state;
  // mutually exclusive with focusedAgentId.
  openHumanChat: HumanChatKey | null;
  // Unsent text per human chat, by humanChatId (ui/human-chat.ts).
  humanChatDrafts: Record<string, string>;
  // The lobby elevator's floors (shared/floors.ts), from full_state and
  // floors_updated, in the order they were added.
  floors: Floor[];
  // The Lobby tab is CLIENT state: no room, never in officeState or in any
  // access list. Open when the viewer clicked it, or landed on it because they
  // have no visible room. Selecting a room closes it.
  lobbyOpen: boolean;
  // This load is an elevator ride (StoreProvider's ride prop). CLIENT state,
  // fixed for the page's life: the saved-spot restore keeps the lobby open.
  rideArrival: boolean;
  tasksLoaded: boolean;
  // Chats that load when they open (task 9ebe887d slice 2), per agent: a
  // stream the store asked for, its request, and the entries of a load in
  // flight. The rendered entries stay in `logs`.
  logStreams: ReadonlyMap<string, LogStream>;
  // The agents whose rendered entries are the whole log (a whole
  // log_open_done), kept across sockets, so a mounted chat reopens whole
  // after a reconnect (task 9ebe887d slice 3). A recent done, a refusal or a
  // clear drops the agent.
  logsComplete: ReadonlySet<string>;
  // The socket generation of the last full_state (W1).
  logSocketGen: number;
  // The last full_state said the server loads chats when they open (W2):
  // only then does the client send open_log.
  logsOnOpen: boolean;
  // The summary task board (task 9ebe887d). +1 on each tasks frame: a fetch
  // started in an older epoch is dropped, and closed rows go.
  tasksEpoch: number;
  // Rows the store holds without their description (from a summary frame).
  summaryTaskIds: ReadonlySet<string>;
  // The done and obsolete tasks of this epoch are all in the store.
  closedTasksLoaded: boolean;
  // +1 per task delta, and the last seq per task id (a deleted id keeps its
  // entry). A fetch result loses to a delta that landed after it started.
  taskDeltaSeq: number;
  taskDeltaSeqById: ReadonlyMap<string, number>;
  // Agent-built apps. Fetched by AppsView when the tab opens (an app list costs
  // a systemd read on the server, so no session pays for a tab it never opens)
  // and kept fresh by the app_upserted / app_deleted deltas. full_state does
  // NOT carry apps and must never clear this slice - AppsView re-fetches on
  // hydrationEpoch instead.
  apps: AppListWire[];
  appsLoaded: boolean;
  // Bumped by every app delta. A list GET is a snapshot of the moment it was
  // ISSUED, so a slow one can land after a delta that supersedes it and
  // resurrect an app somebody just deleted. AppsView captures this when it
  // starts a fetch and hands it back on apps_loaded; a replacement whose
  // revision has moved is refused. Ordering GETs against each other is not
  // enough - the race is a GET against a DELTA.
  appsRevision: number;
  // The open asks addressed to this member, in every room
  // (internal-docs/asks-design.md). useAsksSync reads
  // GET /api/asks on every hydrationEpoch; ask_upserted and
  // ask_removed keep it live. App-level: the desk dots read it.
  asks: AskMemberWire[];
  // askId → where an answer the member gave on the Inbox stands: "undo" while
  // its Undo line shows, "sending" once it is sent. Every count, dot and the
  // chat's ask stack leave these asks out (openAsks); the Inbox keeps an
  // "undo" one as its Undo line. Per tab: another device counts the ask until
  // ask_removed.
  answeredAsks: Map<string, "undo" | "sending">;
  // The asks this tab is answering, from the first tap to the answer's end
  // (sent, failed or undone), so a close by another member can be told.
  answeringAsks: Set<string>;
  // askId → the raw message of the last answer that failed to send. The card
  // draws it (translated at render), so it outlives the card that sent it.
  askErrors: Map<string, string>;
  // askId → a sign-in link or API token an action ask's Apply made (task
  // e3d1bc63, part 4). The result card draws it where the ask was until the
  // member closes it: the ask closes as the link is made, often before the
  // Apply answers. Memory only: never stored, sent or logged.
  askResults: Map<string, AskResult>;
  // Bumped by every delta; a snapshot issued before one is refused and read
  // again.
  asksRevision: number;
  asksFetchSeq: number;
  // The last GET /api/asks failed and no load has landed since: the Asks
  // tab shows a notice with Try again instead of "No open asks".
  asksLoadFailed: boolean;
  // Other members' open asks, for an office owner to read and answer on the
  // Asks tab. useOthersAsksSync reads GET /api/asks/others on every
  // hydrationEpoch; others_ask_upserted and others_ask_removed keep it live.
  // Nothing but the Asks tab reads it: no count, dot or stack. Their drafts,
  // marks and errors share askDrafts, answeredAsks and askErrors.
  othersAsks: AskAgentWire[];
  othersAsksRevision: number;
  othersAsksFetchSeq: number;
  // As asksLoadFailed, for GET /api/asks/others.
  othersAsksLoadFailed: boolean;
  // The webhooks this viewer may see: its own, those in its rooms, or every
  // hook for an office owner. Fetched by the Webhooks tab (and by a webhook run's view, which
  // links to its hook) and kept fresh by the webhook_upserted /
  // webhook_deleted deltas. Same revision rule as apps: a list GET that a
  // delta overtook is refused, so it cannot undo an edit or a delete. The
  // secret is never in this slice.
  webhooks: WebhookWire[];
  webhooksLoaded: boolean;
  webhooksRevision: number;
  // The jobs this viewer may see: its maker's, office owners', and those of
  // the viewer's rooms.
  cronjobs: CronjobListWire[];
  // Bumped by every cronjobs_state, so the Automations page refetches the run
  // lists it just dropped.
  cronjobsStateSeq: number;
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
  // Which update this tab follows on the update screen (ui/update-watch.ts).
  updateWatch: UpdateWatch;
  // The UI build the server serves (null: unknown), and the one whose notice
  // the member closed (ui/ui-build.ts).
  serverUiBuild: string | null;
  uiBuildDismissed: string | null;
  // Server-stored member profiles. `users` is keyed by lowercase(name). The
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
  // Owner-only: the removed members an owner can restore (task 321e7b8e).
  removedMembers: RemovedMemberWire[];
  removedMembersLoaded: boolean;
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
  // in ordinary rooms; the lobby shows self too. The
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
  interactions: AgentChoiceInteraction[];
  providerAccounts: ProviderAccountWire[];
  // Null until the WhatsApp card reads it or the server pushes it.
  whatsappStatus: WhatsAppStatus | null;
  // Null until the Discord card reads them or the server pushes them.
  discordBots: DiscordBot[] | null;
  // Engines the office host cannot run (full_state). The engine and model
  // pickers show them as unavailable with the reason.
  unavailableEngines: UnavailableEngines;
  // Office features the host cannot run (full_state). The Apps view explains.
  unavailableFeatures: UnavailableFeatures;
}

// One chat's load (task 9ebe887d slice 2). loading: a replay is in flight,
// its entries in `replay` and the live entries that came meanwhile in `live`;
// at log_open_done they replace the agent's rendered entries. recent: the last
// `tail` entries are in (a prefetch); complete: the whole log is in.
export interface LogStream {
  state: "loading" | "recent" | "complete";
  requestId: string;
  tail?: number;
  replay: LogEntry[];
  live: LogEntry[];
}

export type Action =
  | {
      type: "full_state";
      agents: AgentInfo[];
      recentCwds: string[];
      office: OfficeWire;
      rooms: RoomWire[];
      killedAgents: KilledAgentSummary[];
      interactions?: AgentChoiceInteraction[];
      unavailableEngines?: UnavailableEngines;
      unavailableFeatures?: UnavailableFeatures;
      membersChat?: MembersChatSummary;
      memberDms?: MemberDmSummary[];
      floors?: Floor[];
      uiBuild?: string;
      logsOnOpen?: true;
      // CLIENT-LOCAL: the ws.ts socket generation the frame came on (task
      // 9ebe887d): a full_state on a new socket is a reconnect, one on the
      // same socket is a re-projection.
      socketGen?: number;
    }
  | { type: "floors_updated"; floors: Floor[] }
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string; roomId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "interaction_added"; interaction: AgentChoiceInteraction }
  | { type: "interaction_removed"; interactionId: string; agentId: string }
  | { type: "killed_agent_added"; agent: KilledAgentSummary }
  | { type: "killed_agent_removed"; agentId: string; lastRoomId: string }
  | { type: "log_entry"; entry: LogEntry; open?: true; requestId?: string }
  | {
      type: "log_open_done";
      agentId: string;
      requestId: string;
      tail?: number;
      whole?: true;
      refused?: true;
    }
  // CLIENT-LOCAL (task 9ebe887d): this tab sent open_log / close_log for an
  // agent (ui/agent-log.ts, ui/log-prefetch.ts).
  | { type: "log_open_sent"; agentId: string; requestId: string; tail?: number }
  | { type: "log_close_sent"; agentId: string; requestId: string }
  // CLIENT-LOCAL (not a ServerMessage): CronjobRunView dispatches this after the
  // REST cron.getRun fetch to merge the historical run transcript into the same
  // logs stream that live `log_entry` events feed during an active run. Reuses
  // the per-stream id dedupe (logEntryIds), so it is equivalent to replaying
  // each entry as a `log_entry` - just one reducer pass instead of N.
  | { type: "log_entries_batch"; entries: LogEntry[] }
  | { type: "focus"; agentId: string | null }
  | { type: "connected" }
  | { type: "disconnected" }
  // CLIENT-LOCAL: this tab starts an update launch, the launch was
  // accepted, and Hide on the update screen.
  | { type: "update_launching" }
  | { type: "update_clicked" }
  | { type: "update_hide"; screen: UpdateScreen }
  | { type: "ui_build"; uiBuild: string | null }
  // CLIENT-LOCAL: the member closed the new-build notice.
  | { type: "ui_build_dismiss" }
  // CLIENT-LOCAL (no longer a ServerMessage): ContextMenu dispatches this after
  // the REST agents.listSessions fetch (GET /api/agents/:id/sessions) to seed the
  // per-agent sessions map. The WS sessions_list push it replaced was retired.
  | {
      type: "sessions_list";
      agentId: string;
      sessions: SessionInfo[];
      currentSessionId: string | null;
    }
  | { type: "set_draft"; agentId: string; text: string }
  | DraftAttachmentAction
  // null deletes the draft.
  | { type: "set_ask_draft"; askId: string; text: string | null }
  | {
      type: "set_side_panel";
      agentId: string;
      panel: "terminal" | "editor" | null;
    }
  | { type: "open_in_editor"; agentId: string; path: string }
  // `quiet`: an agent's auto-open (log_entry `open`) - keyboard focus stays
  // where it is. A member's click leaves it unset and takes the focus.
  | {
      type: "copy_to_terminal";
      agentId: string;
      command: string;
      quiet?: boolean;
    }
  | { type: "editor_path_opened"; agentId: string }
  | { type: "terminal_command_handled"; agentId: string }
  | { type: "append_ask_to_draft"; agentId: string; text: string }
  | { type: "composer_focus_handled"; agentId: string }
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
  | { type: "room_order_updated"; rooms: RoomWire[] }
  | { type: "set_mobile"; isMobile: boolean }
  | {
      type: "office_settings_updated";
      prompt: string | null;
      name: string | null;
    }
  // CLIENT-LOCAL (not a ServerMessage): the members chat panel dispatches this
  // after its REST page fetch. `prepend` is an older page landing above what the
  // panel already holds; otherwise the page REPLACES the slice (initial load or
  // a reconnect refetch), keeping any live message that arrived meanwhile.
  | ({
      type: "members_chat_page";
      messages: MembersChatMessage[];
      hasMore: boolean;
      readPointer: string | null;
      unread: number;
      prepend: boolean;
      // Client-local snapshot at fetch issue; never sent over the wire.
      heldAtRequest?: string[];
    } & (
      | { pinned: MembersChatMessage[]; pinsRevisionAtRequest: number }
      | { pinned?: never; pinsRevisionAtRequest?: number }
    ))
  | {
      type: "members_chat_pins";
      pinned: MembersChatMessage[];
      pinsRevisionAtRequest: number;
    }
  | { type: "set_lobby_open"; open: boolean }
  // Wire events for the same slice (server/events/registry.ts).
  | {
      type: "members_chat_message";
      message: MembersChatMessage;
      updateOnly?: boolean;
    }
  | { type: "members_chat_deleted"; id: string }
  | { type: "members_chat_read"; readPointer: string | null; unread: number }
  // CLIENT-LOCAL: a 1:1 chat's REST page, as members_chat_page without pins.
  | {
      type: "dm_page";
      peerId: string;
      messages: MembersChatMessage[];
      hasMore: boolean;
      readPointer: string | null;
      unread: number;
      prepend: boolean;
      heldAtRequest?: string[];
    }
  // Wire events of the 1:1 chats (server/events/registry.ts).
  | {
      type: "dm_message";
      peerId: string;
      message: MembersChatMessage;
      updateOnly?: boolean;
    }
  | { type: "dm_deleted"; peerId: string; id: string }
  | {
      type: "dm_read";
      peerId: string;
      readPointer: string | null;
      unread: number;
    }
  // CLIENT-LOCAL: open a human chat full screen (closes the agent chat and
  // every page), or close it (null).
  | { type: "open_human_chat"; chat: HumanChatKey | null }
  | { type: "set_human_chat_draft"; chat: HumanChatKey; text: string }
  | { type: "tasks"; tasks: TaskItem[]; summary?: true }
  | { type: "task_upserted"; task: TaskItem }
  // A GET /api/tasks result (ui/task-lookup.ts). epoch and seqAtRequest are
  // tasksEpoch and taskDeltaSeq when the request started; closed: the result
  // is every done and obsolete task.
  | {
      type: "tasks_fetched";
      tasks: TaskItem[];
      epoch: number;
      seqAtRequest: number;
      closed?: true;
    }
  | { type: "task_deleted"; taskId: string }
  // CLIENT-LOCAL (not a ServerMessage): AppsView dispatches this after its REST
  // apps.list fetch. The fetch REPLACES the slice, which is what converges the
  // list after a missed delta or a state change systemd made on its own.
  | { type: "apps_loaded"; apps: AppListWire[]; revision: number }
  | { type: "app_upserted"; app: AppListWire }
  | { type: "app_deleted"; name: string }
  // CLIENT-LOCAL (not a ServerMessage): useAsksSync's snapshot.
  | { type: "asks_loaded"; entries: AskMemberWire[]; revision: number }
  | { type: "asks_load_failed" }
  // CLIENT-LOCAL: the Asks tab's Try again. Reads again each list that failed.
  | { type: "asks_load_retry" }
  | { type: "ask_upserted"; entry: AskMemberWire }
  // `by`: the member who answered it, from the push or from a refused answer
  // (409 ask_closed).
  | { type: "ask_removed"; id: string; by?: string }
  // CLIENT-LOCAL: useOthersAsksSync's snapshot.
  | { type: "others_asks_loaded"; entries: AskAgentWire[]; revision: number }
  | { type: "others_asks_load_failed" }
  | { type: "others_ask_upserted"; entry: AskAgentWire }
  | { type: "others_ask_removed"; id: string }
  // The ask's answer starts: clears its error. The chat stack, which sends at
  // once, dispatches only this one.
  | { type: "ask_answer_started"; id: string }
  // An Inbox answer enters its Undo time or is sent. No-op for an ask not in
  // the slice.
  | { type: "ask_answered"; id: string; phase: "undo" | "sending" }
  | { type: "ask_undone"; id: string }
  // An Apply made a sign-in link or a token; the member closed its card.
  | { type: "ask_result_shown"; askId: string; result: AskResult }
  | { type: "ask_result_closed"; askId: string }
  // A send failed: the ask is open again, with the raw error. No-op for an ask
  // not in the slice.
  | { type: "ask_answer_failed"; id: string; error: string }
  // CLIENT-LOCAL (not a ServerMessage): the webhook list fetch. Refused, like
  // apps_loaded, when a delta landed while it was in flight.
  | { type: "webhooks_loaded"; webhooks: WebhookWire[]; revision: number }
  | { type: "webhook_upserted"; webhook: WebhookWire }
  | { type: "webhook_deleted"; id: string }
  | { type: "set_current_room"; roomId: string }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null }
  | { type: "room_pet_updated"; roomId: string; pet: RoomPet | null }
  | { type: "room_skin_updated"; roomId: string; skin: RoomSkin | null }
  | { type: "room_decor_updated"; roomId: string; decor: RoomDecor | null }
  | { type: "room_cwd_updated"; roomId: string; cwd: string | null }
  | { type: "users_list"; users: UserPublicWire[] }
  | { type: "user_updated"; user: UserPublicWire; prevName?: string }
  | { type: "users_admin_list"; users: UserRecord[] }
  | { type: "user_admin_updated"; user: UserRecord; prevName?: string }
  | { type: "user_self_updated"; user: UserRecord; prevName?: string }
  | { type: "provider_accounts_updated"; accounts: ProviderAccountWire[] }
  // CLIENT-LOCAL (not a ServerMessage): the sign-in card's login answer, the
  // one account it carries (task da3fcc0b). The push brings the rest.
  | { type: "provider_login_started"; account: ProviderAccountWire }
  // The member's own WhatsApp link (task d03a61d8), live and from a read.
  | { type: "whatsapp_status"; status: WhatsAppStatus }
  // The member's own Discord bots (task 7fd44c30), live and from a read.
  | { type: "discord_status"; bots: DiscordBot[] }
  | { type: "session_context"; context: SessionContext }
  | {
      type: "presence_list";
      entries: PresenceInfo[];
      totalOnlineUsers: number;
      onlineUserIds: string[];
    }
  | { type: "all_rooms_list"; rooms: RoomWire[] }
  | { type: "invites_list"; invites: InviteWire[] }
  | { type: "removed_members"; members: RemovedMemberWire[] }
  | { type: "sessions_active_list"; sessions: SessionWire[] }
  | { type: "invite_revoked"; tokenPrefix: string }
  | { type: "session_revoked"; sessionPrefix: string }
  | { type: "session_expired" }
  | ({ type: "update_status" } & UpdateStatusWire)
  | {
      type: "cronjobs_state";
      cronjobs: CronjobListWire[];
      cronjobsPrompt: string | null;
    }
  | { type: "cronjob_added"; cronjob: CronjobListWire }
  | { type: "cronjob_updated"; cronjob: CronjobListWire }
  | { type: "cronjob_deleted"; id: string }
  | { type: "cronjobs_prompt_updated"; value: string | null }
  // cronjob_runs + cronjob_runs_loaded are CLIENT-LOCAL actions (NOT
  // ServerMessage members): CronjobsView dispatches them after the REST
  // cron.listRuns / cron.listAllRuns fetches to seed cronjobRunsByJob. Live
  // cronjob_run_updated events (still on the wire) merge into the same map.
  // `seq` is the cronjobsStateSeq the fetch started under: an answer to a
  // fetch made before a re-projection or a delete is stale and dropped.
  | {
      type: "cronjob_runs";
      cronjobId: string;
      runs: CronjobRun[];
      seq: number;
    }
  | {
      type: "cronjob_runs_loaded";
      jobs: { cronjobId: string; runs: CronjobRun[] }[];
      seq: number;
    }
  | { type: "cronjob_run_updated"; run: CronjobRun };

// A reply draft, an Inbox answer and a send error live until their ask closes.
function without<V>(byAsk: Map<string, V>, askId: string): Map<string, V> {
  if (!byAsk.has(askId)) return byAsk;
  const next = new Map(byAsk);
  next.delete(askId);
  return next;
}
function withoutId(ids: Set<string>, askId: string): Set<string> {
  if (!ids.has(askId)) return ids;
  const next = new Set(ids);
  next.delete(askId);
  return next;
}

// Whether an ask is open in either slice: the member's own asks or, for an
// office owner, other members' asks.
function isOpenAsk(state: AppState, id: string): boolean {
  return (
    state.asks.some((e) => e.id === id) ||
    state.othersAsks.some((e) => e.id === id)
  );
}

// The entries of an ask map whose ask is still open in either slice: the
// member's own asks or, for an office owner, other members' asks.
function keepOpenAsks<V>(
  byAsk: Map<string, V>,
  own: readonly AskMemberWire[],
  others: readonly AskMemberWire[],
): Map<string, V> {
  const ids = new Set([...own, ...others].map((e) => e.id));
  if ([...byAsk.keys()].every((id) => ids.has(id))) return byAsk;
  return new Map([...byAsk].filter(([id]) => ids.has(id)));
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

// Drop cached cronjob runs whose job this viewer no longer sees,
// and every run transcript stream that is not a kept run's. Conservative on
// purpose: a transcript can be cached for a run with no row in the run lists
// (a run view opened on a run the list never loaded), and such a stream has
// no job to check, so it goes too. An open run view that may still read its
// run refetches the transcript, because its fetch key follows
// cronjobsStateSeq, which every caller bumps. Streams go from a replay buffer
// in flight as well, or its commit would bring them back.
function dropCronjobRuns(
  state: AppState,
  dropJob: (jobId: string) => boolean,
): Pick<AppState, "cronjobRunsByJob" | "logs" | "logEntryIds" | "logsReplay"> {
  const cronjobRunsByJob = new Map<string, CronjobRun[]>();
  const keptStreams = new Set<string>();
  for (const [jobId, runs] of state.cronjobRunsByJob) {
    if (dropJob(jobId)) continue;
    cronjobRunsByJob.set(jobId, runs);
    for (const run of runs) keptStreams.add(cronjobRunStreamId(run.id));
  }
  const runPrefix = cronjobRunStreamId("");
  const dropped = (streamId: string) =>
    streamId.startsWith(runPrefix) && !keptStreams.has(streamId);
  const logs = new Map(state.logs);
  const logEntryIds = new Map(state.logEntryIds);
  let logsReplay = state.logsReplay;
  const streams = new Set([
    ...state.logs.keys(),
    ...state.logEntryIds.keys(),
    ...(state.logsReplay?.logs.keys() ?? []),
  ]);
  for (const streamId of streams) {
    if (!dropped(streamId)) continue;
    logs.delete(streamId);
    logEntryIds.delete(streamId);
    logsReplay = clearStreamInReplay(logsReplay, streamId, "delete");
  }
  return { cronjobRunsByJob, logs, logEntryIds, logsReplay };
}

// Merge fetched runs into a job's cached list: a fetched run replaces the
// cached copy with its id, and a cached run the answer does not carry (one
// that started after the server read runs.json) stays.
function mergeRuns(
  cached: CronjobRun[] | undefined,
  fetched: CronjobRun[],
): CronjobRun[] {
  const ids = new Set(fetched.map((run) => run.id));
  return [...fetched, ...(cached ?? []).filter((run) => !ids.has(run.id))];
}

/** Mid-turn: the states the office draws as typing at the desk. */
export function isWorkingState(state: AgentState): boolean {
  return state === "thinking" || state === "tool_executing";
}

// The auto-open request for a live card frame with `open: true`, or the
// previous one when the entry is not an editor or terminal card.
function autoOpenFor(
  entry: LogEntry,
  prev: AppState["autoOpen"],
): AppState["autoOpen"] {
  const target =
    entry.kind === "edit-request" && entry.file
      ? { kind: "editor" as const, path: entry.file.path }
      : entry.kind === "terminal-command" && entry.terminal
        ? { kind: "terminal" as const, command: entry.terminal.command }
        : null;
  if (!target) return prev;
  return {
    seq: (prev?.seq ?? 0) + 1,
    agentId: entry.agentId,
    entryId: entry.id,
    target,
  };
}

// The marks without this agent's (logsComplete), the same set when it has
// none.
function withoutMark(
  marks: ReadonlySet<string>,
  agentId: string,
): ReadonlySet<string> {
  if (!marks.has(agentId)) return marks;
  const next = new Set(marks);
  next.delete(agentId);
  return next;
}

// A full_state on a lazy socket (task 9ebe887d). On the SAME socket it is a
// re-projection: the server kept its subscriptions, so the streams, chats and
// commands of the agents still listed stay, and the others go. On a NEW
// socket nothing is subscribed: every stream goes (the chats on screen open
// again through useAgentLog), and the listed agents' entries stay on screen
// until their new load replaces them.
function lazyFullStateLogs(
  state: AppState,
  action: Extract<Action, { type: "full_state" }>,
): Pick<
  AppState,
  | "logs"
  | "logEntryIds"
  | "logsReplay"
  | "logStreams"
  | "logsComplete"
  | "slashCommands"
  | "logsOnOpen"
  | "logSocketGen"
> {
  const listed = new Set(action.agents.map((agent) => agent.id));
  const socketGen = action.socketGen ?? state.logSocketGen;
  const sameSocket = state.logsOnOpen && socketGen === state.logSocketGen;
  const keep = <V,>(map: ReadonlyMap<string, V>, when = true) =>
    new Map([...map].filter(([agentId]) => when && listed.has(agentId)));
  return {
    logs: keep(state.logs),
    logEntryIds: keep(state.logEntryIds),
    logsReplay: null,
    logStreams: keep(state.logStreams, sameSocket),
    // The marks stay across sockets: a mounted whole chat reopens whole (D3).
    logsComplete: new Set(
      [...state.logsComplete].filter((id) => listed.has(id)),
    ),
    slashCommands: keep(state.slashCommands, sameSocket),
    logsOnOpen: true,
    logSocketGen: socketGen,
  };
}

// The delta seq after one task delta (task 9ebe887d): the task's row is full
// now, and a read that started before this delta loses to it.
function afterTaskDelta(
  state: AppState,
  taskId: string,
): Pick<AppState, "taskDeltaSeq" | "taskDeltaSeqById" | "summaryTaskIds"> {
  const taskDeltaSeq = state.taskDeltaSeq + 1;
  const taskDeltaSeqById = new Map(state.taskDeltaSeqById);
  taskDeltaSeqById.set(taskId, taskDeltaSeq);
  let summaryTaskIds = state.summaryTaskIds;
  if (summaryTaskIds.has(taskId)) {
    const next = new Set(summaryTaskIds);
    next.delete(taskId);
    summaryTaskIds = next;
  }
  return { taskDeltaSeq, taskDeltaSeqById, summaryTaskIds };
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
      const next: AppState = {
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
        // Nowhere else to land: a member with no visible room opens on the
        // lobby. Anyone with a room keeps whatever tab they had.
        lobbyOpen:
          ordinaryRooms(action.rooms).length === 0 ? true : state.lobbyOpen,
        killedAgents: action.killedAgents,
        interactions: action.interactions ?? [],
        unavailableEngines: action.unavailableEngines ?? {},
        unavailableFeatures: action.unavailableFeatures ?? {},
        currentRoomId,
        logs:
          holding && focusedId
            ? new Map([[focusedId, heldLogs ?? []]])
            : new Map<string, LogEntry[]>(),
        logEntryIds:
          holding && focusedId
            ? new Map([
                [focusedId, state.logEntryIds.get(focusedId) ?? new Set()],
              ])
            : new Map<string, Set<string>>(),
        logsReplay: holding
          ? {
              logs: new Map(),
              logEntryIds: new Map(),
              seq: (state.logsReplay?.seq ?? 0) + 1,
            }
          : null,
        hydrationEpoch: state.hydrationEpoch + 1,
        // A reconnect may have missed posts: an open panel refetches when
        // loaded drops. The summary sets the badge; an older server sends
        // none, and the badge keeps the last known count.
        membersChat: {
          ...state.membersChat,
          ...(action.membersChat && {
            readPointer: action.membersChat.readPointer,
            unread: action.membersChat.unread,
          }),
          loaded: false,
        },
        memberDms: dmsFromSummaries(state.memberDms, action.memberDms),
        // An older server sends none: no floors, not the list from before.
        floors: action.floors ?? [],
        needsAttention: new Set(),
        slashCommands: new Map(),
        stateChangedAt: new Map(
          action.agents
            .filter((a) => a.state !== "idle" && a.state !== "stopped")
            .map((a) => [a.id, Date.now()]),
        ),
        // A reconnect keeps the stretch of an agent that is still working.
        workingSince: new Map(
          action.agents
            .filter((a) => isWorkingState(a.state))
            .map((a) => [a.id, state.workingSince.get(a.id) ?? Date.now()]),
        ),
        hasReceivedInitialState: true,
        serverUiBuild: action.uiBuild ?? null,
      };
      // A socket that loads chats when they open (task 9ebe887d): no
      // connect replay, so no global window; the streams follow W1.
      if (action.logsOnOpen)
        return { ...next, ...lazyFullStateLogs(state, action) };
      return {
        ...next,
        logStreams: new Map(),
        logsComplete: new Set(),
        logsOnOpen: false,
        logSocketGen: action.socketGen ?? state.logSocketGen,
      };
    }
    case "agent_added":
      return { ...state, agents: [...state.agents, action.agent] };
    case "interaction_added":
      return {
        ...state,
        interactions: [
          ...state.interactions.filter(
            (interaction) => interaction.id !== action.interaction.id,
          ),
          action.interaction,
        ],
      };
    case "interaction_removed":
      return {
        ...state,
        interactions: state.interactions.filter(
          (interaction) => interaction.id !== action.interactionId,
        ),
      };
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
      const logsComplete = withoutMark(state.logsComplete, action.agentId);
      const sidePanels = new Map(state.sidePanels);
      sidePanels.delete(action.agentId);
      const pendingEditorPaths = new Map(state.pendingEditorPaths);
      pendingEditorPaths.delete(action.agentId);
      const pendingTerminalCommands = new Map(state.pendingTerminalCommands);
      pendingTerminalCommands.delete(action.agentId);
      const quietTerminalCommands = new Set(state.quietTerminalCommands);
      quietTerminalCommands.delete(action.agentId);
      const pendingComposerFocus = new Map(state.pendingComposerFocus);
      pendingComposerFocus.delete(action.agentId);
      return {
        ...state,
        logsComplete,
        agents: state.agents.filter((a) => a.id !== action.agentId),
        logs,
        logEntryIds,
        logsReplay,
        needsAttention,
        sidePanels,
        pendingEditorPaths,
        pendingTerminalCommands,
        quietTerminalCommands,
        pendingComposerFocus,
        interactions: state.interactions.filter(
          (interaction) => interaction.agentId !== action.agentId,
        ),
        focusedAgentId:
          state.focusedAgentId === action.agentId ? null : state.focusedAgentId,
      };
    }
    case "agent_updated": {
      const newAgents = state.agents.map((a) =>
        a.id === action.agentId ? { ...a, ...action.changes } : a,
      );
      const needsAttention = new Set(state.needsAttention);
      const stateChangedAt = action.changes.state
        ? new Map(state.stateChangedAt).set(action.agentId, Date.now())
        : state.stateChangedAt;
      let workingSince = state.workingSince;
      if (action.changes.state) {
        const working = isWorkingState(action.changes.state);
        if (working && !workingSince.has(action.agentId))
          workingSince = new Map(workingSince).set(action.agentId, Date.now());
        else if (!working && workingSince.has(action.agentId)) {
          workingSince = new Map(workingSince);
          workingSince.delete(action.agentId);
        }
      }
      // A turn end may set Unread and sound the turn-end sound.
      if (action.changes.state && ATTENTION_STATES.has(action.changes.state)) {
        const prevAgent = state.agents.find((a) => a.id === action.agentId);
        const wasWorking =
          prevAgent && endsTurn(prevAgent.state, action.changes.state);
        let soundTrigger = state.soundTrigger;
        if (wasWorking) {
          // Unread badge and sound: only for a turn this member started, so
          // traffic between agents and other members' turns stay quiet. The
          // badge also needs the member not to be viewing the agent.
          const selfId = state.sessionContext?.userId ?? null;
          const mine =
            selfId !== null &&
            turnEndMembers(prevAgent, action.changes.state).includes(selfId);
          if (mine) {
            const roomId = prevAgent.roomId;
            soundTrigger = { seq: state.soundTrigger.seq + 1, roomId };
            if (state.focusedAgentId !== action.agentId)
              needsAttention.add(action.agentId);
          }
        }
        return {
          ...state,
          agents: newAgents,
          needsAttention,
          soundTrigger,
          stateChangedAt,
          workingSince,
        };
      }
      return {
        ...state,
        agents: newAgents,
        needsAttention,
        stateChangedAt,
        workingSince,
      };
    }
    case "log_entry": {
      // Per-stream id Set for dedupe. Cloned (not mutated) so the reducer
      // stays pure - future consumers comparing Set identity won't see
      // stale references. Set.add returns the Set, so the chained form
      // works for the new-Set case.
      // Inside a reconnect replay window the entry goes to the buffer instead
      // of the rendered logs, and stays invisible until the fence commits it.
      const streamId = action.entry.agentId;
      // A frame of an open_log replay (task 9ebe887d): into its load's
      // buffer, when it is the agent's current request; else stale.
      const stream = state.logStreams.get(streamId);
      if (action.requestId !== undefined) {
        if (
          stream?.state !== "loading" ||
          stream.requestId !== action.requestId
        )
          return state;
        return {
          ...state,
          logStreams: new Map(state.logStreams).set(streamId, {
            ...stream,
            replay: [...stream.replay, action.entry],
          }),
        };
      }
      // A live entry of a chat that is loading shows at once, and is kept
      // for the swap at log_open_done.
      const logStreams =
        stream?.state === "loading" &&
        !stream.live.some((e) => e.id === action.entry.id)
          ? new Map(state.logStreams).set(streamId, {
              ...stream,
              live: [...stream.live, action.entry],
            })
          : state.logStreams;
      const replay = state.logsReplay;
      const srcLogs = replay ? replay.logs : state.logs;
      const srcIds = replay ? replay.logEntryIds : state.logEntryIds;
      const seen = srcIds.get(streamId);
      if (seen?.has(action.entry.id))
        return logStreams === state.logStreams
          ? state
          : { ...state, logStreams };
      const logs = new Map(srcLogs);
      const logEntryIds = new Map(srcIds);
      logEntryIds.set(streamId, new Set(seen).add(action.entry.id));
      const entries = logs.get(streamId) ?? [];
      logs.set(streamId, [...entries, action.entry]);
      const autoOpen = action.open
        ? autoOpenFor(action.entry, state.autoOpen)
        : state.autoOpen;
      if (replay) {
        return {
          ...state,
          logsReplay: { ...replay, logs, logEntryIds },
          autoOpen,
          logStreams,
        };
      }
      return { ...state, logs, logEntryIds, autoOpen, logStreams };
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
    case "focus": {
      const needsAttention = new Set(state.needsAttention);
      if (action.agentId) {
        needsAttention.delete(action.agentId);
      }
      return {
        ...state,
        focusedAgentId: action.agentId,
        needsAttention,
        // An agent chat replaces the open human chat.
        openHumanChat: action.agentId ? null : state.openHumanChat,
      };
    }
    case "open_human_chat":
      return {
        ...state,
        openHumanChat: action.chat,
        focusedAgentId: action.chat ? null : state.focusedAgentId,
      };
    case "set_human_chat_draft": {
      const key = humanChatId(action.chat);
      if ((state.humanChatDrafts[key] ?? "") === action.text) return state;
      const humanChatDrafts = { ...state.humanChatDrafts };
      if (action.text) humanChatDrafts[key] = action.text;
      else delete humanChatDrafts[key];
      return { ...state, humanChatDrafts };
    }
    case "dm_page":
    case "dm_message":
    case "dm_deleted":
    case "dm_read":
      return reduceMemberDm(state, action);
    case "connected":
      return { ...state, connected: true };
    case "disconnected":
      // The onclose backoff reports again when its connect() replaces the
      // closed socket.
      return state.connected ? { ...state, connected: false } : state;
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
    case "add_draft_attachments":
    case "patch_draft_attachment":
    case "remove_draft_attachments":
    case "clear_draft_attachments": {
      const prev = state.draftAttachments.get(action.agentId) ?? [];
      let next: DraftAttachment[];
      if (action.type === "add_draft_attachments") {
        next = [...prev, ...action.items];
      } else if (action.type === "patch_draft_attachment") {
        // A late upload answer for an item removed or sent meanwhile.
        if (!prev.some((a) => a.id === action.id)) return state;
        next = prev.map((a) =>
          a.id === action.id ? { ...a, ...action.patch } : a,
        );
      } else if (action.type === "remove_draft_attachments") {
        next = prev.filter((a) => !action.ids.includes(a.id));
      } else {
        next = [];
      }
      if (next.length === 0 && prev.length === 0) return state;
      const draftAttachments = new Map(state.draftAttachments);
      if (next.length > 0) draftAttachments.set(action.agentId, next);
      else draftAttachments.delete(action.agentId);
      return { ...state, draftAttachments };
    }
    case "set_ask_draft": {
      const askDrafts = new Map(state.askDrafts);
      if (action.text === null) askDrafts.delete(action.askId);
      else askDrafts.set(action.askId, action.text);
      return { ...state, askDrafts };
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
    case "open_in_editor": {
      const pendingEditorPaths = new Map(state.pendingEditorPaths);
      pendingEditorPaths.set(action.agentId, action.path);
      const sidePanels = new Map(state.sidePanels);
      sidePanels.set(action.agentId, "editor");
      return { ...state, pendingEditorPaths, sidePanels };
    }
    // A repeated click replaces the pending command, so a cold panel opens
    // with one command instead of racing a mount timer.
    // A click (not quiet) also clears the quiet mark of a command that still
    // waits, so the click takes the focus as it always did.
    case "copy_to_terminal": {
      const pendingTerminalCommands = new Map(state.pendingTerminalCommands);
      pendingTerminalCommands.set(action.agentId, action.command);
      const quietTerminalCommands = new Set(state.quietTerminalCommands);
      if (action.quiet) quietTerminalCommands.add(action.agentId);
      else quietTerminalCommands.delete(action.agentId);
      const sidePanels = new Map(state.sidePanels);
      sidePanels.set(action.agentId, "terminal");
      return {
        ...state,
        pendingTerminalCommands,
        quietTerminalCommands,
        sidePanels,
      };
    }
    case "editor_path_opened": {
      if (!state.pendingEditorPaths.has(action.agentId)) return state;
      const pendingEditorPaths = new Map(state.pendingEditorPaths);
      pendingEditorPaths.delete(action.agentId);
      return { ...state, pendingEditorPaths };
    }
    case "terminal_command_handled": {
      if (!state.pendingTerminalCommands.has(action.agentId)) return state;
      const pendingTerminalCommands = new Map(state.pendingTerminalCommands);
      pendingTerminalCommands.delete(action.agentId);
      const quietTerminalCommands = new Set(state.quietTerminalCommands);
      quietTerminalCommands.delete(action.agentId);
      return { ...state, pendingTerminalCommands, quietTerminalCommands };
    }
    // The ask's text goes at the end of the draft, as a cite does. A second
    // tap on the same ask keeps one copy; focus is asked again, at the end.
    case "append_ask_to_draft": {
      const current = state.drafts.get(action.agentId) ?? "";
      const next = current.includes(action.text)
        ? current
        : appendBlockToDraft(current, action.text);
      const drafts = new Map(state.drafts);
      drafts.set(action.agentId, next);
      const pendingComposerFocus = new Map(state.pendingComposerFocus);
      pendingComposerFocus.set(action.agentId, next.length);
      return { ...state, drafts, pendingComposerFocus };
    }
    case "composer_focus_handled": {
      if (!state.pendingComposerFocus.has(action.agentId)) return state;
      const pendingComposerFocus = new Map(state.pendingComposerFocus);
      pendingComposerFocus.delete(action.agentId);
      return { ...state, pendingComposerFocus };
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
      // A load in flight goes on (the server restarts it from the new log):
      // what it buffered belongs to the old conversation.
      const loading = state.logStreams.get(action.agentId);
      const logStreams =
        loading?.state === "loading"
          ? new Map(state.logStreams).set(action.agentId, {
              ...loading,
              replay: [],
              live: [],
            })
          : state.logStreams;
      // A conversation boundary (new-conversation/clear, resume, edit-fork)
      // retires the unread dot everywhere: the dot points at a turn that just
      // got wiped/replaced. Server-broadcast, so ALL connected clients clear
      // in lockstep - previously only the clearing client's dot went away
      // (via its own focus), and everyone else kept a stale dot. A rollback
      // clear (failed edit-fork restoring the PRIOR timeline) is not a
      // boundary - the old unseen result comes back, so the dot stays.
      // A clear (or a rollback) replaces the entries: they are no longer the
      // whole log the mark named (task 9ebe887d slice 3).
      const logsComplete = withoutMark(state.logsComplete, action.agentId);
      if (action.rollback)
        return {
          ...state,
          logs,
          logEntryIds,
          logsReplay,
          logStreams,
          logsComplete,
        };
      const needsAttention = new Set(state.needsAttention);
      needsAttention.delete(action.agentId);
      return {
        ...state,
        logs,
        logEntryIds,
        logsReplay,
        logStreams,
        logsComplete,
        needsAttention,
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
    // Order only, so only the rooms change: no transcript, badge or other
    // slice is touched, unlike full_state.
    case "room_order_updated":
      return {
        ...state,
        rooms: action.rooms,
        currentRoomId: resolveSelectedRoomId(action.rooms, state.currentRoomId),
      };
    case "set_mobile":
      return { ...state, isMobile: action.isMobile };
    case "floors_updated":
      return { ...state, floors: action.floors };
    case "office_settings_updated":
      // envFile is owner-only and no longer rides this all-audience event
      // (3b.5). PRESERVE the existing office.envFile (an owner's loaded value)
      // and update only the public fields, so the event never blanks it.
      return {
        ...state,
        office: {
          ...state.office,
          prompt: action.prompt,
          name: action.name,
        },
      };
    // Whole-board hydration (connect, or this user's room access changed).
    case "members_chat_page": {
      const incoming = action.messages;
      const ids = new Set(incoming.map((m) => m.id));
      const kept = state.membersChat.messages.filter((m) => !ids.has(m.id));
      // Members-chat IDs carry a random suffix and do not sort. A fresh page
      // replaces the request-time cache, retaining only arrivals during fetch.
      const heldAtRequest = new Set(action.heldAtRequest ?? []);
      const messages = action.prepend
        ? [...incoming, ...kept]
        : [...incoming, ...kept.filter((m) => !heldAtRequest.has(m.id))];
      return {
        ...state,
        membersChat: {
          ...state.membersChat,
          ...(action.pinned &&
          action.pinsRevisionAtRequest === (state.membersChat.pinsRevision ?? 0)
            ? { pinned: action.pinned, pinsStale: false }
            : {}),
          messages,
          hasMore: action.prepend
            ? action.hasMore
            : action.hasMore || state.membersChat.hasMore,
          loaded: true,
          readPointer: action.readPointer,
          unread: action.unread,
        },
      };
    }
    case "members_chat_pins":
      if (
        action.pinsRevisionAtRequest !== (state.membersChat.pinsRevision ?? 0)
      )
        return state;
      return {
        ...state,
        membersChat: {
          ...state.membersChat,
          pinned: action.pinned,
          pinsStale: false,
        },
      };
    // A post or an in-place update. A held message is replaced where it sits,
    // a new message goes to the end. Someone else's new message bumps the
    // local unread until the next markRead answer replaces it.
    case "members_chat_message": {
      const mc = state.membersChat;
      const pinAffected =
        (mc.pinned ?? []).some((message) => message.id === action.message.id) ||
        action.message.pinnedAt !== undefined;
      const pinState = pinAffected
        ? {
            pinned: recentMembersChatPins([
              ...(mc.pinned ?? []).filter(
                (message) => message.id !== action.message.id,
              ),
              action.message,
            ]),
            pinsRevision: (mc.pinsRevision ?? 0) + 1,
            pinsStale: true,
          }
        : {};
      const idx = mc.messages.findIndex((m) => m.id === action.message.id);
      if (idx !== -1) {
        const messages = mc.messages.slice();
        messages[idx] = action.message;
        return { ...state, membersChat: { ...mc, ...pinState, messages } };
      }
      // Edits and reactions to an unloaded message are not new arrivals.
      if (action.updateOnly)
        return pinAffected
          ? { ...state, membersChat: { ...mc, ...pinState } }
          : state;
      const mine = action.message.userId === state.sessionContext?.userId;
      return {
        ...state,
        membersChat: {
          ...mc,
          ...pinState,
          messages: [...mc.messages, action.message],
          unread: mine ? mc.unread : mc.unread + 1,
        },
      };
    }
    case "members_chat_deleted": {
      const mc = state.membersChat;
      const pinAffected = (mc.pinned ?? []).some(
        (message) => message.id === action.id,
      );
      if (!mc.messages.some((m) => m.id === action.id) && !pinAffected)
        return state;
      return {
        ...state,
        membersChat: {
          ...mc,
          messages: mc.messages.filter((m) => m.id !== action.id),
          ...(pinAffected
            ? {
                pinned: mc.pinned!.filter(
                  (message) => message.id !== action.id,
                ),
                pinsRevision: (mc.pinsRevision ?? 0) + 1,
                pinsStale: true,
              }
            : {}),
        },
      };
    }
    case "members_chat_read":
      return {
        ...state,
        membersChat: {
          ...state.membersChat,
          readPointer: action.readPointer,
          unread: action.unread,
        },
      };
    // A whole board (no summary: the demo shim, a fixture) is complete. A
    // summary frame (task 9ebe887d) holds the open and in-progress rows with
    // no description; a row the store holds in full at the same version keeps
    // its description, so a reconnect does not read them all again. Closed
    // rows go: the next read of them belongs to the new epoch.
    case "tasks": {
      const tasksEpoch = state.tasksEpoch + 1;
      if (!action.summary)
        return {
          ...state,
          tasks: action.tasks,
          tasksLoaded: true,
          tasksEpoch,
          summaryTaskIds: new Set(),
          closedTasksLoaded: true,
        };
      const held = new Map(state.tasks.map((t) => [t.id, t]));
      const summaryTaskIds = new Set<string>();
      const tasks = action.tasks.map((row) => {
        const old = held.get(row.id);
        if (
          old &&
          old.version === row.version &&
          !state.summaryTaskIds.has(row.id)
        )
          return old;
        summaryTaskIds.add(row.id);
        return row;
      });
      // Before the first frame, the store holds only what chip lookups read
      // (ui/task-lookup.ts carries their answers into this epoch): keep it.
      const looked = state.tasksLoaded
        ? []
        : state.tasks.filter((t) => isClosedTask(t));
      return {
        ...state,
        tasks: looked.length > 0 ? [...tasks, ...looked] : tasks,
        tasksLoaded: true,
        tasksEpoch,
        summaryTaskIds,
        closedTasksLoaded: false,
      };
    }
    // One task arrived: replace it in place if we already hold it, otherwise
    // append. Both cases are real - an update to a task we know, and a task
    // becoming visible for the first time (a re-file into a room we can access,
    // or a fresh create). Row order doesn't matter: the board sorts client-side.
    // A delta is a full row, and it wins over a read that started before it.
    case "task_upserted": {
      const idx = state.tasks.findIndex((t) => t.id === action.task.id);
      const tasks =
        idx === -1
          ? [...state.tasks, action.task]
          : state.tasks.map((t) => (t.id === action.task.id ? action.task : t));
      return {
        ...state,
        tasks,
        ...afterTaskDelta(state, action.task.id),
      };
    }
    // A GET /api/tasks result (ui/task-lookup.ts). Dropped when a tasks frame
    // came since the request; a row loses to a delta (or a delete) that landed
    // after the request started. version is a hash, not an order, so the
    // delta seq decides.
    // Chats that load when they open (task 9ebe887d slice 2).
    case "log_open_sent":
      return {
        ...state,
        logStreams: new Map(state.logStreams).set(action.agentId, {
          state: "loading",
          requestId: action.requestId,
          ...(action.tail === undefined ? {} : { tail: action.tail }),
          replay: [],
          live: [],
        }),
      };
    case "log_close_sent": {
      if (state.logStreams.get(action.agentId)?.requestId !== action.requestId)
        return state;
      const logStreams = new Map(state.logStreams);
      logStreams.delete(action.agentId);
      return { ...state, logStreams };
    }
    // The load's replay ++ the live entries that came meanwhile, once each,
    // REPLACE what the chat showed: a clear missed across a disconnect must
    // not join two conversations.
    case "log_open_done": {
      const stream = state.logStreams.get(action.agentId);
      if (stream?.state !== "loading" || stream.requestId !== action.requestId)
        return state;
      const logStreams = new Map(state.logStreams);
      const logs = new Map(state.logs);
      const logEntryIds = new Map(state.logEntryIds);
      if (action.refused) {
        logStreams.delete(action.agentId);
        logs.delete(action.agentId);
        logEntryIds.delete(action.agentId);
        const logsComplete = withoutMark(state.logsComplete, action.agentId);
        return { ...state, logStreams, logs, logEntryIds, logsComplete };
      }
      const seen = new Set<string>();
      const entries: LogEntry[] = [];
      for (const entry of [...stream.replay, ...stream.live]) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
      }
      logs.set(action.agentId, entries);
      logEntryIds.set(action.agentId, seen);
      // A tail that the server says reached the first entry is the whole log.
      const whole = stream.tail === undefined || action.whole === true;
      logStreams.set(action.agentId, {
        state: whole ? "complete" : "recent",
        requestId: stream.requestId,
        ...(stream.tail === undefined ? {} : { tail: stream.tail }),
        replay: [],
        live: [],
      });
      // The mark follows what the chat now shows: a tail replaced a whole
      // chat (a prefetch after a reconnect) with its last entries.
      const logsComplete = new Set(state.logsComplete);
      if (whole) logsComplete.add(action.agentId);
      else logsComplete.delete(action.agentId);
      return { ...state, logStreams, logs, logEntryIds, logsComplete };
    }
    case "tasks_fetched": {
      if (action.epoch !== state.tasksEpoch) return state;
      const index = new Map(state.tasks.map((t, i) => [t.id, i]));
      const tasks = [...state.tasks];
      const summaryTaskIds = new Set(state.summaryTaskIds);
      for (const row of action.tasks) {
        const last = state.taskDeltaSeqById.get(row.id);
        if (last !== undefined && last > action.seqAtRequest) continue;
        const at = index.get(row.id);
        if (at === undefined) {
          index.set(row.id, tasks.length);
          tasks.push(row);
        } else tasks[at] = row;
        summaryTaskIds.delete(row.id);
      }
      return {
        ...state,
        tasks,
        summaryTaskIds,
        closedTasksLoaded: action.closed ? true : state.closedTasksLoaded,
      };
    }
    // Drop a task: deleted, or re-filed out of our reach. Unknown ids are a
    // no-op rather than an error - the server only sends this to recipients who
    // could see the task, but a race against hydration shouldn't break the board.
    // An id the store does not hold still records its seq: a read in flight
    // can hold it, and the delete must win over it.
    case "task_deleted":
      return {
        ...state,
        tasks: state.tasks.some((t) => t.id === action.taskId)
          ? state.tasks.filter((t) => t.id !== action.taskId)
          : state.tasks,
        ...afterTaskDelta(state, action.taskId),
      };
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
    case "asks_loaded":
      if (action.revision !== state.asksRevision)
        return { ...state, asksFetchSeq: state.asksFetchSeq + 1 };
      return {
        ...state,
        asks: action.entries,
        asksLoadFailed: false,
        askDrafts: keepOpenAsks(
          state.askDrafts,
          action.entries,
          state.othersAsks,
        ),
        answeredAsks: keepOpenAsks(
          state.answeredAsks,
          action.entries,
          state.othersAsks,
        ),
        askErrors: keepOpenAsks(
          state.askErrors,
          action.entries,
          state.othersAsks,
        ),
      };
    case "ask_upserted": {
      const idx = state.asks.findIndex((e) => e.id === action.entry.id);
      return {
        ...state,
        asks:
          idx === -1
            ? [...state.asks, action.entry]
            : state.asks.map((e) =>
                e.id === action.entry.id ? action.entry : e,
              ),
        asksRevision: state.asksRevision + 1,
      };
    }
    // AskCard dispatches it too once an answer is sent, for another member's
    // ask as well: ids are unique across both slices, so it drops the id from
    // either, before the push, and a snapshot of the other slice issued before
    // it is refused.
    case "ask_removed": {
      const wasOthers = state.othersAsks.some((e) => e.id === action.id);
      const open =
        state.asks.find((e) => e.id === action.id) ??
        state.othersAsks.find((e) => e.id === action.id);
      // Closed by another member's answer while this tab was answering.
      const result: AskResult | null =
        commandRunResult(state.asks.find((e) => e.id === action.id)) ??
        (open && action.by && state.answeringAsks.has(action.id)
          ? { kind: "answered-first", agentId: open.agentId, by: action.by }
          : null);
      return {
        ...state,
        ...(result
          ? { askResults: new Map(state.askResults).set(action.id, result) }
          : {}),
        answeringAsks: withoutId(state.answeringAsks, action.id),
        asks: state.asks.filter((e) => e.id !== action.id),
        askDrafts: without(state.askDrafts, action.id),
        answeredAsks: without(state.answeredAsks, action.id),
        askErrors: without(state.askErrors, action.id),
        asksRevision: state.asksRevision + 1,
        ...(wasOthers
          ? {
              othersAsks: state.othersAsks.filter((e) => e.id !== action.id),
              othersAsksRevision: state.othersAsksRevision + 1,
            }
          : {}),
      };
    }
    // The flag stays set until a load lands, so a retry in flight does not
    // show "No open asks".
    case "asks_load_failed":
      return state.asksLoadFailed ? state : { ...state, asksLoadFailed: true };
    case "others_asks_load_failed":
      return state.othersAsksLoadFailed
        ? state
        : { ...state, othersAsksLoadFailed: true };
    case "asks_load_retry":
      return {
        ...state,
        ...(state.asksLoadFailed
          ? { asksFetchSeq: state.asksFetchSeq + 1 }
          : {}),
        ...(state.othersAsksLoadFailed
          ? { othersAsksFetchSeq: state.othersAsksFetchSeq + 1 }
          : {}),
      };
    case "others_asks_loaded":
      if (action.revision !== state.othersAsksRevision)
        return { ...state, othersAsksFetchSeq: state.othersAsksFetchSeq + 1 };
      return {
        ...state,
        othersAsks: action.entries,
        othersAsksLoadFailed: false,
        askDrafts: keepOpenAsks(state.askDrafts, state.asks, action.entries),
        answeredAsks: keepOpenAsks(
          state.answeredAsks,
          state.asks,
          action.entries,
        ),
        askErrors: keepOpenAsks(state.askErrors, state.asks, action.entries),
      };
    case "others_ask_upserted": {
      const idx = state.othersAsks.findIndex((e) => e.id === action.entry.id);
      return {
        ...state,
        othersAsks:
          idx === -1
            ? [...state.othersAsks, action.entry]
            : state.othersAsks.map((e) =>
                e.id === action.entry.id ? action.entry : e,
              ),
        othersAsksRevision: state.othersAsksRevision + 1,
      };
    }
    case "others_ask_removed":
      return {
        ...state,
        othersAsks: state.othersAsks.filter((e) => e.id !== action.id),
        askDrafts: without(state.askDrafts, action.id),
        answeredAsks: without(state.answeredAsks, action.id),
        askErrors: without(state.askErrors, action.id),
        othersAsksRevision: state.othersAsksRevision + 1,
      };
    case "ask_answer_started":
      return {
        ...state,
        askErrors: without(state.askErrors, action.id),
        answeringAsks: new Set(state.answeringAsks).add(action.id),
      };
    case "ask_answered": {
      if (!isOpenAsk(state, action.id)) return state;
      const answeredAsks = new Map(state.answeredAsks);
      answeredAsks.set(action.id, action.phase);
      return {
        ...state,
        answeredAsks,
        askErrors: without(state.askErrors, action.id),
      };
    }
    case "ask_undone":
      return {
        ...state,
        answeredAsks: without(state.answeredAsks, action.id),
        answeringAsks: withoutId(state.answeringAsks, action.id),
      };
    case "ask_result_shown": {
      const askResults = new Map(state.askResults);
      askResults.set(action.askId, action.result);
      return { ...state, askResults };
    }
    case "ask_result_closed":
      return { ...state, askResults: without(state.askResults, action.askId) };
    case "ask_answer_failed": {
      if (!isOpenAsk(state, action.id)) return state;
      const askErrors = new Map(state.askErrors);
      askErrors.set(action.id, action.error);
      return {
        ...state,
        answeredAsks: without(state.answeredAsks, action.id),
        answeringAsks: withoutId(state.answeringAsks, action.id),
        askErrors,
      };
    }
    case "webhooks_loaded":
      if (action.revision !== state.webhooksRevision) {
        return { ...state, webhooksLoaded: true };
      }
      return { ...state, webhooks: action.webhooks, webhooksLoaded: true };
    case "webhook_upserted": {
      const known = state.webhooks.some((w) => w.id === action.webhook.id);
      const webhooks = known
        ? state.webhooks.map((w) =>
            w.id === action.webhook.id ? action.webhook : w,
          )
        : [...state.webhooks, action.webhook];
      return {
        ...state,
        webhooks,
        webhooksRevision: state.webhooksRevision + 1,
      };
    }
    // The revision moves for an unknown id too: a list GET in flight may
    // still carry the hook.
    case "webhook_deleted":
      return {
        ...state,
        webhooks: state.webhooks.filter((w) => w.id !== action.id),
        webhooksRevision: state.webhooksRevision + 1,
      };
    case "set_current_room":
      return { ...state, currentRoomId: action.roomId, lobbyOpen: false };
    case "set_lobby_open":
      if (state.lobbyOpen === action.open) return state;
      return { ...state, lobbyOpen: action.open };
    case "room_created":
      // Select the new room only when nothing is currently selected (e.g. a
      // member whose visible rooms were all closed, then gains a freshly
      // created room via room_created with no intervening full_state). When a
      // room is already selected, creating another doesn't switch to it.
      return {
        ...state,
        // The create response and live broadcast can arrive in either order.
        rooms: state.rooms.some((room) => room.id === action.room.id)
          ? state.rooms
          : [...state.rooms, action.room],
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
              apply: action.apply,
              progress: action.progress ?? null,
              ...(action.outcome ? { outcome: action.outcome } : {}),
            };
      return {
        ...state,
        updateAvailable: action.updateAvailable,
        updateInfo,
        updateWatch: watchOnStatus(state.updateWatch, updateInfo),
      };
    }
    case "update_clicked":
      return {
        ...state,
        updateWatch: watchOnClicked(state.updateWatch),
      };
    case "update_launching":
      return {
        ...state,
        updateWatch: watchOnLaunching(state.updateWatch),
      };
    case "update_hide":
      return {
        ...state,
        updateWatch: watchOnHide(state.updateWatch, action.screen),
      };
    case "ui_build":
      return { ...state, serverUiBuild: action.uiBuild };
    case "ui_build_dismiss":
      return { ...state, uiBuildDismissed: state.serverUiBuild };
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
        lobbyOpen:
          ordinaryRooms(result.rooms).length === 0 ? true : state.lobbyOpen,
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
    case "room_pet_updated": {
      const newRooms = state.rooms.map((r) =>
        r.id === action.roomId ? { ...r, pet: action.pet } : r,
      );
      return { ...state, rooms: newRooms };
    }
    case "room_skin_updated": {
      const newRooms = state.rooms.map((r) =>
        r.id === action.roomId ? { ...r, skin: action.skin } : r,
      );
      return { ...state, rooms: newRooms };
    }
    case "room_decor_updated": {
      const newRooms = state.rooms.map((r) =>
        r.id === action.roomId ? { ...r, decor: action.decor } : r,
      );
      return { ...state, rooms: newRooms };
    }
    case "room_cwd_updated": {
      const newRooms = state.rooms.map((r) =>
        r.id === action.roomId ? { ...r, cwd: action.cwd } : r,
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
    case "provider_accounts_updated":
      return { ...state, providerAccounts: action.accounts };
    case "provider_login_started": {
      const { account } = action;
      const same = (entry: ProviderAccountWire) =>
        entry.provider === account.provider && entry.scope === account.scope;
      return {
        ...state,
        providerAccounts: state.providerAccounts.some(same)
          ? state.providerAccounts.map((entry) =>
              same(entry) ? account : entry,
            )
          : [...state.providerAccounts, account],
      };
    }
    case "whatsapp_status":
      return { ...state, whatsappStatus: action.status };
    case "discord_status":
      return { ...state, discordBots: action.bots };
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
        removedMembersLoaded: false,
        activeSessionsLoaded: false,
      };
    case "all_rooms_list":
      // Owner-only payload. Members never receive this; the case is
      // still reachable via the dispatcher type union so no special
      // guard is needed.
      return { ...state, allRooms: action.rooms };
    case "invites_list":
      return { ...state, invitesList: action.invites, invitesLoaded: true };
    case "removed_members":
      return {
        ...state,
        removedMembers: action.members,
        removedMembersLoaded: true,
      };
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
    // A whole re-projection: on connect, and after a change in what this
    // viewer may see (room close, access or role change). Cached runs and
    // their transcripts survive only for jobs this viewer still sees; the
    // rest (including runs of deleted jobs, which only office owners read)
    // drop, and the Automations page refetches what the server still gives.
    // The seq bump also voids run-list fetches already in flight.
    case "cronjobs_state": {
      const visibleIds = new Set(action.cronjobs.map((c) => c.id));
      return {
        ...state,
        ...dropCronjobRuns(state, (jobId) => !visibleIds.has(jobId)),
        cronjobs: action.cronjobs,
        cronjobsPrompt: action.cronjobsPrompt,
        cronjobsLoaded: true,
        cronjobsStateSeq: state.cronjobsStateSeq + 1,
      };
    }
    // Added and updated are one idempotent upsert by id: a job moved into a
    // room this viewer can see arrives as an update for a row they never had,
    // and a repeated event must not duplicate a row.
    case "cronjob_added":
    case "cronjob_updated": {
      const exists = state.cronjobs.some((c) => c.id === action.cronjob.id);
      return {
        ...state,
        cronjobs: exists
          ? state.cronjobs.map((c) =>
              c.id === action.cronjob.id ? action.cronjob : c,
            )
          : [...state.cronjobs, action.cronjob],
      };
    }
    // A deleted job's runs are office owners' only, and the client does not
    // decide who that is: drop them with their transcripts and let the
    // Automations page refetch (seq bump), which returns them to owners alone.
    case "cronjob_deleted":
      return {
        ...state,
        ...dropCronjobRuns(state, (jobId) => jobId === action.id),
        cronjobs: state.cronjobs.filter((c) => c.id !== action.id),
        cronjobsStateSeq: state.cronjobsStateSeq + 1,
      };
    case "cronjobs_prompt_updated":
      return { ...state, cronjobsPrompt: action.value };
    // Client-local seed for a single job (cron.listRuns REST fetch).
    case "cronjob_runs": {
      if (action.seq !== state.cronjobsStateSeq) return state;
      const cronjobRunsByJob = new Map(state.cronjobRunsByJob);
      cronjobRunsByJob.set(
        action.cronjobId,
        mergeRuns(cronjobRunsByJob.get(action.cronjobId), action.runs),
      );
      return { ...state, cronjobRunsByJob };
    }
    // Client-local seed for the all-runs fetch (cron.listAllRuns REST). Merged
    // run by run (mergeRuns), so neither a job absent from the answer nor a run
    // that arrived live while the fetch was out is lost. That keeps nothing
    // private: every loss of access to a job arrives as cronjobs_state or
    // cronjob_deleted, which drop the job's runs and bump the seq that voids
    // fetches already in flight.
    case "cronjob_runs_loaded": {
      if (action.seq !== state.cronjobsStateSeq) return state;
      const cronjobRunsByJob = new Map(state.cronjobRunsByJob);
      for (const { cronjobId, runs } of action.jobs) {
        cronjobRunsByJob.set(
          cronjobId,
          mergeRuns(cronjobRunsByJob.get(cronjobId), runs),
        );
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
  autoOpen: null,
  focusedAgentId: null,
  connected: false,
  hydrationEpoch: 0,
  isMobile: typeof window !== "undefined" ? window.innerWidth < 768 : false,
  needsAttention: new Set(),
  sessionsList: new Map(),
  soundTrigger: { seq: 0, roomId: null },
  drafts: new Map(),
  draftAttachments: new Map(),
  askDrafts: new Map(),
  sidePanels: new Map(),
  pendingEditorPaths: new Map(),
  pendingTerminalCommands: new Map(),
  quietTerminalCommands: new Set(),
  pendingComposerFocus: new Map(),
  recentCwds: [],
  slashCommands: new Map(),
  stateChangedAt: new Map(),
  workingSince: new Map(),
  office: {
    prompt: null,
    envFile: null,
    name: null,
  },
  rooms: [],
  tasks: [],
  tasksLoaded: false,
  logStreams: new Map(),
  logsComplete: new Set(),
  logSocketGen: 0,
  logsOnOpen: false,
  tasksEpoch: 0,
  summaryTaskIds: new Set(),
  // Only a summary frame says the store lacks the closed tasks; a state with
  // its tasks set whole (a fixed-state fixture) has them all.
  closedTasksLoaded: true,
  taskDeltaSeq: 0,
  taskDeltaSeqById: new Map(),
  membersChat: {
    messages: [],
    hasMore: false,
    loaded: false,
    readPointer: null,
    unread: 0,
  },
  memberDms: {},
  openHumanChat: null,
  humanChatDrafts: {},
  floors: [],
  lobbyOpen: false,
  rideArrival: false,
  apps: [],
  appsLoaded: false,
  appsRevision: 0,
  asks: [],
  answeredAsks: new Map(),
  answeringAsks: new Set(),
  askErrors: new Map(),
  askResults: new Map(),
  asksRevision: 0,
  asksFetchSeq: 0,
  asksLoadFailed: false,
  othersAsks: [],
  othersAsksRevision: 0,
  othersAsksFetchSeq: 0,
  othersAsksLoadFailed: false,
  webhooks: [],
  webhooksLoaded: false,
  webhooksRevision: 0,
  cronjobs: [],
  cronjobsLoaded: false,
  cronjobsPrompt: null,
  cronjobsStateSeq: 0,
  cronjobRunsByJob: new Map(),
  cronjobRunsLoaded: false,
  currentRoomId: null,
  updateAvailable: false,
  updateInfo: null,
  updateWatch: initialUpdateWatch,
  serverUiBuild: null,
  uiBuildDismissed: null,
  users: new Map(),
  usersLoaded: false,
  sessionContext: null,
  allRooms: [],
  invitesList: [],
  invitesLoaded: false,
  removedMembers: [],
  removedMembersLoaded: false,
  activeSessions: [],
  activeSessionsLoaded: false,
  sessionExpired: false,
  hasReceivedInitialState: false,
  presences: [],
  totalOnlineUsers: 0,
  onlineUserIds: [],
  killedAgents: [],
  interactions: [],
  providerAccounts: [],
  whatsappStatus: null,
  discordBots: null,
  unavailableEngines: {},
  unavailableFeatures: {},
};

// Exported so a static render can supply a seeded state. The app itself
// always goes through StoreProvider; nothing but tests should use this
// directly.
export const StateCtx = createContext<AppState>(initialState);
// Exported for the same reason: a test can observe what a view dispatches.
export const DispatchCtx = createContext<Dispatch<Action>>(() => {});

// The member's notification rooms, from the user record of this session.
function myNotifRooms(users: Map<string, UserView>): readonly string[] {
  const username = getUsername();
  return (
    (username ? users.get(username.toLowerCase()) : undefined)?.notifRooms ?? []
  );
}

export function StoreProvider({
  children,
  ride = false,
}: {
  children: ReactNode;
  // This load is an elevator ride (holdArrivingPanel): it opens on the lobby.
  ride?: boolean;
}) {
  const { llmConnected } = useFeatures();
  const [state, dispatch] = useReducer(reducer, initialState, (s) => {
    // The first frame draws the view the restore will open (App.tsx), so
    // nothing switches when the state arrives. The member is not known yet:
    // the guess reads whoever saved last in this browser.
    const last = llmConnected ? loadLastSavedView() : null;
    return {
      ...s,
      rideArrival: ride,
      lobbyOpen: ride || (llmConnected && (last === null || last.lobby)),
    };
  });

  // Ids are never reused, so the set only grows (ui/ask-closed.ts). It never
  // changes identity, so the connect effect still runs once.
  const [closedAsks] = useState(() => new Set<string>());

  useEffect(() => {
    let legacyMigrated = false;
    const onMessage = (msg: ServerMessage) => {
      // Before the dispatch: a held answer flushed as its card unmounts
      // must see that the ask closed.
      if (msg.type === "ask_removed") closedAsks.add(msg.id);
      // In the same task as the dispatch, so React renders both in one
      // commit: the Sending row goes as the message shows.
      acknowledgeAttempts(acknowledgedSendIds(msg));
      // A full_state carries the socket it came on (W1, task 9ebe887d).
      dispatch(
        msg.type === "full_state"
          ? { ...msg, socketGen: socketGeneration() }
          : (msg as Action),
      );
      if (msg.type === "full_state") dispatch({ type: "connected" });
      if (msg.type === "full_state" || msg.type === "floors_updated")
        syncPanel(msg.floors ?? []);
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
    };
    connect(onMessage, (isConnected: boolean) => {
      if (!isConnected) dispatch({ type: "disconnected" });
    });
    // An unmounted tree takes no frame (a later test file can still emit).
    return () => disconnect(onMessage);
  }, [closedAsks]);

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
  const [sound] = useState(createNotificationSound);
  // A click primes the sound only once a room can sound: on iOS an
  // AudioContext pauses audio from other apps.
  const soundOn = useRef(false);
  useEffect(() => {
    soundOn.current = anyRoomSounds(myNotifRooms(state.users));
  }, [state.users]);
  useEffect(() => {
    const onClick = () => {
      if (soundOn.current) sound.prime();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [sound]);
  const prevSoundTriggerSeq = useRef(0);
  useEffect(() => {
    if (
      state.soundTrigger.seq > prevSoundTriggerSeq.current &&
      document.hidden &&
      // The lobby never sounds (shared/notif-rooms.ts).
      shouldNotifyRoom(state.soundTrigger.roomId, myNotifRooms(state.users))
    ) {
      sound.play();
    }
    prevSoundTriggerSeq.current = state.soundTrigger.seq;
  }, [state.soundTrigger, state.users, sound]);

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>
        <AsksClosedHere.Provider value={closedAsks}>
          <RoomListProvider
            allRooms={state.rooms}
            users={state.users}
            selfId={state.sessionContext?.userId ?? null}
            currentRoomId={state.currentRoomId}
            lobbyOpen={state.lobbyOpen}
          >
            {children}
          </RoomListProvider>
        </AsksClosedHere.Provider>
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useAppState() {
  return useContext(StateCtx);
}

// The member's room list (ui/office/room-list.tsx). A tree with no
// StoreProvider (a fixed-state fixture) has no writes in flight: it gets the
// same list from the state alone, and a write only sends.
const sendOnly = (_value: string[], send: () => Promise<unknown>) => {
  send().catch(() => {});
};
export function useRoomList(): RoomList {
  const provided = useContext(RoomListCtx);
  const state = useContext(StateCtx);
  const selfId = state.sessionContext?.userId ?? null;
  const fallback = useMemo<RoomList | null>(
    () =>
      provided
        ? null
        : {
            ...deriveRoomList(
              ordinaryRooms(state.rooms),
              selfTuckedRooms(state.users.values(), selfId),
              null,
              null,
              state.currentRoomId,
              state.lobbyOpen,
            ),
            writeOrder: sendOnly,
            writeTucked: sendOnly,
          },
    [
      provided,
      state.rooms,
      state.users,
      selfId,
      state.currentRoomId,
      state.lobbyOpen,
    ],
  );
  return provided ?? fallback!;
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

// The wall sun/moon walks this fixed order.
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
