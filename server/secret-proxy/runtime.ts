// The server side of the secrets proxy (internal-docs/secrets-design.md,
// sections 2.1-2.6). It owns the placeholder key and the CA, builds the
// snapshot that the proxy child gets over IPC, and tells env-loader what to
// put in an agent's environment.
//
// The store has one reader: this module. An office without secrets, and
// without a cached OAuth MCP access token (GitHub #77), never makes the
// material, never starts the child and never changes an environment
// (ruling 8). The runtime acts only after `enable()`, which
// runOfficeMain calls; the in-process test harness never does.

import {
  SecretStoreUnreadableError,
  type SecretScope,
  type SecretStore,
  type ValuedSecret,
} from "../secret-store.ts";
import { OAUTH_SECRET_NAME, mcpServerHost } from "../../shared/mcp-servers.ts";
import {
  isNeverListed,
  isValidSecretHost,
  type ExchangeSpec,
} from "../../shared/secret-hosts.ts";
import { placeholderFor, proxyClientToken, scopeId } from "./placeholders.ts";
import {
  CA_BUNDLE_VARIABLES,
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
  // The git credential helper's answers (design 2.4): for each host of a
  // secret in the authorization form, the placeholder that git sends as the
  // Basic password. env-loader appends them as GIT_CONFIG_* entries.
  gitCredentials: { host: string; placeholder: string }[];
  // Non-value secret state for the OpenCode revision: each secret's scope,
  // name, generation and placeholder, and the proxy address with its password.
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
  // The secrets that OAuth MCP registrations own in a scope (integrations
  // A2b), or null when the registrations cannot be read.
  oauthOwned?: (scope: SecretScope) => readonly string[] | null;
  // The cached access tokens of OAuth MCP registrations (mcp-oauth-tokens.ts,
  // GitHub #77): snapshot entries whose placeholders a live session's header
  // carries, so a renewal needs no restart and no new session.
  oauthAccess?: () => {
    scope: SecretScope;
    name: string;
    url: string;
    accessToken: string;
  }[];
  // Tests only: another child entry, its environment, and roots that stand
  // in for the system roots.
  childEntry?: string;
  childEnv?: Record<string, string>;
  systemRootsPem?: string;
  // How long boot and a secret route wait for the child to listen.
  startWaitMs?: number;
  // The uid of each member OS user and its member
  // (member-os-users.ts, memberOsUidTies). Default: none.
  memberUids?: () => { uid: number; userId: string }[];
  // The secret material was made or read, with the text of its CA bundle:
  // members' shares get a copy (member-hosts.ts).
  onBundle?: (bundlePem: string) => void;
  // How long tieMember waits for the child to apply the tie.
  tieWaitMs?: number;
}

