// The per-session projection and push: what each office socket may see of
// rooms, agents, tasks, asks, pager entries, webhooks and cronjobs, the full
// state and replay sent on connect, the per-recipient deltas, member message
// sends, and the user access, view and preferences changes that re-project a
// user's sockets. Moved out of server/isomux-office.ts, which creates it once
// at module load.
import type { ApiTokenLimits } from "../shared/api-token-limits.ts";
import type { ServerWebSocket } from "bun";
import type { PreferencesReq } from "../shared/contract-shapes.ts";
import { formatApiTokenDevice, memberReplyDevice } from "../shared/identity.ts";
import type { TaskChange } from "../shared/office-state.ts";
import {
  type AgentInfo,
  type AskEntry,
  type AskRef,
  type Attachment,
  type CronjobRun,
  KILLED_AGENT_CHIP_CAP,
  type LogEntry,
  type OfficeWire,
  type RoomWire,
  type ServerMessage,
  type TaskItem,
  type UserRecord,
} from "../shared/types.ts";
import { sendApiTokenMessage } from "./api-tokens.ts";
import { recheckOpenAppSockets } from "./app-ws-relay.ts";
import {
  askAgentWire,
  type AskAudienceDeps,
  type AskChange,
  askMemberWire,
  askShownToOwnerAsOther,
  askMemberIds,
  askVisibleTo,
} from "./asks.ts";
import { revalidateByHash, type SessionLookup } from "./auth.ts";
import { cronjobVisibleTo } from "./cronjob-visibility.ts";
import { type CronjobChange, cronjobDeltaFor } from "./events/cronjob-delta.ts";
import { taskDeltaFor } from "./events/task-delta.ts";
import { type WebhookChange, webhookDeltaFor } from "./events/webhook-delta.ts";
import type { Identity } from "./identity/index.ts";
import type { UserSendAcceptance } from "./internal-types.ts";
import type { OfficeWsData } from "./isomux-office.ts";
import type { createAccessPolicy } from "./office-access-policy.ts";
import {
  agentManager,
  appHostingUnsupported,
  cronjobManager,
  extensionService,
  floors,
  membersChat,
  openCodeRunsOnHost,
  uiBuildTracker,
} from "./office-managers.ts";
import type { OfficeOutbox } from "./office-ws-outbox.ts";
import { loadRecentCwds } from "./persistence.ts";
import { taskVisibleTo } from "./task-visibility.ts";
import { isClosedTask } from "../shared/task-board.ts";
import { getUserById, updateUserById, type UserAccessChange } from "./users.ts";
import { type WsFrame, type WsPushKind } from "./ws-push-area.ts";
import { ACCESS_CHANGED_CLOSE_CODE } from "../shared/pack-fit.ts";
import type { ApiTokenArea } from "../shared/api-token-limits.ts";

type AccessPolicy = ReturnType<typeof createAccessPolicy>;

// What the per-session projection reads from server/isomux-office.ts.
export interface SessionProjectionDeps {
  accessibleRoomIdsFor: (
    user: UserRecord,
    allowedRoomsOverride?: readonly string[],
  ) => Set<string>;
  askAudience: AskAudienceDeps;
  attributionFor: AccessPolicy["attributionFor"];
  browsers: Set<ServerWebSocket<OfficeWsData>>;
  cronjobFactsById: AccessPolicy["cronjobFactsById"];
  cronjobViewerForSession: AccessPolicy["cronjobViewerForSession"];
  cronjobsFor: AccessPolicy["cronjobsFor"];
  emitPrivateUserRecord: (user: UserRecord) => void;
  emitUserUpdated: (user: UserRecord, prevName?: string) => void;
  emitUsersList: AccessPolicy["emitUsersList"];
  // Whether a write by `identity` to the agent fits the pack rule
  // (server/identity/agent-fit.ts identityFitsAgent).
  identityFitsAgent: (identity: Identity, agentId: string) => boolean;
  officeSend: (
    ws: ServerWebSocket<OfficeWsData>,
    kind: WsPushKind,
    data: string,
  ) => void;
  officeSendLazy: (
    ws: ServerWebSocket<OfficeWsData>,
    frames: Iterator<WsFrame>,
  ) => void;
  // An open_log replay in the outbox's background lane, each frame through
  // the push filter.
  officeSendBackground: (
    ws: ServerWebSocket<OfficeWsData>,
    key: string,
    frames: Iterator<WsFrame>,
    opts?: { front?: boolean },
  ) => void;
  outboxFor: (ws: ServerWebSocket<OfficeWsData>) => OfficeOutbox;
  roomAllowedForSession: (session: SessionLookup, roomId: string) => boolean;
  sendPresenceListTo: (ws: ServerWebSocket<OfficeWsData>) => void;
  sendSessionContext: (ws: ServerWebSocket<OfficeWsData>) => void;
  sessionHasFullRoomAccess: (session: SessionLookup) => boolean;
  taskViewerForUser: AccessPolicy["taskViewerForUser"];
  webhookViewerForSession: AccessPolicy["webhookViewerForSession"];
  // Whether the member of `session` gets a push of `kind` (the pack rule).
  wsPushAllowed: (session: SessionLookup, kind: WsPushKind) => boolean;
}

