// The rows of the integrations list (ConnectionsList), from the server's
// GET /api/me/connections. Pure, so the row shape is tested without a DOM.
// Every row says what it is, the account where Isomux knows it, who gets it
// and where it is set.

import {
  SECRET_TEST_KINDS,
  knownMcpStatus,
  type ConnectionScope,
  type ConnectionsListRes,
  type McpServerStatus,
  type SecretTestKind,
} from "../shared/contract-shapes.ts";

export const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

export type ConnectionRowWhere =
  // A place on the Connections page, in one of its two halves. The selector
  // finds it once that half is mounted.
  | {
      kind: "page";
      half: ConnectionScope;
      place: "variables" | "signIn" | "mcpServers" | "secrets";
      engine?: "claude" | "codex";
      selector: string;
    }
  | { kind: "claude"; url: string }
  // Set in Claude's own files, which the page cannot open.
  | {
      kind: "claudeFile";
      source: "user" | "project" | "local";
      folder: string | null;
    };

export type ConnectionRow =
  | {
      kind: "variable";
      key: string;
      scope: ConnectionScope;
      name: string;
      // The member's usage note for agents (A4), null for none.
      note: string | null;
      where: ConnectionRowWhere;
    }
  | {
      kind: "signIn";
      key: string;
      scope: ConnectionScope;
      engine: "claude" | "codex";
      account: string | null;
      where: ConnectionRowWhere;
    }
  // One row per Claude sign-in: its connectors share the place they are set
  // and who can use them, so the row says that once.
  | {
      kind: "connectors";
      key: string;
      scope: ConnectionScope;
      names: string[];
      // From the last after-turn status read; a name with none is pending.
      statuses: { name: string; status: McpServerStatus }[];
      where: ConnectionRowWhere;
    }
  // A remote MCP server Isomux gives every engine.
  | {
      kind: "mcpServer";
      key: string;
      scope: ConnectionScope;
      name: string;
      host: string;
      credential: boolean;
      secret: string | null;
      problem: ConnectionsListRes["mcpServers"][number]["problem"];
      overridden: boolean;
      note: string | null;
      where: ConnectionRowWhere;
    }
  // An MCP server set in Claude itself, as the caller's sessions report it.
  | {
      kind: "engineMcp";
      key: string;
      scope: ConnectionScope;
      name: string;
      status: McpServerStatus | null;
      where: ConnectionRowWhere;
    }
  // A secret: the Test button runs `test`, the identity check of its hosts.
  | {
      kind: "secret";
      key: string;
      scope: ConnectionScope;
      name: string;
      hosts: string[];
      test: SecretTestKind | null;
      note: string | null;
      where: ConnectionRowWhere;
    }
  // A connected Claude sign-in with no turn seen since the server started:
  // its connectors are not known yet, which is not the same as none.
  | {
      kind: "connectorsPending";
      key: string;
      scope: ConnectionScope;
      where: ConnectionRowWhere;
    };

export function variablesSelector(
  scope: ConnectionScope,
  username: string,
): string {
  const path =
    scope === "office"
      ? "/api/office/env"
      : `/api/users/${encodeURIComponent(username)}/env`;
  return `[data-managed-env-path="${path}"]`;
}

export function mcpServersSelector(
  scope: ConnectionScope,
  username: string,
): string {
  const path =
    scope === "office"
      ? "/api/office/mcp-servers"
      : `/api/users/${encodeURIComponent(username)}/mcp-servers`;
  return `[data-mcp-servers-path="${path}"]`;
}

export function secretsSelector(
  scope: ConnectionScope,
  username: string,
): string {
  const path =
    scope === "office"
      ? "/api/office/secrets"
      : `/api/users/${encodeURIComponent(username)}/secrets`;
  return `[data-secrets-path="${path}"]`;
}

export function signInSelector(engine: "claude" | "codex"): string {
  return `[data-provider-card="${engine}"]`;
}

const SCOPES: ConnectionScope[] = ["office", "personal"];

// A note from a server before A4 is absent; anything but a string is none.
function noteOf(note: unknown): string | null {
  return typeof note === "string" && note ? note : null;
}

