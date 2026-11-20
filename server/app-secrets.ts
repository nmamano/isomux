// Vault secrets that an app reads as raw values (task c7007f8b, design in
// internal-docs/secrets-design.md, section 9). A secret lists the apps that
// may read it; each app gets a file of those values, which its unit reads as
// an EnvironmentFile (the container supervisor reads the same file). Agents
// never get these values: a secret with no hosts gives them no placeholder.
//
// Each file also holds the app's proxy secret (app-proxy-secret.ts), so
// every live app has one.
//
// This module is the one writer of STATE_ROOT/secrets/apps/. Each sync
// writes the file of every live app and removes every other file there, so
// a sync that races an app delete leaves no value behind. The file is a copy: the store is the truth, and each change and
// each boot writes it again.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";

import { OAUTH_SECRET_NAME } from "../shared/mcp-servers.ts";
import type { AppRecord } from "../shared/types.ts";
import { APP_PROXY_SECRET_ENV } from "./app-proxy-secret.ts";
import type { AppSupervisor } from "./app-supervisor.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import {
  SecretStoreUnreadableError,
  type SecretScope,
  type SecretStore,
  type ValuedSecret,
} from "./secret-store.ts";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const appSecretsDir = (stateRoot: string): string =>
  join(stateRoot, "secrets", "apps");

export const appSecretsPath = (dir: string, appName: string): string =>
  join(dir, `${appName}.env`);

// The file text: one NAME="value" line per secret, sorted by name, in the
// double-quoted form of systemd's EnvironmentFile, with a backslash before
// each of " \ ` $. deploy/container/supervisor.py parses it back
// (parse_secrets_env), the exact inverse. A vault value has no line break
// (checkSecretValue), and systemd does not expand % or $ in this file.
export function renderSecretsEnv(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((name) => `${name}="${env[name].replace(/["\\`$]/g, "\\$&")}"\n`)
    .join("");
}

export interface AppSecretsDeps {
  store: Pick<SecretStore, "scopes" | "readForProxy" | "pruneApps">;
  // The live app records.
  apps: () => AppRecord[];
  supervisor: Pick<
    AppSupervisor,
    | "unitInjectsSecrets"
    | "unitPathHasRuntime"
    | "regenerate"
    | "states"
    | "restart"
  >;
  // STATE_ROOT/secrets/apps in production.
  dir: string;
  // The secrets that OAuth MCP registrations own in a scope, or null when
  // the registrations cannot be read. An app never gets them.
  oauthOwned?: (scope: SecretScope) => readonly string[] | null;
  // The app's proxy secret (app-proxy-secret.ts), written to its file as
  // ISOMUX_APP_PROXY_SECRET. Throws when it cannot be computed.
  proxySecret: (app: AppRecord) => string;
  // A fixed line that names apps and secrets, never a value or an error.
  log?: (line: string) => void;
  // The secrets file of an app whose owner has their own OS user, written
  // through their runner (app-supervisor-router.ts); null for an app whose
  // file is in `dir`. Throws when the owner's host is not ready.
  fileFor?: (app: AppRecord) => AppSecretsFile | null;
  // An app not to write now (its owner's own OS user is not ready); its
  // owner's connect syncs again.
  skip?: (app: AppRecord) => boolean;
}

export interface AppSecretsFile {
  // The current text, or null. Read only to skip an unchanged write: nothing
  // in it is used.
  read(): string | null;
  write(text: string): void;
}

