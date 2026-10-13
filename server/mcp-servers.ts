// The remote MCP servers an agent gets (integrations loop, slice A2): the
// office's, then its member's, a member server replacing an office server of
// the same name. Each engine takes the result through a channel that keeps the
// header off argv and out of the environment (internal-docs/integrations-loop.md,
// "Probe facts"): Claude setMcpServers, the Codex thread config, the OpenCode
// config file.
//
// Until secrets slice B2, a header carries the secret's real value. B2 puts
// the placeholder here instead, in this one place.
//
// Resolution fails closed and quiet: an unreadable file, a missing secret or
// a secret that no longer lists the host leaves servers out with a fixed log
// line, and never stops a session from starting.

import { mcpEngineName, mcpServerHost } from "../shared/mcp-servers.ts";
import type {
  ConnectionsListRes,
  McpServerProblem,
  McpServerWire,
} from "../shared/contract-shapes.ts";
import type { SecretForm } from "../shared/secret-hosts.ts";
import {
  createMcpServerStore,
  type McpServerStore,
} from "./mcp-server-store.ts";
import {
  createSecretStore,
  type SecretScope,
  type SecretStore,
} from "./secret-store.ts";

// One server as an engine receives it.
export interface AgentMcpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface McpServerSources {
  servers: Pick<McpServerStore, "list">;
  secrets: Pick<SecretStore, "readSecretValues">;
}

// The stores under STATE_ROOT. Both read their files on every call, so one
// instance per caller is as current as a shared one.
export function createMcpServerSources(root?: string): McpServerSources & {
  servers: McpServerStore;
  secrets: SecretStore;
} {
  const secrets = createSecretStore(root);
  const servers = createMcpServerStore(
    (scope, name) => secrets.readSecretValues(scope, name)?.hosts ?? null,
    root,
  );
  return { servers, secrets };
}

// The token alone is stored; MCP servers take it as a Bearer token.
export function credentialHeader(
  form: SecretForm,
  value: string,
): Record<string, string> {
  return form.kind === "authorization"
    ? { Authorization: `Bearer ${value}` }
    : { [form.header]: value };
}

function listOrNothing(
  sources: McpServerSources,
  scope: SecretScope,
): McpServerWire[] {
  try {
    return sources.servers.list(scope);
  } catch {
    console.warn(
      `[mcp] the ${scope.kind} MCP servers file could not be read; its servers are left out`,
    );
    return [];
  }
}

// The registrations in force for a member: office first, the member's own
// replacing any office server of the same name.
export function registrationsFor(
  sources: McpServerSources,
  userId: string | null | undefined,
): { scope: SecretScope; server: McpServerWire }[] {
  const office: SecretScope = { kind: "office" };
  const member: SecretScope | null = userId ? { kind: "user", userId } : null;
  const own = member ? listOrNothing(sources, member) : [];
  const ownNames = new Set(own.map((s) => s.name));
  return [
    ...listOrNothing(sources, office)
      .filter((server) => !ownNames.has(server.name))
      .map((server) => ({ scope: office, server })),
    ...own.map((server) => ({ scope: member!, server })),
  ];
}

type CredentialProblem = McpServerProblem | "unreadable";

// The one rule for a registration's secret: it exists in the same scope and
// lists the server's host. The agents' headers and the Test button (A3) both
// use it.
export function mcpServerSecret(
  sources: McpServerSources,
  scope: SecretScope,
  server: McpServerWire,
):
  | { ok: true; secret: { value: string; form: SecretForm } | null }
  | { ok: false; problem: CredentialProblem } {
  if (server.secret === null) return { ok: true, secret: null };
  let secret: ReturnType<SecretStore["readSecretValues"]>;
  try {
    secret = sources.secrets.readSecretValues(scope, server.secret);
  } catch {
    return { ok: false, problem: "unreadable" };
  }
  if (!secret) return { ok: false, problem: "secret_missing" };
  if (!secret.hosts.includes(mcpServerHost(server.url)))
    return { ok: false, problem: "secret_host" };
  return { ok: true, secret: { value: secret.value, form: secret.form } };
}

type Credential =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; problem: CredentialProblem };

function credentialFor(
  sources: McpServerSources,
  scope: SecretScope,
  server: McpServerWire,
): Credential {
  const resolved = mcpServerSecret(sources, scope, server);
  if (!resolved.ok) return resolved;
  const { secret } = resolved;
  return {
    ok: true,
    headers: secret ? credentialHeader(secret.form, secret.value) : {},
  };
}

export function mcpServersForUserId(
  sources: McpServerSources,
  userId: string | null | undefined,
): AgentMcpServer[] {
  const result: AgentMcpServer[] = [];
  for (const { scope, server } of registrationsFor(sources, userId)) {
    const credential = credentialFor(sources, scope, server);
    if (!credential.ok) {
      console.warn(
        credential.problem === "unreadable"
          ? `[mcp] ${server.name}: the ${scope.kind} secrets file could not be read; the server is left out`
          : `[mcp] ${server.name}: its secret is missing or does not list the host; the server is left out`,
      );
      continue;
    }
    result.push({
      name: mcpEngineName(server.name),
      url: server.url,
      headers: credential.headers,
    });
  }
  return result;
}

// The integrations list rows. Hosts only, never a URL; the secret name of an
// office server only for an owner.
export function mcpServerRows(
  sources: McpServerSources,
  userId: string,
  officeOwner: boolean,
): ConnectionsListRes["mcpServers"] {
  const office: SecretScope = { kind: "office" };
  const member: SecretScope = { kind: "user", userId };
  const own = listOrNothing(sources, member);
  const ownNames = new Set(own.map((s) => s.name));
  const row = (
    scope: SecretScope,
    server: McpServerWire,
    showSecret: boolean,
  ): ConnectionsListRes["mcpServers"][number] => {
    const credential = credentialFor(sources, scope, server);
    return {
      scope: scope.kind === "office" ? "office" : "personal",
      name: server.name,
      host: mcpServerHost(server.url),
      credential: server.secret !== null,
      secret: showSecret ? server.secret : null,
      problem:
        credential.ok || credential.problem === "unreadable"
          ? null
          : credential.problem,
      overridden: scope.kind === "office" && ownNames.has(server.name),
      note: server.note,
    };
  };
  return [
    ...listOrNothing(sources, office).map((server) =>
      row(office, server, officeOwner),
    ),
    ...own.map((server) => row(member, server, true)),
  ];
}
