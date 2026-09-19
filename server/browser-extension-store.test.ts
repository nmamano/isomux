import { browserPool } from "./browser-session";
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
    expect(store.record("one").backend).toBe("headless");
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
    store.select("one", "extension");
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

test("malformed and unreadable browser state requires selection and preserves source bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-store-invalid-"));
  const path = join(dir, "connections.json");
  try {
    for (const content of ["{", "null", "[]", "7", '"invalid"']) {
      writeFileSync(path, content);
      const store = new BrowserExtensionStore(path);
      expect(store.record("member")).toEqual({ backend: null });
      expect(
        store.memberForHash(browserCredentialHash("old credential")),
      ).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe(content);
    }
    // A directory deterministically rejects readFileSync, even under root.
    rmSync(path);
    mkdirSync(path);
    expect(() => readFileSync(path, "utf8")).toThrow();
    const unreadable = new BrowserExtensionStore(path);
    expect(unreadable.record("member")).toEqual({ backend: null });
    const inode = statSync(path).ino;
    unreadable.select("member", "extension");
    expect(new BrowserExtensionStore(path).record("member").backend).toBe(
      "extension",
    );
    const savedDirectory = readdirSync(dir).find((name) =>
      name.startsWith("connections.json.unavailable-"),
    )!;
    expect(statSync(join(dir, savedDirectory)).isDirectory()).toBe(true);
    expect(statSync(join(dir, savedDirectory)).ino).toBe(inode);
    rmSync(join(dir, savedDirectory), { recursive: true });
    rmSync(path, { recursive: true });
    writeFileSync(path, "{");
    const recovered = new BrowserExtensionStore(path);
    expect(() => recovered.pair("member", false)).toThrow();
    recovered.select("member", "extension");
    const preserved = readdirSync(dir).find((name) =>
      name.startsWith("connections.json.unavailable-"),
    )!;
    expect(readFileSync(join(dir, preserved), "utf8")).toBe("{");
    expect(
      new BrowserExtensionStore(path).record("another member").backend,
    ).toBeNull();
    const pair = recovered.pair("member", false);
    const redeemed = recovered.redeem(pair.code, origin, () => true);
    expect(
      new BrowserExtensionStore(path).memberForHash(
        browserCredentialHash(redeemed.credential),
        origin,
      ),
    ).toBe("member");
    expect(readFileSync(path, "utf8")).not.toContain(redeemed.credential);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed selection write restores the unavailable source before restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-repair-rollback-"));
  const path = join(dir, "connections.json");
  try {
    for (const directory of [false, true]) {
      if (directory) mkdirSync(path);
      else writeFileSync(path, "{");
      const inode = statSync(path).ino;
      const store = new BrowserExtensionStore(path);
      expect(store.record("member").backend).toBeNull();
      // Force the atomic write to fail after preservation succeeds.
      mkdirSync(path + ".tmp");
      expect(() => store.select("member", "headless")).toThrow();
      expect(statSync(path).ino).toBe(inode);
      if (!directory) expect(readFileSync(path, "utf8")).toBe("{");
      expect(
        new BrowserExtensionStore(path).record("member").backend,
      ).toBeNull();
      expect(
        readdirSync(dir).filter((name) => name.includes(".unavailable-")),
      ).toHaveLength(0);
      rmSync(path + ".tmp", { recursive: true });
      store.select("member", "headless");
      expect(new BrowserExtensionStore(path).record("member").backend).toBe(
        "headless",
      );
      const backup = readdirSync(dir).find((name) =>
        name.includes(".unavailable-"),
      )!;
      expect(statSync(join(dir, backup)).ino).toBe(inode);
      rmSync(join(dir, backup), { recursive: true });
      rmSync(path);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid stored backend blocks only that member until explicit selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-selection-invalid-"));
  const path = join(dir, "connections.json");
  try {
    for (const backend of ["invalid", 3, null, {}, undefined]) {
      const original = JSON.stringify({
        bad: { backend },
        good: { backend: "extension" },
      });
      writeFileSync(path, original);
      const store = new BrowserExtensionStore(path);
      expect(store.record("bad").backend).toBeNull();
      expect(store.record("good").backend).toBe("extension");
      expect(store.record("new").backend).toBe("headless");
      store.select("bad", "headless");
      expect(new BrowserExtensionStore(path).record("bad").backend).toBe(
        "headless",
      );
      expect(
        readdirSync(dir)
          .filter((name) => name.startsWith("connections.json.unavailable-"))
          .some((name) => readFileSync(join(dir, name), "utf8") === original),
      ).toBe(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unavailable selections never invoke the headless pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-no-fallback-"));
  const path = join(dir, "connections.json");
  const headless = spyOn(browserPool, "run").mockResolvedValue({
    ok: true,
    url: "",
    title: "",
    closed: true,
  });
  try {
    for (const content of [
      "{",
      JSON.stringify({ member: { backend: "invalid" } }),
      null,
    ]) {
      rmSync(path, { recursive: true, force: true });
      if (content === null) mkdirSync(path);
      else writeFileSync(path, content);
      const service = new BrowserExtensionService(
        new BrowserExtensionStore(path),
        { memberExists: () => true, mayUse: () => true },
      );
      const sessions = new ExtensionBrowserSessions(
        service,
        () => "member",
        () => true,
      );
      expect(service.status("member").selectionRequired).toBe(true);
      expect(await sessions.run("agent", { action: "close" })).toMatchObject({
        ok: false,
        code: "browser_selection_required",
      });
      expect(headless).not.toHaveBeenCalled();
      sessions.stop();
      service.stop();
    }
  } finally {
    headless.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queued browser work cannot cross Off into a replacement tab offer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-off-queue-"));
  const store = new BrowserExtensionStore(join(dir, "connections.json"));
  const service = new BrowserExtensionService(store, { memberExists: () => true, mayUse: () => true });
  const sessions = new ExtensionBrowserSessions(service, () => "member", () => true, () => 500);
  try {
    store.select("member", "extension");
    const { code } = store.pair("member", false);
    const { credential } = store.redeem(code, "chrome-extension://" + "a".repeat(32), () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, { send: m => { messages.push(m); }, close() {} });
    const offer = async (targetId: string) => {
      const assignment = crypto.randomUUID();
      connection.receive({ kind: "offer", generation: connection.generation, assignment, agent: "agent" });
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
    store.select("member", "extension");
    const { code } = store.pair("member", false);
    const { credential } = store.redeem(code, origin, () => true);
    const messages: Record<string, unknown>[] = [];
    const connection = service.bridge.connect(credential, { send: m => { messages.push(m); }, close() {} });
    expect(service.bridge.forMember("member")).toBe(connection);
    expect(connection.offered("agent")).toBeUndefined();
    for (const body of [{ action: "snapshot" }, { action: "goto", url: "https://example.com/" }]) {
      const result = await sessions.run("agent", body);
      expect(messages.filter(m => m.kind === "command")).toHaveLength(0);
      expect(result).toMatchObject({ ok: false, code: "browser_control_ended" });
    }
  } finally {
    sessions.stop(); service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
