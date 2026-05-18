import { join } from "path";
import { homedir } from "os";
import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
} from "fs";
import { createHash } from "crypto";
import type {
  AgentInfo,
  Attachment,
  EffortLevel,
  LogEntry,
  OfficeSettings,
  TaskItem,
} from "../shared/types.ts";
import { familyFromLegacyModel, generateRoomId } from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import { normalizePublicOrigin } from "../shared/public-origin.ts";

const ISOMUX_DIR = join(homedir(), ".isomux");
const LOGS_DIR = join(ISOMUX_DIR, "logs");
const AGENTS_FILE = join(ISOMUX_DIR, "agents.json");
const OFFICE_PROMPT_FILE = join(ISOMUX_DIR, "office-prompt.md");
const OFFICE_CONFIG_FILE = join(ISOMUX_DIR, "office-config.json");
const TASKS_FILE = join(ISOMUX_DIR, "tasks.json");
const AGENT_HISTORY_FILE = join(ISOMUX_DIR, "agent-history.json");

// Ensure directories exist
try {
  mkdirSync(ISOMUX_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
} catch {}

// Atomic file write: write to a sibling .tmp file then rename. Renames are
// atomic on the same filesystem, so a concurrent reader (notably the backup
// tarball) sees either the previous contents or the new contents, never a
// half-written file. JSONL appends are line-tolerant and skip this.
export function atomicWriteFileSync(path: string, data: string | Buffer) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function appendLog(agentId: string, sessionId: string, entry: LogEntry) {
  // Ephemeral entries (e.g. UI-only "Conversation cleared." markers) must
  // never reach disk — guarded here as defense-in-depth so future callers
  // can't accidentally persist one by going through appendLog directly.
  if (entry.ephemeral) return;
  try {
    const agentDir = join(LOGS_DIR, agentId);
    mkdirSync(agentDir, { recursive: true });
    const logFile = join(agentDir, `${sessionId}.jsonl`);
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Failed to write log:", err);
  }
}

// Load log entries from a session's JSONL file
export function loadLog(agentId: string, sessionId: string): LogEntry[] {
  try {
    const logFile = join(LOGS_DIR, agentId, `${sessionId}.jsonl`);
    if (!existsSync(logFile)) return [];
    const content = readFileSync(logFile, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => {
      const entry = JSON.parse(line) as LogEntry & { images?: string[] };
      // Migrate legacy images field to attachments
      if (entry.images && !entry.attachments) {
        entry.attachments = entry.images.map((filename) => {
          const ext = filename.split(".").pop() ?? "";
          const mediaType =
            EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
          return { filename, originalName: filename, mediaType, size: 0 };
        });
        delete entry.images;
      }
      return entry;
    });
  } catch (err) {
    console.error("Failed to load log:", err);
    return [];
  }
}

/**
 * Load log entries for a session, including ancestor entries from forked-from sessions.
 * Walks the forkedFrom chain in sessions.json: for each ancestor, loads entries before
 * forkMessageId (the edited message). Concatenates oldest-ancestor-first, then the
 * fork's own entries. This avoids duplicating log entries across JSONL files.
 */
export function loadLogWithAncestors(
  agentId: string,
  sessionId: string,
): LogEntry[] {
  const sessionsMap = loadSessionsMap(agentId);

  // Build the ancestor chain: [oldest ancestor, ..., immediate parent, self]
  const chain: { sessionId: string; forkMessageId?: string }[] = [];
  let current: string | undefined = sessionId;
  const visited = new Set<string>(); // guard against cycles
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const meta: { forkedFrom?: string; forkMessageId?: string } | undefined =
      sessionsMap[current];
    chain.unshift({ sessionId: current, forkMessageId: meta?.forkMessageId });
    current = meta?.forkedFrom;
  }

  const result: LogEntry[] = [];
  for (let i = 0; i < chain.length; i++) {
    const entries = loadLog(agentId, chain[i].sessionId);
    if (i < chain.length - 1) {
      // Ancestor: take entries before the fork point (the edited message)
      const cutoffId = chain[i + 1].forkMessageId;
      for (const entry of entries) {
        if (entry.id === cutoffId) break;
        result.push(entry);
      }
    } else {
      // Self (leaf): take all entries
      result.push(...entries);
    }
  }
  return result;
}

