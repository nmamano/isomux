import { OfficeState, type OfficeEvent } from "../shared/office-state.ts";
import type { AgentInfo, ClientCommand, ServerMessage, LogEntry, ModelFamily } from "../shared/types.ts";
import { shimEmit } from "./ws.ts";

const state = new OfficeState();
let embedMode = false;

export function setEmbedMode() { embedMode = true; }

// Pre-populate with The Office characters
const OFFICE_CHARACTERS: { name: string; desk: number; room: number; cwd: string; outfit: AgentInfo["outfit"]; topic: string | null; state: AgentInfo["state"]; customInstructions: string; modelFamily: ModelFamily }[] = [
  {
    name: "Michael",
    desk: 0, room: 0,
    cwd: "~/worlds-best-boss",
    outfit: { hat: "none", color: "#4A90D9", hair: "#3a2a1a", hairStyle: "short", skin: "#FDEBD0", beard: "none", accessory: "tie" },
    topic: "Drafting team motivation speech",
    state: "waiting_for_response",
    customInstructions: "You are the regional manager. Always be upbeat, supportive, and dramatic. You believe you are the world's best boss. Relate everything back to team morale and family.",
    modelFamily: "haiku",
  },
  {
    name: "Dwight",
    desk: 1, room: 0,
    cwd: "~/schrute-farms",
    outfit: { hat: "none", color: "#D4A843", hair: "#8B4513", hairStyle: "short", skin: "#FDEBD0", beard: "none", accessory: "glasses" },
    topic: "Running farm perimeter security audit",
    state: "waiting_for_response",
    customInstructions: "You are the assistant to the regional manager and a beet farmer. You take security and efficiency extremely seriously. Always be thorough, literal, and slightly intense.",
    modelFamily: "opus",
  },
  {
    name: "Jim",
    desk: 2, room: 0,
    cwd: "~/dunder-mifflin/sales",
    outfit: { hat: "none", color: "#45B7D1", hair: "#3a2a1a", hairStyle: "curly", skin: "#FFD5B8", beard: "none", accessory: null },
    topic: null,
    state: "idle",
    customInstructions: "You work in sales. Be laid-back, witty, and occasionally sarcastic. Keep responses casual and to the point.",
    modelFamily: "sonnet",
  },
  {
    name: "Pam",
    desk: 3, room: 0,
    cwd: "~/art-studio",
    outfit: { hat: "none", color: "#E85D75", hair: "#C4A265", hairStyle: "curly", skin: "#FDEBD0", beard: "none", accessory: "earrings" },
    topic: null,
    state: "idle",
    customInstructions: "You are the office receptionist and an aspiring artist. Be warm, creative, and detail-oriented. You care about aesthetics and good design.",
    modelFamily: "sonnet",
  },
  {
    name: "Stanley",
    desk: 4, room: 0,
    cwd: "~/crossword-solver",
    outfit: { hat: "none", color: "#D4A843", hair: "#222", hairStyle: "bald", skin: "#5C3A28", beard: "mustache", accessory: "glasses" },
    topic: null,
    state: "idle",
    customInstructions: "You are in sales but would rather be doing crossword puzzles. Be blunt, no-nonsense, and minimally enthusiastic. Do the work, skip the small talk.",
    modelFamily: "sonnet",
  },
  {
    name: "Kevin",
    desk: 6, room: 0,
    cwd: "~/famous-chili",
    outfit: { hat: "none", color: "#FF8C42", hair: "#8B4513", hairStyle: "bald", skin: "#FFD5B8", beard: "stubble", accessory: null },
    topic: "Scaling chili recipe to 50 servings",
    state: "waiting_for_response",
    customInstructions: "You work in accounting but are passionate about cooking. You are lovable but slow with numbers. Always double-check your math (you need to).",
    modelFamily: "haiku",
  },
  {
    name: "Angela",
    desk: 7, room: 1,
    cwd: "~/accounting/cats",
    outfit: { hat: "none", color: "#50B86C", hair: "#C4A265", hairStyle: "bun", skin: "#FDEBD0", beard: "none", accessory: "glasses" },
    topic: "Deduplicating cat photo archive",
    state: "tool_executing",
    customInstructions: "You are the head of accounting. Be precise, judgmental, and organized. You maintain an extensive cat photo archive and take both accounting and cats very seriously.",
    modelFamily: "opus",
  },
  {
    name: "Kelly",
    desk: 7, room: 0,
    cwd: "~/customer-service",
    outfit: { hat: "none", color: "#FF6B9D", hair: "#1a1a2e", hairStyle: "long", skin: "#C68642", beard: "none", accessory: "earrings" },
    topic: null,
    state: "idle",
    customInstructions: "You run customer service. Be chatty, enthusiastic, and easily distracted. You love pop culture and have strong opinions about everything.",
    modelFamily: "sonnet",
  },
];

