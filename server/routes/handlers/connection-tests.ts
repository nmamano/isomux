// The Test button's routes (opIds secrets.test, officeSecrets.test,
// mcpServers.test, officeMcpServers.test; integrations loop, slice A3). The
// route table gates them as the routes that edit the same connection: cap
// integration:manage; member connections for the member or an office owner
// (integrationSelfOrOwner), office ones owner-only (integrationOfficeOwner).
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
import { memberSubject } from "./member-subject.ts";

export interface ConnectionTestsDeps {
  tester: ConnectionTester;
  userIdForUsername: (username: string) => string | null;
}

type Ctx = Parameters<RouteHandler>[0];

// The route has checked integrationOfficeOwner.
const officeScope = (): SecretScope => ({ kind: "office" });

function testRoute(
  scopeOf: (ctx: Ctx) => SecretScope | null,
  run: ConnectionTester["secret"] | ConnectionTester["mcpServer"],
): RouteHandler {
  return async (ctx): Promise<HandlerResult> => {
    const scope = scopeOf(ctx);
    if (!scope) return fail(404, "not_found");
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
  const memberScope = memberSubject(deps.userIdForUsername);
  return {
    "secrets.test": testRoute(memberScope, tester.secret),
    "officeSecrets.test": testRoute(officeScope, tester.secret),
    "mcpServers.test": testRoute(memberScope, tester.mcpServer),
    "officeMcpServers.test": testRoute(officeScope, tester.mcpServer),
  };
}
