// The access tokens of OAuth MCP servers (integrations loop, slice A2b), in
// memory only: the refresh token is the stored secret, and a restart gets a
// new access token from it. One cache for the process, because the agents'
// headers (server/mcp-servers.ts) and the flow (server/mcp-oauth.ts) read it
// through separate store instances.
//
// A token is keyed by scope, name and server URL: a token issued for one URL
// is never sent to another, even after an update moves the registration.

import type { SecretScope } from "./secret-store.ts";

interface CachedToken {
  accessToken: string;
  // Epoch ms; null when the authorization server gave no expiry.
  expiresAt: number | null;
}

const tokens = new Map<string, CachedToken>();
// Registrations whose authorization server refused the refresh token.
const signInNeeded = new Set<string>();

function scopeKey(scope: SecretScope): string {
  return scope.kind === "office" ? "office" : `user:${scope.userId}`;
}

export function oauthTokenKey(
  scope: SecretScope,
  name: string,
  url: string,
): string {
  return `${scopeKey(scope)}\n${name}\n${url}`;
}

function registrationPrefix(scope: SecretScope, name: string): string {
  return `${scopeKey(scope)}\n${name}\n`;
}

// The access token, or null when there is none for this URL or it expired.
export function oauthAccessToken(
  scope: SecretScope,
  name: string,
  url: string,
  now: number = Date.now(),
): string | null {
  const cached = tokens.get(oauthTokenKey(scope, name, url));
  if (!cached) return null;
  if (cached.expiresAt !== null && cached.expiresAt <= now) return null;
  return cached.accessToken;
}

export function oauthTokenExpiry(
  scope: SecretScope,
  name: string,
  url: string,
): number | null | undefined {
  return tokens.get(oauthTokenKey(scope, name, url))?.expiresAt;
}

export function setOAuthAccessToken(
  scope: SecretScope,
  name: string,
  url: string,
  token: CachedToken,
): void {
  dropOAuthTokens(scope, name);
  tokens.set(oauthTokenKey(scope, name, url), token);
}

export function markOAuthSignInNeeded(scope: SecretScope, name: string): void {
  dropOAuthTokens(scope, name);
  signInNeeded.add(registrationPrefix(scope, name));
}

export function oauthSignInNeeded(scope: SecretScope, name: string): boolean {
  return signInNeeded.has(registrationPrefix(scope, name));
}

// Every token of a registration, whatever its URL, and its sign-in mark.
export function dropOAuthTokens(scope: SecretScope, name: string): void {
  const prefix = registrationPrefix(scope, name);
  for (const key of tokens.keys())
    if (key.startsWith(prefix)) tokens.delete(key);
  signInNeeded.delete(prefix);
}

// Every token and sign-in mark of a scope: the member left the office.
export function dropOAuthTokensOfScope(scope: SecretScope): void {
  const prefix = `${scopeKey(scope)}\n`;
  for (const key of tokens.keys())
    if (key.startsWith(prefix)) tokens.delete(key);
  for (const key of signInNeeded)
    if (key.startsWith(prefix)) signInNeeded.delete(key);
}

// Tests only.
export function resetOAuthTokens(): void {
  tokens.clear();
  signInNeeded.clear();
}
