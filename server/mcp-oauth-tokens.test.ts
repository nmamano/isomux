// The access token cache: a removed member's scope goes, and only theirs;
// each change reaches the secret proxy once, when complete (GitHub #77).

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import {
  dropOAuthTokens,
  dropOAuthTokensOfScope,
  listOAuthAccessTokens,
  markOAuthSignInNeeded,
  onOAuthTokensChanged,
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

// What a listener sees of the cache when it is told.
function cacheNow(): string[] {
  return listOAuthAccessTokens().map(
    (token) =>
      `${token.scope.kind === "office" ? "office" : token.scope.userId}/${token.name}/${token.accessToken}`,
  );
}

describe("onOAuthTokensChanged", () => {
  it("tells a listener once per change, after the change is complete, until it unsubscribes", () => {
    const seen: string[][] = [];
    const off = onOAuthTokensChanged(() => seen.push(cacheNow()));
    const token = (accessToken: string) => ({ accessToken, expiresAt: null });
    setOAuthAccessToken(MIA, "linear", URL, token("fake-1"));
    // A renewal: one call, and it already sees the new token.
    setOAuthAccessToken(MIA, "linear", URL, token("fake-2"));
    markOAuthSignInNeeded(MIA, "linear");
    setOAuthAccessToken(OFFICE, "linear", URL, token("fake-3"));
    dropOAuthTokens(OFFICE, "linear");
    setOAuthAccessToken(MIA, "notion", URL, token("fake-4"));
    // A removed member.
    dropOAuthTokensOfScope(MIA);
    expect(seen).toEqual([
      ["u-mia/linear/fake-1"],
      ["u-mia/linear/fake-2"],
      [],
      ["office/linear/fake-3"],
      [],
      ["u-mia/notion/fake-4"],
      [],
    ]);
    off();
    setOAuthAccessToken(MIA, "linear", URL, token("fake-5"));
    expect(seen).toHaveLength(7);
  });

  it("finishes the change and tells the next listener when one listener throws", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[][] = [];
    const offThrow = onOAuthTokensChanged(() => {
      throw new Error("listener failed");
    });
    const off = onOAuthTokensChanged(() => seen.push(cacheNow()));
    try {
      setOAuthAccessToken(MIA, "linear", URL, {
        accessToken: "fake-1",
        expiresAt: null,
      });
      expect(oauthAccessToken(MIA, "linear", URL)).toBe("fake-1");
      expect(seen).toEqual([["u-mia/linear/fake-1"]]);
    } finally {
      offThrow();
      off();
      warn.mockRestore();
    }
  });
});

describe("listOAuthAccessTokens", () => {
  it("lists each cached token with its scope, name and URL, an expired one too", () => {
    const at = Date.now();
    setOAuthAccessToken(OFFICE, "harness", "https://mcp.harness.example/mcp", {
      accessToken: "fake-office-token",
      expiresAt: at + 60_000,
    });
    setOAuthAccessToken(MIA, "mail", URL, {
      accessToken: "fake-member-token",
      expiresAt: null,
    });
    // Expired, and its refresh not done yet: it stays until a change drops
    // it, so the proxy set never moves with the clock alone.
    setOAuthAccessToken(MIA, "stale", URL, {
      accessToken: "fake-stale-token",
      expiresAt: at - 1,
    });
    expect(oauthAccessToken(MIA, "stale", URL)).toBeNull();
    expect(listOAuthAccessTokens()).toEqual([
      {
        scope: OFFICE,
        name: "harness",
        url: "https://mcp.harness.example/mcp",
        accessToken: "fake-office-token",
      },
      { scope: MIA, name: "mail", url: URL, accessToken: "fake-member-token" },
      { scope: MIA, name: "stale", url: URL, accessToken: "fake-stale-token" },
    ]);
  });
});
