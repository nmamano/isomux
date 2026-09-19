import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { test, expect } from "bun:test";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { browserExtensionTransport } from "./browser-extension-transport";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Fixture condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "real extension owns only its task tab and drops disconnected work",
  async () => {
    const started = performance.now();
    const dir = mkdtempSync(join(tmpdir(), "isomux-extension-proof-"));
    const fixture = browserExtensionFixture();
    let setup: BrowserContext | undefined;
    let agent: Browser | undefined;
    try {
      await buildBrowserExtension(join(dir, "extension"));
      setup = await chromium.launchPersistentContext(join(dir, "profile"), {
        executablePath: "/usr/bin/google-chrome",
        headless: false,
        args: ["--enable-unsafe-extension-debugging"],
        ignoreDefaultArgs: ["--disable-extensions"],
        timeout: 10_000,
      });
      const setupCDP = await setup.browser()!.newBrowserCDPSession();
      const { id } = await setupCDP.send("Extensions.loadUnpacked", {
        path: join(dir, "extension"),
      });
      const unrelated = await setup.newPage();
      await unrelated.goto(fixture.origin + "/unrelated");
      const extensionPage = await setup.newPage();
      await extensionPage.goto("chrome-extension://" + id + "/connection.html");
      const configure = async () => {
        await extensionPage.evaluate(
          async (config) => {
            // This is an extension-owned setup page, never a task page.
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
        await until(() => !!fixture.bridge.forMember("fixture-member"));
      };
      await configure();
      const connect = () =>
        chromium.connectOverCDP(
          browserExtensionTransport(
            fixture.bridge.forMember("fixture-member")!,
            "fixture-agent",
          ),
          { noDefaults: true, timeout: 5000 },
        );
      const offeredPage = await setup.newPage();
      await offeredPage.goto(fixture.origin + "/form");
      const offer = async () => {
        await offeredPage.bringToFront();
        const session = await setup!.newCDPSession(offeredPage);
        const target = (await session.send("Target.getTargetInfo")).targetInfo.targetId;
        await session.detach();
        const popup = await openExtensionActionPopup(setupCDP, id, target);
        await popup.waitFor('!document.querySelector("#allow").disabled');
        await popup.click("#allow");
        await popup.waitFor('document.querySelector("#allow").checked && !document.querySelector("#allow").disabled');
        await popup.close();
      };
      await offer();
      agent = await connect();
      const context = agent.contexts()[0];
      expect(context.pages()).toHaveLength(1);
      const page = context.pages()[0];
      page.setDefaultTimeout(5000);
      await page.goto(fixture.origin + "/form");
      expect(context.pages()).toHaveLength(1);
      expect(await page.locator("body").ariaSnapshot()).toContain("textbox");
      expect(await page.locator("body").innerText()).toContain("Message");
      await page.getByRole("textbox").fill("extension proof");
      const box = await page.getByRole("button").boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      expect(await page.locator("output").innerText()).toBe("extension proof");
      expect(await page.locator("output").getAttribute("data-trusted")).toBe(
        "true",
      );
      await page.screenshot({ path: join(dir, "task.png") });
      expect(
        readFileSync(join(dir, "task.png")).subarray(0, 8).toString("hex"),
      ).toBe("89504e470d0a1a0a");
      const root = await agent.newBrowserCDPSession();
      const targets = await root.send("Target.getTargets");
      expect(targets.targetInfos).toHaveLength(1);
      expect(targets.targetInfos[0].type).toBe("page");
      expect(
        await context.newPage().then(
          () => false,
          () => true,
        ),
      ).toBe(true);
      expect(
        await root.send("Target.getTargetInfo", { targetId: "unrelated" }).then(
          () => false,
          () => true,
        ),
      ).toBe(true);
      expect(
        await root.send("Storage.getCookies").then(
          () => false,
          () => true,
        ),
      ).toBe(true);

      // The local counter proves the side effect reached the site BEFORE the cut.
      const pending = page
        .evaluate(async () => {
          await fetch("/started", { method: "POST" });
          await new Promise(() => {});
        })
        .then(
          () => "resolved",
          () => "rejected",
        );
      await until(() => fixture.starts() === 1);
      const old = fixture.bridge.forMember("fixture-member")!;
      old.close();
      await until(() => !agent!.isConnected());
      expect(await pending).toBe("rejected");
      await configure();
      expect(fixture.bridge.forMember("fixture-member")!.generation).not.toBe(
        old.generation,
      );
      expect(() => browserExtensionTransport(fixture.bridge.forMember("fixture-member")!, "fixture-agent")).toThrow();
      await offer();
      agent = await connect();
      expect(agent.contexts()[0].pages()).toHaveLength(1);
      const fresh = agent.contexts()[0].pages()[0];
      expect(await fresh.locator("body").ariaSnapshot()).toContain("textbox");
      expect(fixture.starts()).toBe(1);
      // Closing the CDP client ends control, and preserves the real page.
      await agent.close();
      const setupTargets = await setupCDP.send("Target.getTargets");
      expect(
        setupTargets.targetInfos.filter(
          (target) => target.url === fixture.origin + "/form",
        ),
      ).toHaveLength(1);
      expect(
        setupTargets.targetInfos.some(
          (target) => target.url === fixture.origin + "/unrelated",
        ),
      ).toBe(true);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(30_000);
      writeFileSync(
        join(dir, "evidence.json"),
        JSON.stringify(
          {
            date: new Date().toISOString(),
            playwright: "1.62.1",
            chrome: setup.browser()!.version(),
            durationMs: Math.round(elapsed),
            assertions: [
              "real extension loaded",
              "assigned targets only",
              "snapshot and text",
              "fill and trusted mouse click",
              "PNG screenshot",
              "pending rejected after observed side effect",
              "fresh generation; side effect remains one",
              "detach leaves pages open",
            ],
          },
          null,
          2,
        ),
      );
      console.log("Browser extension evidence: " + dir);
    } finally {
      await agent?.close();
      await setup?.close();
      fixture.stop();
      rmSync(join(dir, "profile"), { recursive: true, force: true });
      rmSync(join(dir, "extension"), { recursive: true, force: true });
    }
  },
  60_000,
);
