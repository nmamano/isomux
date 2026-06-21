// Cronjob resource handlers — Phase 3a slice 2. Cronjob metadata + runs on the
// unified REST surface (opIds cron.list/get/create/update/delete/runNow/setPrompt
// /listRuns/listAllRuns/getRun). The run-message + RUN-bearer affordance handlers
// live alongside these once 3a.2b lands.
//
// Strangler EXPAND: these REST handlers + the legacy /cronjobs HTTP reads + the
// WS add/update/delete/run/prompt arms all delegate to the SAME CronjobManager
// core ops (injected via CronDeps). The manager emits the cronjob_* / run-state
// domain events, which the wireEventSinks sink routes through the emit() helper
// (audience `all`). Handlers never emit directly.
//
// [behavior-change] cron.update/delete/runNow tighten to cronjobOwnerOrOfficeOwner
// and cron.setPrompt to officeOwner (today neither has a role check). The REST
// routes enforce via authorize(); the legacy WS arms enforce the SAME assertion
// at the shared boundary (server/index.ts wsCanMutateCronjob / wsIsOfficeOwner)
// so the strangler leaves no WS-path bypass.
//
// LEAF over the executor + shared types. Only the injected CronDeps surface.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { Cronjob, CronjobRun, LogEntry } from "../../../shared/types.ts";
import type {
  CronCreateReq,
  CronUpdateReq,
  CronPromptReq,
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
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  // Returns an error message if the cwd is invalid, or null if it is fine.
  validateCwd(cwd: string): string | null;
  saveRecentCwd(cwd: string): void;
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
      // route guard. Re-validate cwd if it's being changed (parity with the WS arm).
      const body = (ctx.body ?? {}) as CronUpdateReq;
      if (body.cwd !== undefined) {
        const cwdErr = deps.validateCwd(body.cwd);
        if (cwdErr) return fail(400, "invalid_cwd", cwdErr);
        deps.saveRecentCwd(body.cwd);
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

    "cron.listAllRuns": () => ok({ jobs: deps.allRunsByJob() }),

    "cron.getRun": (ctx) => {
      const { run, entries } = deps.runTranscript(
        ctx.params.id,
        ctx.params.runId,
      );
      return run ? ok({ run, entries }) : fail(404, "not_found");
    },
  };
}
