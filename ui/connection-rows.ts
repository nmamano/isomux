// The caller's connections (GET /api/me/connections) as the Integrations page
// reads them, and the outside addresses the page links to. Pure, so the
// normalization is tested without a DOM.

import {
  SECRET_TEST_KINDS,
  knownMcpStatus,
  type ConnectionsListRes,
} from "../shared/contract-shapes.ts";

export const CLAUDE_CONNECTORS_URL =
  "https://claude.ai/new#customize/connectors";

export const BEDROCK_GUIDE =
  "https://isomux.com/docs/llm-providers#claude-on-amazon-bedrock";

// A tool count from the server, or undefined for anything else.
function toolCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

// The answer of GET /api/me/connections as the page reads it, or null when
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
            const tools = toolCount(entry?.tools);
            return status && typeof entry.name === "string"
              ? [
                  {
                    name: entry.name,
                    status,
                    ...(tools !== undefined ? { tools } : {}),
                  },
                ]
              : [];
          })
        : [],
    })),
    mcpServers: Array.isArray(list.mcpServers) ? list.mcpServers : [],
    engineMcpServers: Array.isArray(list.engineMcpServers)
      ? list.engineMcpServers.map((server) => {
          const tools = toolCount(server.tools);
          const { tools: _tools, ...rest } = server;
          return {
            ...rest,
            signIn:
              server.signIn === "office" || server.signIn === "personal"
                ? server.signIn
                : null,
            status: knownMcpStatus(server.status),
            ...(tools !== undefined ? { tools } : {}),
          };
        })
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
