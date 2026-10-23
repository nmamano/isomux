import { claudeProjectDir } from "../cwd-utils.ts";
import { getSessionClaudeConfigDir } from "../persistence.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OfficeState } from "../../shared/office-state.ts";
import type {
  AgentBackendType,
  ProviderAccountWire,
  RoomWire,
} from "../../shared/types.ts";
import {
  createAgentManager,
  detectAuthErrorForEnvironment,
  type ManagerDeps,
} from "../agent-manager.ts";
import {
  ProviderAccountManager,
  type EffectiveProviderAccountTarget,
} from "../provider-account-manager.ts";
import {
  activatePersonalProvider,
  deactivatePersonalProvider,
  personalProviderHome,
} from "../provider-homes.ts";
import { STATE_ROOT } from "../config.ts";
import { english } from "../i18n.ts";
import { renderLogText } from "../../shared/i18n/log-message.ts";
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
import type { AgentEvent } from "../internal-types.ts";

afterEach(() => clearTestManagedOfficeEnv());

// Claude credentials that exist on disk, for the paths where Claude rejected
// them. Without any, the agent gets the plain sign-in notice instead.
function storeClaudeCredentials(): void {
  const dir = join(STATE_ROOT, `stored-claude-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), "{}");
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: dir });
}

function room(id: string): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: false };
}

async function waitFor(check: () => boolean): Promise<void> {
  // Two bounds live in this file. These legacy polls keep a generous 15 s
  // failure bound; nothing here has been measured near it, and a green poll
  // returns at once. Event-specific waits use a shorter local bound that can
  // fail with the event's name before Bun's 5 s per-test cap.
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

// Polls for at most 2 s, inside Bun's 5 s per-test cap, and asserts nothing:
// the caller's expects after it name what failed.
async function settle(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
}

// This fixture must not inherit a personal Claude sign-in from the test runner.
function withClaudeConfigDirUnset<T>(run: () => T): T {
  const inherited = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return run();
  } finally {
    if (inherited === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = inherited;
    }
  }
}

function logEntryWaiter() {
  type LogEntryEvent = Extract<AgentEvent, { type: "log_entry" }>;
  const waiters = new Set<{
    matches: (event: LogEntryEvent) => boolean;
    resolve: (event: LogEntryEvent) => void;
  }>();
  return {
    onEvent: (event: AgentEvent): void => {
      if (event.type !== "log_entry") return;
      for (const waiter of waiters) {
        if (!waiter.matches(event)) continue;
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    },
    waitFor(
      matches: (event: LogEntryEvent) => boolean,
      description: string,
    ): Promise<LogEntryEvent> {
      const promise = new Promise<LogEntryEvent>((resolve, reject) => {
        const waiter = {
          matches,
          resolve: (event: LogEntryEvent) => {
            clearTimeout(timer);
            resolve(event);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${description}.`));
        }, 2_000);
        waiters.add(waiter);
      });
      promise.catch(() => {});
      return promise;
    },
  };
}

