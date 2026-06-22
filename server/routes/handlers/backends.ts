// Backends resource handler — Phase 3a slice 3a.5. The model picker on the
// unified REST surface (opId backends.listModels). agent:manage + authenticated:
// any caller who can spawn may enumerate a backend's models; AGENT scope lacks
// agent:manage and is rejected at stage 1.
//
// GET /api/backends/:agentType/models?cwd=&includeHidden= . The shared core
// (listBackendModels in the index seam) resolves the per-user env stack
// (buildEnvForUserId) and the cwd (resolveCwd) EXACTLY like a
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
      const r = await deps.listModels({
        agentType: ctx.params.agentType ?? "",
        cwd: ctx.query.get("cwd") ?? "",
        includeHidden: ctx.query.get("includeHidden") === "true",
        userId,
      });
      return r.ok
        ? ok({ models: r.models })
        : ok({ models: [], authError: r.authError, error: r.error });
    },
  };
}
