import { OfficeState, type OfficeEvent } from "../shared/office-state.ts";
import type {
  AgentInfo,
  ClientCommand,
  InviteWire,
  LogEntry,
  ModelFamily,
  Cronjob,
  PresenceInfo,
  Schedule,
  SessionContext,
  SessionWire,
  UserRecord,
  UserRole,
} from "../shared/types.ts";
import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_EFFORT,
  generateCronjobId,
  generateUserId,
} from "../shared/types.ts";
import {
  defaultGhostColorForUserId,
  isGhostVariant,
  isHexColor,
  normalizeHexColor,
} from "../shared/avatar.ts";
import { shimEmit } from "./ws.ts";

const state = new OfficeState();
let embedMode = false;

export function setEmbedMode() {
  embedMode = true;
}

// Pre-populate with The Office characters
const OFFICE_CHARACTERS: {
  name: string;
  desk: number;
  room: number;
  cwd: string;
  outfit: AgentInfo["outfit"];
  topic: string | null;
  state: AgentInfo["state"];
  customInstructions: string;
  modelFamily: ModelFamily;
}[] = [
  {
    name: "Michael",
    desk: 0,
    room: 0,
    cwd: "~/worlds-best-boss",
    outfit: {
      hat: "none",
      color: "#4A90D9",
      hair: "#3a2a1a",
      hairStyle: "short",
      skin: "#FDEBD0",
      beard: "none",
      accessory: "tie",
    },
    topic: "Drafting team motivation speech",
    state: "waiting_for_response",
    customInstructions:
      "You are the regional manager. Always be upbeat, supportive, and dramatic. You believe you are the world's best boss. Relate everything back to team morale and family.",
    modelFamily: "haiku",
  },
  {
    name: "Dwight",
    desk: 1,
    room: 0,
    cwd: "~/schrute-farms",
    outfit: {
      hat: "none",
      color: "#D4A843",
      hair: "#8B4513",
      hairStyle: "short",
      skin: "#FDEBD0",
      beard: "none",
      accessory: "glasses",
    },
    topic: "Running farm perimeter security audit",
    state: "waiting_for_response",
    customInstructions:
      "You are the assistant to the regional manager and a beet farmer. You take security and efficiency extremely seriously. Always be thorough, literal, and slightly intense.",
    modelFamily: "opus",
  },
  {
    name: "Jim",
    desk: 2,
    room: 0,
    cwd: "~/dunder-mifflin/sales",
    outfit: {
      hat: "none",
      color: "#45B7D1",
      hair: "#3a2a1a",
      hairStyle: "curly",
      skin: "#FFD5B8",
      beard: "none",
      accessory: null,
    },
    topic: null,
    state: "idle",
    customInstructions:
      "You work in sales. Be laid-back, witty, and occasionally sarcastic. Keep responses casual and to the point.",
    modelFamily: "sonnet",
  },
  {
    name: "Pam",
    desk: 3,
    room: 0,
    cwd: "~/art-studio",
    outfit: {
      hat: "none",
      color: "#E85D75",
      hair: "#C4A265",
      hairStyle: "curly",
      skin: "#FDEBD0",
      beard: "none",
      accessory: "earrings",
    },
    topic: null,
    state: "idle",
    customInstructions:
      "You are the office receptionist and an aspiring artist. Be warm, creative, and detail-oriented. You care about aesthetics and good design.",
    modelFamily: "sonnet",
  },
  {
    name: "Stanley",
    desk: 4,
    room: 0,
    cwd: "~/crossword-solver",
    outfit: {
      hat: "none",
      color: "#D4A843",
      hair: "#222",
      hairStyle: "bald",
      skin: "#5C3A28",
      beard: "mustache",
      accessory: "glasses",
    },
    topic: null,
    state: "idle",
    customInstructions:
      "You are in sales but would rather be doing crossword puzzles. Be blunt, no-nonsense, and minimally enthusiastic. Do the work, skip the small talk.",
    modelFamily: "sonnet",
  },
  {
    name: "Kevin",
    desk: 6,
    room: 0,
    cwd: "~/famous-chili",
    outfit: {
      hat: "none",
      color: "#FF8C42",
      hair: "#8B4513",
      hairStyle: "bald",
      skin: "#FFD5B8",
      beard: "stubble",
      accessory: null,
    },
    topic: "Scaling chili recipe to 50 servings",
    state: "waiting_for_response",
    customInstructions:
      "You work in accounting but are passionate about cooking. You are lovable but slow with numbers. Always double-check your math (you need to).",
    modelFamily: "haiku",
  },
  {
    name: "Angela",
    desk: 7,
    room: 1,
    cwd: "~/accounting/cats",
    outfit: {
      hat: "none",
      color: "#50B86C",
      hair: "#C4A265",
      hairStyle: "bun",
      skin: "#FDEBD0",
      beard: "none",
      accessory: "glasses",
    },
    topic: "Deduplicating cat photo archive",
    state: "tool_executing",
    customInstructions:
      "You are the head of accounting. Be precise, judgmental, and organized. You maintain an extensive cat photo archive and take both accounting and cats very seriously.",
    modelFamily: "opus",
  },
  {
    name: "Kelly",
    desk: 7,
    room: 0,
    cwd: "~/customer-service",
    outfit: {
      hat: "none",
      color: "#FF6B9D",
      hair: "#1a1a2e",
      hairStyle: "long",
      skin: "#C68642",
      beard: "none",
      accessory: "earrings",
    },
    topic: null,
    state: "idle",
    customInstructions:
      "You run customer service. Be chatty, enthusiastic, and easily distracted. You love pop culture and have strong opinions about everything.",
    modelFamily: "sonnet",
  },
];

