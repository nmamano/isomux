import { join } from "path";
import { homedir } from "os";
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import type { AgentInfo, Attachment, ClaudeModel, LogEntry, TaskItem } from "../shared/types.ts";

const ISOMUX_DIR = join(homedir(), ".isomux");
const LOGS_DIR = join(ISOMUX_DIR, "logs");
const AGENTS_FILE = join(ISOMUX_DIR, "agents.json");
const OFFICE_PROMPT_FILE = join(ISOMUX_DIR, "office-prompt.md");
const TASKS_FILE = join(ISOMUX_DIR, "tasks.json");

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

// Per-session topic storage: ~/.isomux/logs/<agentId>/sessions.json
type SessionsMap = Record<string, { topic: string | null; lastModified: number }>;

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
  map[sessionId] = { topic, lastModified: Date.now() };
  saveSessionsMap(agentId, map);
}

// List all sessions for an agent (sorted by most recent first), with topics from sessions.json
export function listAgentSessions(agentId: string): { sessionId: string; lastModified: number; topic: string | null }[] {
  try {
    const agentDir = join(LOGS_DIR, agentId);
    if (!existsSync(agentDir)) return [];
    const sessionsMap = loadSessionsMap(agentId);
    return readdirSync(agentDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const sid = f.replace(".jsonl", "");
        const entry = sessionsMap[sid];
        return {
          sessionId: sid,
          lastModified: entry?.lastModified ?? Bun.file(join(agentDir, f)).lastModified,
          topic: entry?.topic ?? null,
        };
      })
      .sort((a, b) => b.lastModified - a.lastModified);
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
  model?: ClaudeModel;
  lastSessionId: string | null;
  topic: string | null;
  customInstructions: string | null;
}

export function loadAgents(): PersistedAgent[][] {
  try {
    if (!existsSync(AGENTS_FILE)) return [[]];
    const content = readFileSync(AGENTS_FILE, "utf-8");
    const parsed = JSON.parse(content);
    // Migration: detect flat array (array of objects) vs nested (array of arrays)
    if (Array.isArray(parsed) && parsed.length > 0 && !Array.isArray(parsed[0])) {
      // Flat format — wrap in single room
      return [parsed as PersistedAgent[]];
    }
    if (Array.isArray(parsed)) {
      // Already nested — ensure at least one room
      const rooms = parsed as PersistedAgent[][];
      return rooms.length > 0 ? rooms : [[]];
    }
    return [[]];
  } catch {
    return [[]];
  }
}

export function saveAgents(rooms: PersistedAgent[][]) {
  try {
    writeFileSync(AGENTS_FILE, JSON.stringify(rooms, null, 2));
  } catch (err) {
    console.error("Failed to save agents:", err);
  }
}

// Agent manifest for discovery by other agents
const MANIFEST_FILE = join(ISOMUX_DIR, "agents-summary.json");

export function writeManifest(agents: { id: string; name: string; desk: number; room: number; topic: string | null; cwd: string; model: ClaudeModel }[]) {
  try {
    const manifest = agents.map((a) => ({
      id: a.id,
      name: a.name,
      desk: a.desk,
      room: a.room + 1, // 1-based for human readability
      topic: a.topic,
      cwd: a.cwd,
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

// Office-global system prompt
export function loadOfficePrompt(): string {
  try {
    if (!existsSync(OFFICE_PROMPT_FILE)) return "";
    return readFileSync(OFFICE_PROMPT_FILE, "utf-8");
  } catch {
    return "";
  }
}

export function saveOfficePrompt(text: string) {
  try {
    const trimmed = text.trim();
    if (trimmed) {
      writeFileSync(OFFICE_PROMPT_FILE, trimmed);
    } else if (existsSync(OFFICE_PROMPT_FILE)) {
      unlinkSync(OFFICE_PROMPT_FILE);
    }
  } catch (err) {
    console.error("Failed to save office prompt:", err);
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

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB

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

/** Save a file buffer to disk. Returns an Attachment object or null on failure. */
export function saveFile(agentId: string, data: Buffer, mediaType: string, originalName: string): Attachment | null {
  try {
    if (data.length > MAX_FILE_BYTES) return null;

    // Extension from original filename, fall back to mediaType mapping
    const origExt = originalName.includes(".") ? originalName.split(".").pop()! : null;
    const ext = origExt ?? MIME_TO_EXTENSION[mediaType] ?? "bin";

    const hash = createHash("sha256").update(data).digest("hex");
    const filename = `${hash}.${ext}`;
    const dir = join(LOGS_DIR, agentId, "files");
    mkdirSync(dir, { recursive: true });
    const filepath = join(dir, filename);
    if (!existsSync(filepath)) {
      writeFileSync(filepath, data);
    }
    return { filename, originalName, mediaType, size: data.length };
  } catch (err) {
    console.error("Failed to save file:", err);
    return null;
  }
}

const FILE_FILENAME_RE = /^[a-f0-9]{64}\.\w+$/;

/** Resolve a file's hash-name to its disk path, or null if invalid/missing. */
export function getFilePath(agentId: string, filename: string): string | null {
  if (!FILE_FILENAME_RE.test(filename)) return null;
  if (/[\/\\]/.test(agentId)) return null;
  // Try new files/ directory first, fall back to legacy images/
  const filePath = join(LOGS_DIR, agentId, "files", filename);
  if (existsSync(filePath)) return filePath;
  const legacyPath = join(LOGS_DIR, agentId, "images", filename);
  return existsSync(legacyPath) ? legacyPath : null;
}
