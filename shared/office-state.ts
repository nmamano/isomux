import type { AgentInfo, AgentOutfit, TaskItem, TaskPriority, TaskStatus } from "./types.ts";
import { generateTaskId, isValidStatus, isValidPriority } from "./types.ts";
import { SHIRT_COLORS, HAIR_COLORS, SKIN_COLORS, HAIR_STYLES, BEARDS, HATS, ACCESSORIES } from "./outfit-options.ts";

// Domain events — callers translate these to ServerMessage
export type OfficeEvent =
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "room_created"; roomCount: number; roomName: string }
  | { type: "room_closed"; room: number; roomCount: number }
  | { type: "room_renamed"; room: number; name: string }
  | { type: "office_prompt_set"; value: string }
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
  roomCount: number;
  roomNames: string[];
  officePrompt: string;
  tasks: TaskItem[];
  recentCwds: string[];
}

export class OfficeState {
  private agents = new Map<string, AgentInfo>();
  private _roomCount = 1;
  private _roomNames: string[] = ["Room 1"];
  private _officePrompt = "";
  private _tasks: TaskItem[] = [];
  private _recentCwds: string[] = [];

  get roomCount() { return this._roomCount; }
  get roomNames() { return this._roomNames; }
  get officePrompt() { return this._officePrompt; }
  get tasks() { return this._tasks; }
  get recentCwds() { return this._recentCwds; }

  getState(): OfficeStateData {
    return {
      agents: [...this.agents.values()],
      roomCount: this._roomCount,
      roomNames: [...this._roomNames],
      officePrompt: this._officePrompt,
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

  setRoomCount(count: number) {
    this._roomCount = Math.max(1, count);
  }

  setRoomNames(names: string[]) {
    this._roomNames = names;
  }

  setOfficePromptDirect(text: string) {
    this._officePrompt = text;
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
    room?: number;
    customInstructions?: string;
  }): { agent: AgentInfo; events: OfficeEvent[] } | null {
    // Reject duplicate names
    const nameLower = opts.name.trim().toLowerCase();
    for (const a of this.agents.values()) {
      if (a.name.toLowerCase() === nameLower) return null;
    }

    const targetRoom = (opts.room !== undefined && opts.room >= 0 && opts.room < this._roomCount) ? opts.room : 0;
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
      model: "claude-opus-4-7",
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

  swapDesks(deskA: number, deskB: number, room: number): OfficeEvent[] {
    if (deskA === deskB || deskA < 0 || deskA > 7 || deskB < 0 || deskB > 7) return [];
    if (room < 0 || room >= this._roomCount) return [];

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
    this._roomCount++;
    const roomName = name || `Room ${this._roomCount}`;
    this._roomNames.push(roomName);
    return [{ type: "room_created", roomCount: this._roomCount, roomName }];
  }

  closeRoom(room: number): OfficeEvent[] {
    if (room === 0) return [];
    if (room < 0 || room >= this._roomCount) return [];
    const roomAgents = [...this.agents.values()].filter((a) => a.room === room);
    if (roomAgents.length > 0) return [];

    this._roomCount--;
    this._roomNames.splice(room, 1);
    const events: OfficeEvent[] = [];
    for (const agent of this.agents.values()) {
      if (agent.room > room) {
        agent.room--;
        events.push({ type: "agent_updated", agentId: agent.id, changes: { room: agent.room } });
      }
    }
    events.push({ type: "room_closed", room, roomCount: this._roomCount });
    return events;
  }

  renameRoom(room: number, name: string): OfficeEvent[] {
    if (room < 0 || room >= this._roomCount) return [];
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return [];
    this._roomNames[room] = trimmed;
    return [{ type: "room_renamed", room, name: trimmed }];
  }

  moveAgent(agentId: string, targetRoom: number): OfficeEvent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    if (targetRoom < 0 || targetRoom >= this._roomCount) return [];
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

  setOfficePrompt(text: string): OfficeEvent[] {
    this._officePrompt = text.trim();
    return [{ type: "office_prompt_set", value: this._officePrompt }];
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
