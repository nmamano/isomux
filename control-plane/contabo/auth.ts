// OAuth2 password grant against Contabo's Keycloak realm.
//
// Credentials arrive as ordinary environment variables. This file never reads
// ~/nil/secrets/contabo.env, or any other path: sourcing that file is the
// caller's job, so the secret has exactly one home and this code has no opinion
// about where it lives. Nothing here logs a credential or a token, including on
// the failure paths - an auth failure reports the HTTP status and nothing else,
// because the response body of a failed grant can echo the request.

/** The subset of `fetch` this module needs, so tests can inject a transport. */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const CONTABO_AUTH_URL =
  "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";

export interface ContaboCredentials {
  clientId: string;
  clientSecret: string;
  apiUser: string;
  apiPassword: string;
}

const ENV_KEYS = [
  "CONTABO_CLIENT_ID",
  "CONTABO_CLIENT_SECRET",
  "CONTABO_API_USER",
  "CONTABO_API_PASSWORD",
] as const;

/**
 * Read the four credentials from the environment.
 *
 * Reports which NAMES are missing, never any value or fragment of one - a
 * diagnostic that quotes part of a secret to prove it was read is how secrets
 * end up in transcripts.
 */
export function credentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ContaboCredentials {
  const missing = ENV_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Contabo credentials missing from the environment: ${missing.join(", ")}. ` +
        `Source the credentials file in your shell before running this.`,
    );
  }
  return {
    clientId: env.CONTABO_CLIENT_ID!,
    clientSecret: env.CONTABO_CLIENT_SECRET!,
    apiUser: env.CONTABO_API_USER!,
    apiPassword: env.CONTABO_API_PASSWORD!,
  };
}

/** Seconds shaved off a token's stated lifetime, so a token never expires
 * mid-flight on a slow call. */
const EXPIRY_SLACK_S = 30;

export class TokenProvider {
  private cached: { token: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly creds: ContaboCredentials,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs) {
      return this.cached.token;
    }
    const body = new URLSearchParams({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      username: this.creds.apiUser,
      password: this.creds.apiPassword,
      grant_type: "password",
    });
    const res = await this.fetchImpl(CONTABO_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      // Deliberately status-only. See the file header.
      throw new Error(`Contabo auth failed with HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!parsed.access_token) {
      throw new Error("Contabo auth returned no access token");
    }
    const lifetimeS = Math.max(0, (parsed.expires_in ?? 0) - EXPIRY_SLACK_S);
    this.cached = {
      token: parsed.access_token,
      expiresAtMs: this.now() + lifetimeS * 1000,
    };
    return parsed.access_token;
  }
}
