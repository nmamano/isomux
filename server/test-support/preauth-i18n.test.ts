// The pre-sign-in pages in three languages (internal-docs/i18n-loop.md, S9).
//
// A visitor who has not signed in yet has no stored preference, so these pages
// read the Accept-Language header; the two pages that CAN know their reader
// (the invite-for-someone-else refusal and the sign-out refusal) read that
// reader's stored preference instead, header or no header.
//
// No assertion pins translated copy (internal-docs/testing-guide.md, principle
// 15). Each page is rendered on English too, and each text element (title,
// heading, paragraph, label, button) must differ from the same element of the
// English page; `slot` fails closed when the element is missing or empty. Only
// the escaping claims read a catalog value, after proving it differs from
// English, because their claim is what one key's text became.
//
// Seam: startTestServer() - the real boot path and the real /auth routes.

import { mintMemberLink } from "./member-link.ts";
import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { _testMintLegacyInvite } from "../auth.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// A browser asks for HTML; without this the auth wall answers JSON.
const HTML_ACCEPT = { Accept: "text/html" };

type Init = RequestInit & { rawSessionId?: string };

/** GET a page the way a browser on `language` would. `null` sends no header. */
async function page(
  srv: TestServer,
  path: string,
  language: string | null,
  init: Init = {},
): Promise<{ status: number; html: string }> {
  const headers: Record<string, string> = { ...HTML_ACCEPT };
  if (language) headers["Accept-Language"] = language;
  const res = await srv.http(path, { ...init, headers });
  return { status: res.status, html: await res.text() };
}

async function bootstrapInviteToken(): Promise<string> {
  const mint = await _testMintLegacyInvite({
    username: null,
    role: "owner",
    bootstrap: true,
  });
  return mint.rawToken;
}

async function inviteTokenFor(username: string): Promise<string> {
  return (await mintMemberLink(username)).rawToken;
}

function setLanguage(username: string, language: "es" | "ca" | null): void {
  const user = getUserByName(username);
  if (!user) throw new Error(`no user record for ${username}`);
  const result = updateUserById(user.id, { language });
  if (!result.ok) throw new Error(`could not set language: ${result.error}`);
}

// The text elements a page is compared on, each found by its markup.
const TITLE = /<title>([^<]*)<\/title>/u;
const DESCRIPTION = /<meta property="og:description" content="([^"]*)"/u;
const H1 = /<h1>([^<]*)<\/h1>/u;
const INTRO = /<\/h1>\s*<p>([^<]*)<\/p>/u;
const NAME_LABEL = /<label>([^<]*)<input name="name"/u;
const BUTTON = /<button[^>]*>([^<]*)<\/button>/u;
const ERROR = /<p class="err">([^<]*)<\/p>/u;
const RETURN_LINK = /<a href="\/">([^<]*)<\/a>/u;

/** The text of one element; fails when the page does not have it. */
function slot(html: string, pattern: RegExp): string {
  const text = html.match(pattern)?.[1] ?? "";
  expect({ pattern: String(pattern), present: text.trim().length > 0 }).toEqual(
    { pattern: String(pattern), present: true },
  );
  return text;
}

/** The text of every <p> inside the page body, in order. */
function paragraphs(html: string): string[] {
  const body = html.slice(html.indexOf("<body>"));
  return [...body.matchAll(/<p[^>]*>(.*?)<\/p>/gsu)].map((m) => m[1]);
}

/** Each named element differs from the same element of the English page. */
function expectTranslated(
  local: string,
  english: string,
  patterns: RegExp[],
): void {
  for (const pattern of patterns)
    expect({
      pattern: String(pattern),
      text: slot(local, pattern),
    }).not.toEqual({ pattern: String(pattern), text: slot(english, pattern) });
}

/** Each named element is the same as on the English page. */
function expectSame(html: string, english: string, patterns: RegExp[]): void {
  for (const pattern of patterns)
    expect({ pattern: String(pattern), text: slot(html, pattern) }).toEqual({
      pattern: String(pattern),
      text: slot(english, pattern),
    });
}

// The four header cases the slice owes, per page.
const HEADERS: Array<[label: string, header: string | null, lang: string]> = [
  ["Spanish", "es", "es"],
  ["Catalan", "ca", "ca"],
  ["English", "en", "en"],
  ["no header", null, "en"],
];

