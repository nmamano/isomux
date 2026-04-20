import { join } from "path";
import { homedir } from "os";
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { createHash } from "crypto";
import type { AgentInfo, Attachment, ClaudeModel, LogEntry, ModelFamily, TaskItem } from "../shared/types.ts";
import { familyFromLegacyModel, generateRoomId } from "../shared/types.ts";

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

export function appendLog(agentId: string, sessionId: string, entry: LogEntry) {
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
          const mediaType = EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
          return { filename, originalName: filename, mediaType, size: 0 };
        });
        delete entry.images;
      }
      return entry as LogEntry;
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
export function loadLogWithAncestors(agentId: string, sessionId: string): LogEntry[] {
  const sessionsMap = loadSessionsMap(agentId);

  // Build the ancestor chain: [oldest ancestor, ..., immediate parent, self]
  const chain: { sessionId: string; forkMessageId?: string }[] = [];
  let current: string | undefined = sessionId;
  const visited = new Set<string>(); // guard against cycles
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const meta: { forkedFrom?: string; forkMessageId?: string } | undefined = sessionsMap[current];
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
// - `usage` is session-cumulative, replaced on every `result` from the SDK.
// - `usageSnapshots` records cumulative usage after each turn, anchored to the
//   id of the last log entry written at that moment. /usage walks the parent's
//   log to find the snapshot at-or-before a fork point and subtracts it from
//   the fork's own cumulative — exact fork accounting with no double-count.
// - `forkBaseUsage` is the parent's cumulative-at-the-fork-point captured at
//   fork creation (resolved via the snapshots above).
type UsageSnapshot = { entryId: string; usage: PersistedUsage };
type SessionsMap = Record<string, { topic: string | null; lastModified: number; forkedFrom?: string; forkMessageId?: string; usage?: PersistedUsage; forkBaseUsage?: PersistedUsage; usageSnapshots?: UsageSnapshot[] }>;

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
    writeFileSync(join(agentDir, "sessions.json"), JSON.stringify(map, null, 2));
  } catch (err) {
    console.error("Failed to save sessions map:", err);
  }
}

export function persistSessionTopic(agentId: string, sessionId: string, topic: string | null) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId];
  map[sessionId] = { ...existing, topic, lastModified: Date.now() };
  saveSessionsMap(agentId, map);
}

export function persistSessionFork(agentId: string, sessionId: string, forkedFrom: string, forkMessageId: string, topic: string | null, forkBaseUsage?: PersistedUsage) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  map[sessionId] = { ...existing, topic, lastModified: Date.now(), forkedFrom, forkMessageId, ...(forkBaseUsage ? { forkBaseUsage } : {}) };
  saveSessionsMap(agentId, map);
}

export function persistSessionUsage(agentId: string, sessionId: string, usage: PersistedUsage) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  map[sessionId] = { ...existing, usage, lastModified: Date.now() };
  saveSessionsMap(agentId, map);
}

export function appendSessionUsageSnapshot(agentId: string, sessionId: string, entryId: string, usage: PersistedUsage) {
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
  map[sessionId] = { ...existing, usageSnapshots: snapshots, lastModified: Date.now() };
  saveSessionsMap(agentId, map);
}

// List all sessions for an agent (sorted by most recent first), with topics from sessions.json
export function listAgentSessions(agentId: string): { sessionId: string; lastModified: number; topic: string | null; branched?: boolean; forked?: boolean }[] {
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
          lastModified: entry?.lastModified ?? Bun.file(join(agentDir, f)).lastModified,
          topic: entry?.topic ?? null,
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
  modelFamily?: ModelFamily;
  lastSessionId: string | null;
  topic: string | null;
  customInstructions: string | null;
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
function migratePersistedAgent(agent: any) {
  if (agent.modelFamily) return;
  if (typeof agent.model === "string") {
    agent.modelFamily = familyFromLegacyModel(agent.model);
    delete agent.model;
  }
}

export interface Room {
  id: string;                  // stable 8-char hex
  name: string;                // display name
  prompt: string | null;       // room-level prompt
  envFile: string | null;      // absolute path to dotenv file
  agents: PersistedAgent[];
}

export function loadAgents(): Room[] {
  const defaultRoom = (): Room => ({ id: generateRoomId(), name: "Room 1", prompt: null, envFile: null, agents: [] });
  let rooms: any[];
  try {
    if (!existsSync(AGENTS_FILE)) return [defaultRoom()];
    const content = readFileSync(AGENTS_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) return [defaultRoom()];

    const first = parsed[0];

    if (first && typeof first === "object" && "name" in first && "agents" in first) {
      rooms = parsed;
    } else if (Array.isArray(first)) {
      rooms = (parsed as PersistedAgent[][]).map((agents, i) => ({
        id: generateRoomId(),
        name: `Room ${i + 1}`,
        prompt: null,
        envFile: null,
        agents,
      }));
    } else {
      rooms = [{ id: generateRoomId(), name: "Room 1", prompt: null, envFile: null, agents: parsed as PersistedAgent[] }];
    }
  } catch {
    return [defaultRoom()];
  }

  // Migrate each room: fill in missing id / prompt / envFile.
  // Collect already-present ids to avoid collisions during migration.
  const existingIds: string[] = rooms
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  for (const room of rooms) {
    if (typeof room.id !== "string" || room.id.length === 0) {
      room.id = generateRoomId(existingIds);
      existingIds.push(room.id);
    }
    if (typeof room.prompt !== "string") room.prompt = null;
    if (typeof room.envFile !== "string") room.envFile = null;
    for (const agent of room.agents as PersistedAgent[]) migratePersistedAgent(agent);
  }
  return rooms as Room[];
}

export function saveAgents(rooms: Room[]) {
  try {
    writeFileSync(AGENTS_FILE, JSON.stringify(rooms, null, 2));
  } catch (err) {
    console.error("Failed to save agents:", err);
  }
}

// Agent manifest for discovery by other agents
const MANIFEST_FILE = join(ISOMUX_DIR, "agents-summary.json");

export function writeManifest(agents: { id: string; name: string; desk: number; room: number; roomName: string; topic: string | null; cwd: string; modelFamily: ModelFamily; model: ClaudeModel }[]) {
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
      logDir: join(LOGS_DIR, a.id),
    }));
    writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
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
    writeFileSync(RECENT_CWDS_FILE, JSON.stringify(recent.slice(0, MAX_RECENT_CWDS), null, 2));
  } catch (err) {
    console.error("Failed to save recent cwd:", err);
  }
}

