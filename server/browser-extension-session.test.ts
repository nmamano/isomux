import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chromium,
  errors,
  type Browser,
  type ConnectOverCDPTransport,
} from "playwright-core";
import { BrowserExtensionStore } from "./browser-extension-store";
import type { ServerWebSocket } from "bun";
import {
  BrowserExtensionService,
  type ExtensionWsData,
} from "./browser-extension-service";
import {
  ExtensionBrowserSessions,
  NOT_SENT_ERROR,
  STILL_SETTLING_ERROR,
  TIMED_OUT_ERROR,
} from "./browser-extension-session";

const origin = "chrome-extension://" + "a".repeat(32);

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
async function gateSession(actionMs = 5000) {
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
    () => actionMs,
  );
  // Page commands that reached the extension, by CDP method.
  const reached: string[] = [];
  let transport!: ConnectOverCDPTransport;
  let sessionId: string | undefined;
  let nextId = 1000;
  const answers = new Map<number, (message: { error?: unknown }) => void>();
  // One CDP command as Playwright sends it; resolves with Chrome's answer or
  // the bridge's refusal.
  const cdp = (
    method: string,
    params: Record<string, unknown> = {},
    // The client and page session to send on; by default the current ones.
    via = { wire: transport, session: sessionId },
  ) =>
    new Promise<{ error?: unknown }>((resolve) => {
      const id = ++nextId;
      answers.set(id, resolve);
      via.wire.send({ id, method, sessionId: via.session, params });
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
  const event = (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) =>
    connection.current.receive({
      kind: "event",
      generation: connection.current.generation,
      assignment: grant,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });
  class Page extends EventEmitter {
    current = `${SITE}/start`;
    gotos: string[] = [];
    // Playwright page methods the session called, in order.
    calls: string[] = [];
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
      this.calls.push("title");
      await playwrightCall("Runtime.evaluate", {
        expression: "document.title",
      });
      return `Title of ${this.current}`;
    }
    async click() {
      this.calls.push("click");
      await this.onClick();
    }
    async goto(url: string) {
      this.calls.push("goto");
      this.gotos.push(url);
      await this.onGoto(url);
      // The stand-in extension commits the navigation (navigated below).
      await playwrightCall("Page.navigate", { url });
    }
    async waitForLoadState() {
      this.calls.push("waitForLoadState");
    }
    async screenshot() {
      this.calls.push("screenshot");
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
  // Each Page.navigate that reached the extension, by URL. Chrome answers
  // with the navigation's loader and commits it, unless commits is off.
  const navigated: string[] = [];
  const chrome = { commits: true };
  const extensionNavigate = (url: string, sessionId?: string) => {
    navigated.push(url);
    const loaderId = `loader-${navigated.length}`;
    const frameId = "root";
    event(
      "Network.requestWillBeSent",
      {
        requestId: loaderId,
        loaderId,
        frameId,
        type: "Document",
        documentURL: url,
        request: { url, method: "GET", headers: {} },
      },
      sessionId,
    );
    return {
      result: { frameId, loaderId },
      commit: () => {
        if (!chrome.commits) return;
        event(
          "Page.frameNavigated",
          {
            frame: { id: frameId, loaderId, url, mimeType: "text/html" },
            type: "Navigation",
          },
          sessionId,
        );
        page.current = url;
      },
    };
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
      await cdp(
        "Target.setAutoAttach",
        { autoAttach: true },
        { wire: transport, session: undefined },
      );
      // Playwright's first commands on the page, as connectOverCDP sends
      // them: a refused one fails the attach.
      for (const method of [
        "Page.enable",
        "Page.getFrameTree",
        "Runtime.enable",
      ])
        await playwrightCall(method);
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
      const params = message.params as
        | { method?: string; params?: { url?: string }; sessionId?: string }
        | undefined;
      if (message.method === "cdp" && params?.method)
        reached.push(params.method);
      if (message.method === "cdp" && params?.method === "Page.navigate") {
        const nav = extensionNavigate(
          params.params?.url ?? "",
          params.sessionId,
        );
        queueMicrotask(() => {
          connection.current.receive({
            kind: "result",
            generation: connection.current.generation,
            id: message.id,
            result: nav.result,
          });
          queueMicrotask(nav.commit);
        });
        return;
      }
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
    navigated,
    chrome,
    cdp,
    via: () => ({ wire: transport, session: sessionId }),
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

// Task 34659f31: on a page that is already gated, Playwright would wait on
// the refused page until the action timeout (30 s in the incident), so the
// action is refused before Playwright runs.
for (const action of ["screenshot", "click"] as const)
  test(`a ${action} on a gated page is refused before Playwright runs`, async () => {
    const h = await gateSession();
    try {
      await h.warm();
      // A page script took the tab to the office between two actions.
      h.navigate(`${OFFICE}/`);
      const before = h.page.calls.length;
      const captures = h.reached.filter((m) => m === "Page.captureScreenshot");
      const result = await h.sessions.run("agent", {
        action,
        ...(action === "click" ? { selector: "a" } : {}),
      });
      expect(result).toEqual(officeRefused);
      expect(h.page.calls.slice(before)).toEqual([]);
      expect(h.reached.filter((m) => m === "Page.captureScreenshot")).toEqual(
        captures,
      );
    } finally {
      h.stop();
    }
  });

// Task 34659f31: the gate closes after the action started, and Playwright
// then waits on the refused page with no command in flight (the incident's
// journal line: phase start, pending 0). The action ends at the gate close,
// not at the action timeout, and does not lock the target out of a goto away.
// The ended action's own Playwright work sends nothing after that: a real
// click retries its selector across navigations, so it would otherwise land
// on the page the agent went to next.
test("a gate that closes during an action refuses it at once, and a goto away works after", async () => {
  const actionMs = 3000;
  const h = await gateSession(actionMs);
  const hold = Promise.withResolvers<void>();
  try {
    await h.warm();
    let late: "sent" | "failed" | undefined;
    const lateDone = Promise.withResolvers<void>();
    h.page.onClick = async () => {
      const via = h.via();
      h.navigate(`${OFFICE}/`);
      await hold.promise;
      try {
        late = "sent";
        await h.cdp(
          "Input.dispatchMouseEvent",
          { type: "mousePressed", x: 1, y: 1, button: "left" },
          via,
        );
      } catch {
        late = "failed";
      } finally {
        lateDone.resolve();
      }
    };
    const started = performance.now();
    const result = await h.sessions.run("agent", {
      action: "click",
      selector: "a",
    });
    const elapsed = performance.now() - started;
    // The condition: the click started on the site and its page reached
    // the office during it.
    expect(h.page.calls.at(-1)).toBe("click");
    expect(h.page.current).toBe(`${OFFICE}/`);
    expect(result).toEqual(officeRefused);
    // Well under the settle grace (1 s) too: an action ended through the
    // timeout path waits that grace for its hung operation.
    expect(elapsed).toBeLessThan(500);
    const away = await h.sessions.run("agent", {
      action: "goto",
      url: `${SITE}/after`,
    });
    expect(away).toMatchObject({ ok: true, url: `${SITE}/after` });
    // Task 662ed08b: the goto attaches a new client, whose first commands
    // must not land on the office page; the site gets one request.
    expect(h.navigated).toEqual([`${SITE}/after`]);
    // The ended click resumes on its own client and tries its input.
    hold.resolve();
    await Promise.race([lateDone.promise, Bun.sleep(500)]);
    expect(late).toBeDefined();
    expect(h.reached).not.toContain("Input.dispatchMouseEvent");
  } finally {
    hold.resolve();
    h.stop();
  }
}, 15_000);

// Task 662ed08b: the page reached the office between two actions, with the
// client still attached. The goto leaves, the site gets one request, and the
// client that sat on the office page sends nothing after.
test("a goto away from a page that reached an office between actions works and asks the site once", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    const old = h.via();
    h.navigate(`${OFFICE}/`);
    const result = await h.sessions.run("agent", {
      action: "goto",
      url: `${SITE}/after`,
    });
    expect(result).toMatchObject({
      ok: true,
      url: `${SITE}/after`,
      title: `Title of ${SITE}/after`,
    });
    expect(h.navigated).toEqual([`${SITE}/after`]);
    // The gate is open again (the goto is ok), so a live old client would
    // reach the page.
    const before = h.reached.length;
    try {
      await Promise.race([
        h.cdp("Runtime.evaluate", { expression: "1" }, old),
        Bun.sleep(100),
      ]);
    } catch {
      // A closed transport throws at send.
    }
    expect(h.reached.slice(before)).toEqual([]);
  } finally {
    h.stop();
  }
});

// Task 662ed08b: a leave whose navigation never commits ends with the
// action, and does not hold the grant: the next action is sent.
test("a goto away that never commits does not lock the target out", async () => {
  const actionMs = 300;
  const h = await gateSession(actionMs);
  try {
    await h.warm();
    h.navigate(`${OFFICE}/`);
    h.chrome.commits = false;
    const before = h.reached.length;
    const stuck = await h.sessions.run("agent", {
      action: "goto",
      url: `${SITE}/slow`,
    });
    // The condition: the navigation reached Chrome and did not commit.
    expect(h.navigated).toEqual([`${SITE}/slow`]);
    expect(h.page.current).toBe(`${OFFICE}/`);
    expect(stuck.ok).toBe(false);
    // The leave that ran out stops its load, so it cannot commit later
    // behind the agent's next action.
    expect(h.reached.slice(before)).toContain("Page.stopLoading");
    h.chrome.commits = true;
    const away = await h.sessions.run("agent", {
      action: "goto",
      url: `${SITE}/after`,
    });
    expect(away).toMatchObject({ ok: true, url: `${SITE}/after` });
    expect(h.navigated).toEqual([`${SITE}/slow`, `${SITE}/after`]);
  } finally {
    h.stop();
  }
});

test("an action that fails on a refused command is refused, even when its first command was refused at once", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    let first: { error?: unknown } | undefined;
    // The gate stays open: the first command, a navigation to the office,
    // leaves in the same tick the action starts and is refused without
    // closing the gate.
    h.page.onClick = async () => {
      const sent = h.cdp("Page.navigate", { url: `${OFFICE}/` });
      first = await sent;
      throw new Error("Protocol error (Page.navigate): refused");
    };
    const result = await h.sessions.run("agent", {
      action: "click",
      selector: "button",
    });
    expect(first?.error).toBeDefined();
    expect(h.page.current).toBe(`${SITE}/start`);
    expect(result).toEqual(officeRefused);
  } finally {
    h.stop();
  }
});

