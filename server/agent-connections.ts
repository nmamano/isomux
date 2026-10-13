// GET /api/agent-connections (integrations loop, slice A4): the connections
// an agent gets, with the usage notes its members wrote for them. Built from
// the rules the spawn uses, so it lists what the agent really has: a member's
// variable or MCP server shadows the office one of the same name, and an MCP
// server the spawn leaves out is not listed.
//
// Never a value, a URL path or query, or the secret behind an MCP server. A
// source that cannot be read drops its own rows.

import type {
  AgentConnectionWire,
  ConnectionScope,
} from "../shared/contract-shapes.ts";
import { mcpEngineName, mcpServerHost } from "../shared/mcp-servers.ts";
import {
  mcpServerSecret,
  registrationsFor,
  type McpServerSources,
} from "./mcp-servers.ts";
import type { SecretScope, SecretStore } from "./secret-store.ts";

export interface AgentConnectionsSources {
  // The managed variables as the spawn merges them (env-loader.ts). Each may
  // throw; a throw drops that scope's variables.
  officeVariables: () => Record<string, string>;
  officeVariableNotes: () => Record<string, string>;
  memberVariables: (userId: string) => Record<string, string>;
  memberVariableNotes: (userId: string) => Record<string, string>;
  secrets: Pick<SecretStore, "list">;
  mcp: McpServerSources;
}

function orNothing<T>(read: () => T, nothing: T): T {
  try {
    return read();
  } catch {
    return nothing;
  }
}

function scopeOf(scope: SecretScope): ConnectionScope {
  return scope.kind === "office" ? "office" : "personal";
}

export function buildAgentConnections(
  sources: AgentConnectionsSources,
  userId: string | null,
): AgentConnectionWire[] {
  const connections: AgentConnectionWire[] = [];

  // Variables: the member's own replace the office's of the same name, as in
  // buildEnvForUserId.
  const office = orNothing(sources.officeVariables, {});
  const officeNotes = orNothing(sources.officeVariableNotes, {});
  const member = userId
    ? orNothing(() => sources.memberVariables(userId), {})
    : {};
  const memberNotes = userId
    ? orNothing(() => sources.memberVariableNotes(userId), {})
    : {};
  const variable = (
    scope: ConnectionScope,
    name: string,
    notes: Record<string, string>,
  ): AgentConnectionWire => ({
    kind: "variable",
    scope,
    name,
    hosts: [],
    note: Object.hasOwn(notes, name) ? notes[name] : null,
  });
  for (const name of Object.keys(office).sort())
    if (!Object.hasOwn(member, name))
      connections.push(variable("office", name, officeNotes));
  for (const name of Object.keys(member).sort())
    connections.push(variable("personal", name, memberNotes));

  // Secrets: both scopes; there is no same-name rule between them.
  const secretScopes: SecretScope[] = [{ kind: "office" }];
  if (userId) secretScopes.push({ kind: "user", userId });
  for (const scope of secretScopes)
    for (const secret of orNothing(() => sources.secrets.list(scope), []))
      connections.push({
        kind: "secret",
        scope: scopeOf(scope),
        name: secret.name,
        hosts: [...secret.hosts],
        note: secret.note,
      });

  // MCP servers: the registrations the spawn gives the engines, less those
  // whose secret check fails. registrationsFor drops an unreadable store.
  for (const { scope, server } of registrationsFor(sources.mcp, userId)) {
    if (!mcpServerSecret(sources.mcp, scope, server).ok) continue;
    connections.push({
      kind: "mcp-server",
      scope: scopeOf(scope),
      name: server.name,
      engineName: mcpEngineName(server.name),
      hosts: [mcpServerHost(server.url)],
      note: server.note,
    });
  }
  return connections;
}