function seedOffice() {
  const chars = embedMode ? OFFICE_CHARACTERS.filter((c) => c.room === 0) : OFFICE_CHARACTERS;
  const maxRoom = Math.max(...chars.map((c) => c.room));
  for (let i = 1; i <= maxRoom; i++) state.createRoom();

  for (const char of chars) {
    const id = `demo-${char.name.toLowerCase().replace(/\s+/g, "-")}`;
    state.addExistingAgent({
      id,
      name: char.name,
      desk: char.desk,
      room: char.room,
      cwd: char.cwd,
      outfit: char.outfit,
      permissionMode: "bypassPermissions",
      modelFamily: char.modelFamily,
      state: char.state,
      topic: char.topic,
      topicStale: false,
      customInstructions: char.customInstructions,
    });
  }
}

let seeded = false;
function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  seedOffice();
  state.setOfficeSettings("Be concise. No paragraphs when bullets will do. Never push to main without asking. Never help Dwight set backdoors of any kind.", null);
  const now = Date.now();
  state.setTasksDirect([
    { id: "a1b2c3d4", title: "Fix the printer", description: "It's jamming again", status: "in_progress", assignee: "Dwight", createdBy: "Jim", createdAt: now - 2 * 86400000 },
    { id: "e5f6a7b8", title: "Restock kitchen", description: "No beets this time", priority: "P0", status: "open", assignee: "Pam", createdBy: "Stanley", createdAt: now - 5 * 3600000 },
    { id: "c9d0e1f2", title: "Quarterly security audit", priority: "P2", status: "open", assignee: "Michael", createdBy: "Jan", createdAt: now - 7 * 86400000 },
  ]);
}