// Per-session metadata storage: ~/.isomux/logs/<agentId>/sessions.json.
// - `usage` holds current-run accumulated usage. Token fields are summed as
//   each SDK `result` arrives (SDK reports tokens per-turn). `costUSD` is
//   overwritten (SDK reports cost cumulative-per-process). On resume, the
//   SDK's per-process counters restart, so this struct is rolled into
//   `priorRunsUsage` and reset to zero.
// - `priorRunsUsage` accumulates completed process-runs' final values.
//   Session lifetime = priorRunsUsage + usage.
// - `usageSnapshots` records cumulative usage after each turn, anchored to the
//   id of the last log entry written at that moment. /usage walks the parent's
//   log to find the snapshot at-or-before a fork point and subtracts it from
//   the fork's own cumulative — exact fork accounting with no double-count.
// - `forkBaseUsage` is the parent's cumulative-at-the-fork-point captured at
//   fork creation (resolved via the snapshots above).
type UsageSnapshot = { entryId: string; usage: PersistedUsage };
type SessionsMap = Record<
  string,
  {
    topic: string | null;
    // Count of user_message + text log entries at the moment the persisted
    // topic was last generated. Used on resume/startup to detect drift: if
    // the replayed log has materially more entries, the topic is stale and
    // worth regenerating. Missing on entries persisted before this field
    // existed — treated as 0 (regenerate aggressively).
    topicMessageCount?: number;
    lastModified: number;
    forkedFrom?: string;
    forkMessageId?: string;
    usage?: PersistedUsage;
    priorRunsUsage?: PersistedUsage;
    forkBaseUsage?: PersistedUsage;
    usageSnapshots?: UsageSnapshot[];
  }
>;

export function loadSessionsMap(agentId: string): SessionsMap {
  try {
    const filePath = join(LOGS_DIR, agentId, "sessions.json");
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf-8")) as SessionsMap;
  } catch {
    return {};
  }
}

function saveSessionsMap(agentId: string, map: SessionsMap) {
  try {
    const agentDir = join(LOGS_DIR, agentId);
    mkdirSync(agentDir, { recursive: true });
    atomicWriteFileSync(
      join(agentDir, "sessions.json"),
      JSON.stringify(map, null, 2),
    );
  } catch (err) {
    console.error("Failed to save sessions map:", err);
  }
}

export function persistSessionTopic(
  agentId: string,
  sessionId: string,
  topic: string | null,
  topicMessageCount: number = 0,
) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId];
  map[sessionId] = {
    ...existing,
    topic,
    topicMessageCount,
    lastModified: Date.now(),
  };
  saveSessionsMap(agentId, map);
}

export function persistSessionFork(
  agentId: string,
  sessionId: string,
  forkedFrom: string,
  forkMessageId: string,
  topic: string | null,
  topicMessageCount: number,
  forkBaseUsage?: PersistedUsage,
) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  map[sessionId] = {
    ...existing,
    topic,
    topicMessageCount,
    lastModified: Date.now(),
    forkedFrom,
    forkMessageId,
    ...(forkBaseUsage ? { forkBaseUsage } : {}),
  };
  saveSessionsMap(agentId, map);
}

// Accumulate a turn's usage into the session's current-run bucket. Token
// fields (per-turn from the SDK) are summed; cost (cumulative-per-process
// from the SDK) overwrites. Returns the resulting cumulative so callers can
// use it for downstream bookkeeping (e.g. snapshots).
export function accumulateSessionUsage(
  agentId: string,
  sessionId: string,
  turnTokens: Omit<PersistedUsage, "costUSD">,
  runCostUSD: number,
): PersistedUsage {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  const prev = existing.usage;
  const next: PersistedUsage = {
    inputTokens: (prev?.inputTokens ?? 0) + turnTokens.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + turnTokens.outputTokens,
    cacheReadInputTokens:
      (prev?.cacheReadInputTokens ?? 0) + turnTokens.cacheReadInputTokens,
    cacheCreationInputTokens:
      (prev?.cacheCreationInputTokens ?? 0) +
      turnTokens.cacheCreationInputTokens,
    costUSD: runCostUSD,
  };
  map[sessionId] = { ...existing, usage: next, lastModified: Date.now() };
  saveSessionsMap(agentId, map);
  return next;
}

