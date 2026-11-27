// Task d376e203: in a tab the agent opened, a click on a visible link failed
// with "outside the viewport" and a viewport screenshot failed, because the
// window gave the page no real viewport (minimized on Windows; a strip here,
// see stripWindow).
// A tab the agent opened gets an emulated viewport; an offered tab is never
// touched.
import {
  launchRawExtensionChrome,
  storeExtensionPairing,
} from "./test-support/raw-extension-chrome";
import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser, Page } from "playwright-core";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";
import type { ExtensionBrowserSessions } from "./browser-extension-session";
import type { BrowserResult } from "./browser-actions";
import { VIEWPORT_FLOOR } from "./browser-input";

const live = process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1";
const DEADLINE_MS = 8000;

type Timed = { result: BrowserResult; elapsed: number };
type Harness = {
  // The site: "/" is the page, "/frame" the frame document. `cross` is the
  // same server under another site (localhost), so its frame is out of
  // process.
  origin: string;
  cross: string;
  act: (body: Record<string, unknown>) => Promise<Timed>;
  // The setup client's view of a page whose URL starts with the prefix.
  pageOf: (prefix: string) => Promise<Page>;
  // Sets the outer height of the page's Chrome window, as a strip.
  stripWindow: (page: Page) => Promise<void>;
  // The member offers a tab that the setup client opened.
  offer: (page: Page) => Promise<string>;
  setup: Browser;
};

const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });

