// Cronjob resource handlers. Cronjob metadata + runs on the
// unified REST surface (opIds cron.list/get/create/update/delete/runNow/setPrompt
// /listRuns/listAllRuns/getRun). The run-message + RUN-bearer affordance handlers
// live alongside these once 3a.2b lands.
//
// These handlers are the ONLY cronjob surface: the legacy /cronjobs HTTP reads
// that shared these CronjobManager core ops (injected via CronDeps) are retired,
// as are the WS command arms, across 3d.3 (run-messages), 3d.4 (config muts) and
// the legacy-routes retirement (the reads).
// The manager emits the cronjob_* / run-state domain events, which the
// wireEventSinks sink routes through the emit() helper (audience `all`).
// Handlers never emit directly.
//
// [behavior-change] cron.update/delete/runNow tighten to cronjobOwnerOrOfficeOwner
// and cron.setPrompt to officeOwner (the legacy WS arms had no role check). The
// REST routes are now the SOLE path and enforce via authorize(); the WS command
// arms (and their wsCanMutateCronjob / wsIsOfficeOwner shims) were retired in 3d.4.
//
// LEAF over the executor, shared types and the schedule limits
// (cron-agent-limits.ts). Only the injected CronDeps surface.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import {
  instructionsConflict,
  instructionsRes,
  parseInstructionsWrite,
} from "./instructions.ts";
import { cronOwnOnly, type Identity } from "../../identity/index.ts";
import {
  SCHEDULE_EXCEEDS_AGENT,
  SCHEDULE_ROOM_REFUSAL,
  scheduleExceedsAgent,
  type ScheduleLimitAgent,
  type ScheduleLimitJob,
} from "../../cron-agent-limits.ts";
import type { RunSendResult } from "../../internal-types.ts";
import { USER_CLIENT_MESSAGE_ID_MAX } from "../../user-send-dedupe.ts";
import {
  MIN_INTERVAL_MINUTES,
  type Cronjob,
  type CronjobListWire,
  type CronjobRun,
  type LogEntry,
} from "../../../shared/types.ts";
import type {
  CronCreateReq,
  CronUpdateReq,
  CronPromptReq,
  CronRunMessageReq,
  EditMessageReq,
  AffordanceReadFileReq,
  AffordanceDiffReq,
} from "../../../shared/contract-shapes.ts";

