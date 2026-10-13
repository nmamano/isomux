// The integrations list (GET /api/me/connections, task 911c9bbb): every
// connection the caller's agents can use, built on the server so the client
// never reads a value-bearing env route to draw it. Names only.

import type {
  ConnectionScope,
  ConnectionsListRes,
} from "../shared/contract-shapes.ts";
import type { McpServerStatus, SecretWire } from "../shared/contract-shapes.ts";
import type { ProviderAccountWire } from "../shared/types.ts";
import type { ClaudeConnectorRecord } from "./claude-connectors.ts";
import { secretTestKind } from "./connection-tests.ts";

export interface ConnectionsListSources {
  // officeEnv.get's rule: office variables reach office owners only.
  officeOwner: boolean;
  officeVariableNames: () => string[];
  personalVariableNames: () => string[];
  accounts: () => Promise<ProviderAccountWire[]>;
  // Null when the scope's Claude sign-in has no claude.ai login to read.
  claudeConnectorDir: (scope: ConnectionScope) => string | null;
  claudeConnectorsFor: (dir: string) => ClaudeConnectorRecord | null;
  claudeConnectorStatusesFor: (
    dir: string,
  ) => { name: string; status: McpServerStatus }[];
  // Isomux's remote MCP servers, hosts only (server/mcp-servers.ts), and the
  // ones set in Claude itself as the caller's agents last reported them.
  mcpServers: () => ConnectionsListRes["mcpServers"];
  engineMcpServers: () => ConnectionsListRes["engineMcpServers"];
  // The secret store's list for a scope (names, hosts and form; no value).
  secrets: (scope: ConnectionScope) => SecretWire[];
}

const SCOPES: ConnectionScope[] = ["office", "personal"];

function sortedNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

export async function buildConnectionsList(
  sources: ConnectionsListSources,
): Promise<ConnectionsListRes> {
  const variables: ConnectionsListRes["variables"] = [
    ...(sources.officeOwner
      ? sortedNames(sources.officeVariableNames()).map((name) => ({
          scope: "office" as const,
          name,
        }))
      : []),
    ...sortedNames(sources.personalVariableNames()).map((name) => ({
      scope: "personal" as const,
      name,
    })),
  ];

  // A sign-in probe that fails drops the sign-ins, not the whole list.
  let accounts: ProviderAccountWire[] = [];
  try {
    accounts = await sources.accounts();
  } catch {
    accounts = [];
  }
  const connected = accounts.filter(
    (account) => account.accountStatus === "connected",
  );
  const signIns: ConnectionsListRes["signIns"] = connected.map((account) => ({
    scope: account.scope,
    engine: account.provider,
    account: account.accountLabel?.trim() || null,
  }));

  const claudeConnectors: ConnectionsListRes["claudeConnectors"] = [];
  for (const scope of SCOPES) {
    if (
      !connected.some(
        (account) => account.provider === "claude" && account.scope === scope,
      )
    )
      continue;
    const dir = sources.claudeConnectorDir(scope);
    if (!dir) continue;
    const record = sources.claudeConnectorsFor(dir);
    claudeConnectors.push({
      scope,
      seenAt: record?.seenAt ?? null,
      names: record ? [...record.names] : [],
      statuses: record ? sources.claudeConnectorStatusesFor(dir) : [],
    });
  }

  // A store that cannot be read drops its rows, not the whole list.
  let mcpServers: ConnectionsListRes["mcpServers"] = [];
  try {
    mcpServers = sources.mcpServers();
  } catch {
    mcpServers = [];
  }

  // Office secrets reach office owners only (ruling 12). A store that cannot
  // be read drops its own rows.
  const secrets: NonNullable<ConnectionsListRes["secrets"]> = [];
  for (const scope of SCOPES) {
    if (scope === "office" && !sources.officeOwner) continue;
    let listed: SecretWire[] = [];
    try {
      listed = sources.secrets(scope);
    } catch {
      listed = [];
    }
    for (const secret of listed)
      secrets.push({
        scope,
        name: secret.name,
        hosts: [...secret.hosts],
        test: secretTestKind(secret),
      });
  }

  return {
    variables,
    signIns,
    claudeConnectors,
    mcpServers,
    engineMcpServers: sources.engineMcpServers(),
    secrets,
  };
}
