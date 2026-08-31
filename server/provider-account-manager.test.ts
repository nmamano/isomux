import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
    const first = await manager.startLogin(
      "user-a",
      "codex",
      "office",
      "browser",
    );
    const second = await manager.startLogin(
      "user-b",
      "codex",
      "office",
      "browser",
    );
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
    const first = await manager.startLogin(
      "user-a",
      "codex",
      "office",
      "browser",
    );
    const again = await manager.startLogin(
      "user-a",
      "codex",
      "office",
      "browser",
    );
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
    await manager.startLogin("user-a", "codex", "office", "browser");
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
    await manager.startLogin("user-a", "codex", "office", "browser");
    await manager.cancel("user-a", "codex", "office");
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
    await manager.startLogin("user-a", "codex", "office", "browser");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await manager.startLogin(
      "user-b",
      "codex",
      "office",
      "browser",
    );
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
      (userId) => ({
        CODEX_HOME: `/tmp/${userId}-codex`,
        ...(userId === "user-a" ? { OPENAI_API_KEY: "test-key" } : {}),
      }),
      undefined,
      () => ({}),
      () => ({}),
      (userId) => ({ CODEX_HOME: `/tmp/${userId}-codex` }),
      () => [{ id: "user-a" }, { id: "user-b" }],
    );
    const userA = await manager.list("user-a");
    const userB = await manager.list("user-b");
    expect(
      userA.find(
        (account) => account.provider === "codex" && account.scope === "office",
      ),
    ).toMatchObject({
      accountStatus: "connected",
      accountLabel: "API key",
    });
    expect(
      userB.find(
        (account) => account.provider === "codex" && account.scope === "office",
      ),
    ).toMatchObject({ accountStatus: "not_connected" });
    // Two users times two independently resolved Codex targets.
    expect(starts).toBe(4);
  });

  const refusalCases = [
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["shared home", resolve(homedir(), ".claude")],
    ["office env file", "/tmp/office-file-claude"],
    ["process environment", "/tmp/process-claude"],
    ["another user", "/tmp/other-user-claude"],
    ["relative", "relative/claude"],
    ["tilde", "~/.claude"],
    ["variable", "$HOME/.claude"],
  ] as const;

  for (const [name, value] of refusalCases) {
    it(`refuses Claude personal login for ${name}`, async () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      if (name === "process environment")
        process.env.CLAUDE_CONFIG_DIR = "/tmp/process-claude";
      else delete process.env.CLAUDE_CONFIG_DIR;
      let claudeStarts = 0;
      const own: Record<string, string> =
        value === undefined ? {} : { CLAUDE_CONFIG_DIR: value };
      const manager = new ProviderAccountManager(
        () => {},
        (() => ({
          start: async () => {},
          read: async () => ({ connected: false }),
          close: async () => {},
        })) as never,
        undefined,
        undefined,
        (userId) =>
          userId === "user-a"
            ? own
            : { CLAUDE_CONFIG_DIR: "/tmp/other-user-claude" },
        (() => {
          claudeStarts++;
          return {
            start: async () => {},
            login: async () => ({ authUrl: "https://claude.com/oauth/" }),
            waitForCompletion: () => new Promise(() => {}),
            read: async () => ({ connected: false }),
            close: async () => {},
          };
        }) as never,
        () => ({ CLAUDE_CONFIG_DIR: "/tmp/office-file-claude" }),
        () => ({ CLAUDE_CONFIG_DIR: "/tmp/office-file-claude" }),
        (userId) =>
          userId === "user-a"
            ? own
            : { CLAUDE_CONFIG_DIR: "/tmp/other-user-claude" },
        () => [{ id: "user-a" }, { id: "user-b" }],
      );
      try {
        const result = await manager.startLogin(
          "user-a",
          "claude",
          "personal",
          "browser",
        );
        expect(result).toEqual({
          ok: false,
          status: 422,
          code: "browser_login_unavailable",
          message:
            "Claude sign-in from the browser needs your own Claude config directory. Set CLAUDE_CONFIG_DIR in your env file, and then try again.",
        });
        expect(claudeStarts).toBe(0);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
  }

  it("starts Claude personal login for a unique absolute directory", async () => {
    let claudeStarts = 0;
    const fakeClaude = () => ({
      start: async () => {
        claudeStarts++;
      },
      login: async () => ({ authUrl: "https://claude.com/oauth/" }),
      waitForCompletion: () => new Promise(() => {}),
      read: async () => ({ connected: false }),
      close: async () => {},
    });
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      undefined,
      undefined,
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/user-a-claude" }),
      fakeClaude as never,
      () => ({}),
      () => ({}),
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/user-a-claude" }),
      () => [{ id: "user-a" }],
    );
    const result = await manager.startLogin(
      "user-a",
      "claude",
      "personal",
      "browser",
    );
    expect(result.ok).toBe(true);
    expect(claudeStarts).toBe(1);
  });

  it("rechecks Claude credentials in a fresh client after code completion", async () => {
    let complete!: () => void;
    let clients = 0;
    const emitted: Array<
      Array<{ provider: string; loginStatus: string; scope: string }>
    > = [];
    const createClaude = () => {
      clients++;
      if (clients === 1)
        return {
          start: async () => {},
          login: async () => ({ authUrl: "https://claude.com/oauth/" }),
          submitCode: async () => {},
          waitForCompletion: () =>
            new Promise<void>((resolvePromise) => {
              complete = resolvePromise;
            }),
          read: async () => ({ connected: false }),
          close: async () => {},
        };
      return {
        start: async () => {},
        read: async () => ({
          connected: true,
          label: "person@example.com",
        }),
        close: async () => {},
      };
    };
    const manager = new ProviderAccountManager(
      (_userId, accounts) => emitted.push(accounts),
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      undefined,
      undefined,
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/user-a-claude" }),
      createClaude as never,
      () => ({}),
      () => ({}),
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/user-a-claude" }),
      () => [{ id: "user-a" }],
    );
    await manager.startLogin("user-a", "claude", "personal", "browser");
    const submitted = await manager.submitCode(
      "user-a",
      "claude",
      "personal",
      "code#state",
    );
    expect(submitted.ok).toBe(true);
    const submittedAgain = await manager.submitCode(
      "user-a",
      "claude",
      "personal",
      "code#state",
    );
    expect(submittedAgain.ok).toBe(true);
    complete();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const claude = emitted
      .at(-1)
      ?.find(
        (account) =>
          account.provider === "claude" && account.scope === "personal",
      );
    expect(claude).toMatchObject({ loginStatus: "succeeded" });
    expect(clients).toBe(2);
  });

  it("closes and releases an abandoned Claude login after its deadline", async () => {
    let starts = 0;
    let closes = 0;
    const fakeClaude = () => ({
      start: async () => {
        starts++;
      },
      login: async () => ({
        authUrl: `https://claude.com/oauth/?attempt=${starts}`,
      }),
      submitCode: async () => {},
      waitForCompletion: () => new Promise(() => {}),
      read: async () => ({ connected: false }),
      close: async () => {
        closes++;
      },
    });
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      5,
      undefined,
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/user-a-claude" }),
      fakeClaude as never,
      () => ({}),
      () => ({}),
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/user-a-claude" }),
      () => [{ id: "user-a" }],
    );
    const first = await manager.startLogin(
      "user-a",
      "claude",
      "personal",
      "browser",
    );
    expect(first.ok).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    expect(closes).toBe(1);
    const second = await manager.startLogin(
      "user-a",
      "claude",
      "personal",
      "browser",
    );
    expect(second.ok).toBe(true);
    expect(starts).toBe(2);
  });
});