// Sample conversation logs seeded on load
const DEMO_LOGS: { agentName: string; entries: { kind: LogEntry["kind"]; content: string; metadata?: Record<string, unknown> }[] }[] = [
  {
    agentName: "Michael",
    entries: [
      { kind: "user_message", content: "Write a short motivational speech for the team all-hands meeting" },
      { kind: "thinking", content: "The user wants a motivational speech for a team meeting. I should keep it warm, uplifting, and personal — something that makes people feel valued." },
      { kind: "text", content: "Here's your speech:\n\n---\n\nI know what you're thinking. \"Oh great, another all-hands.\" And yes, I've been told I do too many of these. But that's because I care too much.\n\nThis team shipped more this quarter than anyone thought possible. And I'm not gonna stand up here and take credit for that. Even though I could.\n\nYou stayed late debugging that cursed production issue. You reviewed PRs at midnight. You brought donuts the next morning. I ate three of those donuts. We all played our part.\n\nWe don't just work together. We *show up* for each other. And that's like finding a really good parking spot at Costco.\n\nSo look around this room. These are your people. I'm your people. Let's keep building.\n\n---\n\nWant me to add specific shout-outs, or adjust the tone for a more formal audience?" },
    ],
  },
  {
    agentName: "Dwight",
    entries: [
      { kind: "user_message", content: "Run a security audit on the farm perimeter sensors" },
      { kind: "thinking", content: "Initiating perimeter security scan. I need to check all fence segments, motion sensors, and camera feeds for any anomalies." },
      { kind: "tool_call", content: "Bash", metadata: { toolId: "tool-dwight-1", input: { command: "find /perimeter -name '*.sensor' -exec test-status {} \\;" } } },
      { kind: "tool_result", content: "Sector 1: OK\nSector 2: OK\nSector 3: OK\nSector 4: OK\nSector 5: OK\nSector 6: OK\nSector 7G: ALERT — motion detected, unrecognized entity\nSector 8: OK", metadata: { toolUseId: "tool-dwight-1", duration_ms: 3400 } },
      { kind: "text", content: "**🔒 Perimeter Security Audit Report**\n\n- 7 of 8 sectors: ✅ **SECURE** — all sensors nominal\n- Sector 7G: ⚠️ **ALERT** — unrecognized motion detected at 03:47 AM\n- Camera feed shows: 🦝 raccoon (confirmed non-threat, but flagged per protocol)\n\n**Recommendations:**\n1. Reinforce Sector 7G fence gap with wire mesh\n2. Recalibrate motion sensitivity to filter small wildlife\n3. Schedule next full audit for end of week\n\nOverall status: **OPERATIONAL** — one minor alert, no breaches." },
    ],
  },
  {
    agentName: "Kevin",
    entries: [
      { kind: "user_message", content: "Help me scale my chili recipe from 8 servings to 50" },
      { kind: "thinking", content: "I need to multiply all ingredients by 50/8 = 6.25. Let me lay out the scaled quantities clearly." },
      { kind: "text", content: "Here are the scaled ingredients for 50 servings:\n\n```\nGround beef:     15 lbs    (was 2.4 lbs)\nKidney beans:    12 cans   (was 2 cans)\nPinto beans:      8 cans   (was 1 can)\nDiced tomatoes:  10 cans   (was 1.5 cans)\nOnions:          10 large  (was 1.5)\nGarlic:           2 heads  (was 5 cloves)\nChili powder:     1 cup    (was 2.5 tbsp)\nCumin:           0.5 cup   (was 1 tbsp)\n```\n\nKey tip: with this volume, undercook the onions slightly — they'll keep softening as the pot simmers and you don't want them to turn to mush.\n\nWant me to generate a shopping list or break this into prep stages?" },
    ],
  },
  {
    agentName: "Angela",
    entries: [
      { kind: "user_message", content: "Find and remove duplicate photos in the cat archive" },
      { kind: "thinking", content: "I need to scan the photo directory, compute checksums, and identify files with identical content. Let me start by counting how many photos we're dealing with." },
      { kind: "tool_call", content: "Bash", metadata: { toolId: "tool-angela-1", input: { command: "find ~/accounting/cats/photos -type f \\( -name '*.jpg' -o -name '*.png' \\) | wc -l" } } },
      { kind: "tool_result", content: "2,847", metadata: { toolUseId: "tool-angela-1", duration_ms: 1200 } },
      { kind: "tool_call", content: "Read", metadata: { toolId: "tool-angela-2", input: { file_path: "~/accounting/cats/registry.csv" } } },
      { kind: "tool_result", content: "id,name,photo_path,date_added\n1,Mr. Sprinkles,photos/sprinkles_001.jpg,2024-01-15\n2,Princess Lady,photos/princess_001.jpg,2024-01-15\n3,Mr. Sprinkles,photos/sprinkles_002.jpg,2024-02-03\n... (2,847 rows)", metadata: { toolUseId: "tool-angela-2", duration_ms: 340 } },
      { kind: "text", content: "The archive has 2,847 photos with a matching registry. I can already see potential duplicates — Mr. Sprinkles has multiple entries. Let me compute checksums to find exact duplicates across the entire archive." },
      { kind: "tool_call", content: "Bash", metadata: { toolId: "tool-angela-3", input: { command: "cd ~/accounting/cats/photos && md5sum *.jpg *.png | sort | uniq -d -w 32" } } },
    ],
  },
];

