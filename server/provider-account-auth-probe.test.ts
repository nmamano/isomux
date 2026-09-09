import { describe, expect, it } from "bun:test";
import { ProviderAccountManager } from "./provider-account-manager.ts";

function fixture(createClaude: () => unknown, createCodex = () => ({
  start: async () => {}, read: async () => ({ connected: true }), close: async () => {},
})) {
  return new ProviderAccountManager(
    () => {}, createCodex as never, undefined, () => "auth-probe",
    () => ({ CLAUDE_CONFIG_DIR: "/tmp/auth-probe-office" }), createClaude as never,
    () => ({ CLAUDE_CONFIG_DIR: "/tmp/auth-probe-office" }), () => ({}), () => ({}),
    () => [{ id: "owner" }], () => "/tmp/auth-probe-personal", undefined, () => false,
  );
}

function selection(controller = new AbortController()) {
  return { provider: "claude" as const, scope: "office" as const, refresh: true as const, signal: controller.signal };
}

describe("fresh scoped Claude account checks", () => {
  it("replaces a connected cache entry without probing Codex or another scope", async () => {
    let connected = true;
    let claudeProbes = 0;
    let codexProbes = 0;
    const manager = fixture(() => ({
      start: async () => { claudeProbes++; }, read: async () => ({ connected }), close: async () => {},
    }), () => ({ start: async () => { codexProbes++; }, read: async () => ({ connected: true }), close: async () => {} }));
    await manager.list("owner");
    expect(claudeProbes).toBe(1);
    expect(codexProbes).toBe(1);
    connected = false;
    const fresh = await manager.list("owner", true, selection());
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ provider: "claude", scope: "office", accountStatus: "not_connected" });
    expect(claudeProbes).toBe(2);
    expect(codexProbes).toBe(1);
    const snapshot = manager.cachedList("owner");
    expect(snapshot).toHaveLength(4);
    expect(snapshot!.find((a) => a.provider === "codex" && a.scope === "office")?.accountStatus).toBe("connected");
    expect(snapshot!.find((a) => a.provider === "claude" && a.scope === "office")?.accountStatus).toBe("not_connected");
    expect(codexProbes).toBe(1);
  });

  it("merges the fresh account status while a browser login is waiting", async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const manager = fixture(() => {
      let loggingIn = false;
      return {
        start: async () => {}, read: async () => ({ connected: true }),
        close: async () => { if (loggingIn) finish(); },
        login: async () => { loggingIn = true; return { authUrl: "https://example.test/login" }; },
        waitForCompletion: () => completion,
      };
    });
    await manager.list("owner");
    expect((await manager.startLogin("owner", "claude", "office", "browser")).ok).toBe(true);
    try {
      const fresh = await manager.list("owner", true, selection());
      const snapshot = manager.cachedList("owner", fresh);
      expect(snapshot?.find((a) => a.provider === "claude" && a.scope === "office")).toMatchObject({
        accountStatus: "connected", loginStatus: "waiting_external",
      });
    } finally { await manager.cancel("owner", "claude", "office"); }
  });

  it("keeps a late full-list result from undoing a completed forced refresh", async () => {
    let first = true;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const manager = fixture(() => {
      const old = first;
      first = false;
      return { start: async () => {}, read: async () => { if (old) await pending; return { connected: old }; }, close: async () => {} };
    });
    const oldFull = manager.list("owner");
    await Promise.resolve();
    await manager.list("owner", true, selection());
    release();
    expect((await oldFull).find((a) => a.provider === "claude" && a.scope === "office")?.accountStatus).toBe("not_connected");
    expect(manager.cachedList("owner")!.find((a) => a.provider === "claude" && a.scope === "office")?.accountStatus).toBe("not_connected");
  });

  it("does not fill a cold unrelated cache by starting Codex", async () => {
    let codexProbes = 0;
    const manager = fixture(() => ({ start: async () => {}, read: async () => ({ connected: false }), close: async () => {} }),
      () => { codexProbes++; throw new Error("Codex must not start"); });
    await manager.list("owner", true, selection());
    expect(manager.cachedList("owner")).toBeNull();
    expect(codexProbes).toBe(0);
  });

  for (const phase of ["start", "read"] as const) {
    it(`closes a pending ${phase} on cancellation and does not cache its late result`, async () => {
      let closeCount = 0;
      let readCount = 0;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const manager = fixture(() => ({
        start: async () => { if (phase === "start") await pending; },
        read: async () => { readCount++; if (phase === "read") await pending; return { connected: true }; },
        close: async () => { closeCount++; },
      }));
      const controller = new AbortController();
      const result = manager.list("owner", true, selection(controller));
      await Promise.resolve();
      controller.abort();
      expect((await result)[0].accountStatus).toBe("unavailable");
      expect(closeCount).toBe(1);
      if (phase === "start") expect(readCount).toBe(0);
      release();
      await Promise.resolve();
      expect(manager.cachedList("owner")).toBeNull();
      expect(closeCount).toBe(1);
    });
  }

  it("closes a client whose factory aborts before returning it", async () => {
    const controller = new AbortController();
    let closed = 0;
    let started = 0;
    const manager = fixture(() => {
      controller.abort();
      return { start: async () => { started++; }, read: async () => ({ connected: true }), close: async () => { closed++; } };
    });
    expect((await manager.list("owner", true, selection(controller)))[0].accountStatus).toBe("unavailable");
    expect(started).toBe(0);
    expect(closed).toBe(1);
  });

  it("maps a throwing probe to unavailable and closes it", async () => {
    let closed = 0;
    const manager = fixture(() => ({ start: async () => { throw new Error("probe failed"); }, read: async () => ({ connected: true }), close: async () => { closed++; } }));
    expect((await manager.list("owner", true, selection()))[0].accountStatus).toBe("unavailable");
    expect(closed).toBe(1);
  });
});
