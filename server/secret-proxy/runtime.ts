// The server side of the secrets proxy (internal-docs/secrets-design.md,
// sections 2.1-2.6). It owns the placeholder key and the CA, builds the
// snapshot that the proxy child gets over IPC, and tells env-loader what to
// put in an agent's environment.
//
// The store has one reader: this module. An office without secrets never
// makes the material, never starts the child and never changes an
// environment (ruling 8). The runtime acts only after `enable()`, which
// runOfficeMain calls; the in-process test harness never does.

import {
  SecretStoreUnreadableError,
  type SecretScope,
  type SecretStore,
  type StoredSecret,
} from "../secret-store.ts";
import { scopeId, placeholderFor } from "./placeholders.ts";
import {
  ensureSecretMaterial,
  readProxyPort,
  readSystemRoots,
  saveProxyPort,
  type SecretMaterial,
} from "./material.ts";
import type { ProxySecret, ProxySnapshot, ProxyUse } from "./proxy.ts";
import { createProxySupervisor, type ProxySupervisor } from "./supervisor.ts";

// What env-loader merges for one member (or for an unowned context).
export interface SecretEnvironment {
  office: Record<string, string>;
  member: Record<string, string>;
  // The proxy and trust variables. They go last, over every variable.
  fixed: Record<string, string>;
  // Non-value secret state for the OpenCode revision: each secret's scope,
  // name, generation and placeholder, and the proxy port.
  revision: string;
}

// A change that agents in `scopes` must restart for: their set of secrets or
// a placeholder changed, or the proxy moved to another port ("all").
export type SecretSetChange = SecretScope[] | "all";

export interface SecretsRuntimeDeps {
  store: SecretStore;
  stateRoot: string;
  shareRoot: string;
  // The server's own environment: its SSL_CERT_FILE and its company proxy.
  serverEnv: Record<string, string | undefined>;
  onUse: (use: ProxyUse) => void;
  onSetChanged: (change: SecretSetChange) => void;
  onValues: (values: string[]) => void;
  log: (code: string) => void;
  // Tests only: another child entry, its environment, and roots that stand
  // in for the system roots.
  childEntry?: string;
  childEnv?: Record<string, string>;
  systemRootsPem?: string;
  // How long boot and a secret route wait for the child to listen.
  startWaitMs?: number;
}

const START_WAIT_MS = 5000;

const NO_PROXY = "localhost,127.0.0.1,::1";

function companyProxy(
  env: Record<string, string | undefined>,
): ProxySnapshot["upstreamProxy"] {
  const url = env.HTTPS_PROXY || env.https_proxy;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
  } catch {
    return null;
  }
  return { url, noProxy: env.NO_PROXY || env.no_proxy || "" };
}