export interface CronDeps {
  listCronjobs(): Cronjob[];
  // The jobs this caller may see (server/cronjob-visibility.ts), each with
  // the caller's canManage.
  listCronjobsFor(identity: Identity): CronjobListWire[];
  projectCronjobFor(
    identity: Identity,
    cronjob: Cronjob,
  ): CronjobListWire | null;
  // May this caller see the job, its runs and its system prompt? A job that
  // is gone keeps only office owners.
  visibleTo(identity: Identity, jobId: string): boolean;
  // Room ids this caller may file a cronjob into: live rooms they can access.
  assignableRoomIds(identity: Identity): ReadonlySet<string>;
  // The room a create with no roomId defaults to: an agent caller's own room.
  defaultCreateRoomId(identity: Identity): string | undefined;
  // The live settings of the agent whose reach the caller has (the agent, or
  // an app's owner agent), for the limits on its own schedules. Null when that
  // agent is gone or the caller acts for no agent.
  ownScheduleLimits(
    identity: Identity,
  ): (ScheduleLimitAgent & { roomId: string }) | null;
  buildCronjobSystemPrompt(cronjob: Cronjob): string;
  createCronjob(input: {
    name: string;
    schedule: Cronjob["schedule"];
    prompt: string;
    cwd: string;
    agentType?: Cronjob["agentType"];
    modelFamily: Cronjob["modelFamily"];
    effort: Cronjob["effort"];
    permissionMode: Cronjob["permissionMode"];
    codexSandbox?: Cronjob["codexSandbox"];
    username: string | undefined;
    userId: string | null;
    roomId: string | undefined;
    createdByAgentId?: string;
  }): Promise<Cronjob>;
  updateCronjob(id: string, changes: CronUpdateReq): Promise<Cronjob | null>;
  deleteCronjob(id: string): boolean;
  // The instructions every schedule run gets (null: none).
  getPrompt(): string | null;
  setPrompt(value: string | null): void;
  runNow(id: string, username: string): CronjobRun | null;
  runsForCronjob(jobId: string): CronjobRun[];
  allRunsByJob(): { jobId: string; runs: CronjobRun[] }[];
  runTranscript(
    jobId: string,
    runId: string,
  ): { run: CronjobRun | null; entries: LogEntry[] };
  // 3a.2b - run-message + RUN-affordance core ops (run-message WS arms retired in
  // 3d.3; the RUN-bearer affordance handlers remain). Run-messages are fire-and-forget
  // (the turn streams in the background); the REST handler threads a boundary
  // `messageId` so the persisted/broadcast user_message entry id === the ack.
  // The affordance ops return the manager's own { ok } | { ok:false,status,error }
  // shape (status is only ever 400 bad-input / 404 unknown-or-inactive run).
  findRun(jobId: string, runId: string): CronjobRun | null;
  sendRunMessage(
    jobId: string,
    runId: string,
    text: string,
    username: string | undefined,
    device: string | undefined,
    opts: { messageId?: string; clientMessageId?: string },
  ): Promise<RunSendResult>;
  editRunMessage(
    jobId: string,
    runId: string,
    logEntryId: string,
    newText: string,
    username: string | undefined,
    device: string | undefined,
    opts: { messageId?: string },
  ): void;
  emitCronjobRunReadFile(
    jobId: string,
    runId: string,
    path: string,
  ): { ok: true } | { ok: false; status: number; code?: string; error: string };
  emitCronjobRunDiff(
    jobId: string,
    runId: string,
    dir: string | undefined,
    commit: string | undefined,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  validateCwd(cwd: string): string | null;
  saveRecentCwd(cwd: string): void;
  modelFamilyError(
    agentType: Cronjob["agentType"],
    modelFamily: string | undefined,
  ): string | null;
}

// The roomId field, task semantics. `undefined` = the body has no roomId; ""
// = no room; any other value must be a live room the caller can access, and an
// inaccessible or unknown room is one indistinguishable 404.
function roomIdFromBody(
  body: object,
  identity: Identity,
  deps: CronDeps,
):
  | { ok: true; roomId: string | undefined }
  | { ok: false; response: ReturnType<typeof fail> } {
  if (!Object.prototype.hasOwnProperty.call(body, "roomId")) {
    return { ok: true, roomId: undefined };
  }
  const raw = (body as { roomId?: unknown }).roomId;
  if (typeof raw !== "string") {
    return {
      ok: false,
      response: fail(400, "invalid_request", "roomId must be a string"),
    };
  }
  if (raw.length === 0 || deps.assignableRoomIds(identity).has(raw)) {
    return { ok: true, roomId: raw };
  }
  return { ok: false, response: fail(404, "not_found") };
}

// Why a schedule in a request body is not one of the four shapes, naming the
// field; null when it is. Extra keys are ignored. Out-of-range and non-integer
// values are refused, not clamped, so what is stored is what was sent.
function scheduleError(schedule: unknown): string | null {
  if (typeof schedule !== "object" || schedule === null) {
    return "schedule must be an object";
  }
  const s = schedule as Record<string, unknown>;
  const intIn = (field: string, min: number, max: number): string | null => {
    const v = s[field];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max)
      return null;
    return max === Infinity
      ? `schedule.${field} must be an integer of at least ${min}`
      : `schedule.${field} must be an integer from ${min} to ${max}`;
  };
  const time = () => intIn("hour", 0, 23) ?? intIn("minute", 0, 59);
  switch (s.type) {
    case "none":
      return null;
    case "interval":
      return intIn("minutes", MIN_INTERVAL_MINUTES, Infinity);
    case "daily":
      return time();
    case "weekly":
      return intIn("weekday", 0, 6) ?? time();
    default:
      return 'schedule.type must be "daily", "weekly", "interval" or "none"';
  }
}

// An ordinary agent's limits on a schedule it made (task c4233bfd): the
// refusal when the job, as it would be, reaches more than the agent's current
// mode or folder, or when a request sets a room other than the agent's own.
// Null for every other caller, and within the limits.
function ownScheduleRefusal(
  identity: Identity,
  deps: CronDeps,
  job: ScheduleLimitJob,
  roomId?: string,
): ReturnType<typeof fail> | null {
  if (!cronOwnOnly(identity)) return null;
  const limits = deps.ownScheduleLimits(identity);
  if (!limits) return fail(404, "not_found");
  if (roomId !== undefined && roomId !== "" && roomId !== limits.roomId)
    return fail(403, SCHEDULE_EXCEEDS_AGENT, SCHEDULE_ROOM_REFUSAL);
  const reason = scheduleExceedsAgent(job, limits);
  return reason === null ? null : fail(403, SCHEDULE_EXCEEDS_AGENT, reason);
}