function seedOffice() {
  const chars = embedMode
    ? OFFICE_CHARACTERS.filter((c) => c.room === 0)
    : OFFICE_CHARACTERS;
  const maxRoom = Math.max(...chars.map((c) => c.room));
  for (let i = 1; i <= maxRoom; i++) state.createRoom();

  for (const char of chars) {
    const id = `demo-${char.name.toLowerCase().replace(/\s+/g, "-")}`;
    state.addExistingAgent({
      id,
      name: char.name,
      desk: char.desk,
      room: char.room,
      roomId: state.rooms[char.room].id,
      cwd: char.cwd,
      outfit: char.outfit,
      permissionMode: "auto",
      modelFamily: char.modelFamily,
      effort: DEFAULT_EFFORT,
      state: char.state,
      topic: char.topic,
      topicStale: false,
      customInstructions: char.customInstructions,
      agentType: "claude",
      capabilities: DEFAULT_AGENT_CAPABILITIES,
      userId: null,
      username: null,
      queue: [],
      sessionSwapping: false,
      turnHadHumanInput: false,
    });
  }
}

// Demo presence: a single ghost for "Stephen (phone)" that cycles
// through every agent in the office every 6 seconds, advertising a
// different focusedAgentId / currentRoom on each tick. Clients render
// the ghost SE of whichever desk Stephen's "looking at"; when the
// cycle lands on an agent in a room the viewer isn't on, the ghost
// simply doesn't render (matches real-presence behavior) until the
// viewer switches rooms or the cycle moves on. Re-emitting the entire
// presence_list on each tick is what the real server does too — the
// shape is identical, just constructed inline here.
const STEPHEN_PHONE_CONNECTION_ID = "demo-stephen-phone";
let cycleIndex = 0;
let cycleTimer: ReturnType<typeof setInterval> | null = null;

function emitStephenPresence() {
  const stephen = users.get("stephen");
  if (!stephen) return;
  // Cycle only through agents in the first room. The seed has Angela in
  // the second room, and the client-side currentRoomId filter would
  // (correctly) hide the ghost whenever the cycle landed on her, which
  // reads as a 6-second blank gap in a single-room demo view.
  const firstRoomId = state.getState().rooms[0]?.id;
  const agents = state
    .getState()
    .agents.filter((a) => a.roomId === firstRoomId);
  if (agents.length === 0) return;
  const agent = agents[cycleIndex % agents.length];
  const entry: PresenceInfo = {
    connectionId: STEPHEN_PHONE_CONNECTION_ID,
    userId: stephen.id,
    username: stephen.name,
    device: "Phone",
    avatarColor: stephen.avatarColor,
    avatarVariant: stephen.avatarVariant,
    currentRoom: agent.room,
    currentRoomId: agent.roomId,
    focusedAgentId: agent.id,
    viewMode: "log",
  };
  // Demo only ever has the one Stephen ghost online, so the total
  // matches the entries length. The shim mirrors the real wire shape.
  shimEmit({ type: "presence_list", entries: [entry], totalOnlineUsers: 1 });
}

function startStephenGhostCycle() {
  if (cycleTimer) return;
  // Initial emission so the ghost appears immediately at agent 0 rather
  // than 4 seconds later.
  emitStephenPresence();
  cycleTimer = setInterval(() => {
    const firstRoomId = state.getState().rooms[0]?.id;
    const total = state
      .getState()
      .agents.filter((a) => a.roomId === firstRoomId).length;
    if (total === 0) return;
    cycleIndex = (cycleIndex + 1) % total;
    emitStephenPresence();
  }, 4000);
}

let seeded = false;
function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  seedOffice();
  seedCronjobs();
  seedUsers();
  state.setOfficeSettings(
    "Be concise. No paragraphs when bullets will do. Never push to main without asking. Never help Dwight set backdoors of any kind.",
    null,
    "The Demo",
  );
  const now = Date.now();
  state.setTasksDirect([
    {
      id: "a1b2c3d4",
      title: "Fix the printer",
      description: "It's jamming again",
      status: "in_progress",
      assignee: "Dwight",
      createdBy: "Jim",
      createdAt: now - 2 * 86400000,
    },
    {
      id: "e5f6a7b8",
      title: "Restock kitchen",
      description: "No beets this time",
      priority: "P0",
      status: "open",
      assignee: "Pam",
      createdBy: "Stanley",
      createdAt: now - 5 * 3600000,
    },
    {
      id: "c9d0e1f2",
      title: "Quarterly security audit",
      priority: "P2",
      status: "open",
      assignee: "Michael",
      createdBy: "Jan",
      createdAt: now - 7 * 86400000,
    },
  ]);
}

