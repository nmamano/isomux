import { BROWSER_ACTION_DEADLINE_MS } from "./browser-session";
import { test, expect } from "bun:test";
import { chromium, type BrowserContext } from "playwright-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTestServer, type TestServer } from "./test-support/harness";
import {
  memberRequest,
  ownedAgent,
} from "./test-support/browser-extension-route-fixture";
import { buildPublicOrigin } from "./auth";
import { translatorFor } from "../shared/i18n/translate";
import { getAgentTokenRaw } from "./identity/tokens";

const wait = async (test: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await test()) return;
    await Bun.sleep(50);
  }
  throw new Error("Extension did not connect");
};
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")(
  "real office routes use paired Chrome, separate agents, frames and retained popup opener",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-extension-office-"));
    let setup: BrowserContext | undefined;
    let office: TestServer | undefined;
    let site: ReturnType<typeof Bun.serve> | undefined;
    try {
      expect(BROWSER_ACTION_DEADLINE_MS).toBe(30_000);
      let actionDeadline = BROWSER_ACTION_DEADLINE_MS;
      office = await startTestServer({
        startServer: { browserExtensionActionDeadline: () => actionDeadline },
      });
      const owner = await office.seedOwner();
      const first = await ownedAgent(office, owner, "first");
      const second = await ownedAgent(office, owner, "second");
      const action = async (id: string, body: unknown, tokenId = id) => {
        const response = await office!.http(`/api/agents/${id}/browser`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${getAgentTokenRaw(tokenId)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      setup = await chromium.launchPersistentContext(join(dir, "profile"), {
        executablePath: "/usr/bin/google-chrome", headless: false,
        args: ["--enable-unsafe-extension-debugging"],
        ignoreDefaultArgs: ["--disable-extensions"], timeout: 10_000,
      });
      const { t } = translatorFor("en");
      const officeOrigin = buildPublicOrigin().origin;
      await setup.addCookies([{ name: "isomux_session", value: owner.rawSessionId, url: officeOrigin }]);
      const settings = await setup.newPage();
      await settings.goto(officeOrigin + "/settings");
      await settings.getByRole("button", { name: t("browser.title"), exact: true }).click();
      await settings.getByTestId("browser-backend").selectOption("extension");
      await wait(async () => (await (await memberRequest(office!, owner, "GET", "/api/me/browser")).json()).backend === "extension");
      expect((await action(first.id, { action: "goto", url: "http://localhost/" })).body.error.code).toBe("browser_not_paired");
      const downloadPromise = settings.waitForEvent("download");
      await settings.locator('a[download="isomux-browser.zip"]').click();
      const download = await downloadPromise;
      await download.saveAs(join(dir, "isomux-browser.zip"));
      expect(Bun.spawnSync(["unzip", "-q", join(dir, "isomux-browser.zip"), "-d", join(dir, "extension")]).exitCode).toBe(0);
      await settings.getByTestId("browser-pair").click();
      const code = await settings.getByTestId("browser-code").inputValue();
      const setupCDP = await setup.browser()!.newBrowserCDPSession();
      const { id } = await setupCDP.send("Extensions.loadUnpacked", { path: join(dir, "extension") });
      const openPopup = async (targetId?: string) => {
        if (!targetId) {
          const session = await setup!.newCDPSession(settings);
          targetId = (await session.send("Target.getTargetInfo")).targetInfo.targetId;
          await session.detach();
        }
        const page = setup!.waitForEvent("page");
        await setupCDP.send("Extensions.triggerAction", { id, targetId });
        const opened = await page;
        await opened.waitForURL(`chrome-extension://${id}/connection.html`);
        return opened;
      };
      let popup = await openPopup();
      await popup.locator("#office").fill(officeOrigin);
      await popup.locator("#code").fill(code);
      await popup.locator("#pair").click();
      await popup.locator('#status[data-state="connected"]').waitFor();
      expect(await popup.locator("#member").textContent()).toContain(owner.username);
      await popup.screenshot({ path: join(dir, "extension-connected.png") });
      await popup.close();
      await settings.bringToFront();
      await settings.locator('[data-testid="browser-state"][data-online="true"]').waitFor();
      // Do not preserve a pairing code in evidence, even after redemption.
      await settings.getByTestId("browser-code").evaluate(element => { (element as HTMLInputElement).value = "[redeemed]"; });
      await settings.screenshot({ path: join(dir, "settings-connected.png") });
      site = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          const html =
            url.pathname === "/popup"
              ? '<title>Popup</title><button onclick="window.close()">Return</button>'
              : url.pathname === "/frame"
                ? "<label>Frame field<input></label>"
                : `<title>Main</title><label>Message<input id="message"></label><button id="open" onclick="window.open('/popup')">Open</button><output id="out"></output><button id="apply" onclick="document.querySelector('#out').textContent=document.querySelector('#message').value">Apply</button><iframe src="/frame"></iframe><iframe src="http://127.0.0.1:${url.port}/frame"></iframe>`;
          return new Response(html, {
            headers: { "Content-Type": "text/html" },
          });
        },
      });
      const url = `http://localhost:${site.port}/main`;
      expect((await action(first.id, { action: "goto", url })).status).toBe(
        200,
      );
      expect((await action(second.id, { action: "goto", url })).status).toBe(
        200,
      );
      expect(
        (await action(first.id, { action: "text" }, second.id)).status,
      ).toBe(403);
      expect(
        (
          await action(first.id, {
            action: "fill",
            selector: "#message",
            text: "first tab",
          })
        ).status,
      ).toBe(200);
      expect(
        (await action(first.id, { action: "click", selector: "#apply" }))
          .status,
      ).toBe(200);
      expect((await action(first.id, { action: "text" })).body.text).toContain(
        "first tab",
      );
      expect(
        (await action(second.id, { action: "text" })).body.text,
      ).not.toContain("first tab");
      expect(
        (
          await action(first.id, {
            action: "fill",
            selector:
              "iframe >> nth=0 >> internal:control=enter-frame >> input",
            text: "same",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await action(first.id, {
            action: "fill",
            selector:
              "iframe >> nth=1 >> internal:control=enter-frame >> input",
            text: "cross",
          })
        ).status,
      ).toBe(200);
      const snapshot = await action(first.id, { action: "snapshot" });
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.snapshot).toContain("textbox");
      expect((await action(first.id, { action: "screenshot" })).status).toBe(
        200,
      );
      expect(
        (await action(first.id, { action: "click", selector: "#open" })).status,
      ).toBe(200);
      await wait(
        async () =>
          (await action(first.id, { action: "text" })).body.title === "Popup",
      );
      expect(
        (await action(first.id, { action: "click", selector: "button" }))
          .status,
      ).toBe(200);
      expect((await action(first.id, { action: "text" })).body.title).toBe(
        "Main",
      );
      const taskTargets = (await setupCDP.send("Target.getTargets")).targetInfos.filter(target => target.url === url);
      popup = await openPopup(taskTargets[0].targetId);
      await popup.locator("#assignments section").first().waitFor();
      expect(await popup.locator("#assignments").textContent()).toContain("first");
      expect(await popup.locator("#assignments").textContent()).toContain("second");
      const firstRow = popup.locator("#assignments section").filter({ has: popup.locator("p", { hasText: /^first$/ }) });
      const badge = await popup.evaluate(async () => {
        const c = (globalThis as unknown as { chrome: { runtime: { sendMessage(v: unknown): Promise<{ assignments: { agent: { name: string }; tabId: number }[] }> }; action: { getBadgeText(v: { tabId: number }): Promise<string> } } }).chrome;
        const state = await c.runtime.sendMessage({ action: "state" });
        const tab = state.assignments.find(a => a.agent.name === "first")!;
        return { tabId: tab.tabId, text: await c.action.getBadgeText({ tabId: tab.tabId }) };
      });
      expect(badge.text).toBe("CTRL");
      await popup.screenshot({ path: join(dir, "extension-control.png") });
      await firstRow.locator('[data-action="focus"]').click();
      await wait(async () => setup!.serviceWorkers()[0].evaluate(async tabId => {
        const c = (globalThis as unknown as { chrome: { tabs: { query(v: unknown): Promise<{ id: number }[]> } } }).chrome;
        return (await c.tabs.query({ active: true, lastFocusedWindow: true })).some(tab => tab.id === tabId);
      }, badge.tabId));
      if (!popup.isClosed()) await popup.close();
      popup = await openPopup(taskTargets[0].targetId);
      const stop = popup.locator("#assignments section").filter({ has: popup.locator("p", { hasText: /^first$/ }) }).locator('[data-action="stop"]');
      await stop.click();
      await wait(async () => (await popup.locator("#assignments section").count()) === 1);
      await popup.screenshot({ path: join(dir, "extension-stopped.png") });
      expect(await popup.evaluate(async tabId => (globalThis as unknown as { chrome: { action: { getBadgeText(v: { tabId: number }): Promise<string> } } }).chrome.action.getBadgeText({ tabId }), badge.tabId)).toBe("ON");
      expect((await setupCDP.send("Target.getTargets")).targetInfos.filter(target => target.url === url)).toHaveLength(2);
      await popup.locator("#disconnect").click();
      await popup.locator('#status[data-state="disabled"]').waitFor();
      expect((await action(second.id, { action: "text" })).body.error.code).toBe("browser_offline");
      await popup.locator("#reconnect").click();
      await popup.locator('#status[data-state="connected"]').waitFor();
      // Recovery starts a fresh task tab; prior pages remain open.
      expect((await action(second.id, { action: "goto", url })).status).toBe(200);

      expect((await action(second.id, { action: "text" })).status).toBe(200);
      const targets = await setupCDP.send("Target.getTargets");
      expect(
        targets.targetInfos.filter((target) => target.url === url),
      ).toHaveLength(3);
      actionDeadline = 100;
      expect(
        (
          await action(second.id, {
            action: "fill",
            selector: "#missing-timeout-fixture",
            text: "unused",
          })
        ).body.error.code,
      ).toBe("browser_control_ended");
      await popup.locator("#unpair").click();
      await popup.locator('#status[data-state="unpaired"]').waitFor();
      expect((await (await memberRequest(office, owner, "GET", "/api/me/browser")).json()).paired).toBe(false);
      await popup.screenshot({ path: join(dir, "extension-unpaired.png") });
      writeFileSync(join(dir, "evidence.json"), JSON.stringify({ date: "2026-09-19", packaged: true, member: owner.username, agents: ["first", "second"], actionPopup: true, badge, retainedTabs: 3, disconnectReconnect: true, unpaired: true }));
      console.log("Extension evidence:", dir);
      expect(
        (await action(second.id, { action: "text" })).body.error.code,
      ).toBe("browser_not_paired");
    } finally {
      await setup?.close();
      await office?.stop();
      await site?.stop(true);
      rmSync(join(dir, "profile"), { recursive: true, force: true });
    }
  },
  60_000,
);
