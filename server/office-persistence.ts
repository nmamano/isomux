// Rooms and desks, the agent manifest, the save of agents.json and
// agent-history.json, and the killed-agent roster. Moved out of
// createAgentManager (server/agent-manager.ts), which wires it.
import {
  agentAccessOf,
  stopHasPack,
  type AgentAccess,
} from "../shared/agent-access.ts";
import type { ApiTokenLimits } from "../shared/api-token-limits.ts";
import type {
  LogInFlightTurn,
  ManifestInFlightTurn,
} from "../shared/contract-shapes.ts";
import type { OfficeState } from "../shared/office-state.ts";
import type { RoomPet } from "../shared/pets.ts";
import type { RoomDecorPatch } from "../shared/room-decor.ts";
import type { RoomSkin } from "../shared/room-skins.ts";
import {
  claudeModelFor,
  claudePermissionModeFor,
  isClaudeFamily,
  LOBBY_ROOM,
  LOBBY_ROOM_ID,
  type AgentInfo,
  type KilledAgentSummary,
  type PendingPromptKind,
  type RoomWire,
} from "../shared/types.ts";
import { statSync } from "fs";
import { join } from "path";
import { persistedAutoHandoffTokens } from "./auto-handoff.ts";
import { STATE_ROOT } from "./config.ts";
import {
  pendingPromptOf,
  type AgentEvent,
  type ManagedAgent,
} from "./internal-types.ts";
import type { createMessageQueue } from "./message-queue.ts";
import {
  buildManifest,
  loadAgentHistory,
  saveAgentHistory,
  saveAgents,
  storedTopic,
  writeManifest,
  type AgentHistory,
  type AgentHistoryEntry,
  type PersistedAgent,
  type Room,
} from "./persistence.ts";
import { spawnTreeFields } from "./spawn-agent-limits.ts";
import { buildUsageReportData, type UsageAudience } from "./usage-report.ts";

export interface OfficePersistenceDeps {
  agents: Map<string, ManagedAgent>;
  officeState: OfficeState;
  emit: (event: AgentEvent) => void;
  // The lobby seed flag, a `let` of createAgentManager.
  isLobbySeedPending: () => boolean;
  globalRoomIndexOf: (roomId: string) => number;
  roomById: (roomId: string) => RoomWire | undefined;
  unclaimedQueue: ReturnType<typeof createMessageQueue>["unclaimedQueue"];
  accessFields: (src: { access?: AgentAccess; pack?: ApiTokenLimits }) => {
    access?: AgentAccess;
    pack?: ApiTokenLimits;
  };
}