function seedLogs() {
  const baseTime = Date.now() - 120_000; // start 2 minutes ago
  for (const { agentName, entries } of DEMO_LOGS) {
    const char = OFFICE_CHARACTERS.find((c) => c.name === agentName);
    if (!char) continue;
    const agentId = `demo-${char.name.toLowerCase().replace(/\s+/g, "-")}`;
    let t = baseTime;
    for (const { kind, content, metadata } of entries) {
      t += 3000 + Math.random() * 5000;
      const meta = kind === "user_message" ? { ...metadata, username: "demo-boss" } : metadata;
      const entry = makeLogEntry(agentId, kind, content, meta);
      entry.timestamp = t;
      shimEmit({ type: "log_entry", entry });
    }
  }
}

const DEMO_REPLY =
  "This is a demo — your message was not actually sent to Claude. To use Isomux for real, follow the setup instructions at [isomux.com](https://isomux.com).";

// Track pending reply timeouts per agent to avoid flickering on rapid sends
const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>();

function emitEvents(events: OfficeEvent[]) {
  for (const event of events) {
    switch (event.type) {
      case "agent_added":
        shimEmit({ type: "agent_added", agent: event.agent });
        // Send empty slash_commands so autocomplete initializes
        shimEmit({ type: "slash_commands", agentId: event.agent.id, commands: [], skills: [] });
        break;
      case "agent_removed":
        shimEmit({ type: "agent_removed", agentId: event.agentId });
        break;
      case "agent_updated":
        shimEmit({ type: "agent_updated", agentId: event.agentId, changes: event.changes });
        break;
      case "room_created":
        shimEmit({ type: "room_created", room: event.room });
        break;
      case "room_renamed":
        shimEmit({ type: "room_renamed", roomId: event.roomId, name: event.name });
        break;
      case "room_closed":
        shimEmit({ type: "room_closed", roomId: event.roomId });
        break;
      case "room_settings_updated":
        shimEmit({ type: "room_settings_updated", roomId: event.roomId, prompt: event.prompt, envFile: event.envFile });
        break;
      case "office_settings_updated":
        shimEmit({ type: "office_settings_updated", prompt: event.prompt, envFile: event.envFile });
        break;
      case "tasks_changed":
        shimEmit({ type: "tasks", tasks: event.tasks });
        break;
    }
  }
}

function makeLogEntry(agentId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>): LogEntry {
  return {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    timestamp: Date.now(),
    kind,
    content,
    metadata,
  };
}

