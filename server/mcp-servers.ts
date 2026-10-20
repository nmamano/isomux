// The remote MCP servers an agent gets (integrations loop, slice A2): the
// office's, then its member's, a member server replacing an office server of
// the same name. Each engine takes the result through a channel that keeps the
// header off argv and out of the environment (internal-docs/integrations-loop.md,
// "Probe facts"): Claude setMcpServers, the Codex thread config, the OpenCode
// config file.
//
// A header carries the secret's placeholder, never its value (secrets B2):
// the secret proxy swaps it for the value on the way to the server's host,
// which the secret lists. With no proxy listening, a server with a secret is
// left out.
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
import { oauthAccessToken, oauthSignInNeeded } from "./mcp-oauth-tokens.ts";
import {
  createSecretStore,
  type SecretScope,
  type SecretStore,
  type SecretStoreOptions,
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
export function createMcpServerSources(
  root?: string,
  secretOptions?: SecretStoreOptions,
): McpServerSources & {
  servers: McpServerStore;
  secrets: SecretStore;
} {
  const secrets = createSecretStore(root, secretOptions);
  const servers = createMcpServerStore(
    (scope, name) => secrets.readSecretValues(scope, name)?.hosts ?? null,
    root,
  );
  return { servers, secrets };
}

// Usually the token alone is stored, and goes as a Bearer token. A value
// that already starts with its scheme goes as it is: a Fly token is
// "FlyV1 fm2_...", and flyctl sends it so, without Bearer.
export function credentialHeader(
  form: SecretForm,
  value: string,
): Record<string, string> {
  if (form.kind === "header") return { [form.header]: value };
  return {
    Authorization: /^[A-Za-z][A-Za-z0-9-]* \S/.test(value)
      ? value
      : `Bearer ${value}`,
  };
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

// The placeholder for a secret, from the secrets runtime, which registers
// this at boot. Null: no proxy listens (or none was started), so a header
// could not reach the host with the value.
let placeholderOf: (scope: SecretScope, name: string) => string | null = () =>
  null;

export function setMcpPlaceholderProvider(
  fn: typeof placeholderOf,
): typeof placeholderOf {
  const previous = placeholderOf;
  placeholderOf = fn;
  return previous;
}

type CredentialProblem = McpServerProblem | "unreadable";

// A signed-in server with no token yet, before the refresh after a restart:
// left out of a session, and no problem on its row.
function rowProblem(
  scope: SecretScope,
  server: McpServerWire,
  problem: CredentialProblem,
): McpServerProblem | null {
  if (problem === "unreadable") return null;
  if (problem !== "sign_in" || !server.oauth) return problem;
  if (oauthSignInNeeded(scope, server.name)) return "sign_in_again";
  return server.oauth.signedIn ? null : "sign_in";
}

// The one rule for a registration's secret: it exists in the same scope and
// lists the server's host. The value it returns is for the Test button (A3),
// which runs in the server. The agents' headers never use it: they take only
// the form, with the placeholder (secrets B2, headersFor below). An OAuth
// server's credential is its access token, only while it is cached for the
// registration's current URL (integrations A2b).
export function mcpServerSecret(
  sources: McpServerSources,
  scope: SecretScope,
  server: McpServerWire,
):
  | { ok: true; secret: { value: string; form: SecretForm } | null }
  | { ok: false; problem: CredentialProblem } {
  if (server.oauth) {
    const token = oauthAccessToken(scope, server.name, server.url);
    return token
      ? { ok: true, secret: { value: token, form: { kind: "authorization" } } }
      : { ok: false, problem: "sign_in" };
  }
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
  | { ok: true; form: SecretForm | null }
  | { ok: false; problem: CredentialProblem | "no_proxy" };

// Whether a server's secret is in order, and the form its header takes.
// Never the value.
function credentialFor(
  sources: McpServerSources,
  scope: SecretScope,
  server: McpServerWire,
): Credential {
  const resolved = mcpServerSecret(sources, scope, server);
  if (!resolved.ok) return resolved;
  return { ok: true, form: resolved.secret?.form ?? null };
}

// The headers an engine sends: the placeholder in the secret's form.
function headersFor(
  sources: McpServerSources,
  scope: SecretScope,
  server: McpServerWire,
):
  | { ok: true; headers: Record<string, string> }
  | { ok: false; problem: CredentialProblem | "no_proxy" } {
  // An OAuth server's access token is not a secret of the store, so the
  // proxy has no placeholder for it: the header carries the token itself.
  if (server.oauth) {
    const token = mcpServerSecret(sources, scope, server);
    if (!token.ok) return token;
    return {
      ok: true,
      headers: token.secret
        ? credentialHeader(token.secret.form, token.secret.value)
        : {},
    };
  }
  const credential = credentialFor(sources, scope, server);
  if (!credential.ok) return credential;
  if (credential.form === null || server.secret === null)
    return { ok: true, headers: {} };
  const placeholder = placeholderOf(scope, server.secret);
  if (!placeholder) return { ok: false, problem: "no_proxy" };
  return { ok: true, headers: credentialHeader(credential.form, placeholder) };
}

export function mcpServersForUserId(
  sources: McpServerSources,
  userId: string | null | undefined,
): AgentMcpServer[] {
  const result: AgentMcpServer[] = [];
  for (const { scope, server } of registrationsFor(sources, userId)) {
    const credential = headersFor(sources, scope, server);
    if (!credential.ok) {
      console.warn(
        credential.problem === "unreadable"
          ? `[mcp] ${server.name}: the ${scope.kind} secrets file could not be read; the server is left out`
          : credential.problem === "no_proxy"
            ? `[mcp] ${server.name}: no secret proxy listens; the server is left out`
            : credential.problem === "sign_in"
              ? `[mcp] ${server.name}: it has no access token (sign in); the server is left out`
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
        credential.ok || credential.problem === "no_proxy"
          ? null
          : rowProblem(scope, server, credential.problem),
      overridden: scope.kind === "office" && ownNames.has(server.name),
      note: server.note,
      oauth: server.oauth !== null,
    };
  };
  return [
    ...listOrNothing(sources, office).map((server) =>
      row(office, server, officeOwner),
    ),
    ...own.map((server) => row(member, server, true)),
  ];
}