// Sample conversation logs seeded on load
const DEMO_LOGS: {
  agentName: string;
  entries: {
    kind: LogEntry["kind"];
    content: string;
    metadata?: Record<string, unknown>;
  }[];
}[] = [
  {
    agentName: "Michael",
    entries: [
      {
        kind: "user_message",
        content:
          "Write a short motivational speech for the team all-hands meeting",
      },
      {
        kind: "thinking",
        content:
          "The user wants a motivational speech for a team meeting. I should keep it warm, uplifting, and personal — something that makes people feel valued.",
      },
      {
        kind: "text",
        content:
          "Here's your speech:\n\n---\n\nI know what you're thinking. \"Oh great, another all-hands.\" And yes, I've been told I do too many of these. But that's because I care too much.\n\nThis team shipped more this quarter than anyone thought possible. And I'm not gonna stand up here and take credit for that. Even though I could.\n\nYou stayed late debugging that cursed production issue. You reviewed PRs at midnight. You brought donuts the next morning. I ate three of those donuts. We all played our part.\n\nWe don't just work together. We *show up* for each other. And that's like finding a really good parking spot at Costco.\n\nSo look around this room. These are your people. I'm your people. Let's keep building.\n\n---\n\nWant me to add specific shout-outs, or adjust the tone for a more formal audience?",
      },
    ],
  },
  {
    agentName: "Dwight",
    entries: [
      {
        kind: "user_message",
        content: "Run a security audit on the farm perimeter sensors",
      },
      {
        kind: "thinking",
        content:
          "Initiating perimeter security scan. I need to check all fence segments, motion sensors, and camera feeds for any anomalies.",
      },
      {
        kind: "tool_call",
        content: "Bash",
        metadata: {
          toolId: "tool-dwight-1",
          input: {
            command:
              "find /perimeter -name '*.sensor' -exec test-status {} \\;",
          },
        },
      },
      {
        kind: "tool_result",
        content:
          "Sector 1: OK\nSector 2: OK\nSector 3: OK\nSector 4: OK\nSector 5: OK\nSector 6: OK\nSector 7G: ALERT — motion detected, unrecognized entity\nSector 8: OK",
        metadata: { toolUseId: "tool-dwight-1", duration_ms: 3400 },
      },
      {
        kind: "text",
        content:
          "**🔒 Perimeter Security Audit Report**\n\n- 7 of 8 sectors: ✅ **SECURE** — all sensors nominal\n- Sector 7G: ⚠️ **ALERT** — unrecognized motion detected at 03:47 AM\n- Camera feed shows: 🦝 raccoon (confirmed non-threat, but flagged per protocol)\n\n**Recommendations:**\n1. Reinforce Sector 7G fence gap with wire mesh\n2. Recalibrate motion sensitivity to filter small wildlife\n3. Schedule next full audit for end of week\n\nOverall status: **OPERATIONAL** — one minor alert, no breaches.",
      },
    ],
  },
  {
    agentName: "Kevin",
    entries: [
      {
        kind: "user_message",
        content: "Help me scale my chili recipe from 8 servings to 50",
      },
      {
        kind: "thinking",
        content:
          "I need to multiply all ingredients by 50/8 = 6.25. Let me lay out the scaled quantities clearly.",
      },
      {
        kind: "text",
        content:
          "Here are the scaled ingredients for 50 servings:\n\n```\nGround beef:     15 lbs    (was 2.4 lbs)\nKidney beans:    12 cans   (was 2 cans)\nPinto beans:      8 cans   (was 1 can)\nDiced tomatoes:  10 cans   (was 1.5 cans)\nOnions:          10 large  (was 1.5)\nGarlic:           2 heads  (was 5 cloves)\nChili powder:     1 cup    (was 2.5 tbsp)\nCumin:           0.5 cup   (was 1 tbsp)\n```\n\nKey tip: with this volume, undercook the onions slightly — they'll keep softening as the pot simmers and you don't want them to turn to mush.\n\nWant me to generate a shopping list or break this into prep stages?",
      },
    ],
  },
  {
    agentName: "Angela",
    entries: [
      {
        kind: "user_message",
        content: "Find and remove duplicate photos in the cat archive",
      },
      {
        kind: "thinking",
        content:
          "I need to scan the photo directory, compute checksums, and identify files with identical content. Let me start by counting how many photos we're dealing with.",
      },
      {
        kind: "tool_call",
        content: "Bash",
        metadata: {
          toolId: "tool-angela-1",
          input: {
            command:
              "find ~/accounting/cats/photos -type f \\( -name '*.jpg' -o -name '*.png' \\) | wc -l",
          },
        },
      },
      {
        kind: "tool_result",
        content: "2,847",
        metadata: { toolUseId: "tool-angela-1", duration_ms: 1200 },
      },
      {
        kind: "tool_call",
        content: "Read",
        metadata: {
          toolId: "tool-angela-2",
          input: { file_path: "~/accounting/cats/registry.csv" },
        },
      },
      {
        kind: "tool_result",
        content:
          "id,name,photo_path,date_added\n1,Mr. Sprinkles,photos/sprinkles_001.jpg,2024-01-15\n2,Princess Lady,photos/princess_001.jpg,2024-01-15\n3,Mr. Sprinkles,photos/sprinkles_002.jpg,2024-02-03\n... (2,847 rows)",
        metadata: { toolUseId: "tool-angela-2", duration_ms: 340 },
      },
      {
        kind: "text",
        content:
          "The archive has 2,847 photos with a matching registry. I can already see potential duplicates — Mr. Sprinkles has multiple entries. Let me compute checksums to find exact duplicates across the entire archive.",
      },
      {
        kind: "tool_call",
        content: "Bash",
        metadata: {
          toolId: "tool-angela-3",
          input: {
            command:
              "cd ~/accounting/cats/photos && md5sum *.jpg *.png | sort | uniq -d -w 32",
          },
        },
      },
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
      const meta =
        kind === "user_message" ? { ...metadata, username: "Ricky" } : metadata;
      const entry = makeLogEntry(agentId, kind, content, meta);
      entry.timestamp = t;
      shimEmit({ type: "log_entry", entry });
    }
  }
}

