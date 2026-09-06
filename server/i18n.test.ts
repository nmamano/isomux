// The server's language resolution (server/i18n.ts): which language the server
// writes in for a given actor. See internal-docs/i18n-loop.md, S7.
//
// The oracle is a LITERAL translated string, never text read back through the
// translator (ruling 14), so a resolver that silently returned English could
// not pass its own test.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  translatorForLanguage,
  translatorForUsername,
  translatorForUserId,
  translatorForRequest,
  english,
} from "./i18n.ts";
import type { Identity } from "./identity/index.ts";
import { _testResetUsers, claimUser, updateUserById } from "./users.ts";

// "Conversation cleared." in each language - a key S7 added, so it exercises
// the new catalog rather than an older slice's.
const EN = "Conversation cleared.";
const ES = "Conversación borrada.";
const CA = "Conversa esborrada.";
const KEY = "systemEntries.conversationCleared" as const;

function seed(name: string, language: "en" | "es" | "ca" | null): string {
  const user = claimUser(name);
  updateUserById(user.id, { language });
  return user.id;
}

beforeEach(() => {
  _testResetUsers();
});

describe("translatorForLanguage", () => {
  it("writes in the language it is given", () => {
    expect(translatorForLanguage("es").t(KEY)).toBe(ES);
    expect(translatorForLanguage("ca").t(KEY)).toBe(CA);
    expect(translatorForLanguage("en").t(KEY)).toBe(EN);
  });

  it("treats a never-chosen preference as English", () => {
    // null is "never chosen", not "chosen English": the server cannot see a
    // browser language, so both read English here.
    expect(translatorForLanguage(null).t(KEY)).toBe(EN);
    expect(translatorForLanguage(undefined).t(KEY)).toBe(EN);
    expect(english.t(KEY)).toBe(EN);
  });
});

describe("translatorForUsername - the chat path", () => {
  it("uses the stored preference of the user who typed the command", () => {
    seed("Ana", "es");
    seed("Jordi", "ca");
    expect(translatorForUsername("Ana").t(KEY)).toBe(ES);
    expect(translatorForUsername("Jordi").t(KEY)).toBe(CA);
  });

  it("resolves the name case-insensitively, as the rest of the server does", () => {
    seed("Ana", "es");
    expect(translatorForUsername("ana").t(KEY)).toBe(ES);
  });

  it("falls back to English for a user who never chose one", () => {
    seed("Sam", null);
    expect(translatorForUsername("Sam").t(KEY)).toBe(EN);
  });

  it("falls back to English for an unknown or absent sender", () => {
    // The absent case is how an agent reaches this: an inter-agent message is
    // enqueued with a structured sender and carries no username, so nothing
    // the server writes for it is ever localized.
    expect(translatorForUsername("Nobody").t(KEY)).toBe(EN);
    expect(translatorForUsername(undefined).t(KEY)).toBe(EN);
    expect(translatorForUsername(null).t(KEY)).toBe(EN);
    expect(translatorForUsername("").t(KEY)).toBe(EN);
  });
});

describe("translatorForUserId - the actorless fallback", () => {
  it("uses the owner's preference when no actor is in scope", () => {
    const id = seed("Ana", "es");
    expect(translatorForUserId(id).t(KEY)).toBe(ES);
  });

  it("falls back to English for an unowned agent or an id that is not a user", () => {
    seed("Ana", "es");
    // An AGENT id, not a user id. Only a user record carries a language, so a
    // non-user id must not pick one up.
    expect(translatorForUserId("agent-1774696998326-2e6u").t(KEY)).toBe(EN);
    expect(translatorForUserId(null).t(KEY)).toBe(EN);
    expect(translatorForUserId(undefined).t(KEY)).toBe(EN);
  });
});

describe("interpolation survives resolution", () => {
  it("fills a placeholder in the resolved language", () => {
    seed("Ana", "es");
    expect(
      translatorForUsername("Ana").t("systemEntries.resumedSession", {
        label: "topic",
      }),
    ).toBe("Sesión retomada: topic");
    expect(
      translatorForUsername("Nobody").t("systemEntries.resumedSession", {
        label: "topic",
      }),
    ).toBe("Resumed session: topic");
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
    expect(translatorForRequest(null, "es;q=0.8, ca;q=0.9").t(KEY)).toBe(CA);
    expect(translatorForRequest(null, "fr").t(KEY)).toBe(EN);
    expect(translatorForRequest(null, null).t(KEY)).toBe(EN);
  });
});
