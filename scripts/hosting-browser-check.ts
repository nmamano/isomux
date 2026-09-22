// Manual docs UI check. No office server, provider turns, or external requests.
// Run after build:docs. Artifacts are ignored; the guide sources remain canonical.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOSTING_GUIDES, HOSTING_LEGACY_LINKS, hostingUrl } from "./hosting-docs.ts";

const output = resolve("internal-docs/private/hosting-guide-0921");
mkdirSync(output, { recursive: true });
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const path = pathname.startsWith("/docs/") && !pathname.endsWith(".css")
      ? `site${pathname.replace(/\/$/, "")}/index.html` : `site${pathname}`;
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.route("**/*", async (route) => {
      if (!route.request().url().startsWith(origin)) return route.abort();
      if (new URL(route.request().url()).pathname === "/api/chat") {
        return route.fulfill({ status: 400, contentType: "application/json", body: '{"error":{"message":"Local verification only"}}' });
      }
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/docs/self-hosted`);
    await page.screenshot({ path: `${output}/selector-${viewport.width}.png`, fullPage: true });
    check(await page.locator(".hosting-flow a").count() === 8, "diagram destination count");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "index overflow");
    for (const guide of HOSTING_GUIDES) {
      await page.locator(`.hosting-flow a[data-guide="${guide.id}"]`).click();
      await page.waitForURL(`${origin}${hostingUrl(guide.id)}`);
      check(await page.locator("article h1").count() === 1, "one guide");
      check(await page.locator(".hosting-guide-notice a").getAttribute("href") === "/docs/self-hosted", "guide return link");
      check(await page.locator(".hosting-flow, .hosting-selector").count() === 0, "guide has no picker");
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow: ${guide.id}`);
      if (guide.id === "aws" || guide.id === "private") await page.screenshot({ path: `${output}/${guide.id}-${viewport.width}.png`, fullPage: true });
      const request = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/chat");
      await page.evaluate(() => {
        const widget = window as typeof window & { __chatOpen: () => void; __chatSend: (text: string) => void };
        widget.__chatOpen(); widget.__chatSend("verification");
      });
      const posted = (await request).postDataJSON() as { pageContext: string };
      const expected = readFileSync(`site/_agent/docs/hosting-${guide.id}/index.md`, "utf8").split("\n")[0];
      check(posted.pageContext.split("\n")[0] === expected, "chat context identity");
      await page.goBack();
      await page.waitForURL(`${origin}/docs/self-hosted`);
    }
    // Flow activation and native back/forward preserve the selected guide.
    await page.locator('.hosting-flow a[data-guide="domain"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`${origin}/docs/hosting-domain`);
    await page.goBack(); await page.waitForURL(`${origin}/docs/self-hosted`);
    await page.goForward(); await page.waitForURL(`${origin}/docs/hosting-domain`);
    for (const [hash, destination] of Object.entries(HOSTING_LEGACY_LINKS)) {
      await page.goto(`${origin}/docs/self-hosted#${hash}`);
      await page.waitForURL(`${origin}${destination}`);
    }
    await page.goto(`${origin}/docs/self-hosted#unknown-bookmark`);
    check(page.url().endsWith("#unknown-bookmark"), "unknown fragment stays");
    await context.close();
  }
  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  await noJs.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await noJs.newPage();
  await page.goto(`${origin}/docs/self-hosted`);
  await page.locator('.hosting-flow a[data-guide="render"]').click();
  await page.waitForURL(`${origin}/docs/hosting-render`);
  check(await page.locator("article h1").isVisible(), "no-JS guide");
  await page.locator(".hosting-guide-notice a").click();
  await page.waitForURL(`${origin}/docs/self-hosted`);
  check(await page.locator(".hosting-flow a").count() === 8, "no-JS return to diagram");
  await page.screenshot({ path: `${output}/no-js-390.png`, fullPage: true });
  await page.goto(`${origin}/docs/self-hosted#deploy-on-render`);
  await page.locator(".hosting-legacy").evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.locator('#deploy-on-render a').click();
  await page.waitForURL(`${origin}/docs/hosting-render`);
  // Review artifact: all rendered article copy and all accessible labels, read
  // from generated pages. It is an output, never another maintained guide.
  let copy = "# Hosting review copy\n\nGenerated from rendered pages. Do not edit this artifact.\n";
  for (const path of ["/docs/self-hosted", ...HOSTING_GUIDES.map((g) => hostingUrl(g.id)), "/docs/hosting-reference"]) {
    await page.goto(`${origin}${path}`);
    await page.locator("details").evaluateAll((elements) => elements.forEach((element) => { (element as HTMLDetailsElement).open = true; }));
    copy += `\n\n---\n\n## ${path}\n\n${await page.locator("article").innerText()}\n\nAccessible labels:\n`;
    copy += (await page.locator("[aria-label]").evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")))).join("\n");
  }
  writeFileSync(`${output}/english-copy.md`, copy);
  await noJs.close();
  console.log(`PASS: desktop/mobile selection, keyboard, back/forward, legacy links, no JS, context; artifacts ${output}`);
} finally {
  await browser.close();
  await server.stop();
}
