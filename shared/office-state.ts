import type { RoomPet } from "./pets.ts";
import type {
  AgentInfo,
  AgentOutfit,
  TaskItem,
  TaskPriority,
  RoomWire,
  OfficeSettings,
} from "./types.ts";
import { DEFAULT_AGENT_CAPABILITIES, DEFAULT_EFFORT } from "./types.ts";
import { generateTaskId, generateRoomId } from "./types.ts";
import { versionOf } from "./blob-version.ts";
import { DESK_COUNT, isValidDesk } from "./desks.ts";
import {
  SHIRT_COLORS,
  HAIR_COLORS,
  SKIN_COLORS,
  HAIR_STYLES,
  BEARDS,
  HATS,
  ACCESSORIES,
} from "./outfit-options.ts";

// Domain events - callers translate these to ServerMessage
export type OfficeEvent =
  | { type: "agent_added"; agent: AgentInfo }
  // Carries the pre-removal roomId so consumers can compute a room-scoped
  // audience after the agent is gone from state.
  | { type: "agent_removed"; agentId: string; roomId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null }
  | { type: "room_pet_updated"; roomId: string; pet: RoomPet | null }
  | {
      type: "office_settings_updated";
      prompt: string | null;
      envFile: string | null;
      name: string | null;
    }
  | { type: "tasks_changed"; tasks: TaskItem[]; change: TaskChange };

// Which SINGLE task a tasks_changed event moved. The board is room-scoped and a
// full board is large (hundreds of KB once done tasks accumulate), so the WS
// layer pushes a per-recipient delta built from this instead of re-sending the
// whole list on every mutation. `tasks` stays on the event for
// the persistence sink and the demo shim, which both want the whole board.
export type TaskChange =
  | { kind: "created"; task: TaskItem }
  // prevRoomId is the room the task was in BEFORE the update (absent = it was
  // office-global). A re-file needs it: recipients who could see the OLD room
  // but not the new one must be told to DROP the task, and they are exactly the
  // ones for whom "visible before" is true while "visible now" is false.
  | { kind: "updated"; task: TaskItem; prevRoomId?: string }
  | { kind: "deleted"; task: TaskItem };

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateOutfit(): AgentOutfit {
  return {
    hat: pick(HATS),
    color: pick(SHIRT_COLORS),
    hair: pick(HAIR_COLORS),
    hairStyle: pick(HAIR_STYLES),
    skin: pick(SKIN_COLORS),
    beard: pick(BEARDS),
    accessory: pick(ACCESSORIES),
  };
}

export interface OfficeStateData {
  agents: AgentInfo[];
  rooms: RoomWire[];
  office: OfficeSettings;
  tasks: TaskItem[];
  recentCwds: string[];
}

// Canonical room input - a RoomWire without the derived `canCloseWhenEmpty`
// capability, which OfficeState stamps from room order at materialization. Boot
// and persistence supply this shape (they store room identity, not the flag).
type RoomInput = Omit<RoomWire, "canCloseWhenEmpty">;

export class OfficeState {
  private agents = new Map<string, AgentInfo>();
  private _rooms: RoomWire[] = [
    {
      id: generateRoomId(),
      name: "Room 1",
      prompt: null,
      canCloseWhenEmpty: false, // protected canonical first room
    },
  ];
  private _office: OfficeSettings = {
    prompt: null,
    envFile: null,
    name: null,
  };
  private _tasks: TaskItem[] = [];
  private _recentCwds: string[] = [];
  private onChangeHandlers = new Set<(event: OfficeEvent) => void>();

  constructor(initial?: { rooms?: RoomInput[]; office?: OfficeSettings }) {
    if (initial?.rooms && initial.rooms.length > 0)
      this._rooms = initial.rooms.map((r, i) => ({
        ...r,
        canCloseWhenEmpty: i > 0, // derived: only index 0 is protected
      }));
    if (initial?.office) this._office = { ...initial.office };
  }

  get rooms() {
    return this._rooms;
  }
  get office() {
    return this._office;
  }
  get tasks() {
    return this._tasks;
  }
  get recentCwds() {
    return this._recentCwds;
  }

  onChange(handler: (event: OfficeEvent) => void): () => void {
    this.onChangeHandlers.add(handler);
    return () => this.onChangeHandlers.delete(handler);
  }

  private emitEvents(events: OfficeEvent[]) {
    for (const event of events) {
      for (const handler of this.onChangeHandlers) handler(event);
    }
  }

  getState(): OfficeStateData {
    return {
      agents: [...this.agents.values()],
      rooms: [...this._rooms],
      office: { ...this._office },
      tasks: [...this._tasks],
      recentCwds: [...this._recentCwds],
    };
  }

