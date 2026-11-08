// The agent and cronjob event fan-out: wireEventSinks routes AgentManager and
// CronjobManager domain events onto the office sockets. Moved out of
// server/isomux-office.ts, which creates it once and calls wireEventSinks from
// startServer.
import type { ServerWebSocket } from "bun";
import { errMessage } from "../shared/errors.ts";
import type { TaskChange } from "../shared/office-state.ts";
import type {
  AgentInfo,
  Cronjob,
  CronjobRun,
  LogEntry,
  ServerMessage,
} from "../shared/types.ts";
import { setApiTokenStreamSinks } from "./api-tokens.ts";
import type { SessionLookup } from "./auth.ts";
import type { CronjobVisibilityFacts } from "./cronjob-visibility.ts";
import type { EmitContext } from "./events/emit.ts";
import type { CronjobChange } from "./events/cronjob-delta.ts";
import type { EventId, EventPayloads } from "./events/registry.ts";
import type { AgentEvent } from "./internal-types.ts";
import type { ApiTokenWsData, OfficeWsData } from "./isomux-office.ts";
import {
  agentManager,
  askStore,
  cronjobManager,
  extensionService,
  turnEndWatch,
} from "./office-managers.ts";
import { type WsPushKind } from "./ws-push-area.ts";

// What the event fan-out reads from server/isomux-office.ts.
export interface EventFanoutDeps {
  agentVisibleForSession: (session: SessionLookup, agentId: string) => boolean;
  announceCronjobHookAudience: (
    cronjobId: string,
    roomBefore: string | null,
  ) => void;
  apiTokenSockets: Set<ServerWebSocket<ApiTokenWsData>>;
  broadcast: (msg: ServerMessage) => void;
  browsers: Set<ServerWebSocket<OfficeWsData>>;
  cronjobFacts: (
    job: Pick<Cronjob, "userId" | "roomId" | "createdByAgentId">,
  ) => CronjobVisibilityFacts;
  liveEmit: <K extends EventId>(
    id: K,
    payload: EventPayloads[K],
    ctx?: EmitContext,
  ) => void;
  officeSend: (
    ws: ServerWebSocket<OfficeWsData>,
    kind: WsPushKind,
    data: string,
  ) => void;
  projectAgentForSession: (
    session: SessionLookup,
    agent: AgentInfo,
  ) => AgentInfo | null;
  pushAllRoomsListToOwners: () => void;
  pushCronjobDeltaToEachWs: (change: CronjobChange) => void;
  pushCronjobRunEntryToEachWs: (entry: LogEntry, jobId: string) => void;
  pushCronjobRunToEachWs: (run: CronjobRun) => void;
  pushTaskDeltaToEachWs: (change: TaskChange) => void;
  roomAllowedForSession: (session: SessionLookup, roomId: string) => boolean;
  sendProjectedFullState: (
    ws: ServerWebSocket<OfficeWsData>,
    options?: { replayLogsForVisible?: boolean },
  ) => void;
  sessionHasFullRoomAccess: (session: SessionLookup) => boolean;
  wakeTokenLogWaiters: (tokenId: string) => void;
  // Chats that load when they open (task 9ebe887d): a lazy socket gets an
  // agent's stream frames only after open_log; a clear restarts a replay in
  // flight; a removed agent leaves every subscription.
  liveLogAllowed: (
    ws: ServerWebSocket<OfficeWsData>,
    agentId: string,
  ) => boolean;
  restartLogReplays: (agentId: string) => void;
  forgetAgentLogs: (agentId: string) => void;
}

