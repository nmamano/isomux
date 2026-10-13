// Remote MCP server handlers (opIds mcpServers.* and officeMcpServers.*;
// integrations loop, slice A2). The route table gates them as the secrets:
// cap user:env, which no agent scope holds; member servers self-only
// (selfUserOrApi), office servers owner-only (officeEnvOwner).
//
// The URL of some hosted servers carries a token in its path, so no error
// echoes it, and the log line is fixed text. The list here is the only
// response with the whole URL.

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
  McpServerStoreUnreadableError,
  type McpServerChange,
  type McpServerStore,
} from "../../mcp-server-store.ts";
import {
  SecretStoreUnreadableError,
  type SecretScope,
} from "../../secret-store.ts";
import type { McpOAuth } from "../../mcp-oauth.ts";

export interface McpServersDeps {
  store: McpServerStore;
  // The OAuth flow (integrations A2b). Every create, update and delete goes
  // through it, so the secrets a registration owns go with it.
  oauth: McpOAuth;
  // The audit row of a finished sign-in: the callback is a GET, which the
  // executor does not audit.
  auditSignIn: (ctx: Parameters<RouteHandler>[0], targets: string[]) => void;
  isOfficeOwnerUserId: (userId: string) => boolean;
}

const CREATE_KEYS = ["name", "url", "secret", "note", "oauth"];
const UPDATE_KEYS = ["url", "secret", "note", "oauth"];

function memberScope(ctx: Parameters<RouteHandler>[0]): SecretScope | null {
  return (ctx.identity.scope === "user" || ctx.identity.scope === "api") &&
    ctx.identity.userId
    ? { kind: "user", userId: ctx.identity.userId }
    : null;
}

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

type Change = McpServerChange | { ok: false; kind: "secret_exists" };

function answer(change: Change, status: "ok" | "created" = "ok") {
  if (change.ok)
    return status === "created"
      ? created({ server: change.server })
      : ok({ server: change.server });
  switch (change.kind) {
    case "invalid": {
      const { field, reason } = change.error;
      return fail(
        400,
        "invalid_mcp_server",
        `the ${field} field is not valid`,
        { field, reason },
      );
    }
    case "exists":
      return fail(
        409,
        "mcp_server_exists",
        "an MCP server with this name exists",
      );
    case "not_found":
      return fail(404, "not_found");
    case "secret_not_found":
      return fail(
        422,
        "secret_not_found",
        "no secret with this name in the same scope",
      );
    case "secret_host":
      return fail(
        422,
        "secret_host_mismatch",
        "the secret does not list the server's host",
      );
    case "secret_exists":
      return fail(
        409,
        "secret_exists",
        "a secret in the same scope has the name the sign-in uses",
      );
  }
}

function guarded(handler: RouteHandler): RouteHandler {
  return async (ctx): Promise<HandlerResult> => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof McpServerStoreUnreadableError)
        return fail(500, "mcp_servers_unreadable", err.message);
      if (err instanceof SecretStoreUnreadableError)
        return fail(500, "secrets_unreadable", err.message);
      console.error("[mcp] an MCP servers request failed");
      return fail(500, "mcp_servers_failed");
    }
  };
}

function scopedHandlers(
  deps: McpServersDeps,
  scopeOf: (ctx: Parameters<RouteHandler>[0]) => SecretScope | null,
): Record<"list" | "create" | "update" | "remove" | "signIn", RouteHandler> {
  return {
    list: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      return ok({ servers: deps.store.list(scope) });
    },
    create: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      const body = bodyWith(ctx.body, CREATE_KEYS);
      if (!body) return invalidRequest();
      const result = deps.oauth.create(scope, body);
      return result.ok ? answer(result.change, "created") : invalidRequest();
    },
    update: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      const body = bodyWith(ctx.body, UPDATE_KEYS);
      if (!body || Object.keys(body).length === 0) return invalidRequest();
      const result = deps.oauth.update(scope, ctx.params.name ?? "", body);
      return result.ok ? answer(result.change) : invalidRequest();
    },
    remove: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      return deps.oauth.remove(scope, ctx.params.name ?? "")
        ? noContent()
        : fail(404, "not_found");
    },
    // The authorization URL for the member's browser; no token in it.
    signIn: async (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope || !ctx.identity.userId) return fail(403, "forbidden");
      const result = await deps.oauth.startSignIn(
        scope,
        ctx.params.name ?? "",
        ctx.identity.userId,
      );
      if (result.ok) return ok({ authorizationUrl: result.authorizationUrl });
      if (result.reason === "not_found") return fail(404, "not_found");
      return fail(
        result.reason === "not_oauth" ? 409 : 502,
        "sign_in_failed",
        "the sign-in could not start",
        { reason: result.reason },
      );
    },
  };
}

// Where the callback sends the browser back: the settings page, with a fixed
// code the page reads. Never the authorization server's own text.
function backToSettings(flag: string): HandlerResult {
  const target = `/settings?mcpSignIn=${encodeURIComponent(flag)}`;
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><a href="${target}">Isomux</a>\n`;
  return bytes(new TextEncoder().encode(html), "text/html; charset=utf-8", {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
}

function callbackHandler(deps: McpServersDeps): RouteHandler {
  return async (ctx) => {
    const userId = ctx.identity.scope === "user" ? ctx.identity.userId : null;
    if (!userId) return fail(403, "forbidden");
    // An office server: the member must still be an owner.
    const result = await deps.oauth.finishSignIn(
      userId,
      ctx.query,
      (scope) => scope.kind !== "office" || deps.isOfficeOwnerUserId(userId),
    );
    if (!result.ok) return backToSettings(result.reason);
    deps.auditSignIn(ctx, [
      result.name,
      ...(result.scope.kind === "office" ? ["office"] : []),
    ]);
    return backToSettings("ok");
  };
}

export function mcpServersHandlers(
  deps: McpServersDeps,
): Record<string, RouteHandler> {
  const member = scopedHandlers(deps, memberScope);
  // The route has checked officeEnvOwner.
  const office = scopedHandlers(deps, () => ({ kind: "office" }));
  const handlers: Record<string, RouteHandler> = {
    "mcpServers.list": member.list,
    "mcpServers.create": member.create,
    "mcpServers.update": member.update,
    "mcpServers.delete": member.remove,
    "officeMcpServers.list": office.list,
    "officeMcpServers.create": office.create,
    "officeMcpServers.update": office.update,
    "officeMcpServers.delete": office.remove,
    "mcpServers.signIn": member.signIn,
    "officeMcpServers.signIn": office.signIn,
    "mcpOAuth.callback": callbackHandler(deps),
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}
