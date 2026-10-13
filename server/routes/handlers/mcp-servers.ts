// Remote MCP server handlers (opIds mcpServers.* and officeMcpServers.*;
// integrations loop, slice A2). The route table gates them as the secrets:
// cap user:env, which no agent scope holds; member servers self-only
// (selfUserOrApi), office servers owner-only (officeEnvOwner).
//
// The URL of some hosted servers carries a token in its path, so no error
// echoes it, and the log line is fixed text. The list here is the only
// response with the whole URL.

import {
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

export interface McpServersDeps {
  store: McpServerStore;
}

const CREATE_KEYS = ["name", "url", "secret", "note"];
const UPDATE_KEYS = ["url", "secret", "note"];

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

function answer(change: McpServerChange, status: "ok" | "created" = "ok") {
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
): Record<"list" | "create" | "update" | "remove", RouteHandler> {
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
      return answer(deps.store.create(scope, body), "created");
    },
    update: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      const body = bodyWith(ctx.body, UPDATE_KEYS);
      if (!body || Object.keys(body).length === 0) return invalidRequest();
      return answer(deps.store.update(scope, ctx.params.name ?? "", body));
    },
    remove: (ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return fail(403, "forbidden");
      return deps.store.remove(scope, ctx.params.name ?? "")
        ? noContent()
        : fail(404, "not_found");
    },
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
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}
