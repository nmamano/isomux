// Cronjob scheduler + per-run SDK session lifecycle.
//
// Scheduler tick: every 60s, looks at every enabled cronjob and fires those
// whose nextFireAt has passed. Overlap rule: if a *scheduled* run is still
// in flight for the same cronjob, write a "skipped" row instead of firing.
// Manual "Run now" bypasses the overlap rule.
//
// Each fire creates a fresh V2 SDK session, sends the cronjob's prompt as the
// first user message, streams the SDK output to a per-run JSONL log, and
// broadcasts log entries to the UI via the existing event bus. The synthetic
// "stream id" used for log routing is `cronjobRunStreamId(runId)`.

import {
  unstable_v2_createSession,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  FAMILY_TO_MODEL,
  generateCronjobId,
  generateCronjobRunId,
  cronjobRunStreamId,
  humanizeSchedule,
  type Cronjob,
  type CronjobRun,
  type CronjobPermissionMode,
  type LogEntry,
  type Schedule,
} from "../shared/types.ts";
import { CLAUDE_NATIVE_BIN, validateCwd, resolveCwd } from "./cwd-utils.ts";
import { createSafetyHooks } from "./safety-hooks.ts";
import { loadOfficeConfig, saveOfficeConfig, type PersistedUsage } from "./persistence.ts";
import {
  loadCronjobs,
  saveCronjobs,
  loadCronjobHistory,
  saveCronjobHistory,
  loadRuns,
  saveRuns,
  appendRun,
  updateRun,
  findRun,
  appendRunLog,
  loadRunLogWithAncestors,
  loadRunSessionsMap,
  accumulateRunSessionUsage,
  appendRunSessionUsageSnapshot,
  listAllCronjobIdsOnDisk,
} from "./cronjob-persistence.ts";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface ActiveRun {
  jobId: string;
  runId: string;
  streamId: string;
  session: ReturnType<typeof unstable_v2_createSession>;
  sessionId: string | null;       // assigned on first system:init
  rootSessionId: string;          // the run row's rootSessionId (placeholder until init)
  consumerPromise: Promise<void>;
  hardTimeoutTimer: ReturnType<typeof setTimeout> | null;
  lastWrittenEntryId: string | null;
  lastAssistantText: string;      // for previewText computation
  trigger: CronjobRun["trigger"];
  killed: boolean;
}

const activeRuns = new Map<string, ActiveRun>(); // runId -> ActiveRun

let cronjobs: Cronjob[] = [];
let cronjobsPrompt: string | null = null;

const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const TICK_INTERVAL_MS = 60 * 1000;
const MIN_INTERVAL_MINUTES = 5;

// ---------------------------------------------------------------------------
// Event bus (server/index.ts wires this to the WebSocket broadcast)
// ---------------------------------------------------------------------------

export type CronjobEvent =
  | { type: "cronjob_added"; cronjob: Cronjob }
  | { type: "cronjob_updated"; cronjob: Cronjob }
  | { type: "cronjob_deleted"; id: string }
  | { type: "cronjobs_prompt_updated"; value: string | null }
  | { type: "cronjob_run_updated"; run: CronjobRun }
  | { type: "log_entry"; entry: LogEntry };

let eventHandler: (e: CronjobEvent) => void = () => {};

export function onCronjobEvent(handler: (e: CronjobEvent) => void) {
  eventHandler = handler;
}

// ---------------------------------------------------------------------------
// Schedule math
// ---------------------------------------------------------------------------