// Office-level settings (prompt + env file path) stored in office-config.json.
// On first load, if the legacy office-prompt.md exists and no config file does,
// fold the .md content into the JSON and leave the .md in place as a one-time backup.
export interface OfficeConfig {
  prompt: string | null;
  envFile: string | null;
}

export function loadOfficeConfig(): OfficeConfig {
  try {
    if (existsSync(OFFICE_CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(OFFICE_CONFIG_FILE, "utf-8")) as Partial<OfficeConfig>;
      return {
        prompt: typeof parsed.prompt === "string" && parsed.prompt ? parsed.prompt : null,
        envFile: typeof parsed.envFile === "string" && parsed.envFile ? parsed.envFile : null,
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
  const config: OfficeConfig = { prompt: legacyPrompt, envFile: null };
  // Only persist if the legacy prompt actually had content — otherwise a fresh
  // install touches a new file for no reason, and the next save/set will write
  // it anyway once there's real data.
  if (legacyPrompt) {
    try {
      writeFileSync(OFFICE_CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error("Failed to write initial office config:", err);
    }
  }
  return config;
}

export function saveOfficeConfig(config: OfficeConfig) {
  try {
    writeFileSync(OFFICE_CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("Failed to save office config:", err);
  }
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
    let working = stripped.startsWith("export ") ? stripped.slice(7).trimStart() : stripped;
    const eqIdx = working.indexOf("=");
    if (eqIdx <= 0) {
      throw new Error(`parse error at line ${i + 1}: ${JSON.stringify(raw)}`);
    }
    const key = working.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`parse error at line ${i + 1}: invalid key ${JSON.stringify(key)}`);
    }
    let value = working.slice(eqIdx + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else if (value[0] === '"' || value[0] === "'") {
      throw new Error(`parse error at line ${i + 1}: unterminated quoted value`);
    } else {
      // Strip inline comment (only if preceded by whitespace)
      const hashMatch = value.match(/\s+#/);
      if (hashMatch && hashMatch.index !== undefined) value = value.slice(0, hashMatch.index);
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
  } catch (err: any) {
    throw new Error(`unreadable: ${err.message || String(err)}`);
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
    return JSON.parse(readFileSync(AGENT_HISTORY_FILE, "utf-8")) as AgentHistory;
  } catch {
    return {};
  }
}

export function saveAgentHistory(history: AgentHistory) {
  try {
    writeFileSync(AGENT_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Failed to save agent history:", err);
  }
}

// Tasks
export function loadTasks(): TaskItem[] {
  try {
    if (!existsSync(TASKS_FILE)) return [];
    return JSON.parse(readFileSync(TASKS_FILE, "utf-8")) as TaskItem[];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: TaskItem[]) {
  try {
    writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch (err) {
    console.error("Failed to save tasks:", err);
  }
}

// ---------------------------------------------------------------------------
// File storage (unified files/ directory with SHA256 dedup)
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "text/xml": "xml",
  "application/xml": "xml",
  "text/yaml": "yaml",
  "text/html": "html",
  "text/css": "css",
};

const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg",
  png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain", md: "text/markdown", csv: "text/csv",
  json: "application/json", xml: "text/xml",
  yaml: "text/yaml", yml: "text/yaml",
  html: "text/html", css: "text/css",
};

/** Sanitize a filename: strip path components, replace unsafe chars, fallback to hash. */
function sanitizeFilename(name: string): string {
  // Strip directory components
  const base = name.replace(/.*[\/\\]/, "");
  // Replace anything that isn't alphanumeric, dot, dash, underscore, or space
  const clean = base.replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
  return clean || "file";
}

/** Save a file buffer to disk. Returns an Attachment object or null on failure. */
export function saveFile(agentId: string, data: Buffer, mediaType: string, originalName: string): Attachment | null {
  try {
    if (data.length > MAX_FILE_BYTES) return null;

    const dir = join(LOGS_DIR, agentId, "files");
    mkdirSync(dir, { recursive: true });

    let filename = sanitizeFilename(originalName);
    let filepath = join(dir, filename);

    // If file with same name and content exists, reuse it (same upload repeated).
    // If same name but different content, add a numeric suffix.
    if (existsSync(filepath)) {
      const existingHash = createHash("sha256").update(readFileSync(filepath)).digest("hex");
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
  if (/[\/\\]/.test(filename) || /[\/\\]/.test(agentId)) return null;
  if (filename === "." || filename === "..") return null;
  // Try new files/ directory first, fall back to legacy images/
  const filePath = join(LOGS_DIR, agentId, "files", filename);
  if (existsSync(filePath)) return filePath;
  const legacyPath = join(LOGS_DIR, agentId, "images", filename);
  return existsSync(legacyPath) ? legacyPath : null;
}
