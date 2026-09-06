// The pre-sign-in pages in three languages (internal-docs/i18n-loop.md, S9).
//
// A visitor who has not signed in yet has no stored preference, so these pages
// read the Accept-Language header; the two pages that CAN know their reader
// (the invite-for-someone-else refusal and the sign-out refusal) read that
// reader's stored preference instead, header or no header.
//
// The oracle is a LITERAL translated string, never text read back through the
// translator (ruling 14). Every English assertion here is the byte-for-byte
// sentence the page carried before S9 moved it into the catalog, so a wording
// drift fails the suite (ruling 6).
//
// Seam: startTestServer() - the real boot path and the real /auth routes.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintInvite } from "../auth.ts";
import { getUserByName, updateUserById } from "../users.ts";

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
  const mint = await mintInvite({
    username: null,
    role: "owner",
    createdBy: null,
    allowExisting: false,
    bootstrap: true,
  });
  if (!mint.ok) throw new Error(`bootstrap mint failed: ${mint.error}`);
  return mint.rawToken;
}

async function inviteTokenFor(username: string): Promise<string> {
  const mint = await mintInvite({
    username,
    role: "member",
    createdBy: null,
    allowExisting: false,
  });
  if (!mint.ok) throw new Error(`mint failed: ${mint.error}`);
  return mint.rawToken;
}

function setLanguage(username: string, language: "es" | "ca" | null): void {
  const user = getUserByName(username);
  if (!user) throw new Error(`no user record for ${username}`);
  const result = updateUserById(user.id, { language });
  if (!result.ok) throw new Error(`could not set language: ${result.error}`);
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
      seen[label] = html;
    }
    expect(seen.Spanish).toContain(
      "<h1>Te damos la bienvenida a tu nueva oficina Isomux</h1>",
    );
    expect(seen.Spanish).toContain(
      "Elige un nombre para mostrar; aparecerá junto a todo lo que digas.",
    );
    expect(seen.Spanish).toContain("- configuración inicial</title>");
    expect(seen.Catalan).toContain(
      "<h1>Et donem la benvinguda a la teva nova oficina Isomux</h1>",
    );
    expect(seen.Catalan).toContain(
      "Tria un nom per mostrar; apareixerà al costat de tot el que diguis.",
    );
    // English, byte for byte as it read before the catalog (ruling 6).
    for (const html of [seen.English, seen["no header"]]) {
      expect(html).toContain("<h1>Welcome to your new Isomux office</h1>");
      expect(html).toContain(
        "<p>You're the first person to claim this office. Pick a display name; it'll appear next to anything you say.</p>",
      );
      expect(html).toContain(
        '<label>Display name <input name="name" type="text" autofocus maxlength="64" required',
      );
      expect(html).toContain('<button type="submit">Continue</button>');
      expect(html).toContain("- first-time setup</title>");
    }
  });

  it("answers a bad display name in the language the form was read in", async () => {
    server = await startTestServer();
    const res = await server.http("/auth/claim", {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "Accept-Language": "ca",
      },
      body: "name=",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<html lang="ca">');
    expect(html).toContain(
      "Tria un nom per mostrar (lletres, xifres, espais, punts, guions, apòstrofs o guions baixos).",
    );
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
    expect(seen.Spanish).toContain(
      "Elige un nombre para mostrar - aparecerá junto a todo lo que digas.",
    );
    expect(seen.Catalan).toContain(
      "Tria un nom per mostrar - apareixerà al costat de tot el que diguis.",
    );
    expect(seen.Catalan).toContain('content="Isomux - configuració inicial"');
    for (const html of [seen.English, seen["no header"]]) {
      // The hyphen spelling, one character from the claim page's semicolon.
      expect(html).toContain(
        "<p>You're the first person to claim this office. Pick a display name - it'll appear next to anything you say.</p>",
      );
      expect(html).toContain(
        'content="Open this link to claim ownership of an Isomux office."',
      );
    }
  });

  it("reads in the browser's language on a named invite", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
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
    expect(seen.Spanish).toContain(
      "Al pulsar el botón de abajo iniciarás sesión en este dispositivo.",
    );
    expect(seen.Spanish).toContain(
      '<button type="submit" autofocus>Aceptar y continuar</button>',
    );
    expect(seen.Catalan).toContain(
      "En prémer el botó de sota iniciaràs la sessió en aquest dispositiu.",
    );
    expect(seen.Catalan).toContain(
      '<button type="submit" autofocus>Accepta i continua</button>',
    );
    for (const html of [seen.English, seen["no header"]]) {
      expect(html).toContain(
        "<p>Clicking the button below will sign you in on this device.</p>",
      );
      expect(html).toContain(
        '<button type="submit" autofocus>Accept and continue</button>',
      );
      expect(html).toContain("- accept invite</title>");
    }
  });
});

