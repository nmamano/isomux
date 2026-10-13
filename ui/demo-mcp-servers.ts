// The demo's MCP server routes (mcpServers.* and officeMcpServers.*) and the
// rows they add to the integrations list, with the server's codes and checks.

import {
  checkMcpServerName,
  checkMcpServerUrl,
  mcpServerHost,
  type McpServerFieldError,
} from "../shared/mcp-servers.ts";
import { checkSecretName } from "../shared/secret-hosts.ts";
import { checkConnectionNote } from "../shared/connection-notes.ts";
import type {
  ConnectionsListRes,
  McpServerWire,
} from "../shared/contract-shapes.ts";
import { ApiError, type ApiMethod } from "./api.ts";
import { demoSecretHosts } from "./demo-secrets.ts";

const scopes = new Map<string, McpServerWire[]>();

function refuse(error: McpServerFieldError): never {
  throw new ApiError(
    400,
    "invalid_mcp_server",
    `the ${error.field} field is not valid`,
    { code: "invalid_mcp_server", field: error.field, reason: error.reason },
  );
}

function checkTarget(
  key: string,
  url: unknown,
  secret: unknown,
): { url: string; secret: string | null } {
  if (secret !== null && checkSecretName(secret) !== null)
    refuse({ field: "secret", reason: "invalid" });
  const checked = checkMcpServerUrl(url, secret !== null);
  if (!checked.ok) refuse(checked.error);
  if (secret === null) return { url: checked.url, secret: null };
  const hosts = demoSecretHosts(key, secret as string);
  if (!hosts)
    throw new ApiError(
      422,
      "secret_not_found",
      "no secret with this name in the same scope",
    );
  if (!hosts.includes(checked.host))
    throw new ApiError(
      422,
      "secret_host_mismatch",
      "the secret does not list the server's host",
    );
  return { url: checked.url, secret: secret as string };
}

function noteOf(note: unknown): string | null {
  const checked = checkConnectionNote(note);
  if (!checked.ok) refuse({ field: "note", reason: checked.reason });
  return checked.note;
}

// Answers an MCP servers route, or returns undefined for any other path.
export function demoMcpServersRoute(
  method: ApiMethod,
  pathname: string,
  body: unknown,
  userId: (username: string) => string | null,
): { handled: true; result: unknown } | undefined {
  const match =
    pathname.match(/^\/api\/office\/mcp-servers(?:\/([^/]+))?$/) ??
    pathname.match(/^\/api\/users\/([^/]+)\/mcp-servers(?:\/([^/]+))?$/);
  if (!match) return undefined;
  const office = pathname.startsWith("/api/office/");
  let key = "office";
  let name: string | undefined = match[1];
  if (!office) {
    const id = userId(decodeURIComponent(match[1]));
    if (!id) throw new ApiError(404, "not_found", "Not found");
    key = id;
    name = match[2];
  }
  name = name === undefined ? undefined : decodeURIComponent(name);
  const list = scopes.get(key) ?? [];
  scopes.set(key, list);
  const b = (body ?? {}) as Record<string, unknown>;
  const now = Date.now();

  if (name === undefined) {
    if (method === "GET") return { handled: true, result: { servers: list } };
    if (method !== "POST") return undefined;
    const nameError = checkMcpServerName(b.name);
    if (nameError) refuse(nameError);
    const target = checkTarget(key, b.url, b.secret ?? null);
    const note = noteOf(b.note ?? null);
    if (list.some((s) => s.name === b.name))
      throw new ApiError(
        409,
        "mcp_server_exists",
        "an MCP server with this name exists",
      );
    const server: McpServerWire = {
      name: b.name as string,
      ...target,
      createdAt: now,
      updatedAt: now,
      note,
      // The demo has no authorization server to sign in to.
      oauth: null,
    };
    list.push(server);
    list.sort((a, c) => a.name.localeCompare(c.name));
    return { handled: true, result: { server } };
  }

  const index = list.findIndex((s) => s.name === name);
  if (index === -1) throw new ApiError(404, "not_found", "Not found");
  const server = list[index];
  if (method === "DELETE") {
    list.splice(index, 1);
    return { handled: true, result: undefined };
  }
  if (method !== "PATCH") return undefined;
  const target = checkTarget(
    key,
    b.url !== undefined ? b.url : server.url,
    b.secret !== undefined ? b.secret : server.secret,
  );
  const note = b.note !== undefined ? noteOf(b.note) : server.note;
  Object.assign(server, target, { updatedAt: now, note });
  return { handled: true, result: { server } };
}

// The integrations list rows, built as the server builds them.
export function demoMcpServerRows(
  userId: string | null,
  owner: boolean,
): ConnectionsListRes["mcpServers"] {
  const own = userId ? (scopes.get(userId) ?? []) : [];
  const ownNames = new Set(own.map((s) => s.name));
  const row = (
    key: string,
    server: McpServerWire,
    showSecret: boolean,
  ): ConnectionsListRes["mcpServers"][number] => {
    const host = mcpServerHost(server.url);
    const hosts = server.secret ? demoSecretHosts(key, server.secret) : null;
    return {
      scope: key === "office" ? "office" : "personal",
      name: server.name,
      host,
      credential: server.secret !== null,
      secret: showSecret ? server.secret : null,
      problem:
        server.secret === null
          ? null
          : !hosts
            ? "secret_missing"
            : hosts.includes(host)
              ? null
              : "secret_host",
      overridden: key === "office" && ownNames.has(server.name),
      note: server.note,
    };
  };
  return [
    ...(scopes.get("office") ?? []).map((s) => row("office", s, owner)),
    ...own.map((s) => row(userId!, s, true)),
  ];
}
