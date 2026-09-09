import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OfficeState } from "../../shared/office-state.ts";
import type {
  AgentBackendType,
  ProviderAccountWire,
  RoomWire,
} from "../../shared/types.ts";
import { createAgentManager, type ManagerDeps } from "../agent-manager.ts";
import {
  ProviderAccountManager,
  type EffectiveProviderAccountTarget,
} from "../provider-account-manager.ts";
import { STATE_ROOT } from "../config.ts";
import { FakeBackend } from "./fake-backend.ts";
import { loadAgents } from "../persistence.ts";
import { claudeBackend } from "../backends/claude.ts";
import { codexBackend } from "../backends/codex/adapter.ts";
import { isClaudeCodeAuthenticated } from "../backends/claude-install-check.ts";
import { isCodexAuthenticated } from "../backends/codex/native-bin.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";

afterEach(() => clearTestManagedOfficeEnv());

function room(id: string): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: false };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

async function harness(opts: {
  backendType: AgentBackendType;
  fake: FakeBackend;
  userId?: string | null;
  accounts?: ManagerDeps["listProviderAccounts"];
  timeoutMs?: number;
  target?: () => EffectiveProviderAccountTarget;
}) {
  const roomId = `auth-${crypto.randomUUID()}`;
  const mgr = createAgentManager({
    resolveBackend: () => opts.fake,
    officeState: new OfficeState({ rooms: [room(roomId)] }),
    initialRooms: [],
    listProviderAccounts: opts.accounts,
    claudeAuthCheckTimeoutMs: opts.timeoutMs,
    effectiveProviderAccountTarget: opts.target
      ? () => opts.target!()
      : undefined,
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    `Auth ${roomId}`,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    "fake",
    "high",
    "tester",
    opts.backendType,
    undefined,
    opts.userId === undefined ? "user-a" : opts.userId,
  );
  return { mgr, agentId: info!.id };
}

function claudeWire(
  scope: "office" | "personal",
  overrides: Partial<ProviderAccountWire> = {},
): ProviderAccountWire {
  return {
    provider: "claude",
    scope,
    accountStatus: "not_connected",
    loginStatus: "idle",
    canBrowserLogin: true,
    ...overrides,
  };
}

describe("provider auth affordances", () => {
  it("resolves the active Claude account scope from normalized paths", () => {
    const makeManager = (opts: {
      effective?: string;
      office?: string;
      explicit?: string;
      active?: boolean;
    }) =>
      new ProviderAccountManager(
        () => {},
        undefined,
        undefined,
        undefined,
        () =>
          opts.effective ? { CLAUDE_CONFIG_DIR: opts.effective } : undefined,
        undefined,
        () => (opts.office ? { CLAUDE_CONFIG_DIR: opts.office } : {}),
        (): Record<string, string> =>
          opts.office ? { CLAUDE_CONFIG_DIR: opts.office } : {},
        (): Record<string, string> =>
          opts.explicit ? { CLAUDE_CONFIG_DIR: opts.explicit } : {},
        () => [{ id: "user-a" }],
        () => "/accounts/auto-personal",
        () => "/accounts/auto-personal",
        () => opts.active === true,
      );

    expect(makeManager({}).effectiveTarget("user-a", "claude").scope).toBe(
      "office",
    );
    expect(
      makeManager({
        effective: "./relative-office/",
        office: "./relative-office",
      }).effectiveTarget("user-a", "claude").scope,
    ).toBe("office");
    expect(
      makeManager({
        effective: "/accounts/auto-personal/",
        active: true,
      }).effectiveTarget("user-a", "claude").scope,
    ).toBe("personal");
    expect(
      makeManager({
        effective: "/accounts/explicit/",
        explicit: "/accounts/explicit",
      }).effectiveTarget("user-a", "claude").scope,
    ).toBe("personal");
    expect(() =>
      makeManager({
        effective: "/accounts/unknown",
        explicit: "/accounts/explicit",
      }).effectiveTarget("user-a", "claude"),
    ).toThrow("Cannot map the active claude directory to a scope.");
  });

  it("coalesces Claude system_text and a failed 401 completion", async () => {
    setTestManagedOfficeEnv({
      CLAUDE_CONFIG_DIR: join(STATE_ROOT, "signed-out-claude"),
      ANTHROPIC_API_KEY: "",
    });
    let successfulTopicResult: string | null = null;
    const fake = new FakeBackend({
      isAuthError: (text) => claudeBackend.detectAuthError(text),
      oneShot: () => {
        successfulTopicResult = "Not logged in · Please run /login";
        return successfulTopicResult;
      },
      loginInstructions: {
        kind: "login",
        text: "terminal fallback",
        commands: ["claude"],
      },
      session: {
        onSend: (_text, _attachments, session) => {
          session.push({
            kind: "system_text",
            text: "Not logged in · Please run /login",
          });
          session.push({
            kind: "turn_completed",
            status: "failed",
            error: "401 Unauthorized",
          });
        },
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      accounts: async () => [claudeWire("office")],
      target: () => ({
        provider: "claude",
        scope: "office",
        dir: "/accounts/office-claude",
      }),
    });
    expect(isClaudeCodeAuthenticated(mgr.buildEnvForUserId("user-a"))).toBe(
      false,
    );
    mgr.enqueueMessage(agentId, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    await waitFor(() =>
      mgr
        .getAgentLogs(agentId)
        .some((entry) => entry.metadata?.providerLogin === "claude"),
    );
    await waitFor(() => fake.oneShotCount === 1);
    const logs = mgr.getAgentLogs(agentId);
    expect(fake.oneShotCount).toBe(1);
    expect<string | null>(successfulTopicResult).toBe(
      "Not logged in · Please run /login",
    );
    expect(logs.some((entry) => entry.kind === "user_message")).toBe(true);
    expect(
      logs.filter((entry) => entry.metadata?.providerLogin === "claude"),
    ).toHaveLength(1);
    expect(
      logs.some(
        (entry) => entry.content === "Not logged in · Please run /login",
      ),
    ).toBe(false);
    expect(mgr.getAgent(agentId)?.topic).toBeNull();
    expect(
      loadAgents()
        .flatMap((entry) => entry.agents)
        .find((agent) => agent.id === agentId)?.topic,
    ).toBeNull();
  });

  it("keeps an auth-flavored topic when Claude is signed in", async () => {
    const claudeDir = join(STATE_ROOT, "signed-in-claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".credentials.json"), "{}");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeDir });
    const label = "OAuth authentication flow design";
    const fake = new FakeBackend({
      isAuthError: (text) => claudeBackend.detectAuthError(text),
      oneShot: label,
      session: {
        onSend: (_text, _attachments, session) =>
          session.completeTurn({ text: "ok" }),
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
    });
    expect(isClaudeCodeAuthenticated(mgr.buildEnvForUserId("user-a"))).toBe(
      true,
    );

    await mgr.sendMessage(agentId, "Help me design an OAuth flow", "tester");
    await waitFor(() => fake.oneShotCount === 1);

    expect(claudeBackend.detectAuthError(label)).toBe(true);
    expect(fake.oneShotCount).toBe(1);
    expect(mgr.getAgent(agentId)?.topic).toBe(label);
  });

  it("keeps an auth-flavored topic when Codex is signed in", async () => {
    const codexHome = join(STATE_ROOT, "signed-in-codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), "{}");
    setTestManagedOfficeEnv({ CODEX_HOME: codexHome });
    const label = "Debugging 401 errors in the API";
    const fake = new FakeBackend({
      isAuthError: (text) => codexBackend.detectAuthError(text),
      oneShot: label,
      session: {
        onSend: (_text, _attachments, session) =>
          session.completeTurn({ text: "ok" }),
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "codex",
      fake,
    });
    expect(isCodexAuthenticated(mgr.buildEnvForUserId("user-a"))).toBe(true);

    await mgr.sendMessage(agentId, "Help me debug a 401 API error", "tester");
    await waitFor(() => fake.oneShotCount === 1);

    expect(codexBackend.detectAuthError(label)).toBe(true);
    expect(fake.oneShotCount).toBe(1);
    expect(mgr.getAgent(agentId)?.topic).toBe(label);
  });

  it("coalesces Claude system_text and an auth-looking stream exit", async () => {
    const fake = new FakeBackend({
      isAuthError: (text) => /not logged in|401/i.test(text),
      loginInstructions: {
        kind: "login",
        text: "terminal fallback",
        commands: ["claude"],
      },
      session: {
        onSend: (_text, _attachments, session) => {
          session.push({
            kind: "system_text",
            text: "Not logged in · Please run /login",
          });
          session.failStream(new Error("401 subprocess exit"));
        },
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      accounts: async () => [claudeWire("office")],
      target: () => ({
        provider: "claude",
        scope: "office",
        dir: "/accounts/office-claude",
      }),
    });
    mgr.enqueueMessage(agentId, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    await waitFor(() =>
      mgr
        .getAgentLogs(agentId)
        .some((entry) => entry.metadata?.providerLogin === "claude"),
    );
    await Bun.sleep(20);
    expect(
      mgr
        .getAgentLogs(agentId)
        .filter((entry) => entry.metadata?.providerLogin === "claude"),
    ).toHaveLength(1);
  });

  it("uses only the failing Claude scope for the sign-in card", async () => {
    const fake = new FakeBackend({
      isAuthError: (text) => text.includes("Not logged in"),
      loginInstructions: {
        kind: "login",
        text: "terminal fallback",
        commands: ["claude"],
      },
      session: {
        onSend: (_text, _attachments, session) =>
          session.push({ kind: "system_text", text: "Not logged in" }),
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      accounts: async () => [claudeWire("personal")],
      target: () => ({
        provider: "claude",
        scope: "office",
        dir: "/accounts/office-claude",
      }),
    });
    mgr.enqueueMessage(agentId, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    await waitFor(() =>
      mgr
        .getAgentLogs(agentId)
        .some((entry) => entry.content.includes("could not finish")),
    );
    const logs = mgr.getAgentLogs(agentId);
    expect(logs.some((entry) => entry.content === "terminal fallback")).toBe(
      false,
    );
    expect(
      logs.some((entry) => entry.metadata?.providerLogin === "claude"),
    ).toBe(false);
  });

  it("uses the fresh account status instead of the standalone CLI installation hint", async () => {
    const fake = new FakeBackend({
      isAuthError: (text) => text.includes("Not logged in"),
      loginInstructions: {
        kind: "not_installed",
        cardEligible: false,
        text: "Install Claude first.",
        commands: ["curl -fsSL https://claude.ai/install.sh | bash"],
      },
      session: {
        onSend: (_text, _attachments, session) =>
          session.push({ kind: "system_text", text: "Not logged in" }),
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      accounts: async () => [claudeWire("personal")],
      target: () => ({
        provider: "claude",
        scope: "personal",
        dir: "/accounts/personal-claude",
      }),
    });
    mgr.enqueueMessage(agentId, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    await waitFor(() =>
      mgr
        .getAgentLogs(agentId)
        .some((entry) => entry.metadata?.providerLogin === "claude"),
    );
    const logs = mgr.getAgentLogs(agentId);
    expect(
      logs.some((entry) => entry.content === "Install Claude first."),
    ).toBe(false);
    expect(
      logs.some((entry) => entry.metadata?.providerLogin === "claude"),
    ).toBe(true);
  });

  it("routes /login through the Claude card", async () => {
    const fake = new FakeBackend({
      loginInstructions: {
        kind: "login",
        text: "terminal fallback",
        commands: ["claude"],
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      accounts: async () => [claudeWire("office")],
      target: () => ({
        provider: "claude",
        scope: "office",
        dir: "/accounts/office-claude",
      }),
    });
    await mgr.sendMessage(agentId, "/login", "tester");
    await waitFor(() =>
      mgr
        .getAgentLogs(agentId)
        .some((entry) => entry.metadata?.providerLogin === "claude"),
    );
    expect(
      mgr
        .getAgentLogs(agentId)
        .filter((entry) => entry.metadata?.providerLogin === "claude"),
    ).toHaveLength(1);
  });

  it("targets Claude and Codex logout fallbacks at the active directory", async () => {
    const cases = [
      {
        backendType: "claude" as const,
        provider: "claude" as const,
        dir: "/accounts/personal claude",
        command:
          "CLAUDE_CONFIG_DIR='/accounts/personal claude' claude auth logout",
      },
      {
        backendType: "codex" as const,
        provider: "codex" as const,
        dir: "/accounts/office codex",
        command:
          "CODEX_HOME='/accounts/office codex' ~/.isomux/bin/codex logout",
      },
    ];
    for (const testCase of cases) {
      const fake = new FakeBackend();
      const { mgr, agentId } = await harness({
        backendType: testCase.backendType,
        fake,
        accounts: async () => [
          {
            ...claudeWire("personal", { canBrowserLogin: false }),
            provider: testCase.provider,
          },
        ],
        target: () => ({
          provider: testCase.provider,
          scope: "personal",
          dir: testCase.dir,
        }),
      });
      await mgr.sendMessage(agentId, "/logout", "tester");
      await waitFor(() =>
        mgr
          .getAgentLogs(agentId)
          .some((entry) => entry.kind === "terminal-command"),
      );
      const card = mgr
        .getAgentLogs(agentId)
        .find((entry) => entry.kind === "terminal-command");
      expect(card?.terminal?.command).toBe(testCase.command);
      expect(
        mgr
          .getAgentLogs(agentId)
          .some((entry) => entry.content.includes(testCase.command)),
      ).toBe(true);
    }
  });

  it("opens the logout card and keeps OpenCode terminal-free", async () => {
    const claude = await harness({
      backendType: "claude",
      fake: new FakeBackend(),
      accounts: async () => [claudeWire("office")],
      target: () => ({
        provider: "claude",
        scope: "office",
        dir: "/accounts/office-claude",
      }),
    });
    await claude.mgr.sendMessage(claude.agentId, "/logout", "tester");
    await waitFor(() =>
      claude.mgr
        .getAgentLogs(claude.agentId)
        .some((entry) => entry.metadata?.providerLogin === "claude"),
    );
    expect(
      claude.mgr
        .getAgentLogs(claude.agentId)
        .find((entry) => entry.metadata?.providerLogin === "claude")?.content,
    ).toBe("Manage your Claude sign-in below.");

    const opencode = await harness({
      backendType: "opencode",
      fake: new FakeBackend(),
    });
    await opencode.mgr.sendMessage(opencode.agentId, "/logout", "tester");
    expect(
      opencode.mgr
        .getAgentLogs(opencode.agentId)
        .some(
          (entry) =>
            entry.content === "Sign-out is not available for OpenCode agents.",
        ),
    ).toBe(true);
    expect(
      opencode.mgr
        .getAgentLogs(opencode.agentId)
        .some((entry) => entry.kind === "terminal-command"),
    ).toBe(false);
  });
});

describe("Claude auth-error status checks", () => {
  function rejected(resumeOnly = false) {
    let initialTurn = resumeOnly;
    return new FakeBackend({
      isAuthError: (text) => claudeBackend.detectAuthError(text),
      loginInstructions: {
        kind: "already_authed",
        cardEligible: false,
        text: "Claude Code is signed in. Type `/clear` to refresh.",
      },
      session: {
        onSend: (_text, _attachments, session) => {
          if (initialTurn) {
            initialTurn = false;
            session.completeTurn({ text: "ok" });
            return;
          }
          session.push({
            kind: "system_text",
            text: "Not logged in · Please run /login",
          });
          session.push({
            kind: "system_text",
            text: "Not logged in · Please run /login",
          });
          session.push({
            kind: "turn_completed",
            status: "failed",
            error: "401 Unauthorized",
          });
        },
      },
    });
  }

  for (const scope of ["office", "personal"] as const) {
    it(`ignores credential-file presence and requests a fresh ${scope} Claude read once`, async () => {
      const dir = join(STATE_ROOT, `present-invalid-${scope}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".credentials.json"), "{}");
      setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: dir });
      let calls = 0;
      const { mgr, agentId } = await harness({
        backendType: "claude",
        fake: rejected(true),
        target: () => ({ provider: "claude", scope, dir }),
        accounts: async (_userId, options) => {
          calls++;
          expect(options).toMatchObject({
            provider: "claude",
            scope,
            refresh: true,
          });
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          return [claudeWire(scope)];
        },
      });
      expect(isClaudeCodeAuthenticated(mgr.buildEnvForUserId("user-a"))).toBe(
        true,
      );
      await mgr.sendMessage(agentId, "first turn", "tester");
      expect(await mgr.demoteToLazy(agentId)).toBe(true);
      await mgr.sendMessage(agentId, "resume", "tester");
      await waitFor(() =>
        mgr
          .getAgentLogs(agentId)
          .some(
            (e) =>
              e.metadata?.providerLogin === "claude" ||
              e.content.includes("Claude Code is signed in"),
          ),
      );
      const logs = mgr.getAgentLogs(agentId);
      expect(logs.some((e) => e.content.includes("released while idle"))).toBe(
        true,
      );
      expect(
        logs.some((e) => e.content.includes("Claude Code is signed in")),
      ).toBe(false);
      expect(calls).toBe(1);
      expect(
        logs.filter(
          (e) =>
            e.content ===
            "Claude rejected the credentials. Checking the connection…",
        ),
      ).toHaveLength(1);
      expect(
        logs.filter((e) => e.metadata?.providerLogin === "claude"),
      ).toHaveLength(1);
      expect(
        logs.some(
          (e) =>
            e.content.includes("Claude Code is signed in") ||
            e.content.includes("`/clear`"),
        ),
      ).toBe(false);
      expect(
        logs.find((e) => e.metadata?.providerLogin === "claude")?.content,
      ).toContain(scope === "office" ? "Office" : "Individual connections");
    });
  }

  it("replaces duplicate system_text auth signals with one checking/final pair", async () => {
    let finish!: (accounts: ProviderAccountWire[]) => void;
    const pending = new Promise<ProviderAccountWire[]>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const fake = new FakeBackend({
      isAuthError: (text) => claudeBackend.detectAuthError(text),
      session: {
        onSend: (_text, _attachments, session) => {
          session.push({
            kind: "system_text",
            text: "Not logged in · Please run /login",
          });
          session.push({
            kind: "system_text",
            text: "Not logged in · Please run /login",
          });
          session.push({ kind: "turn_completed", status: "completed" });
        },
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      accounts: () => {
        calls++;
        return pending;
      },
    });
    try {
      await mgr.sendMessage(agentId, "hello", "tester");
      const before = mgr.getAgentLogs(agentId);
      expect(
        before.filter((e) => e.content.includes("Checking the connection…")),
      ).toHaveLength(1);
      expect(
        before.some(
          (e) =>
            e.content.includes("Not logged in") || e.metadata?.providerLogin,
        ),
      ).toBe(false);
      expect(calls).toBe(1);
    } finally {
      finish([claudeWire("office")]);
    }
    await waitFor(() =>
      mgr
        .getAgentLogs(agentId)
        .some((e) => e.metadata?.providerLogin === "claude"),
    );
    const logs = mgr.getAgentLogs(agentId);
    const checking = logs.findIndex((e) =>
      e.content.includes("Checking the connection…"),
    );
    const guidance = logs.findIndex(
      (e) => e.metadata?.providerLogin === "claude",
    );
    expect(guidance).toBeGreaterThan(checking);
    expect(
      logs.filter((e) => e.metadata?.providerLogin === "claude"),
    ).toHaveLength(1);
    expect(logs.some((e) => e.content.includes("Not logged in"))).toBe(false);
  });

  it("preserves the rejection when the account reports connected", async () => {
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake: rejected(),
      accounts: async () => [
        claudeWire("office", { accountStatus: "connected" }),
      ],
    });
    await mgr.sendMessage(agentId, "hello", "tester");
    await waitFor(() =>
      mgr
        .getAgentLogs(agentId)
        .some((e) => e.content.includes("connection check reports a sign-in")),
    );
    const logs = mgr.getAgentLogs(agentId);
    expect(
      logs.some((e) =>
        e.content.includes("Claude rejected the credentials, but"),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (e) => e.content.includes("`/clear`") || e.metadata?.providerLogin,
      ),
    ).toBe(false);
  });

  for (const failure of [
    "throw",
    "unavailable",
    "hang",
    "missing",
    "scope",
    "owner",
  ] as const) {
    it(`finishes ${failure} with retry/sign-in guidance, not a disconnected claim`, async () => {
      let aborted = false;
      const { mgr, agentId } = await harness({
        backendType: "claude",
        fake: rejected(),
        timeoutMs: 20,
        userId: failure === "owner" ? null : undefined,
        target:
          failure === "scope"
            ? () => {
                throw new Error("unresolved scope");
              }
            : undefined,
        accounts:
          failure === "missing"
            ? undefined
            : async (_userId, options) => {
                if (failure === "throw") throw new Error("probe failed");
                if (failure === "unavailable")
                  return [
                    claudeWire("office", { accountStatus: "unavailable" }),
                  ];
                options!.signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                  },
                  { once: true },
                );
                return new Promise(() => {});
              },
      });
      await mgr.sendMessage(agentId, "hello", "tester");
      await waitFor(() =>
        mgr
          .getAgentLogs(agentId)
          .some(
            (e) =>
              e.content ===
              "The Claude connection check could not finish. Retry the request or sign in to Claude in Settings.",
          ),
      );
      const logs = mgr.getAgentLogs(agentId);
      expect(
        logs.filter((e) => e.content.includes("Checking the connection…")),
      ).toHaveLength(1);
      expect(
        logs.filter((e) => e.content.includes("could not finish")),
      ).toHaveLength(1);
      expect(
        logs.some(
          (e) =>
            e.content.includes("Claude Code is signed in") ||
            e.content.includes("`/clear`") ||
            e.metadata?.providerLogin,
        ),
      ).toBe(false);
      if (failure === "hang") expect(aborted).toBe(true);
    });
  }

  it("does not read accounts on a normal same-session idle wake", async () => {
    let calls = 0;
    const fake = new FakeBackend({
      session: {
        onSend: (_text, _attachments, session) =>
          session.completeTurn({ text: "ok" }),
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      accounts: async () => {
        calls++;
        return [claudeWire("office")];
      },
    });
    await mgr.sendMessage(agentId, "hello", "tester");
    expect(await mgr.demoteToLazy(agentId)).toBe(true);
    await mgr.sendMessage(agentId, "hello again", "tester");
    expect(
      mgr
        .getAgentLogs(agentId)
        .some((e) => e.content.includes("released while idle")),
    ).toBe(true);
    expect(calls).toBe(0);
  });
});
