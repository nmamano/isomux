// Backends resource handler. The model picker on the
// unified REST surface (opId backends.listModels). agent:manage + authenticated:
// any caller who can spawn may enumerate a backend's models; AGENT scope lacks
// agent:manage and is rejected at stage 1.
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
// LEAF over the executor + shared types. Only the injected BackendsDeps.

import { ok, fail, type RouteHandler } from "../executor.ts";
import type { BackendModelWire } from "../../../shared/types.ts";

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
}

export function backendsHandlers(
  deps: BackendsDeps,
): Record<string, RouteHandler> {
  return {
    "backends.listModels": async (ctx) => {
      // agent:manage is USER-only, so a valid caller always carries a userId;
      // fail closed if somehow absent rather than resolve env for nobody.
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
