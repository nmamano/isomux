import { describe, expect, it } from "bun:test";
import { ProviderAccountManager } from "./provider-account-manager.ts";

function fixture(
  createClaude: () => unknown,
  createCodex = () => ({
    start: async () => {},
    read: async () => ({ connected: true }),
    close: async () => {},
  }),
  users: { id: string }[] = [{ id: "owner" }],
) {
  return new ProviderAccountManager(
    () => {},
    createCodex as never,
    undefined,
    () => "auth-probe",
    () => ({ CLAUDE_CONFIG_DIR: "/tmp/auth-probe-office" }),
    createClaude as never,
    () => ({ CLAUDE_CONFIG_DIR: "/tmp/auth-probe-office" }),
    () => ({}),
    () => ({}),
    () => users,
    () => "/tmp/auth-probe-personal",
    undefined,
    () => false,
  );
}

function selection(controller = new AbortController()) {
  return {
    provider: "claude" as const,
    scope: "office" as const,
    refresh: true as const,
    signal: controller.signal,
  };
}

describe("fresh scoped Claude account checks", () => {
  it("replaces a connected cache entry without probing Codex or another scope", async () => {
    let connected = true;
    let claudeProbes = 0;
    let codexProbes = 0;
    const manager = fixture(
      () => ({
        start: async () => {
          claudeProbes++;
        },
        read: async () => ({ connected }),
        close: async () => {},
      }),
      () => ({
        start: async () => {
          codexProbes++;
        },
        read: async () => ({ connected: true }),
        close: async () => {},
      }),
    );
    await manager.list("owner");
    expect(claudeProbes).toBe(1);
    expect(codexProbes).toBe(1);
    connected = false;
    const fresh = await manager.list("owner", true, selection());
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      provider: "claude",
      scope: "office",
      accountStatus: "not_connected",
    });
    expect(claudeProbes).toBe(2);
    expect(codexProbes).toBe(1);
    const snapshot = manager.cachedList("owner");
    expect(snapshot).toHaveLength(4);
    expect(
      snapshot!.find((a) => a.provider === "codex" && a.scope === "office")
        ?.accountStatus,
    ).toBe("connected");
    expect(
      snapshot!.find((a) => a.provider === "claude" && a.scope === "office")
        ?.accountStatus,
    ).toBe("not_connected");
    expect(codexProbes).toBe(1);
  });

  it("starts no account read while a browser login waits on the directory", async () => {
    // task 84e98d49: two Claude processes on one config directory mid-OAuth
    // are not known to be safe, so a forced read defers to the login.
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reads = 0;
    const manager = fixture(
      () => {
        let loggingIn = false;
        return {
          start: async () => {},
          read: async () => {
            reads++;
            return { connected: true };
          },
          close: async () => {
            if (loggingIn) finish();
          },
          login: async () => {
            loggingIn = true;
            return { authUrl: "https://example.test/login" };
          },
          waitForCompletion: () => completion,
        };
      },
      undefined,
      [{ id: "owner" }, { id: "alice" }],
    );
    await manager.list("owner");
    expect(reads).toBe(1);
    expect(
      (await manager.startLogin("owner", "claude", "office", "browser")).ok,
    ).toBe(true);
    try {
      const officeClaude = (list: { provider: string; scope: string }[]) =>
        list.find((a) => a.provider === "claude" && a.scope === "office");
      const own = officeClaude(await manager.list("owner", true, selection()));
      expect(own).toMatchObject({ loginStatus: "waiting_external" });
      expect(own).not.toHaveProperty("loginQueue");
      const other = officeClaude(
        await manager.list("alice", true, selection()),
      );
      expect(other).toMatchObject({
        loginStatus: "waiting_external",
        loginQueue: { holderName: expect.any(String) },
      });
      expect(reads).toBe(1);
    } finally {
      await manager.cancel("owner", "claude", "office");
    }
  });

  it("keeps a late full-list result from undoing a completed forced refresh", async () => {
    let first = true;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = fixture(() => {
      const old = first;
      first = false;
      return {
        start: async () => {},
        read: async () => {
          if (old) await pending;
          return { connected: old };
        },
        close: async () => {},
      };
    });
    const oldFull = manager.list("owner");
    await Promise.resolve();
    await manager.list("owner", true, selection());
    release();
    expect(
      (await oldFull).find(
        (a) => a.provider === "claude" && a.scope === "office",
      )?.accountStatus,
    ).toBe("not_connected");
    expect(
      manager
        .cachedList("owner")!
        .find((a) => a.provider === "claude" && a.scope === "office")
        ?.accountStatus,
    ).toBe("not_connected");
  });

  it("does not fill a cold unrelated cache by starting Codex", async () => {
    let codexProbes = 0;
    const manager = fixture(
      () => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      }),
      () => {
        codexProbes++;
        throw new Error("Codex must not start");
      },
    );
    await manager.list("owner", true, selection());
    expect(manager.cachedList("owner")).toBeNull();
    expect(codexProbes).toBe(0);
  });

  for (const phase of ["start", "read"] as const) {
    it(`closes a pending ${phase} on cancellation and does not cache its late result`, async () => {
      let closeCount = 0;
      let readCount = 0;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = fixture(() => ({
        start: async () => {
          if (phase === "start") await pending;
        },
        read: async () => {
          readCount++;
          if (phase === "read") await pending;
          return { connected: true };
        },
        close: async () => {
          closeCount++;
        },
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
      return {
        start: async () => {
          started++;
        },
        read: async () => ({ connected: true }),
        close: async () => {
          closed++;
        },
      };
    });
    expect(
      (await manager.list("owner", true, selection(controller)))[0]
        .accountStatus,
    ).toBe("unavailable");
    expect(started).toBe(0);
    expect(closed).toBe(1);
  });

  it("maps a throwing probe to unavailable and closes it", async () => {
    let closed = 0;
    const manager = fixture(() => ({
      start: async () => {
        throw new Error("probe failed");
      },
      read: async () => ({ connected: true }),
      close: async () => {
        closed++;
      },
    }));
    expect(
      (await manager.list("owner", true, selection()))[0].accountStatus,
    ).toBe("unavailable");
    expect(closed).toBe(1);
  });
});

