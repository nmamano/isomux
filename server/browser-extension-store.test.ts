import { chromium, type Browser } from "playwright-core";
import { BrowserExtensionService } from "./browser-extension-service";
import { ExtensionBrowserSessions } from "./browser-extension-session";
import { test, expect, spyOn } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserExtensionStore } from "./browser-extension-store";
import { browserCredentialHash } from "./browser-extension-bridge";
const origin = "chrome-extension://" + "a".repeat(32);
test("pairing is single use, expires, stores hashes only, and replacement waits for redemption", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-store-"));
  const path = join(dir, "connections.json");
  let now = 0;
  try {
    const store = new BrowserExtensionStore(path, () => now);
    expect(store.record("one").backend).toBe("extension");
    const first = store.pair("one", false);
    expect(first.code.length).toBe(43);
    const paired = store.redeem(first.code, origin, () => true);
    expect(
      store.memberForHash(browserCredentialHash(paired.credential), origin),
    ).toBe("one");
    expect(() => store.redeem(first.code, origin, () => true)).toThrow();
    expect(() => store.pair("one", false)).toThrow();
    const replacement = store.pair("one", true);
    expect(
      store.memberForHash(browserCredentialHash(paired.credential), origin),
    ).toBe("one");
    const second = store.redeem(replacement.code, origin, () => true);
    expect(() => store.redeem(replacement.code, origin, () => true)).toThrow();
    expect(
      store.memberForHash(browserCredentialHash(paired.credential), origin),
    ).toBeUndefined();
    expect(
      store.memberForHash(browserCredentialHash(second.credential), origin),
    ).toBe("one");
    expect(
      store.memberForHash(
        browserCredentialHash(second.credential),
        "chrome-extension://" + "b".repeat(32),
      ),
    ).toBeUndefined();
    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain(second.credential);
    expect(saved).not.toContain(replacement.code);
    const pending = store.pair("two", false);
    const restart = new BrowserExtensionStore(path);
    expect(restart.record("one").backend).toBe("extension");
    expect(
      restart.memberForHash(browserCredentialHash(second.credential), origin),
    ).toBe("one");
    expect(() => restart.redeem(pending.code, origin, () => true)).toThrow();
    now = pending.expiresAt;
    expect(() => store.redeem(pending.code, origin, () => true)).toThrow();
    const fresh = store.pair("two", false);
    expect(() => store.redeem(fresh.code, "null", () => true)).toThrow();
    expect(() => store.redeem(fresh.code, origin, () => false)).toThrow();
    expect(store.redeem(fresh.code, origin, () => true).member).toBe("two");
    restart.revoke("one");
    expect(restart.record("one").hash).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy headless choices migrate to Chrome and preserve pairing and profile files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-migration-"));
  const path = join(dir, "connections.json");
  const profile = join(dir, "browser-profiles");
  mkdirSync(profile);
  writeFileSync(join(profile, "member.json"), "legacy profile fixture");
  try {
    const hash = browserCredentialHash("fixture credential");
    for (const wrapped of [false, true]) {
      const members = { member: { backend: "headless", hash, origin }, unpaired: { backend: "headless" } };
      writeFileSync(path, JSON.stringify(wrapped ? { version: 1, selectionRequired: true, members } : members));
      const store = new BrowserExtensionStore(path);
      expect(store.memberForHash(hash, origin)).toBe("member");
      expect(store.record("member").backend).toBe("extension");
      const service = new BrowserExtensionService(store, { memberExists: () => true, mayUse: () => true });
      const sessions = new ExtensionBrowserSessions(service, () => "unpaired", () => true);
      expect(await sessions.run("agent", { action: "snapshot" })).toMatchObject({ ok: false, code: "browser_not_paired" });
      expect(service.status("member")).toMatchObject({ paired: true, online: false });
      expect(service.status("member")).not.toHaveProperty("backend");
      expect(readFileSync(join(profile, "member.json"), "utf8")).toBe("legacy profile fixture");
      sessions.stop(); service.stop();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt state requires pairing and preserves source on redemption, including failed writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-repair-"));
  const path = join(dir, "connections.json");
  try {
    for (const directory of [false, true]) {
      if (directory) mkdirSync(path); else writeFileSync(path, "{");
      const inode = statSync(path).ino;
      const store = new BrowserExtensionStore(path);
      expect(store.record("member").hash).toBeUndefined();
      const pair = store.pair("member", false);
      mkdirSync(path + ".tmp");
      expect(() => store.redeem(pair.code, origin, () => true)).toThrow();
      expect(statSync(path).ino).toBe(inode);
      expect(readdirSync(dir).filter(n => n.includes(".unavailable-"))).toHaveLength(0);
      rmSync(path + ".tmp", { recursive: true });
      const retry = store.pair("member", false);
      const redeemed = store.redeem(retry.code, origin, () => true);
      const backup = readdirSync(dir).find(n => n.includes(".unavailable-"))!;
      expect(statSync(join(dir, backup)).ino).toBe(inode);
      if (!directory) expect(readFileSync(join(dir, backup), "utf8")).toBe("{");
      expect(new BrowserExtensionStore(path).memberForHash(browserCredentialHash(redeemed.credential), origin)).toBe("member");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      rmSync(join(dir, backup), { recursive: true }); rmSync(path);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queued browser work cannot cross Off into a replacement tab offer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-off-queue-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, { memberExists: () => true, mayUse: () => true });
  const sessions = new ExtensionBrowserSessions(service, () => "member", () => true, () => 500);
  try {
    const { code } = store.pair("member", false);
    const { credential } = store.redeem(code, "chrome-extension://" + "a".repeat(32), () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, { send: m => { messages.push(m); }, close() {} });
    const offer = async (targetId: string) => {
      const assignment = crypto.randomUUID();
      connection.receive({ kind: "offer", durationMinutes: 0, generation: connection.generation, assignment, agent: "agent" });
      const attach = messages.at(-1)!;
      connection.receive({ kind: "result", generation: connection.generation, id: attach.id,
        result: { targetInfo: { targetId, browserContextId: "context", type: "page", url: "https://example.com/" } } });
      await Promise.resolve();
      return assignment;
    };
    await offer("old");
    const first = sessions.run("agent", { action: "snapshot" });
    for (let i = 0; i < 100 && !messages.some(m => m.method === "cdp"); i++) await Bun.sleep(2);
    expect(messages.some(m => m.method === "cdp")).toBe(true);
    const queued = sessions.run("agent", { action: "goto", url: "https://example.com/queued" });
    connection.revoke("agent");
    const replacement = await offer("new");
    const count = messages.filter(m => m.method === "cdp").length;
    expect(connection.offered("agent")).toBe(replacement);
    expect(await first).toMatchObject({ ok: false, code: "browser_control_ended" });
    expect(await queued).toMatchObject({ ok: false, code: "browser_control_ended" });
    expect(messages.filter(m => m.method === "cdp")).toHaveLength(count);
    connection.close();
  } finally {
    sessions.stop(); service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("connected extension without an offered tab rejects agent actions without commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-no-offer-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, { memberExists: () => true, mayUse: () => true });
  const sessions = new ExtensionBrowserSessions(service, () => "member", () => true, () => 500);
  try {
    const { code } = store.pair("member", false);
    const { credential } = store.redeem(code, origin, () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, { send: m => { messages.push(m); }, close() {} });
    expect(service.bridge.forMember("member")).toBe(connection);
    expect(connection.offered("agent")).toBeUndefined();
    for (const body of [{ action: "snapshot" }, { action: "goto", url: "https://example.com/" }, { action: "upload", selector: "#attachment", path: "/missing-fixture.png" }]) {
      const result = await sessions.run("agent", body);
      expect(messages.filter(m => m.kind === "command")).toHaveLength(0);
      expect(result).toMatchObject({ ok: false, code: "browser_control_ended" });
    }
  } finally {
    sessions.stop(); service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Never has no desktop idle timer and stays offered across four hours and actions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-never-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, { memberExists: () => true, mayUse: () => true });
  const sessions = new ExtensionBrowserSessions(service, () => "member", () => true);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timers = spyOn(globalThis, "setTimeout");
  const connect = spyOn(chromium, "connectOverCDP").mockImplementation(async transport => {
    let connected = true;
    return {
      contexts: () => [{ pages: () => [{ url: () => "https://example.com/", title: async () => "Fixture", innerText: async () => "fixture" }], on() {} }],
      isConnected: () => connected, on() {},
      close: async () => { connected = false; (transport as unknown as { close(): void }).close(); },
    } as unknown as Browser;
  });
  try {
    const { code } = store.pair("member", false);
    const { credential } = store.redeem(code, origin, () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, { send: m => { messages.push(m); }, close() {} });
    const assignment = crypto.randomUUID();
    connection.receive({ kind: "offer", durationMinutes: 0, generation: connection.generation, assignment, agent: "agent" });
    const attach = messages.at(-1)!;
    connection.receive({ kind: "result", generation: connection.generation, id: attach.id,
      result: { targetInfo: { targetId: "owned", type: "page", url: "https://example.com/" } } });
    await Promise.resolve();
    expect(connection.offered("agent")).toBe(assignment);
    expect(await sessions.run("agent", { action: "text" })).toMatchObject({ ok: true });
    expect(timers.mock.calls.some(call => call[1] === 15 * 60_000)).toBe(false);
    now += 4 * 60 * 60_000;
    connection.revalidate();
    expect(connection.offered("agent")).toBe(assignment);
    expect(await sessions.run("agent", { action: "text" })).toMatchObject({ ok: true });
    expect(connect).toHaveBeenCalledTimes(1);
  } finally {
    sessions.stop(); service.stop(); connect.mockRestore(); timers.mockRestore(); clock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timed expiry interrupts pending browser work with unknown outcome and never replays it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-expiry-pending-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, { memberExists: () => true, mayUse: () => true });
  const sessions = new ExtensionBrowserSessions(service, () => "member", () => true, () => 1000);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { code } = store.pair("member", false);
    const { credential } = store.redeem(code, origin, () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, { send: m => { messages.push(m); }, close() {} });
    const offer = async (durationMinutes: number, targetId: string) => {
      const assignment = crypto.randomUUID();
      connection.receive({ kind: "offer", durationMinutes, generation: connection.generation, assignment, agent: "agent" });
      const attach = messages.at(-1)!;
      connection.receive({ kind: "result", generation: connection.generation, id: attach.id,
        result: { targetInfo: { targetId, browserContextId: "context", type: "page", url: "https://example.com/" } } });
      await Promise.resolve();
      return assignment;
    };
    const original = await offer(15, "old");
    expect(connection.offered("agent")).toBe(original);
    const pending = sessions.run("agent", { action: "snapshot" });
    for (let i = 0; i < 100 && !messages.some(m => m.method === "cdp"); i++) await Bun.sleep(2);
    expect(messages.some(m => m.method === "cdp")).toBe(true);
    const queued = sessions.run("agent", { action: "goto", url: "https://example.com/queued" });
    now += 15 * 60_000;
    connection.revalidate();
    const replacement = await offer(0, "new");
    expect(replacement).not.toBe(original);
    const count = messages.filter(m => m.method === "cdp").length;
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "browser_control_ended" });
    if (!result.ok) expect(result.error).toMatch(/unknown/i);
    expect(await queued).toMatchObject({ ok: false, code: "browser_control_ended" });
    expect(messages.filter(m => m.method === "cdp")).toHaveLength(count);
    expect(connection.offered("agent")).toBe(replacement);
  } finally {
    sessions.stop(); service.stop(); clock.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function timeoutSessionFixture(held: boolean | "watchdog" | "navigation" = false) {
  const dir = mkdtempSync(join(tmpdir(), "browser-timeout-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, { memberExists: () => true, mayUse: () => true });
  const sessions = new ExtensionBrowserSessions(service, () => "member", () => true, () => 20);
  const { code } = store.pair("member", false);
  const { credential } = store.redeem(code, origin, () => true);
  const messages: Record<string, unknown>[] = [];
  const connection = service.bridge.connect(credential, { send: m => {
    messages.push(m);
    if ((m.params as { method?: string } | undefined)?.method === "Page.stopLoading")
      queueMicrotask(() => {
        for (const command of messages.filter(message => message.method === "cdp"))
          connection.receive({ kind: "result", generation: connection.generation, id: command.id, result: {} });
      });
  }, close() {} });
  const grant = crypto.randomUUID();
  connection.receive({ kind: "offer", durationMinutes: 0, generation: connection.generation, assignment: grant, agent: "agent" });
  connection.receive({ kind: "result", generation: connection.generation, id: messages.at(-1)!.id,
    result: { targetInfo: { targetId: "owned", type: "page", url: "https://example.com/" } } });
  await Promise.resolve();
  let calls = 0;
  let settled = false;
  let transport!: import("playwright-core").ConnectOverCDPTransport;
  let sessionId: unknown;
  const connect = spyOn(chromium, "connectOverCDP").mockImplementation(async wire => {
    transport = wire as import("playwright-core").ConnectOverCDPTransport;
    transport.onmessage = message => { const m = message as { method?: string; params?: { sessionId: string } }; if (m.method === "Target.attachedToTarget") sessionId = m.params?.sessionId; };
    transport.send({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    await Promise.resolve();
    const timeout = async () => {
      if (held === true || held === "navigation") transport.send({ id: 2,
        method: held === "navigation" ? "Page.navigate" : "Input.insertText",
        sessionId: sessionId as string, params: held === "navigation" ? { url: "https://example.com/next" } : { text: "fixture" } });
      await Bun.sleep(held === "watchdog" ? 1200 : 20);
      settled = true;
      throw Object.assign(new Error("fixture timeout"), { name: "TimeoutError" });
    };
    const page = {
      url: () => "https://example.com/", title: async () => "Fixture",
      innerText: async () => { calls++; expect(settled).toBe(true); return "fixture"; },
      fill: timeout, goto: timeout,
      click: async () => { calls++; expect(settled).toBe(true); },
    };
    return { contexts: () => [{ pages: () => [page], on() {} }], isConnected: () => true, on() {},
      close: async () => { transport.close(); } } as unknown as Browser;
  });
  return { sessions, connection, messages, grant, calls: () => calls, connect,
    stop: () => { sessions.stop(); service.stop(); connect.mockRestore(); rmSync(dir, { recursive: true, force: true }); } };
}

test("settled selector timeout retains the same grant/session and queued different action runs", async () => {
  const h = await timeoutSessionFixture();
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const timeout = h.sessions.run("agent", { action: "fill", selector: "#fixture", text: "private fixture" });
    const next = h.sessions.run("agent", { action: "text" });
    expect(await timeout).toMatchObject({ ok: false, code: "action_timeout" });
    expect(await next).toMatchObject({ ok: true, text: "fixture" });
    expect(await h.sessions.run("agent", { action: "click", selector: "button" })).toMatchObject({ ok: true });
    expect(h.connection.offered("agent")).toBe(h.grant);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.messages.some(m => m.method === "detach")).toBe(false);
    const log = diagnostics.mock.calls.flat().join(" ");
    expect(log).toContain("operation_timeout");
    expect(log).not.toContain("watchdog_timeout");
    expect(log).not.toContain("private fixture");
    expect(log).not.toContain("#fixture");
  } finally { diagnostics.mockRestore(); h.stop(); }
});

test("unsettled command keeps ON and fences later work until the real late response", async () => {
  const h = await timeoutSessionFixture(true);
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    expect(await h.sessions.run("agent", { action: "fill", selector: "#fixture", text: "fixture" })).toMatchObject({ code: "action_timeout" });
    const command = h.messages.find(m => m.method === "cdp")!;
    expect(command).toBeDefined();
    expect(h.connection.pendingCount(h.grant)).toBe(1);
    expect(h.connection.offered("agent")).toBe(h.grant);
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({ code: "action_timeout" });
    expect(h.calls()).toBe(0);
    h.connection.receive({ kind: "result", generation: h.connection.generation, id: command.id, result: {} });
    await Bun.sleep(0);
    expect(await h.sessions.run("agent", { action: "text" })).toMatchObject({ ok: true });
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.messages.filter(m => m.method === "cdp")).toHaveLength(1);
    expect(h.messages.some(m => m.method === "detach")).toBe(false);
  } finally { diagnostics.mockRestore(); h.stop(); }
});

test("watchdog response waits for old operation settlement without releasing the grant", async () => {
  const h = await timeoutSessionFixture("watchdog");
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const pending = h.sessions.run("agent", { action: "fill", selector: "#fixture", text: "fixture" });
    const next = h.sessions.run("agent", { action: "text" });
    expect(await pending).toMatchObject({ code: "action_timeout" });
    expect(await next).toMatchObject({ ok: true });
    expect(h.connection.offered("agent")).toBe(h.grant);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(diagnostics.mock.calls.flat().join(" ")).toContain("watchdog_timeout");
    expect(h.messages.some(m => m.method === "detach")).toBe(false);
  } finally { diagnostics.mockRestore(); h.stop(); }
});

test("Playwright initialization timeout retains the offer while outstanding initialization drains", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-init-timeout-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, { memberExists: () => true, mayUse: () => true });
  const sessions = new ExtensionBrowserSessions(service, () => "member", () => true, () => 20);
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const { code } = store.pair("member", false);
    const { credential } = store.redeem(code, origin, () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, { send: m => { messages.push(m); }, close() {} });
    const grant = crypto.randomUUID();
    connection.receive({ kind: "offer", durationMinutes: 0, generation: connection.generation, assignment: grant, agent: "agent" });
    connection.receive({ kind: "result", generation: connection.generation, id: messages.at(-1)!.id,
      result: { targetInfo: { targetId: "owned", browserContextId: "context", type: "page", url: "https://example.com/" } } });
    await Promise.resolve();
    expect(await sessions.run("agent", { action: "snapshot" })).toMatchObject({ code: "action_timeout" });
    expect(connection.pendingCount(grant)).toBeGreaterThan(0);
    expect(connection.offered("agent")).toBe(grant);
    expect(service.bridge.forMember("member")).toBe(connection);
    expect(messages.some(m => m.method === "detach")).toBe(false);
    const count = messages.length;
    expect(await sessions.run("agent", { action: "text" })).toMatchObject({ code: "action_timeout" });
    expect(messages).toHaveLength(count);
    connection.revoke("agent");
    await Bun.sleep(0);
    expect(connection.offered("agent")).toBeUndefined();
  } finally { sessions.stop(); service.stop(); diagnostics.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test("navigation timeout sends owned stop and drains before the queued inspection", async () => {
  const h = await timeoutSessionFixture("navigation");
  const diagnostics = spyOn(console, "info").mockImplementation(() => {});
  try {
    const timeout = h.sessions.run("agent", { action: "goto", url: "https://example.com/next" });
    const next = h.sessions.run("agent", { action: "text" });
    expect(await timeout).toMatchObject({ code: "action_timeout" });
    expect(await next).toMatchObject({ ok: true });
    expect(h.connection.offered("agent")).toBe(h.grant);
    expect(h.connection.pendingCount(h.grant)).toBe(0);
    expect(h.messages.filter(m => m.method === "cdp").map(m => (m.params as { method: string }).method))
      .toEqual(["Page.navigate", "Page.stopLoading"]);
    expect(h.messages.some(m => m.method === "detach")).toBe(false);
    expect(h.connect).toHaveBeenCalledTimes(1);
  } finally { diagnostics.mockRestore(); h.stop(); }
});
