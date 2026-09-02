import { join, dirname } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  mkdirSync,
  appendFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { createHash } from "crypto";
import type {
  AgentInfo,
  Attachment,
  EffortLevel,
  KilledAgentSummary,
  LogEntry,
  OfficeSettings,
  ScheduledMessageEntry,
  TaskItem,
} from "../shared/types.ts";
import { familyFromLegacyModel, generateRoomId } from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import { normalizePublicOrigin } from "../shared/public-origin.ts";
import { sessionMessagePreview } from "../shared/session-label.ts";

const ISOMUX_DIR = STATE_ROOT;
const LOGS_DIR = join(ISOMUX_DIR, "logs");
const AGENTS_FILE = join(ISOMUX_DIR, "agents.json");
const OFFICE_PROMPT_FILE = join(ISOMUX_DIR, "office-prompt.md");
const OFFICE_CONFIG_FILE = join(ISOMUX_DIR, "office-config.json");
const TASKS_FILE = join(ISOMUX_DIR, "tasks.json");
const AGENT_HISTORY_FILE = join(ISOMUX_DIR, "agent-history.json");

// Importing this module is side-effect-free: state directories are created
// lazily by atomicWriteFileSync (and by the per-agent log/file writers below)
// rather than at module load, so tests and other runtimes can import the
// persistence API without touching the filesystem.