export function createOfficePersistence(deps: OfficePersistenceDeps) {
  const {
    agents,
    officeState,
    emit,
    isLobbySeedPending,
    globalRoomIndexOf,
    roomById,
    unclaimedQueue,
    accessFields,
  } = deps;

  function swapDesks(deskA: number, deskB: number, roomId: string) {
    const events = officeState.swapDesks(deskA, deskB, roomId);
    for (const event of events) emit(event);
  }

  function createRoom(name?: string, skin?: RoomSkin | null): string {
    const events = officeState.createRoom(name, skin);
    const created = events.find((e) => e.type === "room_created");
    if (!created) throw new Error("failed to create room");
    for (const event of events) emit(event);
    return created.room.id;
  }

  function closeRoom(roomId: string): boolean {
    const events = officeState.closeRoom(roomId);
    if (events.length === 0) return false;
    for (const event of events) emit(event);
    return true;
  }

  function renameRoom(roomId: string, name: string): boolean {
    const events = officeState.renameRoom(roomId, name);
    if (events.length === 0) return false;
    // Room name appears in the system prompt header; it's rebuilt at every
    // createSession, so agents in this room pick up the new name on their next
    // conversation automatically.
    for (const event of events) emit(event);
    return true;
  }

  /** Sets the room's pet; null clears it back to the default. Unlike a rename
   *  this changes nothing an agent can read, so no session or prompt is
   *  rebuilt - it only has to reach the other clients and the disk. */
  function setRoomPet(roomId: string, pet: RoomPet | null): boolean {
    const events = officeState.setRoomPet(roomId, pet);
    if (events.length === 0) return false;
    for (const event of events) emit(event);
    persistAll();
    return true;
  }

  /** Sets the room's skin; null clears it back to the office look. Like the pet
   *  this changes nothing an agent can read, so no session or prompt is rebuilt.
   *  The lobby draws its own scene and takes no skin, and the caller has to tell
   *  that apart from an unknown room, so this reports which one it was rather
   *  than a bare boolean. */
  function setRoomSkin(
    roomId: string,
    skin: RoomSkin | null,
  ): "ok" | "room_not_found" | "skin_not_supported" {
    const room = officeState.rooms.find((r) => r.id === roomId);
    if (!room) return "room_not_found";
    if (room.type === "lobby") return "skin_not_supported";
    const events = officeState.setRoomSkin(roomId, skin);
    if (events.length === 0) return "room_not_found";
    for (const event of events) emit(event);
    persistAll();
    return "ok";
  }

  /** Applies a decor patch; null clears every choice. Answers like
   *  setRoomSkin, because decor sits on top of the skin and the lobby takes
   *  neither. */
  function setRoomDecor(
    roomId: string,
    patch: RoomDecorPatch | null,
  ): "ok" | "room_not_found" | "skin_not_supported" {
    const room = officeState.rooms.find((r) => r.id === roomId);
    if (!room) return "room_not_found";
    if (room.type === "lobby") return "skin_not_supported";
    const events = officeState.setRoomDecor(roomId, patch);
    if (events.length === 0) return "room_not_found";
    for (const event of events) emit(event);
    persistAll();
    return "ok";
  }

  /** Sets the folder new agents in the room start in (null clears it). Like
   *  the pet it changes nothing a running agent reads. */
  function setRoomCwd(roomId: string, cwd: string | null): boolean {
    const events = officeState.setRoomCwd(roomId, cwd);
    if (events.length === 0) return false;
    for (const event of events) emit(event);
    persistAll();
    return true;
  }

  function moveAgent(agentId: string, targetRoomId: string): boolean {
    const events = officeState.moveAgent(agentId, targetRoomId);
    if (events.length === 0) return false;
    for (const event of events) emit(event);
    return true;
  }

  // moveAgent with a place: a front desk, null for a back seat, or omitted to
  // keep the agent's area (OfficeState.placeAgent).
  function placeAgent(
    agentId: string,
    targetRoomId: string,
    desk?: number | null,
  ): ReturnType<OfficeState["placeAgent"]> {
    const r = officeState.placeAgent(agentId, targetRoomId, desk);
    if (r.ok) for (const event of r.events) emit(event);
    return r;
  }

  function getAllAgents(): AgentInfo[] {
    // info.queue is initialized empty and never mutated; the live queue lives on
    // managed.messageQueue and reaches connected clients via incremental
    // agent_updated events. Splice it in here so full_state (sent on each new WS
    // connect) carries it too. Without this, a device opening the convo after
    // another device already queued messages would render no queue chips.
    // pendingPrompt is derived here for the same reason: it is live state, so
    // full_state must carry today's value rather than whatever the last
    // incremental event happened to set.
    return [...agents.values()].map((a) => ({
      ...a.info,
      queue: unclaimedQueue(a),
      pendingPrompt: pendingPromptOf(a),
    }));
  }

  function getUsageReportData(audience: UsageAudience) {
    return buildUsageReportData(agents, officeState.rooms, audience);
  }

  // Shared entry builder for the on-disk manifest (agents-summary.json) and
  // the GET /agents discovery endpoint - one source so they can't drift.
  function manifestEntries() {
    const rooms = officeState.ordinaryRooms;
    return [...agents.values()].map((a) => {
      // The manifest's `room` number (and its room name) is a
      // derived display field, recomputed from the authoritative roomId.
      // Lobby occupants keep the manifest room:null wire contract.
      const lobby = roomById(a.info.roomId)?.type === "lobby";
      const roomIdx = rooms.findIndex((r) => r.id === a.info.roomId);
      return {
        id: a.info.id,
        name: a.info.name,
        desk: a.info.desk,
        room: lobby ? null : roomIdx,
        roomName: lobby
          ? LOBBY_ROOM.name
          : (rooms[roomIdx]?.name ?? `Room ${roomIdx + 1}`),
        roomId: a.info.roomId,
        topic: a.info.topic,
        cwd: a.info.cwd,
        modelFamily: a.info.modelFamily,
        // The model the agent runs, as a canonical Anthropic id (claudeModelFor:
        // a Bedrock or Vertex pin verbatim, else the canonical id of the model
        // the alias runs), never the provider's regional or dated form. Codex
        // and OpenCode already store their model ids.
        model: isClaudeFamily(a.info.modelFamily)
          ? claudeModelFor(a.info.modelFamily, a.info.claudeFamilyModels)
          : a.info.modelFamily,
        effort: a.info.effort,
        // The mode the agent runs with: a stored Auto on a limited family
        // reads as default. The stored value stays in agents.json.
        permissionMode:
          a.info.agentType === "claude"
            ? claudePermissionModeFor(
                a.info.modelFamily,
                a.info.permissionMode,
                a.info.limitedClaudeFamilies,
              )
            : a.info.permissionMode,
        // Keep agentType out of the established compact discovery contract.
        // The adjacent sandbox field remains Codex-only state.
        sandbox: a.info.codexSandbox ?? null,
        manager: a.info.manager,
      };
    });
  }

  function updateManifest() {
    writeManifest(manifestEntries());
  }

  // Which two-step prompt an agent is parked on right now, or null. An unknown
  // or killed id cannot be waiting for an
  // answer. Read by the logs route so a transcript reader can tell a parked
  // agent from one whose backend died.
  function pendingPrompt(agentId: string): PendingPromptKind | null {
    const managed = agents.get(agentId);
    return managed ? pendingPromptOf(managed) : null;
  }

  function oldestActiveTool(managed: ManagedAgent) {
    let oldest: { name: string; startedAt: number } | null = null;
    for (const tool of managed.toolCallTimestamps.values()) {
      if (!oldest || tool.startedAt < oldest.startedAt) oldest = tool;
    }
    return oldest;
  }

  function inFlightTurnForLogs(agentId: string): LogInFlightTurn | null {
    const managed = agents.get(agentId);
    if (!managed || !managed.sessionManager.turnIsLive(managed)) return null;
    const activeTool = oldestActiveTool(managed);
    return {
      startedAt: managed.turnStartedAt,
      activeTool: activeTool ? { ...activeTool } : null,
    };
  }

  function inFlightTurnForManifest(
    managed: ManagedAgent,
  ): ManifestInFlightTurn | null {
    if (!managed.sessionManager.turnIsLive(managed)) return null;
    const activeTool = oldestActiveTool(managed);
    return {
      startedAt: managed.turnStartedAt,
      activeTool: activeTool ? { startedAt: activeTool.startedAt } : null,
    };
  }

  // Live manifest for GET /agents - same JSON shape as the file writeManifest
  // persists to ~/.isomux/agents-summary.json, plus pendingPrompt.
  //
  // pendingPrompt is added HERE and not in manifestEntries (which both this and
  // the file share) on purpose: it is live state, and the file is a snapshot.
  // A written-at-prompt-time file read minutes later would assert a prompt that
  // was answered long ago. Over HTTP the value is computed per request, so it
  // cannot go stale.
  function getManifest() {
    return buildManifest(manifestEntries()).map((entry) => {
      const managed = agents.get(entry.id);
      return {
        ...entry,
        pendingPrompt: managed ? pendingPromptOf(managed) : null,
        // Live state belongs only on the HTTP projection. Keeping it out of
        // manifestEntries prevents agents-summary.json from freezing a turn
        // snapshot that becomes false as soon as the turn ends.
        inFlightTurn: managed ? inFlightTurnForManifest(managed) : null,
      };
    });
  }

  function persistedAgentOf(a: ManagedAgent): PersistedAgent {
    return {
      id: a.info.id,
      name: a.info.name,
      desk: a.info.desk,
      cwd: a.info.cwd,
      outfit: a.info.outfit,
      permissionMode: a.info.permissionMode,
      modelFamily: a.info.modelFamily,
      effort: a.info.effort,
      agentType: a.info.agentType,
      codexSandbox: a.info.codexSandbox,
      ...(a.info.officeFreeModel
        ? { officeFreeModel: a.info.officeFreeModel }
        : {}),
      lastSessionId: a.sessionManager.sessionId,
      topic: a.info.topic,
      customInstructions: a.info.customInstructions,
      userId: a.info.userId,
      manager: a.info.manager,
      roomId: a.info.roomId,
      privileged: a.info.privileged ?? false,
      ...accessFields(a.info),
      ...spawnTreeFields(a.info),
      ...(a.info.autoHandoff === false ? { autoHandoff: false } : {}),
      ...persistedAutoHandoffTokens(a.info.autoHandoffTokens),
      ...(a.info.limitResume === false ? { limitResume: false } : {}),
      ...(a.limitResumeAt !== null ? { limitResumeAt: a.limitResumeAt } : {}),
      ...(a.heardFrom?.size ? { heardFrom: [...a.heardFrom] } : {}),
      ...(a.officeFallback ? { officeFallback: true as const } : {}),
    };
  }

  function persistAll() {
    const rooms = officeState.rooms;
    const persistedRooms: Room[] = rooms.map((r) => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      pet: r.pet ?? null,
      skin: r.skin ?? null,
      decor: r.decor ?? null,
      ...(r.cwd ? { cwd: r.cwd } : {}),
      type: r.type,
      ...(r.id === LOBBY_ROOM_ID && isLobbySeedPending()
        ? { defaultAgentPending: true as const }
        : {}),
      agents: [] as PersistedAgent[],
    }));
    for (const a of agents.values()) {
      // Bucket into the persisted rooms array by the roomId-derived
      // global index (AgentInfo no longer carries a dense room field).
      const roomIdx = globalRoomIndexOf(a.info.roomId);
      if (roomIdx >= 0 && roomIdx < persistedRooms.length) {
        persistedRooms[roomIdx].agents.push(persistedAgentOf(a));
      }
    }
    saveAgents(persistedRooms);
    updateManifest();
    updateAgentHistory();
  }

  // Snapshot live agents into history. Loop only iterates the live `agents`
  // map, so killed entries are preserved as-is (their `killedAt` and revive
  // payload stamped by `kill()` survive). Two consumers: /isomux-usage attribution
  // for killed agents, and the spawn menu's revive chips (which read the snapshot
  // to rehydrate config).
  function updateAgentHistory() {
    const history: AgentHistory = loadAgentHistory();
    for (const a of agents.values()) {
      const room = roomById(a.info.roomId);
      if (!room) continue;
      history[a.info.id] = {
        name: a.info.name,
        lastRoomId: room.id,
        lastRoomName: room.name,
        killedAt: null,
        cwd: a.info.cwd,
        outfit: a.info.outfit,
        permissionMode: a.info.permissionMode,
        modelFamily: a.info.modelFamily,
        effort: a.info.effort,
        agentType: a.info.agentType,
        codexSandbox: a.info.codexSandbox,
        ...(a.info.officeFreeModel
          ? { officeFreeModel: a.info.officeFreeModel }
          : {}),
        lastSessionId: a.sessionManager.sessionId,
        topic: a.info.topic,
        customInstructions: a.info.customInstructions,
        userId: a.info.userId,
        manager: a.info.manager,
        privileged: a.info.privileged ?? false,
        ...accessFields(a.info),
        ...spawnTreeFields(a.info),
        ...(a.info.autoHandoff === false ? { autoHandoff: false } : {}),
        ...persistedAutoHandoffTokens(a.info.autoHandoffTokens),
        ...(a.info.limitResume === false ? { limitResume: false } : {}),
      };
    }
    saveAgentHistory(history);
  }

  // Wire-summary chip payload for a live agent at kill time.
  function buildKilledAgentSummary(
    agentId: string,
    a: ManagedAgent,
  ): KilledAgentSummary | null {
    const room = roomById(a.info.roomId);
    if (!room) return null;
    return {
      id: agentId,
      name: a.info.name,
      agentType: a.info.agentType,
      lastRoomId: room.id,
      lastRoomName: room.name,
      topic: a.info.topic,
      killedAt: Date.now(),
    };
  }

  // Wire-summary chip payload from a history entry. Legacy pre-revive entries
  // (only name + lastRoom*, no killedAt) surface as Claude chips with their
  // log-dir mtime as a proxy for the kill time - revive() defaults the
  // missing config fields and tries to surface the on-disk transcript.
  function killedAgentSummaryFromHistory(
    agentId: string,
    entry: AgentHistoryEntry,
    fallbackKilledAt: number,
  ): KilledAgentSummary {
    return {
      id: agentId,
      name: entry.name,
      agentType: entry.agentType ?? "claude",
      lastRoomId: entry.lastRoomId,
      lastRoomName: entry.lastRoomName,
      topic: storedTopic(entry.topic),
      killedAt: entry.killedAt ?? fallbackKilledAt,
    };
  }

  // Shared body of the two killed-roster reads below. Takes an ALREADY-LOADED
  // history so a caller that also needs to inspect entries does not pay a second
  // read+parse of the file (loadAgentHistory is uncached).
  function killedSummariesFrom(
    history: AgentHistory,
    include?: (id: string, entry: AgentHistoryEntry) => boolean,
  ): KilledAgentSummary[] {
    const summaries: KilledAgentSummary[] = [];
    for (const [id, entry] of Object.entries(history)) {
      if (agents.has(id)) continue; // revived agents have a history entry but are alive
      if (include && !include(id, entry)) continue;
      const fallback = entry.killedAt ? 0 : legacyKilledAtFromDisk(id);
      // Skip entries with no killedAt AND no on-disk log dir - there's nothing
      // to revive and no ordering signal.
      if (!entry.killedAt && !fallback) continue;
      summaries.push(killedAgentSummaryFromHistory(id, entry, fallback));
    }
    summaries.sort((a, b) => b.killedAt - a.killedAt);
    return summaries;
  }

  // All currently-killed agents, sorted newest-first. Caller layers ACL
  // filtering and the cap. Legacy entries (no killedAt) get the agent's log
  // dir mtime as a proxy so they sort approximately by recency.
  function getKilledAgentSummaries(): KilledAgentSummary[] {
    return killedSummariesFrom(loadAgentHistory());
  }

  // The killed agents SPAWNED BY one user - the member-scoped reach behind
  // GET /agents?killed=1, the same rule killedAgentLogAccess
  // applies to the transcripts these ids unlock.
  //
  // Deliberately NOT `getKilledAgentSummaries().filter(k =>
  // killedAgentManagerUserId(k.id) === userId)`: that lookup re-reads and
  // re-parses agent-history.json for EVERY entry. This loads it once.
  // A legacy entry with no recorded userId fails closed (undefined never
  // matches a real userId), matching killedAgentManagerUserId's null.
  function getKilledAgentSummariesForManager(
    userId: string,
  ): KilledAgentSummary[] {
    return killedSummariesFrom(
      loadAgentHistory(),
      (_id, entry) => entry.userId === userId,
    );
  }

  // Ids of agents KNOWN to be killed, for the storage pruner (which drops the
  // keepPerAgent floor for them). Stricter than the killed roster on purpose:
  // only an entry kill() stamped with killedAt counts. A legacy entry without
  // it, or a live agent read before restoreAgents fills the live map (its entry
  // carries killedAt: null), is not proven killed and keeps its protection.
  function getKilledAgentIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, entry] of Object.entries(loadAgentHistory())) {
      if (typeof entry.killedAt === "number" && !agents.has(id)) ids.add(id);
    }
    return ids;
  }

  // The spawning user recorded for a KILLED agent - one that is gone from the
  // live map but still has its history entry (and its transcripts on disk).
  // Gates the killed-agent branch of log reads, which is why it
  // is a lookup of its own rather than a widening of the live-roster seams.
  //
  // Every unresolvable case fails closed with null: a LIVE agent (that one is
  // the live path's business, never this one), an unknown id, and a legacy
  // history entry from before agents recorded their user.
  function killedAgentManagerUserId(agentId: string): string | null {
    if (agents.has(agentId)) return null;
    return loadAgentHistory()[agentId]?.userId ?? null;
  }

  // The room a KILLED agent was in when it died, or null for a live or
  // unknown agent. Its files stay readable to that room after the kill.
  function killedAgentLastRoomId(agentId: string): string | null {
    if (agents.has(agentId)) return null;
    return loadAgentHistory()[agentId]?.lastRoomId ?? null;
  }

  // A KILLED agent's last stop and pack, which a revive gives it back, or null
  // for a live or unknown agent.
  function killedAgentGrant(
    agentId: string,
  ): { access: AgentAccess; pack?: ApiTokenLimits } | null {
    if (agents.has(agentId)) return null;
    const entry = loadAgentHistory()[agentId];
    if (!entry) return null;
    const access = agentAccessOf(entry);
    return {
      access,
      ...(stopHasPack(access) && entry.pack ? { pack: entry.pack } : {}),
    };
  }

  // For legacy entries (no kill-time stamp), use the agent's log directory
  // mtime as a "last-touched" proxy. One stat call per legacy entry; fine
  // for the ~100-entry scale this file reaches in practice.
  function legacyKilledAtFromDisk(agentId: string): number {
    try {
      return statSync(join(STATE_ROOT, "logs", agentId)).mtimeMs;
    } catch {
      return 0;
    }
  }

  function getAgent(agentId: string): AgentInfo | undefined {
    return agents.get(agentId)?.info;
  }

  // The agents a member spawned (the integrations page lists what their
  // Claude sessions report).
  function agentIdsOfUser(userId: string): string[] {
    return [...agents.values()]
      .filter((managed) => managed.info.userId === userId)
      .map((managed) => managed.info.id);
  }

  return {
    swapDesks,
    createRoom,
    closeRoom,
    renameRoom,
    setRoomPet,
    setRoomSkin,
    setRoomDecor,
    setRoomCwd,
    moveAgent,
    placeAgent,
    getAllAgents,
    getUsageReportData,
    updateManifest,
    pendingPrompt,
    inFlightTurnForLogs,
    getManifest,
    persistAll,
    buildKilledAgentSummary,
    getKilledAgentSummaries,
    getKilledAgentSummariesForManager,
    getKilledAgentIds,
    killedAgentManagerUserId,
    killedAgentLastRoomId,
    killedAgentGrant,
    getAgent,
    agentIdsOfUser,
  };
}