// Task 34659f31: the member turned the offer off (here, the agent's close),
// so the target the agent holds is gone. The answer points the agent at the
// tabs action: a tab the member offers again has a new target.
test("an action on a target that is no longer offered points to tabs", async () => {
  const h = await gateSession();
  try {
    await h.warm();
    const listed = await h.sessions.run("agent", { action: "tabs" });
    const target = (listed as { tabs: { target: string }[] }).tabs[0].target;
    expect(await h.sessions.run("agent", { action: "close" })).toMatchObject({
      ok: true,
      closed: true,
    });
    // The condition: the target is no longer offered.
    expect(await h.sessions.run("agent", { action: "tabs" })).toMatchObject({
      ok: true,
      tabs: [],
    });
    const stale = await h.sessions.run("agent", {
      action: "screenshot",
      target,
    });
    expect(stale).toMatchObject({ ok: false, code: "browser_control_ended" });
    expect((stale as { error: string }).error).toMatch(/\btabs\b/);
    const untargeted = await h.sessions.run("agent", { action: "screenshot" });
    expect(untargeted).toMatchObject({
      ok: false,
      code: "browser_control_ended",
    });
    expect((untargeted as { error: string }).error).not.toBe(
      (stale as { error: string }).error,
    );
  } finally {
    h.stop();
  }
});

