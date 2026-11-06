// The rescue routes inside the office (task cdd7883d, slice 4): the lockdown
// route and the owner export. server/office-lockdown-route.ts and
// server/office-export-jobs.ts hold the logic.

import { basename } from "node:path";
import { fail, file, ok, type RouteHandler } from "../executor";
import type { Identity } from "../../identity/index.ts";
import { requireAuditContext } from "../../audit-context.ts";
import {
  lockOfficeFromRoute,
  type OfficeLockdownDeps,
} from "../../office-lockdown-route.ts";
import type { OfficeExportJobs } from "../../office-export-jobs.ts";

export interface RescueHandlerDeps {
  lockdown: OfficeLockdownDeps;
  exports: OfficeExportJobs;
  /** The marker's `by`: the member's name, or "<agent> for <manager>". */
  byName(identity: Identity): string;
}

export function rescueHandlers(
  deps: RescueHandlerDeps,
): Record<string, RouteHandler> {
  return {
    "office.lockdown": (ctx) => {
      const body = ctx.body;
      const reason =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { reason?: unknown }).reason
          : undefined;
      const result = lockOfficeFromRoute(deps.lockdown, {
        reason,
        by: deps.byName(ctx.identity),
        actor: requireAuditContext().actor,
      });
      if (result.ok) return ok({ locked: true }, 202);
      return result.status === 422
        ? fail(422, "invalid_request", result.message)
        : fail(500, "lock_failed", result.message);
    },
    "office.startExport": () => {
      const result = deps.exports.start();
      if (result.ok) return ok({ id: result.id }, 202);
      return result.status === 409
        ? fail(409, "export_running", result.message)
        : fail(500, "export_failed", result.message);
    },
    "office.exportStatus": (ctx) => {
      const status = deps.exports.status(ctx.params.id);
      return status
        ? ok(status)
        : fail(404, "not_found", "No such export, or it expired.");
    },
    "office.downloadExport": (ctx) => {
      const path = deps.exports.file(ctx.params.id);
      if (!path)
        return fail(404, "not_found", "No such export, or it expired.");
      return file(path, "application/gzip", {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${basename(path)}"`,
        "X-Content-Type-Options": "nosniff",
      });
    },
  };
}
