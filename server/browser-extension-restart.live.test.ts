import { launchRawExtensionChrome } from "./test-support/raw-extension-chrome";
import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";
import type { ExtensionBrowserSessions } from "./browser-extension-session";

async function until(what: string, ok: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() >= deadline) throw new Error(what);
    await Bun.sleep(20);
  }
}

// Task 2c1c81ff: an office restart drops every bridge object. A new fixture
// on the same port with the same credential is that restart: the extension
// reconnects by itself and resumes the offer the member made before it.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "after an office restart the agent's next read with the old target works, with no member step",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-restart-resume-"));
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          "<!doctype html><title>Resume fixture</title><p>resume fixture body</p>",
          { headers: { "Content-Type": "text/html" } },
        ),
    });
    let fixture = browserExtensionFixture();
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
        { url: fixture.extensionURL, credential: fixture.credential },
      );
      const first = fixture;
      await until(
        "Fixture connection did not settle",
        () => !!first.bridge.connections("fixture-member")[0],
        5000,
      );
      const offered = await setup.newPage();
      await offered.goto(site.url.href);
      await offered.bringToFront();
      const offeredCDP = await setup.newCDPSession(offered);
      const tabTarget = (await offeredCDP.send("Target.getTargetInfo"))
        .targetInfo.targetId;
      await offeredCDP.detach();
      const popup = await openExtensionActionPopup(admin, id, tabTarget, setup);
      await popup.waitFor('!document.querySelector("#allow").disabled');
      await popup.click("#allow");
      await popup.waitFor(
        'document.querySelector("#allow").checked && !document.querySelector("#allow").disabled && !!document.querySelector("#expiry-state").textContent',
      );
      await popup.close();
      const connection = first.bridge.connections("fixture-member")[0];
      await connection.drain(connection.offered("fixture-agent")!);
      sessions = first.sessions(5000);
      const listed = await sessions.run("fixture-agent", { action: "tabs" });
      expect(listed.ok).toBe(true);
      const target = listed.ok ? listed.tabs![0].target : "";
      const before = await sessions.run("fixture-agent", {
        action: "text",
        target,
      });
      expect(before.ok && before.text).toContain("resume fixture body");

      // The restart: the old office process is gone, a new one listens.
      sessions.stop();
      sessions = undefined;
      const { port, credential } = first;
      first.stop();
      for (let i = 0; ; i++)
        try {
          fixture = browserExtensionFixture({ port, credential });
          break;
        } catch (error) {
          if (i >= 50) throw error;
          await Bun.sleep(20);
        }
      const second = fixture;
      expect(second.bridge).not.toBe(first.bridge);
      await until(
        "The extension did not reconnect to the new office",
        () => !!second.bridge.connections("fixture-member")[0],
        10_000,
      );
      await until(
        "The offer did not resume after the reconnect",
        () =>
          second.bridge.targets("fixture-member", "fixture-agent").length > 0,
        5000,
      );
      expect(
        second.bridge
          .targets("fixture-member", "fixture-agent")
          .map((t) => t.target),
      ).toEqual([target]);
      sessions = second.sessions(5000);
      const after = await sessions.run("fixture-agent", {
        action: "text",
        target,
      });
      expect(after.ok ? after.text : after).toContain("resume fixture body");
    } finally {
      sessions?.stop();
      await raw?.close();
      fixture.stop();
      void site.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
