// OAuth MCP servers (integrations loop, slice A2b). Isomux is the OAuth
// client (Lead ruling): it runs the MCP authorization flow once per
// registration in the member's browser, keeps the refresh token as a secret
// of the registration's scope, refreshes the access token, and the A2
// channels give the access token to every engine (mcpServerSecret in
// server/mcp-servers.ts reads it from server/mcp-oauth-tokens.ts).
//
// The flow: protected-resource metadata (RFC 9728), authorization-server
// metadata (RFC 8414), dynamic client registration (RFC 7591) unless the
// member pasted a client, PKCE S256, the state parameter, the resource
// parameter (RFC 8707). Every endpoint is https and comes from metadata the
// server checks: the resource names the registered URL and the issuer names
// the URL it was fetched from.
//
// A token never leaves this module but into the secret store, the token
// cache and the authorization server. No error object leaves either: a fetch
// error's message can carry a URL, so every failure is a fixed reason code.

import { mcpServerHost, oauthSecretNames } from "../shared/mcp-servers.ts";
import { checkSecretValue } from "../shared/secret-hosts.ts";
import type { McpServerWire } from "../shared/contract-shapes.ts";
import type {
  McpServerChange,
  McpServerStore,
  StoredOAuth,
} from "./mcp-server-store.ts";
import {
  dropOAuthTokens,
  markOAuthSignInNeeded,
  oauthSignInNeeded,
  oauthTokenExpiry,
  oauthTokenKey,
  setOAuthAccessToken,
} from "./mcp-oauth-tokens.ts";
import type { SecretScope, SecretStore } from "./secret-store.ts";

export type McpOAuthFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface McpOAuthDeps {
  servers: McpServerStore;
  secrets: SecretStore;
  fetch: McpOAuthFetch;
  // The callback URL on the office's own origin.
  redirectUri: () => string;
  now?: () => number;
  timeoutMs?: number;
}

export type McpOAuthReason =
  | "not_found"
  | "not_oauth"
  | "discovery_failed"
  | "insecure_endpoint"
  | "resource_mismatch"
  | "issuer_mismatch"
  | "client_needed"
  | "registration_refused"
  | "redirect_refused"
  | "secret_exists"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "unexpected"
  | "state_unknown"
  | "state_expired"
  | "wrong_member"
  | "denied"
  | "changed"
  | "token_refused";

export const MCP_OAUTH_TIMEOUT_MS = 10_000;
export const MCP_OAUTH_PENDING_MS = 10 * 60_000;
// A token with less than this left is refreshed.
export const MCP_OAUTH_REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CLIENT_ID_LENGTH = 512;
const MCP_PROTOCOL_VERSION = "2025-06-18";

class Failure extends Error {
  constructor(readonly reason: McpOAuthReason) {
    super(reason);
  }
}

function freshOAuth(): StoredOAuth {
  return {
    clientId: null,
    pasted: false,
    clientSecret: null,
    tokenEndpointAuth: "none",
    redirectUri: null,
    issuer: null,
    authorizationEndpoint: null,
    tokenEndpoint: null,
    scope: null,
    refreshToken: null,
    ownedSecrets: [],
  };
}

// The `oauth` field of a create or update body: null, {} (dynamic client
// registration) or a pasted client.
export function checkOAuthRequest(
  value: unknown,
):
  | {
      ok: true;
      oauth: { clientId: string | null; clientSecret: string | null } | null;
    }
  | { ok: false } {
  if (value === null) return { ok: true, oauth: null };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false };
  const o = value as Record<string, unknown>;
  if (
    !Object.keys(o).every((key) => key === "clientId" || key === "clientSecret")
  )
    return { ok: false };
  const clientId = o.clientId ?? null;
  const clientSecret = o.clientSecret ?? null;
  if (
    clientId !== null &&
    (typeof clientId !== "string" ||
      clientId.length === 0 ||
      clientId.length > MAX_CLIENT_ID_LENGTH ||
      !/^[\x21-\x7e]+$/.test(clientId))
  )
    return { ok: false };
  if (
    clientSecret !== null &&
    (clientId === null || checkSecretValue(clientSecret))
  )
    return { ok: false };
  return {
    ok: true,
    oauth: {
      clientId,
      clientSecret: clientSecret as string | null,
    },
  };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new Failure("discovery_failed");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Failure("discovery_failed");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Failure("insecure_endpoint");
  return parsed.href;
}