  getAgent(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): AgentInfo[] {
    return [...this.agents.values()];
  }

  // -- Initialization (for restoring persisted state) --

  addExistingAgent(agent: AgentInfo) {
    this.agents.set(agent.id, agent);
  }

  setRooms(rooms: RoomInput[]) {
    this._rooms =
      rooms.length > 0
        ? rooms.map((r, i) => ({ ...r, canCloseWhenEmpty: i > 0 }))
        : [
            {
              id: generateRoomId(),
              name: "Room 1",
              prompt: null,
              canCloseWhenEmpty: false,
            },
          ];
  }

  setOfficeDirect(office: OfficeSettings) {
    this._office = { ...office };
  }

  setTasksDirect(tasks: TaskItem[]) {
    this._tasks = tasks;
  }

  setRecentCwds(cwds: string[]) {
    this._recentCwds = cwds;
  }

  // -- Mutations (return OfficeEvent[]) --

  spawn(opts: {
    name: string;
    cwd: string;
    permissionMode: AgentInfo["permissionMode"];
    desk?: number;
    roomId?: string;
    customInstructions?: string;
    outfit?: AgentOutfit;
    modelFamily?: AgentInfo["modelFamily"];
    effort?: AgentInfo["effort"];
    agentType?: AgentInfo["agentType"];
    codexSandbox?: AgentInfo["codexSandbox"];
    // Stable identity reference for the spawning user. Drives per-user
    // env at session creation. Null for unowned spawns (legacy paths).
    userId?: string | null;
    // Display snapshot of the spawning user's name. Persisted alongside
    // userId so the UI can label the agent without an extra lookup. Goes
    // stale across renames; behavior reads should go through userId.
    username?: string | null;
    capabilities?: AgentInfo["capabilities"];
  }): { agent: AgentInfo; events: OfficeEvent[] } | null {
    const nameLower = opts.name.trim().toLowerCase();
    for (const a of this.agents.values()) {
      if (a.name.toLowerCase() === nameLower) return null;
    }

    // An OMITTED (undefined) roomId defaults to the canonical first room
    // (legacy callers, welcome-agent seed). A PROVIDED-but-unknown roomId -
    // including "" - is rejected: never silently coerced to rooms[0], which
    // would hide caller mistakes (e.g. passing a display index instead of the
    // real room id), and never stored verbatim, which would dangle. Callers
    // disambiguate the null via a room-existence check, like moveAgent's.
    if (
      opts.roomId !== undefined &&
      !this._rooms.some((r) => r.id === opts.roomId)
    )
      return null;
    const targetRoomId = opts.roomId ?? this._rooms[0].id;
    const roomAgents = [...this.agents.values()].filter(
      (a) => a.roomId === targetRoomId,
    );
    const taken = new Set(roomAgents.map((a) => a.desk));

    // An explicit desk that names no real slot is REJECTED, not quietly
    // reassigned: it is a caller bug, and it previously produced an
    // agent that existed everywhere except the office view (DeskUnit's slot
    // lookup threw and took the whole room's render down). A desk of -1 is
    // doubly invalid - it is also the "no free desk" sentinel below.
    // An explicit desk that is merely TAKEN still falls through to
    // auto-assign, which is the long-standing behavior.
    if (opts.desk !== undefined && !isValidDesk(opts.desk)) return null;

    let desk: number;
    if (opts.desk !== undefined && !taken.has(opts.desk)) {
      desk = opts.desk;
    } else {
      desk = -1;
      for (let i = 0; i < DESK_COUNT; i++) {
        if (!taken.has(i)) {
          desk = i;
          break;
        }
      }
    }
    if (desk === -1) return null; // room full

    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agent: AgentInfo = {
      id,
      name: opts.name,
      desk,
      roomId: targetRoomId,
      cwd: opts.cwd,
      outfit: opts.outfit ?? generateOutfit(),
      permissionMode: opts.permissionMode,
      modelFamily: opts.modelFamily ?? "opus",
      effort: opts.effort ?? DEFAULT_EFFORT,
      state: "idle",
      topic: null,
      topicStale: false,
      customInstructions: opts.customInstructions || null,
      // Maintained in lockstep with customInstructions (see AgentInfo docs):
      // the optimistic-concurrency token an edit must echo back.
      customInstructionsVersion: versionOf(opts.customInstructions || ""),
      agentType: opts.agentType ?? "claude",
      capabilities: opts.capabilities ?? DEFAULT_AGENT_CAPABILITIES,
      ...(opts.codexSandbox ? { codexSandbox: opts.codexSandbox } : {}),
      userId: opts.userId ?? null,
      username: opts.username ?? null,
      // Privilege is never conferred at spawn - it is granted only via the
      // user-gated agents.setPrivileged route (so no agent can self-confer).
      privileged: false,
      queue: [],
      sessionSwapping: false,
      turnHadHumanInput: false,
    };

    this.agents.set(id, agent);

    this.addRecentCwd(opts.cwd);

    const events: OfficeEvent[] = [
      {
        type: "agent_added",
        agent,
      },
    ];
    this.emitEvents(events);
    return {
      agent,
      events,
    };
  }

