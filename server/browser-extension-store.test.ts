import { BrowserExtensionService } from "./browser-extension-service";
import { ExtensionBrowserSessions } from "./browser-extension-session";
import { test, expect } from "bun:test";
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
test("pairing is single use, expires, stores hashes only, and a second code adds a browser", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-store-"));
  const path = join(dir, "connections.json");
  let now = 0;
  try {
    const store = new BrowserExtensionStore(path, () => now);
    expect(store.paired("one")).toBe(false);
    const first = store.pair("one");
    expect(first.code.length).toBe(43);
    const paired = store.redeem(first.code, origin, () => true);
    expect(
      store.memberForHash(browserCredentialHash(paired.credential), origin),
    ).toBe("one");
    expect(() => store.redeem(first.code, origin, () => true)).toThrow();
    // A paired member gets a code without any replace flag; it adds a browser.
    const replacement = store.pair("one", "Work laptop");
    const voided = store.pair("one", "Work laptop");
    expect(() => store.redeem(replacement.code, origin, () => true)).toThrow();
    const second = store.redeem(voided.code, origin, () => true);
    expect(() => store.redeem(voided.code, origin, () => true)).toThrow();
    expect(
      store.memberForHash(browserCredentialHash(paired.credential), origin),
    ).toBe("one");
    expect(store.browsers("one").map((b) => [b.name, b.pairedAt])).toEqual([
      ["Browser 1", 0],
      ["Work laptop", 0],
    ]);
    expect(second.browser).toBe(store.browsers("one")[1].id);
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
    expect(saved).not.toContain(voided.code);
    expect(JSON.parse(saved).version).toBe(2);
    const pending = store.pair("two");
    const restart = new BrowserExtensionStore(path);
    expect(restart.browsers("one")).toEqual(store.browsers("one"));
    expect(
      restart.memberForHash(browserCredentialHash(second.credential), origin),
    ).toBe("one");
    expect(() => restart.redeem(pending.code, origin, () => true)).toThrow();
    now = pending.expiresAt;
    expect(() => store.redeem(pending.code, origin, () => true)).toThrow();
    const fresh = store.pair("two");
    expect(() => store.redeem(fresh.code, "null", () => true)).toThrow();
    expect(() => store.redeem(fresh.code, origin, () => false)).toThrow();
    expect(store.redeem(fresh.code, origin, () => true).member).toBe("two");
    restart.revoke("one");
    expect(restart.paired("one")).toBe(false);
    expect(
      new BrowserExtensionStore(path).memberForHash(
        browserCredentialHash(second.credential),
      ),
    ).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version-2 browsers load, names default and are bounded, and a bad entry is preserved on write", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-v2-"));
  const path = join(dir, "connections.json");
  const hash = browserCredentialHash("fixture credential");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        members: {
          member: {
            browsers: [
              { id: "kept", name: "Browser 2", hash, origin, pairedAt: 5 },
              { id: "bad", name: "Broken", hash: "x", origin, pairedAt: 5 },
            ],
          },
        },
      }),
    );
    const store = new BrowserExtensionStore(path);
    expect(store.browsers("member").map((b) => b.id)).toEqual(["kept"]);
    expect(() => store.pair("member", "x".repeat(41))).toThrow();
    // Sanitized and trimmed; control characters do not count.
    store.pair("member", " \u202e" + "y".repeat(40) + "\n");
    const added = store.redeem(store.pair("member").code, origin, () => true);
    expect(store.browsers("member").map((b) => b.name)).toEqual([
      "Browser 2",
      "Browser 1",
    ]);
    const unavailable = readdirSync(dir).filter((n) =>
      n.includes(".unavailable-"),
    );
    expect(unavailable).toHaveLength(1);
    expect(readFileSync(join(dir, unavailable[0]), "utf8")).toContain("Broken");
    const pending = store.pair("member");
    expect(store.revokeBrowser("member", "missing")).toBeUndefined();
    expect(store.revokeBrowser("other", "kept")).toBeUndefined();
    expect(store.revokeBrowser("member", added.browser)).toBe(
      browserCredentialHash(added.credential),
    );
    expect(store.memberForHash(hash, origin)).toBe("member");
    expect(store.redeem(pending.code, origin, () => true).member).toBe(
      "member",
    );
    const cleared = store.pair("member");
    store.revoke("member");
    expect(() => store.redeem(cleared.code, origin, () => true)).toThrow();
    expect(new BrowserExtensionStore(path).paired("member")).toBe(false);
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
      const members = {
        member: { backend: "headless", hash, origin },
        unpaired: { backend: "headless" },
      };
      writeFileSync(
        path,
        JSON.stringify(
          wrapped ? { version: 1, selectionRequired: true, members } : members,
        ),
      );
      const store = new BrowserExtensionStore(path);
      expect(store.memberForHash(hash, origin)).toBe("member");
      expect(
        store.browsers("member").map((b) => [b.name, b.hash, b.pairedAt]),
      ).toEqual([["Browser 1", hash, null]]);
      expect(store.paired("unpaired")).toBe(false);
      const service = new BrowserExtensionService(store, {
        memberExists: () => true,
        mayUse: () => true,
      });
      const sessions = new ExtensionBrowserSessions(
        service,
        () => "unpaired",
        () => true,
      );
      expect(await sessions.run("agent", { action: "snapshot" })).toMatchObject(
        { ok: false, code: "browser_not_paired" },
      );
      expect(service.status("member")).toMatchObject({
        paired: true,
        online: false,
      });
      expect(service.status("member")).not.toHaveProperty("backend");
      expect(service.status("member").browsers).toEqual([
        {
          id: store.browsers("member")[0].id,
          name: "Browser 1",
          pairedAt: null,
          online: false,
        },
      ]);
      // The next write is version 2 and keeps the migrated credential.
      const added = store.redeem(store.pair("member").code, origin, () => true);
      const reloaded = new BrowserExtensionStore(path);
      expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
      expect(reloaded.memberForHash(hash, origin)).toBe("member");
      expect(
        reloaded.memberForHash(browserCredentialHash(added.credential), origin),
      ).toBe("member");
      expect(reloaded.browsers("member").map((b) => b.name)).toEqual([
        "Browser 1",
        "Browser 2",
      ]);
      expect(readFileSync(join(profile, "member.json"), "utf8")).toBe(
        "legacy profile fixture",
      );
      sessions.stop();
      service.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt state requires pairing and preserves source on redemption, including failed writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-repair-"));
  const path = join(dir, "connections.json");
  try {
    for (const directory of [false, true]) {
      if (directory) mkdirSync(path);
      else writeFileSync(path, "{");
      const inode = statSync(path).ino;
      const store = new BrowserExtensionStore(path);
      expect(store.paired("member")).toBe(false);
      const pair = store.pair("member");
      mkdirSync(path + ".tmp");
      expect(() => store.redeem(pair.code, origin, () => true)).toThrow();
      expect(statSync(path).ino).toBe(inode);
      expect(
        readdirSync(dir).filter((n) => n.includes(".unavailable-")),
      ).toHaveLength(0);
      rmSync(path + ".tmp", { recursive: true });
      const retry = store.pair("member");
      const redeemed = store.redeem(retry.code, origin, () => true);
      const backup = readdirSync(dir).find((n) => n.includes(".unavailable-"))!;
      expect(statSync(join(dir, backup)).ino).toBe(inode);
      if (!directory) expect(readFileSync(join(dir, backup), "utf8")).toBe("{");
      expect(
        new BrowserExtensionStore(path).memberForHash(
          browserCredentialHash(redeemed.credential),
          origin,
        ),
      ).toBe("member");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      rmSync(join(dir, backup), { recursive: true });
      rmSync(path);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