test("queued browser work cannot cross Off into a replacement tab offer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-off-queue-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const sessions = new ExtensionBrowserSessions(
    service,
    () => "member",
    () => true,
    () => 500,
  );
  try {
    const { code } = store.pair("member");
    const { credential } = store.redeem(
      code,
      "chrome-extension://" + "a".repeat(32),
      () => true,
    );
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, {
      send: (m) => {
        messages.push(m);
      },
      close() {},
    });
    const offer = async (targetId: string) => {
      const assignment = crypto.randomUUID();
      connection.receive({
        kind: "offer",
        durationMinutes: 0,
        generation: connection.generation,
        assignment,
        scope: { kind: "agent", agentId: "agent" },
      });
      const attach = messages.at(-1)!;
      connection.receive({
        kind: "result",
        generation: connection.generation,
        id: attach.id,
        result: {
          targetInfo: {
            targetId,
            browserContextId: "context",
            type: "page",
            url: "https://example.com/",
          },
        },
      });
      await Promise.resolve();
      return assignment;
    };
    await offer("old");
    const first = sessions.run("agent", { action: "snapshot" });
    for (let i = 0; i < 100 && !messages.some((m) => m.method === "cdp"); i++)
      await Bun.sleep(2);
    expect(messages.some((m) => m.method === "cdp")).toBe(true);
    const queued = sessions.run("agent", {
      action: "goto",
      url: "https://example.com/queued",
    });
    connection.revoke("agent");
    const replacement = await offer("new");
    const count = messages.filter((m) => m.method === "cdp").length;
    expect(connection.offered("agent")).toBe(replacement);
    expect(await first).toMatchObject({
      ok: false,
      code: "browser_control_ended",
    });
    expect(await queued).toMatchObject({
      ok: false,
      code: "browser_control_ended",
    });
    expect(messages.filter((m) => m.method === "cdp")).toHaveLength(count);
    connection.close();
  } finally {
    sessions.stop();
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connected extension without an offered tab rejects agent actions without commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-no-offer-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const sessions = new ExtensionBrowserSessions(
    service,
    () => "member",
    () => true,
    () => 500,
  );
  try {
    const { code } = store.pair("member");
    const { credential } = store.redeem(code, origin, () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, {
      send: (m) => {
        messages.push(m);
      },
      close() {},
    });
    expect(service.bridge.connections("member")[0]).toBe(connection);
    expect(connection.offered("agent")).toBeUndefined();
    for (const body of [
      { action: "snapshot" },
      { action: "goto", url: "https://example.com/" },
      {
        action: "upload",
        selector: "#attachment",
        path: "/missing-fixture.png",
      },
    ]) {
      const result = await sessions.run("agent", body);
      expect(messages.filter((m) => m.kind === "command")).toHaveLength(0);
      expect(result).toMatchObject({
        ok: false,
        code: "browser_control_ended",
      });
    }
  } finally {
    sessions.stop();
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Task 825bb286: an extension from before 0.4.5 cannot resume offers after an
// office restart. The agent learns which of its manager's browsers is out of
// date, so it asks the manager to update instead of waiting for offers.
test("agents learn which of their manager's browsers is out of date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-outdated-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const owners: Record<string, string> = {
    agent: "member",
    visitor: "third",
  };
  const sessions = new ExtensionBrowserSessions(
    service,
    (agent) => owners[agent],
    () => true,
    () => 500,
  );
  // An extension socket as the server opens one, paired by its hello.
  const connect = (member: string, name: string, extra: object) => {
    const ws = {
      data: { kind: "extension", origin } as ExtensionWsData,
      send() {},
      close: () => service.close(typed),
    };
    const typed = ws as unknown as ServerWebSocket<ExtensionWsData>;
    service.open(typed);
    service.message(
      typed,
      JSON.stringify({
        kind: "hello",
        version: 4,
        code: store.pair(member, name).code,
        ...extra,
      }),
    );
    expect(typed.data.connection).toBeDefined();
    return typed;
  };
  type Answer = { ok: boolean; code?: string; error: string };
  const run = async (agent: string, body: object) =>
    (await sessions.run(agent, body)) as unknown as Answer;
  const untargeted = () => run("agent", { action: "snapshot" });
  const targeted = () =>
    run("agent", { action: "snapshot", target: crypto.randomUUID() });
  try {
    const latest = service.status("member").version;
    const laptop = connect("member", "Laptop", { package: latest });
    connect("other", "Elsewhere", {});
    // Only another member's browser is out of date: nothing to report.
    const tabs = await run("agent", { action: "tabs" });
    expect(tabs).toMatchObject({ ok: true, tabs: [] });
    expect(
      (tabs as unknown as { outdatedBrowsers?: unknown }).outdatedBrowsers,
    ).toBeUndefined();
    const before = [await untargeted(), await targeted()];
    for (const answer of before) {
      expect(answer.code).toBe("browser_control_ended");
      expect(answer.error).not.toContain("Laptop");
    }
    expect(before[0].error).not.toBe(before[1].error);

    const desk = connect("member", "Desk", {});
    expect(await run("agent", { action: "tabs" })).toMatchObject({
      ok: true,
      tabs: [],
      outdatedBrowsers: ["Desk"],
    });
    // Both no-offer answers keep their guidance and name the old browser.
    const after = [await untargeted(), await targeted()];
    after.forEach((answer, i) => {
      expect(answer.code).toBe("browser_control_ended");
      expect(answer.error).toContain(before[i].error);
      expect(answer.error).toContain("Desk");
      expect(answer.error).not.toContain("Laptop");
    });

    // The offline answer of a member with no out-of-date browser.
    service.close(connect("third", "Current", { package: latest }));
    const baseline = await run("visitor", { action: "tabs" });
    expect(baseline.code).toBe("browser_offline");
    expect(baseline.error).not.toContain("Desk");
    // Its promise that offers come back with the same targets.
    const promise = baseline.error.slice(baseline.error.indexOf(". ") + 2);
    expect(promise.length).toBeGreaterThan(0);

    service.close(laptop);
    service.close(desk);
    for (const offline of [
      await run("agent", { action: "tabs" }),
      await untargeted(),
    ]) {
      expect(offline.code).toBe("browser_offline");
      expect(offline.error).toContain("Desk");
      expect(offline.error).not.toContain("Laptop");
      // An old extension cannot resume offers: the answer does not promise it.
      expect(offline.error).not.toContain(promise);
    }
  } finally {
    sessions.stop();
    service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// "hang": the action never settles, even when its client closes (a wait that
// nothing bounds). hangTitle: the first client's title read never answers.
// hangClose: the first client's close never returns.
async function timeoutSessionFixture(
  held: boolean | "watchdog" | "navigation" | "hang" = false,
  all = false,
  durationMinutes = 0,
  opts: {
    fenceCeiling?: number;
    hangTitle?: boolean;
    hangClose?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "browser-timeout-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const allowed = new Set(["agent", "second"]);
  const mayUse = () => true;
  const access = (_member: string, agent: string) =>
    all ? allowed.has(agent) : mayUse();
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: access,
  });
  const sessions = new ExtensionBrowserSessions(
    service,
    () => "member",
    access,
    () => 20,
    opts.fenceCeiling === undefined ? undefined : () => opts.fenceCeiling!,
  );
  const { code } = store.pair("member");
  const { credential } = store.redeem(code, origin, () => true);
  const messages: Record<string, unknown>[] = [];
  const connection = service.bridge.connect(credential, {
    send: (m) => {
      messages.push(m);
      if (
        (m.params as { method?: string } | undefined)?.method ===
        "Page.stopLoading"
      )
        queueMicrotask(() => {
          for (const command of messages.filter(
            (message) => message.method === "cdp",
          ))
            connection.receive({
              kind: "result",
              generation: connection.generation,
              id: command.id,
              result: {},
            });
        });
    },
    close() {},
  });
  const grant = crypto.randomUUID();
  connection.receive({
    kind: "offer",
    durationMinutes,
    generation: connection.generation,
    assignment: grant,
    scope: all ? { kind: "all" } : { kind: "agent", agentId: "agent" },
  });
  connection.receive({
    kind: "result",
    generation: connection.generation,
    id: messages.at(-1)!.id,
    result: {
      targetInfo: {
        targetId: "owned",
        type: "page",
        url: "https://example.com/",
      },
    },
  });
  await Promise.resolve();
  let calls = 0,
    retired = 0,
    background = false,
    sendOnClose = false,
    pageClosed = false;
  // A hang that only a ceiling or a fresh client ends lets the next action run
  // before the old one settles.
  let settled = held === "hang" || !!opts.hangTitle || !!opts.hangClose;
  let clients = 0;
  let transport!: import("playwright-core").ConnectOverCDPTransport;
  let sessionId: unknown;
  const connect = spyOn(chromium, "connectOverCDP").mockImplementation(
    async (wire) => {
      const client = ++clients;
      transport = wire as import("playwright-core").ConnectOverCDPTransport;
      transport.onmessage = (message) => {
        const m = message as {
          method?: string;
          params?: { sessionId: string };
        };
        if (m.method === "Target.attachedToTarget")
          sessionId = m.params?.sessionId;
      };
      transport.send({
        id: 1,
        method: "Target.setAutoAttach",
        params: { autoAttach: true },
      });
      await Promise.resolve();
      const timeout = async () => {
        if (held === "hang") return new Promise<never>(() => {});
        if (held === true || held === "navigation")
          transport.send({
            id: 2,
            method:
              held === "navigation" ? "Page.navigate" : "Input.insertText",
            sessionId: sessionId as string,
            params:
              held === "navigation"
                ? { url: "https://example.com/next" }
                : { text: "fixture" },
          });
        await Bun.sleep(held === "watchdog" ? 1200 : 20);
        settled = true;
        throw Object.assign(new Error("fixture timeout"), {
          name: "TimeoutError",
        });
      };
      const mainFrame = {
        childFrames: () => [],
        isDetached: () => false,
        locator: () => ({
          innerText: async () => {
            calls++;
            expect(settled).toBe(true);
            return "fixture";
          },
        }),
      };
      const page = {
        on() {},
        off() {},
        close: async () => {
          pageClosed = true;
        },
        isClosed: () => pageClosed,
        url: () => "https://example.com/",
        title: () =>
          opts.hangTitle && client === 1
            ? new Promise<string>(() => {})
            : Promise.resolve("Fixture"),
        mainFrame: () => mainFrame,
        fill: timeout,
        goto: timeout,
        click: async () => {
          calls++;
          expect(settled).toBe(true);
          if (background) {
            background = false;
            transport.send({
              id: 42,
              method: "Runtime.releaseObject",
              sessionId: sessionId as string,
              params: { objectId: "fixture" },
            });
          }
        },
      };
      return {
        contexts: () => [{ pages: () => [page], on() {} }],
        isConnected: () => true,
        on() {},
        close: async () => {
          retired++;
          if (opts.hangClose && client === 1)
            return new Promise<void>(() => {});
          // Cleanup that the old client sends while it closes.
          if (sendOnClose)
            transport.send({
              id: 43,
              method: "Runtime.releaseObject",
              sessionId: sessionId as string,
              params: { objectId: "fixture" },
            });
          transport.close();
        },
      } as unknown as Browser;
    },
  );
  return {
    sessions,
    connection,
    messages,
    grant,
    allowed,
    store,
    service,
    pageClosed: () => pageClosed,
    backgroundOnNextClick: () => {
      background = true;
    },
    sendOnNextClose: () => {
      sendOnClose = true;
    },
    closeTransport: () => transport.close(),
    retired: () => retired,
    calls: () => calls,
    connect,
    stop: () => {
      sessions.stop();
      service.stop();
      connect.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("settled selector timeout retains the same grant/session and queued different action runs", async () => {
  const h = await timeoutSessionFixture();
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const timeout = h.sessions.run("agent", {
      action: "fill",
      selector: "#fixture",
      text: "private fixture",
    });
    const next = h.sessions.run("agent", { action: "text" });
    // Its own timeout, settled within the grace.
    expect(await timeout).toMatchObject({
      ok: false,
      code: "action_timeout",
      error: TIMED_OUT_ERROR,
    });
    expect(await next).toMatchObject({ ok: true, text: "fixture" });
    expect(
      await h.sessions.run("agent", { action: "click", selector: "button" }),
    ).toMatchObject({ ok: true });
    expect(h.connection.offered("agent")).toBe(h.grant);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.messages.some((m) => m.method === "detach")).toBe(false);
    const log = diagnostics.mock.calls.flat().join(" ");
    expect(log).toContain("operation_timeout");
    expect(log).not.toContain("watchdog_timeout");
    expect(log).not.toContain("private fixture");
    expect(log).not.toContain("#fixture");
  } finally {
    diagnostics.mockRestore();
    h.stop();
  }
});

test("unsettled command keeps ON and fences later work until the real late response", async () => {
  const h = await timeoutSessionFixture(true);
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const sent = await h.sessions.run("agent", {
      action: "fill",
      selector: "#fixture",
      text: "fixture",
    });
    // Its own timeout, with its command still pending: not the fence copy.
    expect(sent).toMatchObject({
      code: "action_timeout",
      error: STILL_SETTLING_ERROR,
    });
    const command = h.messages.find((m) => m.method === "cdp")!;
    expect(command).toBeDefined();
    expect(h.connection.pendingCount(h.grant)).toBe(1);
    expect(h.connection.offered("agent")).toBe(h.grant);
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({
      code: "action_timeout",
      error: NOT_SENT_ERROR,
    });
    expect(h.calls()).toBe(0);
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
    await Bun.sleep(0);
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({
      ok: true,
    });
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.messages.filter((m) => m.method === "cdp")).toHaveLength(1);
    expect(h.messages.some((m) => m.method === "detach")).toBe(false);
  } finally {
    diagnostics.mockRestore();
    h.stop();
  }
});

test("a client that closes during its own action gets that action's timeout", async () => {
  const h = await timeoutSessionFixture(true);
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const work = h.sessions.run("agent", {
      action: "fill",
      selector: "#fixture",
      text: "fixture",
    });
    for (let i = 0; i < 100 && !h.messages.some((m) => m.method === "cdp"); i++)
      await Bun.sleep(2);
    expect(h.connection.pendingCount(h.grant)).toBe(1);
    h.closeTransport();
    expect(await work).toMatchObject({
      code: "action_timeout",
      error: STILL_SETTLING_ERROR,
    });
    expect(diagnostics.mock.calls.flat().join(" ")).toContain("client_closed");
    expect(h.connection.offered("agent")).toBe(h.grant);
  } finally {
    diagnostics.mockRestore();
    h.stop();
  }
});

