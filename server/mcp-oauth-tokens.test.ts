// The access token cache: a removed member's scope goes, and only theirs.

import { afterEach, describe, expect, it } from "bun:test";

import {
  dropOAuthTokensOfScope,
  markOAuthSignInNeeded,
  oauthAccessToken,
  oauthSignInNeeded,
  resetOAuthTokens,
  setOAuthAccessToken,
} from "./mcp-oauth-tokens.ts";
import type { SecretScope } from "./secret-store.ts";

const URL = "https://mcp.example.com/mcp";
const MIA: SecretScope = { kind: "user", userId: "u-mia" };
// An id that starts with Mia's.
const MIAB: SecretScope = { kind: "user", userId: "u-miab" };
const OFFICE: SecretScope = { kind: "office" };

afterEach(resetOAuthTokens);

describe("dropOAuthTokensOfScope", () => {
  it("drops the scope's tokens and sign-in marks, and keeps the other scopes'", () => {
    for (const scope of [MIA, MIAB, OFFICE])
      setOAuthAccessToken(scope, "linear", URL, {
        accessToken: `fake-token-${JSON.stringify(scope)}`,
        expiresAt: null,
      });
    markOAuthSignInNeeded(MIA, "notion");
    markOAuthSignInNeeded(MIAB, "notion");

    dropOAuthTokensOfScope(MIA);

    expect(oauthAccessToken(MIA, "linear", URL)).toBeNull();
    expect(oauthSignInNeeded(MIA, "notion")).toBe(false);
    expect(oauthAccessToken(MIAB, "linear", URL)).not.toBeNull();
    expect(oauthSignInNeeded(MIAB, "notion")).toBe(true);
    expect(oauthAccessToken(OFFICE, "linear", URL)).not.toBeNull();
  });
});