async function withAgentTabs(
  site: (url: URL) => Response,
  run: (h: Harness) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "isomux-viewport-"));
  const fixture = browserExtensionFixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => site(new URL(req.url)),
  });
  let raw: Awaited<ReturnType<typeof launchRawExtensionChrome>> | undefined;
  let sessions: ExtensionBrowserSessions | undefined;
  try {
    await buildBrowserExtension(join(dir, "extension"));
    raw = await launchRawExtensionChrome(dir);
    const setup = raw.browser.contexts()[0];
    const admin = await raw.browser.newBrowserCDPSession();
    const { id } = await admin.send("Extensions.loadUnpacked", {
      path: join(dir, "extension"),
    });
    const extensionPage = await setup.newPage();
    await extensionPage.goto("chrome-extension://" + id + "/connection.html");
    await storeExtensionPairing(extensionPage, {
      url: fixture.extensionURL,
      credential: fixture.credential,
      nonce: crypto.randomUUID(),
    });
    const connected = Date.now() + 5000;
    while (!fixture.bridge.connections("fixture-member")[0]) {
      if (Date.now() >= connected)
        throw new Error("Fixture connection did not settle");
      await Bun.sleep(20);
    }
    // The member lets their agents open tabs, as the popup's setting does.
    await extensionPage.evaluate(async (office) => {
      const chrome = (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
        }
      ).chrome;
      await chrome.runtime.sendMessage({
        action: "access",
        office,
        access: { agents: "mine", members: [], openTabs: true },
      });
    }, fixture.origin);
    const owned = fixture.sessions(DEADLINE_MS);
    sessions = owned;
    const act = async (body: Record<string, unknown>) => {
      const started = performance.now();
      const result = await owned.run("fixture-agent", body);
      const elapsed = Math.round(performance.now() - started);
      console.log(
        "Action:",
        JSON.stringify({
          action: body.action,
          ok: result.ok,
          code: result.ok ? undefined : result.code,
          error: result.ok ? undefined : result.error,
          elapsed,
        }),
      );
      return { result, elapsed };
    };
    const pageOf = async (prefix: string) => {
      const until = Date.now() + 5000;
      for (;;) {
        const found = setup.pages().find((p) => p.url().startsWith(prefix));
        if (found) return found;
        if (Date.now() >= until) throw new Error("No setup page for " + prefix);
        await Bun.sleep(50);
      }
    };
    const stripWindow = async (page: Page) => {
      const cdp = await setup.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      // In steps: one jump from a full window to a strip can leave the page
      // hidden at its old size, on Linux. Chrome keeps the window at least
      // 143 px high, so the page gets about 57 px: under the floor, but not
      // the 0 px of a minimized window on Windows, which Linux does not give.
      for (const height of [400, 200, 100])
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { width: 1000, height },
        });
      await cdp.detach();
      const until = Date.now() + 5000;
      while (
        (await page.evaluate(() => innerHeight)) >= VIEWPORT_FLOOR.height
      ) {
        if (Date.now() >= until) throw new Error("The window did not shrink");
        await Bun.sleep(50);
      }
    };
    const offer = async (page: Page) => {
      await page.bringToFront();
      const cdp = await setup.newCDPSession(page);
      const target = (await cdp.send("Target.getTargetInfo")).targetInfo
        .targetId;
      await cdp.detach();
      const popup = await openExtensionActionPopup(admin, id, target, setup);
      await popup.waitFor('!document.querySelector("#allow").disabled');
      await popup.offer(join(dir, "offer-failed.png"));
      await popup.close();
      const connection = fixture.bridge.connections("fixture-member")[0];
      await connection.drain(connection.offered("fixture-agent", target)!);
      return target;
    };
    await run({
      origin: server.url.origin,
      cross: `http://localhost:${server.port}`,
      act,
      pageOf,
      stripWindow,
      offer,
      setup: raw.browser,
    });
  } finally {
    sessions?.stop();
    await raw?.close();
    fixture.stop();
    void server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

const innerSize = (page: Page) =>
  page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

// The page shows #tall only when the viewport has a real height, as a
// responsive site hides its desktop parts in a narrow layout. The frame sits
// below the strip's viewport and inside a real one.
const PAGE = (frame: string, gap = 100) =>
  `<!doctype html><title>Viewport</title><style>body{margin:8px}#tall{display:none}@media (min-height:${VIEWPORT_FLOOR.height}px){#tall{display:block}}</style>` +
  `<p id="tall">Desktop part</p>` +
  `<a id="link" href="#clicked" onclick="document.body.dataset.clicked='yes'">Next step</a>` +
  `<div style="height:${gap}px"></div>` +
  `<iframe id="frame" src="${frame}" width="300" height="80"></iframe>`;
const FRAME = `<!doctype html><title>Frame</title><label><input type="checkbox" id="box">I agree</label>`;

const site = (frameOrigin: (url: URL) => string, gap?: number) => (url: URL) =>
  url.pathname === "/frame"
    ? html(FRAME)
    : html(PAGE(frameOrigin(url) + "/frame", gap));
const crossOrigin = (url: URL) => `http://localhost:${url.port}`;

const boxChecked = async (page: Page) => {
  const frame = page.frames().find((f) => f.url().endsWith("/frame"));
  if (!frame) throw new Error("No frame");
  return frame.evaluate(
    () => (document.querySelector("#box") as HTMLInputElement).checked,
  );
};

test.skipIf(live)(
  "in an opened tab whose window is a strip, a snapshot shows the real layout, a click on a link works, and a viewport screenshot works",
  async () => {
    await withAgentTabs(
      site(() => ""),
      async ({ origin, act, pageOf, stripWindow }) => {
        expect(
          (await act({ action: "open", url: origin + "/" })).result.ok,
        ).toBe(true);
        const page = await pageOf(origin);
        await stripWindow(page);
        // The precondition, in the green and the red run.
        const before = await innerSize(page);
        console.log("Strip size:", JSON.stringify(before));
        expect(before.height).toBeLessThan(VIEWPORT_FLOOR.height);
        // The first action after the strip is a read: it must see the layout
        // the click will see.
        const snapshot = (await act({ action: "snapshot" })).result;
        expect(snapshot.ok).toBe(true);
        expect(JSON.stringify(snapshot)).toContain("Desktop part");
        const click = await act({ action: "click", selector: "#link" });
        expect(click.result).toMatchObject({ ok: true });
        expect(await page.evaluate(() => document.body.dataset.clicked)).toBe(
          "yes",
        );
        const shot = await act({ action: "screenshot" });
        expect(shot.result).toMatchObject({ ok: true });
        const after = await innerSize(page);
        expect(after.width).toBeGreaterThanOrEqual(VIEWPORT_FLOOR.width);
        expect(after.height).toBeGreaterThanOrEqual(VIEWPORT_FLOOR.height);
      },
    );
  },
  120_000,
);

// The reCAPTCHA case: a click inside a cross-site frame outside the viewport
// waited for a frame Chrome does not render, and the next action waited too.
test.skipIf(live)(
  "in an opened tab whose window is a strip, a click in a cross-site frame works and the next action does not wait",
  async () => {
    await withAgentTabs(
      site(crossOrigin),
      async ({ origin, act, pageOf, stripWindow }) => {
        expect(
          (await act({ action: "open", url: origin + "/" })).result.ok,
        ).toBe(true);
        const page = await pageOf(origin);
        await stripWindow(page);
        expect((await innerSize(page)).height).toBeLessThan(
          VIEWPORT_FLOOR.height,
        );
        // The frame is out of process: the condition of the incident.
        expect(
          page
            .frames()
            .find((f) => f.url().endsWith("/frame"))!
            .url(),
        ).toStartWith("http://localhost:");
        const click = await act({
          action: "click",
          framePath: [0],
          selector: "#box",
        });
        expect(click.result).toMatchObject({ ok: true });
        expect(await boxChecked(page)).toBe(true);
        const next = await act({ action: "text", selector: "#link" });
        expect(next.result).toMatchObject({ ok: true });
        expect(next.elapsed).toBeLessThan(3000);
      },
    );
  },
  120_000,
);

// The member's own tab keeps its size: an emulated viewport would stay after
// they restore the window, until the grant ends.
test.skipIf(live)(
  "an offered tab whose window is a strip keeps its size",
  async () => {
    await withAgentTabs(
      site(() => ""),
      async ({ origin, act, stripWindow, offer, setup }) => {
        const page = await setup.contexts()[0].newPage();
        await page.goto(origin + "/");
        await offer(page);
        await stripWindow(page);
        const before = await innerSize(page);
        expect(before.height).toBeLessThan(VIEWPORT_FLOOR.height);
        // Every action that runs the check; their outcome is not the point.
        for (const body of [
          { action: "snapshot" },
          { action: "click", selector: "#link" },
          { action: "screenshot" },
        ])
          await act(body);
        expect(await innerSize(page)).toEqual(before);
      },
    );
  },
  120_000,
);
