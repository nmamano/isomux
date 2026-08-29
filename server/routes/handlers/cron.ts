// Cronjob resource handlers - Phase 3a slice 2. Cronjob metadata + runs on the
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
// LEAF over the executor + shared types. Only the injected CronDeps surface.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { Cronjob, CronjobRun, LogEntry } from "../../../shared/types.ts";
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
  }): Cronjob;
  updateCronjob(id: string, changes: CronUpdateReq): Cronjob | null;
  deleteCronjob(id: string): boolean;
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
    opts: { messageId?: string },
  ): void;
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
  ): { ok: true } | { ok: false; status: number; error: string };
  emitCronjobRunDiff(
    jobId: string,
    runId: string,
    dir: string | undefined,
    commit: string | undefined,
  ): { ok: true } | { ok: false; status: number; error: string };
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  // Returns an error message if the cwd is invalid, or null if it is fine.
  validateCwd(cwd: string): string | null;
  saveRecentCwd(cwd: string): void;
  modelFamilyError(
    agentType: Cronjob["agentType"],
    modelFamily: string | undefined,
  ): string | null;
}

export function cronHandlers(deps: CronDeps): Record<string, RouteHandler> {
  return {
    "cron.list": () => ok(deps.listCronjobs()),

    "cron.get": (ctx) => {
      const job = deps.listCronjobs().find((c) => c.id === ctx.params.id);
      return job ? ok(job) : fail(404, "not_found");
    },

    "cron.create": (ctx) => {
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
      deps.saveRecentCwd(body.cwd);
      const { username } = deps.attributionFor(ctx.identity);
      const job = deps.createCronjob({
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
      });
      return created(job);
    },

    "cron.update": (ctx) => {
      // Authorization (cronjobOwnerOrOfficeOwner) was already enforced by the
      // route guard. Re-validate cwd if it's being changed (the now-retired WS
      // arm did the same).
      const body = (ctx.body ?? {}) as CronUpdateReq;
      if (body.cwd !== undefined) {
        const cwdErr = deps.validateCwd(body.cwd);
        if (cwdErr) return fail(400, "invalid_cwd", cwdErr);
        deps.saveRecentCwd(body.cwd);
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
      const job = deps.updateCronjob(ctx.params.id, body);
      return job ? ok(job) : fail(404, "not_found");
    },

    "cron.delete": (ctx) =>
      deps.deleteCronjob(ctx.params.id) ? noContent() : fail(404, "not_found"),

    "cron.runNow": (ctx) => {
      const { username } = deps.attributionFor(ctx.identity);
      const run = deps.runNow(ctx.params.id, username ?? "unknown");
      return run ? ok({ runId: run.id }) : fail(404, "not_found");
    },

    "cron.setPrompt": (ctx) => {
      // Tightened to officeOwner via the route guard. value is string | null.
      const body = (ctx.body ?? {}) as Partial<CronPromptReq>;
      const value =
        typeof body.value === "string" && body.value.length > 0
          ? body.value
          : null;
      deps.setPrompt(value);
      return noContent();
    },

    "cron.listRuns": (ctx) => ok({ runs: deps.runsForCronjob(ctx.params.id) }),

    // Map the manager's internal `jobId` to the public `cronjobId` so the wire
    // matches the documented contract and the rest of the cron surface (every
    // other cron field identifies a cronjob by `cronjobId`). [3d slice 2]
    "cron.listAllRuns": () =>
      ok({
        jobs: deps
          .allRunsByJob()
          .map((j) => ({ cronjobId: j.jobId, runs: j.runs })),
      }),

    "cron.getRun": (ctx) => {
      const { run, entries } = deps.runTranscript(
        ctx.params.id,
        ctx.params.runId,
      );
      return run ? ok({ run, entries }) : fail(404, "not_found");
    },

    // 3a.2b - run-messages (fire-and-forget; the manager threads our messageId
    // into the persisted user_message so the ack === the eventual transcript
    // entry id). Resumability / cwd / provider errors stay transcript-level (not
    // HTTP) to preserve the original fire-and-forget contract; only an unknown run is a cheap
    // 404 pre-flight. The cronjobOwnerOrOfficeOwner guard already ran.
    "cron.runMessage": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<CronRunMessageReq>;
      if (typeof body.text !== "string" || body.text.length === 0) {
        return fail(400, "invalid_request", "text is required");
      }
      const { id: jobId, runId } = ctx.params;
      if (!deps.findRun(jobId, runId)) return fail(404, "not_found");
      const messageId = crypto.randomUUID();
      const { username } = deps.attributionFor(ctx.identity);
      const device = typeof body.device === "string" ? body.device : undefined;
      deps.sendRunMessage(jobId, runId, body.text, username, device, {
        messageId,
      });
      return ok({ messageId });
    },

    "cron.editRunMessage": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<EditMessageReq>;
      if (typeof body.newText !== "string" || body.newText.length === 0) {
        return fail(400, "invalid_request", "newText is required");
      }
      const { id: jobId, runId, logEntryId } = ctx.params;
      if (!deps.findRun(jobId, runId)) return fail(404, "not_found");
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
        : fail(r.status as HandlerErrorStatus, "run_read_file_failed", r.error);
    },

    "cron.runDiff": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordanceDiffReq>;
      const dir = typeof body.dir === "string" ? body.dir : undefined;
      const commit = typeof body.commit === "string" ? body.commit : undefined;
      const r = deps.emitCronjobRunDiff(
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
