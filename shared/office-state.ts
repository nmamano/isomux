import type { AgentInfo, AgentOutfit, TaskItem, TaskPriority, TaskStatus, RoomWire, OfficeSettings } from "./types.ts";
import { generateTaskId, generateRoomId, isValidStatus, isValidPriority } from "./types.ts";
import { SHIRT_COLORS, HAIR_COLORS, SKIN_COLORS, HAIR_STYLES, BEARDS, HATS, ACCESSORIES } from "./outfit-options.ts";

// Domain events — callers translate these to ServerMessage
export type OfficeEvent =
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null; envFile: string | null }
  | { type: "office_settings_updated"; prompt: string; envFile: string | null }
  | { type: "tasks_changed"; tasks: TaskItem[] };

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

export class OfficeState {
  private agents = new Map<string, AgentInfo>();
  private _rooms: RoomWire[] = [{ id: generateRoomId(), name: "Room 1", prompt: null, envFile: null }];
  private _office: OfficeSettings = { prompt: "", envFile: null };
  private _tasks: TaskItem[] = [];
  private _recentCwds: string[] = [];

  get rooms() { return this._rooms; }
  get office() { return this._office; }
  get tasks() { return this._tasks; }
  get recentCwds() { return this._recentCwds; }

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

  setRooms(rooms: RoomWire[]) {
    this._rooms = rooms.length > 0 ? [...rooms] : [{ id: generateRoomId(), name: "Room 1", prompt: null, envFile: null }];
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
  }): { agent: AgentInfo; events: OfficeEvent[] } | null {
    // Reject duplicate names
    const nameLower = opts.name.trim().toLowerCase();
    for (const a of this.agents.values()) {
      if (a.name.toLowerCase() === nameLower) return null;
    }

    let targetRoom = 0;
    if (opts.roomId) {
      const idx = this._rooms.findIndex((r) => r.id === opts.roomId);
      if (idx >= 0) targetRoom = idx;
    }
    const roomAgents = [...this.agents.values()].filter((a) => a.room === targetRoom);
    const taken = new Set(roomAgents.map((a) => a.desk));

    let desk: number;
    if (opts.desk !== undefined && !taken.has(opts.desk)) {
      desk = opts.desk;
    } else {
      desk = -1;
      for (let i = 0; i < 8; i++) {
        if (!taken.has(i)) { desk = i; break; }
      }
    }
    if (desk === -1) return null; // room full

    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const agent: AgentInfo = {
      id,
      name: opts.name,
      desk,
      room: targetRoom,
      cwd: opts.cwd,
      outfit: generateOutfit(),
      permissionMode: opts.permissionMode,
      modelFamily: "opus",
      state: "idle",
      topic: null,
      topicStale: false,
      customInstructions: opts.customInstructions || null,
    };

    this.agents.set(id, agent);

    // Track cwd
    this.addRecentCwd(opts.cwd);

    return {
      agent,
      events: [{ type: "agent_added", agent }],
    };
  }

  kill(agentId: string): OfficeEvent[] {
    if (!this.agents.has(agentId)) return [];
    this.agents.delete(agentId);
    return [{ type: "agent_removed", agentId }];
  }

  editAgent(agentId: string, changes: { name?: string; cwd?: string; outfit?: AgentOutfit; customInstructions?: string }): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];

    const updated: Partial<AgentInfo> = {};

    if (changes.name && changes.name !== agent.name) {
      const nameLower = changes.name.trim().toLowerCase();
      const duplicate = [...this.agents.values()].some((a) => a.id !== agentId && a.name.toLowerCase() === nameLower);
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
    if (changes.customInstructions !== undefined && changes.customInstructions !== agent.customInstructions) {
      agent.customInstructions = changes.customInstructions || null;
      updated.customInstructions = agent.customInstructions;
    }

    if (Object.keys(updated).length === 0) return [];
    return [{ type: "agent_updated", agentId, changes: updated }];
  }

  updateAgent(agentId: string, changes: Partial<AgentInfo>): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    Object.assign(agent, changes);
    return [{ type: "agent_updated", agentId, changes }];
  }

  swapDesks(deskA: number, deskB: number, roomId: string): OfficeEvent[] {
    if (deskA === deskB || deskA < 0 || deskA > 7 || deskB < 0 || deskB > 7) return [];
    const room = this._rooms.findIndex((r) => r.id === roomId);
    if (room < 0) return [];

    const allAgents = [...this.agents.values()];
    const agentA = allAgents.find((a) => a.desk === deskA && a.room === room);
    const agentB = allAgents.find((a) => a.desk === deskB && a.room === room);
    if (!agentA && !agentB) return [];

    const events: OfficeEvent[] = [];
    if (agentA) {
      agentA.desk = deskB;
      events.push({ type: "agent_updated", agentId: agentA.id, changes: { desk: deskB } });
    }
    if (agentB) {
      agentB.desk = deskA;
      events.push({ type: "agent_updated", agentId: agentB.id, changes: { desk: deskA } });
    }
    return events;
  }

  createRoom(name?: string): OfficeEvent[] {
    const existingIds = this._rooms.map((r) => r.id);
    const room: RoomWire = {
      id: generateRoomId(existingIds),
      name: name || `Room ${this._rooms.length + 1}`,
      prompt: null,
      envFile: null,
    };
    this._rooms.push(room);
    return [{ type: "room_created", room }];
  }

  closeRoom(roomId: string): OfficeEvent[] {
    const room = this._rooms.findIndex((r) => r.id === roomId);
    if (room <= 0) return [];
    const roomAgents = [...this.agents.values()].filter((a) => a.room === room);
    if (roomAgents.length > 0) return [];

    this._rooms.splice(room, 1);
    const events: OfficeEvent[] = [];
    for (const agent of this.agents.values()) {
      if (agent.room > room) {
        agent.room--;
        events.push({ type: "agent_updated", agentId: agent.id, changes: { room: agent.room } });
      }
    }
    events.push({ type: "room_closed", roomId });
    return events;
  }

  renameRoom(roomId: string, name: string): OfficeEvent[] {
    const room = this._rooms.findIndex((r) => r.id === roomId);
    if (room < 0) return [];
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return [];
    this._rooms[room] = { ...this._rooms[room], name: trimmed };
    return [{ type: "room_renamed", roomId, name: trimmed }];
  }

  moveAgent(agentId: string, targetRoomId: string): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    const targetRoom = this._rooms.findIndex((r) => r.id === targetRoomId);
    if (targetRoom < 0) return [];
    if (agent.room === targetRoom) return [];

    const targetAgents = [...this.agents.values()].filter((a) => a.room === targetRoom);
    if (targetAgents.length >= 8) return [];
    const taken = new Set(targetAgents.map((a) => a.desk));
    let newDesk = -1;
    for (let i = 0; i < 8; i++) {
      if (!taken.has(i)) { newDesk = i; break; }
    }
    if (newDesk === -1) return [];

    agent.room = targetRoom;
    agent.desk = newDesk;
    return [{ type: "agent_updated", agentId, changes: { room: targetRoom, desk: newDesk } }];
  }

  setOfficeSettings(prompt: string, envFile: string | null): OfficeEvent[] {
    this._office = { prompt: prompt.trim(), envFile: envFile || null };
    return [{ type: "office_settings_updated", prompt: this._office.prompt, envFile: this._office.envFile }];
  }

  setRoomSettings(roomId: string, prompt: string | null, envFile: string | null): OfficeEvent[] {
    const idx = this._rooms.findIndex((r) => r.id === roomId);
    if (idx < 0) return [];
    const normalizedPrompt = prompt && prompt.trim() ? prompt.trim() : null;
    this._rooms[idx] = { ...this._rooms[idx], prompt: normalizedPrompt, envFile: envFile || null };
    return [{ type: "room_settings_updated", roomId, prompt: normalizedPrompt, envFile: envFile || null }];
  }

  setTopic(agentId: string, topic: string): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    agent.topic = topic.slice(0, 80);
    agent.topicStale = false;
    return [{ type: "agent_updated", agentId, changes: { topic: agent.topic, topicStale: false } }];
  }

  resetTopic(agentId: string): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    agent.topic = null;
    agent.topicStale = false;
    return [{ type: "agent_updated", agentId, changes: { topic: null, topicStale: false } }];
  }

  addTask(title: string, createdBy: string, opts?: { description?: string; priority?: TaskPriority; assignee?: string }): OfficeEvent[] {
    const task: TaskItem = {
      id: generateTaskId(this._tasks.map(t => t.id)),
      title: title.trim(),
      description: opts?.description,
      priority: opts?.priority,
      status: "open",
      assignee: opts?.assignee,
      createdBy,
      createdAt: Date.now(),
    };
    this._tasks.push(task);
    return [{ type: "tasks_changed", tasks: [...this._tasks] }];
  }

  updateTask(id: string, changes: Partial<Pick<TaskItem, "title" | "description" | "priority" | "status" | "assignee">>): OfficeEvent[] {
    const task = this._tasks.find((t) => t.id === id);
    if (!task) return [];
    Object.assign(task, changes);
    return [{ type: "tasks_changed", tasks: [...this._tasks] }];
  }

  deleteTask(id: string): OfficeEvent[] {
    this._tasks = this._tasks.filter((t) => t.id !== id);
    return [{ type: "tasks_changed", tasks: [...this._tasks] }];
  }

  addRecentCwd(cwd: string) {
    if (!cwd) return;
    this._recentCwds = [cwd, ...this._recentCwds.filter((c) => c !== cwd)].slice(0, 20);
  }
}
