// Agent self-affordance handlers. The agent-scope analogue
// of the cron RUN-affordances: read-file / diff / edit-file / terminal-command on
// the unified REST surface (opIds agents.readFile/diff/editFile/terminalCommand).
//
// AGENT bearer only: the mutating and chat-emitting routes use
// `self:affordance` + `agentParamMustEqualTokenAgent`, so an agent can act only
// on its own chat. The context and subscription reads use `log:read` +
// `logSearchAccess`, so they can inspect agents in rooms their manager can
// access. The route table owns both policies; handlers only run after a guard.
//
// Sole affordance surface: the legacy loopback HTTP handlers
// (/agents/:id/{read-file,diff,edit-file,terminal-command}) were DELETED in the
// loopback-bypass removal milestone. These REST handlers delegate to the same
// shared AgentManager core ops the legacy paths used; nothing else reaches them.
// (routes-affordances.test.ts asserts the deleted legacy paths now fail closed.)
//
// NO emit bridge (unlike cron): the manager already emits `log_entry` through the
// event sink, which routes it via routeAgentEvent / room-ACL projection. Handlers
// NEVER emit directly. Validation stays shallow - require path/command; the
// manager owns affordance semantics (terminal single-line, bad-path-as-system-log).
//
// LEAF over the executor + shared types. AgentAffordanceDeps is deliberately slim:
// JUST the affordance emit methods - no agent maps, rooms, or emit helpers.
// preview-url is the one async member: it runs a headless-
// browser capture (see preview-capture.ts) before emitting its file-view card.

