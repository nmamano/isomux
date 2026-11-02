// Auth-error checks and the sign-in, sign-out and not-configured notices of
// each agent. Moved out of createAgentManager (server/agent-manager.ts), which
// wires it.
import { resolve } from "path";
import type {
  AgentBackendType,
  AgentState,
  Attachment,
  LogEntry,
  UserRole,
} from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import { msg, msgN, type LogText } from "../shared/i18n/log-message.ts";
import type { ManagerDeps } from "./agent-manager.ts";
import { getAgentHost } from "./agent-host.ts";
import {
  claudeSignInState,
  isClaudeCloudSelected,
} from "./backends/claude-install-check.ts";
import { isCodexAuthenticated } from "./backends/codex/native-bin.ts";
import type { Backend, LoginInstructions } from "./backends/types.ts";
import { claudeConfigRoot } from "./claude-session-root.ts";
import {
  buildEnvForUserId,
  environmentSourceKeyForUserId,
} from "./env-loader.ts";
import {
  BackendNotConfiguredError,
  BackendSignedOutError,
  type ManagedAgent,
} from "./internal-types.ts";
import { getSessionClaudeConfigDir } from "./persistence.ts";
import {
  effectiveProviderDirectory,
  type EffectiveProviderAccountTarget,
} from "./provider-account-manager.ts";

export function detectAuthErrorForEnvironment(
  agentType: AgentBackendType,
  text: string,
  env: Record<string, string | undefined> | undefined,
  detect: (value: string) => boolean,
): boolean {
  // Bedrock and Vertex own authentication and access failures. Their messages
  // must pass through as provider errors; Claude's OAuth guidance only applies
  // to the first-party provider.
  if (agentType === "claude" && env && isClaudeCloudSelected(env)) {
    return false;
  }
  return detect(text);
}

/**
 * A backend id as its product name. Proper nouns, so the same in every
 * language (ruling 11); a name is a placeholder in the sentences above rather
 * than two sentences per provider.
 */
export function providerDisplayName(provider: string): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export interface AgentAuthDeps {
  agents: Map<string, ManagedAgent>;
  getBackend: (agentType: AgentBackendType) => Backend;
  findUser: (
    person: { userId: string } | { username: string },
  ) => { id: string; role: UserRole } | undefined;
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
    extra?: Partial<
      Pick<LogEntry, "diff" | "file" | "terminal" | "secretRequest">
    >,
  ) => unknown;
  updateState: (agentId: string, state: AgentState) => void;
  emitAgentTerminalCommand: (
    agentId: string,
    rawCommand: string,
    opts?: { open?: boolean },
  ) => unknown;
  holdQueue: (managed: ManagedAgent) => symbol;
  listProviderAccounts?: ManagerDeps["listProviderAccounts"];
  effectiveProviderAccountTarget?: ManagerDeps["effectiveProviderAccountTarget"];
  claudeAuthCheckTimeoutMs?: ManagerDeps["claudeAuthCheckTimeoutMs"];
}