export function computeNextFire(schedule: Schedule, anchor: number, now: number = Date.now()): number {
  if (schedule.type === "interval") {
    const intervalMs = Math.max(MIN_INTERVAL_MINUTES, schedule.minutes) * 60_000;
    if (now <= anchor) return anchor + intervalMs;
    const elapsed = now - anchor;
    const periods = Math.ceil(elapsed / intervalMs);
    return anchor + periods * intervalMs;
  }
  if (schedule.type === "daily") {
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  // weekly
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  const currentDay = next.getDay();
  let daysAhead = (schedule.weekday - currentDay + 7) % 7;
  if (daysAhead === 0 && next.getTime() <= now) daysAhead = 7;
  next.setDate(next.getDate() + daysAhead);
  return next.getTime();
}

function clampSchedule(schedule: Schedule): Schedule {
  if (schedule.type === "interval") {
    return { type: "interval", minutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(schedule.minutes)) };
  }
  if (schedule.type === "daily") {
    return {
      type: "daily",
      hour: Math.min(23, Math.max(0, Math.floor(schedule.hour))),
      minute: Math.min(59, Math.max(0, Math.floor(schedule.minute))),
    };
  }
  return {
    type: "weekly",
    weekday: (Math.min(6, Math.max(0, Math.floor(schedule.weekday))) as 0 | 1 | 2 | 3 | 4 | 5 | 6),
    hour: Math.min(23, Math.max(0, Math.floor(schedule.hour))),
    minute: Math.min(59, Math.max(0, Math.floor(schedule.minute))),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listCronjobs(): Cronjob[] {
  return cronjobs;
}

export function getCronjobsPrompt(): string | null {
  return cronjobsPrompt;
}

export function setCronjobsPrompt(value: string | null) {
  const normalized = value && value.trim() ? value.trim() : null;
  cronjobsPrompt = normalized;
  const cfg = loadOfficeConfig();
  cfg.cronjobsPrompt = normalized;
  saveOfficeConfig(cfg);
  eventHandler({ type: "cronjobs_prompt_updated", value: normalized });
}

export interface AddCronjobInput {
  name: string;
  schedule: Schedule;
  prompt: string;
  cwd: string;
  modelFamily: Cronjob["modelFamily"];
  effort: Cronjob["effort"];
  permissionMode: CronjobPermissionMode;
  username: string;
  device?: string;
}

export function addCronjob(input: AddCronjobInput): Cronjob {
  const schedule = clampSchedule(input.schedule);
  const now = Date.now();
  const cronjob: Cronjob = {
    id: generateCronjobId(cronjobs.map((c) => c.id)),
    name: input.name.trim() || "Untitled cronjob",
    schedule,
    prompt: input.prompt,
    cwd: resolveCwd(input.cwd),
    modelFamily: input.modelFamily,
    effort: input.effort,
    permissionMode: input.permissionMode,
    enabled: true,
    createdBy: input.username,
    device: input.device ?? null,
    createdAt: now,
    lastFireAt: null,
    nextFireAt: computeNextFire(schedule, now, now),
  };
  cronjobs.push(cronjob);
  saveCronjobs(cronjobs);
  // Update history with the latest name so /usage attribution survives delete.
  const history = loadCronjobHistory();
  history[cronjob.id] = { lastName: cronjob.name };
  saveCronjobHistory(history);
  eventHandler({ type: "cronjob_added", cronjob });
  return cronjob;
}

export function updateCronjob(
  id: string,
  changes: Partial<Pick<Cronjob, "name" | "schedule" | "prompt" | "cwd" | "modelFamily" | "effort" | "permissionMode" | "enabled">>,
): Cronjob | null {
  const idx = cronjobs.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const prev = cronjobs[idx];
  const next: Cronjob = { ...prev };
  if (changes.name !== undefined) next.name = changes.name.trim() || prev.name;
  if (changes.prompt !== undefined) next.prompt = changes.prompt;
  if (changes.cwd !== undefined) next.cwd = resolveCwd(changes.cwd);
  if (changes.modelFamily !== undefined) next.modelFamily = changes.modelFamily;
  if (changes.effort !== undefined) next.effort = changes.effort;
  if (changes.permissionMode !== undefined) next.permissionMode = changes.permissionMode;
  if (changes.enabled !== undefined) next.enabled = changes.enabled;
  if (changes.schedule !== undefined) {
    next.schedule = clampSchedule(changes.schedule);
    next.nextFireAt = computeNextFire(next.schedule, next.createdAt, Date.now());
  }
  cronjobs[idx] = next;
  saveCronjobs(cronjobs);
  const history = loadCronjobHistory();
  history[next.id] = { lastName: next.name };
  saveCronjobHistory(history);
  eventHandler({ type: "cronjob_updated", cronjob: next });
  return next;
}

export function deleteCronjob(id: string): boolean {
  const idx = cronjobs.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  const removed = cronjobs[idx];
  cronjobs.splice(idx, 1);
  saveCronjobs(cronjobs);
  // Preserve last name for usage report.
  const history = loadCronjobHistory();
  history[removed.id] = { lastName: removed.name };
  saveCronjobHistory(history);
  eventHandler({ type: "cronjob_deleted", id });
  return true;
}

export function getRunsForCronjob(jobId: string): CronjobRun[] {
  return loadRuns(jobId);
}

// Returns one entry per cronjob id that has a runs.json on disk — including
// jobs whose configs have since been deleted. The Runs tab uses this so
// historical runs from deleted cronjobs remain visible.
export function getAllRunsByJob(): { jobId: string; runs: CronjobRun[] }[] {
  return listAllCronjobIdsOnDisk().map((jobId) => ({ jobId, runs: loadRuns(jobId) }));
}

export function getRunTranscript(jobId: string, runId: string): { run: CronjobRun | null; entries: LogEntry[] } {
  const run = findRun(jobId, runId);
  if (!run) return { run: null, entries: [] };
  // Transcript is the latest session in the fork chain. For v1 we use the
  // root session id; resume/fork support will introduce a "current" session.
  const entries = loadRunLogWithAncestors(jobId, runId, run.rootSessionId);
  return { run, entries };
}

// ---------------------------------------------------------------------------
// System prompt for cronjobs
// ---------------------------------------------------------------------------

function buildCronjobSystemPrompt(cronjob: Cronjob, jobId: string, _runId: string): string {
  const officeConfig = loadOfficeConfig();
  // humanizeSchedule produces sentence-case ("Daily at 09:00"); lowercase the
  // first letter so it reads as a sentence fragment ("You run daily at 09:00").
  // Only the first letter — keeps weekday abbreviations like "Mon" capitalized.
  const human = humanizeSchedule(cronjob.schedule);
  const scheduleDescription = human.charAt(0).toLowerCase() + human.slice(1);

  let prompt = `You are "${cronjob.name}", a scheduled cronjob in the Isomux office. You run ${scheduleDescription}.

The Isomux office consists of agents that have persistent identity and sit at desks in various rooms of the office. You don't have a desk or persistent identity — each scheduled run starts fresh. There is no human in the loop during your run; any result must be self-contained, since someone may review it later.

How to discover other office agents and their conversation logs: read ~/.isomux/agents-summary.json.

How to use the task board (localhost:4000/tasks): only touch it if your prompt directs you to. When you do:
  curl -s localhost:4000/tasks                                          # list open tasks
  curl -s localhost:4000/tasks?status=all                               # include done
  curl -s -X POST localhost:4000/tasks -H 'Content-Type: application/json' \\
    -d '{"title":"...","createdBy":"${cronjob.name}"}'                  # create
  curl -s -X POST localhost:4000/tasks/ID/done -d '{}'                  # mark done

How to show an image: read the image file with the Read tool — it renders inline in the conversation.

How to read prior runs of this cronjob: ~/.isomux/cronjobs/${jobId}/runs.json lists every run (newest last) with startedAt, status, and rootSessionId. The transcript for a run lives at ~/.isomux/cronjobs/${jobId}/<runId>/<rootSessionId>.jsonl.

How to answer questions about Isomux itself: the source lives at https://github.com/nmamano/isomux.`;

  if (officeConfig.prompt) prompt += `\n\n## Office Instructions\n\n${officeConfig.prompt}`;
  if (cronjobsPrompt) prompt += `\n\n## Cronjobs Instructions\n\n${cronjobsPrompt}`;
  return prompt;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function emitLogEntry(streamId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>): LogEntry {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: streamId,
    timestamp: Date.now(),
    kind,
    content,
    ...(metadata ? { metadata } : {}),
  };
  eventHandler({ type: "log_entry", entry });
  return entry;
}

function processCronjobMessage(active: ActiveRun, msg: SDKMessage) {
  switch (msg.type) {
    case "system": {
      const subtype = (msg as any).subtype;
      if (subtype === "init") {
        const sessionId = (msg as any).session_id as string | undefined;
        if (sessionId && !active.sessionId) {
          active.sessionId = sessionId;
          // If the SDK assigned a different id than rootSessionId, update the
          // run row so the transcript loads correctly.
          if (sessionId !== active.rootSessionId) {
            const updated = updateRun(active.jobId, active.runId, { rootSessionId: sessionId });
            if (updated) {
              active.rootSessionId = sessionId;
              eventHandler({ type: "cronjob_run_updated", run: updated });
            }
          }
        }
      }
      break;
    }
    case "assistant": {
      const content = (msg as any).message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          active.lastAssistantText = block.text;
          writeLog(active, "text", block.text);
        } else if (block.type === "tool_use") {
          writeLog(active, "tool_call", block.name, { toolId: block.id, input: block.input });
        } else if (block.type === "thinking" && block.thinking) {
          writeLog(active, "thinking", block.thinking);
        }
      }
      break;
    }
    case "user": {
      const content = (msg as any).message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : JSON.stringify(block.content);
          writeLog(active, "tool_result", resultText.slice(0, 10000), { toolUseId: block.tool_use_id });
        }
      }
      break;
    }
    case "result": {
      const subtype = (msg as any).subtype;
      const usageField = (msg as any).usage;
      if (active.sessionId && usageField) {
        const cost = (msg as any).total_cost_usd ?? 0;
        const cumulative = accumulateRunSessionUsage(
          active.jobId,
          active.runId,
          active.sessionId,
          {
            inputTokens: usageField.input_tokens ?? 0,
            outputTokens: usageField.output_tokens ?? 0,
            cacheReadInputTokens: usageField.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usageField.cache_creation_input_tokens ?? 0,
          },
          cost,
        );
        if (active.lastWrittenEntryId) {
          appendRunSessionUsageSnapshot(active.jobId, active.runId, active.sessionId, active.lastWrittenEntryId, cumulative);
        }
      }
      if (subtype !== "success") {
        const errors = (msg as any).errors;
        const errorText = `Run stopped: ${subtype}. ${errors?.join(", ") || ""}`;
        writeLog(active, "error", errorText);
      }
      break;
    }
  }
}

