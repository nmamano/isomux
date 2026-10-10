import { launchRawExtensionChrome } from "./test-support/raw-extension-chrome";
import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";
import { ExtensionBrowserSessions } from "./browser-extension-session";
import type { BrowserExtensionService } from "./browser-extension-service";
import type { BrowserResult } from "./browser-actions";
import type { Page } from "playwright-core";

async function startChrome() {
  const dir = mkdtempSync(join(tmpdir(), "isomux-interactions-"));
  const fixture = browserExtensionFixture();
  let raw: Awaited<ReturnType<typeof launchRawExtensionChrome>> | undefined;
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
    await extensionPage.evaluate(
      async (config) => {
        const extensionChrome = (
          globalThis as unknown as {
            chrome: {
              storage: { local: { set(value: unknown): Promise<void> } };
            };
          }
        ).chrome;
        await extensionChrome.storage.local.set({ connection: config });
      },
      {
        url: fixture.extensionURL,
        credential: fixture.credential,
        nonce: crypto.randomUUID(),
      },
    );
    const deadline = Date.now() + 5000;
    while (!fixture.bridge.connections("fixture-member")[0]) {
      if (Date.now() >= deadline)
        throw new Error("Fixture connection did not settle");
      await Bun.sleep(20);
    }
    return {
      raw,
      setup,
      admin,
      id,
      fixture,
      close: async () => {
        await raw!.close();
        fixture.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await raw?.close();
    fixture.stop();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

let chrome: Awaited<ReturnType<typeof startChrome>>;
beforeAll(async () => {
  if (process.env.ISOMUX_TEST_BROWSER_EXTENSION === "1")
    chrome = await startChrome();
}, 30_000);
afterAll(async () => {
  await chrome?.close();
});

// Poll observations under a bound, then let the caller assert the actual state.
async function observe(predicate: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
}

type Site = (url: URL) => Response | Promise<Response>;
// Each case offers a fresh tab through the real action popup.
async function withOfferedTab(
  site: Site,
  run: (h: {
    act: (body: Record<string, unknown>) => Promise<Timed>;
    setupPage: Page;
    grant: () => string | undefined;
    recoveryEvents: string[];
    turnOff: () => Promise<void>;
  }) => Promise<void>,
  deadlineMs = 5000,
) {
  const { setup, admin, id, fixture } = chrome;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => site(new URL(req.url)),
  });
  const connection = fixture.bridge.connections("fixture-member")[0];
  const receive = connection.receive.bind(connection);
  let sessions: ExtensionBrowserSessions | undefined;
  let offered: Page | undefined;
  try {
    offered = await setup.newPage();
    await offered.goto(server.url.href);
    await offered.bringToFront();
    const offeredCDP = await setup.newCDPSession(offered);
    const target = (await offeredCDP.send("Target.getTargetInfo")).targetInfo
      .targetId;
    await offeredCDP.detach();
    const popup = await openExtensionActionPopup(admin, id, target);
    await popup.waitFor('!document.querySelector("#allow").disabled');
    try {
      await popup.click("#allow");
      await observe(() => !!connection.offered("fixture-agent"));
      expect(connection.offered("fixture-agent")).toBeDefined();
    } finally {
      await popup.close();
    }
    const recoveryEvents: string[] = [];
    connection.receive = (message: unknown) => {
      const event = message as { kind?: string; method?: string };
      if (
        event.kind === "event" &&
        (event.method === "recovering" || event.method === "recovered")
      )
        recoveryEvents.push(event.method);
      receive(message);
    };
    await connection.drain(connection.offered("fixture-agent")!);
    const owned = new ExtensionBrowserSessions(
      {
        bridge: fixture.bridge,
        store: { paired: () => true },
      } as unknown as BrowserExtensionService,
      () => "fixture-member",
      () => true,
      () => deadlineMs,
    );
    sessions = owned;
    await run({
      setupPage: offered,
      grant: () => connection.offered("fixture-agent"),
      recoveryEvents,
      turnOff: async () => {
        await offered!.bringToFront();
        const popup = await openExtensionActionPopup(admin, id, target);
        await popup.waitFor(
          'document.querySelector("#allow").checked && !document.querySelector("#allow").disabled',
        );
        try {
          // Off is complete when the office releases the grant. The popup is
          // not part of that contract and need not stay open for another read.
          await popup.click("#allow");
          await observe(() => !connection.offered("fixture-agent"));
          expect(connection.offered("fixture-agent")).toBeUndefined();
        } finally {
          await popup.close();
        }
      },
      act: async (body) => {
        const started = performance.now();
        const result = await owned.run("fixture-agent", body);
        const elapsed = Math.round(performance.now() - started);
        console.log(
          "Action:",
          JSON.stringify({
            action: body.action,
            ok: result.ok,
            code: result.ok ? undefined : result.code,
            elapsed,
          }),
        );
        return { result, elapsed };
      },
    });
  } finally {
    sessions?.stop();
    connection.receive = receive;
    await offered?.close();
    void server.stop(true);
  }
}

const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });

type Timed = { result: BrowserResult; elapsed: number };

for (const stop of ["tab close", "member Off"] as const) {
  test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
    `custom-protocol click keeps the same grant; ${stop} releases it`,
    async () => {
      await withOfferedTab(
        (url) =>
          url.pathname === "/frame"
            ? html('<p id="inside">frame available</p>')
            : html(
                `<a id="launch" href="#" onclick="location.href='x-proto://launch';return false">Launch</a><p id="status">available</p><iframe src="http://localhost:${url.port}/frame"></iframe>`,
              ),
        async ({ act, grant, setupPage, turnOff, recoveryEvents }) => {
          expect(
            (await act({ action: "text", selector: "#status" })).result,
          ).toMatchObject({ ok: true, text: "available" });
          expect(
            (await act({ action: "text", framePath: [0], selector: "#inside" }))
              .result,
          ).toMatchObject({ ok: true, text: "frame available" });
          const original = grant();
          expect(typeof original).toBe("string");
          const click = await act({ action: "click", selector: "#launch" });
          // If detach precedes the click response, its outcome is unknown.
          // A following read must use the same grant after the bounded recovery.
          await observe(() => recoveryEvents.includes("recovering"));
          console.log("Recovery events after click", recoveryEvents);
          expect(recoveryEvents).toContain("recovering");
          if (!click.result.ok) expect(click.result.code).toBe("action_failed");
          expect(grant()).toBe(original);
          expect(
            (await act({ action: "text", selector: "#status" })).result,
          ).toMatchObject({ ok: true, text: "available" });
          expect(grant()).toBe(original);
          expect(
            (await act({ action: "text", framePath: [0], selector: "#inside" }))
              .result,
          ).toMatchObject({ ok: true, text: "frame available" });
          console.log("Recovery events after read", recoveryEvents);
          expect(recoveryEvents).toEqual(["recovering", "recovered"]);
          if (stop === "tab close") await setupPage.close();
          else await turnOff();
          const deadline = Date.now() + 3000;
          while (grant() && Date.now() < deadline) await Bun.sleep(20);
          expect(grant()).toBeUndefined();
          expect(
            (await act({ action: "text", selector: "#status" })).result,
          ).toMatchObject({ ok: false, code: "browser_control_ended" });
        },
      );
    },
    30_000,
  );
}