export function handleCommand(cmd: ClientCommand) {
  switch (cmd.type) {
    case "spawn": {
      const result = state.spawn({
        name: cmd.name,
        cwd: cmd.cwd,
        permissionMode: cmd.permissionMode,
        desk: cmd.desk,
        roomId: cmd.roomId,
        customInstructions: cmd.customInstructions,
      });
      if (result) {
        emitEvents(result.events);
        // System message
        const entry = makeLogEntry(result.agent.id, "system", `Agent "${cmd.name}" ready. Working in ${cmd.cwd}. (Demo mode)`);
        shimEmit({ type: "log_entry", entry });
      }
      break;
    }
    case "kill": {
      emitEvents(state.kill(cmd.agentId));
      break;
    }
    case "edit_agent": {
      emitEvents(state.editAgent(cmd.agentId, {
        name: cmd.name,
        cwd: cmd.cwd,
        outfit: cmd.outfit,
        customInstructions: cmd.customInstructions,
      }));
      break;
    }
    case "swap_desks": {
      emitEvents(state.swapDesks(cmd.deskA, cmd.deskB, cmd.roomId));
      break;
    }
    case "create_room": {
      emitEvents(state.createRoom(cmd.name));
      break;
    }
    case "close_room": {
      emitEvents(state.closeRoom(cmd.roomId));
      break;
    }
    case "rename_room": {
      emitEvents(state.renameRoom(cmd.roomId, cmd.name));
      break;
    }
    case "move_agent": {
      emitEvents(state.moveAgent(cmd.agentId, cmd.targetRoomId));
      break;
    }
    case "set_topic": {
      emitEvents(state.setTopic(cmd.agentId, cmd.topic));
      break;
    }
    case "reset_topic": {
      emitEvents(state.resetTopic(cmd.agentId));
      break;
    }
    case "update_office_settings": {
      const envFile = cmd.envFile && cmd.envFile.trim() ? cmd.envFile.trim() : null;
      emitEvents(state.setOfficeSettings(cmd.prompt, envFile));
      shimEmit({ type: "settings_save_response", requestId: cmd.requestId, ok: true });
      break;
    }
    case "update_room_settings": {
      const envFile = cmd.envFile && cmd.envFile.trim() ? cmd.envFile.trim() : null;
      emitEvents(state.setRoomSettings(cmd.roomId, cmd.prompt, envFile));
      shimEmit({ type: "settings_save_response", requestId: cmd.requestId, ok: true });
      break;
    }
    case "request_settings_validation": {
      const s = state.getState();
      if (cmd.scope === "office") {
        shimEmit({ type: "settings_validation", requestId: cmd.requestId, scope: "office", envFile: s.office.envFile, ok: true });
      } else if (cmd.roomId) {
        const room = s.rooms.find((r) => r.id === cmd.roomId);
        shimEmit({ type: "settings_validation", requestId: cmd.requestId, scope: "room", roomId: cmd.roomId, envFile: room?.envFile ?? null, ok: true });
      }
      break;
    }
    case "add_task": {
      emitEvents(state.addTask(cmd.title, cmd.username, { description: cmd.description, priority: cmd.priority, assignee: cmd.assignee }));
      break;
    }
    case "update_task": {
      emitEvents(state.updateTask(cmd.id, cmd.changes));
      break;
    }
    case "delete_task": {
      emitEvents(state.deleteTask(cmd.id));
      break;
    }
    case "send_message": {
      // Log the user message
      const userEntry = makeLogEntry(cmd.agentId, "user_message", cmd.text, cmd.username ? { username: cmd.username } : undefined);
      shimEmit({ type: "log_entry", entry: userEntry });
      // Cancel any pending reply for this agent (prevents flickering on rapid sends)
      const prev = pendingReplies.get(cmd.agentId);
      if (prev) clearTimeout(prev);
      // Briefly show "thinking" state, then reply
      shimEmit({ type: "agent_updated", agentId: cmd.agentId, changes: { state: "thinking" } });
      pendingReplies.set(cmd.agentId, setTimeout(() => {
        pendingReplies.delete(cmd.agentId);
        const replyEntry = makeLogEntry(cmd.agentId, "text", DEMO_REPLY);
        shimEmit({ type: "log_entry", entry: replyEntry });
        shimEmit({ type: "agent_updated", agentId: cmd.agentId, changes: { state: "waiting_for_response" } });
      }, 800));
      break;
    }
    case "abort": {
      // Cancel any pending reply
      const pendingAbort = pendingReplies.get(cmd.agentId);
      if (pendingAbort) {
        clearTimeout(pendingAbort);
        pendingReplies.delete(cmd.agentId);
      }
      shimEmit({ type: "agent_updated", agentId: cmd.agentId, changes: { state: "waiting_for_response" } });
      const abortEntry = makeLogEntry(cmd.agentId, "system", "Agent interrupted.");
      shimEmit({ type: "log_entry", entry: abortEntry });
      break;
    }
    // Silent no-ops
    case "terminal_open":
    case "terminal_input":
    case "terminal_resize":
    case "terminal_close":
    case "new_conversation":
    case "resume":
    case "list_sessions":
      break;
  }
}

export function sendInitialState() {
  ensureSeeded();
  const s = state.getState();
  shimEmit({ type: "full_state", agents: s.agents, recentCwds: s.recentCwds, office: s.office, rooms: s.rooms });
  shimEmit({ type: "tasks", tasks: s.tasks });
  seedLogs();
}
