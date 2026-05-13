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
  unstable_v2_resumeSession,
  forkSession,
  getSessionMessages,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  FAMILY_TO_MODEL,
  generateCronjobId,
  generateCronjobRunId,
  cronjobRunStreamId,
  humanizeSchedule,
  type Attachment,
  type Cronjob,
  type CronjobRun,
  type CronjobPermissionMode,
  type LogEntry,
  type Schedule,
} from "../shared/types.ts";
import {
  CLAUDE_NATIVE_BIN,
  validateCwd,
  resolveCwd,
  claudeSessionFileExists,
  claudeProjectDir,
} from "./cwd-utils.ts";
import { formatPrefix } from "../shared/identity.ts";
import { createSafetyHooks } from "./safety-hooks.ts";
import {
  loadOfficeConfig,
  saveFile,
  type PersistedUsage,
} from "./persistence.ts";
import {
  loadCronjobs,
  saveCronjobs,
  loadCronjobHistory,
  saveCronjobHistory,
  loadCronjobsPrompt,
  saveCronjobsPrompt,
  migrateCronjobsPromptFromOfficeConfig,
  loadRuns,
  saveRuns,
  appendRun,
  updateRun,
  findRun,
  appendRunLog,
  loadRunLog,
  loadRunLogWithAncestors,
  loadRunSessionsMap,
  accumulateRunSessionUsage,
  appendRunSessionUsageSnapshot,
  persistRunSessionFork,
  findUsageAtForkRun,
  rollRunSessionUsageOnResume,
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
  sessionId: string | null; // assigned on first system:init
  rootSessionId: string; // the run row's rootSessionId (placeholder until init)
  consumerPromise: Promise<void>;
  hardTimeoutTimer: ReturnType<typeof setTimeout> | null;
  lastWrittenEntryId: string | null;
  lastAssistantText: string; // for previewText computation
  trigger: CronjobRun["trigger"];
  killed: boolean;
  // Buffer entries created before SDK init assigns a sessionId. Without this,
  // pre-init errors (e.g. "Failed to send prompt") get broadcast to clients
  // but never persisted to disk, so they vanish on reload.
  pendingEntries: LogEntry[];
  // True for follow-up turns on a previously-finalized run (resumed or
  // edit-forked). On resume the SDK reuses the existing sessionId, so init
  // must NOT clobber rootSessionId — only currentSessionId tracks the leaf.
  isResume: boolean;
}

const activeRuns = new Map<string, ActiveRun>(); // runId -> ActiveRun

// Synchronously-claimed slot for runs whose resume/fork is mid-startup but
// hasn't reached `activeRuns.set` yet. Without this gate, a second concurrent
// send/edit call for the same runId would pass the activeRuns.has() check
// during the awaits in editRunMessage (getSessionMessages → forkSession),
// fork twice, and end up overwriting each other's ActiveRun entries.
const startingRuns = new Set<string>();

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
  | { type: "log_entry"; entry: LogEntry }
  | { type: "clear_logs"; agentId: string };

let eventHandler: (e: CronjobEvent) => void = () => {};

export function onCronjobEvent(handler: (e: CronjobEvent) => void) {
  eventHandler = handler;
}

// ---------------------------------------------------------------------------
// Schedule math
// ---------------------------------------------------------------------------

export function computeNextFire(
  schedule: Schedule,
  anchor: number,
  now: number = Date.now(),
): number {
  if (schedule.type === "interval") {
    const intervalMs =
      Math.max(MIN_INTERVAL_MINUTES, schedule.minutes) * 60_000;
    if (now <= anchor) return anchor + intervalMs;
    const elapsed = now - anchor;
    // floor + 1 (not ceil): when elapsed lands exactly on a period boundary,
    // ceil(N) = N gives nextFireAt == now and the scheduler fires immediately.
    // floor(N) + 1 always returns the *next* future period.
    const periods = Math.floor(elapsed / intervalMs) + 1;
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
    return {
      type: "interval",
      minutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(schedule.minutes)),
    };
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
    weekday: Math.min(6, Math.max(0, Math.floor(schedule.weekday))) as
      | 0
      | 1
      | 2
      | 3
      | 4
      | 5
      | 6,
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
  saveCronjobsPrompt(normalized);
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
}