// Called at resume time to roll the current-run usage into the prior-runs
// accumulator so the SDK can reset its per-process counter without losing
// the cost already spent. No-op if nothing has been spent yet.
export function rollSessionUsageOnResume(agentId: string, sessionId: string) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId];
  if (!existing?.usage) return;
  const u = existing.usage;
  if (
    u.costUSD === 0 &&
    u.inputTokens === 0 &&
    u.outputTokens === 0 &&
    u.cacheReadInputTokens === 0 &&
    u.cacheCreationInputTokens === 0
  )
    return;
  const prior = existing.priorRunsUsage;
  const rolled: PersistedUsage = {
    inputTokens: (prior?.inputTokens ?? 0) + u.inputTokens,
    outputTokens: (prior?.outputTokens ?? 0) + u.outputTokens,
    cacheReadInputTokens:
      (prior?.cacheReadInputTokens ?? 0) + u.cacheReadInputTokens,
    cacheCreationInputTokens:
      (prior?.cacheCreationInputTokens ?? 0) + u.cacheCreationInputTokens,
    costUSD: (prior?.costUSD ?? 0) + u.costUSD,
  };
  map[sessionId] = {
    ...existing,
    priorRunsUsage: rolled,
    usage: undefined,
    lastModified: Date.now(),
  };
  saveSessionsMap(agentId, map);
}

export function appendSessionUsageSnapshot(
  agentId: string,
  sessionId: string,
  entryId: string,
  usage: PersistedUsage,
) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  const snapshots = existing.usageSnapshots ?? [];
  // Coalesce snapshots that share an entryId (multiple results with no log
  // activity between them — shouldn't happen, but keep the list compact).
  const last = snapshots[snapshots.length - 1];
  if (last && last.entryId === entryId) {
    last.usage = usage;
  } else {
    snapshots.push({ entryId, usage });
  }
  map[sessionId] = {
    ...existing,
    usageSnapshots: snapshots,
    lastModified: Date.now(),
  };
  saveSessionsMap(agentId, map);
}

// List all sessions for an agent (sorted by most recent first), with topics from sessions.json
export function listAgentSessions(agentId: string): {
  sessionId: string;
  lastModified: number;
  topic: string | null;
  topicMessageCount: number;
  branched?: boolean;
  forked?: boolean;
}[] {
  try {
    const agentDir = join(LOGS_DIR, agentId);
    if (!existsSync(agentDir)) return [];
    const sessionsMap = loadSessionsMap(agentId);

    // Collect all forkedFrom values to detect which sessions have been branched FROM
    const branchedFromIds = new Set<string>();
    for (const entry of Object.values(sessionsMap)) {
      if (entry.forkedFrom) branchedFromIds.add(entry.forkedFrom);
    }

    return readdirSync(agentDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const sid = f.replace(".jsonl", "");
        const entry = sessionsMap[sid];
        return {
          sessionId: sid,
          lastModified:
            entry?.lastModified ?? Bun.file(join(agentDir, f)).lastModified,
          topic: entry?.topic ?? null,
          topicMessageCount: entry?.topicMessageCount ?? 0,
          ...(branchedFromIds.has(sid) ? { branched: true as const } : {}),
          ...(entry?.forkedFrom ? { forked: true as const } : {}),
        };
      })
      .sort((a, b) => b.lastModified - a.lastModified);
  } catch {
    return [];
  }
}