describe("the first-time claim page", () => {
  it("reads in the browser's language, and says so in the document", async () => {
    server = await startTestServer();
    const seen: Record<string, string> = {};
    for (const [label, header, lang] of HEADERS) {
      const { status, html } = await page(server, "/", header);
      expect({ label, status }).toEqual({ label, status: 200 });
      expect({ label, lang: html.includes(`<html lang="${lang}">`) }).toEqual({
        label,
        lang: true,
      });
      // The form itself is the same markup in every language.
      expect(html).toContain(
        '<input name="name" type="text" autofocus maxlength="64" required',
      );
      seen[label] = html;
    }
    const elements = [TITLE, H1, INTRO, NAME_LABEL, BUTTON];
    expectTranslated(seen.Spanish, seen.English, elements);
    expectTranslated(seen.Catalan, seen.English, elements);
    expectTranslated(seen.Catalan, seen.Spanish, elements);
    expectSame(seen["no header"], seen.English, elements);
  });

  it("answers a bad display name in the language the form was read in", async () => {
    server = await startTestServer();
    const claim = async (language: string) => {
      const res = await server!.http("/auth/claim", {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html",
          "Accept-Language": language,
        },
        body: `name=&key=${encodeURIComponent(server!.setupKey())}`,
      });
      expect(res.status).toBe(400);
      return res.text();
    };
    const en = await claim("en");
    const ca = await claim("ca");
    expect(ca).toContain('<html lang="ca">');
    expectTranslated(ca, en, [ERROR]);
  });
});

describe("the invite-accept page", () => {
  it("reads in the browser's language on a bootstrap invite", async () => {
    server = await startTestServer();
    const token = await bootstrapInviteToken();
    const seen: Record<string, string> = {};
    const intros: Record<string, { invite: string; claim: string }> = {};
    for (const [label, header, lang] of HEADERS) {
      const { status, html } = await page(server, `/i/${token}`, header);
      expect({ label, status }).toEqual({ label, status: 200 });
      expect({ label, lang: html.includes(`<html lang="${lang}">`) }).toEqual({
        label,
        lang: true,
      });
      seen[label] = html;
      // No owner yet, so / is the claim page in the same language.
      const claim = await page(server, "/", header);
      intros[label] = {
        invite: slot(html, INTRO),
        claim: slot(claim.html, INTRO),
      };
    }
    // The bootstrap invite and the claim page greet the same first owner
    // with one intro, in every language.
    for (const [label] of HEADERS)
      expect({ label, invite: intros[label].invite }).toEqual({
        label,
        invite: intros[label].claim,
      });
    // ...and it is translated, not English on every page.
    const elements = [TITLE, DESCRIPTION, H1, INTRO, BUTTON];
    expectTranslated(seen.Spanish, seen.English, elements);
    expectTranslated(seen.Catalan, seen.English, elements);
    expectTranslated(seen.Catalan, seen.Spanish, elements);
    expectSame(seen["no header"], seen.English, elements);
  });

  it("reads in the browser's language on a named invite", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const token = await inviteTokenFor("Yu");
    const seen: Record<string, string> = {};
    for (const [label, header, lang] of HEADERS) {
      const { status, html } = await page(server, `/i/${token}`, header);
      expect({ label, status }).toEqual({ label, status: 200 });
      expect({ label, lang: html.includes(`<html lang="${lang}">`) }).toEqual({
        label,
        lang: true,
      });
      seen[label] = html;
    }
    const elements = [TITLE, DESCRIPTION, H1, INTRO, BUTTON];
    expectTranslated(seen.Spanish, seen.English, elements);
    expectTranslated(seen.Catalan, seen.English, elements);
    expectSame(seen["no header"], seen.English, elements);
  });
});

describe("the login page", () => {
  it("reads in the browser's language for a visitor with no session", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const seen: Record<string, string> = {};
    for (const [label, header, lang] of HEADERS) {
      const { status, html } = await page(server, "/", header);
      expect({ label, status }).toEqual({ label, status: 401 });
      expect({ label, lang: html.includes(`<html lang="${lang}">`) }).toEqual({
        label,
        lang: true,
      });
      seen[label] = html;
    }
    // Every paragraph of the card, one by one.
    const en = paragraphs(seen.English);
    expect(en.length).toBeGreaterThan(0);
    expect(en.every((text) => text.trim().length > 0)).toBe(true);
    for (const label of ["Spanish", "Catalan"]) {
      const local = paragraphs(seen[label]);
      expect(local.length).toBe(en.length);
      for (const [index, text] of local.entries())
        expect({ label, index, text }).not.toEqual({
          label,
          index,
          text: en[index],
        });
    }
    expect(paragraphs(seen["no header"])).toEqual(en);
    expectTranslated(seen.Catalan, seen.English, [TITLE]);
  });

  it("keeps the pre-claim branch's link and command intact in every language", async () => {
    // No owner yet, so the login page takes its other branch. The anchor and
    // the <code> span are placeholders filled at the call site (ruling 19).
    server = await startTestServer();
    const { html: en } = await page(server, "/nope", "en");
    const { html: ca } = await page(server, "/nope", "ca");
    for (const html of [en, ca]) expect(html).toContain("<code>ssh -L</code>");
    expectTranslated(ca, en, [RETURN_LINK]);
    // Nothing on this branch goes through escapeHtml, so an apostrophe in the
    // Catalan link text stays an apostrophe, exactly like the English
    // possessive.
    const key = "preAuth.login.claimHereLink";
    const catalan = translatorFor("ca").t(key);
    expect(catalan).not.toBe(translatorFor("en").t(key));
    expect(catalan).toContain("'");
    expect(slot(ca, RETURN_LINK)).toBe(catalan);
  });
});

