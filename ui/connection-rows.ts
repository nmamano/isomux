// The rows of the integrations list (ConnectionsList), from the server's
// GET /api/me/connections. Pure, so the row shape is tested without a DOM.
// Every row says what it is, the account where Isomux knows it, who gets it
// and where it is set.

import type {
  ConnectionScope,
  ConnectionsListRes,
} from "../shared/contract-shapes.ts";

export const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

export type ConnectionRowWhere =
  // A place on the Connections page, in one of its two halves. The selector
  // finds it once that half is mounted.
  | {
      kind: "page";
      half: ConnectionScope;
      place: "variables" | "signIn" | "mcpServers";
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
      where: ConnectionRowWhere;
    }
  // An MCP server set in Claude itself, as the caller's sessions report it.
  | {
      kind: "engineMcp";
      key: string;
      scope: ConnectionScope;
      name: string;
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

export function signInSelector(engine: "claude" | "codex"): string {
  return `[data-provider-card="${engine}"]`;
}

const SCOPES: ConnectionScope[] = ["office", "personal"];

// Office rows first, then the caller's own; inside a scope, sign-ins, then
// what Claude manages, then MCP servers, then variables. The servers set in
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
          where: {
            kind: "claudeFile",
            source: server.source,
            folder: server.folder,
          },
        });
    for (const variable of list.variables) {
      if (variable.scope !== scope) continue;
      rows.push({
        kind: "variable",
        key: `variable:${scope}:${variable.name}`,
        scope,
        name: variable.name,
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