// The answer of GET /api/me/connections as the list reads it, or null when
// it is not that shape (a server without the route, or a stub). Fields that
// came later (A2, A3) may be missing from an older server, and one of another
// shape loses only its own rows: a missing status is pending, a missing test
// is none.
export function normalizeConnectionsList(
  result: unknown,
): ConnectionsListRes | null {
  const list = result as Partial<ConnectionsListRes> | null;
  if (
    !list ||
    !Array.isArray(list.variables) ||
    !Array.isArray(list.signIns) ||
    !Array.isArray(list.claudeConnectors)
  )
    return null;
  return {
    ...list,
    variables: list.variables,
    signIns: list.signIns,
    claudeConnectors: list.claudeConnectors.map((connectors) => ({
      ...connectors,
      statuses: Array.isArray(connectors.statuses)
        ? connectors.statuses.flatMap((entry) => {
            const status = knownMcpStatus(entry?.status);
            return status && typeof entry.name === "string"
              ? [{ name: entry.name, status }]
              : [];
          })
        : [],
    })),
    mcpServers: Array.isArray(list.mcpServers) ? list.mcpServers : [],
    engineMcpServers: Array.isArray(list.engineMcpServers)
      ? list.engineMcpServers.map((server) => ({
          ...server,
          status: knownMcpStatus(server.status),
        }))
      : [],
    secrets: Array.isArray(list.secrets)
      ? list.secrets
          .filter(
            (secret) =>
              typeof secret?.name === "string" && Array.isArray(secret.hosts),
          )
          .map((secret) => ({
            ...secret,
            test: (SECRET_TEST_KINDS as readonly unknown[]).includes(
              secret.test,
            )
              ? secret.test
              : null,
          }))
      : [],
  };
}

// Office rows first, then the caller's own; inside a scope, sign-ins, then
// what Claude manages, then MCP servers, then secrets, then variables. The servers set in
// Claude itself are listed with the caller's rows because the caller's own
// sessions reported them; they carry no scope tag (who gets one depends on its
// Claude file, not on an Isomux scope).
export function connectionRows(
  list: ConnectionsListRes,
  username: string,
): ConnectionRow[] {
  const claude: ConnectionRowWhere = {
    kind: "claude",
    url: CLAUDE_CONNECTORS_URL,
  };
  const rows: ConnectionRow[] = [];
  for (const scope of SCOPES) {
    for (const signIn of list.signIns) {
      if (signIn.scope !== scope) continue;
      rows.push({
        kind: "signIn",
        key: `signIn:${scope}:${signIn.engine}`,
        scope,
        engine: signIn.engine,
        account: signIn.account,
        where: {
          kind: "page",
          half: scope,
          place: "signIn",
          engine: signIn.engine,
          selector: signInSelector(signIn.engine),
        },
      });
    }
    for (const connectors of list.claudeConnectors) {
      if (connectors.scope !== scope) continue;
      if (connectors.seenAt === null) {
        rows.push({
          kind: "connectorsPending",
          key: `connectorsPending:${scope}`,
          scope,
          where: claude,
        });
        continue;
      }
      if (connectors.names.length > 0)
        rows.push({
          kind: "connectors",
          key: `connectors:${scope}`,
          scope,
          names: connectors.names,
          statuses: connectors.statuses ?? [],
          where: claude,
        });
    }
    for (const server of list.mcpServers) {
      if (server.scope !== scope) continue;
      rows.push({
        kind: "mcpServer",
        key: `mcpServer:${scope}:${server.name}`,
        scope,
        name: server.name,
        host: server.host,
        credential: server.credential,
        secret: server.secret,
        problem: server.problem,
        overridden: server.overridden,
        note: noteOf(server.note),
        where: {
          kind: "page",
          half: scope,
          place: "mcpServers",
          selector: mcpServersSelector(scope, username),
        },
      });
    }
    if (scope === "personal")
      for (const server of list.engineMcpServers)
        rows.push({
          kind: "engineMcp",
          key: `engineMcp:${server.source}:${server.folder ?? ""}:${server.name}`,
          scope,
          name: server.name,
          status: server.status ?? null,
          where: {
            kind: "claudeFile",
            source: server.source,
            folder: server.folder,
          },
        });
    for (const secret of list.secrets ?? []) {
      if (secret.scope !== scope) continue;
      rows.push({
        kind: "secret",
        key: `secret:${scope}:${secret.name}`,
        scope,
        name: secret.name,
        hosts: secret.hosts,
        test: secret.test,
        note: noteOf(secret.note),
        where: {
          kind: "page",
          half: scope,
          place: "secrets",
          selector: secretsSelector(scope, username),
        },
      });
    }
    for (const variable of list.variables) {
      if (variable.scope !== scope) continue;
      rows.push({
        kind: "variable",
        key: `variable:${scope}:${variable.name}`,
        scope,
        name: variable.name,
        note: noteOf(variable.note),
        where: {
          kind: "page",
          half: scope,
          place: "variables",
          selector: variablesSelector(scope, username),
        },
      });
    }
  }
  return rows;
}
