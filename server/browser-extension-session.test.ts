import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chromium,
  type Browser,
  type ConnectOverCDPTransport,
} from "playwright-core";
import { BrowserExtensionStore } from "./browser-extension-store";
import { BrowserExtensionService } from "./browser-extension-service";
import { ExtensionBrowserSessions } from "./browser-extension-session";

const closedError = () =>
  new Error("Target page, context or browser has been closed");

for (const phase of [
  "metadata",
  "metadata-late-close",
  "input",
  "before-input",
  "mouse-down",
  "read-error",
  "late-success",
  "close-error-without-event",
] as const) {
  test(`popup close during ${phase} preserves the action outcome`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-closed-page-"));
    const store = new BrowserExtensionStore(join(dir, "connections.json"));
    const service = new BrowserExtensionService(store, {
      memberExists: () => true,
      mayUse: () => true,
    });
    const actionMs =
      phase === "late-success" || phase === "close-error-without-event"
        ? 100
        : 5000;
    const sessions = new ExtensionBrowserSessions(
      service,
      () => "member",
      () => true,
      () => actionMs,
    );
    let now = performance.now();
    const initialNow = now;
    const clock =
      phase === "late-success"
        ? spyOn(performance, "now").mockImplementation(() => now)
        : undefined;
    let transport!: ConnectOverCDPTransport;
    let sessionId: string | undefined;
    let clicks = 0,
      releases = 0,
      moves = 0,
      presses = 0,
      closedReads = 0,
      parentTitles = 0;
    const frame = {};
    const popupClosed = Promise.withResolvers<void>();
    class Page extends EventEmitter {
      closed = false;
      constructor(readonly popup: boolean) {
        super();
      }
      isClosed() {
        return this.closed;
      }
      mainFrame() {
        return frame;
      }
      async opener() {
        return root;
      }
      close() {
        this.closed = true;
        this.emit("close");
        if (this.popup) popupClosed.resolve();
      }
      url() {
        if (this.closed) {
          closedReads++;
          throw closedError();
        }
        return this.popup
          ? "https://example.test/popup"
          : "https://example.test/main";
      }
      async title() {
        if (this.closed) {
          closedReads++;
          throw closedError();
        }
        if (!this.popup) {
          parentTitles++;
          return "Main";
        }
        if (phase === "late-success") return "Popup";
        // The input completed; close at the exact asynchronous metadata read.
        expect(releases).toBe(1);
        if (phase === "metadata-late-close") setImmediate(() => this.close());
        else this.close();
        if (phase === "read-error")
          throw new Error("Unrelated title read failure");
        throw closedError();
      }
      async click() {
        clicks++;
        const type =
          phase === "before-input"
            ? "mouseMoved"
            : phase === "mouse-down"
              ? "mousePressed"
              : "mouseReleased";
        transport.send({
          id: 2,
          method: "Input.dispatchMouseEvent",
          sessionId,
          params: { type, x: 1, y: 1, button: "left" },
        });
        if (type === "mouseReleased") releases++;
        else if (type === "mouseMoved") moves++;
        else presses++;
        if (phase === "late-success") now += actionMs + 1;
        if (phase === "close-error-without-event") throw closedError();
        if (
          phase === "input" ||
          phase === "before-input" ||
          phase === "mouse-down"
        ) {
          this.close();
          throw closedError();
        }
      }
    }
    const root = new Page(false),
      popup = new Page(true);
    const context = Object.assign(new EventEmitter(), {
      pages: () => [root, popup],
    });
    const connect = spyOn(chromium, "connectOverCDP").mockImplementation(
      async (wire) => {
        transport = wire as ConnectOverCDPTransport;
        transport.onmessage = (message) => {
          const event = message as {
            method?: string;
            params?: { sessionId: string };
          };
          if (event.method === "Target.attachedToTarget")
            sessionId = event.params?.sessionId;
        };
        transport.send({
          id: 1,
          method: "Target.setAutoAttach",
          params: { autoAttach: true },
        });
        expect(sessionId).toBeString();
        return Object.assign(new EventEmitter(), {
          contexts: () => [context],
          isConnected: () => true,
          close: async () => transport.close(),
        }) as unknown as Browser;
      },
    );
    try {
      const { code } = store.pair("member");
      const { credential } = store.redeem(
        code,
        "chrome-extension://" + "a".repeat(32),
        () => true,
      );
      const offered = Promise.withResolvers<void>();
      const connection = service.bridge.connect(credential, {
        send(message) {
          if (message.kind === "offered") offered.resolve();
          if (message.kind !== "command") return;
          queueMicrotask(() =>
            connection.receive({
              kind: "result",
              generation: connection.generation,
              id: message.id,
              result:
                message.method === "attach"
                  ? {
                      targetInfo: {
                        targetId: "root",
                        type: "page",
                        url: "https://example.test/main",
                      },
                    }
                  : {},
            }),
          );
        },
        close() {},
      });
      const grant = crypto.randomUUID();
      connection.receive({
        kind: "offer",
        generation: connection.generation,
        assignment: grant,
        durationMinutes: 0,
        scope: { kind: "agent", agentId: "agent" },
      });
      await offered.promise;
      const result = await sessions.run("agent", {
        action: "click",
        selector: "button",
      });
      const shouldClose =
        phase !== "late-success" && phase !== "close-error-without-event";
      if (shouldClose) await popupClosed.promise;
      // Assert the enabling events before the outcome, including in mutants.
      expect(popup.closed).toBe(shouldClose);
      expect(clicks).toBe(1);
      expect(releases).toBe(
        phase === "before-input" || phase === "mouse-down" ? 0 : 1,
      );
      expect(moves).toBe(phase === "before-input" ? 1 : 0);
      expect(presses).toBe(phase === "mouse-down" ? 1 : 0);
      if (phase === "late-success")
        expect(now).toBeGreaterThan(initialNow + actionMs);
      if (
        phase === "metadata" ||
        phase === "metadata-late-close" ||
        phase === "input"
      ) {
        expect(result).toMatchObject({
          ok: true,
          title: "Main",
          url: "https://example.test/main",
        });
        expect(parentTitles).toBe(1);
      } else if (phase === "late-success") {
        expect(result).toMatchObject({
          ok: true,
          title: "Popup",
          url: "https://example.test/popup",
        });
        expect(parentTitles).toBe(0);
      } else {
        expect(result).toMatchObject({ ok: false, code: "action_failed" });
        expect(parentTitles).toBe(0);
      }
      expect(closedReads).toBe(0);
      expect(connection.offered("agent")).toBe(grant);
    } finally {
      sessions.stop();
      service.stop();
      connect.mockRestore();
      clock?.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The office gate (task 2a3b5645), seen from the action result. The bridge
// refuses page commands on an office page the member did not offer; the
// session turns that into 403 office_page_refused and returns nothing read
// from the page. Playwright is a stand-in that sends the CDP commands the real
// one sends for each step, through the real transport and bridge.
const OFFICE = "https://office.test";
const SITE = "https://site.test";
async function gateSession() {
  const dir = mkdtempSync(join(tmpdir(), "browser-office-gate-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
    officeOrigins: () => [OFFICE],
  });
  const sessions = new ExtensionBrowserSessions(
    service,
    () => "member",
    () => true,
    () => 5000,
  );
  // Page commands that reached the extension, by CDP method.
  const reached: string[] = [];
  let transport!: ConnectOverCDPTransport;
  let sessionId: string | undefined;
  let nextId = 1000;
  const answers = new Map<number, (message: { error?: unknown }) => void>();
  // One CDP command as Playwright sends it; resolves with Chrome's answer or
  // the bridge's refusal.
  const cdp = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ error?: unknown }>((resolve) => {
      const id = ++nextId;
      answers.set(id, resolve);
      transport.send({ id, method, sessionId, params });
    });
  const playwrightCall = async (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    const answer = await cdp(method, params);
    if (answer.error)
      throw new Error(`Protocol error (${method}): Browser command refused`);
  };
  let grant = "";
  const connection = {
    current: undefined as unknown as ReturnType<typeof service.bridge.connect>,
  };
  const event = (method: string, params: Record<string, unknown>) =>
    connection.current.receive({
      kind: "event",
      generation: connection.current.generation,
      assignment: grant,
      method,
      params,
    });
  class Page extends EventEmitter {
    current = `${SITE}/start`;
    gotos: string[] = [];
    onClick: () => Promise<void> = async () => {};
    onGoto: (url: string) => Promise<void> = async () => {};
    isClosed() {
      return false;
    }
    mainFrame() {
      return {};
    }
    async opener() {
      return null;
    }
    url() {
      return this.current;
    }
    async title() {
      await playwrightCall("Runtime.evaluate", {
        expression: "document.title",
      });
      return `Title of ${this.current}`;
    }
    async click() {
      await this.onClick();
    }
    async goto(url: string) {
      this.gotos.push(url);
      await this.onGoto(url);
      await playwrightCall("Page.navigate", { url });
      navigate(url);
    }
    async screenshot() {
      await playwrightCall("Page.captureScreenshot", {});
      return Buffer.from("png");
    }
  }
  const page = new Page();
  // Chrome's events for a main-frame navigation, in order; the stand-in page
  // follows the commit as Playwright's page.url() does.
  const navigate = (url: string, commit = true) => {
    event("Network.requestWillBeSent", {
      requestId: url,
      loaderId: url,
      frameId: "root",
      type: "Document",
      documentURL: url,
      request: { url, method: "GET", headers: {} },
    });
    if (!commit) return;
    event("Page.frameNavigated", {
      frame: { id: "root", loaderId: url, url, mimeType: "text/html" },
      type: "Navigation",
    });
    page.current = url;
  };
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const connect = spyOn(chromium, "connectOverCDP").mockImplementation(
    async (wire) => {
      transport = wire as ConnectOverCDPTransport;
      transport.onmessage = (message) => {
        const m = message as {
          id?: number;
          method?: string;
          error?: unknown;
          params?: { sessionId: string };
        };
        if (m.method === "Target.attachedToTarget")
          sessionId = m.params?.sessionId;
        if (m.id !== undefined) answers.get(m.id)?.(m);
      };
      transport.send({
        id: 1,
        method: "Target.setAutoAttach",
        params: { autoAttach: true },
      });
      return Object.assign(new EventEmitter(), {
        contexts: () => [context],
        isConnected: () => true,
        close: async () => transport.close(),
      }) as unknown as Browser;
    },
  );
  const { code } = store.pair("member");
  const { credential } = store.redeem(
    code,
    "chrome-extension://" + "a".repeat(32),
    () => true,
  );
  const offered = Promise.withResolvers<void>();
  connection.current = service.bridge.connect(credential, {
    send(message) {
      if (message.kind === "offered") offered.resolve();
      if (message.kind !== "command") return;
      const params = message.params as { method?: string } | undefined;
      if (message.method === "cdp" && params?.method)
        reached.push(params.method);
      queueMicrotask(() =>
        connection.current.receive({
          kind: "result",
          generation: connection.current.generation,
          id: message.id,
          result:
            message.method === "attach"
              ? {
                  targetInfo: {
                    targetId: "root",
                    type: "page",
                    url: `${SITE}/start`,
                  },
                }
              : {},
        }),
      );
    },
    close() {},
  });
  grant = crypto.randomUUID();
  connection.current.receive({
    kind: "offer",
    generation: connection.current.generation,
    assignment: grant,
    durationMinutes: 0,
    scope: { kind: "agent", agentId: "agent" },
  });
  await offered.promise;
  return {
    sessions,
    page,
    reached,
    navigate,
    cdp,
    // Attach the client with a harmless first action, as an agent's first
    // call would.
    warm: async () =>
      expect(
        await sessions.run("agent", { action: "screenshot" }),
      ).toMatchObject({ ok: true }),
    stop: () => {
      sessions.stop();
      service.stop();
      connect.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const officeRefused = {
  ok: false as const,
  status: 403 as const,
  code: "office_page_refused" as const,
  error: expect.any(String) as string,
};

test("a goto to a known office is refused before any navigation", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    const result = await h.sessions.run("agent", {
      action: "goto",
      url: `${OFFICE}/settings`,
    });
    // Exact keys: no url, title or other page data.
    expect(result).toEqual(officeRefused);
    expect(h.page.gotos).toEqual([]);
    expect(h.reached).not.toContain("Page.navigate");
  } finally {
    h.stop();
  }
});

test("an input whose page reaches an office during the action dispatches nothing there", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    // The agent's page redirects to the office while Playwright waits for
    // the selector; the click then targets the office document.
    h.page.onClick = async () => {
      h.navigate(`${OFFICE}/settings`);
      await h.cdp("DOM.getDocument");
      const answer = await h.cdp("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 1,
        y: 1,
        button: "left",
      });
      if (answer.error) throw new Error("Protocol error: refused");
    };
    const result = await h.sessions.run("agent", {
      action: "click",
      selector: "text=Create token",
    });
    expect(h.page.current).toBe(`${OFFICE}/settings`);
    expect(result).toEqual(officeRefused);
    expect(h.reached).not.toContain("Input.dispatchMouseEvent");
    expect(h.reached).not.toContain("DOM.getDocument");
  } finally {
    h.stop();
  }
});

