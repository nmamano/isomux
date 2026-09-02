import {
  closeSync,
  chmodSync,
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
import { parseDotenv } from "./persistence.ts";

const USER_ENV_DIR = join(STATE_ROOT, "user-env");
const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ManagedEnvValues = Record<string, string>;

export class ManagedEnvValidationError extends Error {}

export function managedUserEnvPath(userId: string): string {
  if (!SAFE_USER_ID.test(userId)) {
    throw new ManagedEnvValidationError("invalid user id");
  }
  return join(USER_ENV_DIR, `${userId}.env`);
}

export function managedUserEnvExists(userId: string): boolean {
  if (!SAFE_USER_ID.test(userId)) return false;
  return existsSync(managedUserEnvPath(userId));
}

export function removeManagedUserEnv(userId: string): void {
  rmSync(managedUserEnvPath(userId), { force: true });
}

export function readManagedUserEnv(userId: string): ManagedEnvValues | null {
  const path = managedUserEnvPath(userId);
  if (!existsSync(path)) return null;
  return parseDotenv(readFileSync(path, "utf8"));
}

function validate(values: ManagedEnvValues): void {
  for (const [key, value] of Object.entries(values)) {
    if (!SAFE_KEY.test(key)) {
      throw new ManagedEnvValidationError(`invalid environment key: ${key}`);
    }
    if (key === "__proto__") {
      throw new ManagedEnvValidationError(`invalid environment key: ${key}`);
    }
    if (typeof value !== "string") {
      throw new ManagedEnvValidationError(`value for ${key} must be a string`);
    }
    const unsupportedControl = [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 10 && code <= 31) || code === 127;
    });
    if (unsupportedControl) {
      throw new ManagedEnvValidationError(
        `value for ${key} contains an unsupported control character`,
      );
    }
  }
}

export function serializeManagedUserEnv(values: ManagedEnvValues): string {
  validate(values);
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n")
    .concat(Object.keys(values).length > 0 ? "\n" : "");
}

export function writeManagedUserEnv(
  userId: string,
  values: ManagedEnvValues,
): void {
  const path = managedUserEnvPath(userId);
  const content = serializeManagedUserEnv(values);
  mkdirSync(USER_ENV_DIR, { recursive: true, mode: 0o700 });
  chmodSync(USER_ENV_DIR, 0o700);
  const temp = join(
    USER_ENV_DIR,
    `.${userId}.${process.pid}.${crypto.randomUUID()}.tmp`,
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
