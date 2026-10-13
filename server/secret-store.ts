// The secret store (internal-docs/secrets-design.md, section 1). Values are
// write-only: nothing in this module returns one except readSecretValues,
// which is for the proxy (B2) and has no caller in B1.
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
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { STATE_ROOT } from "./config.ts";
import {
  checkSecretForm,
  checkSecretHosts,
  checkSecretName,
  checkSecretValue,
  type SecretFieldError,
  type SecretForm,
} from "../shared/secret-hosts.ts";
import type { SecretWire } from "../shared/contract-shapes.ts";

export type SecretScope = { kind: "office" } | { kind: "user"; userId: string };

interface StoredSecret {
  name: string;
  value: string;
  hosts: string[];
  form: SecretForm;
  generation: number;
  createdAt: number;
  valueSetAt: number;
  updatedAt: number;
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

const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;

function toWire(secret: StoredSecret): SecretWire {
  return {
    name: secret.name,
    hosts: [...secret.hosts],
    form: { ...secret.form },
    createdAt: secret.createdAt,
    valueSetAt: secret.valueSetAt,
    updatedAt: secret.updatedAt,
  };
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
    typeof s.updatedAt === "number"
  );
}

export function createSecretStore(root: string = STATE_ROOT) {
  const dir = join(root, "secrets");
  const usersDir = join(dir, "users");

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

  return {
    list(scope: SecretScope): SecretWire[] {
      return read(scope).map(toWire);
    },

    create(scope: SecretScope, input: Record<string, unknown>): SecretChange {
      const nameError = checkSecretName(input.name);
      if (nameError) return { ok: false, kind: "invalid", error: nameError };
      const valueError = checkSecretValue(input.value);
      if (valueError) return { ok: false, kind: "invalid", error: valueError };
      const hosts = checkSecretHosts(input.hosts);
      if (!hosts.ok) return { ok: false, kind: "invalid", error: hosts.error };
      const form = checkSecretForm(input.form);
      if (!form.ok) return { ok: false, kind: "invalid", error: form.error };
      const secrets = read(scope);
      const name = input.name as string;
      if (secrets.some((s) => s.name === name))
        return { ok: false, kind: "exists" };
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
      };
      write(scope, [...secrets, secret]);
      return { ok: true, secret: toWire(secret) };
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
      return { ok: true, secret: toWire(secret) };
    },

    update(
      scope: SecretScope,
      name: string,
      patch: Record<string, unknown>,
    ): SecretChange {
      let hosts: string[] | undefined;
      let form: SecretForm | undefined;
      if (patch.hosts !== undefined) {
        const checked = checkSecretHosts(patch.hosts);
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
      const secrets = read(scope);
      const secret = secrets.find((s) => s.name === name);
      if (!secret) return { ok: false, kind: "not_found" };
      if (hosts) secret.hosts = hosts;
      if (form) secret.form = form;
      secret.updatedAt = Date.now();
      write(scope, secrets);
      return { ok: true, secret: toWire(secret) };
    },

    remove(scope: SecretScope, name: string): boolean {
      const secrets = read(scope);
      const next = secrets.filter((s) => s.name !== name);
      if (next.length === secrets.length) return false;
      write(scope, next);
      return true;
    },
  };
}

export type SecretStore = ReturnType<typeof createSecretStore>;
