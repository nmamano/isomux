import { test, expect } from "bun:test";
import { chromium, type Page, type Frame } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchRawExtensionChrome } from "./test-support/raw-extension-chrome";
import { openExtensionActionPopup } from "./test-support/extension-action-popup";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";
import { browserExtensionTransport } from "./browser-extension-transport";
import { buildBrowserExtension } from "../scripts/build-browser-extension";

// Run alone under Xvfb. xwininfo observes native windows, not page contents.
test.skipIf(process.env.ISOMUX_TEST_BROWSER_DIALOGS !== "1")(
  "offered roots, popups and child frames suppress native file pickers and detach restores them",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-dialogs-"));
    const fixture = browserExtensionFixture();
    const [raw] = await Promise.all([
      launchRawExtensionChrome(dir),
      buildBrowserExtension(join(dir, "extension")),
    ]);
    let agent: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    const nativePicker = async () => {
      const deadline = Date.now() + 500;
      for (;;) {
        const probe = Bun.spawn(["xwininfo", "-root", "-tree"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [tree, diagnostic, code] = await Promise.all([
          new Response(probe.stdout).text(),
          new Response(probe.stderr).text(),
          probe.exited,
        ]);
        if (code === 0) return tree.includes('"Open File"');
        // A failed native-window read is never evidence that a dialog is absent.
        if (Date.now() >= deadline)
          throw Error("Native window observation failed: " + diagnostic);
        await Bun.sleep(20);
      }
    };
    const pickerEventually = async (wanted: boolean) => {
      const deadline = Date.now() + 3000;
      do {
        if ((await nativePicker()) === wanted) return;
        await Bun.sleep(50);
      } while (Date.now() < deadline);
      expect(await nativePicker()).toBe(wanted);
    };
    const input =
      '<input id="file" type="file"><output></output><script>file.onchange=()=>document.querySelector("output").textContent=file.files[0]?.name</script>';
    const frames = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(input, {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    try {
      const context = raw.browser.contexts()[0];
      context.setDefaultTimeout(5000);
      const admin = await raw.browser.newBrowserCDPSession();
      const { id } = await admin.send("Extensions.loadUnpacked", {
        path: join(dir, "extension"),
      });
      const config = context.pages()[0] ?? (await context.newPage());
      await config.goto("chrome-extension://" + id + "/connection.html");
      await config.evaluate(
        async (connection) => {
          const extension = (
            globalThis as unknown as {
              chrome: {
                storage: { local: { set(v: unknown): Promise<void> } };
              };
            }
          ).chrome;
          await extension.storage.local.set({ connection });
        },
        {
          url: fixture.extensionURL,
          credential: fixture.credential,
          nonce: crypto.randomUUID(),
        },
      );
      const deadline = Date.now() + 5000;
      while (!fixture.bridge.forMember("fixture-member")) {
        if (Date.now() > deadline) throw Error("Fixture connection timed out");
        await Bun.sleep(20);
      }
      const offered = await context.newPage();
      await offered.goto(frames.url.href);
      await offered.bringToFront();
      const offeredCDP = await context.newCDPSession(offered);
      const target = (await offeredCDP.send("Target.getTargetInfo")).targetInfo
        .targetId;
      await offeredCDP.detach();
      const popup = await openExtensionActionPopup(admin, id, target);
      await popup.waitFor('!document.querySelector("#allow").disabled');
      await popup.click("#allow");
      await popup.waitFor(
        'document.querySelector("#allow").checked && !document.querySelector("#allow").disabled',
      );
      await popup.close();
      const connection = fixture.bridge.forMember("fixture-member")!;
      const grant = connection.offered("fixture-agent")!;
      await connection.drain(grant);
      agent = await chromium.connectOverCDP(
        browserExtensionTransport(
          fixture.bridge.forMember("fixture-member")!,
          "fixture-agent",
        ),
        { noDefaults: true, timeout: 5000 },
      );
      const ownedContext = agent.contexts()[0];
      ownedContext.setDefaultTimeout(5000);
      expect(ownedContext.pages()).toHaveLength(1);
      const root = ownedContext.pages()[0];
      // A separate tab keeps its native picker while this offer is active.
      const unrelated = await context.newPage();
      await unrelated.goto(new URL("/frame", frames.url).href);
      await unrelated.bringToFront();
      await unrelated.locator("#file").click();
      await pickerEventually(true);
      await unrelated
        .locator("#file")
        .setInputFiles({
          name: "fake.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("fixture"),
        });
      expect(await unrelated.locator("output").textContent()).toBe("fake.txt");
      expect(await nativePicker()).toBe(true);
      await unrelated.close();
      await pickerEventually(false);
      const upload = async (scope: Page | Frame, label: string) => {
        await scope.locator("#file").click();
        await Bun.sleep(300);
        expect(await nativePicker(), label + " native picker").toBe(false);
        await scope
          .locator("#file")
          .setInputFiles({
            name: "fake.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("fixture"),
          });
        expect(await scope.locator("output").textContent()).toBe("fake.txt");
        expect(await nativePicker(), label + " after attachment").toBe(false);
      };
      for (const role of ["root", "popup"]) {
        let current = root;
        if (role === "popup") {
          const childPromise = ownedContext.waitForEvent("page", {
            timeout: 5000,
          });
          await root.evaluate((url) => {
            window.open(url, "_blank");
          }, frames.url.href);
          current = await childPromise;
          await current.waitForLoadState("load");
        }
        // No child session can mask a missing top-level interception call.
        expect(current.frames()).toHaveLength(1);
        await upload(current, role);
        await current.evaluate(
          (url) => {
            const iframe = document.createElement("iframe");
            iframe.src = url;
            document.body.append(iframe);
          },
          "http://localhost:" + frames.port + "/frame",
        );
        const frame = await current.locator("iframe").elementHandle();
        const inside = await frame.contentFrame();
        await inside!.locator("#file").waitFor();
        await upload(inside!, role + " child");
      }
      fixture.bridge.forMember("fixture-member")!.revoke("fixture-agent");
      await Bun.sleep(300);
      await offered.bringToFront();
      await offered.locator("#file").click({ timeout: 3000 });
      await pickerEventually(true);
    } finally {
      await agent?.close().catch(() => {});
      await raw.close();
      fixture.stop();
      await frames.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  45_000,
);