const DEMO_REPLY =
  "This is a demo — your message was not actually sent to Claude. To use Isomux for real, follow the setup instructions at [isomux.com](https://isomux.com).";

// Cron jobs: maintained as plain in-memory state (not via OfficeState).
const cronjobs: Cronjob[] = [];
let cronjobsPrompt: string | null = null;

function computeNextFireDemo(
  schedule: Schedule,
  anchor: number,
  now: number = Date.now(),
): number {
  if (schedule.type === "interval") {
    const intervalMs = Math.max(5, schedule.minutes) * 60_000;
    if (now <= anchor) return anchor + intervalMs;
    const periods = Math.floor((now - anchor) / intervalMs) + 1;
    return anchor + periods * intervalMs;
  }
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (schedule.type === "daily") {
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  // weekly
  const currentDay = next.getDay();
  let daysAhead = (schedule.weekday - currentDay + 7) % 7;
  if (daysAhead === 0 && next.getTime() <= now) daysAhead = 7;
  next.setDate(next.getDate() + daysAhead);
  return next.getTime();
}

const DEMO_CRONJOBS_SEED: {
  name: string;
  schedule: Schedule;
  prompt: string;
  cwd: string;
  modelFamily: ModelFamily;
  createdBy: string;
  ageDays: number;
  lastFireDaysAgo: number | null;
}[] = [
  {
    name: "Morning office digest",
    schedule: { type: "daily", hour: 9, minute: 0 },
    prompt:
      "Summarize what every agent worked on yesterday and post the digest in Michael's inbox.",
    cwd: "~/dunder-mifflin",
    modelFamily: "sonnet",
    createdBy: "Michael",
    ageDays: 14,
    lastFireDaysAgo: 0,
  },
  {
    name: "Weekly beet inventory",
    schedule: { type: "weekly", weekday: 1, hour: 6, minute: 30 },
    prompt:
      "Walk every row in ~/schrute-farms/inventory.csv, recount beets by variety, and flag any sector below 100 lbs.",
    cwd: "~/schrute-farms",
    modelFamily: "opus",
    createdBy: "Dwight",
    ageDays: 30,
    lastFireDaysAgo: 1,
  },
  {
    name: "Cat archive backup check",
    schedule: { type: "interval", minutes: 360 },
    prompt:
      "Verify the cat photo archive checksums against the offsite mirror. Open a P1 task if any drift is detected.",
    cwd: "~/accounting/cats",
    modelFamily: "haiku",
    createdBy: "Angela",
    ageDays: 7,
    lastFireDaysAgo: null,
  },
];

function seedCronjobs() {
  const now = Date.now();
  const usedIds = new Set<string>();
  for (const seed of DEMO_CRONJOBS_SEED) {
    const id = generateCronjobId(Array.from(usedIds));
    usedIds.add(id);
    const createdAt = now - seed.ageDays * 86400000;
    const lastFireAt =
      seed.lastFireDaysAgo === null
        ? null
        : now - seed.lastFireDaysAgo * 86400000;
    cronjobs.push({
      id,
      name: seed.name,
      schedule: seed.schedule,
      prompt: seed.prompt,
      cwd: seed.cwd,
      agentType: "claude",
      modelFamily: seed.modelFamily,
      effort: DEFAULT_EFFORT,
      permissionMode: "bypassPermissions",
      enabled: true,
      createdBy: seed.createdBy,
      userId: null,
      username: null,
      createdAt,
      lastFireAt,
      nextFireAt: computeNextFireDemo(
        seed.schedule,
        lastFireAt ?? createdAt,
        now,
      ),
    });
  }
}

// Users: maintained as a plain in-memory map (not via OfficeState), same as
// cronjobs. The demo fakes auth — sendInitialState emits a session_context
// for Ricky (owner), so the modal renders the same "real office" surfaces
// (AccessPane for owners, Sign out, etc.) instead of the pre-auth picker.
const users = new Map<string, UserRecord>();

const DEMO_USERS_SEED: { name: string; role: UserRole }[] = [
  // "Ricky" is the device's pre-set username (see demo-entry.tsx) and the
  // identity carried by the session_context emitted at connect time.
  { name: "Ricky", role: "owner" },
  { name: "Stephen", role: "member" },
];

// Active sessions surfaced in the Access pane. Ricky on laptop is the
// viewer; Stephen has two sessions (laptop + phone) — the phone session
// is the one whose ghost cycles through the office below.
const CURRENT_SESSION_PREFIX = "a1b2c3d4";
let activeSessionsList: SessionWire[] = [];
let invitesListSeed: InviteWire[] = [];
let sessionContext: SessionContext | null = null;

function seedUsers() {
  const roomIds = state.getState().rooms.map((r) => r.id);
  const defaultRoomId = roomIds[0] ?? null;
  const now = Date.now();
  const usedIds = new Set<string>();
  for (const { name, role } of DEMO_USERS_SEED) {
    const id = generateUserId(Array.from(usedIds));
    usedIds.add(id);
    users.set(name.toLowerCase(), {
      id,
      name,
      defaultRoomId,
      notifRooms: defaultRoomId ? [defaultRoomId] : [],
      envFile: null,
      createdAt: now,
      role,
      allowedRooms: [...roomIds],
      hidden: [],
      order: [],
      memberPrompt: null,
      avatarColor: defaultGhostColorForUserId(id),
      // Stephen gets a distinctive variant so the cycling ghost is
      // visually distinct from a default classic Casper as it moves
      // between desks in the demo.
      avatarVariant: name === "Stephen" ? "stubby-arms" : "classic",
    });
  }
  const ricky = users.get("ricky");
  if (ricky) {
    sessionContext = {
      userId: ricky.id,
      username: ricky.name,
      role: ricky.role,
      currentSessionPrefix: CURRENT_SESSION_PREFIX,
      // Fixed demo connectionId — the real server generates these per WS
      // upgrade. The viewer's own ghost is filtered client-side by
      // matching this, so Ricky never sees themselves while Stephen's
      // cycling ghost (different connectionId) renders normally.
      connectionId: "demo-ricky-laptop",
    };
  }
  const LAPTOP_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const PHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  activeSessionsList = [
    {
      sessionPrefix: CURRENT_SESSION_PREFIX,
      username: "Ricky",
      createdAt: now - 7 * 86400000,
      lastSeenAt: now - 30_000,
      expiresAt: now + 30 * 86400000,
      absoluteExpiresAt: now + 365 * 86400000,
      userAgent: LAPTOP_UA,
    },
    {
      sessionPrefix: "7e9f0a12",
      username: "Stephen",
      createdAt: now - 3 * 86400000,
      lastSeenAt: now - 2 * 3600000,
      expiresAt: now + 30 * 86400000,
      absoluteExpiresAt: now + 365 * 86400000,
      userAgent: PHONE_UA,
    },
    {
      sessionPrefix: "9f8e7d6c",
      username: "Stephen",
      createdAt: now - 5 * 86400000,
      lastSeenAt: now - 15 * 60_000,
      expiresAt: now + 30 * 86400000,
      absoluteExpiresAt: now + 365 * 86400000,
      userAgent: LAPTOP_UA,
    },
  ];
  invitesListSeed = [];
}

// Track pending reply timeouts per agent to avoid flickering on rapid sends
const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>();

function emitEvents(events: OfficeEvent[]) {
  for (const event of events) {
    switch (event.type) {
      case "agent_added":
        shimEmit({ type: "agent_added", agent: event.agent });
        // Send empty slash_commands so autocomplete initializes
        shimEmit({
          type: "slash_commands",
          agentId: event.agent.id,
          commands: [],
          skills: [],
        });
        break;
      case "agent_removed":
        shimEmit({ type: "agent_removed", agentId: event.agentId });
        break;
      case "agent_updated":
        shimEmit({
          type: "agent_updated",
          agentId: event.agentId,
          changes: event.changes,
        });
        break;
      case "room_created":
        shimEmit({ type: "room_created", room: event.room });
        break;
      case "room_renamed":
        shimEmit({
          type: "room_renamed",
          roomId: event.roomId,
          name: event.name,
        });
        break;
      case "room_closed":
        shimEmit({ type: "room_closed", roomId: event.roomId });
        break;
      case "room_settings_updated":
        shimEmit({
          type: "room_settings_updated",
          roomId: event.roomId,
          prompt: event.prompt,
        });
        break;
      case "office_settings_updated":
        // envFile is owner-only and never rides the all-audience event (3b.5).
        shimEmit({
          type: "office_settings_updated",
          prompt: event.prompt,
          name: event.name,
        });
        break;
      case "tasks_changed":
        shimEmit({ type: "tasks", tasks: event.tasks });
        break;
    }
  }
}

function makeLogEntry(
  agentId: string,
  kind: LogEntry["kind"],
  content: string,
  metadata?: Record<string, unknown>,
): LogEntry {
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
        outfit: cmd.outfit,
        modelFamily: cmd.modelFamily,
        effort: cmd.effort,
        agentType: cmd.agentType,
        codexSandbox: cmd.codexSandbox,
        username: cmd.username,
      });
      if (result) {
        emitEvents(result.events);
        // System message
        const entry = makeLogEntry(
          result.agent.id,
          "system",
          `Agent "${cmd.name}" ready. Working in ${cmd.cwd}. (Demo mode)`,
        );
        shimEmit({ type: "log_entry", entry });
      }
      if (cmd.requestId) {
        shimEmit({
          type: "agent_save_response",
          requestId: cmd.requestId,
          ok: true,
        });
      }
      break;
    }
    case "kill": {
      emitEvents(state.kill(cmd.agentId));
      break;
    }
    case "revive": {
      // The demo never populates state.killedAgents, so no chip is ever
      // rendered and this branch is unreachable from the UI. Stub here
      // for type coverage on the ClientCommand union; if a hand-crafted
      // command arrives, report a clean failure rather than crashing.
      if (cmd.requestId) {
        shimEmit({
          type: "agent_save_response",
          requestId: cmd.requestId,
          ok: false,
          error: "Revive is not supported in the demo.",
        });
      }
      break;
    }
    case "edit_agent": {
      emitEvents(
        state.editAgent(cmd.agentId, {
          name: cmd.name,
          cwd: cmd.cwd,
          outfit: cmd.outfit,
          customInstructions: cmd.customInstructions,
          permissionMode: cmd.permissionMode,
          modelFamily: cmd.modelFamily,
          effort: cmd.effort,
          codexSandbox: cmd.codexSandbox,
        }),
      );
      if (cmd.requestId) {
        shimEmit({
          type: "agent_save_response",
          requestId: cmd.requestId,
          ok: true,
        });
      }
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
      const envFile =
        cmd.envFile && cmd.envFile.trim() ? cmd.envFile.trim() : null;
      // Match the real server's stale-client preservation behavior; see
      // server/index.ts update_office_settings.
      const name =
        cmd.name === undefined
          ? state.office.name
          : cmd.name && cmd.name.trim()
            ? cmd.name.trim()
            : null;
      emitEvents(state.setOfficeSettings(cmd.prompt, envFile, name));
      shimEmit({
        type: "settings_save_response",
        requestId: cmd.requestId,
        ok: true,
      });
      break;
    }
    case "update_room_settings": {
      emitEvents(state.setRoomSettings(cmd.roomId, cmd.prompt));
      shimEmit({
        type: "settings_save_response",
        requestId: cmd.requestId,
        ok: true,
      });
      break;
    }
    case "request_cwd_validation": {
      // Demo mode: assume all paths are valid (no filesystem access).
      shimEmit({ type: "cwd_validation", requestId: cmd.requestId, ok: true });
      break;
    }
    case "request_settings_validation": {
      const s = state.getState();
      if (cmd.scope === "office") {
        shimEmit({
          type: "settings_validation",
          requestId: cmd.requestId,
          scope: "office",
          envFile: s.office.envFile,
          ok: true,
        });
      } else if (cmd.scope === "user") {
        shimEmit({
          type: "settings_validation",
          requestId: cmd.requestId,
          scope: "user",
          username: cmd.username,
          envFile: null,
          ok: true,
        });
      }
      break;
    }
    case "add_task": {
      emitEvents(
        state.addTask(cmd.title, cmd.username, {
          description: cmd.description,
          priority: cmd.priority,
          assignee: cmd.assignee,
          username: cmd.username,
        }),
      );
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
      const userEntry = makeLogEntry(
        cmd.agentId,
        "user_message",
        cmd.text,
        cmd.username ? { username: cmd.username } : undefined,
      );
      shimEmit({ type: "log_entry", entry: userEntry });
      // Cancel any pending reply for this agent (prevents flickering on rapid sends)
      const prev = pendingReplies.get(cmd.agentId);
      if (prev) clearTimeout(prev);
      // Briefly show "thinking" state, then reply
      shimEmit({
        type: "agent_updated",
        agentId: cmd.agentId,
        changes: { state: "thinking" },
      });
      pendingReplies.set(
        cmd.agentId,
        setTimeout(() => {
          pendingReplies.delete(cmd.agentId);
          const replyEntry = makeLogEntry(cmd.agentId, "text", DEMO_REPLY);
          shimEmit({ type: "log_entry", entry: replyEntry });
          shimEmit({
            type: "agent_updated",
            agentId: cmd.agentId,
            changes: { state: "waiting_for_response" },
          });
        }, 800),
      );
      break;
    }
    case "abort": {
      // Cancel any pending reply
      const pendingAbort = pendingReplies.get(cmd.agentId);
      if (pendingAbort) {
        clearTimeout(pendingAbort);
        pendingReplies.delete(cmd.agentId);
      }
      shimEmit({
        type: "agent_updated",
        agentId: cmd.agentId,
        changes: { state: "waiting_for_response" },
      });
      const abortEntry = makeLogEntry(
        cmd.agentId,
        "system",
        "Agent interrupted.",
      );
      shimEmit({ type: "log_entry", entry: abortEntry });
      break;
    }
    case "add_cronjob": {
      const now = Date.now();
      const id = generateCronjobId(cronjobs.map((c) => c.id));
      const cronjob: Cronjob = {
        id,
        name: cmd.name,
        schedule: cmd.schedule,
        prompt: cmd.prompt,
        cwd: cmd.cwd,
        agentType: cmd.agentType ?? "claude",
        modelFamily: cmd.modelFamily,
        effort: cmd.effort,
        permissionMode: cmd.permissionMode,
        codexSandbox: cmd.codexSandbox,
        enabled: true,
        createdBy: cmd.username,
        userId: null,
        username: cmd.username,
        createdAt: now,
        lastFireAt: null,
        nextFireAt: computeNextFireDemo(cmd.schedule, now, now),
      };
      cronjobs.push(cronjob);
      shimEmit({ type: "cronjob_added", cronjob });
      if (cmd.requestId) {
        shimEmit({
          type: "agent_save_response",
          requestId: cmd.requestId,
          ok: true,
        });
      }
      break;
    }
    case "update_cronjob": {
      const idx = cronjobs.findIndex((c) => c.id === cmd.id);
      if (idx >= 0) {
        const merged: Cronjob = { ...cronjobs[idx], ...cmd.changes };
        if (cmd.changes.schedule) {
          const anchor = merged.lastFireAt ?? merged.createdAt;
          merged.nextFireAt = computeNextFireDemo(
            cmd.changes.schedule,
            anchor,
            Date.now(),
          );
        }
        cronjobs[idx] = merged;
        shimEmit({ type: "cronjob_updated", cronjob: merged });
      }
      if (cmd.requestId) {
        shimEmit({
          type: "agent_save_response",
          requestId: cmd.requestId,
          ok: true,
        });
      }
      break;
    }
    case "delete_cronjob": {
      const idx = cronjobs.findIndex((c) => c.id === cmd.id);
      if (idx >= 0) {
        cronjobs.splice(idx, 1);
        shimEmit({ type: "cronjob_deleted", id: cmd.id });
      }
      break;
    }
    case "update_cronjobs_prompt": {
      cronjobsPrompt = cmd.value && cmd.value.trim() ? cmd.value : null;
      shimEmit({ type: "cronjobs_prompt_updated", value: cronjobsPrompt });
      shimEmit({
        type: "settings_save_response",
        requestId: cmd.requestId,
        ok: true,
      });
      break;
    }
    case "list_all_cronjob_runs": {
      // Demo cron jobs never actually fire, so there are no runs to send.
      // Still emit the sentinel so the client flips its "runs loaded" flag.
      shimEmit({ type: "cronjob_runs_complete" });
      break;
    }
    case "claim_user": {
      const trimmed = cmd.username.trim();
      if (!trimmed) break;
      const key = trimmed.toLowerCase();
      // The modal pre-checks for duplicates, but guard anyway so a stale
      // claim doesn't overwrite an existing record.
      if (users.has(key)) break;
      const roomIds = state.getState().rooms.map((r) => r.id);
      const defaultRoomId =
        cmd.defaultRoomId !== undefined
          ? cmd.defaultRoomId
          : (roomIds[0] ?? null);
      const newId = generateUserId([...users.values()].map((u) => u.id));
      const newUser: UserRecord = {
        id: newId,
        name: trimmed,
        defaultRoomId,
        notifRooms: cmd.notifRooms ?? (roomIds[0] ? [roomIds[0]] : []),
        envFile: null,
        createdAt: Date.now(),
        role: "member",
        allowedRooms: [...roomIds],
        hidden: [],
        order: [],
        memberPrompt: null,
        avatarColor: defaultGhostColorForUserId(newId),
        avatarVariant: "classic",
      };
      users.set(key, newUser);
      shimEmit({ type: "user_updated", user: newUser });
      shimEmit({ type: "users_list", users: [...users.values()] });
      break;
    }
    case "update_user": {
      const key = cmd.username.toLowerCase();
      const existing = users.get(key);
      if (!existing) {
        if (cmd.requestId) {
          shimEmit({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: false,
            error: `User '${cmd.username}' not found.`,
          });
        }
        break;
      }
      const trimmedName = cmd.changes.name?.trim();
      const renamed = !!trimmedName && trimmedName !== existing.name;
      if (renamed && trimmedName) {
        const newKey = trimmedName.toLowerCase();
        if (newKey !== key && users.has(newKey)) {
          if (cmd.requestId) {
            shimEmit({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: `Name '${trimmedName}' is taken.`,
            });
          }
          break;
        }
      }
      const updated: UserRecord = {
        ...existing,
        ...(renamed && trimmedName ? { name: trimmedName } : {}),
        ...(cmd.changes.defaultRoomId !== undefined
          ? { defaultRoomId: cmd.changes.defaultRoomId }
          : {}),
        ...(cmd.changes.notifRooms !== undefined
          ? { notifRooms: cmd.changes.notifRooms }
          : {}),
        ...(cmd.changes.envFile !== undefined
          ? { envFile: cmd.changes.envFile }
          : {}),
        ...(cmd.changes.allowedRooms !== undefined
          ? { allowedRooms: cmd.changes.allowedRooms }
          : {}),
        ...(cmd.changes.memberPrompt !== undefined
          ? {
              memberPrompt: cmd.changes.memberPrompt?.trim()
                ? cmd.changes.memberPrompt.trim()
                : null,
            }
          : {}),
        ...(cmd.changes.avatarColor !== undefined &&
        isHexColor(cmd.changes.avatarColor)
          ? { avatarColor: normalizeHexColor(cmd.changes.avatarColor) }
          : {}),
        ...(cmd.changes.avatarVariant !== undefined &&
        isGhostVariant(cmd.changes.avatarVariant)
          ? { avatarVariant: cmd.changes.avatarVariant }
          : {}),
      };
      if (renamed) users.delete(key);
      users.set(updated.name.toLowerCase(), updated);
      shimEmit({
        type: "user_updated",
        user: updated,
        ...(renamed ? { prevName: existing.name } : {}),
      });
      shimEmit({ type: "users_list", users: [...users.values()] });
      // Live-avatars: if the edited user is Stephen (whose phone ghost
      // cycles through room 0), re-emit his presence now so a color /
      // variant change takes effect immediately instead of waiting up
      // to 6 seconds for the next cycle tick. Mirrors what the real
      // server does via refreshPresenceForUser + pushPresenceListToEachWs.
      const stephen = users.get("stephen");
      if (stephen && updated.id === stephen.id) {
        emitStephenPresence();
      }
      if (cmd.requestId) {
        shimEmit({
          type: "settings_save_response",
          requestId: cmd.requestId,
          ok: true,
        });
      }
      break;
    }
    case "delete_user": {
      const key = cmd.username.toLowerCase();
      if (users.has(key)) {
        users.delete(key);
        // The edit panel's raw listener resolves the pending delete when it
        // sees a users_list without the target — no need for an extra
        // delete_user_blocked path here since the demo has nothing to block.
        shimEmit({ type: "users_list", users: [...users.values()] });
      }
      break;
    }
    case "logout": {
      // The demo emits a session_context so this button is reachable, but
      // there's no real auth to tear down — emit session_expired so the
      // store reloads the page (which lands on the same seeded demo
      // identity again).
      shimEmit({ type: "session_expired" });
      break;
    }
    case "list_invites": {
      shimEmit({ type: "invites_list", invites: [...invitesListSeed] });
      break;
    }
    case "list_active_sessions": {
      shimEmit({
        type: "sessions_active_list",
        sessions: [...activeSessionsList],
      });
      break;
    }
    case "revoke_session": {
      activeSessionsList = activeSessionsList.filter(
        (s) => s.sessionPrefix !== cmd.sessionPrefix,
      );
      shimEmit({ type: "session_revoked", sessionPrefix: cmd.sessionPrefix });
      break;
    }
    case "revoke_invite": {
      invitesListSeed = invitesListSeed.filter(
        (i) => i.tokenPrefix !== cmd.tokenPrefix,
      );
      shimEmit({ type: "invite_revoked", tokenPrefix: cmd.tokenPrefix });
      break;
    }
    case "mint_invite":
    case "mint_self_invite": {
      shimEmit({
        type: "invite_minted",
        requestId: cmd.requestId,
        ok: false,
        error: "Invites are disabled in the demo.",
      });
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
    case "run_cronjob_now":
    case "list_cronjob_runs":
    case "load_cronjob_run":
    case "send_cronjob_run_message":
    case "edit_cronjob_run_message":
      break;
  }
}

