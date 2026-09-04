// Persistence layer for cronjobs and their runs. Mirrors the agent persistence
// shape (sessions.json + per-session JSONL) under one extra layer of nesting:
//
//   ~/.isomux/cronjobs/
//     cronjobs.json                    Cronjob[] config
//     cronjob-history.json             { id -> { lastName } } for deleted-cronjob name preservation
//     <jobId>/
//       runs.json                      CronjobRun[] index
//       <runId>/
//         sessions.json                fork lineage + per-session usage (same shape as agent)
//         <sessionId>.jsonl            append-only log
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  appendFileSync,
  readdirSync,
} from "fs";
import type { Cronjob, CronjobRun, LogEntry } from "../shared/types.ts";
import { atomicWriteFileSync, type PersistedUsage } from "./persistence.ts";

const ISOMUX_DIR = STATE_ROOT;
const CRONJOBS_DIR = join(ISOMUX_DIR, "cronjobs");
const CRONJOBS_FILE = join(CRONJOBS_DIR, "cronjobs.json");
const CRONJOB_HISTORY_FILE = join(CRONJOBS_DIR, "cronjob-history.json");
const CRONJOBS_PROMPT_FILE = join(CRONJOBS_DIR, "cronjobs-prompt.md");

// Importing this module is side-effect-free: CRONJOBS_DIR is created lazily by
// atomicWriteFileSync (top-level cronjob files) and by the per-job / per-run
// mkdir calls below, rather than at module load.