describe("the login page", () => {
  it("reads in the browser's language for a visitor with no session", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
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
    expect(seen.Spanish).toContain(
      "Abre un enlace de invitación para iniciar sesión en este dispositivo.",
    );
    expect(seen.Catalan).toContain(
      "Obre un enllaç d'invitació per iniciar la sessió en aquest dispositiu.",
    );
    expect(seen.Catalan).toContain("- iniciar la sessió</title>");
    for (const html of [seen.English, seen["no header"]]) {
      expect(html).toContain(
        "<p>Open an invite link to sign in on this device.</p>",
      );
      expect(html).toContain(
        "<p>Already signed in elsewhere? Create one in User settings there.</p>",
      );
      expect(html).toContain(
        '<p class="muted">Otherwise, ask the office owner for one.</p>',
      );
    }
  });

  it("keeps the pre-claim branch's link and command intact in every language", async () => {
    // No owner yet, so the login page takes its other branch. The anchor and
    // the <code> span are placeholders filled at the call site (ruling 19).
    server = await startTestServer();
    const { html: en } = await page(server, "/nope", "en");
    const { html: ca } = await page(server, "/nope", "ca");
    expect(en).toContain(
      "<p>Open <a href=\"/\">this office's home page</a> to claim ownership.</p>",
    );
    expect(en).toContain(
      "The server's startup log spells out the exact <code>ssh -L</code> command.",
    );
    // Nothing on this branch goes through escapeHtml, so the Catalan
    // apostrophes stay as apostrophes, exactly like the English possessives.
    expect(ca).toContain(
      '<p>Obre <a href="/">la pàgina d\'inici d\'aquesta oficina</a> per reclamar-ne la propietat.</p>',
    );
    expect(ca).toContain("indica l'ordre <code>ssh -L</code> exacta.");
  });
});

describe("the invite-error page", () => {
  it("reads in the browser's language", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const { status, html: ca } = await page(server, "/i/nosuchtoken", "ca");
    expect(status).toBe(410);
    expect(ca).toContain('<html lang="ca">');
    expect(ca).toContain("<h1>Invitació no disponible</h1>");
    expect(ca).toContain("Aquesta invitació ja no és vàlida.");
    const { html: en } = await page(server, "/i/nosuchtoken", "en");
    expect(en).toContain(
      "<h1>Invite unavailable</h1><p>This invite is no longer valid.</p>",
    );
  });
});

describe("a page that knows its reader", () => {
  it("gives a signed-in Spanish user Spanish, whatever the browser asks for", async () => {
    // Ruling 8's precedence, on the one pre-sign-in page that can identify its
    // reader: Boss is signed in and stored on Spanish, the browser says
    // English, and the invite belongs to someone else.
    server = await startTestServer();
    const boss = await server.seedOwner("Boss");
    setLanguage("Boss", "es");
    const token = await inviteTokenFor("Yu");
    const { status, html } = await page(server, `/i/${token}`, "en", {
      rawSessionId: boss.rawSessionId,
    });
    expect(status).toBe(409);
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("<h1>Esta invitación es para otro usuario</h1>");
    expect(html).toContain(
      "Has iniciado sesión como Boss. Esta invitación es para Yu: ábrela en su dispositivo o en otro perfil del navegador.",
    );
    expect(html).toContain('<a href="/">Volver a la oficina</a>');
  });

  it("leaves a signed-in user with no stored preference in English", async () => {
    // "Never chosen" is English on the server (S7), and a Spanish header does
    // not override a reader we know.
    server = await startTestServer();
    const boss = await server.seedOwner("Boss");
    const token = await inviteTokenFor("Yu");
    const { html } = await page(server, `/i/${token}`, "es", {
      rawSessionId: boss.rawSessionId,
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<h1>This invite is for a different user</h1>");
    expect(html).toContain(
      "<p>You are signed in as Boss. This invite is for Yu: open it on their device or in a separate browser profile.</p>",
    );
  });

  it("still escapes the names it writes into the sentence", async () => {
    // The sentence moved into the catalog and the names did not: an
    // apostrophe in a display name must still arrive as an entity, exactly as
    // it did when the whole composed sentence went through escapeHtml.
    server = await startTestServer();
    const boss = await server.seedOwner("O'Boss");
    const token = await inviteTokenFor("O'Hara");
    const { status, html } = await page(server, `/i/${token}`, "en", {
      rawSessionId: boss.rawSessionId,
    });
    expect(status).toBe(409);
    // One assertion per slot: the sentence takes two names and each is
    // escaped on its own, so dropping either escape has to fail here.
    expect(html).toContain("You are signed in as O&#39;Boss.");
    expect(html).not.toContain("You are signed in as O'Boss.");
    expect(html).toContain("This invite is for O&#39;Hara:");
    expect(html).not.toContain("This invite is for O'Hara:");
  });

  it("refuses the last owner's sign-out in that owner's language", async () => {
    server = await startTestServer();
    const boss = await server.seedOwner("Boss");
    setLanguage("Boss", "ca");
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "text/html", "Accept-Language": "en" },
      rawSessionId: boss.rawSessionId,
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('<html lang="ca">');
    expect(html).toContain("<h1>Tancament de sessió bloquejat</h1>");
    expect(html).toContain(
      "Tancament de sessió rebutjat: aquesta és l&#39;última sessió activa de propietari a l&#39;oficina.",
    );
    // The link text is written into the template, the refusal sentence goes
    // through escapeHtml as it always has - hence the two apostrophe spellings.
    expect(html).toContain('<a href="/">Torna a l\'oficina</a>');
  });
});
