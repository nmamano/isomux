import { describe, expect, it } from "bun:test";
import { ProviderAccountManager } from "./provider-account-manager.ts";

describe("ProviderAccountManager", () => {
  it("allows only one login process for a shared credential directory", async () => {
    let starts = 0;
    const fake = () => ({
      start: async () => {
        starts++;
      },
      login: async () => ({
        loginId: "login-1",
        authUrl: "https://auth.openai.com/",
      }),
      waitForCompletion: () => new Promise(() => {}),
      read: async () => ({ connected: false }),
      cancel: async () => {},
      close: async () => {},
    });
    const manager = new ProviderAccountManager(() => {}, fake as never);
    const first = await manager.startLogin("user-a", "browser");
    const second = await manager.startLogin("user-b", "browser");
    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      status: 409,
      code: "shared_login_in_progress",
      message: "Another user is signing in to this shared Codex account.",
    });
    expect(starts).toBe(1);
  });

  it("returns the same operation when its user starts it again", async () => {
    let starts = 0;
    const fake = () => ({
      start: async () => {
        starts++;
      },
      login: async () => ({
        loginId: "login-1",
        authUrl: "https://auth.openai.com/",
      }),
      waitForCompletion: () => new Promise(() => {}),
      read: async () => ({ connected: false }),
      cancel: async () => {},
      close: async () => {},
    });
    const manager = new ProviderAccountManager(() => {}, fake as never);
    const first = await manager.startLogin("user-a", "browser");
    const again = await manager.startLogin("user-a", "browser");
    expect(again).toEqual(first);
    expect(starts).toBe(1);
  });

  it("checks account/read before a nullable completion can become connected", async () => {
    const emitted: Array<
      Array<{ loginStatus: string; accountStatus: string }>
    > = [];
    const fake = () => ({
      start: async () => {},
      login: async () => ({
        loginId: "login-1",
        authUrl: "https://auth.openai.com/",
      }),
      waitForCompletion: async () => ({
        loginId: null,
        success: true,
        error: null,
      }),
      read: async () => ({ connected: false }),
      cancel: async () => {},
      close: async () => {},
    });
    const manager = new ProviderAccountManager(
      (_userId, accounts) => emitted.push(accounts),
      fake as never,
    );
    await manager.startLogin("user-a", "browser");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted.at(-1)?.[0]).toMatchObject({
      loginStatus: "failed",
      accountStatus: "not_connected",
    });
  });

  it("does not let a canceled operation settle later", async () => {
    let complete!: (value: {
      loginId: string;
      success: boolean;
      error: null;
    }) => void;
    const emitted: string[] = [];
    const fake = () => ({
      start: async () => {},
      login: async () => ({
        loginId: "login-1",
        authUrl: "https://auth.openai.com/",
      }),
      waitForCompletion: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      read: async () => ({ connected: true }),
      cancel: async () => {},
      close: async () => {},
    });
    const manager = new ProviderAccountManager(
      (_userId, accounts) => emitted.push(accounts[0]?.loginStatus ?? "none"),
      fake as never,
    );
    await manager.startLogin("user-a", "browser");
    await manager.cancel("user-a");
    complete({ loginId: "login-1", success: true, error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).not.toContain("succeeded");
  });

  it("releases a shared credential directory after the login deadline", async () => {
    let starts = 0;
    const fake = () => ({
      start: async () => {
        starts++;
      },
      login: async () => ({
        loginId: `login-${starts}`,
        authUrl: "https://auth.openai.com/",
      }),
      waitForCompletion: () => new Promise(() => {}),
      read: async () => ({ connected: false }),
      cancel: async () => {},
      close: async () => {},
    });
    const manager = new ProviderAccountManager(() => {}, fake as never, 5);
    await manager.startLogin("user-a", "browser");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await manager.startLogin("user-b", "browser");
    expect(second.ok).toBe(true);
    expect(starts).toBe(2);
  });

  it("caches account status probes", async () => {
    let starts = 0;
    const fake = () => ({
      start: async () => {
        starts++;
      },
      read: async () => ({ connected: false }),
      close: async () => {},
    });
    const manager = new ProviderAccountManager(() => {}, fake as never);
    await manager.list("user-a");
    await manager.list("user-a");
    expect(starts).toBe(1);
  });

  it("does not share cached status across user environment sources", async () => {
    let starts = 0;
    const fake = (env?: Record<string, string | undefined>) => ({
      start: async () => {
        starts++;
      },
      read: async () => ({
        connected: Boolean(env?.OPENAI_API_KEY),
        label: env?.OPENAI_API_KEY ? "API key" : undefined,
      }),
      close: async () => {},
    });
    const manager = new ProviderAccountManager(
      () => {},
      fake as never,
      undefined,
      (userId) => `env-${userId}`,
      (userId) => (userId === "user-a" ? { OPENAI_API_KEY: "test-key" } : {}),
    );
    const userA = await manager.list("user-a");
    const userB = await manager.list("user-b");
    expect(userA[0]).toMatchObject({
      accountStatus: "connected",
      accountLabel: "API key",
    });
    expect(userB[0]).toMatchObject({ accountStatus: "not_connected" });
    expect(starts).toBe(2);
  });
});