function writeLog(active: ActiveRun, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>) {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: active.streamId,
    timestamp: Date.now(),
    kind,
    content,
    ...(metadata ? { metadata } : {}),
  };
  if (active.sessionId) {
    appendRunLog(active.jobId, active.runId, active.sessionId, entry);
    active.lastWrittenEntryId = entry.id;
  }
  eventHandler({ type: "log_entry", entry });
}

async function runConsumer(active: ActiveRun) {
  try {
    for await (const msg of active.session.stream()) {
      processCronjobMessage(active, msg);
    }
    // Stream ended cleanly — terminal `result` arrived.
    finalizeRun(active, "completed");
  } catch (err: any) {
    if (active.killed) return; // hard timeout already handled
    console.error(`Cronjob run ${active.runId} stream error:`, err.message);
    writeLog(active, "error", `Stream error: ${err.message}`);
    finalizeRun(active, "failed", `Stream error: ${err.message}`);
  }
}

function finalizeRun(active: ActiveRun, status: CronjobRun["status"], errorReason: string | null = null) {
  if (active.hardTimeoutTimer) {
    clearTimeout(active.hardTimeoutTimer);
    active.hardTimeoutTimer = null;
  }
  activeRuns.delete(active.runId);
  const previewText = (active.lastAssistantText || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const updated = updateRun(active.jobId, active.runId, {
    status,
    endedAt: Date.now(),
    errorReason: errorReason ?? null,
    previewText,
  });
  if (updated) eventHandler({ type: "cronjob_run_updated", run: updated });
  // Recompute next fire for the job after a successful or failed scheduled run.
  if (active.trigger === "scheduled") {
    const job = cronjobs.find((c) => c.id === active.jobId);
    if (job) {
      job.lastFireAt = active.session ? Date.now() : job.lastFireAt;
      job.nextFireAt = computeNextFire(job.schedule, job.createdAt, Date.now());
      saveCronjobs(cronjobs);
      eventHandler({ type: "cronjob_updated", cronjob: job });
    }
  }
}

function fire(jobId: string, trigger: CronjobRun["trigger"]): CronjobRun | null {
  const job = cronjobs.find((c) => c.id === jobId);
  if (!job) return null;

  // Validate cwd before spawning so a moved directory surfaces as a failed
  // run rather than an opaque SDK exit.
  let cwdValid = true;
  let cwdError: string | null = null;
  try {
    validateCwd(job.cwd);
  } catch (err: any) {
    cwdValid = false;
    cwdError = err.message || "Invalid cwd";
  }

  const runId = generateCronjobRunId();
  const placeholderSessionId = `pending-${runId}`;
  const now = Date.now();
  const run: CronjobRun = {
    id: runId,
    cronjobId: jobId,
    cronjobName: job.name,
    trigger,
    status: cwdValid ? "running" : "failed",
    startedAt: now,
    endedAt: cwdValid ? null : now,
    errorReason: cwdError,
    promptSnapshot: job.prompt,
    modelFamilySnapshot: job.modelFamily,
    effortSnapshot: job.effort,
    cwdSnapshot: job.cwd,
    permissionModeSnapshot: job.permissionMode,
    rootSessionId: placeholderSessionId,
    previewText: cwdError ?? "",
  };
  appendRun(jobId, run);
  eventHandler({ type: "cronjob_run_updated", run });

  if (!cwdValid) {
    // Update next fire for scheduled trigger so we don't loop.
    if (trigger === "scheduled") {
      job.lastFireAt = now;
      job.nextFireAt = computeNextFire(job.schedule, job.createdAt, now);
      saveCronjobs(cronjobs);
      eventHandler({ type: "cronjob_updated", cronjob: job });
    }
    return run;
  }

  const systemPrompt = buildCronjobSystemPrompt(job, jobId, runId);
  const opts: any = {
    model: FAMILY_TO_MODEL[job.modelFamily],
    permissionMode: job.permissionMode,
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    executableArgs: ["--append-system-prompt", systemPrompt, "--effort", job.effort],
    cwd: job.cwd,
    hooks: createSafetyHooks(),
  };
  let session: ReturnType<typeof unstable_v2_createSession>;
  try {
    session = unstable_v2_createSession(opts);
  } catch (err: any) {
    const updated = updateRun(jobId, runId, {
      status: "failed",
      endedAt: Date.now(),
      errorReason: `Failed to create session: ${err.message || String(err)}`,
    });
    if (updated) eventHandler({ type: "cronjob_run_updated", run: updated });
    return updated ?? run;
  }

  const streamId = cronjobRunStreamId(runId);
  const active: ActiveRun = {
    jobId,
    runId,
    streamId,
    session,
    sessionId: null,
    rootSessionId: placeholderSessionId,
    consumerPromise: Promise.resolve(),
    hardTimeoutTimer: null,
    lastWrittenEntryId: null,
    lastAssistantText: "",
    trigger,
    killed: false,
  };
  activeRuns.set(runId, active);
  active.consumerPromise = runConsumer(active);
  active.hardTimeoutTimer = setTimeout(() => {
    if (!activeRuns.has(runId)) return;
    active.killed = true;
    try { session.close(); } catch {}
    writeLog(active, "error", "Cronjob run exceeded 30-minute hard timeout.");
    finalizeRun(active, "timed_out", "exceeded global run timeout");
  }, HARD_TIMEOUT_MS);

  // Send the prompt as the first user message. Wrap in a try so ergonomic
  // errors don't crash the tick.
  (async () => {
    try {
      await session.send(job.prompt);
    } catch (err: any) {
      if (active.killed) return;
      console.error(`Cronjob run ${runId} input error:`, err.message);
      writeLog(active, "error", `Failed to send prompt: ${err.message || String(err)}`);
      try { session.close(); } catch {}
      finalizeRun(active, "failed", err.message || String(err));
    }
  })();

  return run;
}

function recordSkippedRun(job: Cronjob): CronjobRun {
  const runId = generateCronjobRunId();
  const now = Date.now();
  const run: CronjobRun = {
    id: runId,
    cronjobId: job.id,
    cronjobName: job.name,
    trigger: "scheduled",
    status: "skipped",
    startedAt: now,
    endedAt: now,
    errorReason: "previous scheduled run still in flight",
    promptSnapshot: job.prompt,
    modelFamilySnapshot: job.modelFamily,
    effortSnapshot: job.effort,
    cwdSnapshot: job.cwd,
    permissionModeSnapshot: job.permissionMode,
    rootSessionId: `skipped-${runId}`,
    previewText: "",
  };
  appendRun(job.id, run);
  eventHandler({ type: "cronjob_run_updated", run });
  return run;
}

// ---------------------------------------------------------------------------
// Scheduler tick
// ---------------------------------------------------------------------------

function hasInFlightScheduledRun(jobId: string): boolean {
  for (const a of activeRuns.values()) {
    if (a.jobId === jobId && a.trigger === "scheduled") return true;
  }
  return false;
}

function tick() {
  const now = Date.now();
  for (const job of cronjobs) {
    if (!job.enabled) continue;
    if (now < job.nextFireAt) continue;
    if (hasInFlightScheduledRun(job.id)) {
      recordSkippedRun(job);
      job.nextFireAt = computeNextFire(job.schedule, job.createdAt, now);
      saveCronjobs(cronjobs);
      eventHandler({ type: "cronjob_updated", cronjob: job });
      continue;
    }
    job.lastFireAt = now;
    job.nextFireAt = computeNextFire(job.schedule, job.createdAt, now);
    saveCronjobs(cronjobs);
    eventHandler({ type: "cronjob_updated", cronjob: job });
    fire(job.id, "scheduled");
  }
}

// ---------------------------------------------------------------------------
// Manual trigger
// ---------------------------------------------------------------------------

export function runCronjobNow(id: string, _username: string, _device?: string): CronjobRun | null {
  const job = cronjobs.find((c) => c.id === id);
  if (!job) return null;
  return fire(id, "manual");
}

// ---------------------------------------------------------------------------
// Startup reconciliation + scheduler boot
// ---------------------------------------------------------------------------

export function startCronjobScheduler() {
  // Load configs and cronjobsPrompt
  cronjobs = loadCronjobs();
  const cfg = loadOfficeConfig();
  cronjobsPrompt = cfg.cronjobsPrompt;

  // Recompute nextFireAt for every cronjob from current time forward.
  const now = Date.now();
  let dirty = false;
  for (const job of cronjobs) {
    const schedule = clampSchedule(job.schedule);
    const next = computeNextFire(schedule, job.createdAt, now);
    if (next !== job.nextFireAt) {
      job.nextFireAt = next;
      dirty = true;
    }
  }
  if (dirty) saveCronjobs(cronjobs);

  // Mark any "running" rows on disk as failed — server crashed mid-run.
  for (const jobId of listAllCronjobIdsOnDisk()) {
    const runs = loadRuns(jobId);
    let mutated = false;
    for (const r of runs) {
      if (r.status === "running") {
        r.status = "failed";
        r.endedAt = now;
        r.errorReason = "server restarted during run";
        mutated = true;
      }
    }
    if (mutated) saveRuns(jobId, runs);
  }

  setTimeout(() => tick(), 5_000); // initial tick after small delay
  setInterval(() => tick(), TICK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Per-cronjob lifetime usage helpers (used by /usage)
// ---------------------------------------------------------------------------

export function readCronjobLifetimeUsage(jobId: string): {
  totalIn: number;
  cacheRead: number;
  cacheCreation: number;
  totalOut: number;
  costUSD: number;
} {
  const totals = { totalIn: 0, cacheRead: 0, cacheCreation: 0, totalOut: 0, costUSD: 0 };
  const runs = loadRuns(jobId);
  for (const run of runs) {
    const map = loadRunSessionsMap(jobId, run.id);
    for (const entry of Object.values(map)) {
      const u: PersistedUsage | undefined = entry.usage;
      const p: PersistedUsage | undefined = entry.priorRunsUsage;
      const base: PersistedUsage | undefined = entry.forkBaseUsage;
      const inputTokens = (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0);
      const outputTokens = (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0);
      const cacheReadInputTokens = (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0);
      const cacheCreationInputTokens = (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
      const costUSD = (u?.costUSD ?? 0) + (p?.costUSD ?? 0);
      totals.totalIn += inputTokens + cacheReadInputTokens + cacheCreationInputTokens
        - ((base?.inputTokens ?? 0) + (base?.cacheReadInputTokens ?? 0) + (base?.cacheCreationInputTokens ?? 0));
      totals.cacheRead += cacheReadInputTokens - (base?.cacheReadInputTokens ?? 0);
      totals.cacheCreation += cacheCreationInputTokens - (base?.cacheCreationInputTokens ?? 0);
      totals.totalOut += outputTokens - (base?.outputTokens ?? 0);
      totals.costUSD += costUSD - (base?.costUSD ?? 0);
    }
  }
  return totals;
}
