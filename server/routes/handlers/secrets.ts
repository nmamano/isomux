// Secret handlers (opIds secrets.* and officeSecrets.*). Design:
// internal-docs/secrets-design.md, section 1.
//
// The route table gates them as the variables are: cap user:env, which no
// agent scope holds; member secrets self-only (selfUserOrApi), office secrets
// owner-only (officeEnvOwner). No response carries a value, and no error
// echoes any input: a value pasted into the wrong field does not come back.
//
// Every failure is answered here, never rethrown: the executor logs a thrown
// error in full. The log line is fixed text.

import {
  created,
  fail,
  noContent,
  ok,
  type HandlerResult,
  type RouteHandler,
} from "../executor.ts";
import {
  SecretStoreUnreadableError,
  type SecretChange,
  type SecretScope,
  type SecretStore,
} from "../../secret-store.ts";
import { hasCredentialShape } from "../../log-redaction.ts";

export interface SecretsDeps {
  store: SecretStore;
  // After a change is stored: the secrets runtime pushes it to the proxy
  // and marks the agents that must restart. The store write is the commit
  // point, so a failure here is logged and the route still answers success;
  // the proxy child gets a full snapshot at its next start.
  onChanged?: () => Promise<void>;
}

const CREATE_KEYS = ["name", "value", "hosts", "form", "note"];
const ROTATE_KEYS = ["value"];
const UPDATE_KEYS = ["hosts", "form", "note"];

function memberScope(ctx: Parameters<RouteHandler>[0]): SecretScope | null {
  return (ctx.identity.scope === "user" || ctx.identity.scope === "api") &&
    ctx.identity.userId
    ? { kind: "user", userId: ctx.identity.userId }
    : null;
}

// The body as an object with only the allowed keys, or null.
function bodyWith(
  body: unknown,
  allowed: string[],
): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (!keys.every((key) => allowed.includes(key))) return null;
  return body as Record<string, unknown>;
}

const invalidRequest = () =>
  fail(400, "invalid_request", "the request body has the wrong shape");

function answer(change: SecretChange, status: "ok" | "created" = "ok") {
  if (change.ok)
    return status === "created"
      ? created({ secret: change.secret })
      : ok({ secret: change.secret });
  switch (change.kind) {
    case "invalid": {
      const { field, reason, host } = change.error;
      if (reason === "never_listed")
        return fail(
          422,
          "host_not_allowed",
          `${host} never receives a secret: model and package registry hosts are on the never-list`,
          { field, host },
        );
      return fail(400, "invalid_secret", `the ${field} field is not valid`, {
        field,
        reason,
      });
    }
    case "exists":
      return fail(409, "secret_exists", "a secret with this name exists");
    case "not_found":
      return fail(404, "not_found");
  }
}

// Tells the runtime about a change that the store committed.
async function committed(
  deps: SecretsDeps,
  result: HandlerResult,
): Promise<HandlerResult> {
  if (result.kind !== "error" && deps.onChanged) {
    try {
      await deps.onChanged();
    } catch {
      console.error("[secrets] the proxy did not take a change");
    }
  }
  return result;
}

function guarded(handler: RouteHandler): RouteHandler {
  return async (ctx): Promise<HandlerResult> => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof SecretStoreUnreadableError)
        return fail(500, "secrets_unreadable", err.message);
      console.error("[secrets] a secrets request failed");
      return fail(500, "secrets_failed");
    }
  };
}

function scopedHandlers(
  deps: SecretsDeps,
  scopeOf: (ctx: Parameters<RouteHandler>[0]) => SecretScope | null,
): Record<
  "list" | "create" | "rotate" | "update" | "reissue" | "remove",
  RouteHandler
> {
  return {
    list: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      return ok({ secrets: deps.store.list(scope) });
    },
    create: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      const body = bodyWith(ctx.body, CREATE_KEYS);
      if (!body) return invalidRequest();
      // A name that looks like a credential is most likely the value in the
      // wrong field. Refuse it, so it never becomes a listed name.
      if (typeof body.name === "string" && hasCredentialShape(body.name))
        return answer({
          ok: false,
          kind: "invalid",
          error: { field: "name", reason: "invalid" },
        });
      return committed(deps, answer(deps.store.create(scope, body), "created"));
    },
    rotate: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      const body = bodyWith(ctx.body, ROTATE_KEYS);
      if (!body) return invalidRequest();
      return committed(
        deps,
        answer(deps.store.rotate(scope, ctx.params.name ?? "", body.value)),
      );
    },
    update: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      const body = bodyWith(ctx.body, UPDATE_KEYS);
      if (!body || Object.keys(body).length === 0) return invalidRequest();
      return committed(
        deps,
        answer(deps.store.update(scope, ctx.params.name ?? "", body)),
      );
    },
    reissue: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      if (ctx.body !== undefined && bodyWith(ctx.body, []) === null)
        return invalidRequest();
      return committed(
        deps,
        answer(deps.store.reissue(scope, ctx.params.name ?? "")),
      );
    },
    remove: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      return deps.store.remove(scope, ctx.params.name ?? "")
        ? committed(deps, noContent())
        : fail(404, "not_found");
    },
  };
}

export function secretsHandlers(
  deps: SecretsDeps,
): Record<string, RouteHandler> {
  const member = scopedHandlers(deps, memberScope);
  // The route has checked officeEnvOwner.
  const office = scopedHandlers(deps, () => ({ kind: "office" }));
  const handlers: Record<string, RouteHandler> = {
    "secrets.list": member.list,
    "secrets.create": member.create,
    "secrets.rotate": member.rotate,
    "secrets.update": member.update,
    "secrets.reissue": member.reissue,
    "secrets.delete": member.remove,
    "officeSecrets.list": office.list,
    "officeSecrets.create": office.create,
    "officeSecrets.rotate": office.rotate,
    "officeSecrets.update": office.update,
    "officeSecrets.reissue": office.reissue,
    "officeSecrets.delete": office.remove,
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}
