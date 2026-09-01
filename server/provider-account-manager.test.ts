import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { ProviderAccountManager } from "./provider-account-manager.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";

const disconnectedAccountClient = () => ({
  start: async () => {},
  read: async () => ({ connected: false }),
  close: async () => {},
});

describe("ProviderAccountManager", () => {
  it("marks external CLI directories by resolved path for both providers", async () => {
    const fake = () => ({
      start: async () => {},
      read: async () => ({ connected: false }),
      close: async () => {},
    });
    const external = new ProviderAccountManager(
      () => {},
      fake as never,
      undefined,
      undefined,
      () => ({}),
      fake as never,
      () => ({
        CODEX_HOME: resolve(homedir(), ".codex"),
        CLAUDE_CONFIG_DIR: resolve(homedir(), ".claude"),
      }),
    );
    const managed = new ProviderAccountManager(
      () => {},
      fake as never,
      undefined,
      undefined,
      () => ({}),
      fake as never,
      () => ({
        CODEX_HOME: "/tmp/isomux-codex",
        CLAUDE_CONFIG_DIR: "/tmp/isomux-claude",
      }),
    );

    for (const account of await external.list("user-a"))
      if (account.scope === "office") expect(account.externalCli).toBe(true);
    for (const account of await managed.list("user-a"))
      if (account.scope === "office") expect(account.externalCli).toBe(false);
  });

  it("invalidates and emits an office disconnect for every member", async () => {
    let connected = true;
    const emitted: Array<{ userId: string; connected: boolean }> = [];
    const fake = () => ({
      start: async () => {},
      read: async () => ({ connected }),
      logout: async () => {
        connected = false;
      },
      close: async () => {},
    });
    const manager = new ProviderAccountManager(
      (userId, accounts) =>
        emitted.push({
          userId,
          connected:
            accounts.find(
              (account) =>
                account.provider === "codex" && account.scope === "office",
            )?.accountStatus === "connected",
        }),
      fake as never,
      undefined,
      (userId) => userId,
      () => ({}),
      fake as never,
      () => ({ CODEX_HOME: "/tmp/isomux-codex" }),
      () => ({}),
      () => ({}),
      () => [{ id: "user-a" }, { id: "user-b" }],
    );
    await manager.list("user-a");
    await manager.list("user-b");

    const result = await manager.disconnect("user-a", "codex", "office");

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(
        result.value.accounts.find(
          (account) =>
            account.provider === "codex" && account.scope === "office",
        )?.accountStatus,
      ).toBe("not_connected");
    expect(emitted.slice(-2)).toEqual([
      { userId: "user-a", connected: false },
      { userId: "user-b", connected: false },
    ]);
    expect(
      (await manager.list("user-b")).find(
        (account) => account.provider === "codex" && account.scope === "office",
      )?.accountStatus,
    ).toBe("not_connected");
  });

  it("verifies Claude removal before deactivation and accepts an absent credential", async () => {
    const root = mkdtempSync("/tmp/provider-disconnect-");
    const home = resolve(root, "user-a", "claude");
    mkdirSync(home, { recursive: true });
    writeFileSync(resolve(home, ".credentials.json"), "fixture");
    const order: string[] = [];
    const claude = () => ({
      start: async () => {},
      read: async () => {
        const connected = existsSync(resolve(home, ".credentials.json"));
        order.push(`read:${connected}`);
        return { connected };
      },
      close: async () => {},
    });
    const codex = () => ({
      start: async () => {},
      read: async () => ({ connected: false }),
      close: async () => {},
    });
    const manager = new ProviderAccountManager(
      () => {},
      codex as never,
      undefined,
      undefined,
      () => ({}),
      claude as never,
      () => ({}),
      () => ({}),
      () => ({}),
      () => [{ id: "user-a" }],
      () => home,
      () => home,
      () => true,
      () => {},
      () => order.push("deactivate"),
    );

    const result = await manager.disconnect("user-a", "claude", "personal");

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(
        result.value.accounts.find(
          (account) =>
            account.provider === "claude" && account.scope === "personal",
        )?.accountStatus,
      ).toBe("not_connected");
    expect(order.slice(0, 2)).toEqual(["read:false", "deactivate"]);
    expect(existsSync(resolve(home, ".credentials.json"))).toBe(false);
    expect((await manager.disconnect("user-a", "claude", "personal")).ok).toBe(
      true,
    );
    rmSync(root, { recursive: true });
  });
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
    const manager = new ProviderAccountManager(
      () => {},
      fake as never,
      undefined,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
    );
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
    const manager = new ProviderAccountManager(
      () => {},
      fake as never,
      undefined,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
    );
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
      undefined,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
    );
    await manager.startLogin("user-a", "codex", "office", "browser");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted.at(-1)?.[0]).toMatchObject({
      loginStatus: "failed",
      accountStatus: "not_connected",
    });
  });

  it("verifies Codex device-code completion in a fresh client", async () => {
    let complete!: (value: {
      loginId: string;
      success: boolean;
      error: null;
    }) => void;
    let clients = 0;
    const emitted: string[] = [];
    const manager = new ProviderAccountManager(
      (_userId, accounts) => {
        const wire = accounts.find(
          (account) =>
            account.provider === "codex" && account.scope === "office",
        );
        if (wire)
          emitted.push(
            `${wire.loginStatus}/${wire.accountStatus}/${wire.error ?? "none"}`,
          );
      },
      (() => {
        const client = ++clients;
        return {
          start: async () => {},
          login: async () => ({
            loginId: "device-1",
            authUrl: "https://auth.openai.com/",
            userCode: "ABCD",
          }),
          waitForCompletion: () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
          read: async () =>
            client === 1
              ? { connected: false }
              : { connected: true, label: "signed-in@example.com" },
          close: async () => {},
        };
      }) as never,
      undefined,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
    );

    await manager.startLogin("user-a", "codex", "office", "device");
    complete({ loginId: "device-1", success: true, error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clients).toBeGreaterThan(1);
    expect(emitted.at(-1)).toBe("succeeded/connected/none");
  });

  it("does not reuse a pre-logout probe for a refresh", async () => {
    let connected = true;
    let release!: () => void;
    let reads = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: async () => {},
        read: async () => {
          const snapshot = connected;
          reads++;
          if (reads === 1) await held;
          return { connected: snapshot };
        },
        logout: async () => {
          connected = false;
        },
        close: async () => {},
      })) as never,
      undefined,
      (userId) => userId,
      () => ({}),
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      () => ({ CODEX_HOME: "/tmp/provider-refresh-codex" }),
      () => ({}),
      () => ({}),
      () => [{ id: "user-a" }],
    );

    const oldProbe = manager.list("user-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const disconnect = manager.disconnect("user-a", "codex", "office");
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const result = await disconnect;
    await oldProbe;

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(
        result.value.accounts.find(
          (account) =>
            account.provider === "codex" && account.scope === "office",
        )?.accountStatus,
      ).toBe("not_connected");
    expect(
      (await manager.list("user-a")).find(
        (account) => account.provider === "codex" && account.scope === "office",
      )?.accountStatus,
    ).toBe("not_connected");
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
      undefined,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
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
    const manager = new ProviderAccountManager(
      () => {},
      fake as never,
      5,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
    );
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
    const manager = new ProviderAccountManager(
      () => {},
      fake as never,
      undefined,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
    );
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
      disconnectedAccountClient as never,
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
    [
      "shared home",
      resolve(homedir(), ".claude"),
      "CLAUDE_CONFIG_DIR collides with the box's external Claude CLI directory. Choose a different directory.",
    ],
    [
      "office env file",
      "/tmp/office-file-claude",
      "CLAUDE_CONFIG_DIR collides with the office Claude account directory. Choose a different directory.",
    ],
    [
      "process environment",
      "/tmp/process-claude",
      "CLAUDE_CONFIG_DIR collides with the office Claude account directory. Choose a different directory.",
    ],
    [
      "another user",
      "/tmp/other-user-claude",
      "CLAUDE_CONFIG_DIR collides with another member's Claude account directory. Choose a different directory.",
    ],
    [
      "relative",
      "relative/claude",
      "CLAUDE_CONFIG_DIR must be an absolute directory.",
    ],
    ["tilde", "~/.claude", "CLAUDE_CONFIG_DIR must be an absolute directory."],
    [
      "variable",
      "$HOME/.claude",
      "CLAUDE_CONFIG_DIR must be an absolute directory.",
    ],
  ] as const;

  for (const [name, value, message] of refusalCases) {
    it(`refuses Claude personal login for ${name}`, async () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      if (name === "process environment")
        process.env.CLAUDE_CONFIG_DIR = "/tmp/process-claude";
      else delete process.env.CLAUDE_CONFIG_DIR;
      let claudeStarts = 0;
      const own: Record<string, string> = { CLAUDE_CONFIG_DIR: value };
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
        () => ({
          CLAUDE_CONFIG_DIR:
            name === "office env file"
              ? "/tmp/resolved-office-claude"
              : "/tmp/office-file-claude",
        }),
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
          message,
        });
        expect(claudeStarts).toBe(0);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
  }

  for (const value of [undefined, "", "   "] as const) {
    it(`auto-provisions Claude personal login for ${value === undefined ? "missing" : JSON.stringify(value)}`, async () => {
      let ensured = 0;
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
        () => ({}),
        (() => ({
          start: async () => {},
          login: async () => ({ authUrl: "https://claude.com/oauth/" }),
          waitForCompletion: () => new Promise(() => {}),
          read: async () => ({ connected: false }),
          close: async () => {},
        })) as never,
        () => ({}),
        () => ({}),
        () => own,
        () => [{ id: "user-a" }],
        (userId, provider) => `/tmp/provider-homes/${userId}/${provider}`,
        (userId, provider) => {
          ensured++;
          return `/tmp/provider-homes/${userId}/${provider}`;
        },
        () => false,
        () => {},
      );
      const result = await manager.startLogin(
        "user-a",
        "claude",
        "personal",
        "browser",
      );
      expect(result.ok).toBe(true);
      expect(ensured).toBe(1);
    });
  }

  for (const provider of ["claude", "codex"] as const) {
    it(`keeps an explicit ${provider} directory ahead of an activated managed home`, async () => {
      const variable =
        provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const explicit = `/tmp/explicit-${provider}`;
      const seen: Array<string | undefined> = [];
      const client = (env?: Record<string, string | undefined>) => {
        seen.push(env?.[variable]);
        return {
          start: async () => {},
          login: async () => ({
            authUrl: "https://example.com/oauth/",
            loginId: "login",
          }),
          waitForCompletion: () => new Promise(() => {}),
          read: async () => ({ connected: false }),
          close: async () => {},
        };
      };
      const manager = new ProviderAccountManager(
        () => {},
        client as never,
        undefined,
        undefined,
        () => ({ [variable]: explicit }),
        client as never,
        () => ({}),
        () => ({}),
        () => ({ [variable]: explicit }),
        () => [{ id: "user-a" }],
        (userId, selectedProvider) =>
          `/tmp/provider-homes/${userId}/${selectedProvider}`,
        undefined,
        () => true,
      );
      const result = await manager.startLogin(
        "user-a",
        provider,
        "personal",
        "browser",
      );
      expect(result.ok).toBe(true);
      expect(seen).toContain(explicit);
      expect(seen).not.toContain(`/tmp/provider-homes/user-a/${provider}`);
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
    expect(claudeStarts).toBe(2);
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
    expect(clients).toBe(3);
  });

  it("activates an auto-provisioned personal home only after verified connection", async () => {
    let complete!: () => void;
    const activated: Array<[string, string]> = [];
    let clients = 0;
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      undefined,
      undefined,
      () => ({}),
      (() => {
        clients++;
        if (clients === 1)
          return {
            start: async () => {},
            login: async () => ({ authUrl: "https://claude.com/oauth/" }),
            waitForCompletion: () =>
              new Promise<void>((resolvePromise) => {
                complete = resolvePromise;
              }),
            read: async () => ({ connected: false }),
            close: async () => {},
          };
        return {
          start: async () => {},
          read: async () => ({ connected: true }),
          close: async () => {},
        };
      }) as never,
      () => ({}),
      () => ({}),
      () => ({}),
      () => [{ id: "user-a" }],
      (userId, provider) => `/tmp/provider-homes/${userId}/${provider}`,
      (userId, provider) => `/tmp/provider-homes/${userId}/${provider}`,
      () => false,
      (userId, provider) => activated.push([userId, provider]),
    );
    await manager.startLogin("user-a", "claude", "personal", "browser");
    expect(activated).toEqual([]);
    complete();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(activated).toEqual([["user-a", "claude"]]);
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
    expect(closes).toBe(2);
    const second = await manager.startLogin(
      "user-a",
      "claude",
      "personal",
      "browser",
    );
    expect(second.ok).toBe(true);
    expect(starts).toBe(3);
  });

  it("starts office Claude browser login in the effective office directory", async () => {
    const dirs: Array<string | undefined> = [];
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      undefined,
      undefined,
      () => ({}),
      ((env?: Record<string, string | undefined>) => {
        dirs.push(env?.CLAUDE_CONFIG_DIR);
        return {
          start: async () => {},
          login: async () => ({ authUrl: "https://claude.com/oauth/" }),
          waitForCompletion: () => new Promise(() => {}),
          read: async () => ({ connected: false }),
          close: async () => {},
        };
      }) as never,
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/office-claude" }),
    );
    const accounts = await manager.list("user-a");
    expect(
      accounts.find(
        (account) =>
          account.provider === "claude" && account.scope === "office",
      ),
    ).toMatchObject({ canBrowserLogin: true });
    const result = await manager.startLogin(
      "user-a",
      "claude",
      "office",
      "browser",
    );
    expect(result.ok).toBe(true);
    expect(dirs).toContain("/tmp/office-claude");
  });

  it("refuses the resolved office Claude directory independently of office-file candidates", async () => {
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      undefined,
      undefined,
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/resolved-office-claude" }),
      undefined,
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/resolved-office-claude" }),
      () => ({}),
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/resolved-office-claude" }),
      () => [{ id: "user-a" }],
    );
    const result = await manager.startLogin(
      "user-a",
      "claude",
      "personal",
      "browser",
    );
    expect(result).toMatchObject({
      ok: false,
      message:
        "CLAUDE_CONFIG_DIR collides with the office Claude account directory. Choose a different directory.",
    });
  });

  it("refuses another member's provisioned Claude home", async () => {
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      undefined,
      undefined,
      () => ({}),
      (() => ({
        start: async () => {},
        login: async () => ({ authUrl: "https://claude.com/oauth/" }),
        waitForCompletion: () => new Promise(() => {}),
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      () => ({}),
      () => ({}),
      (userId): Record<string, string> =>
        userId === "user-a"
          ? { CLAUDE_CONFIG_DIR: "/tmp/provider-homes/user-b/claude" }
          : {},
      () => [{ id: "user-a" }, { id: "user-b" }],
      (userId, provider) => `/tmp/provider-homes/${userId}/${provider}`,
    );
    const result = await manager.startLogin(
      "user-a",
      "claude",
      "personal",
      "browser",
    );
    expect(result).toMatchObject({
      ok: false,
      message:
        "CLAUDE_CONFIG_DIR collides with another member's Claude account directory. Choose a different directory.",
    });
  });

  it("refuses the box's external Codex CLI directory", async () => {
    const manager = new ProviderAccountManager(
      () => {},
      undefined,
      undefined,
      undefined,
      () => ({ CODEX_HOME: resolve(homedir(), ".codex") }),
      undefined,
      () => ({}),
      () => ({}),
      () => ({ CODEX_HOME: resolve(homedir(), ".codex") }),
      () => [{ id: "user-a" }],
    );
    const result = await manager.startLogin(
      "user-a",
      "codex",
      "personal",
      "browser",
    );
    expect(result).toMatchObject({
      ok: false,
      message:
        "CODEX_HOME collides with the box's external Codex CLI directory. Choose a different directory.",
    });
  });

  it("refuses another member's provisioned Codex home", async () => {
    const manager = new ProviderAccountManager(
      () => {},
      undefined,
      undefined,
      undefined,
      () => ({ CODEX_HOME: "/tmp/provider-homes/user-b/codex" }),
      undefined,
      () => ({}),
      () => ({}),
      (userId): Record<string, string> =>
        userId === "user-a"
          ? { CODEX_HOME: "/tmp/provider-homes/user-b/codex" }
          : {},
      () => [{ id: "user-a" }, { id: "user-b" }],
      (userId, provider) => `/tmp/provider-homes/${userId}/${provider}`,
    );
    const result = await manager.startLogin(
      "user-a",
      "codex",
      "personal",
      "browser",
    );
    expect(result).toMatchObject({
      ok: false,
      message:
        "CODEX_HOME collides with another member's Codex account directory. Choose a different directory.",
    });
  });

  const codexRefusalCases: Array<
    [string, string, Record<string, string>, Record<string, string>, string]
  > = [
    [
      "isomux office directory",
      ISOMUX_CODEX_HOME,
      {},
      {},
      "CODEX_HOME collides with the office Codex account directory. Choose a different directory.",
    ],
    [
      "office directory",
      "/tmp/office-codex",
      {},
      {},
      "CODEX_HOME collides with the office Codex account directory. Choose a different directory.",
    ],
    [
      "office env file",
      "/tmp/office-file-codex",
      { CODEX_HOME: "/tmp/office-file-codex" },
      {},
      "CODEX_HOME collides with the office Codex account directory. Choose a different directory.",
    ],
    [
      "process environment",
      "/tmp/process-codex",
      {},
      { CODEX_HOME: "/tmp/process-codex" },
      "CODEX_HOME collides with the office Codex account directory. Choose a different directory.",
    ],
    [
      "another configured member",
      "/tmp/other-user-codex",
      {},
      {},
      "CODEX_HOME collides with another member's Codex account directory. Choose a different directory.",
    ],
  ];

  for (const [
    name,
    value,
    officeFile,
    processValue,
    message,
  ] of codexRefusalCases) {
    it(`refuses Codex personal login for ${name}`, async () => {
      const previous = process.env.CODEX_HOME;
      if (processValue.CODEX_HOME)
        process.env.CODEX_HOME = processValue.CODEX_HOME;
      else delete process.env.CODEX_HOME;
      const manager = new ProviderAccountManager(
        () => {},
        (() => ({
          start: async () => {},
          login: async () => ({
            loginId: "login",
            authUrl: "https://example.com/oauth/",
          }),
          waitForCompletion: () => new Promise(() => {}),
          read: async () => ({ connected: false }),
          close: async () => {},
        })) as never,
        undefined,
        undefined,
        () => ({ CODEX_HOME: value }),
        undefined,
        () => ({ CODEX_HOME: "/tmp/office-codex" }),
        () => officeFile,
        (userId) =>
          userId === "user-a"
            ? { CODEX_HOME: value }
            : { CODEX_HOME: "/tmp/other-user-codex" },
        () => [{ id: "user-a" }, { id: "user-b" }],
      );
      try {
        const result = await manager.startLogin(
          "user-a",
          "codex",
          "personal",
          "browser",
        );
        expect(result).toMatchObject({ ok: false, message });
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
      }
    });
  }

  for (const value of ["relative/codex", "~/.codex", "$HOME/.codex"] as const) {
    it(`refuses Codex personal login for non-absolute ${value}`, async () => {
      const manager = new ProviderAccountManager(
        () => {},
        undefined,
        undefined,
        undefined,
        () => ({ CODEX_HOME: value }),
        undefined,
        () => ({}),
        () => ({}),
        () => ({ CODEX_HOME: value }),
        () => [{ id: "user-a" }],
      );
      const result = await manager.startLogin(
        "user-a",
        "codex",
        "personal",
        "browser",
      );
      expect(result).toMatchObject({
        ok: false,
        message: "CODEX_HOME must be an absolute directory.",
      });
    });
  }
});
