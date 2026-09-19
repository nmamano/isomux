import { test, expect } from "bun:test";
import { chromium, type BrowserContext } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTestServer, type TestServer } from "./test-support/harness";
import { memberRequest, ownedAgent } from "./test-support/browser-extension-route-fixture";
import { buildBrowserExtension } from "../scripts/build-browser-extension";
import { buildPublicOrigin } from "./auth";
import { getAgentTokenRaw } from "./identity/tokens";

const wait = async (test: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await test()) return; await Bun.sleep(50); }
  throw new Error("Extension did not connect");
};
test.skipIf(process.env.ISOMUX_TEST_BROWSER_EXTENSION !== "1")("real office routes use paired Chrome, separate agents, frames and retained popup opener", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isomux-extension-office-"));
  let setup: BrowserContext | undefined;
  let office: TestServer | undefined;
  let site: ReturnType<typeof Bun.serve> | undefined;
  try {
    office = await startTestServer();
    const owner = await office.seedOwner();
    const first = await ownedAgent(office, owner, "first");
    const second = await ownedAgent(office, owner, "second");
    const action = async (id: string, body: unknown, tokenId = id) => {
      const response = await office!.http(`/api/agents/${id}/browser`, { method: "POST", headers: { Authorization: `Bearer ${getAgentTokenRaw(tokenId)}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    await memberRequest(office, owner, "PATCH", "/api/me/browser", { backend: "extension" });
    expect((await action(first.id, { action: "goto", url: "http://localhost/" })).body.error.code).toBe("browser_not_paired");
    const { code } = await (await memberRequest(office, owner, "POST", "/api/me/browser/pair", {})).json();
    await buildBrowserExtension(join(dir, "extension"));
    setup = await chromium.launchPersistentContext(join(dir, "profile"), { executablePath: "/usr/bin/google-chrome", headless: false, args: ["--enable-unsafe-extension-debugging"], ignoreDefaultArgs: ["--disable-extensions"], timeout: 10_000 });
    const setupCDP = await setup.browser()!.newBrowserCDPSession();
    const { id } = await setupCDP.send("Extensions.loadUnpacked", { path: join(dir, "extension") });
    const config = await setup.newPage();
    await config.goto(`chrome-extension://${id}/connection.html`);
    await config.evaluate(async (connection) => {
      await (globalThis as unknown as { chrome: { storage: { local: { set(value: unknown): Promise<void> } } } }).chrome.storage.local.set({ connection });
    }, { url: buildPublicOrigin().origin.replace("http:", "ws:") + "/browser-extension/ws", code });
    await wait(async () => (await (await memberRequest(office!, owner, "GET", "/api/me/browser")).json()).online === true);
    site = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch(req) {
      const url = new URL(req.url);
      const html = url.pathname === "/popup" ? '<title>Popup</title><button onclick="window.close()">Return</button>' : url.pathname === "/frame" ? '<label>Frame field<input></label>' : `<title>Main</title><label>Message<input id="message"></label><button id="open" onclick="window.open('/popup')">Open</button><output id="out"></output><button id="apply" onclick="document.querySelector('#out').textContent=document.querySelector('#message').value">Apply</button><iframe src="/frame"></iframe><iframe src="http://127.0.0.1:${url.port}/frame"></iframe>`;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    } });
    const url = `http://localhost:${site.port}/main`;
    expect((await action(first.id, { action: "goto", url })).status).toBe(200);
    expect((await action(second.id, { action: "goto", url })).status).toBe(200);
    expect((await action(first.id, { action: "text" }, second.id)).status).toBe(403);
    expect((await action(first.id, { action: "fill", selector: "#message", text: "first tab" })).status).toBe(200);
    expect((await action(first.id, { action: "click", selector: "#apply" })).status).toBe(200);
    expect((await action(first.id, { action: "text" })).body.text).toContain("first tab");
    expect((await action(second.id, { action: "text" })).body.text).not.toContain("first tab");
    expect((await action(first.id, { action: "fill", selector: 'iframe >> nth=0 >> internal:control=enter-frame >> input', text: "same" })).status).toBe(200);
    expect((await action(first.id, { action: "fill", selector: 'iframe >> nth=1 >> internal:control=enter-frame >> input', text: "cross" })).status).toBe(200);
    const snapshot = await action(first.id, { action: "snapshot" });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.snapshot).toContain("textbox");
    expect((await action(first.id, { action: "screenshot" })).status).toBe(200);
    expect((await action(first.id, { action: "click", selector: "#open" })).status).toBe(200);
    await wait(async () => (await action(first.id, { action: "text" })).body.title === "Popup");
    expect((await action(first.id, { action: "click", selector: "button" })).status).toBe(200);
    expect((await action(first.id, { action: "text" })).body.title).toBe("Main");
    expect((await action(first.id, { action: "close" })).body.closed).toBe(true);
    expect((await action(second.id, { action: "text" })).status).toBe(200);
    const targets = await setupCDP.send("Target.getTargets");
    expect(targets.targetInfos.filter((target) => target.url === url)).toHaveLength(2);
    expect((await action(second.id, { action: "fill", selector: "#missing-timeout-fixture", text: "unused" })).body.error.code).toBe("browser_control_ended");
    expect((await memberRequest(office, owner, "DELETE", "/api/me/browser")).status).toBe(204);
    expect((await action(second.id, { action: "text" })).body.error.code).toBe("browser_not_paired");
  } finally { await setup?.close(); await office?.stop(); await site?.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
