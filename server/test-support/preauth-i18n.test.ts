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
import { ownerLoginCommand } from "../admin-cli.ts";
import { ADMIN_SOCKET_PATH } from "../config.ts";
import { Window, type Element as PageElement } from "happy-dom";
import { runInContext, type Context } from "node:vm";

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
  const headers: Record<string, string> = {
    ...HTML_ACCEPT,
    ...(init.headers as Record<string, string> | undefined),
  };
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
    expectTranslated(seen.Catalan, seen.Spanish, elements);
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
  });
});

// The owner-recovery step on the sign-in page (task 6e4a9789): every agent on
// the box reaches loopback too, so the page only shows the root command that
// mints an owner sign-in link; it never signs anyone in.
describe("the login page's owner-recovery command", () => {
  const OFF_BOX = { "X-Forwarded-For": "203.0.113.9" };

  /** The text of each <code> element, with the HTML entities decoded. */
  function codeTexts(html: string): { raw: string; text: string }[] {
    const body = html.slice(html.indexOf("<body>"));
    return [...body.matchAll(/<code>(.*?)<\/code>/gsu)].map((m) => ({
      raw: m[1],
      text: m[1]
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&amp;", "&"),
    }));
  }

  /** The <code> elements that hold an owner-login command for this office. */
  function ownerCommands(html: string): { raw: string; text: string }[] {
    return codeTexts(html).filter(({ text }) => {
      const data = /--data '(.*)'$/su.exec(text)?.[1];
      if (data === undefined) return false;
      const name = (
        JSON.parse(data.replaceAll(`'\\''`, "'")) as {
          name: string;
        }
      ).name;
      return text === ownerLoginCommand(name, ADMIN_SOCKET_PATH);
    });
  }

  it("shows an on-box visitor the command with this office's socket path, escaped, in every language", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    for (const [label, header] of HEADERS) {
      const { status, html } = await page(server, "/", header);
      expect({ label, status }).toEqual({ label, status: 401 });
      const found = ownerCommands(html);
      expect({ label, count: found.length }).toEqual({ label, count: 1 });
      // The command holds quotes and a placeholder in angle brackets: each
      // reaches the page as an entity, never as markup.
      expect({ label, raw: /[<>"']/u.test(found[0].raw) }).toEqual({
        label,
        raw: false,
      });
    }
  });

  const windows: Window[] = [];
  afterEach(async () => {
    for (const window of windows.splice(0)) await window.happyDOM.close();
  });

  const SCRIPT = /<script>([\s\S]*?)<\/script>/gu;

  /** The source of each inline script on the page, in order. */
  function scripts(html: string): string[] {
    return [...html.matchAll(SCRIPT)].map((m) => m[1]);
  }

  /** The page's markup in a happy-dom window, without its scripts: happy-dom
   * 21 drops a script whose source holds "<=" (the panel script does). */
  function load(html: string): Window {
    const window = new Window({ url: "http://localhost/" });
    window.document.write(html.replace(SCRIPT, ""));
    windows.push(window);
    return window;
  }

  /** The owner-recovery <details> of an on-box page, with its parts. */
  function recoveryBlock(html: string): {
    details: PageElement;
    summary: string;
    button: string;
  } {
    const { document } = load(html);
    const all = document.querySelectorAll("details");
    expect(all.length).toBe(1);
    const details = all[0];
    const first = details.firstElementChild;
    expect(first?.tagName).toBe("SUMMARY");
    const buttons = details.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    return {
      details,
      summary: first?.textContent?.trim() ?? "",
      button: buttons[0].textContent?.trim() ?? "",
    };
  }

  it("folds the on-box command into a closed disclosure whose hint and copy button read in the browser's language", async () => {
    // Nil at sign-off (task b7d1ce62): a hint line that expands to the
    // instructions and the command, with a copy button.
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const seen: Record<string, { summary: string; button: string }> = {};
    for (const [label, header] of HEADERS) {
      const { html } = await page(server, "/", header);
      const block = recoveryBlock(html);
      expect({ label, open: block.details.hasAttribute("open") }).toEqual({
        label,
        open: false,
      });
      // The command sits inside the fold, not next to it.
      const inside = [...block.details.querySelectorAll("code")].map(
        (code) => code.textContent,
      );
      expect({ label, inside }).toEqual({
        label,
        inside: [ownerLoginCommand("<your-display-name>", ADMIN_SOCKET_PATH)],
      });
      expect({
        label,
        summary: block.summary.length > 0,
        button: block.button.length > 0,
      }).toEqual({ label, summary: true, button: true });
      seen[label] = { summary: block.summary, button: block.button };
    }
    for (const label of ["Spanish", "Catalan"])
      for (const part of ["summary", "button"] as const)
        expect({ label, part, text: seen[label][part] }).not.toEqual({
          label,
          part,
          text: seen.English[part],
        });
  });

  it("shows an off-box visitor no command, no fold, no copy button and no copy script", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const onBox = await page(server, "/", "en");
    const offBox = await page(server, "/", "en", { headers: OFF_BOX });
    expect(offBox.status).toBe(401);
    expect(ownerCommands(onBox.html).length).toBe(1);
    expect(codeTexts(offBox.html)).toEqual([]);
    const { document } = load(offBox.html);
    expect(document.querySelectorAll("details, button").length).toBe(0);
    expect(scripts(offBox.html).length).toBe(scripts(onBox.html).length - 1);
  });

  it("copies exactly the command the page shows, and says so only when the copy worked", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const { html } = await page(server, "/", "en");
    const command = ownerLoginCommand("<your-display-name>", ADMIN_SOCKET_PATH);
    // clipboard: what navigator.clipboard.writeText does (absent off a secure
    // context); execCommand: what document.execCommand("copy") returns.
    const cases: Array<{
      clipboard: "resolves" | "rejects" | "absent";
      execCommand: boolean;
      written: string[];
      selected: string[];
      labelChanges: boolean;
    }> = [
      {
        clipboard: "resolves",
        execCommand: false,
        written: [command],
        selected: [],
        labelChanges: true,
      },
      {
        clipboard: "rejects",
        execCommand: true,
        written: [command],
        selected: [command],
        labelChanges: true,
      },
      {
        clipboard: "absent",
        execCommand: true,
        written: [],
        selected: [command],
        labelChanges: true,
      },
      {
        clipboard: "rejects",
        execCommand: false,
        written: [command],
        selected: [command],
        labelChanges: false,
      },
    ];
    for (const c of cases) {
      const window = load(html);
      const { document } = window;
      const written: string[] = [];
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value:
          c.clipboard === "absent"
            ? undefined
            : {
                writeText: (text: string) => {
                  written.push(text);
                  return c.clipboard === "resolves"
                    ? Promise.resolve()
                    : Promise.reject(new Error("NotAllowedError"));
                },
              },
      });
      // The text selected when the page asks the browser to copy.
      const selected: string[] = [];
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: (name: string) => {
          if (name === "copy")
            selected.push(window.getSelection()?.toString() ?? "");
          return c.execCommand;
        },
      });
      for (const script of scripts(html))
        runInContext(script, window as unknown as Context);
      const button = document.querySelector("details button");
      expect({ button: button !== null }).toEqual({ button: true });
      if (!(button instanceof window.HTMLElement)) return;
      const before = button.textContent?.trim() ?? "";
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const after = button.textContent?.trim() ?? "";
      expect({
        ...c,
        written,
        selected,
        labelChanges: after !== before,
      }).toEqual(c);
      if (c.labelChanges) expect(after.length).toBeGreaterThan(0);
      // Nothing copied: the command stays selected for the visitor's Ctrl+C.
      else expect(window.getSelection()?.toString()).toBe(command);
    }
  });

  it("is not on the page before an owner exists, on the box or off it", async () => {
    server = await startTestServer();
    for (const init of [{}, { headers: OFF_BOX }]) {
      const { status, html } = await page(server, "/nope", "en", init);
      expect(status).toBe(401);
      expect(ownerCommands(html)).toEqual([]);
      expect(codeTexts(html).map((c) => c.text)).toEqual(["ssh -L"]);
      expect(
        load(html).document.querySelectorAll("details, button").length,
      ).toBe(0);
    }
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
  });
});
