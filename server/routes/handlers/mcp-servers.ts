// Remote MCP server handlers (opIds mcpServers.* and officeMcpServers.*;
// integrations loop, slice A2). The route table gates them as the secrets:
// cap user:env, which no agent scope holds; member servers for the member or
// an office owner (selfOrEnvOwner), office servers owner-only
// (officeEnvOwner), and the office list for members too (officeEnvReader), as
// a summary.
//
// The URL of some hosted servers carries a token in its path, so no error
// echoes it, and the log line is fixed text. The list here is the only
// response with the whole URL, and a member's office list has the host only.

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
import type {
  McpServerWire,
  OfficeMcpServerSummaryWire,
} from "../../../shared/contract-shapes.ts";
import { mcpServerHost } from "../../../shared/mcp-servers.ts";
import { callerIsEnvOwner, memberSubject } from "./member-subject.ts";

export interface McpServersDeps {
  store: McpServerStore;
  // The OAuth flow (integrations A2b). Every create, update and delete goes
  // through it, so the secrets a registration owns go with it.
  oauth: McpOAuth;
  // The audit row of a finished sign-in: the callback is a GET, which the
  // executor does not audit.
  auditSignIn: (ctx: Parameters<RouteHandler>[0], targets: string[]) => void;
  isOfficeOwnerUserId: (userId: string) => boolean;
  userIdForUsername: (username: string) => string | null;
  usernameForUserId: (userId: string) => string | null;
}

const CREATE_KEYS = ["name", "url", "secret", "note", "oauth"];
const UPDATE_KEYS = ["url", "secret", "note", "oauth"];

// A member's view of an office server, by allowlist: the host, never the
// URL's path or query (they can carry a token) or the credential's name.
// mcpServerHost, as the integrations list (GET /api/me/connections) shows it.
function officeServerSummary(
  server: McpServerWire,
): OfficeMcpServerSummaryWire {
  return {
    name: server.name,
    host: mcpServerHost(server.url),
    note: server.note,
  };
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
      if (!scope) return fail(404, "not_found");
      const servers = deps.store.list(scope);
      if (
        scope.kind === "office" &&
        !callerIsEnvOwner(ctx, deps.isOfficeOwnerUserId)
      )
        return ok({ servers: servers.map(officeServerSummary) });
      return ok({ servers });
    },
    create: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      const body = bodyWith(ctx.body, CREATE_KEYS);
      if (!body) return invalidRequest();
      const result = deps.oauth.create(scope, body);
      return result.ok ? answer(result.change, "created") : invalidRequest();
    },
    update: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      const body = bodyWith(ctx.body, UPDATE_KEYS);
      if (!body || Object.keys(body).length === 0) return invalidRequest();
      const result = deps.oauth.update(scope, ctx.params.name ?? "", body);
      return result.ok ? answer(result.change) : invalidRequest();
    },
    remove: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
      return deps.oauth.remove(scope, ctx.params.name ?? "")
        ? noContent()
        : fail(404, "not_found");
    },
    // The authorization URL for the browser of the person who starts the
    // flow (the member, or an owner for a member's server); no token in it.
    // That person, the caller, finishes it.
    signIn: async (ctx) => {
      if (!ctx.identity.userId) return fail(403, "forbidden");
      const scope = scopeOf(ctx);
      if (!scope) return fail(404, "not_found");
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

// Where the callback sends the browser back: the integrations page, with a
// fixed code the page reads. Never the authorization server's own text.
function backToIntegrations(flag: string): HandlerResult {
  const target = `/integrations?mcpSignIn=${encodeURIComponent(flag)}`;
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
    // The person who started the flow must still be allowed the scope: an
    // office server, an owner; another member's server, an owner too.
    const result = await deps.oauth.finishSignIn(userId, ctx.query, (scope) =>
      scope.kind === "user" && scope.userId === userId
        ? true
        : deps.isOfficeOwnerUserId(userId),
    );
    if (!result.ok) return backToIntegrations(result.reason);
    // The row names the scope: "office", or the member's username, as the
    // other member routes do.
    const subject =
      result.scope.kind === "office"
        ? "office"
        : deps.usernameForUserId(result.scope.userId);
    deps.auditSignIn(ctx, [result.name, ...(subject ? [subject] : [])]);
    return backToIntegrations("ok");
  };
}

export function mcpServersHandlers(
  deps: McpServersDeps,
): Record<string, RouteHandler> {
  const member = scopedHandlers(deps, memberSubject(deps.userIdForUsername));
  // The route has checked officeEnvOwner, or officeEnvReader for the list.
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
