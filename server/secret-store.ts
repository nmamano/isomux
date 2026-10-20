// The secret store (internal-docs/secrets-design.md, section 1). Nothing in
// this module returns a value except readSecretValues and readForProxy.
// Their callers: the MCP server headers (server/mcp-servers.ts, integrations
// A2), the secret proxy (B2), and Show (routes/handlers/secrets.ts), the one
// route that sends a value to a client: to the secret's own member, or to an
// owner for an office secret.
//
// STATE_ROOT/secrets/office.json and STATE_ROOT/secrets/users/<userId>.json,
// 0600 files in 0700 directories, written like the env files. Every change is
// a synchronous read-modify-write, so two requests in one scope cannot lose
// each other's change. A file that does not parse is never rewritten.

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
  SECRET_MAX_APPS,
  isAppReservedSecretName,
  checkSecretForm,
  checkSecretHosts,
  checkSecretName,
  checkSecretValue,
  type SecretFieldError,
  type SecretForm,
} from "../shared/secret-hosts.ts";
import type { SecretWire } from "../shared/contract-shapes.ts";
import { checkConnectionNote } from "../shared/connection-notes.ts";

export type SecretScope = { kind: "office" } | { kind: "user"; userId: string };

// An app that may read a secret's value (task c7007f8b). The creation time
// binds the grant to one registration: a later app with the same name gets
// nothing.
export interface AppGrant {
  name: string;
  createdAt: number;
}

export interface StoredSecret {
  name: string;
  value: string;
  hosts: string[];
  form: SecretForm;
  generation: number;
  createdAt: number;
  valueSetAt: number;
  updatedAt: number;
  // The usage note for agents (integrations A4); absent when there is none.
  note?: string;
  // The apps that read the value from their environment; absent when none.
  apps?: AppGrant[];
}

interface SecretsFile {
  version: 1;
  secrets: StoredSecret[];
}

// The file exists but is not a store this version reads. Its message is fixed
// text and never carries file content.
export class SecretStoreUnreadableError extends Error {
  constructor() {
    super("the secrets file could not be read");
  }
}

export type SecretChange =
  | { ok: true; secret: SecretWire }
  | { ok: false; kind: "invalid"; error: SecretFieldError }
  | { ok: false; kind: "exists" }
  | { ok: false; kind: "not_found" };
// An update that would add a host or an app the caller may not add.
export type SecretUpdateChange =
  | SecretChange
  | { ok: false; kind: "host_added" }
  | { ok: false; kind: "app_added" };

export interface SecretStoreOptions {
  // Whether a grant names a live app (same name and creation time). The wire
  // lists only those. Without it, every grant counts as live.
  isLiveApp?: (grant: AppGrant) => boolean;
}

const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;

function toWire(
  secret: StoredSecret,
  isLiveApp: (grant: AppGrant) => boolean,
): SecretWire {
  return {
    name: secret.name,
    hosts: [...secret.hosts],
    form: { ...secret.form },
    createdAt: secret.createdAt,
    valueSetAt: secret.valueSetAt,
    updatedAt: secret.updatedAt,
    note: secret.note ?? null,
    apps: (secret.apps ?? []).filter(isLiveApp).map((grant) => grant.name),
  };
}

const sameGrant = (a: AppGrant, b: AppGrant): boolean =>
  a.name === b.name && a.createdAt === b.createdAt;

function isAppGrant(entry: unknown): entry is AppGrant {
  if (!entry || typeof entry !== "object") return false;
  const g = entry as Record<string, unknown>;
  return (
    typeof g.name === "string" &&
    g.name.length > 0 &&
    typeof g.createdAt === "number" &&
    Number.isFinite(g.createdAt)
  );
}

// The grants a caller sent, deduplicated and sorted by name, then time.
function checkAppGrants(
  apps: unknown,
): { ok: true; apps: AppGrant[] } | { ok: false; error: SecretFieldError } {
  if (apps === undefined) return { ok: true, apps: [] };
  if (!Array.isArray(apps) || !apps.every(isAppGrant))
    return { ok: false, error: { field: "apps", reason: "invalid" } };
  const unique: AppGrant[] = [];
  for (const grant of apps)
    if (!unique.some((g) => sameGrant(g, grant)))
      unique.push({ name: grant.name, createdAt: grant.createdAt });
  if (unique.length > SECRET_MAX_APPS)
    return { ok: false, error: { field: "apps", reason: "too_long" } };
  unique.sort((a, b) =>
    a.name === b.name
      ? a.createdAt - b.createdAt
      : a.name.localeCompare(b.name),
  );
  return { ok: true, apps: unique };
}

