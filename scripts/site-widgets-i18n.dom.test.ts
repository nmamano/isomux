// The two scripts every page of the public site loads - the chat widget
// (site/chatbot.js) and the theme toggle (site/theme-toggle.js) - carry fixed
// labels of their own. They are shared files, not per-language copies, so they
// read the page's `<html lang>` and fall back to English for anything else.
//
// The widget also tells /api/chat which page it is on, and a language copy of
// a page lives under its own directory, so that classification has to see past
// the prefix. It is checked here on the outbound request body, not on the
// button the visitor clicked: the label and the page kind are different facts
// and a test that only reads the label would pass with the kind wrong.
//
// Each script is a browser IIFE, not a module: the test runs the real file in a
// document whose lang and path it sets first, then reads the DOM the script
// produced, or the request it tried to send. No request leaves the process -
// `fetch` is replaced for the duration. Expectations are literal strings, never
// a lookup into the script's own tables.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setUpDomTestFile } from "../ui/test-support/dom.ts";

setUpDomTestFile();

const SITE = join(import.meta.dir, "..", "site");
const CHATBOT = readFileSync(join(SITE, "chatbot.js"), "utf8");
const THEME_TOGGLE = readFileSync(join(SITE, "theme-toggle.js"), "utf8");

type ChatWindow = typeof window & {
  __chatOpen: () => void;
  __chatSend: (text: string) => void;
};

/** Run a site script in this document, after putting the page on `lang`. */
function runOn(lang: string, source: string): void {
  document.documentElement.lang = lang;
  new Function(source)();
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  document.body.innerHTML = '<div id="chat-widget"></div>';
  localStorage.clear();
  history.pushState(null, "", "/");
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function openChat(lang: string): string {
  runOn(lang, CHATBOT);
  (window as ChatWindow).__chatOpen();
  return document.body.innerHTML;
}

describe("the chat widget's own labels", () => {
  it("reads English on an English page", () => {
    const html = openChat("en");
    expect(html).toContain("Ask about Isomux");
    expect(html).toContain('placeholder="Type a message..."');
    expect(html).toContain("Ask me anything about Isomux!");
    expect(html).toContain("What features does it have?");
    expect(html).toContain("Powered by Claude");
  });

  it("reads Spanish on a Spanish page", () => {
    const html = openChat("es");
    expect(html).toContain("Pregunta sobre Isomux");
    expect(html).toContain('placeholder="Escribe un mensaje..."');
    expect(html).toContain("¡Pregúntame lo que quieras sobre Isomux!");
    expect(html).toContain("¿Qué funciones tiene?");
    expect(html).toContain("Funciona con Claude");
  });

  it("reads Catalan on a Catalan page", () => {
    const html = openChat("ca");
    expect(html).toContain("Pregunta sobre Isomux");
    expect(html).toContain('placeholder="Escriu un missatge..."');
    expect(html).toContain("Quines funcions té?");
    expect(html).toContain("Funciona amb Claude");
  });

  it("falls back to English for a language it has no labels for", () => {
    const html = openChat("fr");
    expect(html).toContain('placeholder="Type a message..."');
    expect(html).toContain("Powered by Claude");
  });
});

describe("the page kind the widget reports to /api/chat", () => {
  /** Send one message from `pathname` and return what the request carried. */
  async function outbound(
    pathname: string,
    lang: string,
  ): Promise<{ url: string; page: string }> {
    history.pushState(null, "", pathname);
    document.body.innerHTML = '<div id="chat-widget"></div>';
    let sent: { url: string; page: string } | null = null;
    let arrive: () => void = () => {};
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url: String(url), page: JSON.parse(String(init.body)).page };
      arrive();
      // An empty stream, so the widget's reader finishes instead of throwing.
      return new Response(
        new ReadableStream({ start: (c) => c.close() }),
      ) as Response;
    }) as unknown as typeof fetch;
    runOn(lang, CHATBOT);
    const w = window as ChatWindow;
    w.__chatOpen();
    w.__chatSend("hola");
    await arrived;
    return sent!;
  }

  it("calls the one endpoint and nothing else", async () => {
    expect((await outbound("/hosted", "en")).url).toBe("/api/chat");
  });

  it("reports the hosted page from every language's copy of it", async () => {
    expect((await outbound("/hosted", "en")).page).toBe("hosted");
    expect((await outbound("/es/hosted", "es")).page).toBe("hosted");
    expect((await outbound("/ca/hosted", "ca")).page).toBe("hosted");
  });

  it("reports the landing from every language's copy of it", async () => {
    expect((await outbound("/", "en")).page).toBe("main");
    expect((await outbound("/es", "es")).page).toBe("main");
    expect((await outbound("/es/", "es")).page).toBe("main");
    expect((await outbound("/ca", "ca")).page).toBe("main");
    expect((await outbound("/ca/", "ca")).page).toBe("main");
  });

  it("reports the landing from a docs page, as it always has", async () => {
    expect((await outbound("/docs/self-hosted", "en")).page).toBe("main");
  });
});

describe("the theme toggle's own label", () => {
  /** The button's title after a run on `lang` with `saved` in localStorage. */
  function label(lang: string, saved: string | null): string {
    // Each run appends its own button, so start from an empty body or the
    // query keeps answering with the first language's button.
    document.body.innerHTML = "";
    localStorage.clear();
    if (saved) localStorage.setItem("isomux-theme", saved);
    runOn(lang, THEME_TOGGLE);
    const buttons = document.querySelectorAll("button.theme-toggle");
    expect(buttons.length).toBe(1);
    return buttons[0].getAttribute("title") ?? "";
  }

  // The button names the mode it would switch TO, so the two halves of the
  // label table are reached by two different saved states. happy-dom's
  // matchMedia answers the light-mode query, so with nothing saved the page is
  // already light and the button offers dark; a saved "dark" is what makes it
  // offer light. Both halves are asserted, in all three languages.
  it("offers dark when the page is light", () => {
    expect(label("en", "light")).toBe("Switch to dark mode");
    expect(label("es", "light")).toBe("Cambiar al modo oscuro");
    expect(label("ca", "light")).toBe("Canviar al mode fosc");
    expect(label("de", "light")).toBe("Switch to dark mode");
  });

  it("offers light when the page is dark", () => {
    expect(label("en", "dark")).toBe("Switch to light mode");
    expect(label("es", "dark")).toBe("Cambiar al modo claro");
    expect(label("ca", "dark")).toBe("Canviar al mode clar");
    expect(label("de", "dark")).toBe("Switch to light mode");
  });

  it("follows the system when nothing is saved", () => {
    expect(label("ca", null)).toBe("Canviar al mode fosc");
  });

  it("puts the same sentence on aria-label as on title", () => {
    document.body.innerHTML = "";
    localStorage.clear();
    localStorage.setItem("isomux-theme", "dark");
    runOn("ca", THEME_TOGGLE);
    const btn = document.querySelector("button.theme-toggle");
    expect(btn!.getAttribute("aria-label")).toBe("Canviar al mode clar");
    expect(btn!.getAttribute("title")).toBe("Canviar al mode clar");
  });
});
