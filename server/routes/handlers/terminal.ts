// Terminal read surface - GET /api/agents/:id/terminal (opId agents.terminal).
// AUTH is `log:read` + liveAgentReadAccess (server/identity/guards.ts): an
// agent reads its own terminal and the terminal of any agent in a room its
// member can access. Read-only, so the route emits nothing.
//
// The output is the in-memory PTY buffer only (server/terminal.ts): a closed
// terminal or a server restart leaves nothing to read.

import { ok, fail, type RouteHandler } from "../executor.ts";
import type { TerminalReadRes } from "../../../shared/contract-shapes.ts";
import { terminalText } from "../../terminal-text.ts";

const MAX_LINES = 10_000;

export interface TerminalReadDeps {
  readTerminal(agentId: string): {
    open: boolean;
    raw: string;
    truncated: boolean;
  };
}

export function terminalReadHandlers(
  deps: TerminalReadDeps,
): Record<string, RouteHandler> {
  return {
    "agents.terminal": (ctx) => {
      const values = ctx.query.getAll("lines");
      let lines: number | undefined;
      if (values.length > 0) {
        const value = values.length === 1 ? values[0] : "";
        lines = /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
        if (!(lines <= MAX_LINES)) {
          return fail(
            400,
            "invalid_lines",
            `lines must be one integer from 1 to ${MAX_LINES}`,
          );
        }
      }
      const { open, raw, truncated } = deps.readTerminal(ctx.params.id);
      const res: TerminalReadRes = {
        open,
        output: terminalText(raw, { truncated, lines }),
        truncated,
      };
      return ok(res);
    },
  };
}