// Turning a job off only narrows it, as a delete does.
function onlyTurnsOff(body: CronUpdateReq): boolean {
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "enabled" && body.enabled === false;
}

function jobById(deps: CronDeps, id: string | undefined): Cronjob | undefined {
  return deps.listCronjobs().find((cronjob) => cronjob.id === id);
}

export function cronHandlers(deps: CronDeps): Record<string, RouteHandler> {
  // A run started or steered by an ordinary agent: the job as it is must be
  // within the agent's current limits.
  const runRefusal = (identity: Identity, jobId: string | undefined) => {
    if (!cronOwnOnly(identity)) return null;
    const job = jobById(deps, jobId);
    return job
      ? ownScheduleRefusal(identity, deps, job)
      : fail(404, "not_found");
  };
  return {
    "cron.list": (ctx) => ok(deps.listCronjobsFor(ctx.identity)),

    // A job the caller may not see is the same 404 as an unknown id.
    "cron.get": (ctx) => {
      const job = deps.listCronjobs().find((c) => c.id === ctx.params.id);
      const projected = job ? deps.projectCronjobFor(ctx.identity, job) : null;
      return projected ? ok(projected) : fail(404, "not_found");
    },

    "cron.readSystemPrompt": (ctx) => {
      const job = deps.listCronjobs().find((c) => c.id === ctx.params.id);
      return job && deps.visibleTo(ctx.identity, job.id)
        ? ok({
            systemPrompt: deps.buildCronjobSystemPrompt(job),
            firstUserMessage: job.prompt,
          })
        : fail(404, "not_found");
    },

    "cron.create": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<CronCreateReq>;
      if (typeof body.name !== "string" || body.name.length === 0) {
        return fail(400, "invalid_request", "name is required");
      }
      if (typeof body.prompt !== "string") {
        return fail(400, "invalid_request", "prompt is required");
      }
      if (typeof body.cwd !== "string" || body.cwd.length === 0) {
        return fail(400, "invalid_request", "cwd is required");
      }
      if (body.schedule === undefined || body.modelFamily === undefined) {
        return fail(
          400,
          "invalid_request",
          "schedule and modelFamily are required",
        );
      }
      const shapeErr = scheduleError(body.schedule);
      if (shapeErr) return fail(422, "invalid_request", shapeErr);
      if (body.effort === undefined || body.permissionMode === undefined) {
        return fail(
          400,
          "invalid_request",
          "effort and permissionMode are required",
        );
      }
      const cwdErr = deps.validateCwd(body.cwd);
      if (cwdErr) return fail(400, "invalid_cwd", cwdErr);
      const familyErr = deps.modelFamilyError(
        body.agentType ?? "claude",
        body.modelFamily,
      );
      if (familyErr) return fail(422, "invalid_model_family", familyErr);
      const room = roomIdFromBody(body, ctx.identity, deps);
      if (!room.ok) return room.response;
      const refusal = ownScheduleRefusal(
        ctx.identity,
        deps,
        {
          agentType: body.agentType ?? "claude",
          codexSandbox: body.codexSandbox,
          cwd: body.cwd,
        },
        room.roomId,
      );
      if (refusal) return refusal;
      deps.saveRecentCwd(body.cwd);
      const { username } = deps.attributionFor(ctx.identity);
      const job = await deps.createCronjob({
        name: body.name,
        schedule: body.schedule,
        prompt: body.prompt,
        cwd: body.cwd,
        agentType: body.agentType,
        modelFamily: body.modelFamily,
        effort: body.effort,
        permissionMode: body.permissionMode,
        codexSandbox: body.codexSandbox,
        username,
        userId: ctx.identity.userId,
        ...(ctx.identity.scope === "agent" && ctx.identity.agentId
          ? { createdByAgentId: ctx.identity.agentId }
          : {}),
        roomId:
          room.roomId === undefined
            ? deps.defaultCreateRoomId(ctx.identity)
            : room.roomId || undefined,
      });
      // The creator is the maker, so the projection is the whole record; a
      // null here would be a rule bug, and it must not fall back to the raw job.
      const projected = deps.projectCronjobFor(ctx.identity, job);
      return projected
        ? created(projected)
        : fail(500, "internal_error", "created schedule is not visible");
    },

    "cron.update": async (ctx) => {
      // Authorization (cronjobOwnerOrOfficeOwner) was already enforced by the
      // route guard. Re-validate cwd if it's being changed (the now-retired WS
      // arm did the same).
      const body = (ctx.body ?? {}) as CronUpdateReq;
      if (body.schedule !== undefined) {
        const shapeErr = scheduleError(body.schedule);
        if (shapeErr) return fail(422, "invalid_request", shapeErr);
      }
      const room = roomIdFromBody(body, ctx.identity, deps);
      if (!room.ok) return room.response;
      if (body.cwd !== undefined) {
        const cwdErr = deps.validateCwd(body.cwd);
        if (cwdErr) return fail(400, "invalid_cwd", cwdErr);
      }
      if (body.modelFamily !== undefined || body.agentType !== undefined) {
        const existing = deps
          .listCronjobs()
          .find((cronjob) => cronjob.id === ctx.params.id);
        if (!existing) return fail(404, "not_found");
        const familyErr = deps.modelFamilyError(
          body.agentType ?? existing.agentType,
          body.modelFamily,
        );
        if (familyErr) return fail(422, "invalid_model_family", familyErr);
      }
      if (!onlyTurnsOff(body) && cronOwnOnly(ctx.identity)) {
        const existing = jobById(deps, ctx.params.id);
        if (!existing) return fail(404, "not_found");
        const refusal = ownScheduleRefusal(
          ctx.identity,
          deps,
          {
            agentType: body.agentType ?? existing.agentType,
            codexSandbox: Object.prototype.hasOwnProperty.call(
              body,
              "codexSandbox",
            )
              ? body.codexSandbox
              : existing.codexSandbox,
            cwd: body.cwd ?? existing.cwd,
          },
          room.roomId,
        );
        if (refusal) return refusal;
      }
      if (body.cwd !== undefined) deps.saveRecentCwd(body.cwd);
      const { roomId: _roomId, ...rest } = body;
      const job = await deps.updateCronjob(ctx.params.id, {
        ...rest,
        ...(room.roomId !== undefined ? { roomId: room.roomId } : {}),
      });
      const projected = job ? deps.projectCronjobFor(ctx.identity, job) : null;
      return projected ? ok(projected) : fail(404, "not_found");
    },

    "cron.delete": (ctx) =>
      deps.deleteCronjob(ctx.params.id) ? noContent() : fail(404, "not_found"),

    "cron.runNow": (ctx) => {
      const refusal = runRefusal(ctx.identity, ctx.params.id);
      if (refusal) return refusal;
      const { username } = deps.attributionFor(ctx.identity);
      const run = deps.runNow(ctx.params.id, username ?? "unknown");
      return run ? ok({ runId: run.id }) : fail(404, "not_found");
    },

    // The schedule instructions: the same store as cron.setPrompt, the old
    // name kept for one release. The version guards one owner tab's write
    // against another's. Check-then-write is atomic on the event loop.
    "cron.readInstructions": () => ok(instructionsRes(deps.getPrompt())),

    "cron.setInstructions": (ctx) => {
      const input = parseInstructionsWrite(ctx.body);
      if (!input.ok) return input.result;
      const current = instructionsRes(deps.getPrompt());
      if (input.version !== current.version)
        return instructionsConflict(current.version);
      deps.setPrompt(input.instructions);
      return ok(instructionsRes(deps.getPrompt()));
    },

    "cron.setPrompt": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<CronPromptReq>;
      const value =
        typeof body.value === "string" && body.value.length > 0
          ? body.value
          : null;
      deps.setPrompt(value);
      return noContent();
    },

    "cron.listRuns": (ctx) =>
      deps.visibleTo(ctx.identity, ctx.params.id)
        ? ok({ runs: deps.runsForCronjob(ctx.params.id) })
        : fail(404, "not_found"),

    // Map the manager's internal `jobId` to the public `cronjobId` so the wire
    // matches the documented contract and the rest of the cron surface (every
    // other cron field identifies a cronjob by `cronjobId`).
    // Only jobs the caller may see.
    "cron.listAllRuns": (ctx) =>
      ok({
        jobs: deps
          .allRunsByJob()
          .filter((j) => deps.visibleTo(ctx.identity, j.jobId))
          .map((j) => ({ cronjobId: j.jobId, runs: j.runs })),
      }),

    "cron.getRun": (ctx) => {
      if (!deps.visibleTo(ctx.identity, ctx.params.id)) {
        return fail(404, "not_found");
      }
      const { run, entries } = deps.runTranscript(
        ctx.params.id,
        ctx.params.runId,
      );
      return run ? ok({ run, entries }) : fail(404, "not_found");
    },

    // 3a.2b - run-messages. The manager threads our messageId into the
    // persisted user_message so the ack === the transcript entry id. The 200
    // means the message is in the run log (task 44872c41); every refusal
    // (unknown run, busy run, unresumable session, usage cap, resume failure)
    // is an HTTP error with its code, so the composer keeps the attempt. The
    // turn itself streams in the background. A clientMessageId resend of an
    // accepted attempt answers 200 with an empty messageId and sends nothing.
    // The cronjobOwnerOrOfficeOwner guard already ran.
    "cron.runMessage": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<CronRunMessageReq>;
      if (typeof body.text !== "string" || body.text.length === 0) {
        return fail(400, "invalid_request", "text is required");
      }
      if (
        body.clientMessageId !== undefined &&
        typeof body.clientMessageId !== "string"
      ) {
        return fail(422, "invalid_request", "clientMessageId must be a string");
      }
      if (
        body.clientMessageId !== undefined &&
        body.clientMessageId.length > USER_CLIENT_MESSAGE_ID_MAX
      ) {
        return fail(
          422,
          "invalid_client_message_id",
          `clientMessageId must be at most ${USER_CLIENT_MESSAGE_ID_MAX} characters.`,
        );
      }
      const { id: jobId, runId } = ctx.params;
      if (!deps.findRun(jobId, runId)) return fail(404, "not_found");
      const refusal = runRefusal(ctx.identity, jobId);
      if (refusal) return refusal;
      const messageId = crypto.randomUUID();
      const { username } = deps.attributionFor(ctx.identity);
      const device = typeof body.device === "string" ? body.device : undefined;
      const r = await deps.sendRunMessage(
        jobId,
        runId,
        body.text,
        username,
        device,
        { messageId, clientMessageId: body.clientMessageId },
      );
      if (!r.ok) return fail(r.status, r.code, r.message);
      return ok({ messageId: r.deduped ? "" : messageId });
    },

    "cron.editRunMessage": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<EditMessageReq>;
      if (typeof body.newText !== "string" || body.newText.length === 0) {
        return fail(400, "invalid_request", "newText is required");
      }
      const { id: jobId, runId, logEntryId } = ctx.params;
      if (!deps.findRun(jobId, runId)) return fail(404, "not_found");
      const refusal = runRefusal(ctx.identity, jobId);
      if (refusal) return refusal;
      const messageId = crypto.randomUUID();
      const { username } = deps.attributionFor(ctx.identity);
      const device = typeof body.device === "string" ? body.device : undefined;
      deps.editRunMessage(
        jobId,
        runId,
        logEntryId,
        body.newText,
        username,
        device,
        { messageId },
      );
      return ok({ messageId });
    },

    // RUN-bearer affordances (self:affordance + runParamMustEqualTokenRun). The
    // manager op surfaces the file/diff card into the LIVE run transcript and
    // returns its own active-run 404 / bad-input 400; map it straight through.
    "cron.runReadFile": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordanceReadFileReq>;
      if (typeof body.path !== "string" || body.path.length === 0) {
        return fail(400, "invalid_request", "path is required");
      }
      const r = deps.emitCronjobRunReadFile(
        ctx.params.id,
        ctx.params.runId,
        body.path,
      );
      return r.ok
        ? ok({ ok: true })
        : fail(
            r.status as HandlerErrorStatus,
            r.code ?? "run_read_file_failed",
            r.error,
          );
    },

    "cron.runDiff": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordanceDiffReq>;
      const dir = typeof body.dir === "string" ? body.dir : undefined;
      const commit = typeof body.commit === "string" ? body.commit : undefined;
      const r = await deps.emitCronjobRunDiff(
        ctx.params.id,
        ctx.params.runId,
        dir,
        commit,
      );
      return r.ok
        ? ok({ ok: true })
        : fail(r.status as HandlerErrorStatus, "run_diff_failed", r.error);
    },
  };
}
