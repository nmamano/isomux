// Secret handlers (opIds secrets.* and officeSecrets.*). Design:
// internal-docs/secrets-design.md, section 1.
//
// The route table gates them as the variables are: cap integration:manage,
// which a human, an API token and a privileged agent hold; member secrets for
// the member or an office owner (integrationSelfOrOwner), office secrets
// owner-only (integrationOfficeOwner), and the office list for members too
// (integrationOfficeReader), as a summary. An agent caller may not add a host
// to a saved secret. Only Show returns a value: cap secret:show, which no
// agent holds, the member's own (selfUserOrApi) or an office one for an
// owner. No error echoes any input: a value pasted into the wrong field
// does not come back.
//
// Every failure is answered here, never rethrown: the executor logs a thrown
// error in full. The log line is fixed text.

import {
  bytes,
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
  type SecretUpdateChange,
  type SecretScope,
  type SecretStore,
} from "../../secret-store.ts";
import { hasCredentialShape } from "../../log-redaction.ts";
import { SECRET_MIN_VALUE_LENGTH } from "../../../shared/secret-hosts.ts";
import type {
  OfficeSecretSummaryWire,
  SecretWire,
} from "../../../shared/contract-shapes.ts";
import { callerIsIntegrationOwner, memberSubject } from "./member-subject.ts";
import {
  pushOpenCodeSettings,
  type PushOpenCodeSettings,
} from "./opencode-settings.ts";

export interface SecretsDeps {
  store: SecretStore;
  userIdForUsername: (username: string) => string | null;
  isOfficeOwnerUserId: (userId: string) => boolean;
  // The audit row of a Show: a GET, which the executor does not audit.
  // Targets are names only, never the value. It throws when the row is not
  // written, and the Show then fails.
  auditReveal: (
    ctx: Parameters<RouteHandler>[0],
    operation: "secrets.reveal" | "officeSecrets.reveal",
    targets: string[],
  ) => void;
  // After a change is stored: the secrets runtime pushes it to the proxy
  // and marks the agents that must restart. The store write is the commit
  // point, so a failure here is logged and the route still answers success;
  // the proxy child gets a full snapshot at its next start.
  onChanged?: () => Promise<void>;
  // After the runtime took the change, so the push reads the new secrets.
  pushOpenCodeSettings?: PushOpenCodeSettings;
}

const CREATE_KEYS = ["name", "value", "hosts", "form", "note"];
const ROTATE_KEYS = ["value"];
const UPDATE_KEYS = ["hosts", "form", "note"];

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

// A member's view of an office secret, by allowlist: a field added to
// SecretWire later does not reach members.
function officeSecretSummary(secret: SecretWire): OfficeSecretSummaryWire {
  return { name: secret.name, hosts: [...secret.hosts], note: secret.note };
}

const invalidRequest = () =>
  fail(400, "invalid_request", "the request body has the wrong shape");

function answer(
  change: SecretChange | SecretUpdateChange,
  status: "ok" | "created" = "ok",
) {
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
      return fail(
        400,
        "invalid_secret",
        reason === "too_short"
          ? `the value must have at least ${SECRET_MIN_VALUE_LENGTH} characters`
          : `the ${field} field is not valid`,
        { field, reason },
      );
    }
    case "exists":
      return fail(409, "secret_exists", "a secret with this name exists");
    case "not_found":
      return fail(404, "not_found");
    case "host_added":
      return fail(
        403,
        "secret_host_add_refused",
        "an agent cannot add a host to a saved secret; it can remove hosts",
      );
  }
}

// Tells the runtime, and then the OpenCode servers, about a change that the
// store committed.
async function committed(
  deps: SecretsDeps,
  result: HandlerResult,
  scope: SecretScope,
): Promise<HandlerResult> {
  if (result.kind === "error") return result;
  if (deps.onChanged) {
    try {
      await deps.onChanged();
    } catch {
      console.error("[secrets] the proxy did not take a change");
    }
  }
  pushOpenCodeSettings(deps.pushOpenCodeSettings, scope);
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
  "list" | "create" | "rotate" | "update" | "reissue" | "remove" | "reveal",
  RouteHandler
> {
  return {
    list: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      const secrets = deps.store.list(scope);
      // A member reads the office secrets as a summary only.
      if (
        scope.kind === "office" &&
        !callerIsIntegrationOwner(ctx, deps.isOfficeOwnerUserId)
      )
        return ok({ secrets: secrets.map(officeSecretSummary) });
      return ok({ secrets });
    },
    reveal: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      const name = ctx.params.name ?? "";
      const value = deps.store.readSecretValues(scope, name)?.value;
      if (value === undefined) return fail(404, "not_found");
      // The row first: a read that cannot be recorded returns no value.
      try {
        if (scope.kind === "office")
          deps.auditReveal(ctx, "officeSecrets.reveal", ["office", name]);
        else
          deps.auditReveal(ctx, "secrets.reveal", [
            ctx.params.username ?? "",
            name,
          ]);
      } catch {
        console.error("[secrets] a Show could not be recorded");
        return fail(500, "audit_failed");
      }
      // Bytes rather than ok(), for the no-store header: no cache keeps it.
      return bytes(
        new TextEncoder().encode(JSON.stringify({ value })),
        "application/json; charset=utf-8",
        { "Cache-Control": "no-store" },
      );
    },
    create: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
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
      return committed(
        deps,
        answer(deps.store.create(scope, body), "created"),
        scope,
      );
    },
    rotate: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      const body = bodyWith(ctx.body, ROTATE_KEYS);
      if (!body) return invalidRequest();
      return committed(
        deps,
        answer(deps.store.rotate(scope, ctx.params.name ?? "", body.value)),
        scope,
      );
    },
    update: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      const body = bodyWith(ctx.body, UPDATE_KEYS);
      if (!body || Object.keys(body).length === 0) return invalidRequest();
      return committed(
        deps,
        answer(
          deps.store.update(scope, ctx.params.name ?? "", body, {
            // Only a human, by cookie or API token, adds hosts; every other
            // caller (an agent, an app) only narrows them.
            addHosts:
              ctx.identity.scope === "user" || ctx.identity.scope === "api",
          }),
        ),
        scope,
      );
    },
    reissue: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      if (ctx.body !== undefined && bodyWith(ctx.body, []) === null)
        return invalidRequest();
      return committed(
        deps,
        answer(deps.store.reissue(scope, ctx.params.name ?? "")),
        scope,
      );
    },
    remove: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      return deps.store.remove(scope, ctx.params.name ?? "")
        ? committed(deps, noContent(), scope)
        : fail(404, "not_found");
    },
  };
}

export function secretsHandlers(
  deps: SecretsDeps,
): Record<string, RouteHandler> {
  const member = scopedHandlers(deps, memberSubject(deps.userIdForUsername));
  // The route has checked integrationOfficeOwner, or integrationOfficeReader
  // for the list.
  const office = scopedHandlers(deps, () => ({ kind: "office" }));
  const handlers: Record<string, RouteHandler> = {
    "secrets.list": member.list,
    "secrets.create": member.create,
    "secrets.rotate": member.rotate,
    "secrets.update": member.update,
    "secrets.reissue": member.reissue,
    "secrets.delete": member.remove,
    "secrets.reveal": member.reveal,
    "officeSecrets.list": office.list,
    "officeSecrets.create": office.create,
    "officeSecrets.rotate": office.rotate,
    "officeSecrets.update": office.update,
    "officeSecrets.reissue": office.reissue,
    "officeSecrets.delete": office.remove,
    "officeSecrets.reveal": office.reveal,
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}
