// Shared env file resolver. Used by agent spawn/resume AND cronjob fire/
// resume to merge process.env with office and managed personal variables, so the same
// env reaches the model picker (`backends.listModels`), the actual session
// (`createSession`), and any session-file prechecks (Codex `CODEX_HOME`).
//
// Lives in its own module to avoid a `cronjob-manager → agent-manager →
// command-handlers → cronjob-manager` import cycle. agent-manager owns the
// in-memory `officeState` and registers an env-file provider at boot via
// setOfficeEnvFileProvider; callers (agent-manager,
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
import type { ClaudeFamilyModels, EnvVariableSource } from "../shared/types.ts";
import { readEnvFile } from "./persistence.ts";
import { logicalAgentPath } from "./split/roots.ts";
import { getUserByName } from "./users.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { STATE_ROOT } from "./config.ts";
import { MCP_SERVERS_DIR } from "./mcp-server-store.ts";
import type { SecretEnvironment } from "./secret-proxy/runtime.ts";
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

// Provider lookup for the current office env file path.
// createProductionAgentManager sets it at boot from its
// `officeState.office.envFile` so we can resolve env without coupling this
// module to OfficeState directly, and stopServer clears it. While no provider
// is registered, `buildEnvFor` behaves as if no office env file is
// configured.
let getOfficeEnvFile: () => string | null = () => null;
let getPersonalProviderActive: typeof isPersonalProviderActive =
  isPersonalProviderActive;

export function setOfficeEnvFileProvider(fn: () => string | null): void {
  getOfficeEnvFile = fn;
}

// The secrets runtime (server/secret-proxy/runtime.ts) registers this at
// boot. Until then, and in an office without a secret in scope, it answers
// null and nothing below changes (ruling 8). Returns the provider it
// replaced, so a test can put it back.
let getSecretEnvironment: (
  userId: string | null | undefined,
) => SecretEnvironment | null = () => null;

