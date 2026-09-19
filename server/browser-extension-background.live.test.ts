import { test, expect } from "bun:test";
import { chromium, type Browser, type BrowserContext, type ConnectOverCDPTransport } from "playwright-core";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { browserExtensionFixture } from "./test-support/browser-extension-fixture";
import { browserExtensionTransport } from "./browser-extension-transport";

test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "owned background roots and popups click without activating tabs and disable emulation on detach",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-background-proof-"));
    const fixture = browserExtensionFixture();
    let setup: BrowserContext | undefined;
    let agent: Browser | undefined;
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    let setupBrowser: Browser | undefined;
    const evidence: unknown[] = [];
    try {
      await buildBrowserExtension(join(dir, "extension"));
      chrome = Bun.spawn([
        "/usr/bin/google-chrome", "--no-sandbox", "--no-first-run",
        "--no-default-browser-check", "--disable-dev-shm-usage",
        "--enable-unsafe-extension-debugging", "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + join(dir, "profile"),
      ], { stdout: "ignore", stderr: "ignore" });
      const portFile = join(dir, "profile", "DevToolsActivePort");
      const launchDeadline = Date.now() + 10_000;
      while (!existsSync(portFile)) {
        if (Date.now() >= launchDeadline) throw new Error("Isolated Chrome did not start");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
      const socket = new WebSocket("ws://127.0.0.1:" + port + path);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Isolated CDP socket did not open")), 5000);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error("Isolated CDP socket failed")); };
      });
      const adminTransport: ConnectOverCDPTransport = {
        send: message => socket.send(JSON.stringify(message)),
        close: () => socket.close(),
      };
      socket.onmessage = event => adminTransport.onmessage?.(JSON.parse(String(event.data)));
      socket.onclose = () => adminTransport.onclose?.();
      setupBrowser = await chromium.connectOverCDP(adminTransport, { noDefaults: true, timeout: 5000 });
      setup = setupBrowser.contexts()[0];
      const admin = await setup.browser()!.newBrowserCDPSession();
      const { id } = await admin.send("Extensions.loadUnpacked", { path: join(dir, "extension") });
      const unrelated = await setup.newPage();
      await unrelated.goto(fixture.origin + "/unrelated");
      const extensionPage = await setup.newPage();
      await extensionPage.goto("chrome-extension://" + id + "/connection.html");
      await extensionPage.evaluate(async config => {
        const extensionChrome = (globalThis as unknown as {
          chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
        }).chrome;
        await extensionChrome.storage.local.set({ connection: config });
      }, { url: fixture.extensionURL, credential: fixture.credential, nonce: crypto.randomUUID() });
      const deadline = Date.now() + 5000;
      while (!fixture.bridge.forMember("fixture-member")) {
        if (Date.now() >= deadline) throw new Error("Fixture connection did not settle");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const worker = setup.serviceWorkers().find(w => w.url().endsWith("/background.js"))!;
      expect(worker).toBeDefined();
      await worker.evaluate(() => {
        const g = globalThis as unknown as {
          chrome: { debugger: {
            attach(target: { tabId: number }, version: string): Promise<void>;
            sendCommand(target: { tabId: number }, method: string, params?: Record<string, unknown>): Promise<unknown>;
          } };
          beforeFocus: Array<{ tabId: number; state: unknown }>;
        };
        g.beforeFocus = [];
        const attach = g.chrome.debugger.attach.bind(g.chrome.debugger);
        const send = g.chrome.debugger.sendCommand.bind(g.chrome.debugger);
        g.chrome.debugger.attach = async (target, version) => {
          await attach(target, version);
          const state = await send(target, "Runtime.evaluate", {
            expression: "JSON.stringify({focused:document.hasFocus(),visibility:document.visibilityState})",
            userGesture: false, returnByValue: true,
          });
          g.beforeFocus.push({ tabId: target.tabId, state });
        };
      });
      // noDefaults on this administrator is essential: normal Playwright
      // initialization emulates focus on all pages and would mask this defect.
      const state = () => ({ visibility: document.visibilityState, focused: document.hasFocus() });
      await extensionPage.bringToFront();
      const backgroundState = await unrelated.evaluate(state);
      expect(backgroundState).toEqual({ visibility: "hidden", focused: false });
      await unrelated.bringToFront();
      const unrelatedBefore = await unrelated.evaluate(state);
      const inventory = () => extensionPage.evaluate(async () => {
        const chrome = (globalThis as unknown as { chrome: {
          tabs: { query(query: object): Promise<Array<{ id: number; active: boolean; windowId: number }>> };
          debugger: { getTargets(): Promise<Array<{ id: string; tabId?: number }>> };
        } }).chrome;
        return { tabs: await chrome.tabs.query({}), targets: await chrome.debugger.getTargets() };
      });
      const initial = await inventory();
      const activeTabs = (value: Awaited<ReturnType<typeof inventory>>) => value.tabs.filter(t => t.active).map(t => ({ id: t.id, windowId: t.windowId }));
      const activeBefore = activeTabs(initial);
      agent = await chromium.connectOverCDP(
        browserExtensionTransport(fixture.bridge.forMember("fixture-member")!, "fixture-agent"),
        { noDefaults: true, timeout: 5000 },
      );
      const context = agent.contexts()[0];
      expect(context.pages()).toHaveLength(0);
      const rootPage = await context.newPage();
      await rootPage.goto(fixture.origin + "/form", { timeout: 5000 });
      const root = await agent.newBrowserCDPSession();
      const ownedTargets = await root.send("Target.getTargets");
      expect(ownedTargets.targetInfos).toHaveLength(1);
      const rootId = ownedTargets.targetInfos[0].targetId;
      const pages = [rootPage];
      const taskTabIds: number[] = [];
      for (const role of ["root", "popup"] as const) {
        if (role === "popup") {
          const popup = context.waitForEvent("page", { timeout: 5000 });
          await rootPage.evaluate(() => { window.open("/form", "_blank"); });
          pages.push(await popup);
          await pages[1].waitForLoadState("load", { timeout: 5000 });
          await unrelated.bringToFront();
        }
        const page = pages.at(-1)!;
        await page.evaluate(role => {
          document.body.dataset.role = role;
          document.body.dataset.clicks = "0";
          document.querySelector("#apply")!.addEventListener("click", () => {
            document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1);
          });
        }, role);
        const targets = await root.send("Target.getTargets");
        expect(targets.targetInfos).toHaveLength(role === "root" ? 1 : 2);
        const target = targets.targetInfos.find(t => role === "root" ? t.targetId === rootId : t.targetId !== rootId)!;
        expect((await admin.send("Target.getTargetInfo", { targetId: target.targetId })).targetInfo.url).toBe(page.url());
        const before = await inventory();
        const tabId = before.targets.find(t => t.id === target.targetId)?.tabId;
        expect(tabId).toBeNumber();
        taskTabIds.push(tabId!);
        if (role === "root") {
          const snapshot = await worker.evaluate(tabId => {
            const snapshots = (globalThis as unknown as { beforeFocus: Array<{ tabId: number; state: { result: { value: string } } }> }).beforeFocus;
            return snapshots.find(s => s.tabId === tabId) ?? null;
          }, tabId!);
          expect(snapshot).not.toBeNull();
          const beforeEnable = JSON.parse(snapshot!.state.result.value) as { visibility: string; focused: boolean };
          expect(beforeEnable.visibility).toBe("hidden");
          evidence.push({ beforeEnable, tabId });
        }
        expect(before.tabs.find(t => t.id === tabId)?.active).toBe(false);
        expect(activeTabs(before)).toEqual(activeBefore);
        expect(await unrelated.evaluate(state)).toEqual(unrelatedBefore);
        const controlled = await page.evaluate(state);
        expect(await page.evaluate(() => document.body.dataset.clicks)).toBe("0");
        let error: string | undefined;
        try {
          await page.click("#apply", { timeout: 3000 });
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        const clicks = await page.evaluate(() => document.body.dataset.clicks);
        const after = await inventory();
        evidence.push({ role, target: target.targetId, tabId, controlled, clicks, error, activeBefore: activeTabs(before), activeAfter: activeTabs(after) });
        expect(error).toBeUndefined();
        expect(clicks).toBe("1");
        expect(controlled.focused).toBe(true);
        expect(controlled.visibility).toBe("visible");
        expect(activeTabs(after)).toEqual(activeBefore);
        expect(await unrelated.evaluate(state)).toEqual(unrelatedBefore);
      }
      await agent.close();
      agent = undefined;
      const retained = setup.pages().filter(p => p.url() === fixture.origin + "/form");
      expect(retained).toHaveLength(2);
      // Native CDP input can leave hasFocus=true even without emulation.
      // The 2026-09-19 native-only probe had no DOM click, so it proves no
      // delivered action. Check override cleanup and debugger ownership here.
      for (const page of retained) {
        const role = await page.evaluate(() => document.body.dataset.role);
        const tabId = taskTabIds[role === "root" ? 0 : 1];
        const detached = () => extensionPage.evaluate(async tabId => {
          const chrome = (globalThis as unknown as { chrome: { debugger: {
            sendCommand(target: { tabId: number }, method: string, params: object): Promise<unknown>;
          } } }).chrome;
          try {
            await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "0", userGesture: false });
            return false;
          } catch (error) {
            return String(error).includes("Debugger is not attached");
          }
        }, tabId);
        const deadline = Date.now() + 5000;
        let isDetached = await detached();
        while (!isDetached && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
          isDetached = await detached();
        }
        expect(isDetached).toBe(true);
        const released = await page.evaluate(state);
        expect(released.visibility).toBe(backgroundState.visibility);
        expect(await page.evaluate(() => document.body.dataset.clicks)).toBe("1");
        evidence.push({ released, role, isDetached });
      }
      const afterDetach = await inventory();
      expect(taskTabIds.every(id => afterDetach.tabs.some(tab => tab.id === id))).toBe(true);
      expect(activeTabs(afterDetach)).toEqual(activeBefore);
      expect(await unrelated.evaluate(state)).toEqual(unrelatedBefore);
    } finally {
      writeFileSync(join(dir, "evidence.json"), JSON.stringify({ date: new Date().toISOString(), evidence }, null, 2));
      console.log("Background action evidence: " + dir);
      await agent?.close();
      await setupBrowser?.close();
      chrome?.kill();
      if (chrome) await chrome.exited;
      fixture.stop();
      rmSync(join(dir, "profile"), { recursive: true, force: true });
      rmSync(join(dir, "extension"), { recursive: true, force: true });
    }
  },
  60_000,
);