// A trailing slash does not make another resource.
function sameResource(a: string, b: string): boolean {
  const trim = (url: string) => url.replace(/\/+$/, "");
  try {
    return trim(new URL(a).href) === trim(new URL(b).href);
  } catch {
    return false;
  }
}

interface Answer {
  status: number;
  headers: Headers;
  text: string;
}

export function createMcpOAuth(deps: McpOAuthDeps) {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? MCP_OAUTH_TIMEOUT_MS;

  // The one way out: https only, no redirect, a size cap, a fixed code for
  // every network error.
  async function send(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Answer> {
    httpsUrl(url);
    let response: Response;
    try {
      response = await deps.fetch(url, { ...init, redirect: "manual", signal });
    } catch {
      throw new Failure(signal.aborted ? "timeout" : "unreachable");
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      throw new Failure("redirect");
    }
    const reader = response.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BODY_BYTES) throw new Failure("unexpected");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch (err) {
        throw err instanceof Failure
          ? err
          : new Failure(signal.aborted ? "timeout" : "unreachable");
      } finally {
        void reader.cancel().catch(() => {});
      }
    }
    return { status: response.status, headers: response.headers, text };
  }

  function json(answer: Answer): Record<string, unknown> {
    try {
      const parsed = JSON.parse(answer.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // Falls through.
    }
    throw new Failure("unexpected");
  }

  // The first candidate that answers 200 with a JSON object.
  async function firstMetadata(
    candidates: string[],
    signal: AbortSignal,
  ): Promise<{ url: string; body: Record<string, unknown> }> {
    for (const url of candidates) {
      const answer = await send(
        url,
        { method: "GET", headers: { Accept: "application/json" } },
        signal,
      );
      if (answer.status === 200) return { url, body: json(answer) };
    }
    throw new Failure("discovery_failed");
  }

  async function discover(
    serverUrl: string,
    signal: AbortSignal,
  ): Promise<{
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string | null;
    authMethods: string[] | null;
    scope: string | null;
  }> {
    const server = new URL(serverUrl);
    // The server names its metadata in the 401 it answers without a token.
    const probe = await send(
      serverUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "isomux", version: "1" },
          },
        }),
      },
      signal,
    );
    const named = /resource_metadata="([^"]+)"/.exec(
      probe.headers.get("www-authenticate") ?? "",
    )?.[1];
    const path = server.pathname === "/" ? "" : server.pathname;
    const resourceCandidates = named
      ? [httpsUrl(named)]
      : [
          ...(path
            ? [`${server.origin}/.well-known/oauth-protected-resource${path}`]
            : []),
          `${server.origin}/.well-known/oauth-protected-resource`,
        ];
    const resource = (await firstMetadata(resourceCandidates, signal)).body;
    if (
      typeof resource.resource !== "string" ||
      !sameResource(resource.resource, serverUrl)
    )
      throw new Failure("resource_mismatch");
    const servers = resource.authorization_servers;
    if (!Array.isArray(servers) || servers.length === 0)
      throw new Failure("discovery_failed");
    const issuer = httpsUrl(servers[0]);
    const issuerUrl = new URL(issuer);
    const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
    const authCandidates = issuerPath
      ? [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
          `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
          `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
        ]
      : [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
          `${issuerUrl.origin}/.well-known/openid-configuration`,
        ];
    const meta = (await firstMetadata(authCandidates, signal)).body;
    // RFC 8414 section 3.3: the issuer is the one the metadata was fetched for.
    if (typeof meta.issuer !== "string" || !sameResource(meta.issuer, issuer))
      throw new Failure("issuer_mismatch");
    const methods = meta.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes("S256"))
      throw new Failure("discovery_failed");
    const scopes = resource.scopes_supported;
    const authMethods = meta.token_endpoint_auth_methods_supported;
    return {
      issuer: meta.issuer,
      authorizationEndpoint: httpsUrl(meta.authorization_endpoint),
      tokenEndpoint: httpsUrl(meta.token_endpoint),
      registrationEndpoint:
        meta.registration_endpoint === undefined
          ? null
          : httpsUrl(meta.registration_endpoint),
      authMethods: Array.isArray(authMethods)
        ? authMethods.filter((m): m is string => typeof m === "string")
        : null,
      scope:
        Array.isArray(scopes) && scopes.every((s) => typeof s === "string")
          ? scopes.join(" ") || null
          : null,
    };
  }

  // Writes a secret the flow owns: rotates it when the registration lists
  // it, creates it when no secret has the name, refuses a member's secret.
  // The registration lists the name before the secret exists, so the
  // secrets runtime never sees it as a plain secret.
  function writeOwnedSecret(
    scope: SecretScope,
    registration: { name: string; url: string },
    oauth: StoredOAuth,
    secretName: string,
    value: string,
  ): void {
    const host = mcpServerHost(registration.url);
    const exists = deps.secrets.list(scope).some((s) => s.name === secretName);
    if (exists && !oauth.ownedSecrets.includes(secretName))
      throw new Failure("secret_exists");
    if (!oauth.ownedSecrets.includes(secretName)) {
      oauth.ownedSecrets = [...oauth.ownedSecrets, secretName];
      if (
        !deps.servers.setOAuth(
          scope,
          registration.name,
          registration.url,
          oauth,
        )
      )
        throw new Failure("changed");
    }
    const change = exists
      ? deps.secrets.rotate(scope, secretName, value)
      : deps.secrets.create(scope, {
          name: secretName,
          value,
          hosts: [host],
          form: { kind: "authorization" },
        });
    if (!change.ok) throw new Failure("unexpected");
  }

  function removeOwnedSecrets(scope: SecretScope, names: string[]): void {
    for (const name of names) deps.secrets.remove(scope, name);
  }

  function readSecret(scope: SecretScope, name: string | null): string | null {
    if (!name) return null;
    return deps.secrets.readSecretValues(scope, name)?.value ?? null;
  }

  // The token request: the client authenticates the way it registered.
  async function tokenRequest(
    scope: SecretScope,
    oauth: StoredOAuth,
    params: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{
    accessToken: string;
    expiresAt: number | null;
    refreshToken: string | null;
  }> {
    if (!oauth.tokenEndpoint || !oauth.clientId)
      throw new Failure("token_refused");
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const clientSecret = readSecret(scope, oauth.clientSecret);
    if (oauth.tokenEndpointAuth === "client_secret_basic" && clientSecret) {
      const user = encodeURIComponent(oauth.clientId);
      const pass = encodeURIComponent(clientSecret);
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    } else {
      body.set("client_id", oauth.clientId);
      if (oauth.tokenEndpointAuth === "client_secret_post" && clientSecret)
        body.set("client_secret", clientSecret);
    }
    const answer = await send(
      oauth.tokenEndpoint,
      { method: "POST", headers, body: body.toString() },
      signal,
    );
    if (answer.status === 400 || answer.status === 401)
      throw new Failure("token_refused");
    if (answer.status !== 200) throw new Failure("unexpected");
    const token = json(answer);
    if (
      typeof token.access_token !== "string" ||
      checkSecretValue(token.access_token) ||
      (token.token_type !== undefined &&
        (typeof token.token_type !== "string" ||
          token.token_type.toLowerCase() !== "bearer"))
    )
      throw new Failure("unexpected");
    const refreshToken =
      typeof token.refresh_token === "string" &&
      !checkSecretValue(token.refresh_token)
        ? token.refresh_token
        : null;
    const expiresIn =
      typeof token.expires_in === "number" && token.expires_in > 0
        ? token.expires_in
        : null;
    return {
      accessToken: token.access_token,
      expiresAt: expiresIn === null ? null : now() + expiresIn * 1000,
      refreshToken,
    };
  }

  async function withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: McpOAuthReason }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return { ok: true, value: await run(controller.signal) };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Failure ? err.reason : "unexpected",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  interface Pending {
    scope: SecretScope;
    name: string;
    url: string;
    userId: string;
    verifier: string;
    redirectUri: string;
    expiresAt: number;
  }
  const pending = new Map<string, Pending>();

  function dropPending(scope: SecretScope, name: string): void {
    const key = oauthTokenKey(scope, name, "");
    for (const [state, flow] of pending)
      if (oauthTokenKey(flow.scope, flow.name, "") === key)
        pending.delete(state);
  }

  // Create, update and delete for every registration: the OAuth record is
  // built here, and the secrets it owns go with it.
  function create(scope: SecretScope, body: Record<string, unknown>) {
    const { oauth: request, ...rest } = body;
    if (request === undefined || request === null)
      return { ok: true as const, change: deps.servers.create(scope, rest) };
    const checked = checkOAuthRequest(request);
    if (!checked.ok || !checked.oauth) return { ok: false as const };
    const oauth = freshOAuth();
    if (checked.oauth.clientId !== null) {
      oauth.clientId = checked.oauth.clientId;
      oauth.pasted = true;
    }
    const change = deps.servers.create(scope, rest, oauth);
    if (!change.ok || !checked.oauth.clientSecret)
      return { ok: true as const, change };
    // The client secret goes in after the registration exists, so a refused
    // create leaves no secret behind.
    const names = oauthSecretNames(change.server.name);
    try {
      writeOwnedSecret(
        scope,
        change.server,
        oauth,
        names.clientSecret,
        checked.oauth.clientSecret,
      );
    } catch {
      deps.servers.remove(scope, change.server.name);
      return {
        ok: true as const,
        change: { ok: false, kind: "secret_exists" } as const,
      };
    }
    oauth.clientSecret = names.clientSecret;
    oauth.tokenEndpointAuth = "client_secret_basic";
    deps.servers.setOAuth(scope, change.server.name, change.server.url, oauth);
    return {
      ok: true as const,
      change: {
        ok: true,
        server: deps.servers
          .list(scope)
          .find((s) => s.name === change.server.name)!,
      } as McpServerChange,
    };
  }

  function update(
    scope: SecretScope,
    name: string,
    body: Record<string, unknown>,
  ):
    | {
        ok: true;
        change: McpServerChange | { ok: false; kind: "secret_exists" };
      }
    | { ok: false } {
    const { oauth: request, ...rest } = body;
    const checked = request === undefined ? null : checkOAuthRequest(request);
    if (checked && !checked.ok) return { ok: false };
    const before = deps.servers.oauthOf(scope, name);
    let dropped: string[] = [];
    let pastedSecret: string | null = null;
    const change = deps.servers.update(
      scope,
      name,
      rest,
      (current, url) => {
        const owned = current?.ownedSecrets ?? [];
        if (checked?.ok) {
          // A new oauth field replaces the whole record; null removes it.
          dropped = owned;
          if (!checked.oauth) return null;
          const next = freshOAuth();
          if (checked.oauth.clientId !== null) {
            next.clientId = checked.oauth.clientId;
            next.pasted = true;
          }
          pastedSecret = checked.oauth.clientSecret;
          return next;
        }
        if (!current) return null;
        if (before && url !== before.url) {
          // Another URL: a new sign-in. A pasted client stays.
          const next = freshOAuth();
          if (current.pasted) {
            next.clientId = current.clientId;
            next.pasted = true;
            next.clientSecret = current.clientSecret;
            next.tokenEndpointAuth = current.tokenEndpointAuth;
            next.ownedSecrets = owned.filter((s) => s === current.clientSecret);
          }
          dropped = owned.filter((s) => !next.ownedSecrets.includes(s));
          return next;
        }
        return current;
        // The secrets go before the registration lets go of them: until then
        // the secrets runtime keeps them from agents (ownedSecrets).
      },
      () => removeOwnedSecrets(scope, dropped),
    );
    if (!change.ok) return { ok: true, change };
    const urlChanged = before !== null && before.url !== change.server.url;
    if (checked?.ok || urlChanged) {
      dropOAuthTokens(scope, name);
      dropPending(scope, name);
    }
    if (pastedSecret) {
      const stored = deps.servers.oauthOf(scope, name);
      if (stored) {
        const names = oauthSecretNames(name);
        try {
          writeOwnedSecret(
            scope,
            { name, url: stored.url },
            stored.oauth,
            names.clientSecret,
            pastedSecret,
          );
        } catch {
          return { ok: true, change: { ok: false, kind: "secret_exists" } };
        }
        stored.oauth.clientSecret = names.clientSecret;
        stored.oauth.tokenEndpointAuth = "client_secret_basic";
        deps.servers.setOAuth(scope, name, stored.url, stored.oauth);
      }
    }
    const server = deps.servers.list(scope).find((s) => s.name === name);
    return { ok: true, change: server ? { ok: true, server } : change };
  }

  function remove(scope: SecretScope, name: string): boolean {
    // The secrets first, as in update.
    const before = deps.servers.oauthOf(scope, name);
    removeOwnedSecrets(scope, before?.oauth.ownedSecrets ?? []);
    if (!deps.servers.remove(scope, name)) return false;
    dropOAuthTokens(scope, name);
    dropPending(scope, name);
    return true;
  }

  // Step 1: discovery, the client, PKCE and state. The URL goes to the
  // member's browser only: it carries no token.
  async function startSignIn(
    scope: SecretScope,
    name: string,
    userId: string,
  ): Promise<
    | { ok: true; authorizationUrl: string }
    | { ok: false; reason: McpOAuthReason }
  > {
    const stored = deps.servers.oauthOf(scope, name);
    if (!stored) {
      const exists = deps.servers.list(scope).some((s) => s.name === name);
      return { ok: false, reason: exists ? "not_oauth" : "not_found" };
    }
    const { url } = stored;
    const redirectUri = deps.redirectUri();
    const result = await withTimeout(async (signal) => {
      const oauth = { ...stored.oauth };
      const found = await discover(url, signal);
      const issuerChanged =
        oauth.issuer !== null && oauth.issuer !== found.issuer;
      oauth.issuer = found.issuer;
      oauth.authorizationEndpoint = found.authorizationEndpoint;
      oauth.tokenEndpoint = found.tokenEndpoint;
      oauth.scope = found.scope;
      if (oauth.pasted) {
        if (oauth.clientSecret)
          oauth.tokenEndpointAuth =
            !found.authMethods ||
            found.authMethods.includes("client_secret_basic")
              ? "client_secret_basic"
              : "client_secret_post";
      } else if (
        !oauth.clientId ||
        oauth.redirectUri !== redirectUri ||
        issuerChanged
      ) {
        if (!found.registrationEndpoint) throw new Failure("client_needed");
        const answer = await send(
          found.registrationEndpoint,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              client_name: "Isomux",
              redirect_uris: [redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          },
          signal,
        );
        if (answer.status === 400) {
          const error = (() => {
            try {
              return json(answer).error;
            } catch {
              return undefined;
            }
          })();
          throw new Failure(
            error === "invalid_redirect_uri"
              ? "redirect_refused"
              : "registration_refused",
          );
        }
        if (answer.status !== 200 && answer.status !== 201)
          throw new Failure("registration_refused");
        const client = json(answer);
        if (
          typeof client.client_id !== "string" ||
          checkOAuthRequest({ clientId: client.client_id }).ok === false
        )
          throw new Failure("unexpected");
        oauth.clientId = client.client_id;
        oauth.redirectUri = redirectUri;
        const names = oauthSecretNames(name);
        if (
          typeof client.client_secret === "string" &&
          !checkSecretValue(client.client_secret)
        ) {
          writeOwnedSecret(
            scope,
            { name, url },
            oauth,
            names.clientSecret,
            client.client_secret,
          );
          oauth.clientSecret = names.clientSecret;
          oauth.tokenEndpointAuth =
            client.token_endpoint_auth_method === "client_secret_post"
              ? "client_secret_post"
              : "client_secret_basic";
        } else {
          if (oauth.ownedSecrets.includes(names.clientSecret)) {
            removeOwnedSecrets(scope, [names.clientSecret]);
            oauth.ownedSecrets = oauth.ownedSecrets.filter(
              (s) => s !== names.clientSecret,
            );
          }
          oauth.clientSecret = null;
          oauth.tokenEndpointAuth = "none";
        }
      }
      if (!deps.servers.setOAuth(scope, name, url, oauth))
        throw new Failure("changed");
      const verifier = randomToken();
      const state = randomToken();
      dropPending(scope, name);
      pending.set(state, {
        scope,
        name,
        url,
        userId,
        verifier,
        redirectUri,
        expiresAt: now() + MCP_OAUTH_PENDING_MS,
      });
      const authorize = new URL(oauth.authorizationEndpoint);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", oauth.clientId!);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("code_challenge", await challengeOf(verifier));
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("resource", url);
      if (oauth.scope) authorize.searchParams.set("scope", oauth.scope);
      return authorize.href;
    });
    return result.ok
      ? { ok: true, authorizationUrl: result.value }
      : { ok: false, reason: result.reason };
  }

  // Step 2, the callback: the member who started the flow brings the code
  // back; Isomux exchanges it and keeps the tokens.
  // `mayUse` re-checks the scope (an office flow: the member is still an
  // owner) before the code is spent.
  async function finishSignIn(
    userId: string,
    query: URLSearchParams,
    mayUse: (scope: SecretScope) => boolean,
  ): Promise<
    | { ok: true; scope: SecretScope; name: string }
    | { ok: false; reason: McpOAuthReason; name?: string }
  > {
    const state = query.get("state") ?? "";
    const flow = pending.get(state);
    if (!flow) return { ok: false, reason: "state_unknown" };
    if (flow.expiresAt <= now()) {
      pending.delete(state);
      return { ok: false, reason: "state_expired", name: flow.name };
    }
    // Another member's browser: the flow stays for the member who started it.
    if (flow.userId !== userId || !mayUse(flow.scope))
      return { ok: false, reason: "wrong_member" };
    pending.delete(state);
    const code = query.get("code");
    if (!code) return { ok: false, reason: "denied", name: flow.name };
    const stored = deps.servers.oauthOf(flow.scope, flow.name);
    if (!stored || stored.url !== flow.url)
      return { ok: false, reason: "changed", name: flow.name };
    const result = await withTimeout(async (signal) => {
      const oauth = { ...stored.oauth };
      const token = await tokenRequest(
        flow.scope,
        oauth,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: flow.redirectUri,
          code_verifier: flow.verifier,
          resource: flow.url,
        },
        signal,
      );
      if (token.refreshToken) {
        const names = oauthSecretNames(flow.name);
        writeOwnedSecret(
          flow.scope,
          flow,
          oauth,
          names.refreshToken,
          token.refreshToken,
        );
        oauth.refreshToken = names.refreshToken;
      } else if (oauth.refreshToken) {
        // No refresh token this time: the old one goes, secret first.
        const old = oauth.refreshToken;
        removeOwnedSecrets(flow.scope, [old]);
        oauth.ownedSecrets = oauth.ownedSecrets.filter((s) => s !== old);
        oauth.refreshToken = null;
      }
      if (!deps.servers.setOAuth(flow.scope, flow.name, flow.url, oauth))
        throw new Failure("changed");
      setOAuthAccessToken(flow.scope, flow.name, flow.url, {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
      });
    });
    return result.ok
      ? { ok: true, scope: flow.scope, name: flow.name }
      : { ok: false, reason: result.reason, name: flow.name };
  }

  const inFlight = new Map<string, Promise<void>>();

  // One refresh per registration at a time. A refusal (400 or 401) means
  // "sign in again"; a network error or another status keeps the token
  // until the next try.
  function refresh(scope: SecretScope, server: McpServerWire): Promise<void> {
    const key = oauthTokenKey(scope, server.name, server.url);
    const running = inFlight.get(key);
    if (running) return running;
    const run = (async () => {
      // A file that does not parse throws; the next tick tries again. The
      // refresher runs from a timer, so nothing may escape it.
      let stored: ReturnType<McpServerStore["oauthOf"]>;
      let refreshToken: string | null;
      try {
        stored = deps.servers.oauthOf(scope, server.name);
        if (!stored || stored.url !== server.url) return;
        refreshToken = readSecret(scope, stored.oauth.refreshToken);
      } catch {
        console.warn(
          `[mcp] ${server.name}: a ${scope.kind} file could not be read; the refresh is tried again`,
        );
        return;
      }
      if (!refreshToken) {
        markOAuthSignInNeeded(scope, server.name);
        return;
      }
      const result = await withTimeout(async (signal) => {
        const oauth = { ...stored.oauth };
        const token = await tokenRequest(
          scope,
          oauth,
          {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            resource: server.url,
          },
          signal,
        );
        if (token.refreshToken && token.refreshToken !== refreshToken)
          writeOwnedSecret(
            scope,
            server,
            oauth,
            oauth.refreshToken!,
            token.refreshToken,
          );
        // The registration moved while the request ran: the token is not
        // for its URL.
        const now = deps.servers.oauthOf(scope, server.name);
        if (!now || now.url !== server.url) throw new Failure("changed");
        setOAuthAccessToken(scope, server.name, server.url, {
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
        });
      });
      if (!result.ok) {
        if (result.reason === "token_refused")
          markOAuthSignInNeeded(scope, server.name);
        else
          console.warn(
            `[mcp] ${server.name}: the access token refresh failed (${result.reason}); it is tried again`,
          );
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  // Every signed-in registration whose token is missing or near its expiry.
  async function refreshDue(): Promise<void> {
    const due: Promise<void>[] = [];
    for (const scope of deps.servers.scopes()) {
      let servers: McpServerWire[];
      try {
        servers = deps.servers.list(scope);
      } catch {
        continue;
      }
      for (const server of servers) {
        if (!server.oauth?.signedIn || oauthSignInNeeded(scope, server.name))
          continue;
        const expiresAt = oauthTokenExpiry(scope, server.name, server.url);
        if (expiresAt === null) continue;
        if (
          expiresAt === undefined ||
          expiresAt - now() < MCP_OAUTH_REFRESH_MARGIN_MS
        )
          due.push(refresh(scope, server));
      }
    }
    await Promise.all(due);
  }

  return {
    create,
    update,
    remove,
    startSignIn,
    finishSignIn,
    refresh,
    refreshDue,
  };
}

export type McpOAuth = ReturnType<typeof createMcpOAuth>;