test("watchdog response waits for old operation settlement without releasing the grant", async () => {
  const h = await timeoutSessionFixture("watchdog");
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const pending = h.sessions.run("agent", {
      action: "fill",
      selector: "#fixture",
      text: "fixture",
    });
    const next = h.sessions.run("agent", { action: "text" });
    expect(await pending).toMatchObject({
      code: "action_timeout",
      error: TIMED_OUT_ERROR,
    });
    expect(await next).toMatchObject({ ok: true });
    expect(h.connection.offered("agent")).toBe(h.grant);
    // A wait that outlived its own timeout marks the client as stuck: the
    // next action gets a fresh one.
    expect(h.retired()).toBe(1);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(diagnostics.mock.calls.flat().join(" ")).toContain(
      "watchdog_timeout",
    );
    expect(h.messages.some((m) => m.method === "detach")).toBe(false);
  } finally {
    diagnostics.mockRestore();
    h.stop();
  }
});

// Task f499efba, hold A: a Playwright wait with no timeout of its own (a
// title or a Locator.count) left the fence on until the member's toggle.
test("a title read that never answers ends as a timeout and the next action gets a fresh client", async () => {
  const h = await timeoutSessionFixture(false, false, 0, { hangTitle: true });
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({
      code: "action_timeout",
      error: TIMED_OUT_ERROR,
    });
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({
      ok: true,
      title: "Fixture",
      text: "fixture",
    });
    expect(h.retired()).toBe(1);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.connection.offered("agent")).toBe(h.grant);
    // The bound ended it, not the watchdog or the ceiling.
    const log = diagnostics.mock.calls.flat().join(" ");
    expect(log).toContain("operation_timeout");
    expect(log).not.toContain("watchdog_timeout");
    expect(log).not.toContain("fence_ceiling");
  } finally {
    diagnostics.mockRestore();
    h.stop();
  }
});