test("an input that lands the page on an office returns no url or title", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    // The click is dispatched on the agent's page and its navigation commits
    // on the office before the result is read.
    h.page.onClick = async () => {
      const answer = await h.cdp("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 1,
        y: 1,
        button: "left",
      });
      expect(answer.error).toBeUndefined();
      h.navigate(`${OFFICE}/`);
    };
    const result = await h.sessions.run("agent", {
      action: "click",
      selector: "a",
    });
    expect(h.reached).toContain("Input.dispatchMouseEvent");
    expect(h.page.current).toBe(`${OFFICE}/`);
    expect(result).toEqual(officeRefused);
  } finally {
    h.stop();
  }
});

test("a read on a gated page returns no screenshot", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    // A page script took the tab to the office between two actions.
    h.navigate(`${OFFICE}/`);
    const captures = h.reached.filter((m) => m === "Page.captureScreenshot");
    const result = await h.sessions.run("agent", { action: "screenshot" });
    expect(result).toEqual(officeRefused);
    expect(h.reached.filter((m) => m === "Page.captureScreenshot")).toEqual(
      captures,
    );
  } finally {
    h.stop();
  }
});

test("a goto away from a gated page succeeds although Playwright's own commands there were refused", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    h.navigate(`${OFFICE}/`);
    let background: { error?: unknown } | undefined;
    // Playwright still works on the office document it saw last.
    h.page.onGoto = async () => {
      background = await h.cdp("Runtime.callFunctionOn", {
        functionDeclaration: "() => 1",
      });
    };
    const result = await h.sessions.run("agent", {
      action: "goto",
      url: `${SITE}/after`,
    });
    // The condition this test needs: a command was refused during the action.
    expect(background?.error).toBeDefined();
    expect(result).toMatchObject({
      ok: true,
      url: `${SITE}/after`,
      title: `Title of ${SITE}/after`,
    });
  } finally {
    h.stop();
  }
});

test("an action that fails on a refused command is refused, even when its first command was refused at once", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    h.navigate(`${OFFICE}/`);
    let first: { error?: unknown } | undefined;
    // The first command leaves in the same tick the action starts; the page
    // then leaves the office, so the gate is open when the action ends.
    h.page.onClick = async () => {
      const sent = h.cdp("DOM.getDocument");
      first = await sent;
      h.navigate(`${SITE}/after`);
      throw new Error("Protocol error (DOM.getDocument): refused");
    };
    const result = await h.sessions.run("agent", {
      action: "click",
      selector: "button",
    });
    expect(first?.error).toBeDefined();
    expect(h.page.current).toBe(`${SITE}/after`);
    expect(result).toEqual(officeRefused);
  } finally {
    h.stop();
  }
});