export function createAgentAuth(deps: AgentAuthDeps) {
  const {
    agents,
    getBackend,
    findUser,
    addLogEntry,
    updateState,
    emitAgentTerminalCommand,
    holdQueue,
  } = deps;

  // Auth-error check for a one-shot result (topic generation), which runs
  // outside the session stream. Session events never need it: the backend
  // sends auth_needed (server/backends/auth-signal.ts).
  function detectAgentAuthError(managed: ManagedAgent, text: string): boolean {
    let env: Record<string, string | undefined> | undefined;
    try {
      env = buildEnvForUserId(managed.info.userId);
    } catch {
      env = undefined;
    }
    const backend = getBackend(managed.info.agentType);
    return detectAuthErrorForEnvironment(
      managed.info.agentType,
      text,
      env,
      (value) => backend.detectAuthError(value),
    );
  }
  // A signed-out engine is not woken either: runAgentTurn stops the send, and
  // an engine process started for nothing can break the sign-in check (two
  // Codex processes on a fresh CODEX_HOME race to create its state database).
  function signedOutProvider(managed: ManagedAgent): string | null {
    const backend = getBackend(managed.info.agentType);
    if (!backend.isKnownSignedOut) return null;
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildEnvForUserId(managed.info.userId);
    } catch {
      return null;
    }
    return backend.isKnownSignedOut(env)
      ? providerDisplayName(managed.info.agentType)
      : null;
  }
  async function agentIsKnownUnauthenticated(
    managed: ManagedAgent,
  ): Promise<boolean> {
    // Credential state must gate topic-output sniffing. The per-turn auth
    // notice cannot: topic generation starts at send time, before the backend
    // can emit that notice, so the first-run ordering is racy.
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildEnvForUserId(managed.info.userId);
    } catch {
      return false;
    }
    // An "unknown" Claude answer is not known-unauthenticated.
    if (managed.info.agentType === "claude")
      return (await claudeSignInState(env)) === "signed_out";
    if (managed.info.agentType === "codex") return !isCodexAuthenticated(env);
    return false;
  }
  async function agentLoginInstructions(
    managed: ManagedAgent | undefined,
    { credentialsRejected }: { credentialsRejected?: boolean } = {},
  ): Promise<LoginInstructions> {
    const generic: LoginInstructions = {
      kind: "login",
      cardEligible: false,
      text: msg("systemEntries.loginInstructions.generic"),
    };
    if (!managed) return generic;
    // Resolve the merged env (process.env + office variables + managed personal variables, in
    // override order) so the backend can recognize env-var auth (e.g. Codex
    // OPENAI_API_KEY in the user's managed variables) and skip the full sign-in
    // walkthrough at a user who's already authed. Best-effort: if loading
    // the environment fails, buildEnvForUserId throws - we want the original auth-error guidance to
    // still surface, not have the hint generator itself fail. Fall back to
    // undefined so the backend uses process.env. Mirrors the envForHints
    // pattern elsewhere in this file.
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildEnvForUserId(managed.info.userId);
    } catch {
      env = undefined;
    }
    try {
      return await getBackend(managed.info.agentType).getLoginInstructions({
        env,
        environmentKey: environmentSourceKeyForUserId(managed.info.userId),
        modelFamily: managed.info.modelFamily,
        credentialsRejected,
      });
    } catch (err) {
      // The sign-in state is unknown: give the generic guidance.
      console.error(
        `[auth] login instructions failed for ${managed.info.agentType}:`,
        errMessage(err),
      );
      return generic;
    }
  }

  // Emit a system log entry with the login/install text, plus the backend's
  // companion terminal-command cards. Centralizes the auth-error callsites.
  async function emitLoginInstructions(
    agentId: string,
    instructions: LoginInstructions,
    // Present when a person typed /login; absent on the auth-error path, where
    // the writer has no typist to name.
    username?: string,
    // A typed /login is not a message the engine failed to run.
    trigger: "turn" | "login_command" = "turn",
  ): Promise<void> {
    const managed = agents.get(agentId);
    if (
      (managed?.info.agentType === "codex" ||
        managed?.info.agentType === "claude") &&
      managed.info.userId &&
      instructions.cardEligible &&
      instructions.commands?.length &&
      deps.listProviderAccounts
    ) {
      try {
        const provider = managed.info.agentType;
        const target = fallbackProviderTarget(managed);
        if (!target) throw new Error("Provider account scope is unavailable.");
        if (cardHiddenFromTypist(managed, target, username))
          throw new Error("The typist cannot see the sign-in card.");
        const accounts = await deps.listProviderAccounts(managed.info.userId);
        const account = accounts.find(
          (value) =>
            value.provider === provider &&
            value.scope === target.scope &&
            value.canBrowserLogin,
        );
        // A failed turn on an account that reads connected means the stored
        // sign-in was rejected (a dead Codex token stays in auth.json): the
        // card's Sign out and Sign in replace it.
        const rejected =
          trigger === "turn" &&
          instructions.kind === "login" &&
          account?.accountStatus === "connected";
        if (account && (account.accountStatus !== "connected" || rejected)) {
          // A member's card has no Sign in on the office half; it says to
          // ask an owner, so the entry does not say "sign in below".
          const withheld = officeSignInWithheld(managed, target, username);
          addLogEntry(
            agentId,
            "system",
            msg(
              rejected
                ? withheld
                  ? "systemEntries.signInRejectedOffice"
                  : "systemEntries.signInRejected"
                : trigger === "login_command"
                  ? withheld
                    ? "systemEntries.notSignedIn"
                    : "systemEntries.signInPrompt"
                  : withheld
                    ? "systemEntries.signInRequiredOffice"
                    : "systemEntries.signInRequired",
              { provider: providerDisplayName(provider) },
            ),
            { providerLogin: provider },
          );
          return;
        }
      } catch {}
    }
    if (
      managed &&
      instructions.kind === "login" &&
      officeSignInWithheld(managed, fallbackProviderTarget(managed), username)
    ) {
      addLogEntry(agentId, "system", msg("settings.signIn.askOfficeOwner"));
      return;
    }
    addLogEntry(agentId, "system", instructions.text);
    for (const command of instructions.commands ?? []) {
      emitAgentTerminalCommand(agentId, command);
    }
  }

  // Only an owner signs the office account in or out (Nil, 2026-10-14), so
  // a member never gets the office login or logout command in the terminal.
  // The person who typed the command decides; with no typist, the agent's
  // manager does.
  function officeSignInWithheld(
    managed: ManagedAgent,
    target: EffectiveProviderAccountTarget | null,
    username: string | undefined,
  ): boolean {
    const userId = managed.info.userId;
    if (!userId || target?.scope !== "office") return false;
    return findUser(username ? { username } : { userId })?.role !== "owner";
  }

  // The sign-in card renders only for the agent's manager. Another person
  // who types /login or /logout on an office-account agent gets the terminal
  // path, which officeSignInWithheld gates by their own role.
  function cardHiddenFromTypist(
    managed: ManagedAgent,
    target: EffectiveProviderAccountTarget | null,
    username: string | undefined,
  ): boolean {
    return (
      !!username &&
      target?.scope === "office" &&
      findUser({ username })?.id !== managed.info.userId
    );
  }

  function emitDetectedAuthInstructions(
    agentId: string,
    managed: ManagedAgent | undefined,
  ): void {
    if (managed?.authNeededThisTurn) return;
    if (managed) managed.authNeededThisTurn = true;
    void (async () => {
      // Credentials that exist were rejected and get the connection check.
      // With none at all, Claude gets the same single notice as Codex.
      if (
        managed?.info.agentType === "claude" &&
        !(await agentIsKnownUnauthenticated(managed))
      ) {
        await emitClaudeAuthInstructions(agentId, managed);
        return;
      }
      await emitLoginInstructions(
        agentId,
        await agentLoginInstructions(managed, { credentialsRejected: true }),
      );
    })();
  }

  async function emitClaudeAuthInstructions(
    agentId: string,
    managed: ManagedAgent,
  ): Promise<void> {
    addLogEntry(agentId, "system", msg("systemEntries.claudeAuth.checking"));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const target = fallbackProviderTarget(managed);
      if (!managed.info.userId || !target || !deps.listProviderAccounts)
        throw new Error("Account scope unavailable");
      const expired = new Promise<never>((_resolve, reject) => {
        // 2026-09-09: three loaded-box probes took 3.486/3.649/5.779s.
        // Three times the slowest reaches the approved 10s cap.
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Account check deadline"));
        }, deps.claudeAuthCheckTimeoutMs ?? 10_000);
      });
      const accounts = await Promise.race([
        deps.listProviderAccounts(managed.info.userId, {
          provider: "claude",
          scope: target.scope,
          refresh: true,
          signal: controller.signal,
        }),
        expired,
      ]);
      const account = accounts.find(
        (value) => value.provider === "claude" && value.scope === target.scope,
      );
      if (!account || account.accountStatus === "unavailable")
        throw new Error("Account check unavailable");
      const location = msg(
        target.scope === "office"
          ? "systemEntries.claudeAuth.officeLocation"
          : "systemEntries.claudeAuth.personalLocation",
      );
      if (account.loginStatus === "waiting_external") {
        // The account cannot be read until the login on its directory ends.
        addLogEntry(
          agentId,
          "system",
          msg("systemEntries.claudeAuth.signingIn"),
          { providerLogin: "claude" },
        );
      } else if (account.accountStatus === "not_connected") {
        addLogEntry(
          agentId,
          "system",
          officeSignInWithheld(managed, target, undefined)
            ? msg("systemEntries.claudeAuth.disconnectedAskOwner")
            : msg("systemEntries.claudeAuth.disconnected", { location }),
          { providerLogin: "claude" },
        );
      } else if (account.accountStatus === "connected") {
        addLogEntry(
          agentId,
          "system",
          msg(
            managed.sessionManager.sessionId &&
              getSessionClaudeConfigDir(
                agentId,
                managed.sessionManager.sessionId,
              ) &&
              getSessionClaudeConfigDir(
                agentId,
                managed.sessionManager.sessionId,
              ) !== claudeConfigRoot(buildEnvForUserId(managed.info.userId))
              ? "systemEntries.claudeAuth.pinned"
              : "systemEntries.claudeAuth.connected",
          ),
          { providerLogin: "claude" },
        );
      } else {
        throw new Error("Account check incomplete");
      }
    } catch {
      addLogEntry(
        agentId,
        "system",
        msg("systemEntries.claudeAuth.incomplete"),
      );
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  function quoteShellWord(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
  }

  function fallbackProviderTarget(
    managed: ManagedAgent,
  ): EffectiveProviderAccountTarget | null {
    const provider = managed.info.agentType;
    if (provider !== "claude" && provider !== "codex") return null;
    if (managed.info.userId && deps.effectiveProviderAccountTarget) {
      try {
        return deps.effectiveProviderAccountTarget(
          managed.info.userId,
          provider,
        );
      } catch {
        return null;
      }
    }
    let env: Record<string, string | undefined> | undefined;
    try {
      env = buildEnvForUserId(managed.info.userId);
    } catch {
      return null;
    }
    // Production injects the exact scope resolver beside listProviderAccounts
    // in isomux-office.ts. Older DI seams predate account scopes, so their
    // honest compatibility default is the office scope.
    return {
      provider,
      scope: "office",
      dir: effectiveProviderDirectory(
        provider,
        env ?? getAgentHost().baseEnv(),
      ),
    };
  }

  async function emitLogoutAffordance(
    agentId: string,
    managed: ManagedAgent,
    username?: string,
  ): Promise<void> {
    const provider = managed.info.agentType;
    if (provider === "opencode") {
      addLogEntry(agentId, "system", msg("systemEntries.signOutOpenCode"));
      return;
    }
    const target = fallbackProviderTarget(managed);
    if (!target) {
      addLogEntry(
        agentId,
        "system",
        msg("systemEntries.signOutNoScope", {
          provider: providerDisplayName(provider),
        }),
      );
      return;
    }
    if (
      managed.info.userId &&
      deps.listProviderAccounts &&
      deps.effectiveProviderAccountTarget &&
      !cardHiddenFromTypist(managed, target, username)
    ) {
      try {
        const accounts = await deps.listProviderAccounts(managed.info.userId);
        const cardIsAvailable = accounts.some(
          (account) =>
            account.provider === provider &&
            account.scope === target.scope &&
            account.canBrowserLogin,
        );
        if (cardIsAvailable) {
          addLogEntry(
            agentId,
            "system",
            msg("systemEntries.manageSignIn", {
              provider: providerDisplayName(provider),
            }),
            { providerLogin: provider },
          );
          return;
        }
      } catch {}
    }
    if (officeSignInWithheld(managed, target, username)) {
      addLogEntry(agentId, "system", msg("settings.signIn.askOfficeOwner"));
      return;
    }
    // The backend names the command, so it resolves the binary the same way
    // its sign-in does. Without one, the member gets no command to run.
    let baseCommand: string | undefined;
    try {
      let env: { [key: string]: string | undefined } | undefined;
      try {
        env = buildEnvForUserId(managed.info.userId);
      } catch {
        env = undefined;
      }
      baseCommand = getBackend(provider).logoutCommand?.({ env });
    } catch (err) {
      console.error(
        `[auth] logout command failed for ${provider}:`,
        errMessage(err),
      );
    }
    if (!baseCommand) return;
    const variable = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    const command = `${variable}=${quoteShellWord(resolve(target.dir))} ${baseCommand}`;
    addLogEntry(
      agentId,
      "system",
      msg("systemEntries.runInTerminal", { command }),
    );
    emitAgentTerminalCommand(agentId, command);
  }

  // /login while already signed in opens the same card affordance /logout
  // does, with its own notice. Falls back to the backend's already-authed
  // text when the card cannot render, which keeps the /clear advice for
  // terminal-only setups.
  async function emitAlreadySignedInAffordance(
    agentId: string,
    managed: ManagedAgent,
    fallback: LoginInstructions,
    username?: string,
  ): Promise<void> {
    const provider = managed.info.agentType;
    if (
      (provider === "claude" || provider === "codex") &&
      managed.info.userId &&
      deps.listProviderAccounts &&
      deps.effectiveProviderAccountTarget
    ) {
      const target = fallbackProviderTarget(managed);
      if (target && !cardHiddenFromTypist(managed, target, username)) {
        try {
          const accounts = await deps.listProviderAccounts(managed.info.userId);
          const cardIsAvailable = accounts.some(
            (account) =>
              account.provider === provider &&
              account.scope === target.scope &&
              account.canBrowserLogin,
          );
          if (cardIsAvailable) {
            addLogEntry(
              agentId,
              "system",
              msg("systemEntries.alreadySignedIn", {
                provider: providerDisplayName(provider),
              }),
              { providerLogin: provider },
            );
            return;
          }
        } catch {}
      }
    }
    void emitLoginInstructions(agentId, fallback, username, "login_command");
  }

  function flushPendingFreshRecoveryNotice(
    agentId: string,
    managed: ManagedAgent | undefined,
  ): void {
    if (!managed?.pendingFreshRecoveryNotice) return;
    managed.pendingFreshRecoveryNotice = false;
    addLogEntry(
      agentId,
      "system",
      msg("systemEntries.freshSessionAfterRestoreFailure"),
    );
  }

  // Surface a BackendNotConfiguredError to the user: emit the actionable
  // hint+card, drain any queued sibling-agent messages (with a single summary
  // system entry so they don't vanish silently), then transition state to
  // waiting_for_response.
  //
  // The drain is load-bearing: it prevents the cross-path duplicate where one
  // user send produced two hint+card emissions. The original failure mode was
  // sendMessage's catch emitting once, then calling updateState - which sees
  // the still-queued sibling message and triggers flushQueue, which throws
  // the same BackendNotConfiguredError again, emitting the second hint+card.
  // Draining the queue in the catch zeroes messageQueue.length so updateState's
  // queue-flush trigger short-circuits.
  //
  // We deliberately don't suppress the hint+card on subsequent attempts -
  // every user message that hits a broken backend gets the full actionable
  // message. Member preference: simpler over a terser repeated-failure UX.
  function surfaceBackendNotConfigured(
    agentId: string,
    managed: ManagedAgent,
    err: BackendNotConfiguredError,
  ): void {
    if (err instanceof BackendSignedOutError)
      emitDetectedAuthInstructions(agentId, managed);
    else
      void emitLoginInstructions(agentId, {
        kind: "not_installed",
        cardEligible: false,
        text: err.message,
        commands: err.command ? [err.command] : undefined,
      });
    // The queue is kept (Nil, 2026-10-06: never delete), and held so the
    // idle transition below does not retry the flush in a loop. The next
    // message releases it.
    const queuedCount = managed.messageQueue.length;
    if (queuedCount > 0) {
      if (!managed.backendHold) managed.backendHold = holdQueue(managed);
      addLogEntry(
        agentId,
        "system",
        msgN("systemEntries.queueKept.notConfigured", queuedCount),
      );
    }
    updateState(agentId, "waiting_for_response");
  }

  return {
    detectAgentAuthError,
    signedOutProvider,
    agentIsKnownUnauthenticated,
    agentLoginInstructions,
    emitLoginInstructions,
    emitDetectedAuthInstructions,
    emitLogoutAffordance,
    emitAlreadySignedInAffordance,
    flushPendingFreshRecoveryNotice,
    surfaceBackendNotConfigured,
  };
}