const START_WAIT_MS = 5000;
const TIE_WAIT_MS = 5000;

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
  function readScope(scope: SecretScope): ValuedSecret[] {
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

  // The refresh token and client secret of an OAuth MCP server are the
  // server's own credentials, never an agent's: no placeholder, not in the
  // proxy snapshot, so the flow's rotation of one restarts no agent. Fails
  // closed: with unreadable registrations, every name of the flow's shape.
  function ownedIn(scope: SecretScope): (name: string) => boolean {
    const owned = deps.oauthOwned ? deps.oauthOwned(scope) : [];
    if (owned === null) return (name) => OAUTH_SECRET_NAME.test(name);
    const names = new Set(owned);
    return (name) => names.has(name);
  }

  // The access token itself is in memory only, no secret of the store - but
  // a live session's header must still survive a renewal (GitHub #77): the
  // snapshot carries each token as an entry of its own, which the proxy
  // swaps in at the request. Its placeholder has a fixed generation and a
  // fixed shape, and its HMAC input names a NUL no member secret can carry,
  // so it is stable across renewals and restarts and collides with nothing.
  // A token counts as a secret in its scope: its agents get the proxy
  // variables, and a sign-in or a drop changes the scope's set. A renewal
  // keeps the placeholder, so it changes no set and restarts no agent.
  function oauthPlaceholder(scope: SecretScope, name: string): string {
    return placeholderFor(
      ensureMaterial().placeholderKey,
      scope,
      `${name}\u0000access`,
      0,
      "",
    );
  }

  // The tokens the proxy can carry: on a host it ends TLS for. A server on
  // another host (an IP address, a never-listed host) keeps the token itself
  // in its header.
  function carriedOAuth(): {
    scope: SecretScope;
    name: string;
    url: string;
    host: string;
    accessToken: string;
  }[] {
    return (deps.oauthAccess?.() ?? []).flatMap((token) => {
      const host = mcpServerHost(token.url);
      return isValidSecretHost(host) && !isNeverListed(host)
        ? [{ ...token, host }]
        : [];
    });
  }

  function oauthEntries(scope: SecretScope): ProxySecret[] {
    const id = scopeId(scope);
    return carriedOAuth()
      .filter((token) => scopeId(token.scope) === id)
      .map((token) => ({
        scope: id,
        ownerId: scope.kind === "user" ? scope.userId : null,
        // The registration's name, as the audit of a use and a 403 read it.
        name: token.name,
        value: token.accessToken,
        hosts: [token.host],
        form: { kind: "authorization" },
        placeholder: oauthPlaceholder(scope, token.name),
      }));
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
      deps.onBundle?.(material.bundlePem);
    }
    return material;
  }

  // Every stored secret with its placeholder, scope by scope.
  // The material is made only when a secret needs a placeholder: an office
  // whose secrets only apps read has no CA.
  // Each scope's cached OAuth access tokens come with it, in `oauth`.
  function readAll(): {
    scope: SecretScope;
    secrets: ProxySecret[];
    oauth: ProxySecret[];
  }[] {
    const key = () => ensureMaterial().placeholderKey;
    return allScopes().map((scope) => ({
      scope,
      oauth: oauthEntries(scope),
      secrets: agentSecrets(scope).map((secret) => ({
        scope: scopeId(scope),
        ownerId: scope.kind === "user" ? scope.userId : null,
        name: secret.name,
        value: secret.value,
        hosts: secret.hosts,
        form: secret.form,
        ...(secret.exchange ? { exchange: secret.exchange } : {}),
        placeholder: placeholderFor(
          key(),
          scope,
          secret.name,
          secret.generation,
          secret.value,
        ),
      })),
    }));
  }

  // The store's scopes and the scopes of the cached OAuth tokens.
  function allScopes(): SecretScope[] {
    const scopes = new Map<string, SecretScope>();
    for (const scope of deps.store.scopes()) scopes.set(scopeId(scope), scope);
    for (const token of deps.oauthAccess?.() ?? [])
      if (!scopes.has(scopeId(token.scope)))
        scopes.set(scopeId(token.scope), token.scope);
    return [...scopes.values()];
  }

  // The secrets agents use: not one an OAuth registration owns, and not
  // one with no host, which only apps read (task c7007f8b).
  function agentSecrets(scope: SecretScope): ValuedSecret[] {
    const owned = ownedIn(scope);
    return readScope(scope).filter(
      (secret) => !owned(secret.name) && secret.hosts.length > 0,
    );
  }

  // True when a scope holds a secret that agents use. An unreadable file
  // counts, for the reason store.hasAny gives.
  function hasAgentSecrets(): boolean {
    return deps.store.scopes().some((scope) => {
      try {
        const owned = ownedIn(scope);
        return deps.store
          .readForProxy(scope)
          .some((secret) => !owned(secret.name) && secret.hosts.length > 0);
      } catch (error) {
        if (error instanceof SecretStoreUnreadableError) return true;
        throw error;
      }
    });
  }

  // True when the proxy has something to carry: a secret that agents use,
  // or a cached OAuth access token on a host it can carry.
  function hasAgentCredentials(): boolean {
    return hasAgentSecrets() || carriedOAuth().length > 0;
  }

  function signatureOf(secrets: ProxySecret[], oauth: ProxySecret[]): string {
    return JSON.stringify(
      [
        ...secrets.map((s) => [s.name, s.placeholder]),
        ...oauth.map((s) => [`${s.name}\u0000access`, s.placeholder]),
      ].sort(),
    );
  }

  function snapshot(): ProxySnapshot {
    const current = ensureMaterial();
    return {
      secrets: readAll().flatMap((entry) => [...entry.secrets, ...entry.oauth]),
      caCertPem: current.ca.certPem,
      caKeyPem: current.ca.keyPem,
      rootsPem: systemRoots ?? "",
      upstreamProxy: companyProxy(deps.serverEnv),
      clientToken: proxyClientToken(current.placeholderKey),
      members: deps.memberUids?.() ?? [],
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
    for (const { scope, secrets, oauth } of entries) {
      const signature = signatureOf(secrets, oauth);
      next.set(scopeId(scope), signature);
      if ((signatures.get(scopeId(scope)) ?? "[]") !== signature)
        changed.push(scope);
    }
    // A scope whose file is gone (a removed member's) lost its secrets.
    for (const [id, signature] of signatures)
      if (!next.has(id) && signature !== "[]")
        changed.push(
          id === "office"
            ? { kind: "office" }
            : { kind: "user", userId: id.slice("user:".length) },
        );
    signatures = next;
    // Log redaction masks the owned values and the access tokens too.
    deps.onValues([
      ...deps.store
        .scopes()
        .flatMap((scope) => readScope(scope).map((s) => s.value)),
      ...(deps.oauthAccess?.() ?? []).map((token) => token.accessToken),
    ]);
    return changed;
  }

  // After a secret or an OAuth access-token change: pushes the new snapshot
  // (or starts the proxy), and marks the scopes whose set of secrets or
  // placeholders changed.
  async function applyChange(): Promise<void> {
    if (!enabled) return;
    const scopes = refresh();
    if (!supervisor) {
      if (!hasAgentCredentials()) return;
      await waitForListen(startProxy());
    } else supervisor.push();
    if (scopes.length > 0) deps.onSetChanged(scopes);
  }

  return {
    // Boot: start the proxy if the office has a secret that agents use. An
    // office whose secrets only apps read still feeds log redaction.
    async enable(): Promise<void> {
      enabled = true;
      if (!deps.store.hasAny() && (deps.oauthAccess?.() ?? []).length === 0)
        return;
      refresh();
      if (!hasAgentCredentials()) return;
      await waitForListen(startProxy());
    },

    // After any successful secret change. Pushes the new snapshot, and marks
    // the scopes whose set of secrets or placeholders changed.
    async changed(): Promise<void> {
      await applyChange();
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
      const git = new Map<string, string>();
      // Member scope first, so a member secret wins a host over an office one.
      for (const scope of [...scopes].reverse()) {
        for (const secret of agentSecrets(scope)) {
          const placeholder = placeholderFor(
            key,
            scope,
            secret.name,
            secret.generation,
            secret.value,
          );
          (scope.kind === "office" ? office : member)[secret.name] =
            placeholder;
          // git sends Basic, and the proxy never puts a token inside Basic:
          // a secret with a token exchange gets no helper entry.
          if (secret.form.kind === "authorization" && !secret.exchange)
            for (const host of secret.hosts)
              if (!git.has(host)) git.set(host, placeholder);
          state.push([
            scopeId(scope),
            secret.name,
            secret.generation,
            placeholder,
          ]);
        }
        // A cached OAuth access token: no variable, but its MCP header
        // carries a placeholder, so the agent needs the proxy.
        for (const entry of oauthEntries(scope))
          state.push([
            scopeId(scope),
            `${entry.name}\u0000access`,
            0,
            entry.placeholder,
          ]);
      }
      if (state.length === 0) return null;
      const proxyPort = port();
      if (proxyPort === null) {
        withheld = true;
        logOnce("no_proxy_port", "no_proxy_port");
        return null;
      }
      const token = proxyClientToken(material.placeholderKey);
      const proxyUrl = `http://isomux:${token}@127.0.0.1:${proxyPort}`;
      const bundle = material.bundlePath;
      const ca = Object.fromEntries(
        CA_BUNDLE_VARIABLES.map((name) => [name, bundle]),
      );
      const gitCredentials = [...git]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([host, placeholder]) => ({ host, placeholder }));
      return {
        office,
        member,
        fixed: {
          HTTPS_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY,
          no_proxy: NO_PROXY,
          ...ca,
          NODE_USE_ENV_PROXY: "1",
        },
        gitCredentials,
        // The git helpers too: they follow the hosts and forms.
        revision: JSON.stringify({
          secrets: state.sort(),
          proxy: proxyUrl,
          git: gitCredentials.map(({ host, placeholder }) => [
            host,
            placeholder,
          ]),
        }),
      };
    },

    // True once the proxy ties member uid `uid` to its member
    // (ProxySnapshot.members): a member's agents start only after it. True
    // at once when no proxy runs (one that starts later reads the current
    // ties); false when the running child does not apply it in time.
    async tieMember(uid: number): Promise<boolean> {
      if (!supervisor) return true;
      const tied = await supervisor.whenTied(
        uid,
        deps.tieWaitMs ?? TIE_WAIT_MS,
      );
      if (!tied) deps.log("member_tie_not_applied");
      return tied;
    },

    // The text of the CA bundle, or null while the office has no secret
    // material.
    caBundle(): string | null {
      return material?.bundlePem ?? null;
    },

    // True when `value` is the current placeholder of the agent secret
    // `name` in some scope. Never makes the material; false while secrets
    // are off or no material exists. An unreadable scope counts as no match,
    // and nothing here throws: the caller then keeps today's behaviour.
    isPlaceholder(name: string, value: string): boolean {
      if (!enabled || !material) return false;
      const key = material.placeholderKey;
      try {
        return deps.store
          .scopes()
          .some((scope) =>
            agentSecrets(scope).some(
              (secret) =>
                secret.name === name &&
                placeholderFor(
                  key,
                  scope,
                  name,
                  secret.generation,
                  secret.value,
                ) === value,
            ),
          );
      } catch {
        return false;
      }
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
      const secret = agentSecrets(scope).find((s) => s.name === name);
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

    // The placeholder of an OAuth registration's access token, for its MCP
    // header, or null while no proxy listens, no token is cached for that
    // registration's current URL, or the proxy cannot carry its host. The
    // header carries the token itself then, which a renewal leaves stale.
    oauthPlaceholderOf(
      scope: SecretScope,
      name: string,
      url: string,
    ): string | null {
      if (!enabled || !material) return null;
      if (port() === null) {
        withheld = true;
        logOnce("no_proxy_port", "no_proxy_port");
        return null;
      }
      const wanted = scopeId(scope);
      const found = carriedOAuth().some(
        (token) =>
          token.name === name &&
          token.url === url &&
          scopeId(token.scope) === wanted,
      );
      return found ? oauthPlaceholder(scope, name) : null;
    },

    // An access token appeared, renewed or went (mcp-oauth-tokens.ts): as
    // changed(). A renewal keeps the placeholder, so only the snapshot moves.
    async oauthTokensChanged(): Promise<void> {
      await applyChange();
    },

    async stop(): Promise<void> {
      await supervisor?.stop();
    },

    // Tests only: the scope, name and exchange of each secret the proxy
    // snapshot holds.
    snapshotSecrets(): {
      scope: string;
      name: string;
      exchange?: ExchangeSpec;
    }[] {
      return snapshot().secrets.map((s) => ({
        scope: s.scope,
        name: s.name,
        ...(s.exchange ? { exchange: s.exchange } : {}),
      }));
    },

    get proxyPort(): number | null {
      return port();
    },
  };
}

export type SecretsRuntime = ReturnType<typeof createSecretsRuntime>;