const diagnosticsOf = (info: { mock: { calls: unknown[][] } }) =>
  info.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("[browser-extension] "))
    .map(
      (line) =>
        JSON.parse(line.slice("[browser-extension] ".length)) as Record<
          string,
          unknown
        >,
    );

test("an action that never settles fences its grant until the ceiling, then a fresh client runs the next action", async () => {
  // The stuck client's close also waits on Chrome: only the bridge's retire
  // frees the grant for the next client.
  const h = await timeoutSessionFixture("hang", false, 0, {
    fenceCeiling: 200,
    hangClose: true,
  });
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    expect(
      await h.sessions.run("agent", {
        action: "fill",
        selector: "#fixture",
        text: "fixture",
      }),
    ).toMatchObject({ code: "action_timeout", error: STILL_SETTLING_ERROR });
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({
      code: "action_timeout",
      error: NOT_SENT_ERROR,
    });
    expect(h.calls()).toBe(0);
    await Bun.sleep(400);
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({
      ok: true,
      text: "fixture",
    });
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.connection.offered("agent")).toBe(h.grant);
    expect(h.messages.some((m) => m.method === "detach")).toBe(false);
    const logs = diagnosticsOf(diagnostics);
    const reasons = logs.map((l) => l.reason);
    expect(reasons).toContain("watchdog_timeout");
    expect(reasons).toContain("fence_ceiling");
    // Each refusal is logged with the fence that refused it.
    const refusals = logs.filter((l) => l.reason === "not_sent");
    expect(refusals).toHaveLength(1);
    expect(Object.values(refusals[0])).toContain("settling");
    expect(JSON.stringify(logs)).not.toContain("#fixture");
  } finally {
    diagnostics.mockRestore();
    h.stop();
  }
}, 10_000);

