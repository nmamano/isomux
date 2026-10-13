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
      place: "variables" | "signIn";
      engine?: "claude" | "codex";
      selector: string;
    }
  | { kind: "claude"; url: string };

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

export function signInSelector(engine: "claude" | "codex"): string {
  return `[data-provider-card="${engine}"]`;
}

const SCOPES: ConnectionScope[] = ["office", "personal"];

// Office rows first, then the caller's own; inside a scope, sign-ins, then
// what Claude manages, then variables.
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
