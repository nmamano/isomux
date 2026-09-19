import { test, expect } from "bun:test";
import { chromium } from "playwright-core";
import { BrowserExtensionBridge, type ExtensionConnection } from "./browser-extension-bridge";
import { browserExtensionTransport } from "./browser-extension-transport";
import { fields, type Fields } from "../shared/browser-extension-protocol";

async function offered() {
  const bridge = new BrowserExtensionBridge({ memberForCredentialHash: () => "member", mayUse: () => true });
  let hold = false;
  let pending!: () => void;
  const started = new Promise<void>(resolve => { pending = resolve; });
  const messages: Fields[] = [];
  const connection: ExtensionConnection = bridge.connect("fixture", {
    send(msg) {
      messages.push(msg);
      if (msg.kind !== "command" || msg.method === "detach") return;
      if (hold) { pending(); return; }
      const params = fields(msg.params);
      const result = msg.method === "attach"
        ? { targetInfo: { type: "page", browserContextId: "context", targetId: "owned", url: "https://example.com/" } }
        : params.method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "owned", loaderId: "loader", url: "https://example.com/", securityOrigin: "https://example.com", mimeType: "text/html" } } }
          : {};
      queueMicrotask(() => connection.receive({ kind: "result", generation: connection.generation, id: msg.id, result }));
    },
    close() {},
  });
  connection.receive({ kind: "offer", durationMinutes: 0, generation: connection.generation, assignment: crypto.randomUUID(), agent: "agent" });
  await Promise.resolve(); await Promise.resolve();
  return { connection, messages, started, hold: () => { hold = true; } };
}

test("public Playwright transport initializes the offered page and cannot create another", async () => {
  const h = await offered();
  const browser = await chromium.connectOverCDP(browserExtensionTransport(h.connection, "agent"), { noDefaults: true, timeout: 1000 });
  expect(browser.contexts()).toHaveLength(1);
  expect(browser.contexts()[0].pages()).toHaveLength(1);
  expect(browser.contexts()[0].pages()[0].url()).toBe("https://example.com/");
  expect(await browser.contexts()[0].newPage().then(() => false, () => true)).toBe(true);
  expect(h.messages.some(m => m.method === "create")).toBe(false);
  await browser.close();
  expect(h.connection.offered("agent")).toBeUndefined();
  h.connection.close();
}, 3000);

test("Off rejects a pending Playwright command without replay", async () => {
  const h = await offered();
  const browser = await chromium.connectOverCDP(browserExtensionTransport(h.connection, "agent"), { noDefaults: true, timeout: 1000 });
  h.hold();
  const result = browser.contexts()[0].pages()[0].goto("https://example.com/next").then(() => false, () => true);
  await h.started;
  h.connection.revoke("agent");
  expect(await result).toBe(true);
  expect(() => browserExtensionTransport(h.connection, "agent")).toThrow();
  h.connection.close();
}, 3000);

test("direct transport loss rejects Playwright initialization", async () => {
  const h = await offered();
  const transport = browserExtensionTransport(h.connection, "agent");
  transport.send = () => h.connection.close();
  const error: unknown = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 1000 }).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).not.toBe("TimeoutError");
}, 3000);