// Atomic file write: write to a sibling .tmp file then rename. Renames are
// atomic on the same filesystem, so a concurrent reader (notably the backup
// tarball) sees either the previous contents or the new contents, never a
// half-written file. JSONL appends are line-tolerant and skip this.
// `mode`, when given, is applied to the TEMP file before the rename, so the
// file is never readable at the ambient umask even for the instant between
// creation and publication. It is chmod'd explicitly rather than passed to
// writeFileSync because that option only takes effect when the file is
// CREATED - a stale .tmp left by an interrupted write would otherwise keep its
// old, laxer permissions.
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer,
  mode?: number,
) {
  // Ensure the target directory exists. This is the single choke point for
  // every top-level state-file write (agents/tasks/office config, users,
  // invites/sessions, cronjob config), so creating dirname here is what lets
  // this module import side-effect-free while still guaranteeing the directory
  // exists on the first write. Recursive mkdir is a no-op once it exists.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function appendLog(agentId: string, sessionId: string, entry: LogEntry) {
  // Ephemeral entries (e.g. UI-only "Conversation cleared." markers) must
  // never reach disk - guarded here as defense-in-depth so future callers
  // can't accidentally persist one by going through appendLog directly.
  if (entry.ephemeral) return;
  try {
    const agentDir = join(LOGS_DIR, agentId);
    mkdirSync(agentDir, { recursive: true });
    const logFile = join(agentDir, `${sessionId}.jsonl`);
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
    if (entry.kind === "user_message") {
      persistSessionFirstUserMessage(agentId, sessionId, entry.content);
    }
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
//   id of the last log entry written at that moment. /isomux-usage walks the parent's
//   log to find the snapshot at-or-before a fork point and subtracts it from
//   the fork's own cumulative - exact fork accounting with no double-count.
// - `forkBaseUsage` is the parent's cumulative-at-the-fork-point captured at
//   fork creation (resolved via the snapshots above).
type UsageSnapshot = { entryId: string; usage: PersistedUsage };
type SessionsMap = Record<
  string,
  {
    topic: string | null;
    firstUserMessage?: string | null;
    // Count of user_message + text log entries at the moment the persisted
    // topic was last generated. Used on resume/startup to detect drift: if
    // the replayed log has materially more entries, the topic is stale and
    // worth regenerating. Missing on entries persisted before this field
    // existed - treated as 0 (regenerate aggressively).
    topicMessageCount?: number;
    lastModified: number;
    // The cwd this session runs in. Source of truth for per-session cwd; the
    // agent's `cwd` field is a denormalized mirror of the *active* session's
    // value (and the seed for the next new session). Absent on sessions
    // persisted before this field existed - callers backfill from the agent
    // cwd then (see getSessionCwd / ensureSessionCwd).
    cwd?: string;
    // The engine config this session runs under. Source of truth for
    // per-session engine + model; the agent's own agentType/modelFamily/effort/
    // permissionMode/codexSandbox fields are denormalized mirrors of the ACTIVE
    // session's values. An agent's engine is therefore a projection of whichever
    // session is live: resuming a session restores its stored engine, and a new
    // conversation can target a different one. Absent on sessions persisted
    // before per-session engine existed - callers fall back to the agent's
    // current engine then (a pre-feature agent only ever ran one engine).
    agentType?: AgentInfo["agentType"];
    modelFamily?: AgentInfo["modelFamily"];
    effort?: AgentInfo["effort"];
    permissionMode?: AgentInfo["permissionMode"];
    codexSandbox?: AgentInfo["codexSandbox"];
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

function persistSessionFirstUserMessage(
  agentId: string,
  sessionId: string,
  content: string,
) {
  const preview = sessionMessagePreview(content);
  if (!preview) return;
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId];
  if (existing?.firstUserMessage) return;
  map[sessionId] = {
    ...(existing ?? { topic: null, lastModified: 0 }),
    firstUserMessage: preview,
    lastModified: existing?.lastModified ?? Date.now(),
  };
  saveSessionsMap(agentId, map);
}

const LEGACY_SESSION_PREVIEW_BYTES = 64 * 1024;

function readLegacySessionPreview(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(LEGACY_SESSION_PREVIEW_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, bytes).split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Partial<LogEntry>;
        if (entry.kind === "user_message" && typeof entry.content === "string")
          return sessionMessagePreview(entry.content);
      } catch {}
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
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

// Persist the cwd a session runs in. Source of truth for per-session cwd; the
// agent's mirror is updated separately by the caller. Merges into the existing
// entry so topic/usage/fork fields aren't clobbered.
export function persistSessionCwd(
  agentId: string,
  sessionId: string,
  cwd: string,
) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  map[sessionId] = { ...existing, cwd, lastModified: Date.now() };
  saveSessionsMap(agentId, map);
}

// Read a session's stored cwd. Returns null when the session has no recorded
// cwd (legacy sessions persisted before per-session cwd, or sessions with no
// metadata entry at all). Callers fall back to the agent's mirror cwd.
export function getSessionCwd(
  agentId: string,
  sessionId: string,
): string | null {
  const map = loadSessionsMap(agentId);
  return map[sessionId]?.cwd ?? null;
}

// Stamp a session's cwd only if it doesn't already have one, returning the
// effective cwd. Backfills legacy sessions and records a fresh session's cwd at
// birth without overwriting an existing value. `fallbackCwd` is the agent's
// current mirror cwd. A pure backfill preserves the existing lastModified so it
// doesn't reorder the resume picker; a brand-new entry stamps lastModified now.
export function ensureSessionCwd(
  agentId: string,
  sessionId: string,
  fallbackCwd: string,
): string {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId];
  if (existing?.cwd) return existing.cwd;
  map[sessionId] = {
    ...(existing ?? { topic: null, lastModified: 0 }),
    cwd: fallbackCwd,
    lastModified: existing?.lastModified ?? Date.now(),
  };
  saveSessionsMap(agentId, map);
  return fallbackCwd;
}

// The engine config a session runs under. Mirrors the per-session cwd model:
// stored in sessions.json, with the agent's own fields as a denormalized mirror
// of the active session's values.
export type SessionEngineConfig = {
  agentType: AgentInfo["agentType"];
  modelFamily: AgentInfo["modelFamily"];
  effort: AgentInfo["effort"];
  permissionMode: AgentInfo["permissionMode"];
  codexSandbox: AgentInfo["codexSandbox"];
};

// Read a session's stored engine config. Returns null for an unknown session and
// leaves individual fields undefined for a legacy session that predates
// per-session engine - `agentType` undefined is the sentinel callers check.
export function getSessionEngineConfig(
  agentId: string,
  sessionId: string,
): Partial<SessionEngineConfig> | null {
  const map = loadSessionsMap(agentId);
  const e = map[sessionId];
  if (!e) return null;
  return {
    agentType: e.agentType,
    modelFamily: e.modelFamily,
    effort: e.effort,
    permissionMode: e.permissionMode,
    codexSandbox: e.codexSandbox,
  };
}

