#!/usr/bin/env bun
// The scripted browser transcript for S11: the storefront in three languages.
//
// It drives a REAL browser against a REAL dev server, and prints a transcript
// rather than assertions alone, the way `signup-flow.e2e.ts` does. What the unit
// tests cannot reach is here: the Accept-Language negotiation on a real request,
// the cookie beating that header, the browser's ORDERED preference list, the
// language switch under a real mouse click, and the root `lang` attribute a
// browser actually ends up with - including across a soft navigation.
//
// IT NAMES NO DATABASE. It runs on a scratch schema from `testing/pg.ts`,
// dropped in the finally, so it never seeds the configured database directly and
// never prints a connection string. `freshDsn` refuses a remote target that
// cannot prove it is the scratch branch.
//
// It needs no Stripe key and no network beyond localhost.
//
//   systemctl --user start pg-local        # 127.0.0.1:5433
//   bun run --cwd control-plane/web e2e:i18n
//
// Screenshots land in $E2E_SHOTS (default /tmp/s11-shots).

import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  freshDsn,
  openTestStoreOn,
  releaseTestStores,
  TARGET_IS_LOCAL,
} from "../../testing/pg.ts";
import { accountForDevSignIn, reserveOffice } from "../../signup.ts";
import { setOperator } from "../../operator-admin.ts";

const PORT = Number(process.env.E2E_PORT ?? 3313);
const BASE = `http://localhost:${PORT}`;
const WEB_DIR = path.join(import.meta.dir, "..");
const CHROME = "/usr/bin/google-chrome";
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/s11-shots";

const transcript: string[] = [];
function say(line: string): void {
  transcript.push(line);
  console.log(line);
}

function check(label: string, ok: boolean, detail = ""): void {
  say(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} never came up`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The root lang the BROWSER ended up with, after hydration. */
async function rootLang(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.lang);
}

/**
 * Wait for the root lang to settle on `expected`, and REPORT rather than throw.
 *
 * A bare `waitForFunction` ends the whole transcript on a timeout, which reads
 * as a crash rather than as the check that failed. This returns whatever the
 * attribute actually says, so the caller can `check` it and the run continues to
 * the checks after it.
 */
async function settledLang(page: Page, expected: string): Promise<string> {
  try {
    await page.waitForFunction(
      (want) => document.documentElement.lang === want,
      expected,
      { timeout: 15_000 },
    );
  } catch {
    // The value below is the evidence; the timeout itself says nothing extra.
  }
  return rootLang(page);
}

async function shot(page: Page, name: string): Promise<void> {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  say(`    screenshot: ${file}`);
}

async function signInAs(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/signin`);
  await page.fill('[data-testid="dev-email"]', email);
  await page.click('[data-testid="dev-submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 20_000 });
}