  kill(agentId: string): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    this.agents.delete(agentId);
    const events: OfficeEvent[] = [
      { type: "agent_removed", agentId, roomId: agent.roomId },
    ];
    this.emitEvents(events);
    return events;
  }

  editAgent(
    agentId: string,
    changes: {
      name?: string;
      cwd?: string;
      outfit?: AgentOutfit;
      customInstructions?: string;
      permissionMode?: AgentInfo["permissionMode"];
      modelFamily?: AgentInfo["modelFamily"];
      effort?: AgentInfo["effort"];
      codexSandbox?: AgentInfo["codexSandbox"];
    },
  ): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];

    const updated: Partial<AgentInfo> = {};

    if (changes.name && changes.name !== agent.name) {
      const nameLower = changes.name.trim().toLowerCase();
      const duplicate = [...this.agents.values()].some(
        (a) => a.id !== agentId && a.name.toLowerCase() === nameLower,
      );
      if (!duplicate) {
        agent.name = changes.name;
        updated.name = changes.name;
      }
    }
    if (changes.cwd && changes.cwd !== agent.cwd) {
      agent.cwd = changes.cwd;
      updated.cwd = changes.cwd;
      this.addRecentCwd(changes.cwd);
    }
    if (changes.outfit) {
      agent.outfit = changes.outfit;
      updated.outfit = changes.outfit;
    }
    if (
      changes.customInstructions !== undefined &&
      changes.customInstructions !== agent.customInstructions
    ) {
      agent.customInstructions = changes.customInstructions || null;
      updated.customInstructions = agent.customInstructions;
      // Lockstep version bump rides the same agent_updated changes, so every
      // client's copy of the token stays current without a refetch.
      agent.customInstructionsVersion = versionOf(
        agent.customInstructions ?? "",
      );
      updated.customInstructionsVersion = agent.customInstructionsVersion;
    }
    if (
      changes.permissionMode &&
      changes.permissionMode !== agent.permissionMode
    ) {
      agent.permissionMode = changes.permissionMode;
      updated.permissionMode = changes.permissionMode;
    }
    if (changes.modelFamily && changes.modelFamily !== agent.modelFamily) {
      agent.modelFamily = changes.modelFamily;
      updated.modelFamily = changes.modelFamily;
    }
    if (changes.effort && changes.effort !== agent.effort) {
      agent.effort = changes.effort;
      updated.effort = changes.effort;
    }
    if (changes.codexSandbox && changes.codexSandbox !== agent.codexSandbox) {
      agent.codexSandbox = changes.codexSandbox;
      updated.codexSandbox = changes.codexSandbox;
    }

    if (Object.keys(updated).length === 0) return [];
    const events: OfficeEvent[] = [
      { type: "agent_updated", agentId, changes: updated },
    ];
    this.emitEvents(events);
    return events;
  }

  updateAgent(agentId: string, changes: Partial<AgentInfo>): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    Object.assign(agent, changes);
    const events: OfficeEvent[] = [{ type: "agent_updated", agentId, changes }];
    this.emitEvents(events);
    return events;
  }

  swapDesks(deskA: number, deskB: number, roomId: string): OfficeEvent[] {
    if (deskA === deskB || !isValidDesk(deskA) || !isValidDesk(deskB))
      return [];
    if (!this._rooms.some((r) => r.id === roomId)) return [];

    const allAgents = [...this.agents.values()];
    const agentA = allAgents.find(
      (a) => a.desk === deskA && a.roomId === roomId,
    );
    const agentB = allAgents.find(
      (a) => a.desk === deskB && a.roomId === roomId,
    );
    if (!agentA && !agentB) return [];

    const events: OfficeEvent[] = [];
    if (agentA) {
      agentA.desk = deskB;
      events.push({
        type: "agent_updated",
        agentId: agentA.id,
        changes: { desk: deskB },
      });
    }
    if (agentB) {
      agentB.desk = deskA;
      events.push({
        type: "agent_updated",
        agentId: agentB.id,
        changes: { desk: deskA },
      });
    }
    this.emitEvents(events);
    return events;
  }

  createRoom(name?: string): OfficeEvent[] {
    const existingIds = this._rooms.map((r) => r.id);
    const displayName = (name || `Room ${this._rooms.length + 1}`)
      .trim()
      .slice(0, 40);
    const room: RoomWire = {
      id: generateRoomId(existingIds),
      name: displayName,
      prompt: null,
      // Appended after the protected first room, so always closeable-when-empty.
      canCloseWhenEmpty: true,
    };
    this._rooms.push(room);
    const events: OfficeEvent[] = [{ type: "room_created", room }];
    this.emitEvents(events);
    return events;
  }

  closeRoom(roomId: string): OfficeEvent[] {
    const room = this._rooms.findIndex((r) => r.id === roomId);
    if (room <= 0) return []; // index 0 is the protected canonical first room
    const roomAgents = [...this.agents.values()].filter(
      (a) => a.roomId === roomId,
    );
    if (roomAgents.length > 0) return [];

    this._rooms.splice(room, 1);
    // Closing a room no longer shifts any wire index. Agents
    // carry a stable roomId and rooms carry a stable id, so a visible close is
    // just the room's removal and a non-visible close is a client no-op - the
    // pre-cut per-agent `room--` agent_updated churn is gone. Splicing a non-zero
    // index also can't change which room is index 0, so every remaining room's
    // derived canCloseWhenEmpty stays correct without a re-stamp.
    const events: OfficeEvent[] = [{ type: "room_closed", roomId }];
    this.emitEvents(events);
    return events;
  }

  renameRoom(roomId: string, name: string): OfficeEvent[] {
    const room = this._rooms.findIndex((r) => r.id === roomId);
    if (room < 0) return [];
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return [];
    this._rooms[room] = { ...this._rooms[room], name: trimmed };
    const events: OfficeEvent[] = [
      { type: "room_renamed", roomId, name: trimmed },
    ];
    this.emitEvents(events);
    return events;
  }

  moveAgent(agentId: string, targetRoomId: string): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    if (!this._rooms.some((r) => r.id === targetRoomId)) return [];
    if (agent.roomId === targetRoomId) return [];

    const targetAgents = [...this.agents.values()].filter(
      (a) => a.roomId === targetRoomId,
    );
    if (targetAgents.length >= DESK_COUNT) return [];
    const taken = new Set(targetAgents.map((a) => a.desk));
    let newDesk = -1;
    for (let i = 0; i < DESK_COUNT; i++) {
      if (!taken.has(i)) {
        newDesk = i;
        break;
      }
    }
    if (newDesk === -1) return [];

    agent.roomId = targetRoomId;
    agent.desk = newDesk;
    const events: OfficeEvent[] = [
      {
        type: "agent_updated",
        agentId,
        // The stable roomId IS the move on the wire. A present
        // `roomId` in `changes` is the move discriminator the server keys on to
        // route the old∪new audience (full-access sessions get this delta
        // verbatim; restricted sessions get a full_state refresh).
        changes: { roomId: targetRoomId, desk: newDesk },
      },
    ];
    this.emitEvents(events);
    return events;
  }

  setOfficeSettings(
    prompt: string | null,
    envFile: string | null,
    name: string | null,
  ): OfficeEvent[] {
    const normalizedPrompt = prompt && prompt.trim() ? prompt.trim() : null;
    const normalizedName = name && name.trim() ? name.trim() : null;
    this._office = {
      prompt: normalizedPrompt,
      envFile: envFile || null,
      name: normalizedName,
    };
    const events: OfficeEvent[] = [
      {
        type: "office_settings_updated",
        prompt: this._office.prompt,
        envFile: this._office.envFile,
        name: this._office.name,
      },
    ];
    this.emitEvents(events);
    return events;
  }

  setRoomSettings(roomId: string, prompt: string | null): OfficeEvent[] {
    const idx = this._rooms.findIndex((r) => r.id === roomId);
    if (idx < 0) return [];
    const normalizedPrompt = prompt && prompt.trim() ? prompt.trim() : null;
    this._rooms[idx] = { ...this._rooms[idx], prompt: normalizedPrompt };
    const events: OfficeEvent[] = [
      { type: "room_settings_updated", roomId, prompt: normalizedPrompt },
    ];
    this.emitEvents(events);
    return events;
  }

  /** Sets the room's pet; null clears it back to the default. Shaped like
   *  setRoomSettings above it: unknown room writes nothing and emits nothing. */
  setRoomPet(roomId: string, pet: RoomPet | null): OfficeEvent[] {
    const idx = this._rooms.findIndex((r) => r.id === roomId);
    if (idx < 0) return [];
    this._rooms[idx] = { ...this._rooms[idx], pet };
    const events: OfficeEvent[] = [{ type: "room_pet_updated", roomId, pet }];
    this.emitEvents(events);
    return events;
  }

  setTopic(agentId: string, topic: string): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    agent.topic = topic.slice(0, 80);
    agent.topicStale = false;
    const events: OfficeEvent[] = [
      {
        type: "agent_updated",
        agentId,
        changes: { topic: agent.topic, topicStale: false },
      },
    ];
    this.emitEvents(events);
    return events;
  }

  resetTopic(agentId: string): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    agent.topic = null;
    agent.topicStale = false;
    const events: OfficeEvent[] = [
      {
        type: "agent_updated",
        agentId,
        changes: { topic: null, topicStale: false },
      },
    ];
    this.emitEvents(events);
    return events;
  }

  addTask(
    title: string,
    createdBy: string,
    opts?: {
      description?: string;
      priority?: TaskPriority;
      assignee?: string;
      username?: string;
      roomId?: string;
    },
  ): OfficeEvent[] {
    // Normalize roomId: only a non-empty string scopes the task; anything else
    // (undefined or "") is office-global, represented as an ABSENT field so the
    // persisted/wire shape has one canonical "global" - no empty-string variant.
    const roomId =
      typeof opts?.roomId === "string" && opts.roomId.length > 0
        ? opts.roomId
        : undefined;
    const task: TaskItem = {
      id: generateTaskId(this._tasks.map((t) => t.id)),
      title: title.trim(),
      description: opts?.description,
      priority: opts?.priority,
      status: "open",
      assignee: opts?.assignee,
      createdBy,
      username: opts?.username,
      createdAt: Date.now(),
      ...(roomId ? { roomId } : {}),
    };
    this._tasks.push(task);
    const events: OfficeEvent[] = [
      {
        type: "tasks_changed",
        tasks: [...this._tasks],
        // Copy: the delta is serialized onto the wire by a later listener, and
        // the stored task keeps being mutated in place by updateTask.
        change: { kind: "created", task: { ...task } },
      },
    ];
    this.emitEvents(events);
    return events;
  }

  updateTask(
    id: string,
    changes: Partial<
      Pick<
        TaskItem,
        "title" | "description" | "priority" | "status" | "assignee" | "roomId"
      >
    >,
  ): OfficeEvent[] {
    const task = this._tasks.find((t) => t.id === id);
    if (!task) return [];
    // Captured BEFORE the assign: a re-file changes who may see this task, and
    // the recipients who lose it are computed from where it used to live.
    const prevRoomId = task.roomId;
    Object.assign(task, changes);
    // Canonical global shape is an ABSENT roomId (see addTask). A clear arrives
    // as `roomId: undefined` in `changes` - Object.assign leaves the key present
    // with an undefined value, so drop it to keep one canonical "global" and
    // match the persisted/wire shape of a task that never had a room.
    if ("roomId" in changes && !task.roomId) delete task.roomId;
    // Same for a cleared priority: `priority: undefined` in
    // `changes` must leave a task shaped like one that never had a priority.
    if ("priority" in changes && !task.priority) delete task.priority;
    const events: OfficeEvent[] = [
      {
        type: "tasks_changed",
        tasks: [...this._tasks],
        change: { kind: "updated", task: { ...task }, prevRoomId },
      },
    ];
    this.emitEvents(events);
    return events;
  }

  deleteTask(id: string): OfficeEvent[] {
    const task = this._tasks.find((t) => t.id === id);
    // Nothing was removed - no state changed, so no event. The AgentManager
    // wrapper already treated this case as a no-op (it compares the length
    // before/after and returns false), so callers see the same outcome.
    if (!task) return [];
    this._tasks = this._tasks.filter((t) => t.id !== id);
    const events: OfficeEvent[] = [
      {
        type: "tasks_changed",
        tasks: [...this._tasks],
        // The removed task, not just its id: its roomId is what decides which
        // recipients ever knew about it and so must be told to drop the row.
        change: { kind: "deleted", task: { ...task } },
      },
    ];
    this.emitEvents(events);
    return events;
  }

  addRecentCwd(cwd: string) {
    if (!cwd) return;
    this._recentCwds = [
      cwd,
      ...this._recentCwds.filter((c) => c !== cwd),
    ].slice(0, 20);
  }
}