// List every agent id that has a log directory on disk. Killed agents stay
// here even though they're gone from agents.json, so /usage can still account
// for their historical token spend.
export function listAllAgentIdsOnDisk(): string[] {
  try {
    if (!existsSync(LOGS_DIR)) return [];
    return readdirSync(LOGS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("agent-"))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// Find the most recent session log for an agent (by file modification time)
export function findLatestSession(agentId: string): string | null {
  try {
    const agentDir = join(LOGS_DIR, agentId);
    if (!existsSync(agentDir)) return null;
    const files = readdirSync(agentDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f.replace(".jsonl", ""),
        mtime: Bun.file(join(agentDir, f)).lastModified,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.name ?? null;
  } catch {
    return null;
  }
}

// Persisted agent config (subset of AgentInfo + session tracking)
export interface PersistedAgent {
  id: string;
  name: string;
  desk: number;
  cwd: string;
  outfit: AgentInfo["outfit"];
  permissionMode: AgentInfo["permissionMode"];
  // Backend-specific string. Claude: ModelFamily; Codex: GPT-5 family id.
  modelFamily?: string;
  effort?: EffortLevel;
  // Engine. Missing field defaults to "claude" on load (legacy agents spawned
  // before this field was added). Fixed at spawn — see task f352984f Round 3.
  agentType?: AgentInfo["agentType"];
  // Codex-only sandbox setting.
  codexSandbox?: AgentInfo["codexSandbox"];
  lastSessionId: string | null;
  topic: string | null;
  customInstructions: string | null;
  // Identity reference for per-user env at spawn/resume time. `userId` is
  // authoritative for env lookup (via buildEnvForUserId); `username` is a
  // display snapshot kept for UI/wire compatibility and audit purposes.
  // Both null on legacy unowned agents.
  userId?: string | null;
  username?: string | null;
}

export interface PersistedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

// Migrate a persisted agent that may have the legacy `model: "claude-opus-4-6"`
// field to the current `modelFamily: "opus"` shape. Mutates in place.
function migratePersistedAgent(
  agent: PersistedAgent & { model?: string },
): void {
  if (agent.modelFamily) return;
  if (typeof agent.model === "string") {
    agent.modelFamily = familyFromLegacyModel(agent.model);
    delete agent.model;
  }
}

export interface Room {
  id: string; // stable 8-char hex
  name: string; // display name
  prompt: string | null; // room-level prompt
  agents: PersistedAgent[];
}

export function loadAgents(): Room[] {
  const defaultRoom = (): Room => ({
    id: generateRoomId(),
    name: "Room 1",
    prompt: null,
    agents: [],
  });
  let rooms: (Room & { envFile?: string })[];
  try {
    if (!existsSync(AGENTS_FILE)) return [defaultRoom()];
    const content = readFileSync(AGENTS_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) return [defaultRoom()];

    const first = parsed[0];

    if (
      first &&
      typeof first === "object" &&
      "name" in first &&
      "agents" in first
    ) {
      rooms = parsed;
    } else if (Array.isArray(first)) {
      rooms = (parsed as PersistedAgent[][]).map((agents, i) => ({
        id: generateRoomId(),
        name: `Room ${i + 1}`,
        prompt: null,
        agents,
      }));
    } else {
      rooms = [
        {
          id: generateRoomId(),
          name: "Room 1",
          prompt: null,
          agents: parsed as PersistedAgent[],
        },
      ];
    }
  } catch {
    return [defaultRoom()];
  }

  // Migrate each room: fill in missing id / prompt; drop legacy envFile.
  const existingIds: string[] = rooms
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  let strippedRoomEnv = 0;
  let migratedAgents = 0;
  for (const room of rooms) {
    if (typeof room.id !== "string" || room.id.length === 0) {
      room.id = generateRoomId(existingIds);
      existingIds.push(room.id);
    }
    if (typeof room.prompt !== "string") room.prompt = null;
    if (typeof room.envFile === "string" && room.envFile) {
      console.log(
        `[migration] room "${room.name}" had envFile=${room.envFile} (now removed; copy to your User Settings if you still want it applied)`,
      );
      strippedRoomEnv++;
    }
    delete room.envFile;
    for (const agent of room.agents) {
      migratePersistedAgent(agent);
      // Stamp username: null on legacy agents that pre-date the user/device split.
      if (!("username" in agent)) {
        agent.username = null;
        migratedAgents++;
      }
      // userId resolution from the legacy username snapshot lives in
      // agent-manager.ts (which can statically import users.ts without
      // creating a cycle with persistence.ts). loadAgents() leaves the
      // field unset; restoreAgents() in agent-manager fills it.
    }
  }
  if (migratedAgents > 0) {
    console.log(
      `[migration] migrated ${migratedAgents} agents to unowned (username:null); spawn new agents to apply per-user env`,
    );
  }
  if (strippedRoomEnv > 0) {
    console.log(
      `[migration] stripped envFile from ${strippedRoomEnv} room(s); env is now per-user`,
    );
  }
  return rooms;
}

export function saveAgents(rooms: Room[]) {
  try {
    atomicWriteFileSync(AGENTS_FILE, JSON.stringify(rooms, null, 2));
  } catch (err) {
    console.error("Failed to save agents:", err);
  }
}

// Agent manifest for discovery by other agents
const MANIFEST_FILE = join(ISOMUX_DIR, "agents-summary.json");

export function writeManifest(
  agents: {
    id: string;
    name: string;
    desk: number;
    room: number;
    roomName: string;
    topic: string | null;
    cwd: string;
    modelFamily: string;
    model: string;
    username: string | null;
  }[],
) {
  try {
    const manifest = agents.map((a) => ({
      id: a.id,
      name: a.name,
      desk: a.desk,
      room: a.room + 1, // 1-based for human readability
      roomName: a.roomName,
      topic: a.topic,
      cwd: a.cwd,
      modelFamily: a.modelFamily,
      model: a.model,
      username: a.username,
      logDir: join(LOGS_DIR, a.id),
    }));
    atomicWriteFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  } catch (err) {
    console.error("Failed to write manifest:", err);
  }
}

// Recent working directories
const RECENT_CWDS_FILE = join(ISOMUX_DIR, "recent-cwds.json");
const MAX_RECENT_CWDS = 20;

export function loadRecentCwds(): string[] {
  try {
    if (!existsSync(RECENT_CWDS_FILE)) return [];
    return JSON.parse(readFileSync(RECENT_CWDS_FILE, "utf-8")) as string[];
  } catch {
    return [];
  }
}

export function saveRecentCwd(cwd: string) {
  try {
    const recent = loadRecentCwds().filter((c) => c !== cwd);
    recent.unshift(cwd);
    atomicWriteFileSync(
      RECENT_CWDS_FILE,
      JSON.stringify(recent.slice(0, MAX_RECENT_CWDS), null, 2),
    );
  } catch (err) {
    console.error("Failed to save recent cwd:", err);
  }
}

// Office-level settings (prompt + env file path) stored in office-config.json.
// On first load, if the legacy office-prompt.md exists and no config file does,
// fold the .md content into the JSON and leave the .md in place as a one-time backup.
//
// The same file also carries deployment-level keys not edited via the UI
// (currently `publicOrigin`, used as a fallback for `ISOMUX_PUBLIC_ORIGIN`
// when the env var is unset — see docs/access-and-invites.md). Those keys
// are NOT part of OfficeSettings; `loadOfficeConfig`/`saveOfficeConfig`
// only surface prompt + envFile to the UI-mutated office state. Save uses
// a read-modify-write so sibling keys outside OfficeSettings survive UI
// saves.
export function loadOfficeConfig(): OfficeSettings {
  try {
    if (existsSync(OFFICE_CONFIG_FILE)) {
      const parsed = JSON.parse(
        readFileSync(OFFICE_CONFIG_FILE, "utf-8"),
      ) as Partial<OfficeSettings>;
      return {
        prompt:
          typeof parsed.prompt === "string" && parsed.prompt
            ? parsed.prompt
            : null,
        envFile:
          typeof parsed.envFile === "string" && parsed.envFile
            ? parsed.envFile
            : null,
        name:
          typeof parsed.name === "string" && parsed.name.trim()
            ? parsed.name.trim()
            : null,
      };
    }
  } catch (err) {
    console.error("Failed to load office config:", err);
  }
  // Migration: fold legacy office-prompt.md into the config on first load.
  let legacyPrompt: string | null = null;
  try {
    if (existsSync(OFFICE_PROMPT_FILE)) {
      const raw = readFileSync(OFFICE_PROMPT_FILE, "utf-8");
      if (raw.trim()) legacyPrompt = raw;
    }
  } catch {}
  const config: OfficeSettings = {
    prompt: legacyPrompt,
    envFile: null,
    name: null,
  };
  // Only persist if the legacy prompt actually had content — otherwise a fresh
  // install touches a new file for no reason, and the next save/set will write
  // it anyway once there's real data.
  if (legacyPrompt) {
    try {
      atomicWriteFileSync(OFFICE_CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error("Failed to write initial office config:", err);
    }
  }
  return config;
}

export function saveOfficeConfig(config: OfficeSettings) {
  try {
    const merged = {
      ...readOfficeConfigRaw(),
      prompt: config.prompt,
      envFile: config.envFile,
      name: config.name,
    };
    atomicWriteFileSync(OFFICE_CONFIG_FILE, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error("Failed to save office config:", err);
  }
}

// Server/deployment config that shares office-config.json but isn't part of
// the UI-mutated OfficeSettings. Currently just `publicOrigin`, used as a
// fallback when `ISOMUX_PUBLIC_ORIGIN` is unset in the environment. Server
// reads at boot only; writes are operator-authored (direct file edit, or
// future tooling that runs outside the agent safety-hook sandbox).

export interface ServerConfig {
  publicOrigin: string | null;
}

// Re-read the raw JSON object so save paths can do a read-modify-write that
// preserves unrelated sibling keys (e.g. `publicOrigin` when the UI saves
// prompt/envFile, or vice versa). Always returns a plain object — missing
// file or parse failure both map to `{}`.
function readOfficeConfigRaw(): Record<string, unknown> {
  try {
    if (!existsSync(OFFICE_CONFIG_FILE)) return {};
    const parsed = JSON.parse(readFileSync(OFFICE_CONFIG_FILE, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Read `publicOrigin` from office-config.json. Invalid values (path, query,
// non-localhost http, malformed URL) are logged and ignored, returning null
// so server boot degrades to the localhost fallback rather than throwing.
export function loadServerConfig(): ServerConfig {
  const raw = readOfficeConfigRaw();
  if (!("publicOrigin" in raw)) return { publicOrigin: null };
  const candidate = raw.publicOrigin;
  if (candidate === null) return { publicOrigin: null };
  if (typeof candidate !== "string") {
    console.error(
      "[server-config] publicOrigin in office-config.json is not a string; ignoring",
    );
    return { publicOrigin: null };
  }
  const normalized = normalizePublicOrigin(candidate);
  if (!normalized) {
    console.error(
      `[server-config] publicOrigin "${candidate}" in office-config.json is not a valid public origin (need https://<host> or http://localhost); ignoring`,
    );
    return { publicOrigin: null };
  }
  return { publicOrigin: normalized };
}

// Persist `publicOrigin` to office-config.json, preserving all other keys.
// Validated here as defense in depth — callers should fail loudly rather
// than persist a value the server would later silently drop. Not currently
// reached from the running server; exposed for tooling that writes the
// fallback from outside the agent safety hook (which blocks writes into
// ~/.isomux/ from agent sessions).
export function saveServerConfig(config: ServerConfig) {
  let nextValue: string | null;
  if (config.publicOrigin === null) {
    nextValue = null;
  } else {
    const normalized = normalizePublicOrigin(config.publicOrigin);
    if (!normalized) {
      throw new Error(
        `invalid publicOrigin: ${config.publicOrigin} (need https://<host> or http://localhost)`,
      );
    }
    nextValue = normalized;
  }
  const merged = { ...readOfficeConfigRaw(), publicOrigin: nextValue };
  atomicWriteFileSync(OFFICE_CONFIG_FILE, JSON.stringify(merged, null, 2));
}

// Minimal dotenv parser. Supports KEY=VALUE, comments (#), export prefix,
// single/double-quoted values (\n escape inside double quotes). Blank lines ignored.
// Throws with "line N" context if a non-blank line can't be parsed.
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const raw = line;
    // Strip BOM from the first line
    if (i === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const working = stripped.startsWith("export ")
      ? stripped.slice(7).trimStart()
      : stripped;
    const eqIdx = working.indexOf("=");
    if (eqIdx <= 0) {
      throw new Error(`parse error at line ${i + 1}: ${JSON.stringify(raw)}`);
    }
    const key = working.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `parse error at line ${i + 1}: invalid key ${JSON.stringify(key)}`,
      );
    }
    let value = working.slice(eqIdx + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else if (value[0] === '"' || value[0] === "'") {
      throw new Error(
        `parse error at line ${i + 1}: unterminated quoted value`,
      );
    } else {
      // Strip inline comment (only if preceded by whitespace)
      const hashMatch = value.match(/\s+#/);
      if (hashMatch && hashMatch.index !== undefined)
        value = value.slice(0, hashMatch.index);
      value = value.trim();
    }
    result[key] = value;
  }
  return result;
}

// Read and parse an env file. Returns the key/value map on success,
// throws a descriptive error on failure (missing, unreadable, parse error).
export function readEnvFile(path: string): Record<string, string> {
  if (!path.startsWith("/")) {
    throw new Error("env file path must be absolute");
  }
  if (!existsSync(path)) {
    throw new Error(`file not found: ${path}`);
  }
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`unreadable: ${errMessage(err)}`, {
      cause: err,
    });
  }
  return parseDotenv(content);
}

// Agent history: per-agent last-known name + last-known room (id + name).
// Used by /usage to attribute killed agents to the room they were in, and to
// label the room as "(deleted)" if it no longer exists. Entries are never
// removed — killed agents keep contributing to lifetime spend forever.
export interface AgentHistoryEntry {
  name: string;
  lastRoomId: string;
  lastRoomName: string;
}
export type AgentHistory = Record<string, AgentHistoryEntry>;

export function loadAgentHistory(): AgentHistory {
  try {
    if (!existsSync(AGENT_HISTORY_FILE)) return {};
    return JSON.parse(
      readFileSync(AGENT_HISTORY_FILE, "utf-8"),
    ) as AgentHistory;
  } catch {
    return {};
  }
}

export function saveAgentHistory(history: AgentHistory) {
  try {
    atomicWriteFileSync(AGENT_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Failed to save agent history:", err);
  }
}

// Tasks
export function loadTasks(): TaskItem[] {
  try {
    if (!existsSync(TASKS_FILE)) return [];
    const records = JSON.parse(readFileSync(TASKS_FILE, "utf-8")) as Array<
      TaskItem & { device?: string }
    >;
    // Migrate legacy `device` field → `username` (the field's actual semantics
    // has always been "the boss's name").
    let migrated = 0;
    for (const r of records) {
      if (r.device !== undefined && r.username === undefined) {
        r.username = r.device;
        migrated++;
      }
      delete (r as { device?: unknown }).device;
    }
    if (migrated > 0) {
      console.log(
        `[migration] migrated ${migrated} task(s) from device → username`,
      );
    }
    return records;
  } catch {
    return [];
  }
}

export function saveTasks(tasks: TaskItem[]) {
  try {
    atomicWriteFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch (err) {
    console.error("Failed to save tasks:", err);
  }
}

// ---------------------------------------------------------------------------
// File storage (unified files/ directory with SHA256 dedup)
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "text/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  html: "text/html",
  css: "text/css",
};

/** Sanitize a filename: strip path components, replace unsafe chars, fallback to hash. */
function sanitizeFilename(name: string): string {
  // Strip directory components
  const base = name.replace(/.*[/\\]/, "");
  // Replace anything that isn't alphanumeric, dot, dash, underscore, or space
  const clean = base.replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
  return clean || "file";
}

/** Save a file buffer to disk. Returns an Attachment object or null on failure. */
export function saveFile(
  agentId: string,
  data: Buffer,
  mediaType: string,
  originalName: string,
): Attachment | null {
  try {
    if (data.length > MAX_FILE_BYTES) return null;

    const dir = join(LOGS_DIR, agentId, "files");
    mkdirSync(dir, { recursive: true });

    let filename = sanitizeFilename(originalName);
    let filepath = join(dir, filename);

    // If file with same name and content exists, reuse it (same upload repeated).
    // If same name but different content, add a numeric suffix.
    if (existsSync(filepath)) {
      const existingHash = createHash("sha256")
        .update(readFileSync(filepath))
        .digest("hex");
      const newHash = createHash("sha256").update(data).digest("hex");
      if (existingHash === newHash) {
        return { filename, originalName, mediaType, size: data.length };
      }
      const dot = filename.lastIndexOf(".");
      const stem = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : "";
      let i = 2;
      while (existsSync(filepath)) {
        filename = `${stem}_${i}${ext}`;
        filepath = join(dir, filename);
        i++;
      }
    }

    writeFileSync(filepath, data);
    return { filename, originalName, mediaType, size: data.length };
  } catch (err) {
    console.error("Failed to save file:", err);
    return null;
  }
}

/** Resolve a filename to its disk path, or null if invalid/missing. */
export function getFilePath(agentId: string, filename: string): string | null {
  // Block path traversal
  if (/[/\\]/.test(filename) || /[/\\]/.test(agentId)) return null;
  if (filename === "." || filename === "..") return null;
  // Try new files/ directory first, fall back to legacy images/
  const filePath = join(LOGS_DIR, agentId, "files", filename);
  if (existsSync(filePath)) return filePath;
  const legacyPath = join(LOGS_DIR, agentId, "images", filename);
  return existsSync(legacyPath) ? legacyPath : null;
}