export function createSecretsRuntime(deps: SecretsRuntimeDeps) {
  let enabled = false;
  let material: SecretMaterial | null = null;
  let systemRoots: string | null = null;
  let supervisor: ProxySupervisor | null = null;
  let starting: Promise<number> | null = null;
  // scopeId -> the set signature agents of that scope were last given.
  let signatures = new Map<string, string>();
  // An environment was asked for while no child had listened yet, so it got
  // no proxy variables. The first listen marks every agent.
  let withheld = false;
  // Codes for a lasting state are logged once until the state ends:
  // environments are built often, and one line per build would fill the log.
  const logged = new Set<string>();
  function logOnce(key: string, code: string) {
    if (logged.has(key)) return;
    logged.add(key);
    deps.log(code);
  }

  // A scope's secrets, or none when its file cannot be read: agents in that
  // scope then get no placeholder (they never get a value either), and the
  // rest of the office keeps working.
  function readScope(scope: SecretScope): StoredSecret[] {
    const key = `store_unreadable:${scopeId(scope)}`;
    try {
      const secrets = deps.store.readForProxy(scope);
      logged.delete(key);
      return secrets;
    } catch (error) {
      if (!(error instanceof SecretStoreUnreadableError)) throw error;
      logOnce(key, "store_unreadable");
      return [];
    }
  }

  // Waits for the first listen, at most `startWaitMs`. A child that never
  // listens must not hold the office's boot or a secret route.
  async function waitForListen(start: Promise<number>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listened = await Promise.race([
      start.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          deps.startWaitMs ?? START_WAIT_MS,
        );
      }),
    ]);
    clearTimeout(timer);
    if (!listened) deps.log("proxy_not_listening");
  }

  function ensureMaterial(): SecretMaterial {
    if (!material) {
      systemRoots ??= deps.systemRootsPem ?? readSystemRoots(deps.serverEnv);
      material = ensureSecretMaterial({
        stateRoot: deps.stateRoot,
        shareRoot: deps.shareRoot,
        systemRootsPem: systemRoots,
      });
    }
    return material;
  }

  // Every stored secret with its placeholder, scope by scope.
  function readAll(): { scope: SecretScope; secrets: ProxySecret[] }[] {
    const key = ensureMaterial().placeholderKey;
    return deps.store.scopes().map((scope) => ({
      scope,
      secrets: readScope(scope).map((secret) => ({
        scope: scopeId(scope),
        ownerId: scope.kind === "user" ? scope.userId : null,
        name: secret.name,
        value: secret.value,
        hosts: secret.hosts,
        form: secret.form,
        placeholder: placeholderFor(
          key,
          scope,
          secret.name,
          secret.generation,
          secret.value,
        ),
      })),
    }));
  }

  function signatureOf(secrets: ProxySecret[]): string {
    return JSON.stringify(secrets.map((s) => [s.name, s.placeholder]).sort());
  }

  function snapshot(): ProxySnapshot {
    const current = ensureMaterial();
    return {
      secrets: readAll().flatMap((entry) => entry.secrets),
      caCertPem: current.ca.certPem,
      caKeyPem: current.ca.keyPem,
      rootsPem: systemRoots ?? "",
      upstreamProxy: companyProxy(deps.serverEnv),
    };
  }

  // The port a child listens on in this process. Before the first listen
  // there is none: agents then get no proxy variables rather than a port
  // that nothing may answer on.
  function port(): number | null {
    return supervisor?.port ?? null;
  }

  function startProxy(): Promise<number> {
    if (starting) return starting;
    supervisor = createProxySupervisor({
      entry: deps.childEntry,
      env: deps.childEnv,
      snapshot,
      savedPort: readProxyPort(deps.stateRoot),
      onPort: (next, previous) => {
        saveProxyPort(deps.stateRoot, next);
        if (previous !== null) deps.onSetChanged("all");
      },
      onListening: () => {
        logged.delete("no_proxy_port");
        if (!withheld) return;
        withheld = false;
        deps.onSetChanged("all");
      },
      onUse: deps.onUse,
      log: deps.log,
    });
    starting = supervisor.start();
    return starting;
  }

  // Recomputes every scope's signature; returns the scopes whose set
  // changed since agents last got it.
  function refresh(): SecretScope[] {
    const entries = readAll();
    const next = new Map<string, string>();
    const changed: SecretScope[] = [];
    for (const { scope, secrets } of entries) {
      const signature = signatureOf(secrets);
      next.set(scopeId(scope), signature);
      if ((signatures.get(scopeId(scope)) ?? "[]") !== signature)
        changed.push(scope);
    }
    signatures = next;
    deps.onValues(entries.flatMap((e) => e.secrets.map((s) => s.value)));
    return changed;
  }

  return {
    // Boot: start the proxy if the office has a secret.
    async enable(): Promise<void> {
      enabled = true;
      if (!deps.store.hasAny()) return;
      refresh();
      await waitForListen(startProxy());
    },

    // After any successful secret change. Pushes the new snapshot, and marks
    // the scopes whose set of secrets or placeholders changed.
    async changed(): Promise<void> {
      if (!enabled) return;
      const changed = refresh();
      if (!supervisor) {
        if (!deps.store.hasAny()) return;
        await waitForListen(startProxy());
      } else supervisor.push();
      if (changed.length > 0) deps.onSetChanged(changed);
    },

    // The variables for an agent, terminal or scheduled run of `userId`
    // (null: unowned), or null when no secret is in scope.
    environmentFor(
      userId: string | null | undefined,
    ): SecretEnvironment | null {
      if (!enabled || !material) return null;
      const scopes: SecretScope[] = [{ kind: "office" }];
      if (userId) scopes.push({ kind: "user", userId });
      const key = material.placeholderKey;
      const office: Record<string, string> = {};
      const member: Record<string, string> = {};
      const state: [string, string, number, string][] = [];
      for (const scope of scopes) {
        for (const secret of readScope(scope)) {
          const placeholder = placeholderFor(
            key,
            scope,
            secret.name,
            secret.generation,
            secret.value,
          );
          (scope.kind === "office" ? office : member)[secret.name] =
            placeholder;
          state.push([
            scopeId(scope),
            secret.name,
            secret.generation,
            placeholder,
          ]);
        }
      }
      if (state.length === 0) return null;
      const proxyPort = port();
      if (proxyPort === null) {
        withheld = true;
        logOnce("no_proxy_port", "no_proxy_port");
        return null;
      }
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;
      const bundle = material.bundlePath;
      return {
        office,
        member,
        fixed: {
          HTTPS_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY,
          no_proxy: NO_PROXY,
          SSL_CERT_FILE: bundle,
          NODE_EXTRA_CA_CERTS: bundle,
          CODEX_CA_CERTIFICATE: bundle,
          REQUESTS_CA_BUNDLE: bundle,
          CURL_CA_BUNDLE: bundle,
          GIT_SSL_CAINFO: bundle,
          CARGO_HTTP_CAINFO: bundle,
          NODE_USE_ENV_PROXY: "1",
        },
        revision: JSON.stringify({ secrets: state.sort(), port: proxyPort }),
      };
    },

    // The placeholder of one secret, for an MCP server's header, or null
    // while no proxy listens (the header could not reach its host with the
    // value) or the secret does not exist.
    placeholderOf(scope: SecretScope, name: string): string | null {
      if (!enabled || !material) return null;
      if (port() === null) {
        withheld = true;
        logOnce("no_proxy_port", "no_proxy_port");
        return null;
      }
      const secret = readScope(scope).find((s) => s.name === name);
      return secret
        ? placeholderFor(
            material.placeholderKey,
            scope,
            name,
            secret.generation,
            secret.value,
          )
        : null;
    },

    async stop(): Promise<void> {
      await supervisor?.stop();
    },

    get proxyPort(): number | null {
      return port();
    },

    // Tests only: the child's pid, to kill it.
    get proxyPid(): number | null {
      return supervisor?.pid ?? null;
    },
  };
}

export type SecretsRuntime = ReturnType<typeof createSecretsRuntime>;