test("Playwright initialization timeout retains the offer while outstanding initialization drains", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-init-timeout-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, {
    memberExists: () => true,
    mayUse: () => true,
  });
  const sessions = new ExtensionBrowserSessions(
    service,
    () => "member",
    () => true,
    () => 20,
  );
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  // Model Playwright's initialization failure only after a real CDP command
  // reaches the bridge. Real Playwright startup is covered by
  // browser-extension-interactions.live.test.ts through browserExtensionTransport.
  const dispatched = Promise.withResolvers<void>();
  const connect = spyOn(chromium, "connectOverCDP").mockImplementation(
    async (wire) => {
      const transport =
        wire as import("playwright-core").ConnectOverCDPTransport;
      let sessionId: string | undefined;
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
      transport.send({
        id: 2,
        method: "Runtime.enable",
        params: {},
        sessionId,
      });
      await dispatched.promise;
      throw new errors.TimeoutError("Initialization timed out");
    },
  );
  try {
    const { code } = store.pair("member");
    const { credential } = store.redeem(code, origin, () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, {
      send: (m) => {
        messages.push(m);
        if (m.method === "cdp") {
          expect(connection.pendingCount(grant)).toBeGreaterThan(0);
          dispatched.resolve();
        }
      },
      close() {},
    });
    const grant = crypto.randomUUID();
    connection.receive({
      kind: "offer",
      durationMinutes: 0,
      generation: connection.generation,
      assignment: grant,
      scope: { kind: "agent", agentId: "agent" },
    });
    connection.receive({
      kind: "result",
      generation: connection.generation,
      id: messages.at(-1)!.id,
      result: {
        targetInfo: {
          targetId: "owned",
          browserContextId: "context",
          type: "page",
          url: "https://example.com/",
        },
      },
    });
    await Promise.resolve();
    expect(await sessions.run("agent", { action: "snapshot" })).toMatchObject({
      code: "action_timeout",
    });
    const reasons = diagnostics.mock.calls.flat().join(" ");
    expect(reasons).toContain("operation_timeout");
    expect(reasons).not.toContain("watchdog_timeout");
    expect(connection.pendingCount(grant)).toBeGreaterThan(0);
    expect(connection.offered("agent")).toBe(grant);
    expect(service.bridge.connections("member")[0]).toBe(connection);
    expect(messages.some((m) => m.method === "detach")).toBe(false);
    const count = messages.length;
    expect(await sessions.run("agent", { action: "text" })).toMatchObject({
      code: "action_timeout",
    });
    expect(messages).toHaveLength(count);
    connection.revoke("agent");
    await Bun.sleep(0);
    expect(connection.offered("agent")).toBeUndefined();
  } finally {
    connect.mockRestore();
    sessions.stop();
    service.stop();
    diagnostics.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("navigation timeout sends owned stop and drains before the queued inspection", async () => {
  const h = await timeoutSessionFixture("navigation");
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const timeout = h.sessions.run("agent", {
      action: "goto",
      url: "https://example.com/next",
    });
    const next = h.sessions.run("agent", { action: "text" });
    expect(await timeout).toMatchObject({ code: "action_timeout" });
    expect(await next).toMatchObject({ ok: true });
    expect(h.connection.offered("agent")).toBe(h.grant);
    expect(h.connection.pendingCount(h.grant)).toBe(0);
    expect(
      h.messages
        .filter((m) => m.method === "cdp")
        .map((m) => (m.params as { method: string }).method),
    ).toEqual(["Page.navigate", "Page.stopLoading"]);
    expect(h.messages.some((m) => m.method === "detach")).toBe(false);
    expect(h.connect).toHaveBeenCalledTimes(1);
  } finally {
    diagnostics.mockRestore();
    h.stop();
  }
});

for (const held of [false, true])
  test(`All shares one queue and timeout fence across callers (held=${held})`, async () => {
    const h = await timeoutSessionFixture(held, true);
    try {
      expect(h.connection.offered("second")).toBe(h.grant);
      const first = h.sessions.run("agent", {
        action: "fill",
        selector: "#fixture",
        text: "fixture",
      });
      const next = h.sessions.run("second", { action: "text" });
      expect(await first).toMatchObject({ code: "action_timeout" });
      if (held) {
        expect(h.connection.pendingCount(h.grant)).toBe(1);
        expect(await next).toMatchObject({
          code: "action_timeout",
          error: NOT_SENT_ERROR,
        });
        expect(h.calls()).toBe(0);
        const command = h.messages.find((m) => m.method === "cdp")!;
        h.connection.receive({
          kind: "result",
          generation: h.connection.generation,
          id: command.id,
          result: {},
        });
        await Bun.sleep(0);
        expect(
          await h.sessions.run("second", { action: "text" }),
        ).toMatchObject({ ok: true });
        expect(h.messages.filter((m) => m.method === "cdp")).toHaveLength(1);
      } else expect(await next).toMatchObject({ ok: true });
      expect(h.connect).toHaveBeenCalledTimes(2);
      expect(h.messages.some((m) => m.method === "detach")).toBe(false);
      expect(
        await h.sessions.run("agent", { action: "click", selector: "button" }),
      ).toMatchObject({ ok: true });
      expect(h.connect).toHaveBeenCalledTimes(3);
      h.allowed.delete("agent");
      h.connection.revalidate();
      expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({
        code: "browser_control_ended",
      });
      expect(h.connection.offered("second")).toBe(h.grant);
      expect(
        await h.sessions.run("second", { action: "click", selector: "button" }),
      ).toMatchObject({ ok: true });
      expect(await h.sessions.run("foreign", { action: "tabs" })).toMatchObject(
        { code: "browser_control_ended" },
      );
      expect(await h.sessions.run("second", { action: "close" })).toMatchObject(
        { ok: true },
      );
      expect(h.connection.offered("second")).toBeUndefined();
    } finally {
      h.stop();
    }
  });

test("target discovery resolves ambiguity without creating a session and rechecks queued callers", async () => {
  const h = await timeoutSessionFixture(true, true);
  const add = async (
    scope: { kind: "all" } | { kind: "agent"; agentId: string },
  ) => {
    const assignment = crypto.randomUUID();
    h.connection.receive({
      kind: "offer",
      generation: h.connection.generation,
      assignment,
      scope,
      durationMinutes: 0,
    });
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: h.messages.at(-1)!.id,
      result: {
        targetInfo: {
          targetId: crypto.randomUUID(),
          type: "page",
          title: "Second fixture",
          url: "https://example.com/second",
        },
      },
    });
    await Promise.resolve();
    return assignment;
  };
  try {
    const target = h.connection.targets("agent")[0].target;
    await add({ kind: "all" });
    const count = h.messages.length;
    const ambiguous = await h.sessions.run("agent", { action: "text" });
    expect(ambiguous).toMatchObject({ code: "browser_target_required" });
    expect(JSON.stringify(ambiguous)).not.toContain("https://");
    expect(h.connect).toHaveBeenCalledTimes(0);
    expect(h.messages).toHaveLength(count);
    expect(await h.sessions.run("agent", { action: "tabs" })).toMatchObject({
      ok: true,
      tabs: expect.arrayContaining([
        {
          target,
          scope: { kind: "all" },
          browser: "Browser 1",
          title: "",
          url: "https://example.com/",
        },
      ]),
    });
    expect(h.messages).toHaveLength(count);
    const first = h.sessions.run("agent", {
      action: "fill",
      selector: "#fixture",
      text: "fixture",
      target,
    });
    const next = h.sessions.run("second", { action: "text", target });
    await Bun.sleep(0);
    expect(h.connection.pendingCount(h.grant)).toBe(1);
    h.allowed.delete("second");
    expect(await first).toMatchObject({ code: "action_timeout" });
    expect(await next).toMatchObject({ code: "browser_control_ended" });
    expect(h.calls()).toBe(0);
    expect((await h.sessions.run("agent", { action: "tabs" })).ok).toBe(true);
    expect(
      await h.sessions.run("agent", {
        action: "text",
        target: crypto.randomUUID(),
      }),
    ).toMatchObject({ code: "browser_control_ended" });
    expect(h.connect).toHaveBeenCalledTimes(1);
  } finally {
    h.stop();
  }
});

