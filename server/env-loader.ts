// Shared env file resolver. Used by agent spawn/resume AND cronjob fire/
// resume to merge process.env with office and user env files, so the same
// env reaches the model picker (`backends.listModels`), the actual session
// (`createSession`), and any session-file prechecks (Codex `CODEX_HOME`).
//
// Lives in its own module to avoid a `cronjob-manager → agent-manager →
// command-handlers → cronjob-manager` import cycle. agent-manager owns the
// in-memory `officeState` singleton and registers an env-file provider at
// module init via setOfficeEnvFileProvider; callers (agent-manager,
// cronjob-manager, server/index) all import `buildEnvFor` from here.
//
// User overrides office; office overrides process.env. Spawn-time failure
// mode: if a configured env file is missing or fails to parse, throw - the
// caller is responsible for surfacing the error to the agent/run log.

import { readEnvFile } from "./persistence.ts";
import { getUserByName, getUserEnvFileById } from "./users.ts";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Provider lookup for the current office env file path. agent-manager sets
// this once at module init from its `officeState.office.envFile` so we can
// resolve env without coupling this module to OfficeState directly. Until
// the provider is registered, `buildEnvFor` behaves as if no office env
// file is configured - which only matters during the brief window before
// agent-manager's module body has run, and no caller hits buildEnvFor that
// early in practice.
let getOfficeEnvFile: () => string | null = () => null;

export function setOfficeEnvFileProvider(fn: () => string | null): void {
  getOfficeEnvFile = fn;
}

// Build the spawn-time env merge for a given user identity. `userId` is
// the stable user record id; pass null for an unowned context (agents
// with no spawning user, cronjobs not bound to a user). Returns
// `undefined` when no office and no user env file are configured - the
// SDK then inherits process.env as-is.
export function buildEnvForUserId(
  userId: string | null | undefined,
): { [key: string]: string | undefined } | undefined {
  const officeEnvFile = getOfficeEnvFile();
  const userEnvFile = userId ? getUserEnvFileById(userId) : null;
  if (!officeEnvFile && !userEnvFile) return undefined;

  const merged: { [key: string]: string | undefined } = { ...process.env };
  if (officeEnvFile) {
    const officeEnv = readEnvFile(officeEnvFile);
    Object.assign(merged, officeEnv);
  }
  if (userEnvFile) {
    const userEnv = readEnvFile(userEnvFile);
    Object.assign(merged, userEnv);
  }
  return merged;
}

// Build the environment used by office-scoped provider operations. This is
// deliberately separate from buildEnvForUserId(): a user's override must not
// change the directory behind an "office" sign-in choice.
export function buildOfficeEnv(): {
  [key: string]: string | undefined;
} {
  const merged: { [key: string]: string | undefined } = { ...process.env };
  const officeEnvFile = getOfficeEnvFile();
  if (officeEnvFile) Object.assign(merged, readEnvFile(officeEnvFile));
  return merged;
}

export function readOfficeEnvFile(): Record<string, string> {
  const officeEnvFile = getOfficeEnvFile();
  return officeEnvFile ? readEnvFile(officeEnvFile) : {};
}

// Stable identity for the intentional environment sources. Contents are not
// identity: rotating a credential must replace the server without stranding
// durable sessions in a new profile. Do not derive this from the merged
// process environment; systemd values change on every isomux restart.
export function environmentSourceKeyForUserId(
  userId: string | null | undefined,
): string {
  const sources = [
    getOfficeEnvFile(),
    userId ? getUserEnvFileById(userId) : null,
  ].filter((path): path is string => Boolean(path));
  if (sources.length === 0) return "default";
  const identity = sources.map((path) => resolve(path));
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16);
}

// Revision of configured environment-file contents. This is replacement
// state, not profile identity: a value change keeps the same profile and
// durable sessions but prevents adoption of a server with the old env.
// Process values are excluded so an Isomux restart can adopt the same server.
export function environmentSourceRevisionForUserId(
  userId: string | null | undefined,
): string {
  const officeEnvFile = getOfficeEnvFile();
  const userEnvFile = userId ? getUserEnvFileById(userId) : null;
  const configured: Record<string, string> = {};
  if (officeEnvFile) Object.assign(configured, readEnvFile(officeEnvFile));
  if (userEnvFile) Object.assign(configured, readEnvFile(userEnvFile));
  const entries = Object.entries(configured).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

// Compatibility wrapper. New code should use `buildEnvForUserId(userId)`
// directly. This resolves a username string (display name) to a userId
// via case-insensitive lookup so legacy call sites that only carry a
// username snapshot keep working. After a rename, the snapshot may no
// longer match - those call sites should be migrated to carry userId.
export function buildEnvFor(
  username?: string,
): { [key: string]: string | undefined } | undefined {
  const userId = username ? (getUserByName(username)?.id ?? null) : null;
  return buildEnvForUserId(userId);
}