async function main(): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `i18n-${suffix}@example.com`;
  const officeName = `i18n-${suffix}`;

  say("# S11 browser transcript: the control plane in three languages");
  // NO CONNECTION STRING IN THE TRANSCRIPT. The one fact worth recording is
  // whether this ran against the throwaway container or a managed branch.
  say(
    `target: ${TARGET_IS_LOCAL ? "local throwaway container" : "managed scratch branch"}`,
  );
  say("schema: a fresh scratch schema, dropped when this exits");

  const dsn = await freshDsn();
  let server: ReturnType<typeof Bun.spawn> | null = null;
  let browser: Browser | null = null;
  try {
    {
      const store = await openTestStoreOn(dsn);
      const account = await accountForDevSignIn(store, email);
      const seeded = await reserveOffice(store, {
        accountId: account.id,
        officeName,
        plan: "office",
      });
      check("seeded an office for the signed-in account", seeded.ok);
      // The same account is granted the operator flag, so `/ops` RENDERS rather
      // than 404s and the ops leg below can assert what it draws. No customer
      // page branches on the flag.
      const granted = await setOperator(store, {
        email,
        on: true,
        actor: "s11-transcript",
      });
      check("granted the seed account operator access", granted.ok);
    }

    server = Bun.spawn(
      ["bun", "--bun", "node_modules/.bin/next", "dev", "-p", String(PORT)],
      {
        cwd: WEB_DIR,
        env: {
          ...process.env,
          CONTROL_PLANE_DB: dsn,
          CONTROL_PLANE_DEV_AUTH: "1",
          NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH: "1",
          AUTH_SECRET: process.env.AUTH_SECRET ?? "s11-transcript-secret",
          AUTH_URL: BASE,
          NEXTAUTH_URL: BASE,
        },
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    await waitForServer(`${BASE}/signin`);
    say("dev server is up");

    // ---------------------------------------------------------------- 1
    say("");
    say("## The prerendered shell is English, whatever the header asks for");
    for (const header of ["ca", "es-ES,es;q=0.9", "en"]) {
      const html = await (
        await fetch(`${BASE}/signin`, {
          headers: { "accept-language": header },
        })
      ).text();
      check(
        `served /signin is English for Accept-Language: ${header}`,
        html.includes("<h1>Sign in</h1>") && html.includes('lang="en"'),
      );
    }

    // ---------------------------------------------------------------- 2
    say("");
    say("## A Catalan browser gets Catalan after hydration, lang and all");
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const catalan = await browser.newContext({ locale: "ca-ES" });
    const page = await catalan.newPage();
    await page.goto(`${BASE}/signin`);
    const signinLang = await settledLang(page, "ca");
    check("the root lang followed the text", signinLang === "ca", signinLang);
    const heading = (await page.textContent("h1")) ?? "";
    check(
      "the sign-in heading reads Catalan",
      heading === "Inicia la sessió",
      heading,
    );
    const googleButton = (await page.textContent(".card button")) ?? "";
    check(
      "the provider button reads Catalan and keeps the product name",
      googleButton === "Continua amb Google",
      googleButton,
    );
    await shot(page, "signin-ca");

    // ---------------------------------------------------------------- 3
    say("");
    say("## The browser's preference ORDER decides, not its first entry");
    // THE CASE `navigator.language` ALONE HIDES: the top preference is a
    // language we do not serve and the second one is. A context locale can only
    // set one language, so the list is overridden before any script runs.
    const ordered = await browser.newContext({ locale: "fr-FR" });
    await ordered.addInitScript(() => {
      Object.defineProperty(navigator, "languages", {
        get: () => ["fr-FR", "ca", "en"],
      });
    });
    const orderedPage = await ordered.newPage();
    await orderedPage.goto(`${BASE}/signin`);
    const orderedLang = await settledLang(orderedPage, "ca");
    check(
      "an unsupported first preference does not hide a supported second",
      (await orderedPage.textContent("h1")) === "Inicia la sessió",
      (await orderedPage.textContent("h1")) ?? "",
    );
    check(
      "and the root lang is Catalan, not French and not English",
      orderedLang === "ca",
      orderedLang,
    );
    await shot(orderedPage, "signin-ordered-preferences");
    await ordered.close();

    // ---------------------------------------------------------------- 4
    say("");
    say(
      "## A real mouse click on the switch changes the language and remembers",
    );
    const spanishButton = await page.waitForSelector(
      '[data-testid="language-es"]',
    );
    const box = await spanishButton.boundingBox();
    check("the switch is on the page with a real box", !!box);
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const clickedLang = await settledLang(page, "es");
    check(
      "the root lang followed the click",
      clickedLang === "es",
      clickedLang,
    );
    const afterClick = (await page.textContent("h1")) ?? "";
    check(
      "the heading reads Spanish after the click",
      afterClick === "Iniciar sesión",
      afterClick,
    );
    const cookies = await catalan.cookies(BASE);
    const stored = cookies.find((c) => c.name === "isomux_lang");
    check(
      "the choice was written to a cookie",
      stored?.value === "es",
      String(stored?.value),
    );
    await shot(page, "signin-es-after-click");

    // The reload is the real test of "remembered": a fresh document, still
    // Spanish, on a browser whose own language is Catalan.
    await page.reload();
    const reloadedLang = await settledLang(page, "es");
    check(
      "the root lang survived the reload",
      reloadedLang === "es",
      reloadedLang,
    );
    check(
      "a reload on a Catalan browser still reads Spanish",
      (await page.textContent("h1")) === "Iniciar sesión",
    );

    // ---------------------------------------------------------------- 5
    say("");
    say("## The server-rendered pages: header first, cookie over header");
    await signInAs(page, email);
    say("signed in");

    const sessionCookie = (await catalan.cookies(BASE))
      .filter((c) => c.name !== "isomux_lang")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const fetchPage = async (
      route: string,
      header: string,
      languageCookie: string | null,
    ): Promise<string> => {
      const cookie = languageCookie
        ? `${sessionCookie}; isomux_lang=${languageCookie}`
        : sessionCookie;
      const res = await fetch(`${BASE}${route}`, {
        headers: { "accept-language": header, cookie },
        redirect: "manual",
      });
      return res.text();
    };

    const signupEs = await fetchPage("/signup", "es-ES,es;q=0.9", null);
    check(
      "/signup renders Spanish from the header alone",
      signupEs.includes("Configura tu oficina") &&
        signupEs.includes('<main lang="es">'),
    );
    const signupCa = await fetchPage("/signup", "ca", null);
    check(
      "/signup renders Catalan from the header alone",
      signupCa.includes("Configura la teva oficina") &&
        signupCa.includes('<main lang="ca">'),
    );
    const signupFr = await fetchPage("/signup", "fr-FR,fr;q=0.9", null);
    check(
      "/signup falls back to English for a language we do not serve",
      signupFr.includes("Set up your office") &&
        signupFr.includes('<main lang="en">'),
    );
    // THE FLIP: the cookie must beat the header, or the switch is decoration.
    const signupFlip = await fetchPage("/signup", "es-ES,es;q=0.9", "ca");
    check(
      "the cookie beats the header on /signup",
      signupFlip.includes("Configura la teva oficina") &&
        signupFlip.includes('<main lang="ca">'),
    );
    const signupFlipBack = await fetchPage("/signup", "ca", "en");
    check(
      "a cookie of en beats a Catalan header",
      signupFlipBack.includes("Set up your office") &&
        signupFlipBack.includes('<main lang="en">'),
    );
    // A corrupt cookie must not decide, and must not throw.
    const signupJunk = await fetchPage("/signup", "ca", "%");
    check(
      "a malformed language cookie falls back to the header",
      signupJunk.includes("Configura la teva oficina") &&
        signupJunk.includes('<main lang="ca">'),
    );

    const officeCa = await fetchPage(`/office/${officeName}`, "en", "ca");
    check(
      "/office renders Catalan from the cookie",
      officeCa.includes('<main lang="ca">') &&
        officeCa.includes("La teva oficina encara no està a punt."),
    );
    const officeEs = await fetchPage(`/office/${officeName}`, "es", null);
    check(
      "/office renders Spanish from the header",
      officeEs.includes('<main lang="es">') &&
        officeEs.includes("Tu oficina aún no está lista."),
    );

    // ---------------------------------------------------------------- 6
    say("");
    say("## The pages in the browser, with a screenshot each");
    await catalan.addCookies([{ name: "isomux_lang", value: "ca", url: BASE }]);
    await page.goto(`${BASE}/signup`);
    await page.waitForSelector("h1");
    check(
      "the sign-up page reads Catalan in the browser",
      (await page.textContent("h1")) === "Configura la teva oficina",
    );
    check("its root lang is Catalan", (await rootLang(page)) === "ca");
    await shot(page, "signup-ca");

    await page.goto(`${BASE}/office/${officeName}`);
    await page.waitForSelector('[data-testid="office-status"]');
    check(
      "the office page reads Catalan in the browser",
      (await page.textContent('[data-testid="office-status"]')) ===
        "La teva oficina encara no està a punt.",
    );
    check("its root lang is Catalan", (await rootLang(page)) === "ca");
    await shot(page, "office-ca");

    // The landing paints its signed-out shell first and swaps to the dashboard
    // when /api/session answers, so wait for the dashboard rather than for the
    // language: the shell is Catalan too, and its heading is the product name.
    await page.goto(`${BASE}/`);
    await page.waitForSelector('[data-testid="signed-in-as"]', {
      timeout: 20_000,
    });
    check(
      "the landing dashboard reads Catalan",
      ((await page.textContent("h1")) ?? "").includes("La teva oficina"),
      (await page.textContent("h1")) ?? "",
    );
    check(
      "and names the signed-in account in Catalan",
      (
        (await page.textContent('[data-testid="signed-in-as"]')) ?? ""
      ).startsWith("Sessió iniciada com a"),
    );
    check("its root lang is Catalan", (await rootLang(page)) === "ca");
    await shot(page, "home-ca");

    // ---------------------------------------------------------------- 7
    say("");
    say("## Ops renders English and offers no switch");
    await page.goto(`${BASE}/ops`);
    await page.waitForSelector("h1", { timeout: 20_000 });
    check(
      "the ops floor renders rather than 404s",
      (await page.textContent("h1")) === "Ops floor",
      (await page.textContent("h1")) ?? "",
    );
    check(
      "the switch is not offered on ops",
      (await page.$('[data-testid="language-switch"]')) === null,
    );
    check(
      "ops declares itself English even behind a Catalan cookie",
      (await rootLang(page)) === "en",
      await rootLang(page),
    );
    await shot(page, "ops-en");

    // ---------------------------------------------------------------- 8
    say("");
    say("## A SOFT navigation takes the root lang with it");
    // The one case a full page load cannot prove: the root layout serves
    // lang="en" on every document, so only a client-side navigation between two
    // pages of different languages shows whether the attribute follows the text.
    // Header says Catalan, browser says English, no cookie: /office is
    // server-rendered Catalan from the header and / resolves English in the
    // browser. The context locale sets the REQUEST header, and the init script
    // overrides what the DOM reports, which is the only pair of knobs that can
    // disagree with each other on purpose.
    const mixed = await browser.newContext({ locale: "ca-ES" });
    await mixed.addInitScript(() => {
      Object.defineProperty(navigator, "languages", { get: () => ["en-US"] });
      Object.defineProperty(navigator, "language", { get: () => "en-US" });
    });
    const mixedPage = await mixed.newPage();
    await signInAs(mixedPage, email);
    await mixedPage.goto(`${BASE}/office/${officeName}`);
    const mixedOfficeLang = await settledLang(mixedPage, "ca");
    check(
      "the office page's root lang is Catalan before the navigation",
      mixedOfficeLang === "ca",
      mixedOfficeLang,
    );
    check(
      "the office page arrived Catalan from the header, with no cookie",
      (await mixedPage.textContent('[data-testid="office-status"]')) ===
        "La teva oficina encara no està a punt.",
    );
    // The sentinel is what stops a full reload passing this by accident.
    await mixedPage.evaluate(() => {
      (window as unknown as { __s11: number }).__s11 = 1;
    });
    await mixedPage.click("nav.page-back a");
    await mixedPage.waitForURL(`${BASE}/`, { timeout: 20_000 });
    const resetLang = await settledLang(mixedPage, "en");
    const survived = await mixedPage.evaluate(
      () => (window as unknown as { __s11?: number }).__s11 === 1,
    );
    check("the navigation was soft: the document was never replaced", survived);
    check(
      "the root lang went back to English with the text",
      resetLang === "en",
      resetLang,
    );
    // The dashboard replaces the shell when /api/session answers; the shell's
    // own heading is the product name, so waiting for the dashboard is what
    // makes this an assertion about language rather than about timing.
    await mixedPage.waitForSelector('[data-testid="signed-in-as"]', {
      timeout: 20_000,
    });
    check(
      "and the landing really is English for this browser",
      ((await mixedPage.textContent("h1")) ?? "").includes("Your office"),
      (await mixedPage.textContent("h1")) ?? "",
    );
    check(
      "the root lang is still English once the dashboard has painted",
      (await rootLang(mixedPage)) === "en",
      await rootLang(mixedPage),
    );
    await shot(mixedPage, "soft-nav-reset-en");
    await mixed.close();
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.kill();
      await server.exited;
    }
    // The server has to be gone before the schema is dropped: a live connection
    // would block the cascade.
    await releaseTestStores();
  }

  const failures = transcript.filter((l) => l.startsWith("FAIL")).length;
  say("");
  say(
    `${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
  );
}

await main();
