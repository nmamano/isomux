// The remote MCP servers registered for the office and for each member
// (integrations loop, slice A2). A registration holds a name, a URL and the
// name of a secret in the same scope; never a value.
//
// STATE_ROOT/mcp-servers/office.json and STATE_ROOT/mcp-servers/users/<userId>.json,
// 0600 files in 0700 directories, written like the secret store: the URL of
// some hosted servers carries a token in its path. A file that does not parse
// is never rewritten, and a member's file is never deleted, even when its list
// becomes empty: its path is part of the member's OpenCode profile key
// (env-loader.ts), so the key must not move back.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { STATE_ROOT } from "./config.ts";
import {
  checkMcpServerName,
  checkMcpServerUrl,
  type McpServerFieldError,
} from "../shared/mcp-servers.ts";
import { checkSecretName } from "../shared/secret-hosts.ts";
import type { McpServerWire } from "../shared/contract-shapes.ts";
import type { SecretScope } from "./secret-store.ts";

export const MCP_SERVERS_DIR = "mcp-servers";

interface StoredMcpServer {
  name: string;
  url: string;
  secret: string | null;
  createdAt: number;
  updatedAt: number;
}

interface McpServersFile {
  version: 1;
  servers: StoredMcpServer[];
}

// The file exists but is not a store this version reads. Fixed text: the
// message never carries file content.
export class McpServerStoreUnreadableError extends Error {
  constructor() {
    super("the MCP servers file could not be read");
  }
}

export type McpServerChange =
  | { ok: true; server: McpServerWire }
  | { ok: false; kind: "invalid"; error: McpServerFieldError }
  | { ok: false; kind: "exists" }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "secret_not_found" }
  | { ok: false; kind: "secret_host" };

// The hosts of a secret in a scope, or null when it does not exist.
export type SecretHostsLookup = (
  scope: SecretScope,
  name: string,
) => string[] | null;

const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;

function isStoredServer(entry: unknown): entry is StoredMcpServer {
  if (!entry || typeof entry !== "object") return false;
  const s = entry as Record<string, unknown>;
  return (
    checkMcpServerName(s.name) === null &&
    typeof s.url === "string" &&
    (s.secret === null || checkSecretName(s.secret) === null) &&
    typeof s.createdAt === "number" &&
    typeof s.updatedAt === "number"
  );
}

function toWire(server: StoredMcpServer): McpServerWire {
  return { ...server };
}

export function mcpServersPathFor(root: string, scope: SecretScope): string {
  const dir = join(root, MCP_SERVERS_DIR);
  if (scope.kind === "office") return join(dir, "office.json");
  if (!SAFE_USER_ID.test(scope.userId)) throw new Error("invalid user id");
  return join(dir, "users", `${scope.userId}.json`);
}

export function createMcpServerStore(
  secretHosts: SecretHostsLookup,
  root: string = STATE_ROOT,
) {
  const dir = join(root, MCP_SERVERS_DIR);
  const usersDir = join(dir, "users");

  function read(scope: SecretScope): StoredMcpServer[] {
    const path = mcpServersPathFor(root, scope);
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new McpServerStoreUnreadableError();
    }
    const file = parsed as Partial<McpServersFile> | null;
    if (
      !file ||
      typeof file !== "object" ||
      file.version !== 1 ||
      !Array.isArray(file.servers) ||
      !file.servers.every(isStoredServer)
    )
      throw new McpServerStoreUnreadableError();
    return file.servers;
  }

  function write(scope: SecretScope, servers: StoredMcpServer[]): void {
    const path = mcpServersPathFor(root, scope);
    const directory = scope.kind === "office" ? dir : usersDir;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chmodSync(directory, 0o700);
    const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
    const content = `${JSON.stringify({ version: 1, servers: sorted } satisfies McpServersFile, null, 2)}\n`;
    const temp = join(
      directory,
      `.mcp-servers.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let fd: number | null = null;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, path);
    } finally {
      if (fd !== null) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }

  // The URL and secret together: a secret must exist in the same scope and
  // list the URL's host.
  function checkTarget(
    scope: SecretScope,
    url: unknown,
    secret: unknown,
  ):
    | { ok: true; url: string; secret: string | null }
    | Exclude<McpServerChange, { ok: true }> {
    if (secret !== null && checkSecretName(secret) !== null)
      return {
        ok: false,
        kind: "invalid",
        error: { field: "secret", reason: "invalid" },
      };
    const checked = checkMcpServerUrl(url, secret !== null);
    if (!checked.ok)
      return { ok: false, kind: "invalid", error: checked.error };
    if (secret === null) return { ok: true, url: checked.url, secret: null };
    const hosts = secretHosts(scope, secret as string);
    if (!hosts) return { ok: false, kind: "secret_not_found" };
    if (!hosts.includes(checked.host))
      return { ok: false, kind: "secret_host" };
    return { ok: true, url: checked.url, secret: secret as string };
  }

  return {
    list(scope: SecretScope): McpServerWire[] {
      return read(scope).map(toWire);
    },

    create(
      scope: SecretScope,
      input: Record<string, unknown>,
    ): McpServerChange {
      const nameError = checkMcpServerName(input.name);
      if (nameError) return { ok: false, kind: "invalid", error: nameError };
      const target = checkTarget(scope, input.url, input.secret ?? null);
      if (!target.ok) return target;
      const servers = read(scope);
      const name = input.name as string;
      if (servers.some((s) => s.name === name))
        return { ok: false, kind: "exists" };
      const now = Date.now();
      const server: StoredMcpServer = {
        name,
        url: target.url,
        secret: target.secret,
        createdAt: now,
        updatedAt: now,
      };
      write(scope, [...servers, server]);
      return { ok: true, server: toWire(server) };
    },

    update(
      scope: SecretScope,
      name: string,
      patch: Record<string, unknown>,
    ): McpServerChange {
      const servers = read(scope);
      const server = servers.find((s) => s.name === name);
      if (!server) return { ok: false, kind: "not_found" };
      const target = checkTarget(
        scope,
        patch.url !== undefined ? patch.url : server.url,
        patch.secret !== undefined ? patch.secret : server.secret,
      );
      if (!target.ok) return target;
      server.url = target.url;
      server.secret = target.secret;
      server.updatedAt = Date.now();
      write(scope, servers);
      return { ok: true, server: toWire(server) };
    },

    remove(scope: SecretScope, name: string): boolean {
      const servers = read(scope);
      const next = servers.filter((s) => s.name !== name);
      if (next.length === servers.length) return false;
      write(scope, next);
      return true;
    },
  };
}

export type McpServerStore = ReturnType<typeof createMcpServerStore>;