function isStoredSecret(entry: unknown): entry is StoredSecret {
  if (!entry || typeof entry !== "object") return false;
  const s = entry as Record<string, unknown>;
  return (
    checkSecretName(s.name) === null &&
    typeof s.value === "string" &&
    Array.isArray(s.hosts) &&
    s.hosts.every((host) => typeof host === "string") &&
    checkSecretForm(s.form).ok &&
    Number.isSafeInteger(s.generation) &&
    (s.generation as number) >= 1 &&
    typeof s.createdAt === "number" &&
    typeof s.valueSetAt === "number" &&
    typeof s.updatedAt === "number" &&
    // Any string: the note rule is checked at write only.
    (s.note === undefined || typeof s.note === "string") &&
    (s.apps === undefined ||
      (Array.isArray(s.apps) && s.apps.every(isAppGrant)))
  );
}

export function createSecretStore(
  root: string = STATE_ROOT,
  options: SecretStoreOptions = {},
) {
  const dir = join(root, "secrets");
  const usersDir = join(dir, "users");
  const isLiveApp = options.isLiveApp ?? (() => true);
  const wire = (secret: StoredSecret) => toWire(secret, isLiveApp);

  function pathFor(scope: SecretScope): string {
    if (scope.kind === "office") return join(dir, "office.json");
    if (!SAFE_USER_ID.test(scope.userId)) throw new Error("invalid user id");
    return join(usersDir, `${scope.userId}.json`);
  }

  function read(scope: SecretScope): StoredSecret[] {
    const path = pathFor(scope);
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new SecretStoreUnreadableError();
    }
    const file = parsed as Partial<SecretsFile> | null;
    if (
      !file ||
      typeof file !== "object" ||
      file.version !== 1 ||
      !Array.isArray(file.secrets) ||
      !file.secrets.every(isStoredSecret)
    )
      throw new SecretStoreUnreadableError();
    return file.secrets;
  }

  function write(scope: SecretScope, secrets: StoredSecret[]): void {
    const path = pathFor(scope);
    const directory = scope.kind === "office" ? dir : usersDir;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chmodSync(directory, 0o700);
    const sorted = [...secrets].sort((a, b) => a.name.localeCompare(b.name));
    const content = `${JSON.stringify({ version: 1, secrets: sorted } satisfies SecretsFile, null, 2)}\n`;
    const temp = join(
      directory,
      `.secrets.${process.pid}.${crypto.randomUUID()}.tmp`,
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

  // The only way a value leaves this module: a copy of a stored secret's
  // value, hosts and form. Never for a log line; the one response is Show
  // (secrets.reveal and officeSecrets.reveal), for the secret's own member or
  // an owner on an office secret.
  function valuesOf(secret: StoredSecret): {
    value: string;
    hosts: string[];
    form: SecretForm;
  } {
    return {
      value: secret.value,
      hosts: [...secret.hosts],
      form: { ...secret.form },
    };
  }

  // A secret's value, hosts and form, or null when it does not exist.
  function readSecretValues(
    scope: SecretScope,
    name: string,
  ): { value: string; hosts: string[]; form: SecretForm } | null {
    const secret = read(scope).find((s) => s.name === name);
    return secret ? valuesOf(secret) : null;
  }

  // Every scope that has a file, and the user ids that have one. A file name
  // that is not a safe user id is skipped, as pathFor would refuse it.
  function scopes(): SecretScope[] {
    const found: SecretScope[] = [];
    if (existsSync(pathFor({ kind: "office" }))) found.push({ kind: "office" });
    if (!existsSync(usersDir)) return found;
    for (const entry of readdirSync(usersDir).sort()) {
      if (!entry.endsWith(".json")) continue;
      const userId = entry.slice(0, -".json".length);
      if (SAFE_USER_ID.test(userId)) found.push({ kind: "user", userId });
    }
    return found;
  }

  // Would `apps` let one app read this secret and another scope's secret
  // of the same name? Checked in the write path of the change. An
  // unreadable file holds no grant that this check can see; the render
  // drops a clash that slips through.
  function clashes(scope: SecretScope, name: string, apps: AppGrant[]) {
    if (apps.length === 0) return false;
    const self = pathFor(scope);
    return scopes().some((other) => {
      if (pathFor(other) === self) return false;
      let secrets: StoredSecret[];
      try {
        secrets = read(other);
      } catch (error) {
        if (error instanceof SecretStoreUnreadableError) return false;
        throw error;
      }
      return secrets.some(
        (s) =>
          s.name === name &&
          (s.apps ?? []).some((g) => apps.some((grant) => sameGrant(g, grant))),
      );
    });
  }

  // Keeps the grants that `keep` accepts, in every readable scope, and
  // writes only a scope that changed. A secret keeps its place when its last
  // grant goes: it reaches nothing until a member gives it an app or a host.
  function keepGrants(keep: (grant: AppGrant) => boolean): void {
    for (const scope of scopes()) {
      let secrets: StoredSecret[];
      try {
        secrets = read(scope);
      } catch (error) {
        if (error instanceof SecretStoreUnreadableError) continue;
        throw error;
      }
      let changed = false;
      for (const secret of secrets) {
        if (!secret.apps) continue;
        const kept = secret.apps.filter(keep);
        if (kept.length === secret.apps.length) continue;
        changed = true;
        if (kept.length > 0) secret.apps = kept;
        else delete secret.apps;
      }
      if (changed) write(scope, secrets);
    }
  }

  return {
    list(scope: SecretScope): SecretWire[] {
      return read(scope).map(wire);
    },

    // One scope's secrets with their values, for the snapshot that the
    // server sends to the secret proxy and for placeholders. One file read.
    readForProxy(scope: SecretScope): StoredSecret[] {
      return read(scope).map((s) => ({
        ...s,
        ...valuesOf(s),
        ...(s.apps ? { apps: s.apps.map((grant) => ({ ...grant })) } : {}),
      }));
    },

    readSecretValues,

    // The scopes that have a secrets file. A file with no secrets counts.
    scopes,

    // True when any scope holds at least one secret. An unreadable file
    // counts as holding one: the proxy starts (it reads that scope as empty,
    // so it only tunnels for it), and once the file is fixed the next agent
    // start finds a proxy to point at.
    hasAny(): boolean {
      return scopes().some((scope) => {
        try {
          return read(scope).length > 0;
        } catch (error) {
          if (error instanceof SecretStoreUnreadableError) return true;
          throw error;
        }
      });
    },

    // `input.apps`, when present, holds AppGrant pairs that the caller
    // resolved against the live app records.
    create(scope: SecretScope, input: Record<string, unknown>): SecretChange {
      const nameError = checkSecretName(input.name);
      if (nameError) return { ok: false, kind: "invalid", error: nameError };
      const valueError = checkSecretValue(input.value);
      if (valueError) return { ok: false, kind: "invalid", error: valueError };
      const apps = checkAppGrants(input.apps);
      if (!apps.ok) return { ok: false, kind: "invalid", error: apps.error };
      // A secret needs a host or an app.
      const hosts = checkSecretHosts(input.hosts, {
        allowEmpty: apps.apps.length > 0,
      });
      if (!hosts.ok) return { ok: false, kind: "invalid", error: hosts.error };
      const form = checkSecretForm(input.form);
      if (!form.ok) return { ok: false, kind: "invalid", error: form.error };
      const note = checkConnectionNote(input.note ?? null);
      if (!note.ok)
        return {
          ok: false,
          kind: "invalid",
          error: { field: "note", reason: note.reason },
        };
      const name = input.name as string;
      if (apps.apps.length > 0 && isAppReservedSecretName(name))
        return {
          ok: false,
          kind: "invalid",
          error: { field: "name", reason: "reserved" },
        };
      const secrets = read(scope);
      if (secrets.some((s) => s.name === name))
        return { ok: false, kind: "exists" };
      if (clashes(scope, name, apps.apps))
        return {
          ok: false,
          kind: "invalid",
          error: { field: "apps", reason: "clash" },
        };
      const now = Date.now();
      const secret: StoredSecret = {
        name,
        value: input.value as string,
        hosts: hosts.hosts,
        form: form.form,
        generation: 1,
        createdAt: now,
        valueSetAt: now,
        updatedAt: now,
        ...(note.note !== null ? { note: note.note } : {}),
        ...(apps.apps.length > 0 ? { apps: apps.apps } : {}),
      };
      write(scope, [...secrets, secret]);
      return { ok: true, secret: wire(secret) };
    },

    rotate(scope: SecretScope, name: string, value: unknown): SecretChange {
      const valueError = checkSecretValue(value);
      if (valueError) return { ok: false, kind: "invalid", error: valueError };
      const secrets = read(scope);
      const secret = secrets.find((s) => s.name === name);
      if (!secret) return { ok: false, kind: "not_found" };
      const now = Date.now();
      secret.value = value as string;
      secret.valueSetAt = now;
      secret.updatedAt = now;
      write(scope, secrets);
      return { ok: true, secret: wire(secret) };
    },

    // A new placeholder: the generation goes up and the value stays. The
    // agents in scope get the new placeholder at their next start.
    reissue(scope: SecretScope, name: string): SecretChange {
      const secrets = read(scope);
      const secret = secrets.find((s) => s.name === name);
      if (!secret) return { ok: false, kind: "not_found" };
      secret.generation += 1;
      secret.updatedAt = Date.now();
      write(scope, secrets);
      return { ok: true, secret: wire(secret) };
    },

    // `addHosts: false` (an agent caller, Lead 2026-10-14): the new hosts must
    // be stored hosts already. Otherwise the agent could send the stand-in it
    // holds to a host it controls and read the value back. Checked against
    // the stored list in the same read as the write. `addApps: false` is the
    // same rule for apps (task c7007f8b): an agent can read the environment
    // of any app, so only a human gives a secret to one.
    update(
      scope: SecretScope,
      name: string,
      patch: Record<string, unknown>,
      options: { addHosts: boolean; addApps: boolean } = {
        addHosts: true,
        addApps: true,
      },
    ): SecretUpdateChange {
      let hosts: string[] | undefined;
      let form: SecretForm | undefined;
      let apps: AppGrant[] | undefined;
      if (patch.apps !== undefined) {
        const checked = checkAppGrants(patch.apps);
        if (!checked.ok)
          return { ok: false, kind: "invalid", error: checked.error };
        apps = checked.apps;
      }
      if (patch.hosts !== undefined) {
        // An empty list is judged below, against the apps the secret keeps.
        const checked = checkSecretHosts(patch.hosts, { allowEmpty: true });
        if (!checked.ok)
          return { ok: false, kind: "invalid", error: checked.error };
        hosts = checked.hosts;
      }
      if (patch.form !== undefined) {
        const checked = checkSecretForm(patch.form);
        if (!checked.ok)
          return { ok: false, kind: "invalid", error: checked.error };
        form = checked.form;
      }
      let note: string | null | undefined;
      if (patch.note !== undefined) {
        const checked = checkConnectionNote(patch.note);
        if (!checked.ok)
          return {
            ok: false,
            kind: "invalid",
            error: { field: "note", reason: checked.reason },
          };
        note = checked.note;
      }
      const secrets = read(scope);
      const secret = secrets.find((s) => s.name === name);
      if (!secret) return { ok: false, kind: "not_found" };
      if (
        hosts &&
        !options.addHosts &&
        !hosts.every((host) => secret.hosts.includes(host))
      )
        return { ok: false, kind: "host_added" };
      // Judged on (name, createdAt) pairs: the same name for another
      // registration is an add.
      const stored = secret.apps ?? [];
      if (
        apps &&
        !options.addApps &&
        !apps.every((grant) => stored.some((g) => sameGrant(g, grant)))
      )
        return { ok: false, kind: "app_added" };
      if (hosts || apps) {
        const nextHosts = hosts ?? secret.hosts;
        const nextApps = apps ?? stored;
        if (nextHosts.length === 0 && nextApps.length === 0)
          return {
            ok: false,
            kind: "invalid",
            error: { field: "hosts", reason: "invalid" },
          };
        if (nextApps.length > 0 && isAppReservedSecretName(name))
          return {
            ok: false,
            kind: "invalid",
            error: { field: "name", reason: "reserved" },
          };
      }
      if (apps && clashes(scope, name, apps))
        return {
          ok: false,
          kind: "invalid",
          error: { field: "apps", reason: "clash" },
        };
      if (hosts) secret.hosts = hosts;
      if (apps) {
        if (apps.length > 0) secret.apps = apps;
        else delete secret.apps;
      }
      if (form) secret.form = form;
      if (note === null) delete secret.note;
      else if (note !== undefined) secret.note = note;
      secret.updatedAt = Date.now();
      write(scope, secrets);
      return { ok: true, secret: wire(secret) };
    },

    // Keeps the file when the list becomes empty: its path is part of the
    // member's OpenCode profile key (env-loader.ts), which must not move back.
    remove(scope: SecretScope, name: string): boolean {
      const secrets = read(scope);
      const next = secrets.filter((s) => s.name !== name);
      if (next.length === secrets.length) return false;
      write(scope, next);
      return true;
    },

    // An app was deleted: its grant leaves every scope.
    dropApp(grant: AppGrant): void {
      keepGrants((g) => !sameGrant(g, grant));
    },

    // Removes every grant whose app is not live, in every scope.
    pruneApps(isLive: (grant: AppGrant) => boolean): void {
      keepGrants(isLive);
    },

    // The member left the office: their file goes, even one that does not
    // parse.
    removeMember(userId: string): void {
      rmSync(pathFor({ kind: "user", userId }), { force: true });
    },
  };
}

export type SecretStore = ReturnType<typeof createSecretStore>;