// The reverse order (task 84e98d49, scope round 2): a sign-in that starts while
// an account read is running on the same directory waits for that read, and
// the directory is reserved from the first moment, so nothing new starts on it.
describe("a sign-in that starts during an account read", () => {
  type Client = { started: boolean; loggedIn: boolean };
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await Promise.resolve();
    if (!cond()) throw new Error("condition never held");
  }
  async function ticks(n = 50): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }
  function heldReadFixture(options: { failLogin?: () => boolean } = {}) {
    const clients: Client[] = [];
    let releaseRead!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let completeLogin!: () => void;
    const completion = new Promise<void>((resolve) => {
      completeLogin = resolve;
    });
    const manager = fixture(
      () => {
        const me: Client = { started: false, loggedIn: false };
        const first = clients.push(me) === 1;
        return {
          start: async () => {
            me.started = true;
          },
          read: async () => {
            if (first) await held;
            return { connected: false };
          },
          close: async () => {
            if (me.loggedIn) completeLogin();
          },
          login: async () => {
            if (options.failLogin?.()) throw new Error("login refused");
            me.loggedIn = true;
            return { authUrl: "https://example.test/login" };
          },
          waitForCompletion: () => completion,
        };
      },
      undefined,
      [{ id: "owner" }, { id: "alice" }],
    );
    const loginClientsStarted = () =>
      clients.slice(1).filter((c) => c.started).length;
    return { manager, clients, releaseRead, loginClientsStarted };
  }
  const officeClaude = (list: { provider: string; scope: string }[]) =>
    list.find((a) => a.provider === "claude" && a.scope === "office");

  it("waits for the running read, and nothing new starts on the directory meanwhile", async () => {
    const { manager, clients, releaseRead, loginClientsStarted } =
      heldReadFixture();
    const read = manager.list("owner", true, selection());
    await until(() => clients.length === 1 && clients[0].started);
    const login = manager.startLogin("owner", "claude", "office", "browser");
    try {
      await ticks();
      expect(loginClientsStarted()).toBe(0);

      // The directory is reserved: a forced read starts nothing and reports
      // the sign-in, another user is told someone is signing in, and there is
      // no code to submit to yet.
      const clientsBefore = clients.length;
      expect(
        officeClaude(await manager.list("owner", true, selection())),
      ).toMatchObject({ loginStatus: "waiting_external" });
      expect(clients.length).toBe(clientsBefore);
      expect(
        await manager.startLogin("alice", "claude", "office", "browser"),
      ).toMatchObject({
        ok: false,
        status: 409,
        code: "shared_login_in_progress",
      });
      expect(
        await manager.submitCode("owner", "claude", "office", "code"),
      ).toMatchObject({ ok: false, status: 409, code: "no_login_in_progress" });
      expect(loginClientsStarted()).toBe(0);

      releaseRead();
      await read;
      const started = await login;
      expect(started.ok && started.value.authUrl).toBe(
        "https://example.test/login",
      );
      expect(loginClientsStarted()).toBe(1);
    } finally {
      releaseRead();
      await manager.cancel("owner", "claude", "office");
    }
  });

  it("gives two same-user starts one sign-in and the same outcome", async () => {
    let fail = false;
    const { manager, clients } = heldReadFixture({ failLogin: () => fail });
    const loggedIn = () => clients.filter((c) => c.loggedIn).length;
    try {
      const [a, b] = await Promise.all([
        manager.startLogin("owner", "claude", "office", "browser"),
        manager.startLogin("owner", "claude", "office", "browser"),
      ]);
      expect(a.ok && a.value.authUrl).toBe("https://example.test/login");
      expect(b.ok && b.value.authUrl).toBe("https://example.test/login");
      expect(loggedIn()).toBe(1);
    } finally {
      await manager.cancel("owner", "claude", "office");
    }

    fail = true;
    const startsBefore = clients.filter((c) => c.started).length;
    const [c, d] = await Promise.all([
      manager.startLogin("owner", "claude", "office", "browser"),
      manager.startLogin("owner", "claude", "office", "browser"),
    ]);
    for (const failed of [c, d])
      expect(failed).toMatchObject({ ok: false, code: "provider_error" });
    expect(clients.filter((x) => x.started).length - startsBefore).toBe(1);

    // The failed reservation is gone: the next start begins afresh.
    fail = false;
    const again = await manager.startLogin(
      "owner",
      "claude",
      "office",
      "browser",
    );
    try {
      expect(again.ok && again.value.authUrl).toBe(
        "https://example.test/login",
      );
    } finally {
      await manager.cancel("owner", "claude", "office");
    }
  });

  it("a cancel during the wait leaves no sign-in behind", async () => {
    const { manager, clients, releaseRead } = heldReadFixture();
    const read = manager.list("owner", true, selection());
    await until(() => clients.length === 1 && clients[0].started);
    const login = manager.startLogin("owner", "claude", "office", "browser");
    await ticks();
    expect(await manager.cancel("owner", "claude", "office")).toBe(true);
    releaseRead();
    await read;
    const result = await login;
    expect(result.ok && result.value.authUrl).toBeFalsy();
    // The start gives up before it launches a login client at all.
    expect(clients.slice(1).some((c) => c.started)).toBe(false);
    expect(clients.some((c) => c.loggedIn)).toBe(false);
    // Nothing holds the directory: a forced read probes it again.
    expect(
      officeClaude(await manager.list("owner", true, selection())),
    ).toMatchObject({ loginStatus: "idle" });
  });
});