export function setSecretEnvironmentProvider(
  fn: typeof getSecretEnvironment,
): typeof getSecretEnvironment {
  const previous = getSecretEnvironment;
  getSecretEnvironment = fn;
  return previous;
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

const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;

// The member's secrets and MCP servers files that exist, for the profile key.
function memberStoreFiles(userId: string | null | undefined): string[] {
  if (!userId || !SAFE_USER_ID.test(userId)) return [];
  return [
    join(STATE_ROOT, "secrets", "users", `${userId}.json`),
    join(STATE_ROOT, MCP_SERVERS_DIR, "users", `${userId}.json`),
  ].filter((path) => existsSync(path));
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
  const merge = mergeEnvForUserId(userId, base);
  if (merge) return merge.env;
  return getAgentHost().kind === "runner" ? { ...base } : undefined;
}

// Where the env of `userId`'s agents gets `name` from, by the merge order of
// buildEnvForUserId. Null when the merged value is unset or empty.
export function envSourceForUserId(
  userId: string | null | undefined,
  name: string,
): EnvVariableSource | null {
  const base = getAgentHost().baseEnv();
  const merge = mergeEnvForUserId(userId, base);
  const value = merge ? merge.env[name] : base[name];
  if (!value) return null;
  return merge?.sources.get(name) ?? "server";
}

// The one merge behind buildEnvForUserId and envSourceForUserId, with the
// layer each name came from. Null when nothing is in scope.
function mergeEnvForUserId(
  userId: string | null | undefined,
  base: { [key: string]: string | undefined },
): {
  env: { [key: string]: string | undefined };
  sources: Map<string, EnvVariableSource>;
} | null {
  const officeEnvFile = resolveOfficeEnvSource();
  const userEnvFile = resolveUserEnvSource(userId);
  const personalClaude = Boolean(
    userId && getPersonalProviderActive(userId, "claude"),
  );
  const personalCodex = Boolean(
    userId && getPersonalProviderActive(userId, "codex"),
  );
  const secrets = getSecretEnvironment(userId);
  if (
    !officeEnvFile &&
    !userEnvFile &&
    !personalClaude &&
    !personalCodex &&
    !secrets
  )
    return null;

  const env: { [key: string]: string | undefined } = { ...base };
  const sources = new Map<string, EnvVariableSource>();
  const layer = (
    source: EnvVariableSource,
    vars: { [key: string]: string | undefined },
  ) => {
    for (const [name, value] of Object.entries(vars)) {
      env[name] = value;
      sources.set(name, source);
    }
  };
  // Order (secrets design 2.1): office variable, office secret, member
  // variable, member secret; then the proxy and trust variables over all.
  if (officeEnvFile) layer("office_variable", readEnvFile(officeEnvFile));
  if (secrets) layer("office_secret", secrets.office);
  const userEnv = userEnvFile ? readEnvFile(userEnvFile) : {};
  if (userEnvFile) layer("member_variable", userEnv);
  if (secrets) layer("member_secret", secrets.member);
  // The server sets the rest.
  if (userId && personalClaude && !userEnv.CLAUDE_CONFIG_DIR?.trim()) {
    layer("server", {
      CLAUDE_CONFIG_DIR: personalProviderHome(userId, "claude"),
    });
  }
  if (userId && personalCodex && !userEnv.CODEX_HOME?.trim()) {
    layer("server", { CODEX_HOME: personalProviderHome(userId, "codex") });
  }
  if (secrets) {
    layer("server", secrets.fixed);
    layer("server", gitCredentialHelpers(env, secrets.gitCredentials));
  }
  return { env, sources };
}

// The office git credential helper (secrets design 2.4): for each listed
// host, git asks it and gets the placeholder as the Basic password, which the
// proxy swaps. The entries go after any GIT_CONFIG_* already set. An empty
// helper first resets the host's helper list: else the system and global
// helpers answer first (with the member's own token), and git's store and
// erase calls would reach them with the placeholder.
function gitCredentialHelpers(
  env: { [key: string]: string | undefined },
  hosts: { host: string; placeholder: string }[],
): Record<string, string> {
  if (hosts.length === 0) return {};
  const added: Record<string, string> = {};
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  let next = Number.isSafeInteger(count) && count > 0 ? count : 0;
  for (const { host, placeholder } of hosts) {
    added[`GIT_CONFIG_KEY_${next}`] = `credential.https://${host}.helper`;
    added[`GIT_CONFIG_VALUE_${next}`] = "";
    next++;
    added[`GIT_CONFIG_KEY_${next}`] = `credential.https://${host}.helper`;
    // A placeholder is base62 after a known prefix: no quote can occur.
    added[`GIT_CONFIG_VALUE_${next}`] =
      `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' '${placeholder}'; }; f`;
    next++;
  }
  added.GIT_CONFIG_COUNT = String(next);
  return added;
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
//
// The member's other Isomux-held source files join it when they exist: their
// secrets and their MCP servers (integrations A2; Lead ruling, 2026-10-13).
// Without them, two members with no env file would share one OpenCode server,
// and one member's MCP servers would reach the other's agents. The stores
// delete these files only when the member leaves the office, so the key never
// moves back while they are a member. Office files do not join:
// an office change revises the server's config, not its profile.
export function environmentSourceKeyForUserId(
  userId: string | null | undefined,
): string {
  const userEnvFile = resolveUserEnvSource(userId);
  const sources = [
    resolveOfficeEnvSource(),
    userEnvFile,
    ...memberStoreFiles(userId),
  ].filter((path): path is string => Boolean(path));
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
  const hash = createHash("sha256").update(JSON.stringify(entries));
  // The non-value secret state, the proxy port and the git helper hosts: an
  // add, a delete, a new placeholder, a new port, or a hosts or form edit
  // that changes the git helpers replaces the server; a value rotation does
  // not. No secret in scope: the hash is as before.
  const secrets = getSecretEnvironment(userId);
  if (secrets) hash.update(`\0secrets\0${secrets.revision}`);
  return hash.digest("hex");
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
