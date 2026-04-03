import { join } from "path";
import { homedir } from "os";
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import type { AgentInfo, ClaudeModel, LogEntry, TodoItem } from "../shared/types.ts";

const ISOMUX_DIR = join(homedir(), ".isomux");
const LOGS_DIR = join(ISOMUX_DIR, "logs");
const AGENTS_FILE = join(ISOMUX_DIR, "agents.json");
const OFFICE_PROMPT_FILE = join(ISOMUX_DIR, "office-prompt.md");
const TODOS_FILE = join(ISOMUX_DIR, "todos.json");

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
    return content.split("\n").map((line) => JSON.parse(line) as LogEntry);
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

// Todos
export function loadTodos(): TodoItem[] {
  try {
    if (!existsSync(TODOS_FILE)) return [];
    return JSON.parse(readFileSync(TODOS_FILE, "utf-8")) as TodoItem[];
  } catch {
    return [];
  }
}

export function saveTodos(todos: TodoItem[]) {
  try {
    writeFileSync(TODOS_FILE, JSON.stringify(todos, null, 2));
  } catch (err) {
    console.error("Failed to save todos:", err);
  }
}
