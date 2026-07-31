// Validation resource handlers - Phase 3a slice 3a.5. Pre-spawn / pre-save
// validation probes on the unified REST surface (opIds validate.{cwd,env}). Both
// are pure request/response (emits: []); neither mutates state.
//
// validate.cwd (agent:manage + authenticated): any caller who can spawn may
// check a cwd. Delegates to agentManager.validateCwd - the shared validation
// core. The legacy request_cwd_validation WS arm that also called it was retired
// in the Phase 3 transport migration, so REST is now the sole transport.
//
// validate.env (office:read + authenticated + validateEnvBodySelfSubject): the
// object-level policy (office or another user's env ⇒ officeOwner; own user's env
// ⇒ self) is enforced ENTIRELY by the validateEnvBodySelfSubject precondition,
// because the subject is body.username (scope:"user"), not a :username path param
// - the params-based selfUser guard could never match it (see the route-table
// comment + internal-docs Guard catalog). By the time this handler runs, the
// precondition has authorized the caller; the handler only resolves + validates.
// The shared core (resolveAndValidateEnv) is the sole resolver now that the
// legacy request_settings_validation WS arm has been retired (Phase 3 transport
// migration). REST DROPS the resolved env-file path from the response by design
// (the retired WS arm used to echo it).
//
// LEAF over the executor + shared types. Only the injected ValidateDeps.

import { ok, type RouteHandler } from "../executor.ts";

export interface ValidateDeps {
  // Validate a working directory. Returns null on success, an error string on
  // failure (the manager's validateCwd throws; the seam catches + flattens it).
  validateCwd(cwd: string): string | null;
  // Resolve the scope/user's env-file path and count its keys. AUTH is NOT here
  // (the validateEnvBodySelfSubject precondition owns it); this is resolution
  // only. For scope:"user", an omitted username resolves to the CALLER's own env
  // via selfUserId (the subject the precondition authorized as "self"). An
  // explicit non-empty `path` validates THAT path instead of the stored one
  // (typed-but-unsaved settings-UI probe; same authorization - see
  // ValidateEnvReq). The resolved path is returned by the core but DROPPED by
  // the REST handler (the retired request_settings_validation WS arm used to
  // echo it).
  validateEnv(
    scope: string,
    username: string | undefined,
    selfUserId: string | undefined,
    path: string | undefined,
  ): { ok: boolean; keyCount?: number; error?: string; envFile: string | null };
}

export function validateHandlers(
  deps: ValidateDeps,
): Record<string, RouteHandler> {
  return {
    "validate.cwd": (ctx) => {
      const cwd =
        typeof (ctx.body as { cwd?: unknown } | undefined)?.cwd === "string"
          ? (ctx.body as { cwd: string }).cwd
          : "";
      // Input-validation at the untyped REST boundary: an empty cwd must not
      // silently resolve to the server's OWN working directory (resolveCwd("") ->
      // process.cwd()) and report ok. The typed WS client always sends a real cwd.
      if (cwd.trim() === "") {
        return ok({ ok: false, error: "cwd is required" });
      }
      const error = deps.validateCwd(cwd);
      return error === null ? ok({ ok: true }) : ok({ ok: false, error });
    },

    "validate.env": (ctx) => {
      const b = (ctx.body ?? {}) as {
        scope?: unknown;
        username?: unknown;
        path?: unknown;
      };
      const scope = typeof b.scope === "string" ? b.scope : "";
      const username = typeof b.username === "string" ? b.username : undefined;
      const path = typeof b.path === "string" ? b.path : undefined;
      // Input-validation at the untyped REST boundary for the explicit-path
      // probe: a PROVIDED path must be non-blank (a blank one must not
      // silently fall back to the stored env and report a misleading ok), and
      // the override exists only for the user-scope settings UI - reject it
      // for any other scope rather than leaving the combination ambiguous.
      if (path !== undefined && path.trim() === "") {
        return ok({ ok: false, error: "path must not be empty" });
      }
      if (path !== undefined && scope !== "user") {
        return ok({
          ok: false,
          error: 'path is only supported with scope "user"',
        });
      }
      // Omitted username on scope:"user" resolves to the caller's own env inside
      // the core; pass the caller's userId so "self" is concrete.
      const r = deps.validateEnv(
        scope,
        username,
        ctx.identity.userId ?? undefined,
        path,
      );
      // Drop the resolved env-file path (envFile) from the REST response by
      // design - only the WS echo carries it.
      return r.ok
        ? ok({
            ok: true,
            ...(r.keyCount !== undefined ? { keyCount: r.keyCount } : {}),
          })
        : ok({ ok: false, error: r.error });
    },
  };
}