// Overwrite a session's stored engine config to match the agent's current
// values. Unlike ensureSessionCwd this is a deliberate overwrite, not a
// backfill: it's called at every session bootstrap (system_init), and because
// every model/effort/permission/engine change funnels through a session replace
// (and thus a fresh system_init), this keeps the active session's stored config
// in lockstep with the live agent - so a later resume restores exactly what the
// session last ran as. Does not touch lastModified, so it never reorders the
// resume picker.
export function stampSessionEngineConfig(
  agentId: string,
  sessionId: string,
  cfg: SessionEngineConfig,
) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  map[sessionId] = {
    ...existing,
    agentType: cfg.agentType,
    modelFamily: cfg.modelFamily,
    effort: cfg.effort,
    permissionMode: cfg.permissionMode,
    codexSandbox: cfg.codexSandbox,
  };
  saveSessionsMap(agentId, map);
}

// One-time backfill: stamp the agent's CURRENT engine config onto every session
// that predates per-session engine (no stored agentType). Called at agent
// load/revive, BEFORE the agent can switch engines - at that moment the agent's
// engine is exactly the engine every existing session ran under, so this tags
// legacy sessions correctly by construction. Without it a legacy session would
// stay engine-less, and after the agent later switched engines, resuming it
// wouldn't flip back: createSession would dispatch the wrong backend (e.g. open
// a Claude .jsonl as a Codex rollout) and the user could never re-enter that
// conversation. Idempotent - only touches entries missing agentType, never bumps
// lastModified.
export function backfillSessionEngineConfigs(
  agentId: string,
  cfg: SessionEngineConfig,
) {
  const map = loadSessionsMap(agentId);
  let changed = false;
  for (const sid of Object.keys(map)) {
    const e = map[sid];
    if (e.agentType) continue;
    map[sid] = {
      ...e,
      agentType: cfg.agentType,
      modelFamily: cfg.modelFamily,
      effort: cfg.effort,
      permissionMode: cfg.permissionMode,
      codexSandbox: cfg.codexSandbox,
    };
    changed = true;
  }
  if (changed) saveSessionsMap(agentId, map);
}

