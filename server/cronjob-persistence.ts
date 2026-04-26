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
import { homedir } from "os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "fs";
import type { Cronjob, CronjobRun, LogEntry } from "../shared/types.ts";
import type { PersistedUsage } from "./persistence.ts";

const ISOMUX_DIR = join(homedir(), ".isomux");
const CRONJOBS_DIR = join(ISOMUX_DIR, "cronjobs");
const CRONJOBS_FILE = join(CRONJOBS_DIR, "cronjobs.json");
const CRONJOB_HISTORY_FILE = join(CRONJOBS_DIR, "cronjob-history.json");

try { mkdirSync(CRONJOBS_DIR, { recursive: true }); } catch {}

// ---------------------------------------------------------------------------
// Cronjob configs
// ---------------------------------------------------------------------------

export function loadCronjobs(): Cronjob[] {
  try {
    if (!existsSync(CRONJOBS_FILE)) return [];
    return JSON.parse(readFileSync(CRONJOBS_FILE, "utf-8")) as Cronjob[];
  } catch (err) {
    console.error("Failed to load cronjobs:", err);
    return [];
  }
}

export function saveCronjobs(cronjobs: Cronjob[]) {
  try {
    writeFileSync(CRONJOBS_FILE, JSON.stringify(cronjobs, null, 2));
  } catch (err) {
    console.error("Failed to save cronjobs:", err);
  }
}

export type CronjobHistory = Record<string, { lastName: string }>;

export function loadCronjobHistory(): CronjobHistory {
  try {
    if (!existsSync(CRONJOB_HISTORY_FILE)) return {};
    return JSON.parse(readFileSync(CRONJOB_HISTORY_FILE, "utf-8")) as CronjobHistory;
  } catch {
    return {};
  }
}

export function saveCronjobHistory(history: CronjobHistory) {
  try {
    writeFileSync(CRONJOB_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Failed to save cronjob history:", err);
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

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

function sessionLogFile(jobId: string, runId: string, sessionId: string): string {
  return join(runDir(jobId, runId), `${sessionId}.jsonl`);
}

export function loadRuns(jobId: string): CronjobRun[] {
  try {
    const file = runsFile(jobId);
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf-8")) as CronjobRun[];
  } catch (err) {
    console.error(`Failed to load runs for ${jobId}:`, err);
    return [];
  }
}

export function saveRuns(jobId: string, runs: CronjobRun[]) {
  try {
    mkdirSync(jobDir(jobId), { recursive: true });
    writeFileSync(runsFile(jobId), JSON.stringify(runs, null, 2));
  } catch (err) {
    console.error(`Failed to save runs for ${jobId}:`, err);
  }
}

// Append a single run (writes the whole file — mirrors saveTasks pattern).
export function appendRun(jobId: string, run: CronjobRun) {
  const runs = loadRuns(jobId);
  runs.push(run);
  saveRuns(jobId, runs);
}

export function updateRun(jobId: string, runId: string, patch: Partial<CronjobRun>): CronjobRun | null {
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
// gone. Used by /usage and reconciliation.
export function listAllCronjobIdsOnDisk(): string[] {
  try {
    if (!existsSync(CRONJOBS_DIR)) return [];
    return readdirSync(CRONJOBS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-run sessions.json (same shape as agent sessions map)
// ---------------------------------------------------------------------------

type UsageSnapshot = { entryId: string; usage: PersistedUsage };
type RunSessionsMap = Record<string, {
  topic: string | null;
  lastModified: number;
  forkedFrom?: string;
  forkMessageId?: string;
  usage?: PersistedUsage;
  priorRunsUsage?: PersistedUsage;
  forkBaseUsage?: PersistedUsage;
  usageSnapshots?: UsageSnapshot[];
}>;

export function loadRunSessionsMap(jobId: string, runId: string): RunSessionsMap {
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
    writeFileSync(sessionsMapFile(jobId, runId), JSON.stringify(map, null, 2));
  } catch (err) {
    console.error(`Failed to save run sessions map ${jobId}/${runId}:`, err);
  }
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
    cacheReadInputTokens: (prev?.cacheReadInputTokens ?? 0) + turnTokens.cacheReadInputTokens,
    cacheCreationInputTokens: (prev?.cacheCreationInputTokens ?? 0) + turnTokens.cacheCreationInputTokens,
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
  map[sessionId] = { ...existing, usageSnapshots: snapshots, lastModified: Date.now() };
  saveRunSessionsMap(jobId, runId, map);
}

// ---------------------------------------------------------------------------
// Per-run JSONL append + load
// ---------------------------------------------------------------------------

export function appendRunLog(jobId: string, runId: string, sessionId: string, entry: LogEntry) {
  try {
    mkdirSync(runDir(jobId, runId), { recursive: true });
    appendFileSync(sessionLogFile(jobId, runId, sessionId), JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`Failed to write run log ${jobId}/${runId}/${sessionId}:`, err);
  }
}

export function loadRunLog(jobId: string, runId: string, sessionId: string): LogEntry[] {
  try {
    const file = sessionLogFile(jobId, runId, sessionId);
    if (!existsSync(file)) return [];
    const content = readFileSync(file, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as LogEntry);
  } catch (err) {
    console.error(`Failed to load run log ${jobId}/${runId}/${sessionId}:`, err);
    return [];
  }
}

// Walk the fork chain and concatenate ancestor log entries the same way
// loadLogWithAncestors does for agents. For v1 cronjobs, runs typically have a
// single root session, but the structure supports forks via the same mechanism.
export function loadRunLogWithAncestors(jobId: string, runId: string, sessionId: string): LogEntry[] {
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
