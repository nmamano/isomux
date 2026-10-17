import {
  fail,
  noContent,
  ok,
  type HandlerErrorStatus,
  type HandlerResult,
  type RouteHandler,
} from "../executor.ts";
import type {
  UserEnvNamesRes,
  UserEnvReplaceReq,
  UserEnvRes,
} from "../../../shared/contract-shapes.ts";
import { isManagedEnvKey, ManagedEnvValidationError } from "../../user-env.ts";
import { memberSubject } from "./member-subject.ts";
import type { SecretScope } from "../../secret-store.ts";
import {
  pushOpenCodeSettings,
  type PushOpenCodeSettings,
} from "./opencode-settings.ts";

type Outcome =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; code: string; message?: string };

export interface UserEnvDeps {
  get(userId: string): UserEnvRes;
  // Variable names, their notes and personal provider status, or null for an
  // unknown user.
  // Takes the username rather than a userId because the officeOwner guard on
  // userEnv.names never resolves the path param - it only asks who is calling.
  names(username: string): Promise<UserEnvNamesRes | null>;
  // `notes` is the body's notes field as sent (undefined keeps the saved
  // notes); a note that breaks the rule throws ManagedEnvValidationError.
  replace(
    userId: string,
    values: Record<string, string>,
    notes: unknown,
  ): Outcome;
  // One variable, for the member or an office owner (Nil, 2026-10-13): the
  // same checks, writes and after-effects as replace. `note` undefined keeps
  // the saved note, null or "" clears it. False from remove: not set.
  setOne(userId: string, name: string, value: string, note: unknown): Outcome;
  removeOne(userId: string, name: string): Outcome | false;
  userIdForUsername(username: string): string | null;
  getOffice(): UserEnvRes;
  replaceOffice(values: Record<string, string>, notes: unknown): Outcome;
  // One office variable, as setOne and removeOne: the owner sets or removes
  // it without reading the others' values.
  setOfficeOne(name: string, value: string, note: unknown): Outcome;
  removeOfficeOne(name: string): Outcome | false;
  pushOpenCodeSettings?: PushOpenCodeSettings;
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

function notesFromBody(body: unknown): unknown {
  return (body as Partial<UserEnvReplaceReq>).notes;
}

const SET_KEYS = ["value", "note"];

function setBody(body: unknown): { value: string; note: unknown } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!Object.keys(body).every((key) => SET_KEYS.includes(key))) return null;
  const { value, note } = body as { value?: unknown; note?: unknown };
  return typeof value === "string" ? { value, note } : null;
}

// A write, and after a success the OpenCode push (task d4a7031e).
function writeOutcome(
  run: () => Outcome | false,
  saved: () => void,
): HandlerResult {
  try {
    const result = run();
    if (result === false) return fail(404, "not_found");
    if (!result.ok) return fail(result.status, result.code, result.message);
    saved();
    return noContent();
  } catch (error) {
    return error instanceof ManagedEnvValidationError
      ? fail(400, "invalid_env", error.message)
      : fail(500, "write_failed", "could not save the managed env file");
  }
}

export function userEnvHandlers(
  deps: UserEnvDeps,
): Record<string, RouteHandler> {
  const subjectOf = memberSubject((username) =>
    deps.userIdForUsername(username),
  );
  const saved = (scope: SecretScope) => () =>
    pushOpenCodeSettings(deps.pushOpenCodeSettings, scope);
  const officeVariable = (
    ctx: Parameters<RouteHandler>[0],
  ): { name: string } | HandlerResult => {
    const name = ctx.params.name ?? "";
    return isManagedEnvKey(name)
      ? { name }
      : fail(400, "invalid_env", "the variable name is not valid");
  };
  // The guard (integrationSelfOrOwner) admitted the caller for :username. The
  // name is checked before anything is read; no message echoes it or the
  // value.
  const variable = (
    ctx: Parameters<RouteHandler>[0],
  ): { userId: string; name: string } | HandlerResult => {
    const subject = subjectOf(ctx);
    if (!subject || subject.kind !== "user") return fail(404, "not_found");
    const name = ctx.params.name ?? "";
    if (!isManagedEnvKey(name))
      return fail(400, "invalid_env", "the variable name is not valid");
    return { userId: subject.userId, name };
  };
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
    // Owner-only: variable names, their notes and provider status, with no
    // values or account metadata.
    "userEnv.names": async (ctx) => {
      const username = ctx.params.username;
      if (!username) return fail(404, "not_found");
      try {
        const res = await deps.names(username);
        if (!res) return fail(404, "not_found");
        return ok(res);
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
      return writeOutcome(
        () => deps.replace(userId, values, notesFromBody(ctx.body)),
        saved({ kind: "user", userId }),
      );
    },
    "userEnv.set": (ctx) => {
      const target = variable(ctx);
      if ("kind" in target) return target;
      const body = setBody(ctx.body);
      if (!body)
        return fail(400, "invalid_request", "the body is { value, note? }");
      return writeOutcome(
        () => deps.setOne(target.userId, target.name, body.value, body.note),
        saved({ kind: "user", userId: target.userId }),
      );
    },
    "userEnv.remove": (ctx) => {
      const target = variable(ctx);
      if ("kind" in target) return target;
      return writeOutcome(
        () => deps.removeOne(target.userId, target.name),
        saved({ kind: "user", userId: target.userId }),
      );
    },
    "officeEnv.names": () => {
      try {
        const { values, notes = {} } = deps.getOffice();
        return ok({
          variables: Object.keys(values)
            .sort()
            .map((name) => ({
              name,
              note: Object.hasOwn(notes, name) ? notes[name] : null,
            })),
        });
      } catch {
        return fail(500, "read_failed", "could not read the managed env file");
      }
    },
    "officeEnv.get": () => {
      try {
        return ok(deps.getOffice());
      } catch {
        return fail(500, "read_failed", "could not read the managed env file");
      }
    },
    "officeEnv.replace": (ctx) => {
      const values = valuesFromBody(ctx.body);
      if (!values)
        return fail(400, "invalid_env", "values must be a string map");
      return writeOutcome(
        () => deps.replaceOffice(values, notesFromBody(ctx.body)),
        saved({ kind: "office" }),
      );
    },
    "officeEnv.set": (ctx) => {
      const target = officeVariable(ctx);
      if ("kind" in target) return target;
      const body = setBody(ctx.body);
      if (!body)
        return fail(400, "invalid_request", "the body is { value, note? }");
      return writeOutcome(
        () => deps.setOfficeOne(target.name, body.value, body.note),
        saved({ kind: "office" }),
      );
    },
    "officeEnv.remove": (ctx) => {
      const target = officeVariable(ctx);
      if ("kind" in target) return target;
      return writeOutcome(
        () => deps.removeOfficeOne(target.name),
        saved({ kind: "office" }),
      );
    },
  };
}
