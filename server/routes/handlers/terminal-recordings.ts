// Terminal recordings (task 749cb7fd): the list and the file. The readers are
// the audit log's (route table: audit:read + auditOwner). The file goes out as
// a download a browser never renders: a recording holds bytes any member
// could print.

import { existsSync } from "node:fs";
import {
  listTerminalRecordings,
  terminalRecordingPath,
} from "../../terminal-recorder.ts";
import { fail, file, ok, type RouteHandler } from "../executor.ts";

export function terminalRecordingHandlers(): Record<string, RouteHandler> {
  return {
    "terminalRecordings.list": (ctx) => {
      const agentId = ctx.query.get("agentId");
      return ok({
        items: listTerminalRecordings(agentId === null ? {} : { agentId }),
      });
    },
    "terminalRecordings.get": (ctx) => {
      const path = terminalRecordingPath(ctx.params.id);
      if (path === null || !existsSync(path))
        return fail(404, "not_found", "No such terminal recording.");
      return file(path, "application/x-asciicast", {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="${ctx.params.id}.cast"`,
      });
    },
  };
}
