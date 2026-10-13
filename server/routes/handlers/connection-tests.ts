// The Test button's routes (opIds secrets.test, officeSecrets.test,
// mcpServers.test, officeMcpServers.test; integrations loop, slice A3). The
// route table gates them as the routes that edit the same connection: cap
// user:env, which no agent scope holds; member connections self-only
// (selfUserOrApi), office ones owner-only (officeEnvOwner).
//
// The tester answers every outside failure with a code, so the only errors
// here are the stores' own, with fixed text.

import {
  fail,
  ok,
  type HandlerResult,
  type RouteHandler,
} from "../executor.ts";
import type { ConnectionTester } from "../../connection-tests.ts";
import { McpServerStoreUnreadableError } from "../../mcp-server-store.ts";
import {
  SecretStoreUnreadableError,
  type SecretScope,
} from "../../secret-store.ts";

export interface ConnectionTestsDeps {
  tester: ConnectionTester;
}

type Ctx = Parameters<RouteHandler>[0];

function memberScope(ctx: Ctx): SecretScope | null {
  return (ctx.identity.scope === "user" || ctx.identity.scope === "api") &&
    ctx.identity.userId
    ? { kind: "user", userId: ctx.identity.userId }
    : null;
}

// The route has checked officeEnvOwner.
const officeScope = (): SecretScope => ({ kind: "office" });

function testRoute(
  scopeOf: (ctx: Ctx) => SecretScope | null,
  run: ConnectionTester["secret"] | ConnectionTester["mcpServer"],
): RouteHandler {
  return async (ctx): Promise<HandlerResult> => {
    const scope = scopeOf(ctx);
    if (!scope) return fail(403, "forbidden");
    try {
      const tested = run(scope, ctx.params.name ?? "");
      if (!tested) return fail(404, "not_found");
      return ok({ result: await tested });
    } catch (err) {
      if (err instanceof SecretStoreUnreadableError)
        return fail(500, "secrets_unreadable", err.message);
      if (err instanceof McpServerStoreUnreadableError)
        return fail(500, "mcp_servers_unreadable", err.message);
      console.error("[connections] a connection test request failed");
      return fail(500, "connection_test_failed");
    }
  };
}

export function connectionTestsHandlers(
  deps: ConnectionTestsDeps,
): Record<string, RouteHandler> {
  const { tester } = deps;
  return {
    "secrets.test": testRoute(memberScope, tester.secret),
    "officeSecrets.test": testRoute(officeScope, tester.secret),
    "mcpServers.test": testRoute(memberScope, tester.mcpServer),
    "officeMcpServers.test": testRoute(officeScope, tester.mcpServer),
  };
}
