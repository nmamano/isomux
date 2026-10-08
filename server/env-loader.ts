// Shared env file resolver. Used by agent spawn/resume AND cronjob fire/
// resume to merge process.env with office and managed personal variables, so the same
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

import { getAgentHost } from "./agent-host.ts";
import {
  claudeFamilyModels,
  limitedClaudeFamilies,
} from "./backends/claude-install-check.ts";
import type { ClaudeFamilyModels } from "../shared/types.ts";
import { readEnvFile } from "./persistence.ts";
import { logicalAgentPath } from "./split/roots.ts";
import { getUserByName } from "./users.ts";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  isPersonalProviderActive,
  personalProviderHome,
} from "./provider-homes.ts";
import {
  managedOfficeEnvExists,
  managedOfficeEnvPath,
  managedUserEnvExists,
  managedUserEnvPath,
} from "./user-env.ts";

// Provider lookup for the current office env file path. agent-manager sets
// this once at module init from its `officeState.office.envFile` so we can
// resolve env without coupling this module to OfficeState directly. Until
// the provider is registered, `buildEnvFor` behaves as if no office env
// file is configured - which only matters during the brief window before
// agent-manager's module body has run, and no caller hits buildEnvFor that
// early in practice.
let getOfficeEnvFile: () => string | null = () => null;
let getPersonalProviderActive: typeof isPersonalProviderActive =
  isPersonalProviderActive;

export function setOfficeEnvFileProvider(fn: () => string | null): void {
  getOfficeEnvFile = fn;
}

// Returns the provider it replaced so a test can put back exactly what it
// found. Two suites once installed `() => false` here and never restored it,
// which disabled personal-provider resolution for every later file in the
// same process (53f6a397).
export function setPersonalProviderActiveProvider(
  fn: typeof isPersonalProviderActive,
): typeof isPersonalProviderActive {
  const previous = getPersonalProviderActive;
  getPersonalProviderActive = fn;
  return previous;
}

function resolveUserEnvSource(
  userId: string | null | undefined,
): string | null {
  if (!userId) return null;
  return managedUserEnvExists(userId) ? managedUserEnvPath(userId) : null;
}

function resolveOfficeEnvSource(): string | null {
  const pendingImport = getOfficeEnvFile();
  if (pendingImport) throw pendingImportError(pendingImport);
  return managedOfficeEnvExists() ? managedOfficeEnvPath() : null;
}

function pendingImportError(path: string): Error {
  return new Error(
    `The env file ${path} could not be imported into managed variables: fix it so it parses (one NAME=value per line) or delete it, then restart isomux.`,
  );
}

// Build the spawn-time env merge for a given user identity. `userId` is
// the stable user record id; pass null for an unowned context (agents
// with no spawning user, cronjobs not bound to a user). Returns
// `undefined` when no managed variables or personal provider are active - the
// SDK then inherits process.env as-is. `base` is the environment the merge
// starts from: the agent host's own (server/agent-host.ts). In split mode the
// result is never undefined, so no agent process inherits the server's
// process.env.
export function buildEnvForUserId(
  userId: string | null | undefined,
  base: { [key: string]: string | undefined } = getAgentHost().baseEnv(),
): { [key: string]: string | undefined } | undefined {
  const officeEnvFile = resolveOfficeEnvSource();
  const userEnvFile = resolveUserEnvSource(userId);
  const personalClaude = Boolean(
    userId && getPersonalProviderActive(userId, "claude"),
  );
  const personalCodex = Boolean(
    userId && getPersonalProviderActive(userId, "codex"),
  );
  if (!officeEnvFile && !userEnvFile && !personalClaude && !personalCodex)
    return getAgentHost().kind === "runner" ? { ...base } : undefined;

  const merged: { [key: string]: string | undefined } = { ...base };
  if (officeEnvFile) {
    const officeEnv = readEnvFile(officeEnvFile);
    Object.assign(merged, officeEnv);
  }
  const userEnv = userEnvFile ? readEnvFile(userEnvFile) : {};
  if (userEnvFile) {
    Object.assign(merged, userEnv);
  }
  if (userId && personalClaude && !userEnv.CLAUDE_CONFIG_DIR?.trim()) {
    merged.CLAUDE_CONFIG_DIR = personalProviderHome(userId, "claude");
  }
  if (userId && personalCodex && !userEnv.CODEX_HOME?.trim()) {
    merged.CODEX_HOME = personalProviderHome(userId, "codex");
  }
  return merged;
}

// A member's effective env (office plus personal variables) for the Claude
// model checks below. An env file that fails to parse leaves the host env; the
// launch reports that failure.
function claudeEnvForUserId(userId: string | null | undefined): {
  [key: string]: string | undefined;
} {
  try {
    return buildEnvForUserId(userId) ?? getAgentHost().baseEnv();
  } catch {
    return getAgentHost().baseEnv();
  }
}

// The Claude families limited in a member's effective env.
export function limitedClaudeFamiliesForUserId(
  userId: string | null | undefined,
): string[] {
  return limitedClaudeFamilies(claudeEnvForUserId(userId));
}

// The models Claude families run in a member's effective env, where they
// differ from FAMILY_TO_MODEL.
export function claudeFamilyModelsForUserId(
  userId: string | null | undefined,
): ClaudeFamilyModels {
  return claudeFamilyModels(claudeEnvForUserId(userId));
}

// Build the environment used by office-scoped provider operations. This is
// deliberately separate from buildEnvForUserId(): a user's override must not
// change the directory behind an "office" sign-in choice.
export function buildOfficeEnv(): {
  [key: string]: string | undefined;
} {
  const merged: { [key: string]: string | undefined } = {
    ...getAgentHost().baseEnv(),
  };
  const officeEnvFile = resolveOfficeEnvSource();
  if (officeEnvFile) Object.assign(merged, readEnvFile(officeEnvFile));
  return merged;
}

export function readOfficeEnvFile(): Record<string, string> {
  const officeEnvFile = resolveOfficeEnvSource();
  return officeEnvFile ? readEnvFile(officeEnvFile) : {};
}

// Stable identity for the intentional environment sources. Contents are not
// identity: rotating a credential must replace the server without stranding
// durable sessions in a new profile. Do not derive this from the merged
// process environment; systemd values change on every isomux restart.
export function environmentSourceKeyForUserId(
  userId: string | null | undefined,
): string {
  const userEnvFile = resolveUserEnvSource(userId);
  const sources = [resolveOfficeEnvSource(), userEnvFile].filter(
    (path): path is string => Boolean(path),
  );
  if (sources.length === 0) return "default";
  // In split mode the files moved with the server state; the key hashes the
  // paths they had before (design section 3.1.2), so it does not change.
  const identity = sources.map((path) => logicalAgentPath(resolve(path)));
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
  const officeEnvFile = resolveOfficeEnvSource();
  const userEnvFile = resolveUserEnvSource(userId);
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