export function createAppSecrets(deps: AppSecretsDeps) {
  const log = deps.log ?? ((line: string) => console.error(line));

  // A scope's secrets, or none when its file cannot be read.
  function readScope(scope: SecretScope): ValuedSecret[] {
    try {
      return deps.store.readForProxy(scope);
    } catch (error) {
      if (error instanceof SecretStoreUnreadableError) return [];
      throw error;
    }
  }

  // The secrets an OAuth registration owns are the server's own. Fails
  // closed as the agent placeholders do (secret-proxy/runtime.ts): with
  // unreadable registrations, every name of the flow's shape.
  function ownedIn(scope: SecretScope): (name: string) => boolean {
    const owned = deps.oauthOwned ? deps.oauthOwned(scope) : [];
    if (owned === null) return (name) => OAUTH_SECRET_NAME.test(name);
    const names = new Set(owned);
    return (name) => names.has(name);
  }

  // The values `app` gets: the office secrets and its owner's secrets whose
  // grant names this app and its creation time.
  function envFor(app: AppRecord): Record<string, string> {
    const scopes: SecretScope[] = [{ kind: "office" }];
    // A member secret goes only to an app that member owns.
    if (app.userId) scopes.push({ kind: "user", userId: app.userId });
    const env: Record<string, string> = {};
    const clashed = new Set<string>();
    for (const scope of scopes) {
      const owned = ownedIn(scope);
      for (const secret of readScope(scope)) {
        if (owned(secret.name)) continue;
        const granted = (secret.apps ?? []).some(
          (grant) =>
            grant.name === app.name && grant.createdAt === app.createdAt,
        );
        if (!granted) continue;
        if (secret.name in env) clashed.add(secret.name);
        env[secret.name] = secret.value;
      }
    }
    // The store refuses a clash; a hand-edited file can still hold one. A
    // wrong value is worse than none.
    for (const name of clashed) {
      delete env[name];
      log(
        `[app-secrets] two scopes give the app "${app.name}" the secret ${name}; it gets neither`,
      );
    }
    return env;
  }

  // One pass. Synchronous from start to end, so two passes never overlap.
  // `boot`: also rewrite two kinds of old unit: one written before app
  // secrets existed (no secrets line), and one whose PATH misses the
  // runtime's bin folder (a member's unit that named the office user's bun).
  // Only then: in a container the unit check is a subprocess per app.
  function run(boot: boolean): void {
    let apps: AppRecord[];
    try {
      apps = deps.apps();
    } catch {
      log("[app-secrets] the app records could not be read");
      return;
    }
    const isLive = (grant: { name: string; createdAt: number }) =>
      apps.some(
        (a) => a.name === grant.name && a.createdAt === grant.createdAt,
      );
    try {
      deps.store.pruneApps(isLive);
    } catch {
      log("[app-secrets] stale app grants could not be removed");
    }

    const wanted = new Set<string>();
    const changed: string[] = [];
    // Apps whose unit got the runtime folder in its PATH at this boot.
    const pathFixed: string[] = [];
    for (const app of apps) {
      if (deps.skip?.(app)) continue;
      if (boot)
        try {
          // A unit written before app secrets existed does not read the
          // file; a unit without the runtime folder cannot find bun.
          const pathStale = !deps.supervisor.unitPathHasRuntime(app.name);
          if (pathStale || !deps.supervisor.unitInjectsSecrets(app.name)) {
            deps.supervisor.regenerate(app);
            if (pathStale) pathFixed.push(app.name);
          }
        } catch {
          log(
            `[app-secrets] the unit of the app "${app.name}" could not be updated`,
          );
        }
      let proxySecret: string;
      try {
        proxySecret = deps.proxySecret(app);
      } catch {
        // Its current file stays, and the app keeps running with it.
        wanted.add(`${app.name}.env`);
        log(
          `[app-secrets] the proxy secret of the app "${app.name}" could not be computed`,
        );
        continue;
      }
      let text: string;
      try {
        // The proxy secret last: it wins over any other value of its name.
        text = renderSecretsEnv({
          ...envFor(app),
          [APP_PROXY_SECRET_ENV]: proxySecret,
        });
      } catch {
        log(
          `[app-secrets] the secrets of the app "${app.name}" could not be read`,
        );
        continue;
      }
      let file: AppSecretsFile | null;
      try {
        file = deps.fileFor ? deps.fileFor(app) : null;
      } catch {
        log(
          `[app-secrets] the secrets file of the app "${app.name}" could not be written`,
        );
        continue;
      }
      if (file) {
        try {
          if (file.read() === text) continue;
          file.write(text);
          changed.push(app.name);
        } catch {
          log(
            `[app-secrets] the secrets file of the app "${app.name}" could not be written`,
          );
        }
        continue;
      }
      const path = appSecretsPath(deps.dir, app.name);
      try {
        const current = existsSync(path) ? readFileSync(path, "utf8") : null;
        wanted.add(`${app.name}.env`);
        if (current === text) continue;
        mkdirSync(deps.dir, { recursive: true, mode: DIR_MODE });
        chmodSync(deps.dir, DIR_MODE);
        atomicWriteFileSync(path, text, FILE_MODE);
        changed.push(app.name);
      } catch {
        log(
          `[app-secrets] the secrets file of the app "${app.name}" could not be written`,
        );
      }
    }

    // Every other file goes: a deleted app's, an empty one's, a temp file.
    try {
      if (existsSync(deps.dir))
        for (const entry of readdirSync(deps.dir))
          if (!wanted.has(entry))
            rmSync(join(deps.dir, entry), { recursive: true, force: true });
    } catch {
      log("[app-secrets] an old secrets file could not be removed");
    }

    const asked = [...new Set([...changed, ...pathFixed])];
    if (asked.length === 0) return;
    let states: ReturnType<AppSupervisor["states"]>;
    try {
      states = deps.supervisor.states(asked);
    } catch {
      log("[app-secrets] the app states could not be read; no app restarted");
      return;
    }
    for (const name of changed) {
      const state = states.get(name)?.state;
      // A stopped or failed app reads the file at its next start.
      if (state !== "running" && state !== "starting") continue;
      try {
        deps.supervisor.restart(name);
      } catch {
        log(
          `[app-secrets] the app "${name}" could not be restarted to read its secrets`,
        );
      }
    }
    // The old PATH made the app exit at its start, so it is failed and
    // nothing else starts it again. A running app does not need the PATH
    // now; a stopped one was stopped by its owner.
    for (const name of pathFixed) {
      if (states.get(name)?.state !== "failed") continue;
      try {
        deps.supervisor.restart(name);
      } catch {
        log(
          `[app-secrets] the app "${name}" could not be restarted with its new PATH`,
        );
      }
    }
  }

  function syncNow(options: { boot?: boolean } = {}): void {
    try {
      run(options.boot === true);
    } catch {
      log("[app-secrets] the app secrets could not be synced");
    }
  }

  return {
    // Converge the files on the store, restart the running apps whose file
    // changed, and prune stale grants; at boot, also regenerate a unit that
    // does not read its file or whose PATH misses the runtime folder, and
    // restart a failed app whose PATH that fixed. Never throws: a failure for one app is logged and the others
    // go on. Synchronous, so calls never overlap, and a caller that must not
    // yield (the app delete, which holds the name until it answers) can use
    // it.
    syncNow,

    // The same, for an async caller.
    async sync(options: { boot?: boolean } = {}): Promise<void> {
      syncNow(options);
    },
  };
}

export type AppSecrets = ReturnType<typeof createAppSecrets>;
