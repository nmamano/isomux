// Cronjob scheduler + per-run backend session lifecycle.
//
// Scheduler tick: every 60s, looks at every enabled cronjob and fires those
// whose nextFireAt has passed. Overlap rule: if a *scheduled* run is still
// in flight for the same cronjob, write a "skipped" row instead of firing.
// Manual "Run now" bypasses the overlap rule.
//
// Each fire creates a fresh backend session (Claude or Codex, per the
// cronjob's agentType), sends the prompt as the first user message,
// consumes the normalized event stream, and broadcasts log entries to the
// UI via the existing event bus. The synthetic "stream id" used for log
// routing is `cronjobRunStreamId(runId)` — this is also the agentId passed
// to the backend so attachments resolve under the run's logs/files dir.
//
// Cron differs from agents in lifecycle: a run is single-turn-then-close,
// not a long-lived session. consumeUntilTurnCompleted() awaits the first
// turn_completed (or error) event, finalizes the run row, and closes the
// session. Resume/edit follow the same one-turn shape.

import {
  generateCronjobId,
  generateCronjobRunId,
  cronjobRunStreamId,
  humanizeSchedule,
  type AgentBackendType,
  type Attachment,
  type CodexSandboxMode,
  type Cronjob,
  type CronjobRun,
  type CronjobPermissionMode,
  type LogEntry,
  type Schedule,
} from "../shared/types.ts";
import {
  validateCwd,
  resolveCwd,
  claudeSessionFileExists,
  claudeProjectDir,
  codexRolloutFileExists,
  codexSessionsDir,
} from "./cwd-utils.ts";
import { formatPrefix } from "../shared/identity.ts";
import { errMessage } from "../shared/errors.ts";
import { loadOfficeConfig, type PersistedUsage } from "./persistence.ts";
import { getBackend } from "./backends/index.ts";
import type {
  BackendSession,
  CreateSessionOptions,
  NormalizedEvent,
} from "./backends/types.ts";
import {
  validateCronjobPermissionMode,
  validateModelFamily,
  validateEffort,
  validateCodexSandbox,
} from "./agent-validators.ts";
// buildEnvFor merges process.env with the office env file and the cronjob
// owner's user env file (matches agent-manager's spawn-time env). Cron uses
// the same builder so a user that successfully fetches Codex models with
// their per-user OPENAI_API_KEY / CODEX_HOME via `list_backend_models` gets
// the same env when the cronjob actually fires. Imported from env-loader
// (not agent-manager) to keep cron decoupled from the orchestrator — the
// `cronjob-manager → agent-manager → command-handlers → cronjob-manager`
// cycle is what env-loader exists to break.
import { buildEnvForUserId } from "./env-loader.ts";
import { getUserByName } from "./users.ts";
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
  agentType: AgentBackendType;
  session: BackendSession;
  sessionId: string | null; // assigned on first system_init event
  rootSessionId: string; // the run row's rootSessionId (placeholder until init)
  consumerPromise: Promise<void>;
  hardTimeoutTimer: ReturnType<typeof setTimeout> | null;
  lastWrittenEntryId: string | null;
  lastAssistantText: string; // for previewText computation
  trigger: CronjobRun["trigger"];
  killed: boolean;
  // Buffer entries created before system_init assigns a sessionId. Without
  // this, pre-init errors (e.g. "Failed to send prompt") get broadcast to
  // clients but never persisted to disk, so they vanish on reload.
  pendingEntries: LogEntry[];
  // Per-turn tool-call start timestamps, keyed by toolUseId. Used to compute
  // duration_ms on the matching tool_result event when the backend itself
  // doesn't emit a durationMs.
  toolCallTimestamps: Map<string, number>;
  // True for follow-up turns on a previously-finalized run (resumed or
  // edit-forked). On resume the backend reuses the existing sessionId, so
  // system_init must NOT clobber rootSessionId — only currentSessionId
  // tracks the leaf.
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
  agentType: AgentBackendType;
  modelFamily: Cronjob["modelFamily"];
  effort: Cronjob["effort"];
  permissionMode: CronjobPermissionMode;
  codexSandbox?: CodexSandboxMode;
  // Display snapshot of the owning user's name at creation time.
  username: string;
  // Stable identity reference for per-user env at fire time. Optional
  // for legacy/unowned cronjobs; new caller paths pass session.userId.
  userId?: string | null;
}

