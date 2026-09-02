import {
  fail,
  noContent,
  ok,
  type HandlerErrorStatus,
  type RouteHandler,
} from "../executor.ts";
import type {
  UserEnvReplaceReq,
  UserEnvRes,
} from "../../../shared/contract-shapes.ts";
import { ManagedEnvValidationError } from "../../user-env.ts";

type Outcome =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; code: string; message?: string };

export interface UserEnvDeps {
  get(userId: string): UserEnvRes;
  replace(userId: string, values: Record<string, string>): Outcome;
  importCustom(userId: string): Outcome;
}

function subjectUserId(ctx: Parameters<RouteHandler>[0]): string | null {
  return (ctx.identity.scope === "user" || ctx.identity.scope === "api") &&
    ctx.identity.userId
    ? ctx.identity.userId
    : null;
}

function valuesFromBody(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const values = (body as Partial<UserEnvReplaceReq>).values;
  if (!values || typeof values !== "object" || Array.isArray(values))
    return null;
  if (!Object.values(values).every((value) => typeof value === "string"))
    return null;
  return values;
}

export function userEnvHandlers(
  deps: UserEnvDeps,
): Record<string, RouteHandler> {
  return {
    "userEnv.get": (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      try {
        return ok(deps.get(userId));
      } catch {
        return fail(500, "read_failed", "could not read the managed env file");
      }
    },
    "userEnv.replace": (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      const values = valuesFromBody(ctx.body);
      if (!values)
        return fail(400, "invalid_env", "values must be a string map");
      try {
        const result = deps.replace(userId, values);
        return result.ok
          ? noContent()
          : fail(result.status, result.code, result.message);
      } catch (error) {
        return error instanceof ManagedEnvValidationError
          ? fail(400, "invalid_env", error.message)
          : fail(500, "write_failed", "could not save the managed env file");
      }
    },
    "userEnv.import": (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      const result = deps.importCustom(userId);
      return result.ok
        ? noContent()
        : fail(result.status, result.code, result.message);
    },
  };
}
