import { afterAll, describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ProviderAccountManager } from "./provider-account-manager.ts";
import { ClaudeAccountClient } from "./backends/claude/account.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";
import { writeManagedUserEnv, removeManagedUserEnv } from "./user-env.ts";

const disconnectedAccountClient = () => ({
  start: async () => {},
  read: async () => ({ connected: false }),
  close: async () => {},
});

describe("ProviderAccountManager", () => {
  it("evicts a timed-out shared probe so a second read starts a fresh probe", async () => {
    let starts = 0;
    const timeouts: Array<() => void> = [];
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: () => {
          starts++;
          return new Promise<void>(() => {});
        },
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      undefined,
      (id) => id,
      () => ({}),
      disconnectedAccountClient as never,
      () => ({}),
      () => ({}),
      () => ({}),
      () => [{ id: "member" }],
      () => "/tmp/timed-out-probe",
      () => "/tmp/timed-out-probe",
      () => false,
      () => {},
      () => {},
      (onTimeout) => {
        timeouts.push(onTimeout);
        return () => {
          const index = timeouts.indexOf(onTimeout);
          if (index >= 0) timeouts.splice(index, 1);
        };
      },
    );

    const first = manager.list("member");
    await Promise.resolve();
    expect(starts).toBe(1);
    timeouts.shift()!();
    const firstAccounts = await first;
    expect(
      firstAccounts.find(
        (account) => account.provider === "codex" && account.scope === "office",
      ),
    ).toMatchObject({
      accountStatus: "unavailable",
      canBrowserLogin: true,
      error: "",
    });

    const second = manager.list("member");
    await Promise.resolve();
    expect(starts).toBe(2);
    timeouts.shift()!();
    await second;
  });

  for (const selector of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    it(`probes personal ${selector} without activating an OAuth home`, async () => {
      let connected = true;
      let probes = 0;
      const manager = new ProviderAccountManager(
        () => {},
        disconnectedAccountClient as never,
        undefined,
        (id) => id,
        () => ({ [selector]: "1" }),
        (() => ({
          start: async () => {
            probes++;
          },
          read: async () => ({ connected }),
          close: async () => {},
        })) as never,
        () => ({}),
        () => ({}),
        () => ({ [selector]: "1" }),
        () => [{ id: "cloud-member" }],
        () => "/tmp/cloud-personal",
        () => "/tmp/cloud-personal",
        () => false,
      );
      const personal = (accounts: Awaited<ReturnType<typeof manager.list>>) =>
        accounts.find(
          (value) => value.provider === "claude" && value.scope === "personal",
        );
      expect(personal(await manager.list("cloud-member"))?.accountStatus).toBe(
        "connected",
      );
      expect(manager.effectiveTarget("cloud-member", "claude").scope).toBe(
        "personal",
      );
      expect(probes).toBe(2);
      expect(
        personal((await manager.cachedList("cloud-member"))!)?.accountStatus,
      ).toBe("connected");
      expect((await manager.memberStatuses("cloud-member"))[0].status).toBe(
        "connected",
      );
      connected = false;
      expect(
        personal(await manager.list("cloud-member", true))?.accountStatus,
      ).toBe("not_connected");
    });

    it(`keeps office ${selector} out of the personal account probe`, async () => {
      const seen: Array<Record<string, string | undefined>> = [];
      const manager = new ProviderAccountManager(
        () => {},
        disconnectedAccountClient as never,
        undefined,
        (id) => id,
        () => ({ [selector]: "1" }),
        ((env: Record<string, string | undefined>) => {
          seen.push(env);
          return disconnectedAccountClient();
        }) as never,
        () => ({ [selector]: "1" }),
        () => ({}),
        () => ({}),
        () => [{ id: "cloud-member" }],
        () => "/tmp/cloud-personal",
        () => "/tmp/cloud-personal",
        () => true,
      );
      await manager.list("cloud-member");
      expect(manager.effectiveTarget("cloud-member", "claude").scope).toBe(
        "office",
      );
      expect(seen).toHaveLength(2);
      expect(
        seen.find((env) => env.CLAUDE_CONFIG_DIR === "/tmp/cloud-personal")?.[
          selector
        ],
      ).toBe("");
      expect(
        seen.find((env) => env.CLAUDE_CONFIG_DIR !== "/tmp/cloud-personal")?.[
          selector
        ],
      ).toBe("1");
    });
  }

  it("resolves managed CODEX_HOME and CLAUDE_CONFIG_DIR as explicitDirectory", async () => {
    const id = "managed-directory-member";
    const codexDir = resolve("/tmp/managed-member-codex");
    const claudeDir = resolve("/tmp/managed-member-claude");
    const seen: Array<Record<string, string | undefined>> = [];
    const client = (env: Record<string, string | undefined>) => {
      seen.push(env);
      return disconnectedAccountClient();
    };
    const manager = new ProviderAccountManager(
      () => {},
      client as never,
      undefined,
      (userId) => userId,
      () => ({}),
      client as never,
      () => ({}),
      () => ({}),
      undefined,
      () => [{ id }],
    );
    try {
      writeManagedUserEnv(id, {
        CODEX_HOME: codexDir,
        CLAUDE_CONFIG_DIR: claudeDir,
      });
      const accounts = await manager.list(id);
      for (const provider of ["codex", "claude"] as const) {
        expect(
          accounts.find(
            (account) =>
              account.provider === provider && account.scope === "personal",
          ),
        ).toMatchObject({
          explicitDirectory: true,
          accountStatus: "not_connected",
        });
      }
      expect(seen.some((env) => env.CODEX_HOME === codexDir)).toBe(true);
      expect(seen.some((env) => env.CLAUDE_CONFIG_DIR === claudeDir)).toBe(
        true,
      );
    } finally {
      removeManagedUserEnv(id);
    }
  });

  it("rejects another member's managed account directory for both providers", async () => {
    const id = "managed-collision-member-a";
    const otherId = "managed-collision-member-b";
    const manager = new ProviderAccountManager(
      () => {},
      disconnectedAccountClient as never,
      undefined,
      (userId) => userId,
      () => ({}),
      disconnectedAccountClient as never,
      () => ({}),
      () => ({}),
      undefined,
      () => [{ id }, { id: otherId }],
    );
    const values = {
      CODEX_HOME: "/tmp/managed-collision-codex",
      CLAUDE_CONFIG_DIR: "/tmp/managed-collision-claude",
    };
    try {
      writeManagedUserEnv(id, values);
      writeManagedUserEnv(otherId, values);
      const personal = async (provider: "codex" | "claude") =>
        (await manager.list(id, true)).find(
          (entry) => entry.provider === provider && entry.scope === "personal",
        );
      for (const provider of ["codex", "claude"] as const)
        expect(await personal(provider)).toMatchObject({
          accountStatus: "unavailable",
          canBrowserLogin: false,
          error: expect.any(String),
        });
      // Positive control: the same directories are fine once the other
      // member no longer claims them.
      removeManagedUserEnv(otherId);
      for (const provider of ["codex", "claude"] as const)
        expect(await personal(provider)).toMatchObject({
          accountStatus: "not_connected",
          canBrowserLogin: true,
        });
    } finally {
      removeManagedUserEnv(id);
      removeManagedUserEnv(otherId);
    }
  });

  it("maps a rejected probe to unknown and keeps the other provider", async () => {
    // Only the active Codex home reaches the environment key, which throws.
    const manager = new ProviderAccountManager(
      () => {},
      disconnectedAccountClient as never,
      undefined,
      () => {
        throw new Error("environment key unreadable");
      },
      () => ({}),
      disconnectedAccountClient as never,
      () => ({}),
      () => ({}),
      () => ({}),
      () => [{ id: "member" }],
      (id, provider) => `/tmp/rejected-probe-${provider}-${id}`,
      undefined,
      (_id, provider) => provider === "codex",
    );
    expect(await manager.memberStatuses("member")).toEqual([
      { provider: "claude", status: "not_connected" },
      { provider: "codex", status: "unknown" },
    ]);
  });

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

    const office = async (manager: ProviderAccountManager) =>
      (await manager.list("user-a"))
        .filter((account) => account.scope === "office")
        .map((account) => [account.provider, account.externalCli]);
    expect(await office(external)).toEqual([
      ["codex", true],
      ["claude", true],
    ]);
    expect(await office(managed)).toEqual([
      ["codex", false],
      ["claude", false],
    ]);
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
    // Usage readings of the account in this directory go stale (task 967a09d1).
    const changed: Array<[string, string]> = [];
    manager.onAccountChanged = (provider, dir) => changed.push([provider, dir]);
    await manager.list("user-a");
    await manager.list("user-b");

    const result = await manager.disconnect("user-a", "codex", "office");
    expect(changed).toEqual([["codex", "/tmp/isomux-codex"]]);

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
    const changed: Array<[string, string]> = [];
    manager.onAccountChanged = (provider, dir) => changed.push([provider, dir]);

    const result = await manager.disconnect("user-a", "claude", "personal");
    expect(changed).toEqual([["claude", home]]);

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
    let cancels = 0;
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
      cancel: async () => {
        cancels++;
      },
      close: async () => {},
    });
    const manager = new ProviderAccountManager(
      () => {},
      fake as never,
      undefined,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
      () => ({}),
      () => ({}),
      () => ({}),
      () => [
        { id: "user-a", name: "Ana" },
        { id: "user-b", name: "Ben" },
      ],
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
      detail: {
        holderName: "Ana",
        startedAt: expect.any(Number),
      },
    });
    expect(
      (await manager.list("user-b")).find(
        (account) => account.provider === "codex" && account.scope === "office",
      )?.loginQueue,
    ).toEqual({ holderName: "Ana", startedAt: expect.any(Number) });
    expect(starts).toBe(1);
    expect(await manager.cancel("user-b", "codex", "office")).toBe(false);
    expect(await manager.cancel("user-b", "codex", "office", true)).toBe(true);
    expect(cancels).toBe(1);
    for (const userId of ["user-a", "user-b"]) {
      const account = (await manager.list(userId)).find(
        (candidate) =>
          candidate.provider === "codex" && candidate.scope === "office",
      );
      expect(account?.loginQueue).toBeUndefined();
      expect(account?.loginStatus).toBe("idle");
    }
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

  // The completion's own success is not enough: a fresh client must read
  // the account. The login client itself always reads not connected.
  for (const [method, verified, expected] of [
    [
      "device",
      true,
      {
        loginStatus: "succeeded",
        accountStatus: "connected",
        accountLabel: "signed-in@example.com",
        error: undefined,
      },
    ],
    [
      "browser",
      false,
      {
        loginStatus: "failed",
        accountStatus: "not_connected",
        error: expect.any(String),
      },
    ],
  ] as const) {
    it(`verifies a Codex ${method} completion in a fresh client (${verified ? "connected" : "not connected"})`, async () => {
      let complete!: (value: {
        loginId: string | null;
        success: boolean;
        error: null;
      }) => void;
      let clients = 0;
      const emitted: unknown[] = [];
      const manager = new ProviderAccountManager(
        (_userId, accounts) =>
          emitted.push(
            accounts.find(
              (account) =>
                account.provider === "codex" && account.scope === "office",
            ),
          ),
        (() => {
          const client = ++clients;
          return {
            start: async () => {},
            login: async () => ({
              loginId: "login-1",
              authUrl: "https://auth.openai.com/",
              userCode: "ABCD",
            }),
            waitForCompletion: () =>
              new Promise((resolve) => {
                complete = resolve;
              }),
            read: async () =>
              client > 1 && verified
                ? { connected: true, label: "signed-in@example.com" }
                : { connected: false },
            cancel: async () => {},
            close: async () => {},
          };
        }) as never,
        undefined,
        undefined,
        () => ({}),
        disconnectedAccountClient as never,
      );

      await manager.startLogin("user-a", "codex", "office", method);
      complete({ loginId: null, success: true, error: null });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(emitted.at(-1)).toMatchObject(expected);
    });
  }

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
    // The start and the cancel publish; the late completion publishes nothing.
    expect(emitted).toEqual(["waiting_external", "idle"]);
  });

  it("closes and releases a shared credential directory after the login deadline", async () => {
    let starts = 0;
    let loginCloses = 0;
    const emitted: Array<[string, string | undefined]> = [];
    const fake = () => {
      let loggedIn = false;
      return {
        start: async () => {
          starts++;
        },
        login: async () => {
          loggedIn = true;
          return {
            loginId: `login-${starts}`,
            authUrl: "https://auth.openai.com/",
          };
        },
        waitForCompletion: () => new Promise(() => {}),
        read: async () => ({ connected: false }),
        cancel: async () => {},
        close: async () => {
          if (loggedIn) loginCloses++;
        },
      };
    };
    const manager = new ProviderAccountManager(
      (userId, accounts) =>
        emitted.push([
          userId,
          accounts.find(
            (account) =>
              account.provider === "codex" && account.scope === "office",
          )?.loginStatus,
        ]),
      fake as never,
      5,
      undefined,
      () => ({}),
      disconnectedAccountClient as never,
      () => ({}),
      () => ({}),
      () => ({}),
      () => [{ id: "user-a" }, { id: "user-b" }],
    );
    expect(
      (await manager.startLogin("user-a", "codex", "office", "browser")).ok,
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(loginCloses).toBe(1);
    expect(emitted.at(-1)).toEqual(["user-a", "interrupted"]);
    const second = await manager.startLogin(
      "user-b",
      "codex",
      "office",
      "browser",
    );
    expect(second.ok).toBe(true);
    expect(starts).toBe(2);
    await manager.cancel("user-b", "codex", "office");
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

  for (const value of [undefined, "   "] as const) {
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

  it("publishes a clean successful Claude sign-in after a rejected duplicate callback", async () => {
    let complete!: () => void;
    let clients = 0;
    let submissions = 0;
    const emitted: Array<
      Array<{ provider: string; loginStatus: string; scope: string }>
    > = [];
    const createClaude = () => {
      clients++;
      if (clients === 1)
        return {
          start: async () => {},
          login: async () => ({ authUrl: "https://claude.com/oauth/" }),
          submitCode: async () => {
            if (++submissions > 1)
              throw new Error("Claude rejected this sign-in code.");
          },
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
    expect(submittedAgain).toMatchObject({
      ok: false,
      message: "Claude rejected this sign-in code.",
    });
    complete();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const claude = emitted
      .at(-1)
      ?.find(
        (account) =>
          account.provider === "claude" && account.scope === "personal",
      );
    expect(claude).toMatchObject({
      accountStatus: "connected",
      loginStatus: "succeeded",
      error: undefined,
    });
  });

  // The Claude CLI answers claude_oauth_wait_for_completion and
  // claude_oauth_callback from one OAuth flow, in the order they were sent,
  // one reply per line. finish() sent the wait at login start, so its reply
  // lands first and finish() closes the client while the callback reply is
  // still in flight; the SDK then rejects the callback ("Query closed before
  // response received"). Nil saw that as a rejected code after a good
  // sign-in (task 5b0f2234).
  for (const accepted of [true, false]) {
    it(`answers a Claude code ${accepted ? "accepted" : "refused"} by the flow ${accepted ? "as submitted when the client closes before its reply" : "as a failure"}`, async () => {
      let settleFlow!: () => void;
      const flow = new Promise<void>((resolveFlow, rejectFlow) => {
        settleFlow = () =>
          accepted
            ? resolveFlow()
            : rejectFlow(new Error("Request failed with status code 400"));
      });
      flow.catch(() => {});
      const pending = new Map<(error: Error) => void, string>();
      const sent: string[] = [];
      const cutByClose: string[] = [];
      const reply = (name: string) => {
        const slot = sent.push(name) - 1;
        return new Promise<unknown>((resolveReply, rejectReply) => {
          const fail = (error: Error) => {
            if (!pending.delete(fail)) return;
            rejectReply(error);
          };
          pending.set(fail, name);
          // Reply n goes out n lines after the first.
          const after = () =>
            slot === 0
              ? Promise.resolve()
              : new Promise((resolveTick) => setTimeout(resolveTick, 0));
          flow.then(
            () =>
              after().then(() => {
                if (pending.delete(fail)) resolveReply({ account: {} });
              }),
            (error: Error) => after().then(() => fail(error)),
          );
        });
      };
      const cli = {
        claudeAuthenticate: async () => ({
          manualUrl: "https://claude.com/oauth/?state=state",
        }),
        claudeOAuthWaitForCompletion: () => reply("wait"),
        claudeOAuthCallback: (_code: string, _state: string) => {
          const answer = reply("callback");
          settleFlow();
          return answer;
        },
        accountInfo: async () => ({ tokenSource: "none" }),
        close: () => {
          for (const [fail, name] of [...pending]) {
            cutByClose.push(name);
            fail(new Error("Query closed before response received"));
          }
        },
      };
      const emitted: Array<
        Array<{ provider: string; loginStatus: string; scope: string }>
      > = [];
      let clients = 0;
      const createClaude = (env: Record<string, string | undefined>) => {
        clients++;
        if (clients === 1) return new ClaudeAccountClient(env, () => cli);
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
        disconnectedAccountClient as never,
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
      const loginStatus = () =>
        emitted
          .at(-1)
          ?.find(
            (account) =>
              account.provider === "claude" && account.scope === "personal",
          )?.loginStatus;
      for (
        let tick = 0;
        tick < 50 && loginStatus() === "waiting_external";
        tick++
      )
        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      expect(sent).toEqual(["wait", "callback"]);
      if (accepted) {
        // The race this guards: the close cut the callback reply off.
        expect(cutByClose).toEqual(["callback"]);
        expect(submitted).toEqual({ ok: true, value: { submitted: true } });
        expect(loginStatus()).toBe("succeeded");
      } else {
        expect(submitted).toMatchObject({ ok: false, status: 502 });
        expect(loginStatus()).toBe("interrupted");
      }
    });
  }

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
    const changed: Array<[string, string]> = [];
    manager.onAccountChanged = (provider, dir) => changed.push([provider, dir]);
    await manager.startLogin("user-a", "claude", "personal", "browser");
    expect(activated).toEqual([]);
    // Starting a sign-in changes no account; completing it does.
    expect(changed).toEqual([]);
    complete();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(activated).toEqual([["user-a", "claude"]]);
    expect(changed).toEqual([["claude", "/tmp/provider-homes/user-a/claude"]]);
  });

  it("starts office Claude browser login in the effective office directory", async () => {
    const loginDirs: Array<string | undefined> = [];
    const manager = new ProviderAccountManager(
      () => {},
      disconnectedAccountClient as never,
      undefined,
      undefined,
      () => ({}),
      ((env?: Record<string, string | undefined>) => ({
        start: async () => {},
        login: async () => {
          loginDirs.push(env?.CLAUDE_CONFIG_DIR);
          return { authUrl: "https://claude.com/oauth/" };
        },
        waitForCompletion: () => new Promise(() => {}),
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      () => ({ CLAUDE_CONFIG_DIR: "/tmp/office-claude" }),
    );
    try {
      expect(
        (await manager.startLogin("user-a", "claude", "office", "browser")).ok,
      ).toBe(true);
      expect(loginDirs).toEqual(["/tmp/office-claude"]);
    } finally {
      await manager.cancel("user-a", "claude", "office");
    }
  });

  // A personal directory that collides with the office's, another member's or
  // the box's CLI directory, or that is not absolute, is refused before any
  // client is built. Each row collides with one source only; the explicit
  // directory test below is the positive control on the same fixture.
  const refusals: Array<
    [
      provider: "claude" | "codex",
      name: string,
      value: string,
      officeFile: Record<string, string>,
      processValue: string | undefined,
    ]
  > = [
    [
      "claude",
      "the box's CLI directory",
      resolve(homedir(), ".claude"),
      {},
      undefined,
    ],
    [
      "claude",
      "the resolved office directory",
      "/tmp/office-claude",
      {},
      undefined,
    ],
    [
      "claude",
      "the office env file",
      "/tmp/office-file-claude",
      { CLAUDE_CONFIG_DIR: "/tmp/office-file-claude" },
      undefined,
    ],
    [
      "claude",
      "the process environment",
      "/tmp/process-claude",
      {},
      "/tmp/process-claude",
    ],
    [
      "claude",
      "another member's variable",
      "/tmp/other-user-claude",
      {},
      undefined,
    ],
    [
      "claude",
      "another member's provisioned home",
      "/tmp/provider-homes/user-b/claude",
      {},
      undefined,
    ],
    ["claude", "a non-absolute path", "~/.claude", {}, undefined],
    [
      "codex",
      "the box's CLI directory",
      resolve(homedir(), ".codex"),
      {},
      undefined,
    ],
    ["codex", "the isomux office directory", ISOMUX_CODEX_HOME, {}, undefined],
    [
      "codex",
      "the resolved office directory",
      "/tmp/office-codex",
      {},
      undefined,
    ],
    [
      "codex",
      "the office env file",
      "/tmp/office-file-codex",
      { CODEX_HOME: "/tmp/office-file-codex" },
      undefined,
    ],
    [
      "codex",
      "the process environment",
      "/tmp/process-codex",
      {},
      "/tmp/process-codex",
    ],
    [
      "codex",
      "another member's variable",
      "/tmp/other-user-codex",
      {},
      undefined,
    ],
    [
      "codex",
      "another member's provisioned home",
      "/tmp/provider-homes/user-b/codex",
      {},
      undefined,
    ],
    ["codex", "a non-absolute path", "~/.codex", {}, undefined],
  ];
  // Refusal tests must never fall back to the real account clients: if the
  // refusal regresses, a real client spawns the provider CLI on the refused
  // directory (for Codex, the box's ~/.codex), merges isomux's safety hook into
  // it and starts a real login there.
  const personalLoginManager = (
    provider: "claude" | "codex",
    value: string,
    officeFile: Record<string, string> = {},
  ) => {
    const variable = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    const loginDirs: Array<string | undefined> = [];
    const client = (env?: Record<string, string | undefined>) => ({
      start: async () => {},
      login: async () => {
        loginDirs.push(env?.[variable]);
        return { authUrl: "https://example.com/oauth/", loginId: "login" };
      },
      waitForCompletion: () => new Promise(() => {}),
      read: async () => ({ connected: false }),
      cancel: async () => {},
      close: async () => {},
    });
    let built = 0;
    const factory = ((env?: Record<string, string | undefined>) => {
      built++;
      return client(env);
    }) as never;
    const manager = new ProviderAccountManager(
      () => {},
      factory,
      undefined,
      undefined,
      () => ({}),
      factory,
      () => ({
        CLAUDE_CONFIG_DIR: "/tmp/office-claude",
        CODEX_HOME: "/tmp/office-codex",
      }),
      () => officeFile,
      (userId): Record<string, string> =>
        userId === "user-a"
          ? { [variable]: value }
          : {
              CLAUDE_CONFIG_DIR: "/tmp/other-user-claude",
              CODEX_HOME: "/tmp/other-user-codex",
            },
      () => [{ id: "user-a" }, { id: "user-b" }],
      (userId, selected) => `/tmp/provider-homes/${userId}/${selected}`,
      undefined,
      () => true,
    );
    return { manager, built: () => built, loginDirs };
  };

  for (const [provider, name, value, officeFile, processValue] of refusals) {
    it(`refuses ${provider} personal login on ${name}`, async () => {
      const variable =
        provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const previous = process.env[variable];
      if (processValue) process.env[variable] = processValue;
      else delete process.env[variable];
      try {
        const { manager, built } = personalLoginManager(
          provider,
          value,
          officeFile,
        );
        expect(
          await manager.startLogin("user-a", provider, "personal", "browser"),
        ).toMatchObject({
          ok: false,
          status: 422,
          code: "browser_login_unavailable",
        });
        expect(built()).toBe(0);
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
    });
  }

  // The positive control, and an explicit directory wins over an activated
  // managed home.
  for (const provider of ["claude", "codex"] as const) {
    it(`starts ${provider} personal login in a unique explicit directory`, async () => {
      const explicit = `/tmp/explicit-${provider}`;
      const { manager, loginDirs } = personalLoginManager(provider, explicit);
      try {
        expect(
          (await manager.startLogin("user-a", provider, "personal", "browser"))
            .ok,
        ).toBe(true);
        expect(loginDirs).toEqual([explicit]);
      } finally {
        await manager.cancel("user-a", provider, "personal");
      }
    });
  }

  // The Codex card names where the viewer's agents get OPENAI_API_KEY when
  // they use it (task a704657a): only when their CODEX_HOME holds no stored
  // sign-in, which wins over the key (task 23c1992a). The source is the
  // viewer's, read on every read, on Codex wires only.
  describe("Codex API key source", () => {
    type Source = ReturnType<
      NonNullable<ConstructorParameters<typeof ProviderAccountManager>[16]>
    >;
    const homes: string[] = [];
    afterAll(() => {
      for (const dir of homes.splice(0))
        rmSync(dir, { recursive: true, force: true });
    });
    // The CODEX_HOME the viewer's agents use, with or without a stored sign-in.
    const agentCodexHome = (signedIn: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "api-key-source-agents-"));
      homes.push(dir);
      if (signedIn) writeFileSync(join(dir, "auth.json"), "{}");
      return dir;
    };
    const keyManager = (options: {
      source: (userId: string) => Source;
      codex?: () => unknown;
      agentEnv?: Record<string, string>;
    }) => {
      const agentEnv = options.agentEnv ?? {
        OPENAI_API_KEY: "sk-test",
        CODEX_HOME: agentCodexHome(false),
      };
      let probes = 0;
      const codex =
        options.codex ??
        (() => ({
          start: async () => {
            probes++;
          },
          read: async () => ({ connected: true, email: "office@example.com" }),
          close: async () => {},
        }));
      const manager = new ProviderAccountManager(
        () => {},
        codex as never,
        undefined,
        (id) => id,
        () => agentEnv,
        disconnectedAccountClient as never,
        () => ({}),
        () => ({}),
        () => ({}),
        () => [
          { id: "user-a", name: "Ana" },
          { id: "user-b", name: "Ben" },
        ],
        (id, provider) => `/tmp/api-key-source-personal-${provider}-${id}`,
        (id, provider) => `/tmp/api-key-source-personal-${provider}-${id}`,
        () => true,
        () => {},
        () => {},
        undefined,
        options.source,
      );
      return { manager, probes: () => probes };
    };
    const sources = (
      accounts: Array<{
        provider: string;
        scope: string;
        apiKeySource?: string;
      }>,
    ) =>
      Object.fromEntries(
        accounts.map((account) => [
          `${account.provider}:${account.scope}`,
          account.apiKeySource ?? null,
        ]),
      );

    it("follows the viewer's source on every read, warm cache included", async () => {
      let current: Source = "member_variable";
      const { manager, probes } = keyManager({
        source: () => current,
      });
      const first = await manager.list("user-a");
      expect(sources(first)).toEqual({
        "codex:office": "member_variable",
        "codex:personal": "member_variable",
        "claude:office": null,
        "claude:personal": null,
      });
      // The probe still reports the stored sign-in.
      expect(
        first.find((a) => a.provider === "codex" && a.scope === "office"),
      ).toMatchObject({ accountStatus: "connected" });
      const probed = probes();
      expect(probed).toBeGreaterThan(0);

      current = "office_secret";
      const second = await manager.list("user-a");
      expect(probes()).toBe(probed);
      expect(sources(second)["codex:office"]).toBe("office_secret");
      expect(sources(second)["codex:personal"]).toBe("office_secret");
      expect(sources((await manager.cachedList("user-a"))!)).toEqual({
        "codex:office": "office_secret",
        "codex:personal": "office_secret",
        "claude:office": null,
        "claude:personal": null,
      });

      current = null;
      const third = await manager.list("user-a");
      expect(probes()).toBe(probed);
      for (const account of [
        ...third,
        ...(await manager.cachedList("user-a"))!,
      ])
        expect("apiKeySource" in account).toBe(false);
    });

    it("leaves the field off when the source cannot be read", async () => {
      const { manager } = keyManager({
        source: () => {
          throw new Error("env file waits for import");
        },
      });
      const accounts = await manager.list("user-a");
      expect(accounts).toHaveLength(4);
      expect(
        accounts.find((a) => a.provider === "codex" && a.scope === "office"),
      ).toMatchObject({ accountStatus: "connected" });
      const cached = await manager.cachedList("user-a");
      expect(cached).toHaveLength(4);
      for (const account of [...accounts, ...cached!])
        expect("apiKeySource" in account).toBe(false);
    });

    it("carries each viewer's own source through a sign-in in progress", async () => {
      const { manager } = keyManager({
        source: (userId) =>
          userId === "user-a" ? "member_secret" : "office_variable",
        codex: () => ({
          start: async () => {},
          login: async () => ({
            loginId: "login-1",
            authUrl: "https://auth.openai.com/",
          }),
          waitForCompletion: () => new Promise(() => {}),
          read: async () => ({ connected: false }),
          cancel: async () => {},
          close: async () => {},
        }),
      });
      const started = await manager.startLogin(
        "user-a",
        "codex",
        "office",
        "browser",
      );
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value.account).toMatchObject({
        loginStatus: "waiting_external",
        apiKeySource: "member_secret",
      });
      const holder = (await manager.list("user-a")).find(
        (a) => a.provider === "codex" && a.scope === "office",
      );
      expect(holder).toMatchObject({
        loginStatus: "waiting_external",
        apiKeySource: "member_secret",
      });
      // Ben waits in Ana's queue and sees his own source, not hers.
      const queued = (await manager.list("user-b")).find(
        (a) => a.provider === "codex" && a.scope === "office",
      );
      expect(queued?.loginQueue?.holderName).toBe("Ana");
      expect(queued?.apiKeySource).toBe("office_variable");
      const cachedQueued = (await manager.cachedList("user-b"))?.find(
        (a) => a.provider === "codex" && a.scope === "office",
      );
      expect(cachedQueued?.loginQueue?.holderName).toBe("Ana");
      expect(cachedQueued?.apiKeySource).toBe("office_variable");
      expect(await manager.cancel("user-a", "codex", "office")).toBe(true);
    });

    it("leaves the field off while the agents' CODEX_HOME holds a stored sign-in", async () => {
      const home = agentCodexHome(true);
      const { manager } = keyManager({
        source: () => "member_variable",
        agentEnv: { OPENAI_API_KEY: "sk-test", CODEX_HOME: home },
        codex: () => ({
          start: async () => {},
          login: async () => ({
            loginId: "login-1",
            authUrl: "https://auth.openai.com/",
          }),
          waitForCompletion: () => new Promise(() => {}),
          read: async () => ({ connected: true, email: "member@example.com" }),
          cancel: async () => {},
          close: async () => {},
        }),
      });
      const listed = await manager.list("user-a");
      expect(listed.filter((a) => a.provider === "codex")).toHaveLength(2);
      for (const account of [
        ...listed,
        ...(await manager.cachedList("user-a"))!,
      ])
        expect("apiKeySource" in account).toBe(false);
      // A sign-in started (and joined) on the card: the stored one still wins.
      for (let i = 0; i < 2; i++) {
        const started = await manager.startLogin(
          "user-a",
          "codex",
          "office",
          "browser",
        );
        expect(started.ok).toBe(true);
        if (started.ok)
          expect("apiKeySource" in started.value.account).toBe(false);
      }
      expect(await manager.cancel("user-a", "codex", "office")).toBe(true);
      // Signed out: the key is what the agents use, read now, not cached.
      rmSync(join(home, "auth.json"));
      expect(sources(await manager.list("user-a"))).toMatchObject({
        "codex:office": "member_variable",
        "codex:personal": "member_variable",
      });
      expect(sources((await manager.cachedList("user-a"))!)).toMatchObject({
        "codex:office": "member_variable",
        "codex:personal": "member_variable",
      });
    });
  });
});