export function addCronjob(input: AddCronjobInput): Cronjob {
  const schedule = clampSchedule(input.schedule);
  const now = Date.now();
  const agentType = input.agentType;
  const modelFamily = validateModelFamily(agentType, input.modelFamily);
  const effort = validateEffort(agentType, modelFamily, input.effort);
  const permissionMode = validateCronjobPermissionMode(
    agentType,
    input.permissionMode,
  );
  const codexSandbox =
    agentType === "codex"
      ? validateCodexSandbox(input.codexSandbox)
      : undefined;
  const cronjob: Cronjob = {
    id: generateCronjobId(cronjobs.map((c) => c.id)),
    name: input.name.trim() || "Untitled cron job",
    schedule,
    prompt: input.prompt,
    cwd: resolveCwd(input.cwd),
    agentType,
    modelFamily,
    effort,
    permissionMode,
    ...(codexSandbox ? { codexSandbox } : {}),
    enabled: true,
    createdBy: input.username,
    userId:
      input.userId ??
      (input.username ? (getUserByName(input.username)?.id ?? null) : null),
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
      | "codexSandbox"
      | "enabled"
    >
  >,
): Cronjob | null {
  const idx = cronjobs.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const prev = cronjobs[idx];
  // agentType is immutable on edit, mirroring agents. Re-validate the rest
  // under the existing agentType so a stale UI payload can't slip an
  // invalid Codex model into a Claude cronjob (or vice versa).
  const next: Cronjob = { ...prev };
  if (changes.name !== undefined) next.name = changes.name.trim() || prev.name;
  if (changes.prompt !== undefined) next.prompt = changes.prompt;
  if (changes.cwd !== undefined) next.cwd = resolveCwd(changes.cwd);
  if (changes.modelFamily !== undefined)
    next.modelFamily = validateModelFamily(prev.agentType, changes.modelFamily);
  if (changes.effort !== undefined)
    next.effort = validateEffort(
      prev.agentType,
      next.modelFamily,
      changes.effort,
    );
  if (changes.permissionMode !== undefined)
    next.permissionMode = validateCronjobPermissionMode(
      prev.agentType,
      changes.permissionMode,
    );
  if (changes.codexSandbox !== undefined && prev.agentType === "codex") {
    const v = validateCodexSandbox(changes.codexSandbox);
    if (v) next.codexSandbox = v;
    else delete next.codexSandbox;
  }
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
  // memberPrompt for the boss this cronjob runs on behalf of, looked up
  // at build time so renames / edits to the user's profile take effect
  // on the next fire without touching the cronjob record itself.
  if (cronjob.username) {
    const ownerRecord = getUserByName(cronjob.username);
    if (ownerRecord?.memberPrompt) {
      prompt += `\n\n## Special instructions for "${cronjob.username}"\n\n${ownerRecord.memberPrompt}`;
    }
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

// Translate a NormalizedEvent into cron's LogEntry / sessions.json side
// effects. Mirror of agent-manager.processNormalizedEvent, but with the cron
// writeLog signature (which routes to the run's <runId>/<sessionId>.jsonl).
//
// Per-turn lifecycle (finalize on turn_completed, error termination, etc.)
// lives in consumeUntilTurnCompleted — this function only logs / accumulates
// and never closes the session.
function processNormalizedEvent(active: ActiveRun, ev: NormalizedEvent) {
  switch (ev.kind) {
    case "system_init": {
      const sessionId = ev.sessionId;
      if (sessionId && !active.sessionId) {
        active.sessionId = sessionId;
        // If the backend assigned a different id than rootSessionId, update
        // the run row so the transcript loads correctly. On resume the same
        // id is reused, so this branch only fires for fresh-fire init or a
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
      break;
    }
    case "assistant_text": {
      active.lastAssistantText = ev.text;
      writeLog(active, "text", ev.text);
      break;
    }
    case "system_text": {
      writeLog(active, "system", ev.text);
      break;
    }
    case "thinking": {
      writeLog(
        active,
        "thinking",
        ev.text,
        ev.durationMs != null ? { duration_ms: ev.durationMs } : undefined,
      );
      break;
    }
    case "tool_call": {
      active.toolCallTimestamps.set(ev.toolUseId, Date.now());
      writeLog(active, "tool_call", ev.name, {
        toolId: ev.toolUseId,
        input: ev.input,
      });
      break;
    }
    case "tool_result": {
      const callStart = active.toolCallTimestamps.get(ev.toolUseId);
      const duration_ms =
        ev.durationMs ?? (callStart ? Date.now() - callStart : undefined);
      if (callStart) active.toolCallTimestamps.delete(ev.toolUseId);
      writeLog(
        active,
        "tool_result",
        ev.content.slice(0, 10000),
        {
          toolUseId: ev.toolUseId,
          ...(duration_ms != null ? { duration_ms } : {}),
        },
        ev.attachments,
      );
      break;
    }
    case "approval_request": {
      // Should not happen for cronjob permission modes (Claude
      // bypassPermissions, Codex never). If it does the turn will block
      // until the 30-minute hard timeout — surface a system note so it's
      // diagnosable in the transcript.
      writeLog(
        active,
        "system",
        `Approval requested for ${ev.toolName} — cronjobs run unattended; ` +
          `this should not occur with the configured permission mode. ` +
          `The run will block until the 30-minute hard timeout.`,
      );
      break;
    }
    case "turn_completed": {
      // Accumulate usage *before* the caller closes the session. close()
      // ends the stream, and the last usage anchor must reach disk first.
      if (active.sessionId && ev.usage) {
        const cumulative = accumulateRunSessionUsage(
          active.jobId,
          active.runId,
          active.sessionId,
          {
            inputTokens: ev.usage.inputTokens,
            outputTokens: ev.usage.outputTokens,
            cacheReadInputTokens: ev.usage.cacheReadInputTokens,
            cacheCreationInputTokens: ev.usage.cacheCreationInputTokens,
          },
          ev.cost ?? 0,
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
      if (ev.status !== "completed") {
        const errorText = ev.error ?? `Run stopped: ${ev.status}.`;
        writeLog(active, "error", errorText);
        if (getBackend(active.agentType).detectAuthError(errorText)) {
          writeLog(
            active,
            "system",
            getBackend(active.agentType).getLoginInstructions(),
          );
        }
      }
      break;
    }
    case "usage_update": {
      // Backend emitted running totals outside a turn boundary (Codex). Treat
      // it like a turn_completed for accumulation; no log/state side effects.
      if (active.sessionId) {
        const cumulative = accumulateRunSessionUsage(
          active.jobId,
          active.runId,
          active.sessionId,
          ev.tokenUsage,
          0,
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
      break;
    }
    case "compacted": {
      writeLog(
        active,
        "system",
        ev.summary ? `Context compacted: ${ev.summary}` : "Context compacted.",
      );
      break;
    }
    case "error": {
      writeLog(active, "error", ev.message);
      if (getBackend(active.agentType).detectAuthError(ev.message)) {
        writeLog(
          active,
          "system",
          getBackend(active.agentType).getLoginInstructions(),
        );
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

// Consume the backend's normalized event stream until the run's single turn
// completes (or fails). On the first `turn_completed` for this run turn,
// finalize the run row (status from the event) and close the session via
// finalizeRun. Backend streams are persistent across turns, so we MUST stop
// reading once the turn is done — otherwise a successful Codex run would
// stay open until the hard timeout. Same one-turn shape applies to resumed
// and edit-forked sessions installed via installResumedActive.
async function consumeUntilTurnCompleted(active: ActiveRun) {
  try {
    for await (const ev of active.session.stream()) {
      processNormalizedEvent(active, ev);
      if (ev.kind === "turn_completed") {
        const status: CronjobRun["status"] =
          ev.status === "completed" ? "completed" : "failed";
        const errorReason =
          ev.status === "completed"
            ? null
            : (ev.error ?? `Run stopped: ${ev.status}`);
        finalizeRun(active, status, errorReason);
        return;
      }
      if (ev.kind === "error") {
        // processNormalizedEvent already wrote the error LogEntry; terminate.
        finalizeRun(active, "failed", ev.message);
        return;
      }
    }
    // Stream ended without a turn_completed — should not happen with healthy
    // backends, but if it does (e.g. transport closed mid-turn), record it.
    if (activeRuns.has(active.runId)) {
      finalizeRun(active, "failed", "stream ended before turn completed");
    }
  } catch (err) {
    if (active.killed) return; // hard timeout already handled
    console.error(`Cronjob run ${active.runId} stream error:`, errMessage(err));
    writeLog(active, "error", `Stream error: ${errMessage(err)}`);
    finalizeRun(active, "failed", `Stream error: ${errMessage(err)}`);
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
  // Release the backend session (Claude SDK process or Codex subprocess).
  // Backend streams are persistent across turns; consumeUntilTurnCompleted
  // returns after the first turn_completed, so close() here is what actually
  // tears down the subprocess. Idempotent on the Backend contract.
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
  // run rather than an opaque backend process-exit message.
  let cwdValid = true;
  let cwdError: string | null = null;
  try {
    validateCwd(job.cwd);
  } catch (err) {
    cwdValid = false;
    cwdError = errMessage(err) || "Invalid cwd";
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
    agentTypeSnapshot: job.agentType,
    modelFamilySnapshot: job.modelFamily,
    effortSnapshot: job.effort,
    cwdSnapshot: job.cwd,
    permissionModeSnapshot: job.permissionMode,
    ...(job.codexSandbox ? { codexSandboxSnapshot: job.codexSandbox } : {}),
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
  // Resolve env up-front so a broken env file surfaces as a "Failed to create
  // session" run row instead of a stream-time error. Falls back to
  // process.env when no env file is configured for the cronjob owner.
  let env: { [key: string]: string | undefined } | undefined;
  try {
    env = buildEnvForUserId(job.userId ?? null);
  } catch (err) {
    const updated = updateRun(jobId, runId, {
      status: "failed",
      endedAt: Date.now(),
      errorReason: `Failed to build env: ${errMessage(err)}`,
    });
    if (updated) eventHandler({ type: "cronjob_run_updated", run: updated });
    return updated ?? run;
  }
  const opts: CreateSessionOptions = {
    agentId: cronjobRunStreamId(runId),
    cwd: job.cwd,
    systemPrompt,
    modelFamily: job.modelFamily,
    effort: job.effort,
    permissionMode: job.permissionMode,
    sandbox: job.codexSandbox,
    env,
  };
  let session: BackendSession;
  try {
    session = getBackend(job.agentType).createSession(opts);
  } catch (err) {
    const updated = updateRun(jobId, runId, {
      status: "failed",
      endedAt: Date.now(),
      errorReason: `Failed to create session: ${errMessage(err)}`,
    });
    if (updated) eventHandler({ type: "cronjob_run_updated", run: updated });
    return updated ?? run;
  }

  const streamId = cronjobRunStreamId(runId);
  const active: ActiveRun = {
    jobId,
    runId,
    streamId,
    agentType: job.agentType,
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
    toolCallTimestamps: new Map(),
    isResume: false,
  };
  activeRuns.set(runId, active);
  active.consumerPromise = consumeUntilTurnCompleted(active);
  active.hardTimeoutTimer = setTimeout(() => {
    if (!activeRuns.has(runId)) return;
    active.killed = true;
    try {
      session.close();
    } catch {}
    writeLog(active, "error", "Cron job run exceeded 30-minute hard timeout.");
    finalizeRun(active, "timed_out", "exceeded global run timeout");
  }, HARD_TIMEOUT_MS);

  // Send the prompt as the first user message. session.send awaits the
  // backend's bootstrap (Codex: initialize + thread/start; Claude: SDK
  // handshake) and can reject if spawn / auth fails — wrap so async
  // bootstrap errors finalize the run instead of crashing the tick.
  void (async () => {
    try {
      await session.send(job.prompt);
    } catch (err) {
      if (active.killed) return;
      console.error(`Cronjob run ${runId} input error:`, errMessage(err));
      writeLog(active, "error", `Failed to send prompt: ${errMessage(err)}`);
      try {
        session.close();
      } catch {}
      finalizeRun(active, "failed", errMessage(err));
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
    agentTypeSnapshot: job.agentType,
    modelFamilySnapshot: job.modelFamily,
    effortSnapshot: job.effort,
    cwdSnapshot: job.cwd,
    permissionModeSnapshot: job.permissionMode,
    ...(job.codexSandbox ? { codexSandboxSnapshot: job.codexSandbox } : {}),
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

// Build CreateSessionOptions for a resumed cronjob run. The current run's
// usage is rolled into priorRunsUsage before each resume — backends report
// cost cumulative-per-process, so the counter resets to zero on resume and
// the prior segment would otherwise vanish from lifetime accounting.
//
// systemPrompt: re-built from the live cronjob config when still present so
// resumed runs pick up office/cronjobs prompt edits. For deleted cronjobs
// we'd have nothing to derive the prompt from; pass an empty string so the
// backend's saved session keeps using whatever it was started with.
//
// env: resolved from the live cronjob's username (env file paths are
// per-user, not snapshotted). Deleted-cronjob resume falls back to
// process.env. A broken env file throws here — the caller surfaces it as
// a "Failed to resume" entry in the run transcript.
function buildRunSessionOptions(
  run: CronjobRun,
  resumeSessionId: string,
): CreateSessionOptions {
  rollRunSessionUsageOnResume(run.cronjobId, run.id, resumeSessionId);
  const job = cronjobs.find((c) => c.id === run.cronjobId);
  const systemPrompt = job ? buildCronjobSystemPrompt(job) : "";
  const env = buildEnvForUserId(job?.userId ?? null);
  return {
    agentId: cronjobRunStreamId(run.id),
    cwd: run.cwdSnapshot,
    systemPrompt,
    modelFamily: run.modelFamilySnapshot,
    effort: run.effortSnapshot,
    permissionMode: run.permissionModeSnapshot,
    sandbox: run.codexSandboxSnapshot,
    env,
  };
}

// Wire up an ActiveRun around a backend session (resumed or freshly forked).
// Marks the run row "running", starts the consumer + hard timeout, and
// returns the active so callers can persist log entries / call session.send.
function installResumedActive(
  run: CronjobRun,
  session: BackendSession,
  sessionId: string,
): ActiveRun {
  const streamId = cronjobRunStreamId(run.id);
  const active: ActiveRun = {
    jobId: run.cronjobId,
    runId: run.id,
    streamId,
    agentType: run.agentTypeSnapshot,
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
    toolCallTimestamps: new Map(),
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
  active.consumerPromise = consumeUntilTurnCompleted(active);
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
      "Cannot resume: the original run never reached backend init.",
    );
    return;
  }
  try {
    validateCwd(run.cwdSnapshot);
  } catch (err) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Cannot resume: cwd is invalid: ${errMessage(err)}`,
    );
    return;
  }
  const precheckError = checkResumableSession(run, leaf);
  if (precheckError) {
    emitRunErrorEntry(jobId, runId, precheckError);
    return;
  }

  startingRuns.add(runId);
  try {
    let session: BackendSession;
    try {
      session = getBackend(run.agentTypeSnapshot).resumeSession(
        leaf,
        buildRunSessionOptions(run, leaf),
      );
    } catch (err) {
      emitRunErrorEntry(jobId, runId, `Failed to resume: ${errMessage(err)}`);
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
    void (async () => {
      try {
        await session.send(prefixedText);
      } catch (err) {
        if (active.killed) return;
        console.error(`Cronjob run ${runId} send error:`, errMessage(err));
        writeLog(active, "error", `Failed to send: ${errMessage(err)}`);
        try {
          session.close();
        } catch {}
        finalizeRun(active, "failed", errMessage(err));
      }
    })();
  } finally {
    startingRuns.delete(runId);
  }
}

// Per-backend resume-precheck: a moved/renamed cwd or missing on-disk
// session/rollout surfaces here as a readable error, rather than letting
// the backend return an opaque "process exited with code 1" later. Returns
// null when the session looks resumable; otherwise returns the error
// message to surface in the run transcript.
//
// For Codex, CODEX_HOME is honored via the cronjob owner's env file, so
// the rollout-file lookup happens under the *same* sessions/ dir the
// actual session would use at resume — preventing a precheck pass under
// process.env's CODEX_HOME and a resume-time failure under the user's.
function checkResumableSession(run: CronjobRun, leaf: string): string | null {
  // Build env once for both branches — Claude honors CLAUDE_CONFIG_DIR for
  // its project dir lookup, Codex honors CODEX_HOME for its sessions/ dir.
  // A broken envFile is a real precheck failure: fall through to a clear
  // error rather than silently checking the wrong directory.
  const job = cronjobs.find((c) => c.id === run.cronjobId);
  let env: { [key: string]: string | undefined } | undefined;
  try {
    env = buildEnvForUserId(job?.userId ?? null);
  } catch (err) {
    return `Cannot build env: ${errMessage(err)}`;
  }
  if (run.agentTypeSnapshot === "claude") {
    if (!claudeSessionFileExists(run.cwdSnapshot, leaf, env)) {
      return (
        `Cannot resume session ${leaf.slice(0, 8)}…: its file is missing from ${claudeProjectDir(run.cwdSnapshot, env)}. ` +
        `Most commonly this happens after the cwd was moved or renamed — the Claude CLI stores sessions under a path derived from cwd.`
      );
    }
    return null;
  }
  // Codex: explicit-resume paths only block on missing-file. Header-only
  // and corrupt rollouts surface via Codex's own thread/resume error with
  // a more specific message — let it through.
  if (!codexRolloutFileExists(leaf, env)) {
    return (
      `Cannot resume Codex thread ${leaf.slice(0, 8)}…: no rollout file found under ${codexSessionsDir(env)}. ` +
      `This usually means the thread was started but never received a user turn before its process exited.`
    );
  }
  return null;
}

// Edit-to-fork a user message in a finalized run. Mirrors agent-manager's
// editMessage: asks the backend to fork the session before the target
// message, persists fork lineage in the run's sessions.json, then resumes
// the new leaf and sends the edited text.
//
// The matching strategy (content + occurrence-index) operates on the
// backend-agnostic NormalizedMessage list so Claude and Codex transcripts
// look identical to this layer. Per-backend fork mechanics
// (Claude: SDK forkSession at predecessor; Codex: thread/fork +
// thread/rollback) hide behind backend.forkSessionBeforeMessage.
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
  // Synchronous claim — see sendRunMessage. Without this,
  // getSessionMessages + forkSessionBeforeMessage below would race against
  // a second concurrent submission.
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
      "Cannot edit: the original run never reached backend init.",
    );
    return;
  }
  try {
    validateCwd(run.cwdSnapshot);
  } catch (err) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Cannot edit: cwd is invalid: ${errMessage(err)}`,
    );
    return;
  }
  const precheckError = checkResumableSession(run, leaf);
  if (precheckError) {
    emitRunErrorEntry(jobId, runId, `Cannot edit: ${precheckError}`);
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
  const backend = getBackend(run.agentTypeSnapshot);

  // 1. Locate the target log entry in the run's transcript (with ancestry).
  const oldEntries = loadRunLogWithAncestors(jobId, runId, leaf);
  const targetEntry = oldEntries.find((e) => e.id === logEntryId);
  if (!targetEntry || targetEntry.kind !== "user_message") {
    emitRunErrorEntry(jobId, runId, "Cannot edit: message not found.");
    return;
  }

  // 2. Match the target to a position in the backend session's message list.
  //    Uses NormalizedMessage (role + text + uuid) so the matching is engine-
  //    agnostic — Claude and Codex both surface user turns identically here.
  let sessionMessages: Awaited<ReturnType<typeof backend.getSessionMessages>>;
  try {
    sessionMessages = await backend.getSessionMessages(leaf, run.cwdSnapshot);
  } catch (err) {
    emitRunErrorEntry(
      jobId,
      runId,
      `Failed to load session messages: ${errMessage(err)}`,
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
  // Skip the cronjob's original prompt: it's the backend's first user message
  // but not a LogEntry, so its content will never match (it's stored only as
  // run.promptSnapshot). occurrenceIndex therefore counts from the first
  // post-prompt user message — i.e. the first follow-up turn.
  const cronjobPromptIsFirstUser = sessionMessages[0]?.role === "user";
  let matchCount = 0;
  let targetIdx = -1;
  for (
    let i = cronjobPromptIsFirstUser ? 1 : 0;
    i < sessionMessages.length;
    i++
  ) {
    const m = sessionMessages[i];
    if (m.role !== "user") continue;
    if (m.text === prefixedContent) {
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
      "Cannot edit: could not locate message in backend session.",
    );
    return;
  }

  // 3. Ask the backend to fork before the target message. Each backend
  //    handles its own fork mechanics:
  //      Claude: SDK forkSession at predecessor (excludes target)
  //      Codex:  thread/fork parent + thread/rollback child by N turns
  //    The result is either a linked fork (returns { sessionId,
  //    forkedFromSessionId }) or a fresh session (no id yet — fills on
  //    system_init). Cron only supports the linked-fork path because the
  //    "fresh" branch would lose the run's identity; if a backend returns
  //    "fresh" here, surface it as an error.
  const targetMessageId = sessionMessages[targetIdx].uuid;
  let newSessionId: string;
  try {
    const forkResult = await backend.forkSessionBeforeMessage(
      leaf,
      targetMessageId,
    );
    if (forkResult.kind !== "fork") {
      emitRunErrorEntry(
        jobId,
        runId,
        "Cannot edit: backend returned a fresh session (no linked fork).",
      );
      return;
    }
    newSessionId = forkResult.sessionId;
  } catch (err) {
    emitRunErrorEntry(jobId, runId, `Fork failed: ${errMessage(err)}`);
    return;
  }

  // 4. Resume the new fork. If this fails, do NOT update currentSessionId —
  //    leave the run pointing at the old leaf so a retry can start over.
  let session: BackendSession;
  try {
    session = backend.resumeSession(
      newSessionId,
      buildRunSessionOptions(run, newSessionId),
    );
  } catch (err) {
    emitRunErrorEntry(jobId, runId, `Failed to start fork: ${errMessage(err)}`);
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
  void (async () => {
    try {
      await session.send(prefixedText);
    } catch (err) {
      if (active.killed) return;
      console.error(`Cronjob run ${runId} edit-send error:`, errMessage(err));
      writeLog(
        active,
        "error",
        `Failed to send edited message: ${errMessage(err)}`,
      );
      try {
        session.close();
      } catch {}
      finalizeRun(active, "failed", errMessage(err));
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
  // userid migration: legacy cronjobs had only a `username` snapshot for
  // identity. Resolve to the stable user.id so env selection from now on
  // goes through buildEnvForUserId(job.userId), unaffected by renames.
  let cronjobsMigrated = 0;
  for (const job of cronjobs) {
    if (typeof job.userId === "string" && job.userId) continue;
    if (job.username) {
      const owner = getUserByName(job.username);
      job.userId = owner?.id ?? null;
      if (!owner) {
        console.log(
          `[migration] cronjob "${job.name}" (username="${job.username}") has no matching user record; runs unowned`,
        );
      }
    } else {
      job.userId = null;
    }
    cronjobsMigrated++;
  }
  if (cronjobsMigrated > 0) {
    // Persist the upgraded shape so next boot doesn't re-run the
    // migration on every record.
    saveCronjobs(cronjobs);
  }
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