export function persistSessionFork(
  agentId: string,
  sessionId: string,
  forkedFrom: string,
  forkMessageId: string,
  topic: string | null,
  topicMessageCount: number,
  // The cwd the new (forked) session runs in - inherited from the active
  // session's cwd at fork time, so a fork keeps working in the same directory.
  cwd: string,
  forkBaseUsage?: PersistedUsage,
) {
  const map = loadSessionsMap(agentId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  map[sessionId] = {
    ...existing,
    topic,
    topicMessageCount,
    cwd,
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
  // activity between them - shouldn't happen, but keep the list compact).
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
  firstUserMessage: string | null;
  topicMessageCount: number;
  cwd: string | null;
  agentType: AgentInfo["agentType"] | null;
  modelFamily: AgentInfo["modelFamily"] | null;
  branched?: boolean;
  forked?: boolean;
}[] {
  try {
    const agentDir = join(LOGS_DIR, agentId);
    if (!existsSync(agentDir)) return [];
    const sessionsMap = loadSessionsMap(agentId);
    let backfilledPreview = false;

    // Collect all forkedFrom values to detect which sessions have been branched FROM
    const branchedFromIds = new Set<string>();
    for (const entry of Object.values(sessionsMap)) {
      if (entry.forkedFrom) branchedFromIds.add(entry.forkedFrom);
    }

    const sessions = readdirSync(agentDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const sid = f.replace(".jsonl", "");
        const entry = sessionsMap[sid];
        let legacyPreview: string | null = null;
        if (entry?.firstUserMessage === undefined) {
          legacyPreview = readLegacySessionPreview(join(agentDir, f));
          if (entry) {
            sessionsMap[sid] = {
              ...entry,
              firstUserMessage: legacyPreview,
            };
            backfilledPreview = true;
          }
        }
        const effectiveEntry = sessionsMap[sid];
        return {
          sessionId: sid,
          lastModified:
            effectiveEntry?.lastModified ??
            Bun.file(join(agentDir, f)).lastModified,
          topic: effectiveEntry?.topic ?? null,
          firstUserMessage:
            effectiveEntry?.firstUserMessage ?? legacyPreview ?? null,
          topicMessageCount: effectiveEntry?.topicMessageCount ?? 0,
          cwd: effectiveEntry?.cwd ?? null,
          agentType: effectiveEntry?.agentType ?? null,
          modelFamily: effectiveEntry?.modelFamily ?? null,
          ...(branchedFromIds.has(sid) ? { branched: true as const } : {}),
          ...(effectiveEntry?.forkedFrom ? { forked: true as const } : {}),
        };
      })
      .sort((a, b) => b.lastModified - a.lastModified);
    if (backfilledPreview) saveSessionsMap(agentId, sessionsMap);
    return sessions;
  } catch {
    return [];
  }
}

// List every agent id that has a log directory on disk. Killed agents stay
// here even though they're gone from agents.json, so /isomux-usage can still account
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
  // before this field was added). Fixed at spawn - see task f352984f Round 3.
  agentType?: AgentInfo["agentType"];
  // Codex-only sandbox setting.
  codexSandbox?: AgentInfo["codexSandbox"];
  lastSessionId: string | null;
  topic: string | null;
  customInstructions: string | null;
  // Identity reference for per-user env at spawn/resume time. `userId` is
  // authoritative for env lookup (via buildEnvForUserId) and identifies
  // the agent's manager - the spawning user, shown in the system prompt
  // user section. Set at spawn and immutable. `username` is the matching
  // display snapshot kept for UI/wire compatibility and audit purposes;
  // not authoritative for any behavior, can go stale across renames.
  // Both null on legacy unowned agents.
  userId?: string | null;
  username?: string | null;
  // Stable room id (matches the container Room.id). Phase 3c: persisted agents
  // are explicitly room-id keyed. Physical nesting under rooms stays the source
  // of truth, so this is optional and backfilled from the container on load -
  // there is no structural flatten to {rooms, agents} in 3c (deferred/not
  // required).
  roomId?: string;
  // Privileged-token flag (default false). Stamped into the agent's bearer
  // token at mint time so it carries its spawning user's room-scoped operator
  // capabilities. Absent on agents persisted before this field landed; read
  // sites coerce a missing value with `?? false`, so there is NO migration
  // backfill (which keeps the saveAgents→loadAgents round-trip lossless - see
  // migratePersistedAgent).
  privileged?: boolean;
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
  // NOTE: `privileged` needs no backfill here. It's an optional field and every
  // read site coerces a missing value with `?? false`, so a legacy agent (no
  // field) already behaves as not-privileged - and NOT rewriting it keeps the
  // saveAgents->loadAgents round-trip lossless.
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
  let backfilledRoomIds = 0;
  for (const room of rooms) {
    if (typeof room.id !== "string" || room.id.length === 0) {
      room.id = generateRoomId(existingIds);
      existingIds.push(room.id);
    }
    if (typeof room.prompt !== "string") room.prompt = null;
    if (typeof room.envFile === "string" && room.envFile) {
      console.log(
        `[migration] room "${room.name}" had envFile=${room.envFile} (now removed; add its variables in User Settings → Connections if you still want them applied)`,
      );
      strippedRoomEnv++;
    }
    delete room.envFile;
    for (const agent of room.agents) {
      migratePersistedAgent(agent);
      // Phase 3c: stamp the stable roomId from the container room so each
      // persisted agent is explicitly room-id keyed. Physical nesting stays the
      // source of truth: backfill when missing, and on the (defensive) mismatch
      // case prefer the container and log.
      if (typeof agent.roomId !== "string" || agent.roomId.length === 0) {
        agent.roomId = room.id;
        backfilledRoomIds++;
      } else if (agent.roomId !== room.id) {
        console.log(
          `[migration] agent ${agent.id} roomId ${agent.roomId} != container room ${room.id}; using container`,
        );
        agent.roomId = room.id;
        backfilledRoomIds++;
      }
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
  if (backfilledRoomIds > 0) {
    console.log(
      `[migration] stamped roomId on ${backfilledRoomIds} persisted agent(s) from their container room`,
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

// Agent manifest for discovery by other agents. The same manifest is served
// over HTTP as GET /agents (see server/isomux-office.ts); buildManifest is the single
// source of the entry shape so the file and the endpoint can't drift.
const MANIFEST_FILE = join(ISOMUX_DIR, "agents-summary.json");

export interface ManifestAgentInput {
  id: string;
  name: string;
  desk: number;
  room: number;
  roomName: string;
  // Stable room id - the value memory scopeIds and room-targeting routes
  // expect (the 1-based `room` number is display-only).
  roomId: string;
  topic: string | null;
  cwd: string;
  modelFamily: string;
  model: string;
  effort: EffortLevel;
  permissionMode: AgentInfo["permissionMode"];
  sandbox: AgentInfo["codexSandbox"] | null;
  username: string | null;
}

export function buildManifest(agents: ManifestAgentInput[]) {
  return agents.map((a) => ({
    id: a.id,
    name: a.name,
    desk: a.desk,
    room: a.room + 1, // 1-based for human readability
    roomName: a.roomName,
    roomId: a.roomId,
    topic: a.topic,
    cwd: a.cwd,
    modelFamily: a.modelFamily,
    model: a.model,
    effort: a.effort,
    permissionMode: a.permissionMode,
    sandbox: a.sandbox,
    username: a.username,
    logDir: join(LOGS_DIR, a.id),
  }));
}

// The killed-roster analogue, served as GET /agents?killed=1 (task 18fded2c).
// Never written to a file - a killed agent is not something a file-based reader
// polls - but it lives here so `logDir` is derived in exactly one place. The
// KilledAgentSummary fields pass through untouched; logDir is the addition that
// makes the id actionable (it is where the transcripts the log route serves are).
export function buildKilledManifest(killed: readonly KilledAgentSummary[]) {
  return killed.map((k) => ({ ...k, logDir: join(LOGS_DIR, k.id) }));
}

export function writeManifest(agents: ManifestAgentInput[]) {
  try {
    atomicWriteFileSync(
      MANIFEST_FILE,
      JSON.stringify(buildManifest(agents), null, 2),
    );
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

// Office-level settings stored in office-config.json. envFile remains only as a
// boot-migration marker for old installs.
// On first load, if the legacy office-prompt.md exists and no config file does,
// fold the .md content into the JSON and leave the .md in place as a one-time backup.
//
// The same file also carries deployment-level keys not edited via the UI
// (currently `publicOrigin`, used as a fallback for `ISOMUX_PUBLIC_ORIGIN`
// when the env var is unset - see docs/access-and-invites.md). Those keys
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
  // Only persist if the legacy prompt actually had content - otherwise a fresh
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

// A single entry in office-config.json's `enabledPlugins` array.
//
//   - Bare string ("safety-hooks") = a bundled first-party plugin, resolved
//     under `<isomuxRoot>/plugins/<id>/`.
//   - Object ({ id, path }) = an external plugin at the explicit `path`. The
//     plugin's exported `id` must match the entry's `id` (the path's basename
//     does NOT have to match - e.g., the mem0 plugin lives at a directory
//     called `isomux-mem0` but exports id "mem0").
//
// The hybrid shape keeps bundled-plugin config clean (just a string id, no
// machine-specific paths) while making external-plugin trust explicit:
// the config file enumerates every directory whose code will be imported
// into the isomux process.
export type EnabledPluginEntry = string | { id: string; path: string };

// Read `enabledPlugins` from office-config.json. Returns validated entries
// (deduped by id, first occurrence wins). Goes through readOfficeConfigRaw
// rather than loadOfficeConfig because `OfficeSettings` filters unknown keys
// - `enabledPlugins` lives alongside `prompt` / `envFile` / `name` /
// `publicOrigin` in the JSON but is not surfaced to the UI in v0 (operator
// edits the file directly).
//
// Validation:
// - Top-level must be an array; otherwise the field is dropped wholesale.
// - String entries must match `[a-z0-9_-]+`.
// - Object entries must have `id: string` matching the same regex AND
//   `path: string` that's absolute (starts with `/`) or tilde-prefixed
//   (starts with `~/`). Relative paths are rejected because they'd resolve
//   against the server cwd which is brittle.
// - Bad entries are logged to stderr and dropped - a malformed enable list
//   should not silently broaden the trust boundary.
export function loadEnabledPlugins(): EnabledPluginEntry[] {
  const raw = readOfficeConfigRaw();
  if (!("enabledPlugins" in raw)) return [];
  const candidate = raw.enabledPlugins;
  if (!Array.isArray(candidate)) {
    console.error(
      "[server-config] enabledPlugins in office-config.json is not an array; ignoring",
    );
    return [];
  }
  const idRe = /^[a-z0-9_-]+$/;
  const result: EnabledPluginEntry[] = [];
  const seenIds = new Set<string>();
  for (const v of candidate) {
    let entry: EnabledPluginEntry | null = null;
    if (typeof v === "string") {
      const id = v.trim();
      if (!idRe.test(id)) {
        console.error(
          `[server-config] enabledPlugins entry "${v}" is not a valid plugin id (need ${idRe}); ignoring`,
        );
        continue;
      }
      entry = id;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as { id?: unknown; path?: unknown };
      const rawId = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!rawId || !idRe.test(rawId)) {
        console.error(
          `[server-config] enabledPlugins object entry has invalid id (need ${idRe}); ignoring:`,
          v,
        );
        continue;
      }
      const rawPath = typeof obj.path === "string" ? obj.path.trim() : "";
      if (!rawPath) {
        console.error(
          `[server-config] enabledPlugins object entry "${rawId}" is missing path; ignoring`,
        );
        continue;
      }
      if (!rawPath.startsWith("/") && !rawPath.startsWith("~/")) {
        console.error(
          `[server-config] enabledPlugins entry "${rawId}" path "${rawPath}" is not absolute (must start with / or ~/); ignoring`,
        );
        continue;
      }
      entry = { id: rawId, path: rawPath };
    } else {
      console.error(
        "[server-config] enabledPlugins entry is neither a string nor an {id, path} object; ignoring:",
        v,
      );
      continue;
    }
    const id = typeof entry === "string" ? entry : entry.id;
    if (seenIds.has(id)) {
      console.error(
        `[server-config] enabledPlugins has duplicate id "${id}"; keeping the first occurrence`,
      );
      continue;
    }
    seenIds.add(id);
    result.push(entry);
  }
  return result;
}

// Server/deployment config that shares office-config.json but isn't part of
// the UI-mutated OfficeSettings. Currently just `publicOrigin`, used as a
// fallback when `ISOMUX_PUBLIC_ORIGIN` is unset in the environment. Server
// reads at boot only; writes are operator-authored (direct file edit, or
// future tooling that runs outside the agent safety-hook sandbox).

export interface ServerConfig {
  publicOrigin: string | null;
  // `null` means the JSON didn't carry the field at all (legacy / unset).
  // Callers decide the migration default: a present `publicOrigin` or
  // `ISOMUX_PUBLIC_ORIGIN` env var implies the operator was on a networked
  // install pre-redesign, so externalAccess should effectively be true.
  externalAccess: boolean | null;
  // Operator/deployment-authored. The server reads this field but never writes
  // it, so Access-pane saves preserve the deployment's bind choice.
  networkBind: "auto" | "loopback" | "all";
}

// Re-read the raw JSON object so save paths can do a read-modify-write that
// preserves unrelated sibling keys (e.g. `publicOrigin` when the UI saves
// prompt/envFile, or vice versa). Always returns a plain object - missing
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

// Read `publicOrigin` + `externalAccess` from office-config.json. Invalid
// values are logged and ignored. publicOrigin must validate as a public
// origin (https://<host> or http://localhost); externalAccess must be a
// boolean. Both fields surface as null when absent so the caller can apply
// migration defaults.
export function loadServerConfig(): ServerConfig {
  const raw = readOfficeConfigRaw();
  let publicOrigin: string | null = null;
  if ("publicOrigin" in raw) {
    const candidate = raw.publicOrigin;
    if (candidate === null) {
      publicOrigin = null;
    } else if (typeof candidate !== "string") {
      console.error(
        "[server-config] publicOrigin in office-config.json is not a string; ignoring",
      );
    } else {
      const normalized = normalizePublicOrigin(candidate);
      if (!normalized) {
        console.error(
          `[server-config] publicOrigin "${candidate}" in office-config.json is not a valid public origin (need https://<host> or http://localhost); ignoring`,
        );
      } else {
        publicOrigin = normalized;
      }
    }
  }
  let externalAccess: boolean | null = null;
  if ("externalAccess" in raw) {
    const candidate = raw.externalAccess;
    if (typeof candidate === "boolean") {
      externalAccess = candidate;
    } else if (candidate !== null) {
      console.error(
        "[server-config] externalAccess in office-config.json is not a boolean; ignoring",
      );
    }
  }
  let networkBind: "auto" | "loopback" | "all" = "auto";
  if ("networkBind" in raw) {
    const candidate = raw.networkBind;
    if (
      candidate === "auto" ||
      candidate === "loopback" ||
      candidate === "all"
    ) {
      networkBind = candidate;
    } else if (candidate !== null) {
      console.error(
        '[server-config] networkBind in office-config.json must be "auto", "loopback", or "all"; using auto',
      );
    }
  }
  return { publicOrigin, externalAccess, networkBind };
}

// Persist `publicOrigin` and `externalAccess` to office-config.json,
// preserving all other keys. Validates publicOrigin so callers fail loudly
// rather than write a value the server would silently drop. externalAccess
// is plain boolean storage; null means "remove the field" so loadServerConfig
// returns to the unset state.
export function saveServerConfig(
  config: Pick<ServerConfig, "publicOrigin" | "externalAccess">,
) {
  let nextOrigin: string | null;
  if (config.publicOrigin === null) {
    nextOrigin = null;
  } else {
    const normalized = normalizePublicOrigin(config.publicOrigin);
    if (!normalized) {
      throw new Error(
        `invalid publicOrigin: ${config.publicOrigin} (need https://<host> or http://localhost)`,
      );
    }
    nextOrigin = normalized;
  }
  const merged: Record<string, unknown> = {
    ...readOfficeConfigRaw(),
    publicOrigin: nextOrigin,
  };
  if (config.externalAccess === null) {
    delete merged.externalAccess;
  } else {
    merged.externalAccess = config.externalAccess;
  }
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

// Per-agent last-known snapshot. Entries are never removed.
// Consumers: /isomux-usage (attribution) and the spawn menu's revive chips
// (config rehydration). `killedAt: null` means currently-alive (or legacy
// pre-revive entry); revive-payload fields are optional for backward
// compat with the existing on-disk file.
export interface AgentHistoryEntry {
  name: string;
  lastRoomId: string;
  lastRoomName: string;
  killedAt?: number | null;
  cwd?: string;
  outfit?: AgentInfo["outfit"];
  permissionMode?: AgentInfo["permissionMode"];
  modelFamily?: string;
  effort?: EffortLevel;
  agentType?: AgentInfo["agentType"];
  codexSandbox?: AgentInfo["codexSandbox"];
  lastSessionId?: string | null;
  topic?: string | null;
  customInstructions?: string | null;
  userId?: string | null;
  username?: string | null;
  // Privileged-token flag, snapshotted so a killed agent revives with the
  // same privilege it had. Absent ⇒ false (legacy/normal agents).
  privileged?: boolean;
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
// Scheduled messages (task 8ff369b5)
// ---------------------------------------------------------------------------

const SCHEDULED_MESSAGES_FILE = join(ISOMUX_DIR, "scheduled-messages.json");

// Load the raw scheduled-messages array. Returns unknown[] - per-entry shape
// validation belongs to the scheduled-message manager (so it also applies to
// injected test persistence), not here. A corrupt file is QUARANTINED (renamed
// aside with a timestamp suffix) rather than left in place, so a later save
// can never clobber data a human might still want to inspect; the load then
// starts empty. Never throws.
export function loadScheduledMessagesRaw(): unknown[] {
  try {
    if (!existsSync(SCHEDULED_MESSAGES_FILE)) return [];
    const parsed: unknown = JSON.parse(
      readFileSync(SCHEDULED_MESSAGES_FILE, "utf-8"),
    );
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch (err) {
    console.error(
      "Corrupt scheduled-messages.json; quarantining:",
      errMessage(err),
    );
    try {
      renameSync(
        SCHEDULED_MESSAGES_FILE,
        `${SCHEDULED_MESSAGES_FILE}.corrupt-${Date.now()}`,
      );
    } catch (renameErr) {
      // Rename failed (e.g. permissions): leave the file alone. Saves may
      // still overwrite it in this degraded state, but we never write [] here
      // at load time.
      console.error(
        "Failed to quarantine scheduled-messages.json:",
        errMessage(renameErr),
      );
    }
    return [];
  }
}

// Unlike the other save* helpers, this THROWS on failure: a schedule/cancel
// request whose durable write failed must fail the HTTP request (a memory-only
// scheduled message would silently die on restart - review-pinned behavior).
export function saveScheduledMessages(entries: ScheduledMessageEntry[]) {
  atomicWriteFileSync(
    SCHEDULED_MESSAGES_FILE,
    JSON.stringify(entries, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Durable per-agent message queues (task 9870b472)
// ---------------------------------------------------------------------------

const MESSAGE_QUEUES_FILE = join(ISOMUX_DIR, "message-queues.json");

// On-disk shape: { [agentId]: { queue: QueuedMessage[], dedupe: { [cid]: expiresAtMs } } }.
// Per-record shape validation belongs to agent-manager (which also drops
// records for agents no longer on disk); this layer owns only the file
// contract. A corrupt file is QUARANTINED (renamed aside with a timestamp
// suffix) rather than left in place - same policy as scheduled-messages.
// Never throws.
export function loadMessageQueuesRaw(): Record<string, unknown> {
  try {
    if (!existsSync(MESSAGE_QUEUES_FILE)) return {};
    const parsed: unknown = JSON.parse(
      readFileSync(MESSAGE_QUEUES_FILE, "utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.error(
      "Corrupt message-queues.json; quarantining:",
      errMessage(err),
    );
    try {
      renameSync(
        MESSAGE_QUEUES_FILE,
        `${MESSAGE_QUEUES_FILE}.corrupt-${Date.now()}`,
      );
    } catch (renameErr) {
      console.error(
        "Failed to quarantine message-queues.json:",
        errMessage(renameErr),
      );
    }
    return {};
  }
}

// Side-effect-free read of the same file, for callers that must NOT quarantine.
// loadMessageQueuesRaw renames a corrupt file aside; that is right for the boot
// path and wrong for anything read-only (the storage pruner reads the durable
// queue to learn which attachments are still owed to an undelivered message -
// see server/storage-prune.ts - and a dry run must never move a user's file).
//
// EMPTY and UNKNOWN are separate results, deliberately. A caller that is about
// to DELETE files based on "nothing is queued" must not be handed the same
// answer for "the queue is genuinely empty" and "the queue file could not be
// read or parsed". An absent file is a real, valid empty (a fresh box); an
// unreadable or malformed one is `ok: false` and the caller has to decide -
// the pruner treats it as fail-closed.
export type MessageQueuesPeek =
  | { ok: true; records: Record<string, unknown> }
  | { ok: false };

export function peekMessageQueuesRaw(): MessageQueuesPeek {
  if (!existsSync(MESSAGE_QUEUES_FILE)) return { ok: true, records: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(MESSAGE_QUEUES_FILE, "utf-8"));
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, records: parsed as Record<string, unknown> };
}

// THROWS on failure. The ACCEPTANCE path (enqueueMessage) needs the throw to
// roll back and fail the request - an acked-but-unpersisted message would be
// silent loss on restart (review-pinned, mirrors saveScheduledMessages).
// Post-accept callers (drain/cancel/clear) catch and log instead: the backend
// already accepted, and stale disk merely widens at-least-once replay.
export function saveMessageQueues(store: Record<string, unknown>) {
  atomicWriteFileSync(MESSAGE_QUEUES_FILE, JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------
// File storage (unified files/ directory with SHA256 dedup)
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200MB

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
