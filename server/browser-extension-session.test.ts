import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type ConnectOverCDPTransport } from "playwright-core";
import { BrowserExtensionStore } from "./browser-extension-store";
import { BrowserExtensionService } from "./browser-extension-service";
import { ExtensionBrowserSessions } from "./browser-extension-session";

const closedError = () => new Error("Target page, context or browser has been closed");

for (const phase of ["metadata", "metadata-late-close", "input", "before-input", "mouse-down", "read-error", "late-success", "close-error-without-event"] as const) {
  test(`popup close during ${phase} preserves the action outcome`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-closed-page-"));
    const store = new BrowserExtensionStore(join(dir, "connections.json"));
    const service = new BrowserExtensionService(store, {
      memberExists: () => true,
      mayUse: () => true,
    });
    const actionMs = phase === "late-success" || phase === "close-error-without-event" ? 100 : 5000;
    const sessions = new ExtensionBrowserSessions(service, () => "member", () => true, () => actionMs);
    let now = performance.now();
    const initialNow = now;
    const clock = phase === "late-success" ? spyOn(performance, "now").mockImplementation(() => now) : undefined;
    let transport!: ConnectOverCDPTransport;
    let sessionId: string | undefined;
    let clicks = 0, releases = 0, moves = 0, presses = 0, closedReads = 0, parentTitles = 0;
    const frame = {};
    const popupClosed = Promise.withResolvers<void>();
    class Page extends EventEmitter {
      closed = false;
      constructor(readonly popup: boolean) { super(); }
      isClosed() { return this.closed; }
      mainFrame() { return frame; }
      async opener() { return root; }
      close() { this.closed = true; this.emit("close"); if (this.popup) popupClosed.resolve(); }
      url() {
        if (this.closed) { closedReads++; throw closedError(); }
        return this.popup ? "https://example.test/popup" : "https://example.test/main";
      }
      async title() {
        if (this.closed) { closedReads++; throw closedError(); }
        if (!this.popup) { parentTitles++; return "Main"; }
        if (phase === "late-success") return "Popup";
        // The input completed; close at the exact asynchronous metadata read.
        expect(releases).toBe(1);
        if (phase === "metadata-late-close") setImmediate(() => this.close());
        else this.close();
        if (phase === "read-error") throw new Error("Unrelated title read failure");
        throw closedError();
      }
      async click() {
        clicks++;
        const type = phase === "before-input" ? "mouseMoved" : phase === "mouse-down" ? "mousePressed" : "mouseReleased";
        transport.send({ id: 2, method: "Input.dispatchMouseEvent", sessionId, params: { type, x: 1, y: 1, button: "left" } });
        if (type === "mouseReleased") releases++;
        else if (type === "mouseMoved") moves++;
        else presses++;
        if (phase === "late-success") now += actionMs + 1;
        if (phase === "close-error-without-event") throw closedError();
        if (phase === "input" || phase === "before-input" || phase === "mouse-down") {
          this.close();
          throw closedError();
        }
      }
    }
    const root = new Page(false), popup = new Page(true);
    const context = Object.assign(new EventEmitter(), { pages: () => [root, popup] });
    const connect = spyOn(chromium, "connectOverCDP").mockImplementation(async (wire) => {
      transport = wire as ConnectOverCDPTransport;
      transport.onmessage = (message) => {
        const event = message as { method?: string; params?: { sessionId: string } };
        if (event.method === "Target.attachedToTarget") sessionId = event.params?.sessionId;
      };
      transport.send({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
      expect(sessionId).toBeString();
      return Object.assign(new EventEmitter(), {
        contexts: () => [context],
        isConnected: () => true,
        close: async () => transport.close(),
      }) as unknown as Browser;
    });
    try {
      const { code } = store.pair("member");
      const { credential } = store.redeem(code, "chrome-extension://" + "a".repeat(32), () => true);
      const offered = Promise.withResolvers<void>();
      const connection = service.bridge.connect(credential, {
        send(message) {
          if (message.kind === "offered") offered.resolve();
          if (message.kind !== "command") return;
          queueMicrotask(() => connection.receive({
            kind: "result", generation: connection.generation, id: message.id,
            result: message.method === "attach"
              ? { targetInfo: { targetId: "root", type: "page", url: "https://example.test/main" } }
              : {},
          }));
        },
        close() {},
      });
      const grant = crypto.randomUUID();
      connection.receive({ kind: "offer", generation: connection.generation, assignment: grant, durationMinutes: 0, scope: { kind: "agent", agentId: "agent" } });
      await offered.promise;
      const result = await sessions.run("agent", { action: "click", selector: "button" });
      const shouldClose = phase !== "late-success" && phase !== "close-error-without-event";
      if (shouldClose) await popupClosed.promise;
      // Assert the enabling events before the outcome, including in mutants.
      expect(popup.closed).toBe(shouldClose);
      expect(clicks).toBe(1);
      expect(releases).toBe(phase === "before-input" || phase === "mouse-down" ? 0 : 1);
      expect(moves).toBe(phase === "before-input" ? 1 : 0);
      expect(presses).toBe(phase === "mouse-down" ? 1 : 0);
      if (phase === "late-success") expect(now).toBeGreaterThan(initialNow + actionMs);
      if (phase === "metadata" || phase === "metadata-late-close" || phase === "input") {
        expect(result).toMatchObject({ ok: true, title: "Main", url: "https://example.test/main" });
        expect(parentTitles).toBe(1);
      } else if (phase === "late-success") {
        expect(result).toMatchObject({ ok: true, title: "Popup", url: "https://example.test/popup" });
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