export function sendInitialState() {
  ensureSeeded();
  const s = state.getState();
  shimEmit({
    type: "full_state",
    agents: s.agents,
    recentCwds: s.recentCwds,
    office: s.office,
    rooms: s.rooms,
    // The demo doesn't simulate kill/revive — the chip row in the spawn
    // menu just stays empty.
    killedAgents: [],
  });
  shimEmit({ type: "tasks", tasks: s.tasks });
  shimEmit({ type: "cronjobs_state", cronjobs: [...cronjobs], cronjobsPrompt });
  // DEMO ONLY (non-production): the demo has a single simulated user and no ACL
  // boundary, so it sends FULL records on the public users_list. The live
  // server sends UserPublicWire here plus the subject's full record via
  // user_self_updated; the UI merge core tolerates both (a full record is
  // assignable to the public wire and simply hydrates as a full view).
  shimEmit({ type: "users_list", users: [...users.values()] });
  if (sessionContext) {
    shimEmit({ type: "session_context", context: sessionContext });
  }
  seedLogs();
  // Start Stephen's phone ghost cycle AFTER users_list + session_context
  // so the first presence_list emission lands with the user record
  // already in the client store (otherwise the ghost render would
  // briefly miss the username/color denormalization). Idempotent —
  // re-calls after the first are no-ops.
  startStephenGhostCycle();
}