// Cronjobs system prompt - owned by cronjob-manager and stored in its own
// file, not folded into office-config.json. Two managers writing the same
// JSON with stale in-memory copies would silently clobber each other (one
// of the v1 review blockers).
export function loadCronjobsPrompt(): string | null {
  try {
    if (!existsSync(CRONJOBS_PROMPT_FILE)) return null;
    const content = readFileSync(CRONJOBS_PROMPT_FILE, "utf-8");
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

export function saveCronjobsPrompt(value: string | null) {
  try {
    atomicWriteFileSync(CRONJOBS_PROMPT_FILE, value ?? "");
  } catch (err) {
    console.error("Failed to save cronjobs prompt:", err);
  }
}

// One-shot migration on startup: if cronjobs-prompt.md doesn't exist yet,
// look for a legacy `cronjobsPrompt` field in office-config.json (added
// during v1 development) and copy it over. Idempotent across restarts.
export function migrateCronjobsPromptFromOfficeConfig() {
  if (existsSync(CRONJOBS_PROMPT_FILE)) return;
  try {
    const officePath = join(ISOMUX_DIR, "office-config.json");
    if (!existsSync(officePath)) return;
    const parsed = JSON.parse(readFileSync(officePath, "utf-8"));
    if (
      typeof parsed.cronjobsPrompt === "string" &&
      parsed.cronjobsPrompt.trim()
    ) {
      atomicWriteFileSync(CRONJOBS_PROMPT_FILE, parsed.cronjobsPrompt);
    }
  } catch {}
}

export function loadCronjobs(): Cronjob[] {
  try {
    if (!existsSync(CRONJOBS_FILE)) return [];
    const records = JSON.parse(readFileSync(CRONJOBS_FILE, "utf-8")) as Array<
      Cronjob & { device?: string | null; agentType?: Cronjob["agentType"] }
    >;
    // Migrate legacy `device` field → `username` (the field's actual semantics
    // has always been "the boss's name").
    let migrated = 0;
    for (const r of records) {
      if (r.device !== undefined && r.username === undefined) {
        r.username = r.device ?? null;
        migrated++;
      }
      delete (r as { device?: unknown }).device;
      // Default agentType for records written before Codex cron support.
      // Read-time only - saveCronjobs will fold it in on the next write.
      if (r.agentType === undefined) r.agentType = "claude";
      // Migrate "auto" permissionMode to "bypassPermissions". Pre-port cron
      // passed permissionMode straight to the SDK without a canUseTool
      // callback, so the SDK's internal "auto" classifier resolved the
      // approvals. Post-port, ClaudeSession always installs canUseTool and
      // cron has no resolver - an "auto" classifier mismatch would hang the
      // run until the 30-min hard timeout. bypassPermissions is the safest
      // unattended fallback.
      if ((r as { permissionMode?: string }).permissionMode === "auto") {
        (r as { permissionMode?: string }).permissionMode = "bypassPermissions";
      }
    }
    if (migrated > 0) {
      console.log(
        `[migration] migrated ${migrated} cronjob(s) from device → username`,
      );
    }
    return records;
  } catch (err) {
    console.error("Failed to load cronjobs:", err);
    return [];
  }
}

export function saveCronjobs(cronjobs: Cronjob[]) {
  try {
    atomicWriteFileSync(CRONJOBS_FILE, JSON.stringify(cronjobs, null, 2));
  } catch (err) {
    console.error("Failed to save cronjobs:", err);
  }
}

export type CronjobHistory = Record<string, { lastName: string }>;

export function loadCronjobHistory(): CronjobHistory {
  try {
    if (!existsSync(CRONJOB_HISTORY_FILE)) return {};
    return JSON.parse(
      readFileSync(CRONJOB_HISTORY_FILE, "utf-8"),
    ) as CronjobHistory;
  } catch {
    return {};
  }
}

export function saveCronjobHistory(history: CronjobHistory) {
  try {
    atomicWriteFileSync(CRONJOB_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Failed to save cronjob history:", err);
  }
}

function jobDir(jobId: string): string {
  return join(CRONJOBS_DIR, jobId);
}

function runsFile(jobId: string): string {
  return join(jobDir(jobId), "runs.json");
}

function runDir(jobId: string, runId: string): string {
  return join(jobDir(jobId), runId);
}

function sessionsMapFile(jobId: string, runId: string): string {
  return join(runDir(jobId, runId), "sessions.json");
}

function sessionLogFile(
  jobId: string,
  runId: string,
  sessionId: string,
): string {
  return join(runDir(jobId, runId), `${sessionId}.jsonl`);
}

export function loadRuns(jobId: string): CronjobRun[] {
  try {
    const file = runsFile(jobId);
    if (!existsSync(file)) return [];
    const runs = JSON.parse(readFileSync(file, "utf-8")) as Array<
      CronjobRun & { agentTypeSnapshot?: CronjobRun["agentTypeSnapshot"] }
    >;
    for (const r of runs) {
      // Default agentTypeSnapshot for rows written before Codex cron support.
      if (r.agentTypeSnapshot === undefined) r.agentTypeSnapshot = "claude";
      // Same "auto" → "bypassPermissions" migration as cronjobs.json. Snapshot
      // values only describe what *was* run, so coercing them doesn't change
      // historical truth - but it prevents resume/edit from re-using "auto"
      // for a new turn on the same run row.
      if (
        (r as { permissionModeSnapshot?: string }).permissionModeSnapshot ===
        "auto"
      ) {
        (r as { permissionModeSnapshot?: string }).permissionModeSnapshot =
          "bypassPermissions";
      }
    }
    return runs;
  } catch (err) {
    console.error(`Failed to load runs for ${jobId}:`, err);
    return [];
  }
}

export function saveRuns(jobId: string, runs: CronjobRun[]) {
  try {
    mkdirSync(jobDir(jobId), { recursive: true });
    atomicWriteFileSync(runsFile(jobId), JSON.stringify(runs, null, 2));
  } catch (err) {
    console.error(`Failed to save runs for ${jobId}:`, err);
  }
}

// Append a single run (writes the whole file - mirrors saveTasks pattern).
export function appendRun(jobId: string, run: CronjobRun) {
  const runs = loadRuns(jobId);
  runs.push(run);
  saveRuns(jobId, runs);
}

export function updateRun(
  jobId: string,
  runId: string,
  patch: Partial<CronjobRun>,
): CronjobRun | null {
  const runs = loadRuns(jobId);
  const idx = runs.findIndex((r) => r.id === runId);
  if (idx < 0) return null;
  runs[idx] = { ...runs[idx], ...patch };
  saveRuns(jobId, runs);
  return runs[idx];
}

export function findRun(jobId: string, runId: string): CronjobRun | null {
  return loadRuns(jobId).find((r) => r.id === runId) ?? null;
}

// List every cronjobId that has a directory on disk, even if its config is
// gone. Used by /isomux-usage and reconciliation. Filtered to 8-char hex (the
// generateHexId format) so stray dirs (editor swap files, future siblings
// like `tmp/`) aren't mistaken for cronjob ids.
const HEX8 = /^[a-f0-9]{8}$/;
export function listAllCronjobIdsOnDisk(): string[] {
  try {
    if (!existsSync(CRONJOBS_DIR)) return [];
    return readdirSync(CRONJOBS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && HEX8.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

type UsageSnapshot = { entryId: string; usage: PersistedUsage };
type RunSessionsMap = Record<
  string,
  {
    topic: string | null;
    lastModified: number;
    forkedFrom?: string;
    forkMessageId?: string;
    usage?: PersistedUsage;
    priorRunsUsage?: PersistedUsage;
    forkBaseUsage?: PersistedUsage;
    usageSnapshots?: UsageSnapshot[];
  }
>;

export function loadRunSessionsMap(
  jobId: string,
  runId: string,
): RunSessionsMap {
  try {
    const file = sessionsMapFile(jobId, runId);
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf-8")) as RunSessionsMap;
  } catch {
    return {};
  }
}

function saveRunSessionsMap(jobId: string, runId: string, map: RunSessionsMap) {
  try {
    mkdirSync(runDir(jobId, runId), { recursive: true });
    atomicWriteFileSync(
      sessionsMapFile(jobId, runId),
      JSON.stringify(map, null, 2),
    );
  } catch (err) {
    console.error(`Failed to save run sessions map ${jobId}/${runId}:`, err);
  }
}

// Mirror of persistSessionFork (agent side) for cronjob runs. Records that
// `sessionId` was forked from `forkedFrom` at log entry `forkMessageId`, so
// loadRunLogWithAncestors can walk back through the chain when rendering.
export function persistRunSessionFork(
  jobId: string,
  runId: string,
  sessionId: string,
  forkedFrom: string,
  forkMessageId: string,
  forkBaseUsage?: PersistedUsage,
) {
  const map = loadRunSessionsMap(jobId, runId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  map[sessionId] = {
    ...existing,
    topic: existing.topic ?? null,
    lastModified: Date.now(),
    forkedFrom,
    forkMessageId,
    ...(forkBaseUsage ? { forkBaseUsage } : {}),
  };
  saveRunSessionsMap(jobId, runId, map);
}

// Mirror of findUsageAtFork (agent side) for cronjob runs. Walks the parent's
// JSONL to locate `forkMessageId`, then returns the latest usage snapshot
// before that position. Falls back to current cumulative when no snapshot
// pre-dates the fork.
export function findUsageAtForkRun(
  jobId: string,
  runId: string,
  parentSessionId: string,
  forkMessageId: string,
): PersistedUsage | undefined {
  const entries = loadRunLog(jobId, runId, parentSessionId);
  const positions = new Map<string, number>();
  entries.forEach((e, i) => positions.set(e.id, i));
  const forkPos = positions.get(forkMessageId);
  if (forkPos === undefined) return undefined;
  const parentMeta = loadRunSessionsMap(jobId, runId)[parentSessionId];
  const snapshots = parentMeta?.usageSnapshots ?? [];
  let best: PersistedUsage | undefined;
  let bestPos = -1;
  for (const snap of snapshots) {
    const p = positions.get(snap.entryId);
    if (p === undefined) continue;
    if (p < forkPos && p > bestPos) {
      bestPos = p;
      best = snap.usage;
    }
  }
  if (best) return best;
  const u = parentMeta?.usage;
  const p = parentMeta?.priorRunsUsage;
  if (!u && !p) return undefined;
  return {
    inputTokens: (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0),
    outputTokens: (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0),
    cacheReadInputTokens:
      (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0),
    costUSD: (u?.costUSD ?? 0) + (p?.costUSD ?? 0),
  };
}

// Mirror of rollSessionUsageOnResume (agent side). The SDK reports cost
// cumulative-per-process, so a resumed session's counter starts from zero.
// Roll the current-run usage into the prior-runs accumulator before the
// resume call so lifetime cost survives the reset.
export function rollRunSessionUsageOnResume(
  jobId: string,
  runId: string,
  sessionId: string,
) {
  const map = loadRunSessionsMap(jobId, runId);
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
  saveRunSessionsMap(jobId, runId, map);
}

export function accumulateRunSessionUsage(
  jobId: string,
  runId: string,
  sessionId: string,
  turnTokens: Omit<PersistedUsage, "costUSD">,
  runCostUSD: number,
): PersistedUsage {
  const map = loadRunSessionsMap(jobId, runId);
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
  saveRunSessionsMap(jobId, runId, map);
  return next;
}

export function appendRunSessionUsageSnapshot(
  jobId: string,
  runId: string,
  sessionId: string,
  entryId: string,
  usage: PersistedUsage,
) {
  const map = loadRunSessionsMap(jobId, runId);
  const existing = map[sessionId] ?? { topic: null, lastModified: 0 };
  const snapshots = existing.usageSnapshots ?? [];
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
  saveRunSessionsMap(jobId, runId, map);
}

export function appendRunLog(
  jobId: string,
  runId: string,
  sessionId: string,
  entry: LogEntry,
) {
  try {
    mkdirSync(runDir(jobId, runId), { recursive: true });
    appendFileSync(
      sessionLogFile(jobId, runId, sessionId),
      JSON.stringify(entry) + "\n",
    );
  } catch (err) {
    console.error(
      `Failed to write run log ${jobId}/${runId}/${sessionId}:`,
      err,
    );
  }
}

export function loadRunLog(
  jobId: string,
  runId: string,
  sessionId: string,
): LogEntry[] {
  try {
    const file = sessionLogFile(jobId, runId, sessionId);
    if (!existsSync(file)) return [];
    const content = readFileSync(file, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as LogEntry);
  } catch (err) {
    console.error(
      `Failed to load run log ${jobId}/${runId}/${sessionId}:`,
      err,
    );
    return [];
  }
}

// Walk the fork chain and concatenate ancestor log entries the same way
// loadLogWithAncestors does for agents. For v1 cronjobs, runs typically have a
// single root session, but the structure supports forks via the same mechanism.
export function loadRunLogWithAncestors(
  jobId: string,
  runId: string,
  sessionId: string,
): LogEntry[] {
  const sessionsMap = loadRunSessionsMap(jobId, runId);
  const chain: { sessionId: string; forkMessageId?: string }[] = [];
  let current: string | undefined = sessionId;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const meta: RunSessionsMap[string] | undefined = sessionsMap[current];
    chain.unshift({ sessionId: current, forkMessageId: meta?.forkMessageId });
    current = meta?.forkedFrom;
  }
  const result: LogEntry[] = [];
  for (let i = 0; i < chain.length; i++) {
    const entries = loadRunLog(jobId, runId, chain[i].sessionId);
    if (i < chain.length - 1) {
      const cutoffId = chain[i + 1].forkMessageId;
      for (const entry of entries) {
        if (entry.id === cutoffId) break;
        result.push(entry);
      }
    } else {
      result.push(...entries);
    }
  }
  return result;
}
