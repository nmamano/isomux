// The remote MCP servers registered for the office and for each member
// (integrations loop, slice A2). A registration holds a name, a URL and the
// name of a secret in the same scope; never a value.
//
// STATE_ROOT/mcp-servers/office.json and STATE_ROOT/mcp-servers/users/<userId>.json,
// 0600 files in 0700 directories, written like the secret store: the URL of
// some hosted servers carries a token in its path. A file that does not parse
// is never rewritten, and a member's file is deleted only when the member
// leaves the office, not when its list becomes empty: its path is part of the
// member's OpenCode profile key (env-loader.ts), so the key must not move back.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import { checkConnectionNote } from "../shared/connection-notes.ts";

export const MCP_SERVERS_DIR = "mcp-servers";

interface StoredMcpServer {
  name: string;
  url: string;
  secret: string | null;
  createdAt: number;
  updatedAt: number;
  // The usage note for agents (integrations A4); absent when there is none.
  note?: string;
  // The MCP authorization flow (integrations A2b); absent for other servers.
  oauth?: StoredOAuth;
}

export type TokenEndpointAuth =
  | "none"
  | "client_secret_post"
  | "client_secret_basic";

// The client registration and what discovery found. No credential: the
// client secret and the refresh token are secrets of the same scope, named
// here.
export interface StoredOAuth {
  // The pasted client, or the one dynamic registration gave; null until then.
  clientId: string | null;
  // A pasted client stays when the URL changes; a registered one does not.
  pasted: boolean;
  clientSecret: string | null;
  tokenEndpointAuth: TokenEndpointAuth;
  // The redirect URI a registered client was registered with.
  redirectUri: string | null;
  issuer: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  scope: string | null;
  // The secret that holds the refresh token; null until the first sign-in.
  refreshToken: string | null;
  // The secrets the flow wrote in this scope. A same-name secret not listed
  // here is the member's, and the flow never writes it.
  ownedSecrets: string[];
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

const nullableString = (value: unknown) =>
  value === null || typeof value === "string";

function isStoredOAuth(entry: unknown): entry is StoredOAuth {
  if (!entry || typeof entry !== "object") return false;
  const o = entry as Record<string, unknown>;
  return (
    nullableString(o.clientId) &&
    typeof o.pasted === "boolean" &&
    nullableString(o.clientSecret) &&
    ["none", "client_secret_post", "client_secret_basic"].includes(
      o.tokenEndpointAuth as string,
    ) &&
    nullableString(o.redirectUri) &&
    nullableString(o.issuer) &&
    nullableString(o.authorizationEndpoint) &&
    nullableString(o.tokenEndpoint) &&
    nullableString(o.scope) &&
    nullableString(o.refreshToken) &&
    Array.isArray(o.ownedSecrets) &&
    o.ownedSecrets.every((name) => typeof name === "string")
  );
}

function isStoredServer(entry: unknown): entry is StoredMcpServer {
  if (!entry || typeof entry !== "object") return false;
  const s = entry as Record<string, unknown>;
  return (
    (s.oauth === undefined || isStoredOAuth(s.oauth)) &&
    checkMcpServerName(s.name) === null &&
    typeof s.url === "string" &&
    (s.secret === null || checkSecretName(s.secret) === null) &&
    typeof s.createdAt === "number" &&
    typeof s.updatedAt === "number" &&
    // Any string: the note rule is checked at write only.
    (s.note === undefined || typeof s.note === "string")
  );
}

function toWire(server: StoredMcpServer): McpServerWire {
  return {
    name: server.name,
    url: server.url,
    secret: server.secret,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    note: server.note ?? null,
    oauth: server.oauth
      ? {
          clientId: server.oauth.clientId,
          signedIn: server.oauth.refreshToken !== null,
        }
      : null,
  };
}

function checkNote(
  note: unknown,
):
  | { ok: true; note: string | null }
  | Extract<McpServerChange, { kind: "invalid" }> {
  const checked = checkConnectionNote(note);
  return checked.ok
    ? checked
    : {
        ok: false,
        kind: "invalid",
        error: { field: "note", reason: checked.reason },
      };
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
  // An OAuth server takes no secret and the URL rules of a credential.
  function checkTarget(
    scope: SecretScope,
    url: unknown,
    secret: unknown,
    oauth = false,
  ):
    | { ok: true; url: string; secret: string | null }
    | Exclude<McpServerChange, { ok: true }> {
    if (
      (secret !== null && checkSecretName(secret) !== null) ||
      (oauth && secret !== null)
    )
      return {
        ok: false,
        kind: "invalid",
        error: { field: "secret", reason: "invalid" },
      };
    const checked = checkMcpServerUrl(url, secret !== null || oauth);
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

    // The whole stored record, for the OAuth flow only (server/mcp-oauth.ts).
    oauthOf(
      scope: SecretScope,
      name: string,
    ): { url: string; oauth: StoredOAuth } | null {
      const server = read(scope).find((s) => s.name === name);
      return server?.oauth ? { url: server.url, oauth: server.oauth } : null;
    },

    // Saves what the flow learned, only while the registration still has
    // the URL the flow started with. False when it changed or went away.
    setOAuth(
      scope: SecretScope,
      name: string,
      url: string,
      oauth: StoredOAuth,
    ): boolean {
      const servers = read(scope);
      const server = servers.find((s) => s.name === name);
      if (!server?.oauth || server.url !== url) return false;
      server.oauth = oauth;
      write(scope, servers);
      return true;
    },

    // The secrets the scope's OAuth registrations own, for the secrets
    // runtime (integrations A2b). Throws when the file cannot be read.
    oauthOwnedSecrets(scope: SecretScope): string[] {
      return read(scope).flatMap((s) => s.oauth?.ownedSecrets ?? []);
    },

    // The member scopes that have a file, and the office.
    scopes(): SecretScope[] {
      let users: string[] = [];
      try {
        users = readdirSync(usersDir)
          .filter((file) => file.endsWith(".json"))
          .map((file) => file.slice(0, -".json".length))
          .filter((userId) => SAFE_USER_ID.test(userId));
      } catch {
        // No member has a file yet.
      }
      return [
        { kind: "office" },
        ...users.map((userId) => ({ kind: "user" as const, userId })),
      ];
    },

    // `oauth` is the record the flow built (server/mcp-oauth.ts), never a
    // request body.
    create(
      scope: SecretScope,
      input: Record<string, unknown>,
      oauth?: StoredOAuth,
    ): McpServerChange {
      const nameError = checkMcpServerName(input.name);
      if (nameError) return { ok: false, kind: "invalid", error: nameError };
      const target = checkTarget(
        scope,
        input.url,
        input.secret ?? null,
        oauth !== undefined,
      );
      if (!target.ok) return target;
      const note = checkNote(input.note ?? null);
      if (!note.ok) return note;
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
        ...(note.note !== null ? { note: note.note } : {}),
        ...(oauth ? { oauth } : {}),
      };
      write(scope, [...servers, server]);
      return { ok: true, server: toWire(server) };
    },

    // `oauth`: the record the flow built for the new state; undefined keeps
    // the stored one, null removes it. `beforeWrite` runs once the change is
    // valid and before it is saved; if it throws, nothing is saved.
    update(
      scope: SecretScope,
      name: string,
      patch: Record<string, unknown>,
      oauth?: (
        current: StoredOAuth | undefined,
        url: string,
      ) => StoredOAuth | null,
      beforeWrite?: () => void,
    ): McpServerChange {
      const servers = read(scope);
      const server = servers.find((s) => s.name === name);
      if (!server) return { ok: false, kind: "not_found" };
      const nextUrl = patch.url !== undefined ? patch.url : server.url;
      const nextOAuth = oauth
        ? oauth(server.oauth, typeof nextUrl === "string" ? nextUrl : "")
        : (server.oauth ?? null);
      const target = checkTarget(
        scope,
        nextUrl,
        patch.secret !== undefined
          ? patch.secret
          : nextOAuth
            ? null
            : server.secret,
        nextOAuth !== null,
      );
      if (!target.ok) return target;
      const note = patch.note !== undefined ? checkNote(patch.note) : null;
      if (note && !note.ok) return note;
      server.url = target.url;
      server.secret = target.secret;
      if (nextOAuth) server.oauth = nextOAuth;
      else delete server.oauth;
      if (note?.note === null) delete server.note;
      else if (note) server.note = note.note;
      server.updatedAt = Date.now();
      beforeWrite?.();
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

    // The member left the office: their file goes, even one that does not
    // parse.
    removeMember(userId: string): void {
      rmSync(mcpServersPathFor(root, { kind: "user", userId }), {
        force: true,
      });
    },
  };
}

export type McpServerStore = ReturnType<typeof createMcpServerStore>;
