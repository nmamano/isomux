// Backends resource handler. The model picker on the
// unified REST surface (opId backends.listModels). agent:manage or agent:spawn:
// any caller who can spawn may enumerate a backend's models (task e340753f).
// An agent without agent:manage lists only where it may spawn: below full
// reach, cwd must be its working folder or an existing folder inside it, the
// spawn folder rule (spawn-agent-limits.ts), checked before any backend starts.
//
// POST /api/backends/:agentType/models with JSON {cwd, includeHidden?}. A POST
// because the listing can start a backend and, for OpenCode, load cwd's project
// config: the Origin check refuses a request from another site (task 77ec7e9d).
// The shared core (listBackendModels in the index seam) resolves the per-user
// env stack (buildEnvForUserId) and checks the cwd (validateCwd) EXACTLY like a
// real spawn, so OPENAI_API_KEY / CHATGPT_LOGIN overrides from office/user env
// files are reflected, and on failure flags backend-specific auth errors
// (detectAuthError) so the UI can render login instructions instead of a generic
// "failed to load".
//
// LEAF over the executor, shared types and two pure imports: identity/index.ts
// (identityHasCapability) and spawn-agent-limits.ts (hasFullReach,
// SPAWN_EXCEEDS_AGENT). The agent record and the folder check come in through
// BackendsDeps.

import { ok, fail, type RouteHandler } from "../executor.ts";
import type { AgentInfo, BackendModelWire } from "../../../shared/types.ts";
import { identityHasCapability } from "../../identity/index.ts";
import { hasFullReach, SPAWN_EXCEEDS_AGENT } from "../../spawn-agent-limits.ts";

export interface BackendsDeps {
  listModels(input: {
    agentType: string;
    cwd: string;
    includeHidden: boolean;
    userId: string;
  }): Promise<
    | { ok: true; models: BackendModelWire[] }
    | { ok: false; error: string; authError: boolean }
  >;
  getAgent(id: string): AgentInfo | undefined;
  // folderInsideFor (cron-agent-limits.ts): false for a missing folder.
  folderInsideFor(
    cwd: string,
    agentCwd: string,
    userId: string | null,
  ): Promise<boolean>;
}

export function backendsHandlers(
  deps: BackendsDeps,
): Record<string, RouteHandler> {
  return {
    "backends.listModels": async (ctx) => {
      // Every caller acts for a member; fail closed if somehow absent rather
      // than resolve env for nobody.
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as {
        cwd?: unknown;
        includeHidden?: unknown;
      };
      // An empty cwd would resolve to the server's own working directory, a
      // folder the caller never named.
      if (typeof body.cwd !== "string" || body.cwd === "") {
        return fail(
          422,
          "invalid_request",
          "cwd (non-empty string) is required",
        );
      }
      if (
        body.includeHidden !== undefined &&
        typeof body.includeHidden !== "boolean"
      ) {
        return fail(422, "invalid_request", "includeHidden must be a boolean");
      }
      // The spawn gate (handlers/agents.ts agents.spawn): an agent without
      // agent:manage lists only from its own live record, and below full reach
      // only in its folder.
      if (
        ctx.identity.scope === "agent" &&
        !identityHasCapability(ctx.identity, "agent:manage")
      ) {
        const agent = ctx.identity.agentId
          ? deps.getAgent(ctx.identity.agentId)
          : undefined;
        if (!agent) return fail(403, "forbidden");
        if (
          !hasFullReach(agent) &&
          !(await deps.folderInsideFor(body.cwd, agent.cwd, userId))
        ) {
          return fail(
            403,
            SPAWN_EXCEEDS_AGENT,
            "List models in your working folder or an existing folder inside it.",
          );
        }
      }
      const r = await deps.listModels({
        agentType: ctx.params.agentType ?? "",
        cwd: body.cwd,
        includeHidden: body.includeHidden ?? false,
        userId,
      });
      return r.ok
        ? ok({ models: r.models })
        : ok({ models: [], authError: r.authError, error: r.error });
    },
  };
}