test("access loss after dispatch ends only that caller with unknown outcome and no replay", async () => {
  const h = await timeoutSessionFixture(true, true);
  try {
    const action = h.sessions.run("agent", {
      action: "fill",
      selector: "#fixture",
      text: "fixture",
    });
    await Bun.sleep(0);
    const command = h.messages.find((m) => m.method === "cdp")!;
    expect(command).toBeDefined();
    expect(h.connection.pendingCount(h.grant)).toBe(1);
    h.allowed.delete("agent");
    h.connection.revalidate();
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: command.id,
      result: {},
    });
    const result = await action;
    expect(result).toMatchObject({ code: "browser_control_ended" });
    if (!result.ok) expect(result.error).toMatch(/unknown/i);
    expect(h.connection.offered("second")).toBe(h.grant);
    expect(
      await h.sessions.run("second", { action: "click", selector: "button" }),
    ).toMatchObject({ ok: true });
    expect(h.messages.filter((m) => m.method === "cdp")).toHaveLength(1);
    expect(h.messages.some((m) => m.method === "detach")).toBe(false);
  } finally {
    h.stop();
  }
});

for (const held of [false, true])
  test(`actor switch drains successful prior action cleanup before retiring its client (held=${held})`, async () => {
    const h = await timeoutSessionFixture(false, true);
    try {
      expect(
        await h.sessions.run("agent", {
          action: "fill",
          selector: "#fixture",
          text: "fixture",
        }),
      ).toMatchObject({ code: "action_timeout" });
      h.backgroundOnNextClick();
      const first = h.sessions.run("agent", {
        action: "click",
        selector: "button",
      });
      const second = h.sessions.run("second", { action: "text" });
      expect(await first).toMatchObject({ ok: true });
      expect(h.connection.pendingCount(h.grant)).toBe(1);
      expect(h.retired()).toBe(0);
      expect(h.connect).toHaveBeenCalledTimes(1);
      const cleanup = h.messages.findLast((m) => m.method === "cdp")!;
      expect((cleanup.params as { method: string }).method).toBe(
        "Runtime.releaseObject",
      );
      if (held) {
        expect(await second).toMatchObject({
          code: "action_timeout",
          error: NOT_SENT_ERROR,
        });
        expect(h.retired()).toBe(0);
        expect(h.connection.targets("second")).toHaveLength(1);
      }
      h.connection.receive({
        kind: "result",
        generation: h.connection.generation,
        id: cleanup.id,
        result: {},
      });
      expect(h.connection.pendingCount(h.grant)).toBe(0);
      expect(
        await (held ? h.sessions.run("second", { action: "text" }) : second),
      ).toMatchObject({ ok: true });
      expect(h.retired()).toBe(1);
      expect(h.connect).toHaveBeenCalledTimes(2);
      expect(h.messages.filter((m) => m.method === "cdp")).toHaveLength(1);
      expect(h.connection.offered("second")).toBe(h.grant);
    } finally {
      h.stop();
    }
  });

test("an actor switch whose retiring client leaves a command pending sends nothing", async () => {
  const h = await timeoutSessionFixture(false, true);
  try {
    expect(
      await h.sessions.run("agent", {
        action: "fill",
        selector: "#fixture",
        text: "fixture",
      }),
    ).toMatchObject({ code: "action_timeout" });
    expect(
      await h.sessions.run("agent", { action: "click", selector: "button" }),
    ).toMatchObject({ ok: true });
    expect(h.connection.pendingCount(h.grant)).toBe(0);
    h.sendOnNextClose();
    expect(await h.sessions.run("second", { action: "text" })).toMatchObject({
      code: "action_timeout",
      error: NOT_SENT_ERROR,
    });
    expect(h.retired()).toBe(1);
    expect(h.calls()).toBe(1);
    expect(h.connect).toHaveBeenCalledTimes(1);
  } finally {
    h.stop();
  }
});

test("an actor switch whose old client never finishes closing still runs the next caller", async () => {
  const h = await timeoutSessionFixture(false, true, 0, { hangClose: true });
  try {
    expect(
      await h.sessions.run("agent", { action: "click", selector: "button" }),
    ).toMatchObject({ ok: true });
    const outcome = await Promise.race([
      h.sessions.run("second", { action: "text" }),
      Bun.sleep(4000).then(() => ({ outcome: "no answer in 4 s" })),
    ]);
    expect(outcome).toMatchObject({ ok: true, text: "fixture" });
    expect(h.retired()).toBe(1);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.connection.offered("second")).toBe(h.grant);
  } finally {
    h.stop();
  }
}, 10_000);

for (const expiry of [false, true])
  test(`All release interrupts both active and queued callers (expiry=${expiry})`, async () => {
    let now = 1_800_000_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const h = await timeoutSessionFixture(true, true, expiry ? 15 : 0);
    try {
      const first = h.sessions.run("agent", {
        action: "fill",
        selector: "#fixture",
        text: "fixture",
      });
      const second = h.sessions.run("second", { action: "text" });
      await Bun.sleep(0);
      expect(h.connection.pendingCount(h.grant)).toBe(1);
      if (expiry) {
        now += 15 * 60_000;
        expect(h.connection.offered("second")).toBeUndefined();
      } else h.connection.revoke("second");
      const result = await first;
      expect(result).toMatchObject({ code: "browser_control_ended" });
      if (!result.ok) expect(result.error).toMatch(/unknown/i);
      expect(await second).toMatchObject({ code: "browser_control_ended" });
      expect(h.connection.targets("agent")).toEqual([]);
      expect(h.connection.targets("second")).toEqual([]);
      expect(
        await h.sessions.run("agent", { action: "snapshot" }),
      ).toMatchObject({ code: "browser_control_ended" });
      expect(
        await h.sessions.run("second", { action: "snapshot" }),
      ).toMatchObject({ code: "browser_control_ended" });
      expect(h.pageClosed()).toBe(false);
      expect(h.messages.filter((m) => m.method === "detach")).toHaveLength(1);
      await Bun.sleep(30);
      expect(h.messages.filter((m) => m.method === "cdp")).toHaveLength(1);
    } finally {
      h.stop();
      clock.mockRestore();
    }
  });