import {
  ok,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type {
  AffordanceReadFileReq,
  AffordanceEditFileReq,
  AffordanceDiffReq,
  AffordanceTerminalCmdReq,
  AffordancePreviewUrlReq,
  AffordanceBrowserReq,
  AffordanceBrowserResp,
  AgentContextUsageResp,
  AgentSubscriptionUsageResp,
} from "../../../shared/contract-shapes.ts";

// The manager's affordance result: ok, or a failure carrying an HTTP-mappable
// status (only ever 400 bad-input / 404 unknown agent - the latter is unreachable
// via the new route, where the guard binds `:id` to the token's own agent).
type AffordanceResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

// preview-url's richer result: async (headless-browser capture), and the
// manager owns the per-failure `code` (invalid_request / capture_busy /
// no_browser / unreachable / capture_failed / save_failed / capture_timeout)
// instead of the handler passing a fixed one.
type PreviewAffordanceResult =
  | { ok: true }
  | { ok: false; status: number; code: string; error: string };

// The browser affordance answers with data, not just `ok`: an agent reads the
// page from the response. The screenshot action is the one that also leaves a
// card in the chat, and the manager owns that emit.
type BrowserAffordanceResult =
  | ({ ok: true } & AffordanceBrowserResp)
  | { ok: false; status: number; code: string; error: string };

export interface AgentAffordanceDeps {
  emitAgentReadFile(agentId: string, path: string): AffordanceResult;
  emitAgentDiff(
    agentId: string,
    dir: string | undefined,
    commit: string | undefined,
  ): AffordanceResult;
  emitAgentEditRequest(agentId: string, path: string): AffordanceResult;
  emitAgentTerminalCommand(agentId: string, command: string): AffordanceResult;
  emitAgentPreviewUrl(
    agentId: string,
    body: unknown,
  ): Promise<PreviewAffordanceResult>;
  runAgentBrowserAction(
    agentId: string,
    body: unknown,
  ): Promise<BrowserAffordanceResult>;
  // Context-fullness check. Never throws for "no data" - unavailability
  // is a structured { available: false, reason } payload, not an error.
  getAgentContextUsage(agentId: string): Promise<AgentContextUsageResp>;
  getAgentSubscriptionUsage(
    agentId: string,
  ): Promise<AgentSubscriptionUsageResp>;
}

// Map a manager AffordanceResult to a HandlerResult. Status is narrowed at the
// boundary (the manager only returns 400/404 for these ops).
function mapResult(
  r: AffordanceResult,
  code: string,
): ReturnType<RouteHandler> {
  return r.ok
    ? ok({ ok: true })
    : fail(r.status as HandlerErrorStatus, code, r.error);
}

export function agentAffordanceHandlers(
  deps: AgentAffordanceDeps,
): Record<string, RouteHandler> {
  return {
    "agents.readFile": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordanceReadFileReq>;
      if (typeof body.path !== "string" || body.path.length === 0) {
        return fail(400, "invalid_request", "path is required");
      }
      return mapResult(
        deps.emitAgentReadFile(ctx.params.id, body.path),
        "read_file_failed",
      );
    },

    "agents.editFile": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordanceEditFileReq>;
      if (typeof body.path !== "string" || body.path.length === 0) {
        return fail(400, "invalid_request", "path is required");
      }
      return mapResult(
        deps.emitAgentEditRequest(ctx.params.id, body.path),
        "edit_file_failed",
      );
    },

    "agents.diff": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordanceDiffReq>;
      const dir = typeof body.dir === "string" ? body.dir : undefined;
      const commit = typeof body.commit === "string" ? body.commit : undefined;
      return mapResult(
        deps.emitAgentDiff(ctx.params.id, dir, commit),
        "diff_failed",
      );
    },

    "agents.terminalCommand": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordanceTerminalCmdReq>;
      if (typeof body.command !== "string" || body.command.length === 0) {
        return fail(400, "invalid_request", "command is required");
      }
      // The single-line check lives in the manager op (returns 400); the handler
      // maps it 1:1, so manager-owned semantics stay the source of truth.
      return mapResult(
        deps.emitAgentTerminalCommand(ctx.params.id, body.command),
        "terminal_command_failed",
      );
    },

    "agents.previewUrl": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordancePreviewUrlReq>;
      if (typeof body.url !== "string" || body.url.length === 0) {
        return fail(400, "invalid_request", "url is required");
      }
      // Full validation (URL shape, host policy, viewport/wait ranges) lives in
      // the manager op / preview-capture; the handler stays shallow. Unexpected
      // rejections are pinned to a structured 500 here rather than falling
      // through to the executor's generic internal-error path.
      try {
        const r = await deps.emitAgentPreviewUrl(ctx.params.id, ctx.body);
        return r.ok
          ? ok({ ok: true })
          : fail(r.status as HandlerErrorStatus, r.code, r.error);
      } catch (err) {
        console.error("[agents.previewUrl] unexpected rejection:", err);
        return fail(500, "capture_failed", "unexpected error during capture");
      }
    },

    "agents.browser": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AffordanceBrowserReq>;
      if (typeof body.action !== "string" || body.action.length === 0) {
        return fail(400, "invalid_request", "action is required");
      }
      // Full validation (the action name, its own required fields, the URL
      // rules, viewport ranges) lives in browser-actions.ts; the handler stays
      // shallow, like previewUrl above.
      try {
        const r = await deps.runAgentBrowserAction(ctx.params.id, ctx.body);
        if (!r.ok) return fail(r.status as HandlerErrorStatus, r.code, r.error);
        const { ok: _ok, ...payload } = r;
        return ok({ ok: true, ...payload });
      } catch (err) {
        console.error("[agents.browser] unexpected rejection:", err);
        return fail(500, "action_failed", "unexpected error in the browser");
      }
    },

    "agents.contextUsage": async (ctx) =>
      // GET, no body. The manager op owns all semantics (live attempt with
      // snapshot fallback, availability reasons); unavailability is a 200 with
      // { available: false } so callers branch on the payload, not on status.
      ok(await deps.getAgentContextUsage(ctx.params.id)),
    "agents.subscriptionUsage": async (ctx) =>
      ok(await deps.getAgentSubscriptionUsage(ctx.params.id)),
  };
}
