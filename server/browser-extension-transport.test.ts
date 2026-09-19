import { test, expect } from "bun:test";
import { chromium } from "playwright-core";
import { BrowserExtensionBridge } from "./browser-extension-bridge";
import { browserExtensionTransport } from "./browser-extension-transport";

test("public Playwright direct transport initializes and closes without a socket", async () => {
  const bridge = new BrowserExtensionBridge({ memberForCredentialHash: () => "member", mayUse: () => true });
  const connection = bridge.connect("fixture", { send() {}, close() {} });
  const browser = await chromium.connectOverCDP(browserExtensionTransport(connection, "agent"), { noDefaults: true, timeout: 1000 });
  expect(browser.contexts()).toHaveLength(1);
  expect(browser.contexts()[0].pages()).toHaveLength(0);
  const disconnected = new Promise<void>(resolve => browser.once("disconnected", () => resolve()));
  connection.close();
  await disconnected;
  expect(browser.isConnected()).toBe(false);
}, 3000);

test("closing direct transport rejects pending Playwright creation", async () => {
  const bridge = new BrowserExtensionBridge({ memberForCredentialHash: () => "member", mayUse: () => true });
  let created!: () => void;
  const command = new Promise<void>(resolve => { created = resolve; });
  const connection = bridge.connect("fixture", { send(msg) { if (msg.method === "create") created(); }, close() {} });
  const browser = await chromium.connectOverCDP(browserExtensionTransport(connection, "agent"), { noDefaults: true, timeout: 1000 });
  const pending = browser.contexts()[0].newPage().then(() => false, () => true);
  await command;
  connection.close();
  expect(await pending).toBe(true);
}, 3000);

test("direct transport loss rejects Playwright initialization", async () => {
  const bridge = new BrowserExtensionBridge({ memberForCredentialHash: () => "member", mayUse: () => true });
  const connection = bridge.connect("fixture", { send() {}, close() {} });
  const transport = browserExtensionTransport(connection, "agent");
  transport.send = () => connection.close();
  const error: unknown = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 1000 }).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).not.toBe("TimeoutError");
}, 3000);