test("a queued action stays bound to its browser and grant when another browser's offer takes precedence", async () => {
  const h = await timeoutSessionFixture(true, true);
  const { code } = h.store.pair("member", "Desk");
  const { credential } = h.store.redeem(code, origin, () => true);
  const deskWire: Record<string, unknown>[] = [];
  const desk = h.service.bridge.connect(credential, {
    send: (m) => deskWire.push(m),
    close() {},
  });
  try {
    expect(await h.sessions.run("agent", { action: "tabs" })).toMatchObject({
      ok: true,
      tabs: [{ browser: "Browser 1", scope: { kind: "all" } }],
    });
    const first = h.sessions.run("agent", {
      action: "fill",
      selector: "#fixture",
      text: "fixture",
    });
    const queued = h.sessions.run("agent", { action: "text" });
    await Bun.sleep(0);
    expect(h.connection.pendingCount(h.grant)).toBe(1);
    desk.receive({
      kind: "offer",
      generation: desk.generation,
      assignment: crypto.randomUUID(),
      scope: { kind: "agent", agentId: "agent" },
      durationMinutes: 0,
    });
    desk.receive({
      kind: "result",
      generation: desk.generation,
      id: deskWire.at(-1)!.id,
      result: {
        targetInfo: {
          targetId: "desk-owned",
          type: "page",
          url: "https://example.com/desk",
        },
      },
    });
    await Promise.resolve();
    const sent = deskWire.length;
    // As with one browser, a newly preferred offer ends unqualified work on
    // the old grant; neither action moves to the other browser.
    expect(await first).toMatchObject({ code: "browser_control_ended" });
    expect(await queued).toMatchObject({ code: "browser_control_ended" });
    expect(h.calls()).toBe(0);
    expect(deskWire.slice(sent).filter((m) => m.kind === "command")).toEqual(
      [],
    );
    expect(await h.sessions.run("agent", { action: "tabs" })).toMatchObject({
      ok: true,
      tabs: [
        { browser: "Browser 1", scope: { kind: "all" } },
        { browser: "Desk", scope: { kind: "agent", agentId: "agent" } },
      ],
    });
  } finally {
    desk.close();
    h.stop();
  }
});

// The grant half of the binding: one connection, so only the grant tells the
// old All offer from the agent's own offer that now takes precedence.
test("a queued action stays bound to its grant when an individual offer on the same browser takes precedence", async () => {
  const h = await timeoutSessionFixture(true, true);
  try {
    const first = h.sessions.run("agent", {
      action: "fill",
      selector: "#fixture",
      text: "fixture",
    });
    const queued = h.sessions.run("agent", { action: "text" });
    await Bun.sleep(0);
    expect(h.connection.pendingCount(h.grant)).toBe(1);
    const own = crypto.randomUUID();
    h.connection.receive({
      kind: "offer",
      generation: h.connection.generation,
      assignment: own,
      scope: { kind: "agent", agentId: "agent" },
      durationMinutes: 0,
    });
    h.connection.receive({
      kind: "result",
      generation: h.connection.generation,
      id: h.messages.at(-1)!.id,
      result: {
        targetInfo: {
          targetId: "own-tab",
          type: "page",
          url: "https://example.com/own",
        },
      },
    });
    await Promise.resolve();
    // The condition this test needs: the same connection now prefers the
    // individual grant, and the All grant is still offered to the agent.
    expect(h.service.bridge.resolve("member", "agent")).toMatchObject({
      connection: h.connection,
      grant: own,
    });
    expect(h.connection.targets("agent")).toHaveLength(2);
    expect(await first).toMatchObject({ code: "browser_control_ended" });
    expect(await queued).toMatchObject({ code: "browser_control_ended" });
    expect(h.calls()).toBe(0);
    expect(h.messages.filter((m) => m.method === "cdp")).toHaveLength(1);
  } finally {
    h.stop();
  }
});

test("an action that outwaits debugger recovery is not sent", async () => {
  const h = await timeoutSessionFixture();
  try {
    expect(
      await h.sessions.run("agent", {
        action: "fill",
        selector: "input",
        text: "fixture",
      }),
    ).toMatchObject({ code: "action_timeout" });
    h.connection.receive({
      kind: "event",
      generation: h.connection.generation,
      assignment: h.grant,
      method: "recovering",
      params: {},
    });
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({
      code: "action_timeout",
      error: NOT_SENT_ERROR,
    });
    expect(h.calls()).toBe(0);
    expect(h.connection.offered("agent")).toBe(h.grant);
  } finally {
    h.stop();
  }
});

for (const outcome of ["recovered", "detached"] as const) {
  test(`an action during debugger recovery waits and follows ${outcome}`, async () => {
    const h = await timeoutSessionFixture();
    try {
      // Complete the existing fixture's selector timeout before detaching.
      expect(
        await h.sessions.run("agent", {
          action: "fill",
          selector: "input",
          text: "fixture",
        }),
      ).toMatchObject({ code: "action_timeout" });
      const event = (method: string) =>
        h.connection.receive({
          kind: "event",
          generation: h.connection.generation,
          assignment: h.grant,
          method,
          params: {},
        });
      event("recovering");
      let finished = false;
      const started = performance.now();
      const waiting = h.sessions
        .run("agent", { action: "text" })
        .then((result) => {
          finished = true;
          return result;
        });
      await Bun.sleep(5);
      expect(finished).toBe(false);
      expect(h.calls()).toBe(0);
      event(outcome);
      expect(await waiting).toMatchObject(
        outcome === "recovered"
          ? { ok: true, text: "fixture" }
          : { ok: false, code: "browser_control_ended" },
      );
      expect(performance.now() - started).toBeLessThan(3000);
      expect(h.connect).toHaveBeenCalledTimes(outcome === "recovered" ? 2 : 1);
    } finally {
      h.stop();
    }
  });
}