describe("the invite-error page", () => {
  it("reads in the browser's language", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const { status, html: ca } = await page(server, "/i/nosuchtoken", "ca");
    expect(status).toBe(410);
    expect(ca).toContain('<html lang="ca">');
    const { html: en } = await page(server, "/i/nosuchtoken", "en");
    expectTranslated(ca, en, [H1, INTRO]);
  });
});

describe("a page that knows its reader", () => {
  // Morgan is signed in and Yu's invite is open. `refusal` is the page Morgan
  // gets on it, with Morgan on `language` and the browser asking for `header`.
  async function seedConflict(): Promise<
    (language: "es" | null, header: string) => Promise<string>
  > {
    const morgan = await server!.seedOwner("Morgan");
    const token = await inviteTokenFor("Yu");
    return async (language, header) => {
      setLanguage("Morgan", language);
      const { status, html } = await page(server!, `/i/${token}`, header, {
        rawSessionId: morgan.rawSessionId,
      });
      expect(status).toBe(409);
      return html;
    };
  }

  it("gives a signed-in Spanish user Spanish, whatever the browser asks for", async () => {
    // Ruling 8's precedence, on the one pre-sign-in page that can identify its
    // reader: Morgan is signed in and stored on Spanish, the browser says
    // English, and the invite belongs to someone else.
    server = await startTestServer();
    const refusal = await seedConflict();
    const en = await refusal(null, "en");
    const es = await refusal("es", "en");
    expect(es).toContain('<html lang="es">');
    expectTranslated(es, en, [H1, INTRO, RETURN_LINK]);
    // Both names reach the sentence in every language.
    for (const html of [en, es]) {
      expect(slot(html, INTRO)).toContain("Morgan");
      expect(slot(html, INTRO)).toContain("Yu");
    }
  });

  it("leaves a signed-in user with no stored preference in English", async () => {
    // "Never chosen" is English on the server (S7), and a Spanish header does
    // not override a reader we know.
    server = await startTestServer();
    const refusal = await seedConflict();
    const en = await refusal(null, "en");
    const withHeader = await refusal(null, "es");
    expect(withHeader).toContain('<html lang="en">');
    expectSame(withHeader, en, [H1, INTRO, RETURN_LINK]);
  });

  it("still escapes the names it writes into the sentence", async () => {
    // The sentence moved into the catalog and the names did not: an
    // apostrophe in a display name must still arrive as an entity, exactly as
    // it did when the whole composed sentence went through escapeHtml.
    server = await startTestServer();
    const morgan = await server.seedOwner("O'Morgan");
    const token = await inviteTokenFor("O'Hara");
    const { status, html } = await page(server, `/i/${token}`, "en", {
      rawSessionId: morgan.rawSessionId,
    });
    expect(status).toBe(409);
    // One assertion per slot: the sentence takes two names and each is
    // escaped on its own, so dropping either escape has to fail here.
    expect(html).toContain("O&#39;Morgan");
    expect(html).not.toContain("O'Morgan");
    expect(html).toContain("O&#39;Hara");
    expect(html).not.toContain("O'Hara");
  });

  it("refuses the last owner's sign-out in that owner's language", async () => {
    server = await startTestServer();
    const morgan = await server.seedOwner("Morgan");
    const logout = async (language: "ca" | null) => {
      setLanguage("Morgan", language);
      const res = await server!.http("/auth/logout", {
        method: "POST",
        redirect: "manual",
        headers: { Accept: "text/html", "Accept-Language": "en" },
        rawSessionId: morgan.rawSessionId,
      });
      expect(res.status).toBe(409);
      return res.text();
    };
    const en = await logout(null);
    const ca = await logout("ca");
    expect(ca).toContain('<html lang="ca">');
    expectTranslated(ca, en, [TITLE, H1, INTRO, RETURN_LINK]);
    // The refusal sentence goes through escapeHtml as it always has; the link
    // text is written into the template unescaped.
    const ca_ = translatorFor("ca").t;
    const en_ = translatorFor("en").t;
    const refusal = ca_("preAuth.signOutBlocked.lastOwnerSession");
    const link = ca_("common.returnToOffice");
    expect(refusal).not.toBe(en_("preAuth.signOutBlocked.lastOwnerSession"));
    expect(link).not.toBe(en_("common.returnToOffice"));
    expect(refusal).toContain("'");
    expect(link).toContain("'");
    expect(slot(ca, INTRO)).toBe(refusal.replaceAll("'", "&#39;"));
    expect(slot(ca, RETURN_LINK)).toBe(link);
  });
});