async function harness(opts: {
  backendType: AgentBackendType;
  fake: FakeBackend;
  userId?: string | null;
  accounts?: ManagerDeps["listProviderAccounts"];
  timeoutMs?: number;
  target?: () => EffectiveProviderAccountTarget;
  eventSink?: ManagerDeps["eventSink"];
  findUser?: ManagerDeps["findUser"];
}) {
  const roomId = `auth-${crypto.randomUUID()}`;
  const mgr = createAgentManager({
    resolveBackend: () => opts.fake,
    officeState: new OfficeState({ rooms: [room(roomId)] }),
    initialRooms: [],
    listProviderAccounts: opts.accounts,
    claudeAuthCheckTimeoutMs: opts.timeoutMs,
    eventSink: opts.eventSink,
    effectiveProviderAccountTarget: opts.target
      ? () => opts.target!()
      : undefined,
    // By default "tester" types and is "user-a", the agent's member manager.
    findUser:
      opts.findUser ??
      ((person) =>
        (
          "username" in person
            ? person.username === "tester"
            : person.userId === "user-a"
        )
          ? { id: "user-a", role: "member" }
          : undefined),
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

describe("Claude auth classification by provider", () => {
  const classify = (text: string, env: Record<string, string | undefined>) =>
    detectAuthErrorForEnvironment("claude", text, env, (value) =>
      claudeBackend.detectAuthError(value),
    );

  it("does not classify first-party-shaped text under a cloud selector", () => {
    // The control: without a cloud selector, first-party sign-in text is
    // classified. (A 403 is a provider refusal everywhere since task
    // 2bd836d5.)
    expect(classify("Not logged in · Please run /login", {})).toBe(true);
    expect(
      classify("Not logged in · Please run /login", {
        CLAUDE_CODE_USE_VERTEX: "true",
      }),
    ).toBe(false);
  });
});

describe("provider auth affordances", () => {
  // No credentials file, but a cloud selector signs Claude in: not known
  // signed out, so the topic runs, with the managed env on every launch.
  {
    const selector = "CLAUDE_CODE_USE_BEDROCK";
    it(`keeps an auth topic and passes ${selector} to the topic launch`, async () => {
      const env = {
        CLAUDE_CONFIG_DIR: join(STATE_ROOT, `signed-out-${selector}`),
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_USE_VERTEX: "",
        [selector]: "1",
        AWS_REGION: "us-east-1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-4-6",
      };
      setTestManagedOfficeEnv(env);
      const label = "OAuth authentication flow design";
      let topicEnv: unknown;
      const fake = new FakeBackend({
        isAuthError: (text) => claudeBackend.detectAuthError(text),
        oneShot: (_prompt, opts) => {
          topicEnv = opts.env;
          return label;
        },
        session: {
          onSend: (_text, _attachments, session) =>
            session.completeTurn({ text: "ok" }),
        },
      });
      const { mgr, agentId } = await harness({ backendType: "claude", fake });
      await mgr.sendMessage(agentId, "Help me design an OAuth flow", "tester");
      await waitFor(() => fake.oneShotCount === 1);
      expect(topicEnv).toMatchObject(env);
      expect(mgr.getAgent(agentId)?.topic).toBe(label);
      expect(fake.lastSession?.opts.env).toMatchObject(env);
      expect(await mgr.demoteToLazy(agentId)).toBe(true);
      await mgr.sendMessage(agentId, "Continue", "tester");
      expect(fake.lastSession?.opts.env).toMatchObject(env);
    });
  }

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

    withClaudeConfigDirUnset(() => {
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
  });

  it("gives a signed-out Claude one notice with the sign-in card, and no topic", async () => {
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
          session.push({ kind: "auth_needed" });
          session.push({ kind: "auth_needed" });
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
    const logs = mgr.getAgentLogs(agentId);
    // No credentials at all: one notice, and it carries the sign-in card.
    const sent = logs.findIndex((entry) => entry.kind === "user_message");
    expect(sent).toBeGreaterThan(-1);
    const notices = logs.slice(sent).filter((entry) => entry.kind === "system");
    expect(notices).toHaveLength(1);
    expect(notices[0].metadata?.providerLogin).toBe("claude");
    // Topic generation skips a signed-out engine instead of calling it.
    expect(fake.oneShotCount).toBe(0);
    expect<string | null>(successfulTopicResult).toBeNull();
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

  // A rejected credential that is not a file still gets the connection
  // check, not the "no credentials" notice.
  {
    const token = "CLAUDE_CODE_OAUTH_TOKEN";
    it(`keeps the rejected-credential check for a rejected ${token}`, async () => {
      const dir = join(STATE_ROOT, `token-claude-${crypto.randomUUID()}`);
      mkdirSync(dir, { recursive: true });
      setTestManagedOfficeEnv({
        CLAUDE_CONFIG_DIR: dir,
        ANTHROPIC_API_KEY: "",
        [token]: "rejected-token",
      });
      const fake = new FakeBackend({
        isAuthError: (text) => claudeBackend.detectAuthError(text),
        // The plain sign-in path's card, so a wrong route still ends in a
        // providerLogin entry and reaches the assertion below.
        loginInstructions: {
          kind: "login",
          text: "terminal fallback",
          commands: ["claude"],
        },
        session: {
          onSend: (_text, _attachments, session) => {
            session.push({ kind: "auth_needed" });
            session.completeTurn({
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
      expect(mgr.buildEnvForUserId("user-a")?.[token]).toBe("rejected-token");
      expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
      mgr.enqueueMessage(agentId, {
        sender: { kind: "user", username: "tester" },
        text: "hello",
      });
      await settle(() =>
        mgr
          .getAgentLogs(agentId)
          .some((entry) => entry.metadata?.providerLogin === "claude"),
      );
      expect(
        mgr
          .getAgentLogs(agentId)
          .some(
            (entry) =>
              entry.content === english.t("systemEntries.claudeAuth.checking"),
          ),
      ).toBe(true);
    });
  }

  describe("a signed-out Codex agent", () => {
    async function signedOutCodex(
      signedOut: () => boolean = () => true,
      backendType: AgentBackendType = "codex",
    ) {
      const fake = new FakeBackend({
        signedOut,
        loginInstructions: {
          kind: "login",
          text: "terminal fallback",
          commands: ["~/.isomux/bin/codex login"],
        },
        session: {
          onSend: (_text, _attachments, session) =>
            session.completeTurn({ text: "ok" }),
        },
      });
      const h = await harness({
        backendType,
        fake,
        accounts: async () => [
          { ...claudeWire("office"), provider: "codex" as const },
        ],
        target: () => ({
          provider: "codex",
          scope: "office",
          dir: "/accounts/office-codex",
        }),
      });
      const notices = () =>
        h.mgr
          .getAgentLogs(h.agentId)
          .filter((entry) => entry.metadata?.providerLogin === "codex");
      const errors = () =>
        h.mgr.getAgentLogs(h.agentId).filter((entry) => entry.kind === "error");
      const sent = () => fake.sessions.flatMap((session) => session.sent);
      // Bounded well inside the per-test cap, and asserts nothing: each case
      // then checks the sends and the notice on their own.
      const observe = () => settle(() => notices().length > 0);
      return { ...h, fake, notices, errors, sent, observe };
    }

    function expectOneSignInNotice(notices: { content: string }[]) {
      expect(notices).toHaveLength(1);
      expect(notices[0].content).toBe(
        english.t("systemEntries.signInRequiredOffice", { provider: "Codex" }),
      );
    }

    // A new agent is dormant until its first message. It stays dormant: a
    // Codex process started for nothing races the account check on a fresh
    // CODEX_HOME.
    for (const path of ["member", "queue"] as const) {
      it(`keeps a ${path} message from Codex and shows one sign-in notice`, async () => {
        const h = await signedOutCodex();
        expect(h.mgr.getAgent(h.agentId)?.dormant).toBe(true);
        if (path === "member") {
          await h.mgr.sendMessage(h.agentId, "hi", "tester");
        } else {
          h.mgr.enqueueMessage(h.agentId, {
            sender: { kind: "user", username: "tester" },
            text: "queued hi",
          });
        }
        await h.observe();
        expect(h.fake.createSessionCount + h.fake.resumeSessionCount).toBe(0);
        expect(h.sent()).toEqual([]);
        expectOneSignInNotice(h.notices());
        expect(h.errors()).toEqual([]);
        expect(h.mgr.getAgent(h.agentId)?.dormant).toBe(true);
        expect(h.mgr.getAgent(h.agentId)?.state).toBe("waiting_for_response");
      });
    }

    it("keeps a message from a live Codex session after sign-out", async () => {
      let signedOut = false;
      const h = await signedOutCodex(() => signedOut);
      await h.mgr.sendMessage(h.agentId, "first", "tester");
      expect(h.sent()).toHaveLength(1);
      signedOut = true;
      await h.mgr.sendMessage(h.agentId, "second", "tester");
      await h.observe();
      expect(h.sent()).toHaveLength(1);
      expectOneSignInNotice(h.notices());
      expect(h.errors()).toEqual([]);
      expect(h.mgr.getAgent(h.agentId)?.state).toBe("waiting_for_response");
    });

    it("keeps an edit from Codex without branching the conversation", async () => {
      let signedOut = false;
      const h = await signedOutCodex(() => signedOut);
      await h.mgr.sendMessage(h.agentId, "first", "tester");
      const entry = h.mgr
        .getAgentLogs(h.agentId)
        .find((e) => e.kind === "user_message");
      expect(entry).toBeDefined();
      signedOut = true;
      await h.mgr.editMessage(h.agentId, entry!.id, "edited", "tester");
      await h.observe();
      expect(h.fake.forkCount).toBe(0);
      expect(h.sent()).toHaveLength(1);
      expectOneSignInNotice(h.notices());
      expect(h.errors()).toEqual([]);
      expect(h.mgr.getAgent(h.agentId)?.state).toBe("waiting_for_response");
    });

    it("keeps a skill from Codex", async () => {
      const skillDir = join(STATE_ROOT, "skills", "gateskill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "gate skill body");
      let signedOut = false;
      const h = await signedOutCodex(() => signedOut);
      await h.mgr.sendMessage(h.agentId, "first", "tester");
      expect(h.sent()).toHaveLength(1);
      signedOut = true;
      await h.mgr.sendMessage(h.agentId, "/gateskill", "tester");
      await h.observe();
      expect(h.sent()).toHaveLength(1);
      expectOneSignInNotice(h.notices());
      expect(h.errors()).toEqual([]);
      expect(h.mgr.getAgent(h.agentId)?.state).toBe("waiting_for_response");
    });

    it("sends once Codex is signed in", async () => {
      let signedOut = true;
      const h = await signedOutCodex(() => signedOut);
      await h.mgr.sendMessage(h.agentId, "first", "tester");
      signedOut = false;
      await h.mgr.sendMessage(h.agentId, "second", "tester");
      expect(h.sent()).toHaveLength(1);
      expect(h.sent()[0].text.endsWith("second")).toBe(true);
    });

    it("is what the Codex backend reports with no credentials", () => {
      const codexHome = join(STATE_ROOT, `gate-codex-${crypto.randomUUID()}`);
      mkdirSync(codexHome, { recursive: true });
      const env = { CODEX_HOME: codexHome, OPENAI_API_KEY: "" };
      expect(codexBackend.isKnownSignedOut?.(env)).toBe(true);
      expect(
        codexBackend.isKnownSignedOut?.({ ...env, OPENAI_API_KEY: "sk-test" }),
      ).toBe(false);
      writeFileSync(join(codexHome, "auth.json"), "{}");
      expect(codexBackend.isKnownSignedOut?.(env)).toBe(false);
    });
  });

  // A dead Codex refresh token leaves auth.json on disk (task 1403b454): a
  // failed turn gets the sign-in walkthrough, never "signed in, /clear". A
  // typed /login is not a failure and keeps the signed-in notice. When the
  // sign-in card can show, the failed turn points at the card instead
  // (task 1492e688).
  describe("a Codex agent whose stored sign-in fails", () => {
    async function codexWithAuthJson(
      opts: {
        // The account the card reads; absent, the account lookup is not wired.
        account?: Partial<ProviderAccountWire>;
        scope?: "office" | "personal";
        manager?: "owner" | "member";
      } = {},
    ) {
      const scope = opts.scope ?? "personal";
      const manager = { id: "user-a", role: opts.manager ?? "member" };
      const codexHome = join(STATE_ROOT, `dead-codex-${crypto.randomUUID()}`);
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "auth.json"), "{}");
      setTestManagedOfficeEnv({ CODEX_HOME: codexHome, OPENAI_API_KEY: "" });
      const fake = new FakeBackend({
        isAuthError: (text) => codexBackend.detectAuthError(text),
        session: {
          onSend: (_text, _attachments, session) => {
            session.push({ kind: "auth_needed" });
            session.push({
              kind: "turn_completed",
              status: "failed",
              error: "401 Unauthorized",
            });
          },
        },
      });
      // The real Codex answer for whatever the manager passes.
      fake.getLoginInstructions = (opts) =>
        codexBackend.getLoginInstructions(opts);
      // By default a personal account, so no office-owner gate stands in
      // front of the walkthrough.
      const h = await harness({
        backendType: "codex",
        fake,
        accounts: opts.account
          ? async () => [
              {
                ...claudeWire(scope, opts.account),
                provider: "codex" as const,
              },
            ]
          : undefined,
        findUser: (person) =>
          (
            "username" in person
              ? person.username === "tester"
              : person.userId === "user-a"
          )
            ? manager
            : undefined,
        target: () => ({
          provider: "codex",
          scope,
          dir: codexHome,
        }),
      });
      expect(isCodexAuthenticated(h.mgr.buildEnvForUserId("user-a"))).toBe(
        true,
      );
      const signedOut = await codexBackend.getLoginInstructions({
        env: { CODEX_HOME: join(codexHome, "absent"), OPENAI_API_KEY: "" },
      });
      expect(signedOut.kind).toBe("login");
      expect(signedOut.commands?.length).toBeGreaterThan(0);
      // The walkthrough is a message; the log stores its English as content.
      const signedOutText = renderLogText(english, signedOut.text);
      const signedInText = english.t(
        "systemEntries.loginInstructions.codexSignedIn",
      );
      const logs = () => h.mgr.getAgentLogs(h.agentId);
      const notices = () =>
        logs()
          .filter(
            (e) =>
              e.kind === "system" &&
              (e.content === signedOutText || e.content === signedInText),
          )
          .map((e) => e.content);
      const commands = () =>
        logs()
          .filter((e) => e.kind === "terminal-command")
          .map((e) => e.terminal?.command);
      const cards = () =>
        logs()
          .filter((e) => e.metadata?.providerLogin === "codex")
          .map((e) => e.content);
      const askedOwner = () =>
        logs().some(
          (e) => e.content === english.t("settings.signIn.askOfficeOwner"),
        );
      // Bounded inside the per-test cap and asserts nothing: the expects
      // after it name what failed.
      const settled = () =>
        settle(
          () =>
            notices().length > 0 ||
            cards().length > 0 ||
            commands().length > 0 ||
            askedOwner(),
        );
      return {
        ...h,
        signedOut,
        signedOutText,
        signedInText,
        notices,
        commands,
        cards,
        askedOwner,
        settled,
      };
    }

    // An account that cannot sign in on the card keeps the backend's own
    // signed-in notice.
    it("keeps the signed-in notice on a typed /login", async () => {
      const h = await codexWithAuthJson({
        account: { accountStatus: "connected", canBrowserLogin: false },
      });
      await h.mgr.sendMessage(h.agentId, "/login", "tester");
      await settle(() => h.notices().length > 0);
      expect(h.notices()).toEqual([h.signedInText]);
      expect(h.commands()).toEqual([]);
    });

    // Codex reads the account without refreshing its token, so a dead token
    // can still read as connected. The manager can sign out and in on the
    // card; only the office half held from a member says to ask an owner.
    const rejectedCases = [
      ["personal", "member", "systemEntries.signInRejected"],
      ["office", "member", "systemEntries.signInRejectedOffice"],
    ] as const;
    for (const [scope, manager, key] of rejectedCases) {
      it(`points a failed turn at the card of a connected ${scope} account managed by a ${manager}`, async () => {
        const h = await codexWithAuthJson({
          account: { accountStatus: "connected", canBrowserLogin: true },
          scope,
          manager,
        });
        await h.mgr.sendMessage(h.agentId, "hello", "tester");
        await h.settled();
        expect(h.cards()).toEqual([english.t(key, { provider: "Codex" })]);
        expect(h.notices()).toEqual([]);
        expect(h.commands()).toEqual([]);
        expect(h.askedOwner()).toBe(false);
      });
    }

    it("keeps the walkthrough when the connected account cannot sign in on the card", async () => {
      const h = await codexWithAuthJson({
        account: { accountStatus: "connected", canBrowserLogin: false },
      });
      await h.mgr.sendMessage(h.agentId, "hello", "tester");
      await h.settled();
      expect(h.cards()).toEqual([]);
      expect(h.notices()).toEqual([h.signedOutText]);
      expect(h.commands()).toEqual(h.signedOut.commands!);
    });

    it("keeps the signed-in card on a typed /login with a connected account", async () => {
      const h = await codexWithAuthJson({
        account: { accountStatus: "connected", canBrowserLogin: true },
      });
      await h.mgr.sendMessage(h.agentId, "/login", "tester");
      await h.settled();
      expect(h.cards()).toEqual([
        english.t("systemEntries.alreadySignedIn", { provider: "Codex" }),
      ]);
      expect(h.notices()).toEqual([]);
      expect(h.commands()).toEqual([]);
    });
  });

  // A typed /login that reaches the walkthrough is not a rejection: the
  // backend says to sign in, and a connected account does not change that.
  it("keeps the walkthrough for a typed /login that the backend answers with a sign-in", async () => {
    const fake = new FakeBackend({
      loginInstructions: {
        kind: "login",
        text: "terminal fallback",
        commands: ["~/.isomux/bin/codex login"],
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "codex",
      fake,
      accounts: async () => [
        {
          ...claudeWire("personal", { accountStatus: "connected" }),
          provider: "codex" as const,
        },
      ],
      target: () => ({
        provider: "codex",
        scope: "personal",
        dir: "/accounts/personal-codex",
      }),
    });
    await mgr.sendMessage(agentId, "/login", "tester");
    const logs = () => mgr.getAgentLogs(agentId);
    await settle(() =>
      logs().some(
        (entry) =>
          entry.kind === "terminal-command" ||
          entry.metadata?.providerLogin === "codex",
      ),
    );
    expect(
      logs().filter((entry) => entry.metadata?.providerLogin === "codex"),
    ).toEqual([]);
    expect(
      logs().filter(
        (entry) =>
          entry.kind === "system" && entry.content === "terminal fallback",
      ),
    ).toHaveLength(1);
    expect(
      logs()
        .filter((entry) => entry.kind === "terminal-command")
        .map((entry) => entry.terminal?.command),
    ).toEqual(["~/.isomux/bin/codex login"]);
  });

  it("uses only the failing Claude scope for the sign-in card", async () => {
    storeClaudeCredentials();
    const fake = new FakeBackend({
      isAuthError: (text) => text.includes("Not logged in"),
      loginInstructions: {
        kind: "login",
        text: "terminal fallback",
        commands: ["claude"],
      },
      session: {
        onSend: (_text, _attachments, session) =>
          session.push({ kind: "auth_needed" }),
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
        .some(
          (entry) =>
            entry.content === english.t("systemEntries.claudeAuth.incomplete"),
        ),
    );
    const logs = mgr.getAgentLogs(agentId);
    expect(logs.some((entry) => entry.content === "terminal fallback")).toBe(
      false,
    );
    expect(
      logs.some((entry) => entry.metadata?.providerLogin === "claude"),
    ).toBe(false);
  });

  // The backend names the sign-out command for the agent's env (it finds
  // the binary on that PATH); the manager points it at the active directory.
  it("targets the backend's logout command at the active directory", async () => {
    setTestManagedOfficeEnv({ ISOMUX_LOGOUT_PROBE: "agent-env" });
    const cases = [
      {
        backendType: "claude" as const,
        provider: "claude" as const,
        dir: "/accounts/personal claude",
        command: "CLAUDE_CONFIG_DIR='/accounts/personal claude' engine out",
      },
      {
        backendType: "codex" as const,
        provider: "codex" as const,
        dir: "/accounts/office codex",
        command: "CODEX_HOME='/accounts/office codex' engine out",
      },
    ];
    for (const testCase of cases) {
      const fake = new FakeBackend({ logoutCommand: "engine out" });
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
      expect(fake.logoutCalls).toHaveLength(1);
      expect(fake.logoutCalls[0].env?.ISOMUX_LOGOUT_PROBE).toBe("agent-env");
    }
  });

  it("offers no terminal command when the backend cannot name one", async () => {
    const fake = new FakeBackend({
      logoutCommand: () => {
        throw new Error("no binary");
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      accounts: async () => [
        claudeWire("personal", { canBrowserLogin: false }),
      ],
      target: () => ({
        provider: "claude",
        scope: "personal",
        dir: "/accounts/personal-claude",
      }),
    });
    await mgr.sendMessage(agentId, "/logout", "tester");
    await settle(() => fake.logoutCalls.length > 0);
    // The fallback reached the backend, and its failure stays inside it.
    expect(fake.logoutCalls).toHaveLength(1);
    const logs = mgr.getAgentLogs(agentId);
    expect(logs.some((entry) => entry.kind === "terminal-command")).toBe(false);
    expect(logs.some((entry) => entry.content.includes("undefined"))).toBe(
      false,
    );
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
    ).toBe(english.t("systemEntries.manageSignIn", { provider: "Claude" }));

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
            entry.content === english.t("systemEntries.signOutOpenCode"),
        ),
    ).toBe(true);
    expect(
      opencode.mgr
        .getAgentLogs(opencode.agentId)
        .some((entry) => entry.kind === "terminal-command"),
    ).toBe(false);
  });

  // Only an owner gets the office login or logout command (Nil,
  // 2026-10-14). The person who typed the command decides; with no typist,
  // the agent's manager does. The card renders only for the manager, so a
  // typist who is someone else gets the terminal path. "tester" types;
  // "user-a" manages.
  describe("an agent on the office account", () => {
    const askOwner = english.t("settings.signIn.askOfficeOwner");
    async function officeAgent(opts: {
      typist: "owner" | "member" | "manager";
      manager: "owner" | "member";
      provider?: "claude" | "codex";
      scope?: "office" | "personal";
      canBrowserLogin?: boolean;
    }) {
      const provider = opts.provider ?? "claude";
      const scope = opts.scope ?? "office";
      const manager = { id: "user-a", role: opts.manager };
      const typist =
        opts.typist === "manager"
          ? manager
          : { id: "user-b", role: opts.typist };
      const fake = new FakeBackend({
        signedOut: () => true,
        loginInstructions: {
          kind: "login",
          text: "terminal fallback",
          commands: [`${provider} login`],
        },
        logoutCommand: `${provider} logout`,
      });
      const h = await harness({
        backendType: provider,
        fake,
        findUser: (person) =>
          "username" in person
            ? person.username === "tester"
              ? typist
              : undefined
            : person.userId === "user-a"
              ? manager
              : undefined,
        accounts: async () => [
          {
            ...claudeWire(scope, {
              canBrowserLogin: opts.canBrowserLogin ?? true,
            }),
            provider,
          },
        ],
        target: () => ({
          provider,
          scope,
          dir: `/accounts/${scope} ${provider}`,
        }),
      });
      const logs = () => h.mgr.getAgentLogs(h.agentId);
      const commands = () =>
        logs()
          .filter((entry) => entry.kind === "terminal-command")
          .map((entry) => entry.terminal?.command);
      const asked = () => logs().some((entry) => entry.content === askOwner);
      const card = () =>
        logs().some((entry) => entry.metadata?.providerLogin === provider);
      const cardText = () =>
        logs().find((entry) => entry.metadata?.providerLogin === provider)
          ?.content;
      // Bounded inside the per-test cap and asserts nothing: the expects
      // after it name what failed.
      const settled = () =>
        settle(() => asked() || commands().length > 0 || card());
      return { ...h, commands, asked, card, cardText, settled };
    }

    it("gives an owner who types /login on a member's agent the command, not the card", async () => {
      const h = await officeAgent({ typist: "owner", manager: "member" });
      await h.mgr.sendMessage(h.agentId, "/login", "tester");
      await h.settled();
      expect(h.commands()).toEqual(["claude login"]);
      expect(h.card()).toBe(false);
      expect(h.asked()).toBe(false);
    });

    it("gives a member who types /login on an owner's agent the owner line", async () => {
      const h = await officeAgent({ typist: "member", manager: "owner" });
      await h.mgr.sendMessage(h.agentId, "/login", "tester");
      await h.settled();
      expect(h.commands()).toEqual([]);
      expect(h.card()).toBe(false);
      expect(h.asked()).toBe(true);
    });

    it("gives a member who types /logout on an owner's agent the owner line", async () => {
      const h = await officeAgent({ typist: "member", manager: "owner" });
      await h.mgr.sendMessage(h.agentId, "/logout", "tester");
      await h.settled();
      expect(h.commands()).toEqual([]);
      expect(h.card()).toBe(false);
      expect(h.asked()).toBe(true);
    });

    it("gives an owner who types /logout on a member's agent the command, not the card", async () => {
      const h = await officeAgent({ typist: "owner", manager: "member" });
      await h.mgr.sendMessage(h.agentId, "/logout", "tester");
      await h.settled();
      expect(h.commands()).toEqual([
        "CLAUDE_CONFIG_DIR='/accounts/office claude' claude logout",
      ]);
      expect(h.card()).toBe(false);
      expect(h.asked()).toBe(false);
    });

    for (const manager of ["member", "owner"] as const) {
      it(`keeps the card for a ${manager} manager who types /login`, async () => {
        const h = await officeAgent({ typist: "manager", manager });
        await h.mgr.sendMessage(h.agentId, "/login", "tester");
        await h.settled();
        expect(h.card()).toBe(true);
        expect(h.cardText()).toBe(
          english.t(
            manager === "owner"
              ? "systemEntries.signInPrompt"
              : "systemEntries.notSignedIn",
            { provider: "Claude" },
          ),
        );
        expect(h.commands()).toEqual([]);
        expect(h.asked()).toBe(false);
      });
    }

    it("keeps the card when someone else types /login on a personal-account agent", async () => {
      const h = await officeAgent({
        typist: "member",
        manager: "owner",
        scope: "personal",
      });
      await h.mgr.sendMessage(h.agentId, "/login", "tester");
      await h.settled();
      expect(h.card()).toBe(true);
      expect(h.commands()).toEqual([]);
      expect(h.asked()).toBe(false);
    });

    for (const manager of ["member", "owner"] as const) {
      // The typist is the opposite role, so a gate that read the typist
      // would fail here.
      const typist = manager === "owner" ? "member" : "owner";
      const failTurn = async (canBrowserLogin: boolean) => {
        const h = await officeAgent({
          typist,
          manager,
          provider: "codex",
          canBrowserLogin,
        });
        h.mgr.enqueueMessage(h.agentId, {
          sender: { kind: "user", username: "tester" },
          text: "hello",
        });
        await h.settled();
        return h;
      };

      it(`keeps the card on a sign-in failure for a ${manager} manager`, async () => {
        const h = await failTurn(true);
        expect(h.card()).toBe(true);
        expect(h.cardText()).toBe(
          english.t(
            manager === "owner"
              ? "systemEntries.signInRequired"
              : "systemEntries.signInRequiredOffice",
            { provider: "Codex" },
          ),
        );
        expect(h.commands()).toEqual([]);
        expect(h.asked()).toBe(false);
      });

      it(`lets a ${manager} manager's role decide the fallback on a sign-in failure`, async () => {
        const h = await failTurn(false);
        expect(h.card()).toBe(false);
        expect(h.commands()).toEqual(
          manager === "owner" ? ["codex login"] : [],
        );
        expect(h.asked()).toBe(manager === "member");
      });
    }
  });
});

describe("Claude auth-error status checks", () => {
  beforeEach(() => storeClaudeCredentials());

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
          session.push({ kind: "auth_needed" });
          session.push({ kind: "auth_needed" });
          session.push({ kind: "auth_needed" });
          session.push({
            kind: "turn_completed",
            status: "failed",
            error: "401 Unauthorized",
          });
        },
      },
    });
  }

  // Only an owner signs the office account in (Nil, 2026-10-14): a member
  // manager is told to ask one, and the card still follows.
  for (const role of ["member", "owner"] as const) {
    it(`tells a ${role} manager of an office Claude agent what to do`, async () => {
      const { mgr, agentId } = await harness({
        backendType: "claude",
        fake: rejected(),
        target: () => ({
          provider: "claude",
          scope: "office",
          dir: "/accounts/office-claude",
        }),
        findUser: () => ({ id: "user-a", role }),
        accounts: async () => [claudeWire("office")],
      });
      mgr.enqueueMessage(agentId, {
        sender: { kind: "user", username: "tester" },
        text: "hello",
      });
      const entry = () =>
        mgr
          .getAgentLogs(agentId)
          .find((e) => e.metadata?.providerLogin === "claude");
      await settle(() => !!entry());
      expect(entry()?.content).toBe(
        role === "member"
          ? english.t("systemEntries.claudeAuth.disconnectedAskOwner")
          : english.t("systemEntries.claudeAuth.disconnected", {
              location: english.t("systemEntries.claudeAuth.officeLocation"),
            }),
      );
    });
  }

  // A sign-in already running on the directory (task 84e98d49): no account
  // read starts during it, and the chat says the sign-in is in progress -
  // never "disconnected" - with the card, which follows the login live.
  // Seen by a member, so a check that ran after not_connected would read
  // as "ask an owner".
  it("a not-connected account during another person's office sign-in, seen by a member", async () => {
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake: rejected(),
      target: () => ({
        provider: "claude",
        scope: "office",
        dir: "/accounts/office-claude",
      }),
      findUser: () => ({ id: "user-a", role: "member" }),
      accounts: async () => [
        claudeWire("office", {
          loginStatus: "waiting_external",
          loginQueue: { holderName: "Morgan", startedAt: 1 },
        }),
      ],
    });
    mgr.enqueueMessage(agentId, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    const entry = () =>
      mgr
        .getAgentLogs(agentId)
        .find((e) => e.metadata?.providerLogin === "claude");
    await settle(() => !!entry());
    expect(entry()?.content).toBe(
      english.t("systemEntries.claudeAuth.signingIn"),
    );
  });

  // The office location is pinned by the owner row above.
  {
    const scope = "personal";
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
        // An owner manager: a member's office text is the next test's.
        findUser: () => ({ id: "user-a", role: "owner" }),
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
      // The agent was woken from idle, so this is the resume path.
      expect(
        logs.some((e) => e.content === english.t("systemEntries.wake.idle")),
      ).toBe(true);
      // Three auth signals, one read, one checking line, then one card.
      expect(calls).toBe(1);
      const checking = english.t("systemEntries.claudeAuth.checking");
      expect(logs.filter((e) => e.content === checking)).toHaveLength(1);
      const cards = logs.filter((e) => e.metadata?.providerLogin === "claude");
      expect(cards).toHaveLength(1);
      expect(logs.indexOf(cards[0])).toBeGreaterThan(
        logs.findIndex((e) => e.content === checking),
      );
      // The card points at this scope's own place, never the backend's text.
      expect(cards[0].content).toBe(
        english.t("systemEntries.claudeAuth.disconnected", {
          location: english.t("systemEntries.claudeAuth.personalLocation"),
        }),
      );
      expect(
        logs.some((e) => e.content.includes("Claude Code is signed in")),
      ).toBe(false);
    });
  }

  for (const initialized of [false, true]) {
    it(`keeps the account explanation conditional with ${initialized ? "an unchanged" : "no recorded"} root`, async () => {
      const fake = new FakeBackend({
        isAuthError: (text) => claudeBackend.detectAuthError(text),
        session: {
          autoSystemInit: initialized,
          onSend: (_text, _attachments, session) => {
            session.push({ kind: "auth_needed" });
            session.completeTurn({
              status: "failed",
              error: "401 unauthorized",
            });
          },
        },
      });
      const { mgr, agentId } = await harness({
        backendType: "claude",
        fake,
        accounts: async () => [
          claudeWire("office", { accountStatus: "connected" }),
        ],
        target: () => ({
          provider: "claude",
          scope: "office",
          dir: "/accounts/office-claude",
        }),
      });
      const connected = english.t("systemEntries.claudeAuth.connected");
      try {
        await mgr.sendMessage(agentId, "hello", "tester");
        await waitFor(() =>
          mgr
            .getAgentLogs(agentId)
            .some((entry) => entry.content === connected),
        );
        const entry = mgr
          .getAgentLogs(agentId)
          .find((value) => value.content === connected);
        expect(entry?.metadata?.providerLogin).toBe("claude");
        expect(
          mgr
            .getAgentLogs(agentId)
            .some(
              (value) =>
                value.content === english.t("systemEntries.claudeAuth.pinned"),
            ),
        ).toBe(false);
      } finally {
        await mgr.kill(agentId);
      }
    });
  }

  it("keeps the cwd-specific error and rolls back edits when a legacy transcript is missing", async () => {
    const fake = new FakeBackend({
      session: {
        onSend: (_text, _attachments, session) =>
          session.completeTurn({ text: "ok" }),
      },
    });
    const { mgr, agentId } = await harness({ backendType: "claude", fake });
    try {
      await mgr.sendMessage(agentId, "first", "tester");
      // Simulate legacy metadata with no recorded root and no native transcript.
      writeFileSync(join(STATE_ROOT, "logs", agentId, "sessions.json"), "{}");
      expect(
        getSessionClaudeConfigDir(agentId, fake.sessions[0].sessionId),
      ).toBeUndefined();
      const before = mgr.getAgent(agentId)!;
      const oldName = before.name;
      const oldCwd = before.cwd;
      const newCwd = join(STATE_ROOT, `missing-transcript-${agentId}`);
      mkdirSync(newCwd, { recursive: true });
      const failure = await mgr
        .editAgent(agentId, { cwd: newCwd, name: "Should roll back" })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("cwd change aborted");
      expect(mgr.getAgent(agentId)?.cwd).toBe(oldCwd);
      expect(mgr.getAgent(agentId)?.name).toBe(oldName);
    } finally {
      await mgr.kill(agentId);
    }
  });

  it("records the launch root when sign-in changes before system_init", async () => {
    const userId = `init-${crypto.randomUUID()}`;
    const oldRoot = join(STATE_ROOT, "launch-root");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: oldRoot });
    const fake = new FakeBackend({
      session: {
        autoSystemInit: false,
        onSend: (_text, _attachments, session) => {
          activatePersonalProvider(userId, "claude");
          session.push({
            kind: "system_init",
            sessionId: session.sessionId,
            slashCommands: [],
          });
          session.completeTurn({ text: "ok" });
        },
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      userId,
    });
    try {
      await mgr.sendMessage(agentId, "first", "tester");
      expect(
        getSessionClaudeConfigDir(agentId, fake.sessions[0].sessionId),
      ).toBe(oldRoot);
      await mgr.resume(agentId, fake.sessions[0].sessionId);
      expect(fake.sessions.at(-1)?.opts.env?.CLAUDE_CONFIG_DIR).toBe(oldRoot);
      expect(
        getSessionClaudeConfigDir(agentId, fake.sessions[0].sessionId),
      ).toBe(oldRoot);
    } finally {
      deactivatePersonalProvider(userId, "claude");
      await mgr.kill(agentId);
    }
  });

  it("offers clear after personal sign-in and starts the next conversation with the new account environment", async () => {
    const userId = `signin-${crypto.randomUUID()}`;
    const personalDir = personalProviderHome(userId, "claude");
    const events = logEntryWaiter();
    setTestManagedOfficeEnv({
      CLAUDE_CONFIG_DIR: join(STATE_ROOT, "old-office-claude"),
    });
    const fake = new FakeBackend({
      isAuthError: (text) => claudeBackend.detectAuthError(text),
      session: {
        onSend: (_text, _attachments, session) => {
          if (_text.endsWith("before sign-in")) {
            session.completeTurn({ text: "Existing account turn" });
          } else if (session.opts.env?.CLAUDE_CONFIG_DIR !== personalDir) {
            session.push({ kind: "auth_needed" });
            session.completeTurn({
              status: "failed",
              error: "401 unauthorized",
            });
          } else {
            session.completeTurn({ text: "New account works" });
          }
        },
      },
    });
    const { mgr, agentId } = await harness({
      backendType: "claude",
      fake,
      userId,
      accounts: async () => [
        claudeWire("personal", {
          accountStatus: "connected",
          loginStatus: "idle",
        }),
      ],
      target: () => ({
        provider: "claude",
        scope: "personal",
        dir: personalDir,
      }),
      eventSink: events.onEvent,
    });
    try {
      // Start before the personal home is activated by successful sign-in.
      await mgr.sendMessage(agentId, "before sign-in", "tester");
      const oldSession = fake.sessions[0];
      expect(oldSession.opts.env?.CLAUDE_CONFIG_DIR).toBe(
        join(STATE_ROOT, "old-office-claude"),
      );
      activatePersonalProvider(userId, "claude");
      // A real sign-in leaves credentials in the personal home.
      mkdirSync(personalDir, { recursive: true });
      writeFileSync(join(personalDir, ".credentials.json"), "{}");
      const pinned = english.t("systemEntries.claudeAuth.pinned");
      const guidanceEvent = events.waitFor(
        (event) => event.entry.content === pinned,
        "Claude new-account guidance after sign-in",
      );
      await mgr.sendMessage(agentId, "after sign-in", "tester");
      expect(fake.sessions).toHaveLength(1);
      expect(oldSession.opts.env?.CLAUDE_CONFIG_DIR).toBe(
        join(STATE_ROOT, "old-office-claude"),
      );
      const guidance = (await guidanceEvent).entry;
      expect(guidance.metadata?.providerLogin).toBe("claude");
      // Explicit resume exercises the same replacement used after interrupt.
      await mgr.resume(agentId, oldSession.sessionId);
      expect(fake.sessions.at(-1)?.opts.env?.CLAUDE_CONFIG_DIR).toBe(
        join(STATE_ROOT, "old-office-claude"),
      );
      expect(getSessionClaudeConfigDir(agentId, oldSession.sessionId)).toBe(
        join(STATE_ROOT, "old-office-claude"),
      );
      const resumedGuidanceEvent = events.waitFor(
        (event) => event.entry.content === pinned,
        "Claude pinned-account guidance after resume",
      );
      await mgr.sendMessage(agentId, "retry after resume", "tester");
      await resumedGuidanceEvent;
      expect(
        mgr.getAgentLogs(agentId).filter((e) => e.content === pinned),
      ).toHaveLength(2);
      // A cwd edit must move the transcript within the pinned root.
      const oldProject = claudeProjectDir(STATE_ROOT, oldSession.opts.env);
      mkdirSync(oldProject, { recursive: true });
      writeFileSync(join(oldProject, `${oldSession.sessionId}.jsonl`), "{}\n");
      const newCwd = join(STATE_ROOT, `moved-${userId}`);
      mkdirSync(newCwd, { recursive: true });
      await mgr.editAgent(agentId, { cwd: newCwd });
      expect(
        existsSync(
          join(
            claudeProjectDir(newCwd, oldSession.opts.env),
            `${oldSession.sessionId}.jsonl`,
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            claudeProjectDir(newCwd, { CLAUDE_CONFIG_DIR: personalDir }),
            `${oldSession.sessionId}.jsonl`,
          ),
        ),
      ).toBe(false);
      await mgr.newConversation(agentId);
      await mgr.sendMessage(agentId, "fresh", "tester");
      expect(oldSession.closed).toBe(true);
      expect(fake.sessions.at(-1)?.opts.env?.CLAUDE_CONFIG_DIR).toBe(
        personalDir,
      );
      expect(
        mgr
          .getAgentLogs(agentId)
          .some((e) => e.content === "New account works"),
      ).toBe(true);
    } finally {
      deactivatePersonalProvider(userId, "claude");
      await mgr.kill(agentId);
    }
  });

  // Every failed read lands in one catch; a hang also aborts the read.
  for (const failure of ["throw", "hang"] as const) {
    it(`finishes ${failure} with retry/sign-in guidance, not a disconnected claim`, async () => {
      let aborted = false;
      const { mgr, agentId } = await harness({
        backendType: "claude",
        fake: rejected(),
        timeoutMs: 20,
        target: () => ({
          provider: "claude",
          scope: "office",
          dir: "/accounts/office-claude",
        }),
        accounts: async (_userId, options) => {
          if (failure === "throw") throw new Error("probe failed");
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
      const incomplete = english.t("systemEntries.claudeAuth.incomplete");
      await mgr.sendMessage(agentId, "hello", "tester");
      await waitFor(() =>
        mgr.getAgentLogs(agentId).some((e) => e.content === incomplete),
      );
      const logs = mgr.getAgentLogs(agentId);
      expect(
        logs.filter(
          (e) => e.content === english.t("systemEntries.claudeAuth.checking"),
        ),
      ).toHaveLength(1);
      expect(logs.filter((e) => e.content === incomplete)).toHaveLength(1);
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
});
