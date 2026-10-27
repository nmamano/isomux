import { test, expect } from "bun:test";
import { chromium } from "playwright-core";
import {
  BrowserExtensionBridge,
  type ExtensionConnection,
} from "./browser-extension-bridge";
import { browserExtensionTransport } from "./browser-extension-transport";
import { fields, type Fields } from "../shared/browser-extension-protocol";

// mainFrame is the tab's main frame id in Chrome's frame tree. It differs
// from the target id after Chrome activates a prerendered page in the tab. A
// popup's main frame id is its target id.
async function offered(mainFrame = "owned") {
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: () => "member",
    mayUse: () => true,
  });
  const messages: Fields[] = [];
  const connection: ExtensionConnection = bridge.connect("fixture", {
    send(msg) {
      messages.push(msg);
      if (msg.kind !== "command" || msg.method === "detach") return;
      const params = fields(msg.params);
      const result =
        msg.method === "attach"
          ? {
              targetInfo: {
                type: "page",
                browserContextId: "context",
                targetId: "owned",
                url: "https://example.com/",
              },
            }
          : params.method === "Page.getFrameTree"
            ? {
                frameTree: {
                  frame: {
                    id:
                      params.sessionId === "popup-session"
                        ? "popup"
                        : mainFrame,
                    loaderId: "loader",
                    url:
                      params.sessionId === "popup-session"
                        ? "https://example.com/popup"
                        : "https://example.com/",
                    securityOrigin: "https://example.com",
                    mimeType: "text/html",
                  },
                },
              }
            : {};
      queueMicrotask(() =>
        connection.receive({
          kind: "result",
          generation: connection.generation,
          id: msg.id,
          result,
        }),
      );
    },
    close() {},
  });
  connection.receive({
    kind: "offer",
    durationMinutes: 0,
    generation: connection.generation,
    assignment: crypto.randomUUID(),
    scope: { kind: "agent", agentId: "agent" },
  });
  await Promise.resolve();
  await Promise.resolve();
  return { connection, messages };
}

test("public Playwright transport initializes the offered page and cannot create another", async () => {
  const h = await offered();
  const browser = await chromium.connectOverCDP(
    browserExtensionTransport(h.connection, "agent"),
    { noDefaults: true, timeout: 1000 },
  );
  expect(browser.contexts()).toHaveLength(1);
  expect(browser.contexts()[0].pages()).toHaveLength(1);
  expect(browser.contexts()[0].pages()[0].url()).toBe("https://example.com/");
  expect(
    await browser
      .contexts()[0]
      .newPage()
      .then(
        () => false,
        () => true,
      ),
  ).toBe(true);
  expect(h.messages.some((m) => m.method === "create")).toBe(false);
  await browser.close();
  expect(h.connection.offered("agent")).toBeUndefined();
  h.connection.close();
}, 3000);

test("direct transport loss rejects Playwright initialization", async () => {
  const h = await offered();
  const transport = browserExtensionTransport(h.connection, "agent");
  transport.send = () => h.connection.close();
  const error: unknown = await chromium
    .connectOverCDP(transport, { noDefaults: true, timeout: 1000 })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).not.toBe("TimeoutError");
}, 3000);

test("the transport counts every Input command that it sends", async () => {
  const h = await offered();
  const transport = browserExtensionTransport(h.connection, "agent");
  const browser = await chromium.connectOverCDP(transport, {
    noDefaults: true,
    timeout: 1000,
  });
  const page = browser.contexts()[0].pages()[0];
  expect(page.url()).toBe("https://example.com/");
  expect(transport.inputs).toBe(0);
  expect(transport.mouseReleases).toBe(0);
  await page.mouse.click(5, 5);
  expect(transport.inputs).toBe(3);
  expect(transport.mouseReleases).toBe(1);
  await page.keyboard.press("A");
  expect(transport.inputs).toBe(5);
  expect(transport.mouseReleases).toBe(1);
  await browser.close();
  h.connection.close();
}, 3000);

// A tab Chrome activated from a prerender (task 69602671,
// microsoft/playwright#41397): Playwright found no page for the main frame, so
// the page never committed and every read waited.
test("Playwright initializes a tab whose main frame id is not its target id, and finds its popup's opener", async () => {
  const h = await offered("main-frame");
  const browser = await chromium.connectOverCDP(
    browserExtensionTransport(h.connection, "agent"),
    { noDefaults: true, timeout: 1000 },
  );
  try {
    const [page] = browser.contexts()[0].pages();
    expect(page.url()).toBe("https://example.com/");
    const popup = page.waitForEvent("popup", { timeout: 1000 });
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment: h.connection.offered("agent"),
      method: "popup",
      params: {
        sessionId: "popup-session",
        targetInfo: {
          type: "page",
          browserContextId: "context",
          targetId: "popup",
          openerId: "owned",
          url: "https://example.com/popup",
        },
      },
    });
    const opened = await popup;
    expect(opened.url()).toBe("https://example.com/popup");
    expect(await opened.opener()).toBe(page);
  } finally {
    await browser.close();
    h.connection.close();
  }
}, 3000);