export function createEventFanout(deps: EventFanoutDeps) {
  const {
    agentVisibleForSession,
    announceCronjobHookAudience,
    apiTokenSockets,
    broadcast,
    browsers,
    cronjobFacts,
    liveEmit,
    officeSend,
    projectAgentForSession,
    pushAllRoomsListToOwners,
    pushCronjobDeltaToEachWs,
    pushCronjobRunEntryToEachWs,
    pushCronjobRunToEachWs,
    pushTaskDeltaToEachWs,
    roomAllowedForSession,
    sendProjectedFullState,
    sessionHasFullRoomAccess,
    wakeTokenLogWaiters,
    liveLogAllowed,
    restartLogReplays,
    forgetAgentLogs,
  } = deps;

  // Per-WS dispatch for events that touch a specific room or agent.
  // Sessions whose allowedRooms covers every current room id take the
  // fast path and receive the event verbatim. Sessions with partial
  // coverage get either:
  //   - the event verbatim if its room/agent is visible (post-cut there's no
  //     dense index to rewrite - agents carry stable room ids), or
  //   - a suppressed event (the room/agent isn't visible), or
  //   - a fresh projected full_state when a move could change which agents are
  //     visible to a restricted recipient (agent move across rooms).
  //
  // The full_state-on-shift approach is heavy-handed but keeps the UI's
  // existing positional contract intact. log entries are replayed for
  // agents that become newly visible inside the same call.
  function routeAgentEvent(event: AgentEvent) {
    for (const ws of browsers) {
      routeAgentEventToWs(ws, event);
    }
  }

  // Route the room-ACL agent/room event fanout through the emit()
  // helper (registry audience) + the projection-aware deliver(), replacing the
  // implicit per-WS routeAgentEvent for every event whose registry audience maps
  // 1:1 to today's access decision (verified byte-identical; projection.test
  // stays green). One event that needs pre-mutation context the domain event
  // drops stays on the routeAgentEvent bridge until the carried-context slice
  // lands for it:
  //   - agent_updated MOVE (changes.roomId set): carries the NEW roomId but drops
  //     the OLD room the old∪new move audience needs.
  // agent_removed left the bridge: the domain event now carries
  // the pre-removal roomId, so it rides the registry's room-ACL audience
  // (carriedRoomId) instead of the old broadcast-all.
  function emitAgentEvent(event: AgentEvent): void {
    if (event.type === "agent_updated" || event.type === "agent_removed")
      extensionService?.revalidate();
    switch (event.type) {
      case "log_entry":
        liveEmit(
          "log_entry",
          event.open
            ? { entry: event.entry, open: true }
            : { entry: event.entry },
        );
        break;
      case "clear_logs":
        liveEmit(
          "clear_logs",
          event.rollback
            ? { agentId: event.agentId, rollback: true }
            : { agentId: event.agentId },
        );
        // After the clear frame: a replay in flight restarts from the new log.
        restartLogReplays(event.agentId);
        break;
      case "slash_commands":
        liveEmit("slash_commands", {
          agentId: event.agentId,
          commands: event.commands,
          skills: event.skills,
        });
        break;
      case "terminal_output":
        liveEmit("terminal_output", {
          agentId: event.agentId,
          data: event.data,
        });
        break;
      case "terminal_status":
        liveEmit("terminal_status", {
          agentId: event.agentId,
          process: event.process,
          shell: event.shell,
          ...(event.envStale ? { envStale: true as const } : {}),
        });
        break;
      case "terminal_exit":
        liveEmit("terminal_exit", {
          agentId: event.agentId,
          exitCode: event.exitCode,
        });
        break;
      case "agent_added":
        liveEmit("agent_added", { agent: event.agent });
        break;
      case "interaction_added":
        liveEmit("interaction_added", { interaction: event.interaction });
        break;
      case "interaction_removed":
        liveEmit("interaction_removed", {
          interactionId: event.interactionId,
          agentId: event.agentId,
        });
        break;
      case "killed_agent_added":
        liveEmit("killed_agent_added", { agent: event.agent });
        break;
      case "killed_agent_removed":
        liveEmit("killed_agent_removed", {
          agentId: event.agentId,
          lastRoomId: event.lastRoomId,
        });
        break;
      case "agent_removed":
        forgetAgentLogs(event.agentId);
        // The agent's open asks go with it.
        try {
          askStore?.removeAgent(event.agentId);
        } catch (err) {
          console.error(
            `[asks] could not remove ${event.agentId}'s entries:`,
            errMessage(err),
          );
        }
        // Room-ACL via the CARRIED pre-removal roomId. The agent
        // is already gone from state, so the registry's carriedRoomId projection
        // is what makes the audience computable; sessions that couldn't see the
        // room no longer learn the id existed.
        liveEmit("agent_removed", {
          agentId: event.agentId,
          roomId: event.roomId,
        });
        break;
      case "room_created":
        liveEmit("room_created", { room: event.room });
        break;
      case "room_renamed":
        liveEmit("room_renamed", { roomId: event.roomId, name: event.name });
        break;
      case "room_settings_updated":
        liveEmit("room_settings_updated", {
          roomId: event.roomId,
          prompt: event.prompt,
        });
        break;
      case "room_pet_updated":
        liveEmit("room_pet_updated", {
          roomId: event.roomId,
          pet: event.pet,
        });
        break;
      case "room_skin_updated":
        liveEmit("room_skin_updated", {
          roomId: event.roomId,
          skin: event.skin,
        });
        break;
      case "room_decor_updated":
        liveEmit("room_decor_updated", {
          roomId: event.roomId,
          decor: event.decor,
        });
        break;
      case "room_cwd_updated":
        liveEmit("room_cwd_updated", { roomId: event.roomId, cwd: event.cwd });
        break;
      case "room_closed":
        liveEmit("room_closed", { roomId: event.roomId });
        break;
      case "agent_updated":
        // NON-move updates project via agentLookup on the agent's CURRENT room.
        // A MOVE is discriminated by a present `roomId` in changes; it needs the
        // old∪new audience the domain event can't supply yet, so it rides the
        // bridge (full_state refresh for restricted recipients) until oldRoomId is
        // carried in the carried-context slice.
        if (event.changes.roomId === undefined) {
          liveEmit("agent_updated", {
            agentId: event.agentId,
            changes: event.changes,
          });
        } else {
          routeAgentEvent(event);
        }
        break;
      default:
        // The routeAgentEvent bridge is BOUNDED - it is allowed ONLY for
        // agent_updated with changes.roomId set (handled in the case above),
        // plus any explicitly documented bridge case. Nothing else may be added
        // here. agent_removed left the bridge (carried roomId →
        // room-ACL; the characterization lives in projection.test.ts);
        // the bounded-bridge + behavioral raw-send invariant (no un-projected
        // fanout outside the projection dispatcher) is enforced by the
        // contract-test slice. This default is unreachable for the remaining
        // event types (office_settings_updated / tasks_changed are handled
        // before emitAgentEvent is called).
        routeAgentEvent(event);
        break;
    }
  }

  function routeAgentEventToWs(
    ws: ServerWebSocket<OfficeWsData>,
    event: AgentEvent,
  ) {
    const session = ws.data.session;
    const streamAgent =
      event.type === "log_entry"
        ? event.entry.agentId
        : event.type === "clear_logs" || event.type === "slash_commands"
          ? event.agentId
          : null;
    if (streamAgent !== null && !liveLogAllowed(ws, streamAgent)) return;

    if (sessionHasFullRoomAccess(session)) {
      officeSend(ws, event.type, JSON.stringify(event));
      return;
    }

    switch (event.type) {
      case "agent_added": {
        const projected = projectAgentForSession(session, event.agent);
        if (projected) {
          officeSend(
            ws,
            "agent_added",
            JSON.stringify({ type: "agent_added", agent: projected }),
          );
        }
        break;
      }
      case "agent_removed": {
        // Defensive/legacy branch: agent_removed is delivered via the emit()
        // registry (room-ACL on the carried pre-removal roomId), not this
        // bridge, so this case is not normally reached. Scoped like
        // killed_agent_added right below - a session that couldn't see the
        // room must not learn the id existed.
        if (roomAllowedForSession(session, event.roomId)) {
          officeSend(ws, event.type, JSON.stringify(event));
        }
        break;
      }
      case "killed_agent_added": {
        // ACL: only deliver if the session can see the lastRoomId. A
        // member shouldn't learn a private room's agent died.
        if (roomAllowedForSession(session, event.agent.lastRoomId)) {
          officeSend(ws, event.type, JSON.stringify(event));
        }
        break;
      }
      case "killed_agent_removed": {
        // Symmetric ACL with the added variant: a session that never
        // saw the chip shouldn't learn the id became alive again.
        if (roomAllowedForSession(session, event.lastRoomId)) {
          officeSend(ws, event.type, JSON.stringify(event));
        }
        break;
      }
      case "agent_updated": {
        if (event.changes.roomId !== undefined) {
          // Room move (discriminated by a present roomId): for a restricted
          // recipient the agent could be entering, leaving, or staying in their
          // visible set, so a targeted full_state refresh is the cheapest correct
          // play - but the UI's full_state reducer clears logs/slashCommands, so
          // we replay them for every currently-visible agent or the member loses
          // transcripts.
          sendProjectedFullState(ws, { replayLogsForVisible: true });
        } else if (agentVisibleForSession(session, event.agentId)) {
          // No room change - non-room fields are safe to forward verbatim.
          officeSend(ws, event.type, JSON.stringify(event));
        }
        break;
      }
      case "room_created": {
        if (roomAllowedForSession(session, event.room.id)) {
          // New room is at the end of the global rooms array → also at
          // the end of this session's visible array. No index shift.
          officeSend(ws, event.type, JSON.stringify(event));
        }
        // If the room is not allowed, the member's visible list is
        // unchanged.
        break;
      }
      case "room_closed":
      case "room_renamed":
      case "room_settings_updated": {
        // Defensive/legacy branch: these room events are delivered via the emit()
        // registry + deliver() path, not this bridge, so this case is not normally
        // reached. Post-cut none of them shift any dense index (room ids are
        // stable), so a visible recipient takes the verbatim delta and a
        // non-visible one drops it.
        if (roomAllowedForSession(session, event.roomId)) {
          officeSend(ws, event.type, JSON.stringify(event));
        }
        break;
      }
      case "log_entry": {
        if (agentVisibleForSession(session, event.entry.agentId)) {
          officeSend(ws, event.type, JSON.stringify(event));
        }
        break;
      }
      case "clear_logs":
      case "slash_commands":
      case "terminal_output":
      case "terminal_status":
      case "terminal_exit": {
        if (agentVisibleForSession(session, event.agentId)) {
          officeSend(ws, event.type, JSON.stringify(event));
        }
        break;
      }
      case "office_settings_updated":
      case "tasks_changed": {
        // No room scope - everyone sees these.
        officeSend(ws, event.type, JSON.stringify(event));
        break;
      }
    }
  }

  // wireEventSinks: route AgentManager + CronjobManager domain events onto the
  // WS broadcast / per-recipient fanout. Extracted so startServer() wires the
  // active instances. Body left at prior indentation; prettier normalizes.
  function wireEventSinks(): void {
    setApiTokenStreamSinks({
      logEntry: (tokenId, entry) => {
        liveEmit(
          "api_token_log_entry",
          { tokenId, entry },
          { apiTokenId: tokenId },
        );
        wakeTokenLogWaiters(tokenId);
      },
      revoked: (tokenId) => {
        for (const ws of apiTokenSockets) {
          if (ws.data.tokenId !== tokenId) continue;
          ws.close(1008, "API token unavailable");
          apiTokenSockets.delete(ws);
        }
      },
    });
    agentManager.onEvent((event) => {
      // Task mutations carry the full board as a domain event, but the WS layer
      // sends only the ONE task that moved: the board is ROOM-SCOPED, so what a
      // socket must be told depends on whether that task is visible to THAT
      // recipient before and after the change. The event's `tasks` payload is
      // ignored here (the persistence sink is its consumer); the whole list still
      // rides the `tasks` event at connect and on a room-access change, so a
      // reload and the accumulated deltas agree.
      if (event.type === "tasks_changed") {
        pushTaskDeltaToEachWs(event.change);
        return;
      }
      // Office settings: envFile is owner-only and NEVER rides this all-audience
      // event. Members read {prompt,name}; owners learn envFile via
      // their full_state (owner office projection) / office.getSettings on reload.
      if (event.type === "office_settings_updated") {
        broadcast({
          type: "office_settings_updated",
          prompt: event.prompt,
          name: event.name,
        });
        return;
      }
      // All remaining events touch a specific room or agent. The registry routes the
      // clean room-ACL events through the emit() helper (registry audience) +
      // projection-aware deliver(); agent_updated-MOVE stays on the
      // routeAgentEvent bridge inside emitAgentEvent (agent_removed left the
      // bridge - carried roomId → room-ACL).
      emitAgentEvent(event);
      turnEndWatch?.observe(event);
      // Any mutation of the global rooms list also refreshes the owner-only
      // admin view of all rooms (used by UserSettingsView). Done here
      // (rather than inside routeAgentEvent) so the all_rooms_list message
      // doesn't fan out per-event-type; one shot per mutation.
      if (
        event.type === "room_created" ||
        event.type === "room_closed" ||
        event.type === "room_renamed" ||
        event.type === "room_settings_updated"
      ) {
        pushAllRoomsListToOwners();
      }
    });

    cronjobManager.onCronjobEvent((event) => {
      switch (event.type) {
        // The clean `all`-audience cron events route through the emit() helper
        // (byte-identical broadcast); matching registry ids + payload shapes.
        // Cronjob records are per-recipient: who sees a job, and how much of
        // it, depends on the socket (server/events/cronjob-delta.ts).
        case "cronjob_added":
          pushCronjobDeltaToEachWs({
            kind: "added",
            cronjob: event.cronjob,
            facts: cronjobFacts(event.cronjob),
          });
          break;
        case "cronjob_updated":
          pushCronjobDeltaToEachWs({
            kind: "updated",
            cronjob: event.cronjob,
            facts: cronjobFacts(event.cronjob),
            before: cronjobFacts(event.previous ?? event.cronjob),
          });
          announceCronjobHookAudience(
            event.cronjob.id,
            cronjobFacts(event.previous ?? event.cronjob).liveRoomId,
          );
          break;
        case "cronjob_deleted":
          pushCronjobDeltaToEachWs({
            kind: "deleted",
            id: event.id,
            before: cronjobFacts(event.cronjob),
          });
          announceCronjobHookAudience(
            event.id,
            cronjobFacts(event.cronjob).liveRoomId,
          );
          break;
        case "cronjobs_prompt_updated":
          liveEmit("cronjobs_prompt_updated", { value: event.value });
          break;
        case "cronjob_run_updated":
          pushCronjobRunToEachWs(event.run);
          break;
        // COMPATIBILITY BRIDGE: cron-run transcript entries stream as `log_entry`
        // with a synthetic cronrun-<runId> agentId. The TARGET registry event is
        // `cron_run_log_entry`, but the UI/demo still key cron transcripts on
        // `log_entry` (ui/store.tsx), and the target `log_entry` registry entry
        // is room-ACL (it would fail-closed on the non-existent synthetic agent).
        // So these keep the `log_entry` wire shape, sent only to the sockets
        // that may see the job. Do NOT
        // route through liveEmit until shared ServerMessage, ui/store, and
        // demo-server switch together.
        case "log_entry":
          pushCronjobRunEntryToEachWs(event.entry, event.jobId);
          break;
      }
    });
  } // end wireEventSinks

  return { wireEventSinks };
}
