import { OfficeState, type OfficeEvent } from "../shared/office-state.ts";
import type {
  CronCreateReq,
  CronUpdateReq,
  CronPromptReq,
  OfficeSettingsReq,
  TaskCreateReq,
  RoomCreateReq,
  RoomRenameReq,
  RoomSettingsReq,
  MoveAgentReq,
  SwapDesksReq,
  TopicReq,
  SpawnReq,
  EditAgentReq,
  SendMessageReq,
} from "../shared/contract-shapes.ts";
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
import { ApiError, type ApiMethod } from "./api.ts";

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
// different focusedAgentId / currentRoomId on each tick. Clients render
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

// Demo counterpart to the server's REST executor. As each command migrates off
// the WS shim (handleCommand) to apiFetch, its demo handling moves here so the
// landing demo keeps working — the demo's own WS-case -> REST-route strangle,
// one route at a time, mirroring the real server. Registered via setApiShim() in
// demo-entry; apiFetch routes here instead of the network when the demo is live.
export async function demoApi(
  method: ApiMethod,
  path: string,
  body?: unknown,
): Promise<unknown> {
  // Split the query string off before matching: query/param routes (e.g.
  // backends.listModels carries ?cwd=) can't be matched by exact full-path.
  const pathname = path.split("?")[0];
  const route = `${method} ${pathname}`;
  switch (route) {
    // validate.cwd / validate.env — the demo has no filesystem, so every probe
    // succeeds. REST drops the resolved env path + keyCount the WS arm echoed.
    case "POST /api/validate/cwd":
      return { ok: true };
    case "POST /api/validate/env":
      return { ok: true };
    // 3d.9a auth surface (invites / login-sessions / access). Mirrors the retired
    // list_invites / list_active_sessions / logout / mint_* handleCommand cases;
    // the recipient-scoped broadcasts still drive the lists, so the reads return
    // the same seed snapshots.
    case "GET /api/invites":
      return { invites: [...invitesListSeed] };
    case "GET /api/sessions":
      return { sessions: [...activeSessionsList] };
    case "POST /api/invites":
    case "POST /api/invites/self":
      throw new ApiError(
        403,
        "invites_disabled",
        "Invites are disabled in the demo.",
      );
    case "DELETE /api/sessions/current":
      // logout: no real auth to tear down; emit session_expired so the store
      // reloads (landing back on the same seeded demo identity).
      shimEmit({ type: "session_expired" });
      return undefined;
    case "GET /api/office/access":
      // The demo binds loopback-only and has no external-access policy to read.
      return {
        externalAccess: false,
        publicOrigin: null,
        envOriginSet: false,
        envOrigin: null,
        boundLoopback: true,
      };
    case "PUT /api/office/access":
      // No-op in the demo (no bind/origin policy to persist).
      return { signInUrl: null, restartRequired: false };
    // cron.listAllRuns — demo cron jobs never fire, so there are no runs.
    case "GET /api/cron-runs":
      return { jobs: [] };
    // cron.create — build a demo cronjob, broadcast cronjob_added, and RETURN
    // it (the dialog awaits the HTTP result; the old agent_save_response emit is
    // gone). username is server-derived in production; the demo user is Ricky.
    case "POST /api/cronjobs": {
      const b = (body ?? {}) as CronCreateReq;
      const now = Date.now();
      const cronjob: Cronjob = {
        id: generateCronjobId(cronjobs.map((c) => c.id)),
        name: b.name,
        schedule: b.schedule,
        prompt: b.prompt,
        cwd: b.cwd,
        agentType: b.agentType ?? "claude",
        modelFamily: b.modelFamily,
        effort: b.effort,
        permissionMode: b.permissionMode,
        codexSandbox: b.codexSandbox,
        enabled: true,
        createdBy: "Ricky",
        userId: null,
        username: "Ricky",
        createdAt: now,
        lastFireAt: null,
        nextFireAt: computeNextFireDemo(b.schedule, now, now),
      };
      cronjobs.push(cronjob);
      shimEmit({ type: "cronjob_added", cronjob });
      return cronjob;
    }
    // cron.setPrompt — set + broadcast; no body returned (204-like).
    case "PUT /api/cron-prompt": {
      const b = (body ?? {}) as CronPromptReq;
      cronjobsPrompt = b.value && b.value.trim() ? b.value : null;
      shimEmit({ type: "cronjobs_prompt_updated", value: cronjobsPrompt });
      return undefined;
    }
    // office.setSettings — set + broadcast office_settings_updated; no body
    // (204-like). Mirrors the retired update_office_settings handleCommand:
    // name === undefined preserves the current name (a stale tab), else it sets
    // or clears. The demo has no env validation, so every save succeeds.
    case "PUT /api/office/settings": {
      const b = (body ?? {}) as OfficeSettingsReq;
      const envFile = b.envFile && b.envFile.trim() ? b.envFile.trim() : null;
      const name =
        b.name === undefined
          ? state.office.name
          : b.name && b.name.trim()
            ? b.name.trim()
            : null;
      emitEvents(state.setOfficeSettings(b.prompt, envFile, name));
      return undefined;
    }
    // tasks.create — push + broadcast the `tasks` event; return the created task
    // (the caller ignores it — fire-and-forget — but the contract shape is
    // TaskItem). createdBy/username are token-derived in prod; demo user = Ricky.
    case "POST /api/tasks": {
      const b = (body ?? {}) as TaskCreateReq;
      emitEvents(
        state.addTask(b.title, "Ricky", {
          description: b.description,
          priority: b.priority,
          assignee: b.assignee,
          username: "Ricky",
        }),
      );
      return state.tasks.at(-1);
    }
    // rooms.create — create + broadcast room_created; RETURN { room } (the
    // contract shape; the UI ignores it and relies on the broadcast). No
    // rule-based creator grant in the demo: the single demo user (Ricky) is an
    // owner and reaches every room by rule, matching the production no-fan-out.
    case "POST /api/rooms": {
      const b = (body ?? {}) as RoomCreateReq;
      const events = state.createRoom(b.name);
      emitEvents(events);
      const created = events.find((e) => e.type === "room_created");
      return { room: created?.room };
    }
    // view.setOrder — per-user view order is not modeled in the single-user
    // demo, so reorder is a no-op (matching the pre-cutover demo, where
    // reorder_rooms had no handleCommand case and was silently dropped).
    case "PUT /api/me/view/order":
      return undefined;
    // 3d.9b view.setNotifRooms / view.setDefaultRoom — self view prefs aren't
    // modeled per-user in the single-user demo (same as view/order). No-op; the
    // modal + the legacy-pref migration close optimistically. Replaces the demo
    // update_user notif/default handling and the claim_user prefs migration.
    case "PUT /api/me/view/notif-rooms":
    case "PUT /api/me/view/default-room":
      return undefined;
    // agents.spawn — build a demo agent, broadcast agent_added + a system log,
    // RETURN { agent } (the dialog awaits the HTTP result; the old
    // agent_save_response emit is gone). username is server-derived in prod; the
    // demo user is Ricky.
    case "POST /api/agents": {
      const b = (body ?? {}) as SpawnReq;
      const result = state.spawn({
        name: b.name,
        cwd: b.cwd,
        permissionMode: b.permissionMode ?? "default",
        desk: b.desk,
        roomId: b.roomId,
        customInstructions: b.customInstructions,
        outfit: b.outfit,
        modelFamily: b.modelFamily,
        effort: b.effort,
        agentType: b.agentType,
        codexSandbox: b.codexSandbox,
        username: "Ricky",
      });
      if (!result) {
        throw new ApiError(409, "spawn_failed", "Could not spawn the agent.");
      }
      emitEvents(result.events);
      shimEmit({
        type: "log_entry",
        entry: makeLogEntry(
          result.agent.id,
          "system",
          `Agent "${b.name}" ready. Working in ${b.cwd}. (Demo mode)`,
        ),
      });
      return { agent: result.agent };
    }
  }
  // Param routes (matched by shape, since the id/agentType segment varies).
  // backends.listModels — the demo has no backend process to probe; an empty
  // list makes the model dialog fall back to its hardcoded CODEX_MODELS list.
  if (method === "GET" && /^\/api\/backends\/[^/]+\/models$/.test(pathname)) {
    return { models: [] };
  }
  // cron.getRun — no runs in the demo (cronjobs never fire), so no transcript.
  // Listed before listRuns: the trailing anchors already make the two routes
  // disjoint, but specific-before-general is the safe convention. The view
  // ignores the fetched `run`, so returning just `entries` is enough.
  if (
    method === "GET" &&
    /^\/api\/cronjobs\/[^/]+\/runs\/[^/]+$/.test(pathname)
  ) {
    return { entries: [] };
  }
  // cron.listRuns — no runs in the demo.
  if (method === "GET" && /^\/api\/cronjobs\/[^/]+\/runs$/.test(pathname)) {
    return { runs: [] };
  }
  // cron.runMessage (POST) / cron.editRunMessage (PATCH) — fire-and-forget
  // mutations. The demo has no runs (unreachable in practice), but demoApi throws
  // on unmapped routes, so map them; the caller ignores the { messageId } ack.
  if (
    (method === "POST" &&
      /^\/api\/cronjobs\/[^/]+\/runs\/[^/]+\/messages$/.test(pathname)) ||
    (method === "PATCH" &&
      /^\/api\/cronjobs\/[^/]+\/runs\/[^/]+\/messages\/[^/]+$/.test(pathname))
  ) {
    return { messageId: "demo" };
  }
  // cron.update (PATCH) / cron.delete (DELETE) — mutate the demo cronjob and
  // broadcast the event; PATCH returns the merged job, DELETE returns no body.
  const cronIdMatch = pathname.match(/^\/api\/cronjobs\/([^/]+)$/);
  if (cronIdMatch && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(cronIdMatch[1]);
    const idx = cronjobs.findIndex((c) => c.id === id);
    if (method === "PATCH") {
      if (idx < 0) return undefined;
      const changes = (body ?? {}) as CronUpdateReq;
      const merged: Cronjob = { ...cronjobs[idx], ...changes };
      if (changes.schedule) {
        const anchor = merged.lastFireAt ?? merged.createdAt;
        merged.nextFireAt = computeNextFireDemo(
          changes.schedule,
          anchor,
          Date.now(),
        );
      }
      cronjobs[idx] = merged;
      shimEmit({ type: "cronjob_updated", cronjob: merged });
      return merged;
    }
    if (idx >= 0) {
      cronjobs.splice(idx, 1);
      shimEmit({ type: "cronjob_deleted", id });
    }
    return undefined;
  }
  // cron.runNow — the demo never fires runs; return a placeholder id (ignored).
  if (method === "POST" && /^\/api\/cronjobs\/[^/]+\/runs$/.test(pathname)) {
    return { runId: "demo-run" };
  }
  // tasks.update (PATCH) / tasks.delete (DELETE) — mutate the demo board and
  // broadcast the `tasks` event. PATCH takes a FLAT TaskUpdateReq body and
  // returns the merged task (caller ignores it); DELETE returns no body. The raw
  // body is applied as-is (matching the retired update_task handleCommand), so a
  // key carrying `undefined` clears that field — the demo's pre-cutover behavior.
  const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskIdMatch && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(taskIdMatch[1]);
    if (method === "PATCH") {
      // Raw body applied as-is (it satisfies the Partial change shape); a key
      // carrying `undefined` clears that field — the demo's pre-cutover behavior.
      emitEvents(state.updateTask(id, body ?? {}));
      return state.tasks.find((t) => t.id === id);
    }
    emitEvents(state.deleteTask(id));
    return undefined;
  }
  // 3d.9a invites.revoke (DELETE /api/invites/:tokenPrefix): drop the seed row
  // + broadcast invite_revoked (mirrors the retired revoke_invite handleCommand).
  const inviteRevokeMatch = pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteRevokeMatch && method === "DELETE") {
    const prefix = decodeURIComponent(inviteRevokeMatch[1]);
    invitesListSeed = invitesListSeed.filter((i) => i.tokenPrefix !== prefix);
    shimEmit({ type: "invite_revoked", tokenPrefix: prefix });
    return undefined;
  }
  // 3d.9a sessions.revoke (DELETE /api/sessions/:sessionPrefix): drop the row +
  // broadcast session_revoked. DELETE /api/sessions/current is an exact route in
  // the switch above, so it never reaches this shape matcher.
  const sessionRevokeMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionRevokeMatch && method === "DELETE") {
    const prefix = decodeURIComponent(sessionRevokeMatch[1]);
    activeSessionsList = activeSessionsList.filter(
      (s) => s.sessionPrefix !== prefix,
    );
    shimEmit({ type: "session_revoked", sessionPrefix: prefix });
    return undefined;
  }
  // 3d.9b users.setAccess (PUT /api/users/:username/access) — set allowedRooms +
  // prune notif/default to the new access (mirror the server clamp). An owner
  // target accesses all rooms by rule, so don't prune theirs. Listed before the
  // bare /:username route.
  const userAccessMatch = pathname.match(/^\/api\/users\/([^/]+)\/access$/);
  if (userAccessMatch && method === "PUT") {
    const uname = decodeURIComponent(userAccessMatch[1]);
    const existing = users.get(uname.toLowerCase());
    if (!existing) {
      throw new ApiError(404, "not_found", `User ${uname} not found`);
    }
    const b = (body ?? {}) as { allowedRooms?: string[] };
    const allowedRooms = Array.isArray(b.allowedRooms)
      ? b.allowedRooms
      : existing.allowedRooms;
    const accessible =
      existing.role === "owner"
        ? new Set(state.getState().rooms.map((r) => r.id))
        : new Set(allowedRooms);
    const notifRooms = existing.notifRooms.filter((id) => accessible.has(id));
    const defaultRoomId =
      existing.defaultRoomId && accessible.has(existing.defaultRoomId)
        ? existing.defaultRoomId
        : null;
    const updated: UserRecord = {
      ...existing,
      allowedRooms,
      notifRooms,
      defaultRoomId,
    };
    users.set(updated.name.toLowerCase(), updated);
    shimEmit({ type: "user_updated", user: updated });
    shimEmit({ type: "users_list", users: [...users.values()] });
    return { user: updated };
  }
  // 3d.9b users.update (PATCH) / users.delete (DELETE) on /api/users/:username.
  // PATCH = record fields only (Option A; view prefs ride the no-op view.*
  // routes); mirrors the retired update_user record path (rename-collision 409,
  // missing 404). DELETE removes the record + broadcasts users_list.
  const userIdMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userIdMatch && (method === "PATCH" || method === "DELETE")) {
    const uname = decodeURIComponent(userIdMatch[1]);
    const key = uname.toLowerCase();
    if (method === "DELETE") {
      if (users.has(key)) {
        users.delete(key);
        shimEmit({ type: "users_list", users: [...users.values()] });
      }
      return undefined;
    }
    const existing = users.get(key);
    if (!existing) {
      throw new ApiError(404, "not_found", `User ${uname} not found`);
    }
    const c = (body ?? {}) as {
      name?: string;
      envFile?: string | null;
      memberPrompt?: string | null;
      avatarColor?: string;
      avatarVariant?: string;
    };
    const trimmedName = c.name?.trim();
    const renamed = !!trimmedName && trimmedName !== existing.name;
    if (renamed && trimmedName) {
      const newKey = trimmedName.toLowerCase();
      if (newKey !== key && users.has(newKey)) {
        throw new ApiError(
          409,
          "name_taken",
          `User "${trimmedName}" already exists`,
        );
      }
    }
    const updated: UserRecord = {
      ...existing,
      ...(renamed && trimmedName ? { name: trimmedName } : {}),
      ...(c.envFile !== undefined ? { envFile: c.envFile } : {}),
      ...(c.memberPrompt !== undefined
        ? {
            memberPrompt: c.memberPrompt?.trim() ? c.memberPrompt.trim() : null,
          }
        : {}),
      ...(c.avatarColor !== undefined && isHexColor(c.avatarColor)
        ? { avatarColor: normalizeHexColor(c.avatarColor) }
        : {}),
      ...(c.avatarVariant !== undefined && isGhostVariant(c.avatarVariant)
        ? { avatarVariant: c.avatarVariant }
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
    const stephen = users.get("stephen");
    if (stephen && updated.id === stephen.id) emitStephenPresence();
    return { user: updated };
  }
  // rooms.setSettings (PUT .../settings) — set the prompt + broadcast
  // room_settings_updated. No settings_save_response (the dialog reads the HTTP
  // response now); returns no body (204-like). Listed before the bare /:id route.
  const roomSettingsMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/settings$/);
  if (roomSettingsMatch && method === "PUT") {
    const id = decodeURIComponent(roomSettingsMatch[1]);
    const b = (body ?? {}) as RoomSettingsReq;
    emitEvents(state.setRoomSettings(id, b.prompt));
    return undefined;
  }
  // rooms.rename (PATCH) / rooms.close (DELETE) — mutate + broadcast
  // room_renamed / room_closed; no body (204-like). The production close also
  // strips the dead roomId from user records, but the single demo user is an
  // owner (rule-based access, no materialized allowedRooms), so there is nothing
  // to clean up — matching the pre-cutover demo close_room handleCommand.
  const roomIdMatch = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomIdMatch && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(roomIdMatch[1]);
    if (method === "PATCH") {
      const b = (body ?? {}) as RoomRenameReq;
      emitEvents(state.renameRoom(id, b.name));
      return undefined;
    }
    emitEvents(state.closeRoom(id));
    return undefined;
  }
  // 3d.7a — agent lifecycle, fire-and-forget mutations. The demo OfficeState
  // owns the agent_updated / agent_removed broadcasts; these routes mirror the
  // retired handleCommand cases (no agent_save_response — that is 7b's
  // response-driven trio). The FF call sites ignore the body; mapped because
  // demoApi throws on an unmapped route.
  // agents.move (POST .../move) — move + broadcast agent_updated; return { agent }.
  const agentMoveMatch = pathname.match(/^\/api\/agents\/([^/]+)\/move$/);
  if (agentMoveMatch && method === "POST") {
    const id = decodeURIComponent(agentMoveMatch[1]);
    const b = (body ?? {}) as MoveAgentReq;
    emitEvents(state.moveAgent(id, b.targetRoomId));
    return { agent: state.getAgent(id) };
  }
  // agents.abort (POST .../abort) — mirror the retired abort handleCommand:
  // cancel any pending demo reply, flip to waiting, log the interrupt. No body.
  const agentAbortMatch = pathname.match(/^\/api\/agents\/([^/]+)\/abort$/);
  if (agentAbortMatch && method === "POST") {
    const id = decodeURIComponent(agentAbortMatch[1]);
    const pending = pendingReplies.get(id);
    if (pending) {
      clearTimeout(pending);
      pendingReplies.delete(id);
    }
    shimEmit({
      type: "agent_updated",
      agentId: id,
      changes: { state: "waiting_for_response" },
    });
    shimEmit({
      type: "log_entry",
      entry: makeLogEntry(id, "system", "Agent interrupted."),
    });
    return undefined;
  }
  // agents.setTopic (PUT .../topic) / agents.clearTopic (DELETE .../topic).
  const agentTopicMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topic$/);
  if (agentTopicMatch && (method === "PUT" || method === "DELETE")) {
    const id = decodeURIComponent(agentTopicMatch[1]);
    if (method === "PUT") {
      const b = (body ?? {}) as TopicReq;
      emitEvents(state.setTopic(id, b.topic));
    } else {
      emitEvents(state.resetTopic(id));
    }
    return undefined;
  }
  // agents.revive (POST .../revive) — unreachable in the demo (no killed agents
  // -> no chips), but demoApi throws on an unmapped route, so map it; mirror the
  // retired handleCommand's clean failure.
  if (method === "POST" && /^\/api\/agents\/[^/]+\/revive$/.test(pathname)) {
    throw new ApiError(
      400,
      "revive_unsupported",
      "Revive is not supported in the demo.",
    );
  }
  // agents.kill (DELETE /api/agents/:id) + agents.update (PATCH /api/agents/:id).
  const agentIdMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentIdMatch && (method === "DELETE" || method === "PATCH")) {
    const id = decodeURIComponent(agentIdMatch[1]);
    if (method === "PATCH") {
      const changes = (body ?? {}) as EditAgentReq;
      // OfficeState.editAgent wants customInstructions string|undefined; the REST
      // type widens it to allow null (the AgentInfo Pick). The dialog clears via
      // "", never null, so coerce to preserve parity.
      emitEvents(
        state.editAgent(id, {
          ...changes,
          customInstructions: changes.customInstructions ?? undefined,
        }),
      );
      return { agent: state.getAgent(id) };
    }
    emitEvents(state.kill(id));
    return undefined;
  }
  // rooms.swapDesks (POST /api/rooms/:roomId/swap-desks) — swap + broadcast.
  const swapDesksMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/swap-desks$/);
  if (swapDesksMatch && method === "POST") {
    const roomId = decodeURIComponent(swapDesksMatch[1]);
    const b = (body ?? {}) as SwapDesksReq;
    emitEvents(state.swapDesks(b.deskA, b.deskB, roomId));
    return undefined;
  }
  // 3d.6a — conversation (send/edit/cancel/sendNow/newConversation/resume/
  // listSessions). The demo simulates a chat reply for sendMessage (the retired
  // send_message handleCommand); the rest are no-ops the demo never exercises but
  // must map (demoApi throws on an unmapped route). The turn "streams" via the
  // same shimEmit log_entry events; the { messageId } ack is ignored by the UI.
  // agents.listSessions (GET .../sessions) — the demo has no sessions.
  if (method === "GET" && /^\/api\/agents\/[^/]+\/sessions$/.test(pathname)) {
    return { sessions: [], currentSessionId: null };
  }
  // agents.sendMessage (POST .../messages) — log the user message, show
  // "thinking", then reply after a beat. username is server-derived in prod, so
  // the demo user message carries no username label.
  const messagesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
  if (messagesMatch && method === "POST") {
    const id = decodeURIComponent(messagesMatch[1]);
    const b = (body ?? {}) as SendMessageReq;
    shimEmit({
      type: "log_entry",
      entry: makeLogEntry(id, "user_message", b.text ?? ""),
    });
    const prev = pendingReplies.get(id);
    if (prev) clearTimeout(prev);
    shimEmit({
      type: "agent_updated",
      agentId: id,
      changes: { state: "thinking" },
    });
    pendingReplies.set(
      id,
      setTimeout(() => {
        pendingReplies.delete(id);
        shimEmit({
          type: "log_entry",
          entry: makeLogEntry(id, "text", DEMO_REPLY),
        });
        shimEmit({
          type: "agent_updated",
          agentId: id,
          changes: { state: "waiting_for_response" },
        });
      }, 800),
    );
    return { messageId: "demo" };
  }
  // agents.editMessage (PATCH .../messages/:logEntryId) — no-op in the demo.
  if (
    method === "PATCH" &&
    /^\/api\/agents\/[^/]+\/messages\/[^/]+$/.test(pathname)
  ) {
    return { messageId: "demo" };
  }
  // agents.cancelQueued (DELETE .../queue/:messageId) — no-op (no demo queue).
  if (
    method === "DELETE" &&
    /^\/api\/agents\/[^/]+\/queue\/[^/]+$/.test(pathname)
  ) {
    return undefined;
  }
  // agents.sendNow / newConversation / resume — no-ops the demo never exercises.
  if (
    method === "POST" &&
    /^\/api\/agents\/[^/]+\/(send-now|new-conversation|resume)$/.test(pathname)
  ) {
    return undefined;
  }
  // 3d.6b — editor (open/save/close). The demo has no filesystem: open returns a
  // placeholder (echoing the requested path so the client keys its tab), save is a
  // no-op ack, close (watch teardown) is a no-op. Unreachable in practice (demo
  // agents emit no edit affordances) but must map — demoApi throws on an unmapped
  // route.
  if (method === "GET" && /^\/api\/agents\/[^/]+\/file$/.test(pathname)) {
    const p = new URLSearchParams(path.split("?")[1] ?? "").get("path") ?? "";
    return {
      path: p,
      content: "// File contents are not available in the demo.\n",
      mtime: 0,
      language: "plaintext",
      size: 0,
    };
  }
  if (method === "PUT" && /^\/api\/agents\/[^/]+\/file$/.test(pathname)) {
    return { ok: true, mtime: 0 };
  }
  if (
    method === "DELETE" &&
    /^\/api\/agents\/[^/]+\/file\/watch$/.test(pathname)
  ) {
    return undefined;
  }
  throw new Error(`demoApi: unhandled route ${route}`);
}

export function handleCommand(cmd: ClientCommand) {
  switch (cmd.type) {
    // Silent no-ops
    case "terminal_open":
    case "terminal_input":
    case "terminal_resize":
    case "terminal_close":
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