export function createSessionProjection(deps: SessionProjectionDeps) {
  const {
    accessibleRoomIdsFor,
    askAudience,
    attributionFor,
    browsers,
    cronjobFactsById,
    cronjobViewerForSession,
    cronjobsFor,
    emitPrivateUserRecord,
    emitUserUpdated,
    emitUsersList,
    identityFitsAgent,
    officeSend,
    officeSendBackground,
    officeSendLazy,
    outboxFor,
    roomAllowedForSession,
    sendPresenceListTo,
    sendSessionContext,
    sessionHasFullRoomAccess,
    taskViewerForUser,
    webhookViewerForSession,
    wsPushAllowed,
  } = deps;

  interface VisibleRoomProjection {
    rooms: RoomWire[];
    // global room index → dense visible index, or -1 if not visible for this
    // session. Post-cut this is purely a per-recipient VISIBILITY predicate
    // (>= 0 ⟺ visible); the dense value is no longer rewritten onto the wire.
    globalToVisible: number[];
    // Stable roomId → GLOBAL room index (covers every room, not just the
    // visible ones). Lets roomId-authority callers map an id to its global index
    // for corrupt-id detection and, via globalToVisible, test visibility. A roomId
    // absent here is corrupt (loud); present-but-globalToVisible<0 is normal
    // projection filtering.
    globalRoomIdToIndex: Map<string, number>;
  }

  function visibleRoomProjection(
    session: SessionLookup,
  ): VisibleRoomProjection {
    const all = agentManager.getRooms();
    // Built once, shared by both projection paths. roomId → global index
    // for callers that derive the dense index from the authoritative roomId.
    const globalRoomIdToIndex = new Map(all.map((r, i) => [r.id, i] as const));
    const user = getUserById(session.userId);
    // Fast path: a full-access user with NO hidden rooms and NO custom order sees
    // every room in office order - the identity projection (no per-room
    // allocations). Hidden/order migrates to [], so this is the common
    // case and stays byte-identical to the pre-3b full-access fast path.
    if (
      user &&
      sessionHasFullRoomAccess(session) &&
      user.hidden.length === 0 &&
      user.order.length === 0
    ) {
      const identity: number[] = all.map((_, i) => i);
      return {
        rooms: all,
        globalToVisible: identity,
        globalRoomIdToIndex,
      };
    }
    // General path. ACCESS is the security gate (roomAllowedForSession today;
    // canAccess). `hidden` is an additive VIEW filter ON TOP (effective shown =
    // accessible \ hidden) and is NEVER a security gate - an
    // owner who hides a room still has access; a re-show consults only access.
    // `order` is a SPARSE per-user preference: rooms listed there come first in
    // that order, then the remaining visible rooms in office order. With the
    // migrated defaults (hidden=[], order=[]) this reduces to "accessible rooms
    // in office order", i.e. today's projection - verified by projection.test.
    const hidden = new Set(user?.hidden ?? []);
    const orderRank = new Map<string, number>();
    // First-write-wins on duplicate order ids (applyViewChange dedupes on write;
    // this guards a hand-edited persisted order array too).
    if (user) {
      user.order.forEach((id, i) => {
        if (!orderRank.has(id)) orderRank.set(id, i);
      });
    }
    const visibleGlobal: number[] = [];
    for (let i = 0; i < all.length; i++) {
      if (!roomAllowedForSession(session, all[i].id)) continue; // access gate
      if (all[i].type !== "lobby" && hidden.has(all[i].id)) continue; // view filter (not security)
      visibleGlobal.push(i);
    }
    // Stable sort: explicit-order rank first (listed rooms, in listed order),
    // office order (the original global index) as the tiebreak for everything
    // unlisted. Rank +Infinity for unlisted rooms keeps them in office order.
    visibleGlobal.sort((a, b) => {
      const lobbyRank =
        Number(all[b].type === "lobby") - Number(all[a].type === "lobby");
      if (lobbyRank) return lobbyRank;
      const ra = orderRank.has(all[a].id)
        ? orderRank.get(all[a].id)!
        : Infinity;
      const rb = orderRank.has(all[b].id)
        ? orderRank.get(all[b].id)!
        : Infinity;
      return ra !== rb ? ra - rb : a - b;
    });
    const rooms: RoomWire[] = [];
    const globalToVisible = new Array<number>(all.length).fill(-1);
    for (const i of visibleGlobal) {
      globalToVisible[i] = rooms.length;
      rooms.push(all[i]);
    }
    return { rooms, globalToVisible, globalRoomIdToIndex };
  }

  // Return the agent only when its room is visible to this session.
  function projectAgentForSession(
    session: SessionLookup,
    agent: AgentInfo,
    projection?: VisibleRoomProjection,
  ): AgentInfo | null {
    // Visibility follows the current room, including the canonical lobby.
    const proj = projection ?? visibleRoomProjection(session);
    // Derive the global index from the authoritative roomId. Absent from
    // the map = corrupt roomId (loud + suppress); present but globalToVisible < 0 =
    // legitimately not visible to this session (silent, normal filtering).
    const globalIdx = proj.globalRoomIdToIndex.get(agent.roomId);
    if (globalIdx === undefined) {
      console.error(
        `[3c] projectAgentForSession: unknown roomId "${agent.roomId}" for agent ${agent.id}; suppressing`,
      );
      return null;
    }
    if (proj.globalToVisible[globalIdx] < 0) return null;
    return agent;
  }

  // True if a given agentId currently lives in a room visible to this
  // session. Looks up the agent's room from AgentManager - caller doesn't
  // need to know it. Used by per-agent event routing (log_entry,
  // slash_commands, terminal_*) and write-side enforcement.
  function agentVisibleForSession(
    session: SessionLookup,
    agentId: string,
  ): boolean {
    if (sessionHasFullRoomAccess(session)) return true;
    const agent = agentManager.getAllAgents().find((a) => a.id === agentId);
    if (!agent) return false;
    // The agent carries its authoritative roomId directly.
    if (!agent.roomId) return false;
    return roomAllowedForSession(session, agent.roomId);
  }

  // Build and send the full_state payload for a given WS using the session's
  // projected room/agent view. Used at connect time and as the targeted
  // refresh after any change that could shift this session's visible set
  // (allowedRooms changes, agent moves across rooms, room close/rename/
  // reorder when explicit-list members are connected). Mid-session callers
  // pass replayLogsForVisible=true to also resend cached log entries for
  // agents the session can now see; without that flag, newly visible agents
  // would render in the UI with no history until the next reload.
  // Project office settings for a recipient: envFile is owner-only, so it is
  // stripped for non-owner recipients and never reaches a member's
  // full_state.office. Owners keep the full triple.
  function projectOfficeFor(session: SessionLookup): OfficeWire {
    const office = agentManager.getOfficeSettings();
    const isOwner = getUserById(session.userId)?.role === "owner";
    return isOwner
      ? {
          prompt: office.prompt,
          name: office.name,
          envFile: office.envFile,
        }
      : {
          prompt: office.prompt,
          name: office.name,
        };
  }

  function sendProjectedFullState(
    ws: ServerWebSocket<OfficeWsData>,
    options?: { replayLogsForVisible?: boolean },
  ) {
    // A refresh while frames from the previous projection still wait in the
    // outbox: those frames may cover rooms this session just lost. Close the
    // socket instead of sending them; the client reconnects to a fresh
    // projection.
    // A socket that loads chats when they open (task 9ebe887d) has its
    // open_log replays in the outbox's background lane most of the time on a
    // slow link: only queued LIVE frames are the stale projection.
    const lazy = ws.data.logsOnOpen === true;
    if (
      options?.replayLogsForVisible &&
      (lazy ? outboxFor(ws).liveBacklogged : outboxFor(ws).backlogged)
    ) {
      outboxFor(ws).dispose();
      ws.terminate();
      return;
    }
    const session = ws.data.session;
    const proj = visibleRoomProjection(session);
    const agents: AgentInfo[] = [];
    for (const a of agentManager.getAllAgents()) {
      const projected = projectAgentForSession(session, a, proj);
      if (!projected) continue;
      // The order of a client's background chat loads.
      const lastEntryAt = agentManager.getAgentLogs(a.id).at(-1)?.timestamp;
      agents.push(
        lastEntryAt === undefined ? projected : { ...projected, lastEntryAt },
      );
    }
    // A lazy socket keeps the chats it loads across a re-projection, except
    // the agents it no longer sees.
    if (lazy) {
      const visible = new Set(agents.map((agent) => agent.id));
      for (const agentId of [...(ws.data.logSubscriptions ?? [])])
        if (!visible.has(agentId)) dropLogSubscription(ws, agentId);
    }
    const visibleAgentIds = new Set(agents.map((agent) => agent.id));
    const interactions = agentManager
      .getPendingInteractions()
      .filter((interaction) => visibleAgentIds.has(interaction.agentId));
    // ACL-filtered list of currently-killed agents for the spawn menu's
    // revive chips. Drop entries whose lastRoomId isn't visible to this
    // session - a member shouldn't be able to revive an agent from a
    // private room they can't enter. Cap AFTER filtering so the user
    // sees up to KILLED_AGENT_CHIP_CAP entries they can actually act on,
    // not a smaller number trimmed by entries outside their room set.
    const killedAgents = agentManager
      .getKilledAgentSummaries()
      .filter((k) => roomAllowedForSession(session, k.lastRoomId))
      .slice(0, KILLED_AGENT_CHIP_CAP);
    // A member with a permission pack gets each field only with its area
    // (server/ws-push-area.ts has the pushes).
    const user = getUserById(session.userId);
    const pack = user?.role === "member" ? user.pack : undefined;
    const can = (area: ApiTokenArea) => !pack || pack.areas[area] !== undefined;
    const office = projectOfficeFor(session);
    officeSend(
      ws,
      "full_state",
      JSON.stringify({
        type: "full_state",
        agents: can("agents") ? agents : [],
        recentCwds: can("agentManagement") ? loadRecentCwds() : [],
        office: can("office") ? office : { ...office, prompt: null },
        rooms: proj.rooms,
        killedAgents: can("agentManagement") ? killedAgents : [],
        interactions: can("agents") ? interactions : [],
        unavailableEngines: openCodeRunsOnHost()
          ? {}
          : { opencode: "needs_linux" },
        unavailableFeatures:
          appHostingUnsupported() === null ? {} : { apps: "needs_linux" },
        // Every office session is a person, who holds chat:members.
        ...(can("membersChat")
          ? { membersChat: membersChat.summary(session.userId) }
          : {}),
        ...(can("office") ? { floors: floors.list() } : {}),
        uiBuild: uiBuildTracker?.current() ?? undefined,
        ...(lazy ? { logsOnOpen: true as const } : {}),
      } satisfies ServerMessage),
    );
    // Fence the replay so the client knows the replayed transcript is complete
    // and can swap it in atomically. Only with replayLogsForVisible: without it
    // there is no replay to terminate. A lazy socket gets the fence alone.
    if (options?.replayLogsForVisible) {
      officeSendLazy(ws, replayFrames(lazy ? [] : agents.map((a) => a.id)));
    }
  }

  // --- Chats that load when they open (task 9ebe887d slice 2) ---------------
  // A lazy socket subscribes to an agent with open_log: the server replays the
  // agent's log in the outbox's background lane (live frames go first) and
  // from then on sends that agent's live entries. The open replays, per socket
  // and agent: their request, so a clear can restart one (R2).
  const pendingLogOpens = new WeakMap<
    ServerWebSocket<OfficeWsData>,
    Map<
      string,
      { requestId: string; tail?: number; front: boolean; token: object }
    >
  >();

  function sendLogOpenDone(
    ws: ServerWebSocket<OfficeWsData>,
    agentId: string,
    requestId: string,
    extra: { tail?: number; refused?: true } = {},
  ) {
    officeSend(
      ws,
      "log_open_done",
      JSON.stringify({
        type: "log_open_done",
        agentId,
        requestId,
        ...extra,
      } satisfies ServerMessage),
    );
  }

  // The replay of one open_log: the last `tail` entries pinned NOW (as
  // replayFrames pins them), the agent's commands, then log_open_done. The
  // pack filter is officeSendBackground's.
  function startLogReplay(
    ws: ServerWebSocket<OfficeWsData>,
    agentId: string,
    requestId: string,
    tail: number | undefined,
    front: boolean,
  ) {
    const logs = agentManager.getAgentLogs(agentId);
    const length = logs.length;
    const from = tail === undefined ? 0 : Math.max(0, length - tail);
    const cmds = agentManager.getAgentCommands(agentId);
    const token = {};
    let pending = pendingLogOpens.get(ws);
    if (!pending) {
      pending = new Map();
      pendingLogOpens.set(ws, pending);
    }
    pending.set(agentId, { requestId, tail, front, token });
    const mine = pending;
    const release = () => {
      if (mine.get(agentId)?.token === token) mine.delete(agentId);
    };
    const frames = (function* (): Generator<WsFrame> {
      try {
        for (let i = from; i < length; i++)
          yield {
            kind: "log_entry",
            data: JSON.stringify({
              type: "log_entry",
              entry: logs[i],
              requestId,
            } satisfies ServerMessage),
          };
        if (cmds.commands.length > 0 || cmds.skills.length > 0)
          yield {
            kind: "slash_commands",
            data: JSON.stringify({
              type: "slash_commands",
              agentId,
              commands: cmds.commands,
              skills: cmds.skills,
              requestId,
            } satisfies ServerMessage),
          };
        // Every entry is out: a clear from here on needs no restart.
        release();
        yield {
          kind: "log_open_done",
          data: JSON.stringify({
            type: "log_open_done",
            agentId,
            requestId,
            ...(tail === undefined ? {} : { tail }),
            // The tail reached the first entry: the whole log is in.
            ...(tail !== undefined && from === 0 ? { whole: true } : {}),
          } satisfies ServerMessage),
        };
      } finally {
        release();
      }
    })();
    officeSendBackground(ws, agentId, frames, { front });
  }

  function openLog(
    ws: ServerWebSocket<OfficeWsData>,
    agentId: string,
    requestId: string,
    tail: number | undefined,
    // A background prefetch goes behind the lane's other loads; any other
    // open (the chat on screen) goes to its front (task 9ebe887d slice 3).
    prefetch = false,
  ) {
    const session = ws.data.session;
    const known = agentManager.getAllAgents().some((a) => a.id === agentId);
    if (
      !ws.data.logsOnOpen ||
      !known ||
      !agentVisibleForSession(session, agentId) ||
      !wsPushAllowed(session, "log_entry")
    ) {
      // A live frame, in order behind every frame queued before it.
      sendLogOpenDone(ws, agentId, requestId, { refused: true });
      return;
    }
    (ws.data.logSubscriptions ??= new Set()).add(agentId);
    startLogReplay(ws, agentId, requestId, tail, !prefetch);
  }

  function dropLogSubscription(
    ws: ServerWebSocket<OfficeWsData>,
    agentId: string,
  ) {
    ws.data.logSubscriptions?.delete(agentId);
    pendingLogOpens.get(ws)?.delete(agentId);
    outboxFor(ws).cancelBackground(agentId);
  }

  // close_log: a stale request id (an older open of the same agent) leaves
  // the newer one alone.
  function closeLog(
    ws: ServerWebSocket<OfficeWsData>,
    agentId: string,
    requestId: string,
  ) {
    const pending = pendingLogOpens.get(ws)?.get(agentId);
    if (pending && pending.requestId !== requestId) return;
    dropLogSubscription(ws, agentId);
  }

  // Whether a lazy socket gets this agent's live stream frame.
  function liveLogAllowed(
    ws: ServerWebSocket<OfficeWsData>,
    agentId: string,
  ): boolean {
    return !ws.data.logsOnOpen || !!ws.data.logSubscriptions?.has(agentId);
  }

  // The agent's log was cleared (R2): a replay in flight still holds the old
  // array, so it restarts from the new one with the same request. Called
  // after the clear_logs frame is queued.
  function restartLogReplays(agentId: string) {
    for (const ws of browsers) {
      const pending = pendingLogOpens.get(ws)?.get(agentId);
      if (!pending) continue;
      startLogReplay(
        ws,
        agentId,
        pending.requestId,
        pending.tail,
        pending.front,
      );
    }
  }

  // An agent killed or deleted (R4) leaves every subscription.
  function forgetAgentLogs(agentId: string) {
    for (const ws of browsers)
      if (
        ws.data.logSubscriptions?.has(agentId) ||
        pendingLogOpens.get(ws)?.has(agentId)
      )
        dropLogSubscription(ws, agentId);
  }

  // The connect replay as a lazy run of frames: each agent's cached log entries,
  // then its slash commands, then the log_replay_complete fence. The snapshot is
  // taken NOW: a cached log only ever grows by push or is replaced by a new
  // array, so the array and its current length pin exactly the entries this
  // call would have sent at once, and entries pushed later reach the client as
  // the live frames queued behind the replay. Serialization waits for the
  // socket (server/office-ws-outbox.ts).
  function replayFrames(agentIds: string[]): Iterator<WsFrame> {
    const snapshot = agentIds.map((agentId) => {
      const logs = agentManager.getAgentLogs(agentId);
      return {
        agentId,
        logs,
        length: logs.length,
        cmds: agentManager.getAgentCommands(agentId),
      };
    });
    return (function* () {
      for (const { agentId, logs, length, cmds } of snapshot) {
        for (let i = 0; i < length; i++) {
          yield {
            kind: "log_entry",
            data: JSON.stringify({ type: "log_entry", entry: logs[i] }),
          };
        }
        if (cmds.commands.length > 0 || cmds.skills.length > 0) {
          yield {
            kind: "slash_commands",
            data: JSON.stringify({
              type: "slash_commands",
              agentId,
              commands: cmds.commands,
              skills: cmds.skills,
            }),
          };
        }
      }
      yield {
        kind: "log_replay_complete",
        data: JSON.stringify({ type: "log_replay_complete" }),
      };
    })();
  }

  // Push a fresh projected full_state to every WS owned by a specific
  // userId. Called after a view change (hidden rooms) - every device that user
  // is connected from gets the new view applied without a reconnect. An access
  // change re-projects through onUserAccessChanged instead.
  function pushProjectedFullStateForUserId(userId: string) {
    for (const ws of browsers) {
      if (ws.data.session.userId === userId) {
        sendProjectedFullState(ws, { replayLogsForVisible: true });
      }
    }
  }

  // An order-only view change: each of the user's sockets gets its own projected
  // room list, and no transcript replay.
  function pushRoomOrderForUserId(userId: string) {
    for (const ws of browsers) {
      if (ws.data.session.userId === userId) {
        officeSend(
          ws,
          "room_order_updated",
          JSON.stringify({
            type: "room_order_updated",
            rooms: visibleRoomProjection(ws.data.session).rooms,
          } satisfies ServerMessage),
        );
      }
    }
  }

  // Push the presence_list to just ONE user's sockets (each per-recipient
  // projected). Used after a per-user view change alters which rooms that user
  // sees (hidden/order): buildPresenceListFor re-filters their ghosts, but no
  // other user's projection changed - so this stays tighter than
  // pushPresenceListToEachWs.
  function pushPresenceListForUserId(userId: string) {
    for (const ws of browsers) {
      if (ws.data.session.userId === userId) sendPresenceListTo(ws);
    }
  }

  // The `tasks` wire event is per-recipient PROJECTED, not an all-audience
  // broadcast: each socket receives only the tasks in the rooms its user can
  // ACCESS, UNION every office-global task (no roomId), UNION closed rooms' tasks
  // for an office owner. Access, not view - a hidden room's tasks still show.
  // This is the reconnect/full_state hydration shape too, so a reload and a live
  // push agree.
  function projectTasksForSession(session: SessionLookup): TaskItem[] {
    const viewer = taskViewerForUser(getUserById(session.userId) ?? null);
    return agentManager
      .getTasks()
      .filter((t) => taskVisibleTo(t.roomId, viewer));
  }

  // A socket that asked for the summary board (task 9ebe887d) gets only the
  // open and in-progress tasks, each without its description, which the
  // client reads over GET /api/tasks when it needs them. The version stays the
  // full row's, so a save from a fetched row is checked as before.
  function sendTasksTo(ws: ServerWebSocket<OfficeWsData>) {
    const tasks = projectTasksForSession(ws.data.session);
    officeSend(
      ws,
      "tasks",
      JSON.stringify(
        ws.data.tasksSummary
          ? {
              type: "tasks",
              tasks: tasks
                .filter((t) => !isClosedTask(t))
                .map(({ description: _description, ...row }) => row),
              summary: true,
            }
          : { type: "tasks", tasks },
      ),
    );
  }

  // Push ONE task mutation to every socket as a per-recipient delta. Replaces the
  // old whole-board rebroadcast: at 535 tasks that was 635KB per mutation per
  // socket (68% of it done rows the default view hides), which is what made a
  // create take seconds to appear on a remote browser. taskDeltaFor decides what
  // each recipient is told - upsert, delete, or nothing at all - from their room
  // access; see server/events/task-delta.ts for the rule and why silence matters.
  function pushTaskDeltaToEachWs(change: TaskChange) {
    for (const ws of browsers) {
      const viewer = taskViewerForUser(
        getUserById(ws.data.session.userId) ?? null,
      );
      const delta = taskDeltaFor(change, viewer);
      if (delta) officeSend(ws, delta.type, JSON.stringify(delta));
    }
  }

  // Push ONE ask change to the sockets of the members askVisibleTo admits, the
  // rule GET /api/asks applies, and to no one else. A removal goes to the
  // members it named, every signed-in member for a room ask, or every owner
  // for an office secret request, with no room check, so a stack never keeps
  // an entry that closed. Office owners hear
  // other members' asks as others_ask_* (askShownToOwnerAsOther, the rule of
  // GET /api/asks/others); the removal of one goes to every other owner, with
  // no room check either.
  function pushAskChange(change: AskChange) {
    const { entry } = change;
    const forOwners = entry.secret?.scope === "office";
    // A plain ask's members at the close, and who answered it (task
    // 9461c464), named only to members who reach the room.
    const members =
      change.kind === "removed" && !forOwners
        ? askMemberIds(entry, askAudience)
        : [];
    const roomId = askAudience.agentRoomId(entry.agentId);
    const by =
      change.kind === "removed" && change.byUserId
        ? (getUserById(change.byUserId)?.name ?? null)
        : null;
    for (const ws of browsers) {
      const userId = ws.data.session.userId;
      if (change.kind === "removed") {
        // A room ask goes to every signed-in socket: a member who hid the
        // room or lost it since may still hold the card.
        const addressed = forOwners
          ? !!userId && askAudience.isOfficeOwner(userId)
          : !!userId && (!!entry.room || members.includes(userId));
        // Not to the answerer: their own tab would read it as beaten.
        const named =
          by !== null &&
          !!userId &&
          userId !== change.byUserId &&
          roomId !== null &&
          askAudience.canSeeRoom(userId, roomId);
        if (addressed)
          officeSend(
            ws,
            "ask_removed",
            JSON.stringify({
              type: "ask_removed",
              id: entry.id,
              ...(named ? { by } : {}),
            }),
          );
        // The office's page about a member's own feature is theirs alone.
        else if (
          !entry.secret &&
          !entry.office &&
          !!userId &&
          askAudience.isOfficeOwner(userId)
        )
          officeSend(
            ws,
            "others_ask_removed",
            JSON.stringify({ type: "others_ask_removed", id: entry.id }),
          );
        continue;
      }
      if (askVisibleTo(entry, userId, askAudience))
        officeSend(
          ws,
          "ask_upserted",
          JSON.stringify({
            type: "ask_upserted",
            entry: askMemberWire(
              entry,
              (id) => getUserById(id)?.name ?? null,
              askAudience,
            ),
          }),
        );
      else if (askShownToOwnerAsOther(entry, userId, askAudience))
        officeSend(
          ws,
          "others_ask_upserted",
          JSON.stringify({
            type: "others_ask_upserted",
            entry: askAgentWire(
              entry,
              (id) => getUserById(id)?.name ?? null,
              askAudience,
            ),
          }),
        );
    }
  }

  // A member's message to an agent: the one wrapper over sendMessage for the
  // chat send, the API-token send and an ask's answer. Resolves at the
  // acceptance decision (task 51de8814), never at turn completion: sendMessage
  // owns the echo / queue / recovery / slash / approval-reply overload and
  // streams the turn over WS.
  function sendMemberMessage(
    agentId: string,
    text: string,
    username: string | undefined,
    device: string | undefined,
    attachments: Attachment[] | undefined,
    opts: {
      sendNow?: boolean;
      clientMessageId?: string;
      ask?: AskRef;
      refusePromptAnswer?: boolean;
      limits?: ApiTokenLimits;
    } = {},
  ): Promise<UserSendAcceptance> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: UserSendAcceptance) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      agentManager
        .sendMessage(agentId, text, username, device, attachments, {
          ...opts,
          onAccepted: settle,
        })
        .then(() =>
          settle({
            ok: false,
            status: 500,
            code: "acceptance_missing",
            message: "The message did not reach an acceptance decision.",
          }),
        )
        .catch(() =>
          settle({
            ok: false,
            status: 500,
            code: "send_failed",
            message: "The message could not be sent.",
          }),
        );
    });
  }

  // A reply, a dismiss, a filed task, or a simplify request or its withdrawal
  // of an ask, delivered the way a typed member message is (an API token
  // through its own send record, as on the message route). Resolves at the
  // acceptance decision.
  function deliverAskAnswer(
    identity: Identity,
    entry: AskEntry,
    text: string,
    opts: {
      dismissed: boolean;
      simplify?: boolean;
      simplifyUndone?: boolean;
      taskId?: string;
      device: string | undefined;
    },
  ): Promise<UserSendAcceptance> {
    const username = attributionFor(identity).username;
    const ask = {
      id: entry.id,
      prompt: entry.prompt,
      ...(opts.dismissed ? { dismissed: true } : {}),
      ...(opts.simplify ? { simplify: true } : {}),
      ...(opts.simplifyUndone ? { simplifyUndone: true } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.app ? { app: { name: entry.app.name } } : {}),
      // The chat shows the answered ask in full (ui/log-view/ask-link.tsx).
      ...(entry.options ? { options: entry.options } : {}),
      ...(entry.recommended !== undefined
        ? { recommended: entry.recommended }
        : {}),
    };
    const send = (device: string | undefined) =>
      sendMemberMessage(entry.agentId, text, username, device, undefined, {
        ask,
      });
    // A member with a permission pack answers an agent outside it as data,
    // as a token does.
    if (identity.scope !== "api")
      return send(
        identity.memberPack && !identityFitsAgent(identity, entry.agentId)
          ? memberReplyDevice(opts.device)
          : opts.device,
      );
    const display = agentManager.getAgentDisplay(entry.agentId);
    return sendApiTokenMessage(
      identity.apiTokenId ?? "",
      {
        targetAgentId: entry.agentId,
        targetAgentName: display?.name ?? entry.agentId,
        targetRoomName: display?.roomName ?? "",
        text,
      },
      () =>
        send(
          formatApiTokenDevice(
            identity.apiTokenName ?? "unknown",
            identity.apiTokenId ?? "reply unavailable: missing token id",
            identity.apiTokenLimits?.repliesOnly === true ||
              !identityFitsAgent(identity, entry.agentId),
          ),
        ),
    ).then((result) => (result.ok ? { ok: true } : result));
  }

  // Webhooks: per-recipient, like cronjobs. A socket hears a hook it can see
  // (server/webhook-visibility.ts), and a delete when it could see it before.
  function pushWebhookDeltaToEachWs(change: WebhookChange) {
    for (const ws of browsers) {
      const delta = webhookDeltaFor(
        change,
        webhookViewerForSession(ws.data.session),
      );
      if (delta) officeSend(ws, delta.type, JSON.stringify(delta));
    }
  }

  // Cronjobs: per-recipient like tasks. sendCronjobsTo is the connect hydration
  // and the re-projection after a change that shifts what a socket may see with
  // no single job to point at (room close, a user's access or role change).
  function sendCronjobsTo(ws: ServerWebSocket<OfficeWsData>) {
    officeSend(
      ws,
      "cronjobs_state",
      JSON.stringify({
        type: "cronjobs_state",
        cronjobs: cronjobsFor(cronjobViewerForSession(ws.data.session)),
        cronjobsPrompt: cronjobManager.getCronjobsPrompt(),
      }),
    );
  }

  function pushCronjobsToEachWs() {
    for (const ws of browsers) sendCronjobsTo(ws);
  }

  function pushCronjobDeltaToEachWs(change: CronjobChange) {
    for (const ws of browsers) {
      const delta = cronjobDeltaFor(
        change,
        cronjobViewerForSession(ws.data.session),
      );
      if (delta) officeSend(ws, delta.type, JSON.stringify(delta));
    }
  }

  // A run row and a live run entry go to the sockets that can see the job.
  function pushCronjobRunToEachWs(run: CronjobRun) {
    const facts = cronjobFactsById(run.cronjobId);
    for (const ws of browsers) {
      if (cronjobVisibleTo(facts, cronjobViewerForSession(ws.data.session))) {
        officeSend(
          ws,
          "cronjob_run_updated",
          JSON.stringify({ type: "cronjob_run_updated", run }),
        );
      }
    }
  }

  function pushCronjobRunEntryToEachWs(entry: LogEntry, jobId: string) {
    const facts = cronjobFactsById(jobId);
    for (const ws of browsers) {
      if (cronjobVisibleTo(facts, cronjobViewerForSession(ws.data.session))) {
        officeSend(
          ws,
          "cron_run_log_entry",
          JSON.stringify({ type: "log_entry", entry }),
        );
      }
    }
  }

  // Re-project the WHOLE board to every socket. Not a mutation path - a mutation
  // sends one delta (pushTaskDeltaToEachWs). This is for the rare change that
  // shifts what MANY recipients may see at once with no single task to point at:
  // today, a room close, which strips a room from every user's access and leaves
  // its tasks to office owners. Each socket re-projects against its own access,
  // so this converges live boards to the reload view without telling anyone
  // anything new.
  function pushTasksToEachWs() {
    for (const ws of browsers) sendTasksTo(ws);
  }

  // A user's room access changed (users.ts setOnUserAccessChanged, wired at boot).
  // Re-project every socket of that user; no other user's projection changed.
  // A role change first refreshes the cached ws.data.session, which role-keyed
  // audiences (ownerSessions in liveEmitDeps) and visibleRoomProjection read, so
  // a just-demoted ex-owner gets no further owner-only event. REFRESH, not
  // evict: the session is still valid. If revalidation fails (expired/orphaned
  // in the meantime), fall back to the notify-then-close contract the
  // per-message path applies. The client then gets its role and owner room list
  // before the projected rooms, board and cronjobs.
  //
  // A grant write that leaves the LIVE accessible set unchanged re-projects
  // nothing: rooms.close strips the dead room id from every member after the
  // room is gone, and the bare room_closed delta plus close's own every-socket
  // board and cronjobs push already converge them (no full_state log replay).
  function onUserAccessChanged(userId: string, changed: UserAccessChange) {
    // A pack change: the member's pages reload (close code 4003, ui/ws.ts), so
    // the fresh connect gets the filtered snapshot and nothing the pack now
    // hides stays in the browser.
    if (changed.pack) {
      for (const ws of browsers) {
        if (ws.data.session.userId !== userId) continue;
        try {
          ws.close(ACCESS_CHANGED_CLOSE_CODE, "access changed");
        } catch {}
      }
      recheckOpenAppSockets();
      extensionService?.revalidate();
      return;
    }
    if (!changed.role) {
      const user = getUserById(userId);
      if (!user) return;
      const live = new Set(agentManager.getRooms().map((room) => room.id));
      const liveIds = (ids: Set<string>) =>
        [...ids].filter((id) => live.has(id));
      const now = liveIds(accessibleRoomIdsFor(user));
      const before = new Set(
        liveIds(accessibleRoomIdsFor(user, changed.previousAllowedRooms)),
      );
      if (now.length === before.size && now.every((id) => before.has(id))) {
        return;
      }
    }
    for (const ws of browsers) {
      if (ws.data.session.userId !== userId) continue;
      if (changed.role) {
        const fresh = revalidateByHash(ws.data.session.sessionIdHash);
        if (!fresh) {
          try {
            ws.send(JSON.stringify({ type: "session_expired" }));
          } catch {}
          try {
            ws.close();
          } catch {}
          continue;
        }
        ws.data.session = fresh;
        sendSessionContext(ws);
        officeSend(
          ws,
          "all_rooms_list",
          JSON.stringify({
            type: "all_rooms_list",
            rooms:
              fresh.role === "owner" ? agentManager.getOrdinaryRooms() : [],
          }),
        );
      }
      sendProjectedFullState(ws, { replayLogsForVisible: true });
      sendTasksTo(ws);
      sendCronjobsTo(ws);
    }
    recheckOpenAppSockets();
    extensionService?.revalidate();
  }

  // Dedupe preserving FIRST occurrence (used for the sparse `order` list, so a
  // hand-edited or client-sent order with duplicates resolves deterministically).
  function dedupeFirstWins(ids: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  // The SINGLE core that owns every per-user VIEW-preference write. TARGET-USER
  // based (owners edit a member's view via admin surfaces, and
  // a role-change/demotion hook re-clamps the target the same way), so the change
  // applies to targetUserId, never the actor's session. It is the ONE place that
  // computes: the rule-based ACCESSIBLE set, effective shown (accessible \
  // hidden), the sparse-order filter+dedupe, and the notifRooms/pushRooms clamp - then
  // persists once and fans out.
  //
  // NO-ORACLE on write (Isomuxer3 Q2): unknown / inaccessible / accessible-but-
  // hidden room ids are SILENTLY filtered/clamped, never rejected (a reject is an
  // existence oracle). Callers reject malformed body SHAPES before reaching here.
  //
  // `change` is a partial: any subset of {order, shown, notifRooms, tucked,
  // pushRooms}. An EMPTY change is the re-clamp pass (call after an access
  // mutation / demotion to re-establish hidden ⊆ accessible, notifRooms and
  // pushRooms ⊆ effective shown). `shown` is
  // the desired VISIBLE set (route input); it is converted at the boundary to
  // hidden = accessible \ shown (only accessible ids are ever persisted in
  // hidden). Returns false if the target user is missing.
  interface ViewChange {
    order?: readonly string[];
    shown?: readonly string[];
    notifRooms?: readonly string[];
    tucked?: readonly string[];
    pushRooms?: readonly string[];
  }

  // PURE clamp - the single source of truth for the view invariants. Given the
  // accessible set, the user's CURRENT view fields, and a partial change, compute
  // the next fields: order deduped (first wins) + filtered to accessible (hidden-
  // but-accessible ids KEPT, so hide/show is non-destructive); hidden = the
  // accessible rooms NOT in the desired shown set (or the stored hidden re-
  // filtered to accessible); tucked deduped + filtered to accessible (hidden ids
  // kept, as for order); notifRooms and pushRooms within effective shown and
  // off tucked rooms, with push within notifRooms (shared/room-view-level.ts:
  // each room is on one level). The list the change carries wins: a change
  // that carries pushRooms adds those rooms to notifRooms; any other change,
  // the empty re-clamp included, drops push rooms without notifications.
  // applyViewChange
  // (view.*) and the users.setAccess prune-clamp both clamp through this,
  // so the invariant lives in exactly one place.
  function clampViewFields(
    accessible: ReadonlySet<string>,
    current: {
      order: readonly string[];
      hidden: readonly string[];
      notifRooms: readonly string[];
      tucked: readonly string[];
      pushRooms: readonly string[];
    },
    change: ViewChange,
  ): {
    order: string[];
    hidden: string[];
    notifRooms: string[];
    tucked: string[];
    pushRooms: string[];
  } {
    const order = dedupeFirstWins([...(change.order ?? current.order)]).filter(
      (id) => accessible.has(id),
    );
    let hidden: string[];
    if (change.shown !== undefined) {
      const shownSet = new Set(change.shown.filter((id) => accessible.has(id)));
      hidden = [...accessible].filter((id) => !shownSet.has(id));
    } else {
      hidden = current.hidden.filter((id) => accessible.has(id));
    }
    const tucked = dedupeFirstWins([
      ...(change.tucked ?? current.tucked),
    ]).filter((id) => accessible.has(id));
    const hiddenSet = new Set(hidden);
    const tuckedSet = new Set(tucked);
    const canNotify = (id: string) =>
      accessible.has(id) && !hiddenSet.has(id) && !tuckedSet.has(id);
    const notifRooms = dedupeFirstWins([
      ...(change.notifRooms ?? current.notifRooms),
    ]).filter(canNotify);
    let pushRooms = dedupeFirstWins([
      ...(change.pushRooms ?? current.pushRooms),
    ]).filter(canNotify);
    if (change.pushRooms !== undefined && change.notifRooms === undefined) {
      for (const id of pushRooms) {
        if (!notifRooms.includes(id)) notifRooms.push(id);
      }
    } else {
      pushRooms = pushRooms.filter((id) => notifRooms.includes(id));
    }
    return { order, hidden, notifRooms, tucked, pushRooms };
  }

  function applyViewChange(targetUserId: string, change: ViewChange): boolean {
    const user = getUserById(targetUserId);
    if (!user) return false;
    const accessible = accessibleRoomIdsFor(user);

    // Snapshot prior values (as keys) BEFORE the write so the post-write fanout
    // can tell what actually changed (sets compared order-insensitively; `order`
    // is order-sensitive).
    const prevOrderKey = user.order.join("\u0000");
    const prevHiddenKey = [...user.hidden].sort().join("\u0000");
    const prevNotifKey = [...user.notifRooms].sort().join("\u0000");
    const prevTuckedKey = [...user.tucked].sort().join("\u0000");
    const prevPushKey = [...user.pushRooms].sort().join("\u0000");
    const next = clampViewFields(accessible, user, change);

    const r = updateUserById(targetUserId, {
      order: next.order,
      hidden: next.hidden,
      notifRooms: next.notifRooms,
      tucked: next.tucked,
      pushRooms: next.pushRooms,
    });
    if (!r.ok) {
      console.error(
        `[view] applyViewChange failed for ${targetUserId}: ${r.error}`,
      );
      return false;
    }

    // Fanout, scoped to what actually changed. order/hidden change the PROJECTION
    // (which rooms the target sees and in what order) → to the target's own
    // sockets, a projected full_state when hidden changed, else room_order_updated,
    // which replays no transcripts. notifRooms and hidden are record fields not carried
    // in full_state → emitUserUpdated (public wire to all, full record to
    // owners via the admin channel and to the subject via the self channel) +
    // emitUsersList. hidden joined the record fan-out with the hide-rooms UI. The
    // Users page edits it against the self record, so a shown write must refresh
    // user.hidden on the editing client or its form
    // would read dirty forever. `order` stays projection-only (no UI reads the
    // record field; RoomTabBar is echo-authoritative).
    const hiddenChanged =
      [...next.hidden].sort().join("\u0000") !== prevHiddenKey;
    const orderChanged = next.order.join("\u0000") !== prevOrderKey;
    const notifChanged =
      [...next.notifRooms].sort().join("\u0000") !== prevNotifKey;
    // A notifRooms write keeps its public frames (view.setNotifRooms emits
    // user_updated). A tuck or push write that moves notifRooms through the
    // clamp stays private, like the field it carries.
    const recordChanged =
      hiddenChanged || (notifChanged && change.notifRooms !== undefined);
    if (hiddenChanged) {
      // The visible set changed: newly shown rooms need their transcripts.
      pushProjectedFullStateForUserId(targetUserId);
    } else if (orderChanged) {
      pushRoomOrderForUserId(targetUserId);
    }
    if (hiddenChanged || orderChanged) {
      // Re-push the target's OWN presence list: hiding/reordering changes which
      // rooms are visible to them, so buildPresenceListFor re-filters their ghosts
      // (full_state carries no presence; only this user's sockets are affected).
      pushPresenceListForUserId(targetUserId);
    }
    if (recordChanged) {
      emitUserUpdated(r.user);
      emitUsersList();
    } else if (
      notifChanged ||
      [...next.tucked].sort().join("\u0000") !== prevTuckedKey ||
      [...next.pushRooms].sort().join("\u0000") !== prevPushKey
    ) {
      // Tucked and pushRooms are private and not in full_state: they leave the
      // projection as it is, so only the record goes out, on the private
      // channels. So does the notifRooms change their clamp makes.
      emitPrivateUserRecord(r.user);
    }
    return true;
  }

  // Personal-preference core. Sibling of applyViewChange: it persists the
  // self-only preference fields and fans out the record. There is
  // nothing to clamp here - the handler already rejected values outside the
  // supported set, and users.ts normalizes defensively on top - so this is just
  // write + conditional fan-out. No projection is involved: neither field
  // changes which rooms or agents the user can see, so no full_state push.
  function applyPreferencesChange(
    targetUserId: string,
    change: PreferencesReq,
  ): boolean {
    const user = getUserById(targetUserId);
    if (!user) return false;
    const r = updateUserById(targetUserId, change);
    if (!r.ok) {
      console.error(
        `[prefs] applyPreferencesChange failed for ${targetUserId}: ${r.error}`,
      );
      return false;
    }
    // Only fan out on a real change.
    if (
      r.user.language !== user.language ||
      r.user.voiceInput !== user.voiceInput ||
      r.user.voiceOutput !== user.voiceOutput ||
      r.user.voiceName !== user.voiceName ||
      JSON.stringify(r.user.recordingWords) !==
        JSON.stringify(user.recordingWords)
    ) {
      emitPrivateUserRecord(r.user);
    }
    return true;
  }

  return {
    agentVisibleForSession,
    applyPreferencesChange,
    applyViewChange,
    clampViewFields,
    deliverAskAnswer,
    onUserAccessChanged,
    projectAgentForSession,
    pushAskChange,
    pushCronjobDeltaToEachWs,
    pushCronjobRunEntryToEachWs,
    pushCronjobRunToEachWs,
    pushCronjobsToEachWs,
    pushTaskDeltaToEachWs,
    pushTasksToEachWs,
    pushWebhookDeltaToEachWs,
    replayFrames,
    openLog,
    closeLog,
    liveLogAllowed,
    restartLogReplays,
    forgetAgentLogs,
    sendCronjobsTo,
    sendMemberMessage,
    sendProjectedFullState,
    sendTasksTo,
    visibleRoomProjection,
  };
}
