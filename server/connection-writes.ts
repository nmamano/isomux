// The writes behind the Integrations page that an ask can also make (task
// c71cb60f): one variable, one new MCP server. The routes (user-env.ts,
// mcp-servers.ts) and the value requests (secret-requests.ts) all write
// through writeVariable and writeMcpServer, so a write's after-effects (the
// OpenCode push) are in one place.

import type { McpOAuth } from "./mcp-oauth.ts";
import type { McpServerChange } from "./mcp-server-store.ts";
import type { SecretScope } from "./secret-store.ts";
import type { HandlerErrorStatus } from "./routes/executor.ts";
import {
  pushOpenCodeSettings,
  type PushOpenCodeSettings,
} from "./routes/handlers/opencode-settings.ts";

export type VariableWriteOutcome =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; code: string; message?: string };

export interface VariableWriteDeps {
  // The managed env writes (isomux-office.ts). `note` undefined keeps the
  // saved note. A bad name or value throws ManagedEnvValidationError.
  setUserVariable(
    userId: string,
    name: string,
    value: string,
    note: unknown,
  ): VariableWriteOutcome;
  setOfficeVariable(
    name: string,
    value: string,
    note: unknown,
  ): VariableWriteOutcome;
  pushOpenCodeSettings?: PushOpenCodeSettings;
}

// Sets one variable in the scope, then pushes the scope's OpenCode settings
// after a success.
export function writeVariable(
  deps: VariableWriteDeps,
  scope: SecretScope,
  name: string,
  value: string,
  note?: unknown,
): VariableWriteOutcome {
  const outcome =
    scope.kind === "office"
      ? deps.setOfficeVariable(name, value, note)
      : deps.setUserVariable(scope.userId, name, value, note);
  if (outcome.ok) pushOpenCodeSettings(deps.pushOpenCodeSettings, scope);
  return outcome;
}

export interface McpServerWriteDeps {
  oauth: McpOAuth;
  pushOpenCodeSettings?: PushOpenCodeSettings;
}

// Creates one MCP server in the scope (McpOAuth.create's body and answer),
// then pushes the scope's OpenCode settings after a success.
export function writeMcpServer(
  deps: McpServerWriteDeps,
  scope: SecretScope,
  body: Record<string, unknown>,
): ReturnType<McpOAuth["create"]> {
  const result = deps.oauth.create(scope, body);
  if (result.ok && result.change.ok)
    pushOpenCodeSettings(deps.pushOpenCodeSettings, scope);
  return result;
}

// A refused MCP server change as the routes answer it. No message holds the
// URL, which can carry a token.
export type McpServerRefusal =
  Exclude<McpServerChange, { ok: true }> | { ok: false; kind: "secret_exists" };

export function mcpServerFailure(change: McpServerRefusal): {
  status: HandlerErrorStatus;
  code: string;
  message?: string;
  detail?: Record<string, unknown>;
} {
  switch (change.kind) {
    case "invalid": {
      const { field, reason } = change.error;
      return {
        status: 400,
        code: "invalid_mcp_server",
        message: `the ${field} field is not valid`,
        detail: { field, reason },
      };
    }
    case "exists":
      return {
        status: 409,
        code: "mcp_server_exists",
        message: "an MCP server with this name exists",
      };
    case "not_found":
      return { status: 404, code: "not_found" };
    case "secret_not_found":
      return {
        status: 422,
        code: "secret_not_found",
        message: "no secret with this name in the same scope",
      };
    case "secret_host":
      return {
        status: 422,
        code: "secret_host_mismatch",
        message: "the secret does not list the server's host",
      };
    case "secret_exists":
      return {
        status: 409,
        code: "secret_exists",
        message: "a secret in the same scope has the name the sign-in uses",
      };
  }
}

export interface ConnectionWritesDeps extends VariableWriteDeps {
  // A getter: the office makes the OAuth flow after the routes that use
  // these writes.
  oauth: () => McpOAuth;
}

export function createConnectionWrites(deps: ConnectionWritesDeps) {
  return {
    setVariable: (
      scope: SecretScope,
      name: string,
      value: string,
      note?: unknown,
    ): VariableWriteOutcome => writeVariable(deps, scope, name, value, note),
    createMcpServer: (
      scope: SecretScope,
      body: Record<string, unknown>,
    ): ReturnType<McpOAuth["create"]> =>
      writeMcpServer(
        {
          oauth: deps.oauth(),
          pushOpenCodeSettings: deps.pushOpenCodeSettings,
        },
        scope,
        body,
      ),
  };
}

export type ConnectionWrites = ReturnType<typeof createConnectionWrites>;
