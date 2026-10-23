// The server's language resolution (server/i18n.ts): which language the server
// writes in for a given actor. See internal-docs/i18n-loop.md, S7.
//
// The claim is which language was picked, so the expectation is the catalog
// value of KEY in that language (internal-docs/testing-guide.md, principle 15
// and its one exception). The up-front test proves KEY's values are pairwise
// distinct across the shipped languages, so a resolver that returned English,
// or any other wrong language, fails.

import { describe, it, expect, beforeEach } from "bun:test";
import { translatorForUserId, translatorForRequest } from "./i18n.ts";
import type { Identity } from "./identity/index.ts";
import { _testResetUsers, claimUser, updateUserById } from "./users.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import { SUPPORTED_LANGUAGES } from "../shared/languages.ts";

// A key S7 added, so it exercises the new catalog rather than an older slice's.
const KEY = "systemEntries.resumeCancelled" as const;
const EN = translatorFor("en").t(KEY);
const ES = translatorFor("es").t(KEY);

it("tells every shipped language apart by KEY", () => {
  const values = SUPPORTED_LANGUAGES.map(({ code }) =>
    translatorFor(code).t(KEY),
  );
  expect(values.every((value) => value.length > 0 && value !== KEY)).toBe(true);
  expect(new Set(values).size).toBe(SUPPORTED_LANGUAGES.length);
});

function seed(name: string, language: "es" | null): string {
  const user = claimUser(name);
  updateUserById(user.id, { language });
  return user.id;
}

beforeEach(() => {
  _testResetUsers();
});

describe("translatorForUserId - a delivery to one user", () => {
  it("uses the recipient's stored preference", () => {
    const id = seed("Ana", "es");
    expect(translatorForUserId(id).t(KEY)).toBe(ES);
  });

  it("falls back to English for no id or an id that is not a user", () => {
    seed("Ana", "es");
    // An AGENT id, not a user id. Only a user record carries a language, so a
    // non-user id must not pick one up.
    expect(translatorForUserId("agent-1774696998326-2e6u").t(KEY)).toBe(EN);
    expect(translatorForUserId(null).t(KEY)).toBe(EN);
    expect(translatorForUserId(undefined).t(KEY)).toBe(EN);
  });
});

// A caller identity as the gating layer hands one over. Capabilities are
// irrelevant here - this resolver reads scope and userId only.
function identity(scope: Identity["scope"], userId: string | null): Identity {
  return { scope, userId, role: "owner", capabilities: [] };
}

describe("translatorForRequest - the pre-sign-in pages", () => {
  it("gives a reader we know their stored preference, header or no header", () => {
    const id = seed("Ana", "es");
    expect(translatorForRequest(identity("user", id), "en").t(KEY)).toBe(ES);
    expect(translatorForRequest(identity("user", id), null).t(KEY)).toBe(ES);
    // A human's own API token is that human reading, not a machine.
    expect(translatorForRequest(identity("api", id), "en").t(KEY)).toBe(ES);
  });

  it("leaves a reader who never chose one in English, whatever the browser says", () => {
    const id = seed("Sam", null);
    expect(translatorForRequest(identity("user", id), "es").t(KEY)).toBe(EN);
  });

  it("writes English for a machine, even one whose owner reads Spanish", () => {
    // An agent bearer can fetch an invite page. It must not pick up the
    // owner's language through the userId its identity carries (ruling 2).
    const id = seed("Ana", "es");
    expect(translatorForRequest(identity("agent", id), "es").t(KEY)).toBe(EN);
    expect(translatorForRequest(identity("cron-run", id), "ca").t(KEY)).toBe(
      EN,
    );
    expect(translatorForRequest(identity("app", id), "ca").t(KEY)).toBe(EN);
  });

  it("negotiates from the header for a visitor with no identity", () => {
    expect(translatorForRequest(null, "es-ES,es;q=0.9").t(KEY)).toBe(ES);
    expect(translatorForRequest(null, "fr").t(KEY)).toBe(EN);
  });
});