export function addCronjob(input: AddCronjobInput): Cronjob {
  const schedule = clampSchedule(input.schedule);
  const now = Date.now();
  const cronjob: Cronjob = {
    id: generateCronjobId(cronjobs.map((c) => c.id)),
    name: input.name.trim() || "Untitled cron job",
    schedule,
    prompt: input.prompt,
    cwd: resolveCwd(input.cwd),
    modelFamily: input.modelFamily,
    effort: input.effort,
    permissionMode: input.permissionMode,
    enabled: true,
    createdBy: input.username,
    username: input.username,
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
  changes: Partial<
    Pick<
      Cronjob,
      | "name"
      | "schedule"
      | "prompt"
      | "cwd"
      | "modelFamily"
      | "effort"
      | "permissionMode"
      | "enabled"
    >
  >,
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
  if (changes.permissionMode !== undefined)
    next.permissionMode = changes.permissionMode;
  if (changes.enabled !== undefined) next.enabled = changes.enabled;
  if (changes.schedule !== undefined) {
    next.schedule = clampSchedule(changes.schedule);
    // Anchor to the most recent fire (or createdAt if never fired) so an
    // edit can't surprise-fire immediately. The design doc originally said
    // anchor to createdAt for "predictable cadence", but that produces
    // immediate fires when the new period happens to align near `now`.
    const anchor = next.lastFireAt ?? next.createdAt;
    next.nextFireAt = computeNextFire(next.schedule, anchor, Date.now());
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
  return listAllCronjobIdsOnDisk().map((jobId) => ({
    jobId,
    runs: loadRuns(jobId),
  }));
}

export function getRunTranscript(
  jobId: string,
  runId: string,
): { run: CronjobRun | null; entries: LogEntry[] } {
  const run = findRun(jobId, runId);
  if (!run) return { run: null, entries: [] };
  // Walk back from the leaf of the fork chain so edit-to-fork transcripts
  // render correctly. Old runs without currentSessionId fall back to the
  // root — equivalent to the un-forked case.
  const leaf = run.currentSessionId ?? run.rootSessionId;
  const entries = loadRunLogWithAncestors(jobId, runId, leaf);
  return { run, entries };
}

// ---------------------------------------------------------------------------
// System prompt for cronjobs
// ---------------------------------------------------------------------------

export function buildCronjobSystemPrompt(cronjob: Cronjob): string {
  const officeConfig = loadOfficeConfig();
  // humanizeSchedule produces sentence-case ("Daily at 09:00"); lowercase the
  // first letter so it reads as a sentence fragment ("You run daily at 09:00").
  // Only the first letter — keeps weekday abbreviations like "Mon" capitalized.
  const human = humanizeSchedule(cronjob.schedule);
  const scheduleDescription = human.charAt(0).toLowerCase() + human.slice(1);

  let prompt = `You are "${cronjob.name}", a scheduled cron job in the Isomux office. You run ${scheduleDescription}.

The Isomux office consists of agents that have persistent identity and sit at desks in various rooms of the office. You don't have a desk or persistent identity — each scheduled run starts fresh. There is no human in the loop during your run; any result must be self-contained, since someone may review it later.

How to discover other office agents and their conversation logs: read ~/.isomux/agents-summary.json.

How to use the task board (localhost:4000/tasks): only touch it if your prompt directs you to. When you do:
  curl -s localhost:4000/tasks                                          # list active tasks (excludes done and backlog)
  curl -s localhost:4000/tasks?status=all                               # include done and backlog
  curl -s -X POST localhost:4000/tasks -H 'Content-Type: application/json' \\
    -d '{"title":"...","createdBy":"${cronjob.name}"}'                  # create
  curl -s -X POST localhost:4000/tasks/ID/done -d '{}'                  # mark done

How to show an image: read the image file with the Read tool — it renders inline in the conversation.

How to inspect cronjobs (~/.isomux/cronjobs/): cronjobs are scheduled SDK sessions, not agents — they fire daily/weekly/at an interval, run a fresh session with a configured prompt, and save the transcript as a "run". They have no desk or persistent identity. Only touch them when the boss asks.
  ~/.isomux/cronjobs/cronjobs.json                              # all cronjob configs
  ~/.isomux/cronjobs/<jobId>/runs.json                          # run history for one cronjob (newest last)
  ~/.isomux/cronjobs/<jobId>/<runId>/<rootSessionId>.jsonl      # transcript of one run, one log entry per line
To create, edit, delete, or trigger a cronjob, direct the boss to the Cronjobs tab in the UI.

How to answer questions about Isomux itself: the source lives at https://github.com/nmamano/isomux.`;

  if (officeConfig.prompt)
    prompt += `\n\n## Office Instructions\n\n${officeConfig.prompt}`;
  if (cronjobsPrompt)
    prompt += `\n\n## Cron Jobs Instructions\n\n${cronjobsPrompt}`;
  return prompt;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function processCronjobMessage(active: ActiveRun, msg: SDKMessage) {
  switch (msg.type) {
    case "system": {
      const subtype = (msg as any).subtype;
      if (subtype === "init") {
        const sessionId = (msg as any).session_id as string | undefined;
        if (sessionId && !active.sessionId) {
          active.sessionId = sessionId;
          // If the SDK assigned a different id than rootSessionId, update the
          // run row so the transcript loads correctly. On resume the SDK keeps
          // the same id, so this branch only fires for fresh-fire init or a
          // forked-then-resumed leaf where currentSessionId is already in sync.
          if (sessionId !== active.rootSessionId) {
            // Only sync rootSessionId on the initial fire. For resumed/forked
            // runs the root is fixed history; the leaf is currentSessionId.
            const patch: Partial<CronjobRun> = active.isResume
              ? { currentSessionId: sessionId }
              : { rootSessionId: sessionId, currentSessionId: sessionId };
            const updated = updateRun(active.jobId, active.runId, patch);
            if (updated) {
              if (!active.isResume) active.rootSessionId = sessionId;
              eventHandler({ type: "cronjob_run_updated", run: updated });
            }
          }
          // Flush any pre-init log entries (errors, etc.) to the now-known
          // session's JSONL so they survive a reload.
          for (const entry of active.pendingEntries) {
            appendRunLog(active.jobId, active.runId, sessionId, entry);
            active.lastWrittenEntryId = entry.id;
          }
          active.pendingEntries = [];
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
          writeLog(active, "tool_call", block.name, {
            toolId: block.id,
            input: block.input,
          });
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
          // Extract image attachments from tool_result blocks (e.g. from the
          // Read tool reading an image). Files are saved under the cronjob run
          // stream id so the existing /api/files/<agentId>/... route resolves
          // them (~/.isomux/logs/cronrun-<runId>/files/).
          let resultAttachments: Attachment[] | undefined;
          if (Array.isArray(block.content)) {
            const atts: Attachment[] = [];
            for (const c of block.content as any[]) {
              if (c.type === "image" && c.source?.type === "base64") {
                const decoded = Buffer.from(c.source.data, "base64");
                const att = saveFile(
                  active.streamId,
                  decoded,
                  c.source.media_type,
                  `image.${c.source.media_type.split("/")[1] ?? "png"}`,
                );
                if (att) atts.push(att);
              }
            }
            if (atts.length > 0) resultAttachments = atts;
          }
          writeLog(
            active,
            "tool_result",
            resultText.slice(0, 10000),
            { toolUseId: block.tool_use_id },
            resultAttachments,
          );
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
            cacheCreationInputTokens:
              usageField.cache_creation_input_tokens ?? 0,
          },
          cost,
        );
        if (active.lastWrittenEntryId) {
          appendRunSessionUsageSnapshot(
            active.jobId,
            active.runId,
            active.sessionId,
            active.lastWrittenEntryId,
            cumulative,
          );
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

function writeLog(
  active: ActiveRun,
  kind: LogEntry["kind"],
  content: string,
  metadata?: Record<string, unknown>,
  attachments?: Attachment[],
) {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: active.streamId,
    timestamp: Date.now(),
    kind,
    content,
    ...(metadata ? { metadata } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
  if (active.sessionId) {
    appendRunLog(active.jobId, active.runId, active.sessionId, entry);
    active.lastWrittenEntryId = entry.id;
  } else {
    // Pre-init: buffer until processCronjobMessage(system/init) flushes us.
    active.pendingEntries.push(entry);
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

function finalizeRun(
  active: ActiveRun,
  status: CronjobRun["status"],
  errorReason: string | null = null,
) {
  // Idempotent: multiple paths can race to finalize (runConsumer's success
  // branch when stream ends, the IIFE's catch when session.send() fails, the
  // timeout handler). The first one wins; later calls no-op. Without this,
  // a send-fail's finalizeRun(failed) gets clobbered by runConsumer reaching
  // finalizeRun(completed) right after session.close() ends the stream.
  if (!activeRuns.has(active.runId)) return;
  activeRuns.delete(active.runId);
  if (active.hardTimeoutTimer) {
    clearTimeout(active.hardTimeoutTimer);
    active.hardTimeoutTimer = null;
  }
  // If init never arrived, the run row's rootSessionId is still the
  // `pending-<runId>` placeholder. Flush any buffered pre-init entries to
  // a JSONL named after that placeholder so loadRunLogWithAncestors finds
  // them on reload (the canonical motivating example: "Failed to send
  // prompt" surfaced before the SDK assigned a sessionId).
  if (!active.sessionId && active.pendingEntries.length > 0) {
    for (const entry of active.pendingEntries) {
      appendRunLog(active.jobId, active.runId, active.rootSessionId, entry);
    }
    active.pendingEntries = [];
  }
  // Release the underlying Claude subprocess. The V2 SDK's stream() ends per
  // turn (not per session), so a successful run reaches finalizeRun with the
  // session still alive — without close() it would leak until process exit.
  try {
    active.session.close();
  } catch {}
  const previewText = (active.lastAssistantText || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const updated = updateRun(active.jobId, active.runId, {
    status,
    endedAt: Date.now(),
    errorReason: errorReason ?? null,
    previewText,
  });
  if (updated) eventHandler({ type: "cronjob_run_updated", run: updated });
  // tick() and the cwd-invalid branch in fire() already set lastFireAt and
  // nextFireAt at fire time — no further schedule update needed here.
}

function fire(
  job: Cronjob,
  trigger: CronjobRun["trigger"],
  triggeredBy?: string,
): CronjobRun | null {
  const jobId = job.id;

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
    currentSessionId: placeholderSessionId,
    previewText: cwdError ?? "",
    ...(triggeredBy ? { triggeredBy } : {}),
  };
  appendRun(jobId, run);
  eventHandler({ type: "cronjob_run_updated", run });

  if (!cwdValid) {
    // Update next fire for scheduled trigger so we don't loop.
    if (trigger === "scheduled") {
      job.lastFireAt = now;
      job.nextFireAt = computeNextFire(job.schedule, now, now);
      saveCronjobs(cronjobs);
      eventHandler({ type: "cronjob_updated", cronjob: job });
    }
    return run;
  }

  const systemPrompt = buildCronjobSystemPrompt(job);
  const opts: any = {
    model: FAMILY_TO_MODEL[job.modelFamily],
    permissionMode: job.permissionMode,
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    executableArgs: [
      "--append-system-prompt",
      systemPrompt,
      "--effort",
      job.effort,
    ],
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
    pendingEntries: [],
    isResume: false,
  };
  activeRuns.set(runId, active);
  active.consumerPromise = runConsumer(active);
  active.hardTimeoutTimer = setTimeout(() => {
    if (!activeRuns.has(runId)) return;
    active.killed = true;
    try {
      session.close();
    } catch {}
    writeLog(active, "error", "Cron job run exceeded 30-minute hard timeout.");
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
      writeLog(
        active,
        "error",
        `Failed to send prompt: ${err.message || String(err)}`,
      );
      try {
        session.close();
      } catch {}
      finalizeRun(active, "failed", err.message || String(err));
    }
  })();

  return run;
}

function recordSkippedRun(job: Cronjob): CronjobRun {
  const runId = generateCronjobRunId();
  const now = Date.now();
  // Skipped runs never open a session, so there's deliberately no
  // <runId>/<sessionId>.jsonl on disk. The "skipped-<runId>" placeholder
  // satisfies the type; CronjobRunView shows "This run was skipped" without
  // attempting to render a transcript (loadRunLog returns [] for missing
  // files, which is handled by the empty-state branch).
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
      job.nextFireAt = computeNextFire(
        job.schedule,
        job.lastFireAt ?? job.createdAt,
        now,
      );
      saveCronjobs(cronjobs);
      eventHandler({ type: "cronjob_updated", cronjob: job });
      continue;
    }
    job.lastFireAt = now;
    job.nextFireAt = computeNextFire(job.schedule, job.lastFireAt, now);
    saveCronjobs(cronjobs);
    eventHandler({ type: "cronjob_updated", cronjob: job });
    fire(job, "scheduled");
  }
}

// ---------------------------------------------------------------------------
// Manual trigger
// ---------------------------------------------------------------------------

export function runCronjobNow(id: string, username: string): CronjobRun | null {
  const job = cronjobs.find((c) => c.id === id);
  if (!job) return null;
  return fire(job, "manual", username);
}

// ---------------------------------------------------------------------------
// Resume / edit-to-fork — follow-up turns into a finalized run
// ---------------------------------------------------------------------------

// Append a one-off log entry without an active session. Used to surface
// pre-flight errors (cwd invalid, leaf is a placeholder, etc.) so the user
// sees them in the run transcript instead of the message vanishing.
function emitRunErrorEntry(jobId: string, runId: string, message: string) {
  const run = findRun(jobId, runId);
  if (!run) return;
  const sessionId = run.currentSessionId ?? run.rootSessionId;
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: cronjobRunStreamId(runId),
    timestamp: Date.now(),
    kind: "error",
    content: message,
  };
  appendRunLog(jobId, runId, sessionId, entry);
  eventHandler({ type: "log_entry", entry });
}

function buildRunResumeOpts(run: CronjobRun, resumeSessionId: string): any {
  // Roll the current-run usage into priorRunsUsage so the SDK's per-process
  // cost counter resetting to zero (which it does on every resume) doesn't
  // wipe lifetime accounting. Mirrors agent-manager's createSession.
  rollRunSessionUsageOnResume(run.cronjobId, run.id, resumeSessionId);
  // Re-pass the system prompt when the cronjob still exists so resumed runs
  // pick up any office/cronjobs prompt edits. For deleted cronjobs the saved
  // session preserves the original prompt — skip --append-system-prompt
  // entirely rather than synthesize a partial one.
  const job = cronjobs.find((c) => c.id === run.cronjobId);
  const systemPrompt = job ? buildCronjobSystemPrompt(job) : null;
  const executableArgs = systemPrompt
    ? ["--append-system-prompt", systemPrompt, "--effort", run.effortSnapshot]
    : ["--effort", run.effortSnapshot];
  return {
    model: FAMILY_TO_MODEL[run.modelFamilySnapshot],
    permissionMode: run.permissionModeSnapshot,
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    executableArgs,
    cwd: run.cwdSnapshot,
    hooks: createSafetyHooks(),
    resume: resumeSessionId,
  };
}

// Wire up an ActiveRun around an SDK session (resumed or freshly forked).
// Marks the run row "running", starts the consumer + hard timeout, and
// returns the active so callers can persist log entries / call session.send.
function installResumedActive(
  run: CronjobRun,
  session: ReturnType<typeof unstable_v2_resumeSession>,
  sessionId: string,
): ActiveRun {
  const streamId = cronjobRunStreamId(run.id);
  const active: ActiveRun = {
    jobId: run.cronjobId,
    runId: run.id,
    streamId,
    session,
    sessionId,
    rootSessionId: run.rootSessionId,
    consumerPromise: Promise.resolve(),
    hardTimeoutTimer: null,
    lastWrittenEntryId: null,
    lastAssistantText: "",
    // Force trigger="manual" for resumed turns regardless of the run row's
    // original trigger. hasInFlightScheduledRun uses active.trigger to gate
    // the cron scheduler — if a user resumes a scheduled run, we don't want
    // the scheduler to suppress the cronjob's next regular fire while the
    // user-driven follow-up is in flight. (run.trigger on disk is unchanged
    // — that's history, not in-flight semantics.)
    trigger: "manual",
    killed: false,
    pendingEntries: [],
    isResume: true,
  };
  activeRuns.set(run.id, active);
  // Reset terminal state — the run row goes back to "running" until finalize.
  const updated = updateRun(run.cronjobId, run.id, {
    status: "running",
    endedAt: null,
    errorReason: null,
  });
  if (updated) eventHandler({ type: "cronjob_run_updated", run: updated });
  active.consumerPromise = runConsumer(active);
  active.hardTimeoutTimer = setTimeout(() => {
    if (!activeRuns.has(run.id)) return;
    active.killed = true;
    try {
      active.session.close();
    } catch {}
    writeLog(active, "error", "Cron job run exceeded 30-minute hard timeout.");
    finalizeRun(active, "timed_out", "exceeded global run timeout");
  }, HARD_TIMEOUT_MS);
  return active;
}

// Send a follow-up message into a finalized run by resuming the leaf session.
// No-op if the run is missing, currently in flight, or has no real SDK
// session to resume (skipped or pre-init failed).
export async function sendRunMessage(
  jobId: string,
  runId: string,
  text: string,
  username?: string,
  device?: string,
): Promise<void> {
  const run = findRun(jobId, runId);
  if (!run) return;
  // Synchronous claim — must happen before any await so a concurrent
  // send/edit for the same runId bails immediately. installResumedActive's
  // activeRuns.set keeps the slot held; the `finally` below releases it.
  if (activeRuns.has(runId) || startingRuns.has(runId)) return;
  if (run.status === "skipped") {
    emitRunErrorEntry(
      jobId,
      runId,
      "Cannot resume a skipped run — it never opened a session.",
    );
    return;
  }
  const leaf = run.currentSessionId ?? run.rootSessionId;
  if (leaf.startsWith("pending-") || leaf.startsWith("skipped-")) {
    emitRunErrorEntry(
      jobId,
      runId,
      "Cannot resume: the original run never reached SDK init.",
    );
    return;
  }
  try {
    validateCwd(run.cwdSnapshot);
  } catch (err: any) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Cannot resume: cwd is invalid: ${err.message || String(err)}`,
    );
    return;
  }
  // Mirror agent-manager's claudeSessionFileExists preflight so a moved or
  // renamed cwd surfaces a readable error instead of "process exited with 1".
  if (!claudeSessionFileExists(run.cwdSnapshot, leaf)) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Cannot resume session ${leaf.slice(0, 8)}…: its file is missing from ${claudeProjectDir(run.cwdSnapshot)}. ` +
        `Most commonly this happens after the cwd was moved or renamed — the Claude CLI stores sessions under a path derived from cwd.`,
    );
    return;
  }

  startingRuns.add(runId);
  try {
    let session: ReturnType<typeof unstable_v2_resumeSession>;
    try {
      session = unstable_v2_resumeSession(leaf, buildRunResumeOpts(run, leaf));
    } catch (err: any) {
      emitRunErrorEntry(
        jobId,
        runId,
        `Failed to resume: ${err.message || String(err)}`,
      );
      return;
    }

    const active = installResumedActive(run, session, leaf);
    // Persist the user message so it shows up in the transcript.
    const meta: Record<string, unknown> | undefined =
      username || device
        ? { ...(username ? { username } : {}), ...(device ? { device } : {}) }
        : undefined;
    writeLog(active, "user_message", text, meta);

    const prefix = formatPrefix({ username, device });
    const prefixedText = prefix ? `${prefix}${text}` : text;
    (async () => {
      try {
        await session.send(prefixedText);
      } catch (err: any) {
        if (active.killed) return;
        console.error(`Cronjob run ${runId} send error:`, err.message);
        writeLog(
          active,
          "error",
          `Failed to send: ${err.message || String(err)}`,
        );
        try {
          session.close();
        } catch {}
        finalizeRun(active, "failed", err.message || String(err));
      }
    })();
  } finally {
    startingRuns.delete(runId);
  }
}

// Edit-to-fork a user message in a finalized run. Mirrors agent-manager's
// editMessage: forks the SDK session at the predecessor of the target
// message, persists fork lineage in the run's sessions.json, then resumes
// the new leaf and sends the edited text.
export async function editRunMessage(
  jobId: string,
  runId: string,
  logEntryId: string,
  newText: string,
  username?: string,
  device?: string,
): Promise<void> {
  const run = findRun(jobId, runId);
  if (!run) return;
  // Synchronous claim — see sendRunMessage. Without this, getSessionMessages
  // and forkSession below would race against a second concurrent submission.
  if (activeRuns.has(runId) || startingRuns.has(runId)) return;
  if (run.status === "skipped") {
    emitRunErrorEntry(
      jobId,
      runId,
      "Cannot edit a skipped run — it never opened a session.",
    );
    return;
  }
  const leaf = run.currentSessionId ?? run.rootSessionId;
  if (leaf.startsWith("pending-") || leaf.startsWith("skipped-")) {
    emitRunErrorEntry(
      jobId,
      runId,
      "Cannot edit: the original run never reached SDK init.",
    );
    return;
  }
  try {
    validateCwd(run.cwdSnapshot);
  } catch (err: any) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Cannot edit: cwd is invalid: ${err.message || String(err)}`,
    );
    return;
  }
  if (!claudeSessionFileExists(run.cwdSnapshot, leaf)) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Cannot edit: session ${leaf.slice(0, 8)}… is missing from ${claudeProjectDir(run.cwdSnapshot)}. ` +
        `Most commonly this happens after the cwd was moved or renamed — the Claude CLI stores sessions under a path derived from cwd.`,
    );
    return;
  }

  startingRuns.add(runId);
  try {
    await editRunMessageImpl(run, logEntryId, newText, leaf, username, device);
  } finally {
    startingRuns.delete(runId);
  }
}

async function editRunMessageImpl(
  run: CronjobRun,
  logEntryId: string,
  newText: string,
  leaf: string,
  username?: string,
  device?: string,
): Promise<void> {
  const jobId = run.cronjobId;
  const runId = run.id;

  // 1. Locate the target log entry in the run's transcript (with ancestry).
  const oldEntries = loadRunLogWithAncestors(jobId, runId, leaf);
  const targetEntry = oldEntries.find((e) => e.id === logEntryId);
  if (!targetEntry || targetEntry.kind !== "user_message") {
    emitRunErrorEntry(jobId, runId, "Cannot edit: message not found.");
    return;
  }

  // 2. Match the target to a position in the SDK session's message list. Mirror
  //    agent-manager's content + occurrence-index strategy.
  let sdkMessages: Awaited<ReturnType<typeof getSessionMessages>>;
  try {
    sdkMessages = await getSessionMessages(leaf);
  } catch (err: any) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Failed to load session messages: ${err.message || String(err)}`,
    );
    return;
  }
  const targetUsername = targetEntry.metadata?.username as string | undefined;
  const targetDevice = targetEntry.metadata?.device as string | undefined;
  const targetSdkText =
    (targetEntry.metadata?.sdkText as string | undefined) ??
    targetEntry.content;
  const prefixedContent = `${formatPrefix({ username: targetUsername, device: targetDevice })}${targetSdkText}`;
  const userLogEntries = oldEntries.filter((e) => e.kind === "user_message");
  let occurrenceIndex = 0;
  for (const e of userLogEntries) {
    const u = e.metadata?.username as string | undefined;
    const d = e.metadata?.device as string | undefined;
    const sdkText = (e.metadata?.sdkText as string | undefined) ?? e.content;
    const prefixed = `${formatPrefix({ username: u, device: d })}${sdkText}`;
    if (prefixed === prefixedContent) {
      if (e.id === logEntryId) break;
      occurrenceIndex++;
    }
  }
  // Skip the cronjob's original prompt: it's the SDK's first user message but
  // not a LogEntry, so its content will never match (it's stored only as
  // run.promptSnapshot). occurrenceIndex therefore counts from the first
  // post-prompt user message — i.e. the first follow-up turn.
  const cronjobPromptIsFirstSdkUser = sdkMessages[0]?.type === "user";
  let matchCount = 0;
  let targetIdx = -1;
  for (
    let i = cronjobPromptIsFirstSdkUser ? 1 : 0;
    i < sdkMessages.length;
    i++
  ) {
    const m = sdkMessages[i];
    if (m.type !== "user") continue;
    const msg = m.message as any;
    const contentBlocks = Array.isArray(msg?.content)
      ? msg.content
      : Array.isArray(msg)
        ? msg
        : typeof msg === "string"
          ? [{ type: "text", text: msg }]
          : [];
    const msgContent = contentBlocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (msgContent === prefixedContent) {
      if (matchCount === occurrenceIndex) {
        targetIdx = i;
        break;
      }
      matchCount++;
    }
  }
  if (targetIdx <= 0) {
    emitRunErrorEntry(
      jobId,
      runId,
      "Cannot edit: could not locate message in SDK session.",
    );
    return;
  }

  // 3. Fork the SDK session at the predecessor (inclusive) so the original
  //    target message is excluded from the fork.
  const predecessorUuid = sdkMessages[targetIdx - 1].uuid;
  let newSessionId: string;
  try {
    const forkResult = await forkSession(leaf, {
      upToMessageId: predecessorUuid,
    });
    newSessionId = forkResult.sessionId;
  } catch (err: any) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Fork failed: ${err.message || String(err)}`,
    );
    return;
  }

  // 4. Try to resume the new fork. If this fails, do NOT update currentSessionId
  //    — leave the run pointing at the old leaf so a retry can start over.
  let session: ReturnType<typeof unstable_v2_resumeSession>;
  try {
    session = unstable_v2_resumeSession(
      newSessionId,
      buildRunResumeOpts(run, newSessionId),
    );
  } catch (err: any) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Failed to start fork: ${err.message || String(err)}`,
    );
    return;
  }

  // 5. The target log entry may live in an ancestor's JSONL (if the user has
  //    forked before). Walk back to find which JSONL actually contains it,
  //    and point forkedFrom at that ancestor — keeps loadRunLogWithAncestors
  //    cutting at the right level.
  let forkFromSessionId = leaf;
  const leafEntries = loadRunLog(jobId, runId, leaf);
  if (!leafEntries.some((e) => e.id === logEntryId)) {
    const sessMap = loadRunSessionsMap(jobId, runId);
    let walk: string | undefined = sessMap[leaf]?.forkedFrom;
    const visited = new Set<string>([leaf]);
    while (walk && !visited.has(walk)) {
      visited.add(walk);
      const ancestorEntries = loadRunLog(jobId, runId, walk);
      if (ancestorEntries.some((e) => e.id === logEntryId)) {
        forkFromSessionId = walk;
        break;
      }
      walk = sessMap[walk]?.forkedFrom;
    }
  }

  // 6. Persist fork metadata + parent-base usage, then update the run's
  //    currentSessionId so getRunTranscript walks back from the fork.
  const parentBase = findUsageAtForkRun(
    jobId,
    runId,
    forkFromSessionId,
    logEntryId,
  );
  persistRunSessionFork(
    jobId,
    runId,
    newSessionId,
    forkFromSessionId,
    logEntryId,
    parentBase,
  );
  const updatedRun = updateRun(jobId, runId, {
    currentSessionId: newSessionId,
  });
  if (updatedRun)
    eventHandler({ type: "cronjob_run_updated", run: updatedRun });

  // 7. Re-emit the transcript up to (but not including) the edited entry so
  //    every connected client switches to the new branch immediately.
  const streamId = cronjobRunStreamId(runId);
  const parentEntries: LogEntry[] = [];
  for (const e of oldEntries) {
    if (e.id === logEntryId) break;
    parentEntries.push(e);
  }
  eventHandler({ type: "clear_logs", agentId: streamId });
  for (const e of parentEntries) {
    eventHandler({ type: "log_entry", entry: e });
  }

  // 8. Wire up the active run, persist the new edited message, send it.
  const active = installResumedActive(updatedRun ?? run, session, newSessionId);
  const editMeta: Record<string, unknown> | undefined =
    username || device
      ? { ...(username ? { username } : {}), ...(device ? { device } : {}) }
      : undefined;
  writeLog(active, "user_message", newText, editMeta);
  const editPrefix = formatPrefix({ username, device });
  const prefixedText = editPrefix ? `${editPrefix}${newText}` : newText;
  (async () => {
    try {
      await session.send(prefixedText);
    } catch (err: any) {
      if (active.killed) return;
      console.error(`Cronjob run ${runId} edit-send error:`, err.message);
      writeLog(
        active,
        "error",
        `Failed to send edited message: ${err.message || String(err)}`,
      );
      try {
        session.close();
      } catch {}
      finalizeRun(active, "failed", err.message || String(err));
    }
  })();
}

// ---------------------------------------------------------------------------
// Startup reconciliation + scheduler boot
// ---------------------------------------------------------------------------

export function startCronjobScheduler() {
  // Load configs and cronjobsPrompt (with one-shot migration from the legacy
  // location in office-config.json — see migrateCronjobsPromptFromOfficeConfig).
  cronjobs = loadCronjobs();
  migrateCronjobsPromptFromOfficeConfig();
  cronjobsPrompt = loadCronjobsPrompt();

  // Recompute nextFireAt for every cronjob from current time forward.
  const now = Date.now();
  let dirty = false;
  for (const job of cronjobs) {
    const schedule = clampSchedule(job.schedule);
    const anchor = job.lastFireAt ?? job.createdAt;
    const next = computeNextFire(schedule, anchor, now);
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
  const totals = {
    totalIn: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalOut: 0,
    costUSD: 0,
  };
  const runs = loadRuns(jobId);
  for (const run of runs) {
    const map = loadRunSessionsMap(jobId, run.id);
    for (const entry of Object.values(map)) {
      const u: PersistedUsage | undefined = entry.usage;
      const p: PersistedUsage | undefined = entry.priorRunsUsage;
      const base: PersistedUsage | undefined = entry.forkBaseUsage;
      const inputTokens = (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0);
      const outputTokens = (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0);
      const cacheReadInputTokens =
        (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0);
      const cacheCreationInputTokens =
        (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
      const costUSD = (u?.costUSD ?? 0) + (p?.costUSD ?? 0);
      totals.totalIn +=
        inputTokens +
        cacheReadInputTokens +
        cacheCreationInputTokens -
        ((base?.inputTokens ?? 0) +
          (base?.cacheReadInputTokens ?? 0) +
          (base?.cacheCreationInputTokens ?? 0));
      totals.cacheRead +=
        cacheReadInputTokens - (base?.cacheReadInputTokens ?? 0);
      totals.cacheCreation +=
        cacheCreationInputTokens - (base?.cacheCreationInputTokens ?? 0);
      totals.totalOut += outputTokens - (base?.outputTokens ?? 0);
      totals.costUSD += costUSD - (base?.costUSD ?? 0);
    }
  }
  return totals;
}
