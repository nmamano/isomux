// The environment of each agent's sessions and the fallback to the office
// sign-in (server/provider-fallback.ts): which account a session starts on,
// and the account check that moves a conversation at a turn start. Moved out
// of createAgentManager (server/agent-manager.ts), which wires it.
import { resolve } from "path";
import type {
  AgentBackendType,
  Attachment,
  LogEntry,
  QueuedMessage,
} from "../shared/types.ts";
import type { SignIn } from "../shared/contract-shapes.ts";
import type { OfficeState } from "../shared/office-state.ts";
import { errMessage } from "../shared/errors.ts";
import { msg, type LogText } from "../shared/i18n/log-message.ts";
import type { LimitResumeClock, ManagerDeps } from "./agent-manager.ts";
import { providerDisplayName } from "./agent-auth.ts";
import { getAgentHost } from "./agent-host.ts";
import { isClaudeCodeAuthenticated } from "./backends/claude-install-check.ts";
import { isCodexAuthenticated } from "./backends/codex/native-bin.ts";
import type { Backend, BackendSession } from "./backends/types.ts";
import { resolveClaudeSessionRoot } from "./claude-session-root.ts";
import {
  buildEnvForUserId,
  claudeFamilyModelsForUserId,
  environmentSourceKeyForUserId,
  envSourceForUserId,
  limitedClaudeFamiliesForUserId,
} from "./env-loader.ts";
import { getAgentTokenRaw } from "./identity/tokens.ts";
import { prepareRelease } from "./idle-release.ts";
import {
  inMultiStepFlow,
  type AgentEvent,
  type EnqueueResult,
  type ManagedAgent,
} from "./internal-types.ts";
import type { mcpServersForUserId } from "./mcp-servers.ts";
import { officeUsageTarget } from "./member-usage-cap.ts";
import {
  ensureSessionClaudeConfigDir,
  getSessionClaudeConfigDir,
  setSessionClaudeConfigDir,
} from "./persistence.ts";
import { effectiveProviderDirectory } from "./provider-account-manager.ts";
import {
  entryCovers,
  FALLBACK_CONTINUE_TEXT,
  OPENCODE_FALLBACK_RETRY_MS,
  providerFallback,
  type FallbackAccount,
  type FallbackEntry,
  type FallbackFamily,
  type FallbackProvider,
  type ProviderFallback,
} from "./provider-fallback.ts";
import { personalProviderHome } from "./provider-homes.ts";
import type { DormantReason } from "./session-manager.ts";
import {
  codexHomeOfThread,
  copySessionFilesInAgentSpace,
  removeSessionSourceInAgentSpace,
  type SessionMove,
} from "./session-account-move.ts";
import { CREDENTIAL_VARIABLES } from "./usage-account.ts";

export interface SessionAccountsDeps {
  agents: Map<string, ManagedAgent>;
  officeState: OfficeState;
  emit: (event: AgentEvent) => void;
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
  ) => unknown;
  persistAll: () => void;
  getBackend: (agentType: AgentBackendType) => Backend;
  createSession: (
    managed: ManagedAgent,
    resumeSessionId?: string,
  ) => BackendSession;
  pickAutoResumeSessionId: (managed: ManagedAgent) => string | null;
  getAgentDisplay: (
    agentId: string,
  ) => { name: string; roomName: string } | null;
  enqueueMessage: (
    agentId: string,
    msg: {
      sender: QueuedMessage["sender"];
      text: string;
      fallbackContinue?: boolean;
      limitResumeMemberIds?: string[];
    },
  ) => EnqueueResult;
  agentMcpServers: (
    userId: string | null | undefined,
  ) => ReturnType<typeof mcpServersForUserId>;
  buildOpenCodeLaunchEnvironmentForUserId: (
    userId: string | null | undefined,
  ) => { [key: string]: string | undefined } | undefined;
  openCodeEnvironmentRevisionForUserId: (
    userId: string | null | undefined,
  ) => string;
  limitResumeClock: LimitResumeClock;
  providerFallback: ManagerDeps["providerFallback"];
  // Puts the sign-in on the agent's info (server/usage-readings.ts).
  refreshSignIn: (managed: ManagedAgent) => void;
  fallbackOfficeAccount: ManagerDeps["fallbackOfficeAccount"];
  // After the switch installs the new process: what its close carried (an
  // environment change, ended background work) reaches the agent.
  noteSwitchRelease: (managed: ManagedAgent, reason: DormantReason) => void;
}

export function createSessionAccounts(deps: SessionAccountsDeps) {
  const {
    agents,
    officeState,
    emit,
    addLogEntry,
    persistAll,
    getBackend,
    createSession,
    pickAutoResumeSessionId,
    getAgentDisplay,
    enqueueMessage,
    agentMcpServers,
    buildOpenCodeLaunchEnvironmentForUserId,
    openCodeEnvironmentRevisionForUserId,
    limitResumeClock,
  } = deps;

  // Merge process.env with office variables and the agent owner's managed personal variables.
  // User overrides office; office overrides process.env. Spawn-time failure
  // mode: if a configured env file is missing or fails to parse, throw - the
  // caller is responsible for surfacing the error to the agent log.
  //
  // The shared implementation lives in env-loader.ts so cronjob-manager can
  // import it without dragging in agent-manager (which would create an import
  // cycle through command-handlers). The office-env-file provider is registered
  // by createAgentManager (setOfficeEnvFileProvider in server/agent-manager.ts)
  // so env-loader can read its `officeState` without importing it directly.
  function buildSessionEnv(
    managed: ManagedAgent,
    sessionId: string | null = managed.sessionManager.sessionId,
  ): { [key: string]: string | undefined } | undefined {
    const provider = managed.info.agentType;
    let base =
      provider === "opencode"
        ? buildOpenCodeLaunchEnvironmentForUserId(managed.info.userId)
        : buildEnvForUserId(managed.info.userId);
    // On the office sign-in (alignAccount): new sessions start there. A
    // Claude session's pin still wins below, and a Codex thread is looked up
    // in both homes, so a conversation runs where its files are.
    if (provider !== "opencode") {
      const name = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const office = managed.officeFallback ? officeAccountDir(provider) : null;
      if (office)
        base = { ...(base ?? getAgentHost().baseEnv()), [name]: office };
      if (provider === "codex" && sessionId && fallbackInPlay(managed)) {
        const chosen = effectiveProviderDirectory(
          "codex",
          base ?? getAgentHost().baseEnv(),
        );
        const home = codexHomeOfThread(
          sessionId,
          [chosen, ...fallbackHomes(managed)].filter(
            (dir, i, all) => all.indexOf(dir) === i,
          ),
        );
        if (home && home !== chosen)
          base = { ...(base ?? getAgentHost().baseEnv()), CODEX_HOME: home };
      }
    }
    if (provider === "claude" && sessionId) {
      const root = resolveClaudeSessionRoot(
        sessionId,
        managed.info.cwd,
        base,
        getSessionClaudeConfigDir(managed.info.id, sessionId),
        managed.info.userId,
      );
      ensureSessionClaudeConfigDir(managed.info.id, sessionId, root);
      base = { ...(base ?? getAgentHost().baseEnv()), CLAUDE_CONFIG_DIR: root };
    }
    const token = getAgentTokenRaw(managed.info.id);
    if (!token) return base;
    // Inject the agent's own bearer token so its self-affordance /
    // inter-agent message curls authenticate as itself. In-memory secret, never
    // persisted/logged; spread process.env when there's no env-file base so the
    // subprocess keeps PATH/HOME/etc. Redaction tests assert it stays out of
    // prompts, logs, errors, diffs, and the WS.
    return { ...(base ?? getAgentHost().baseEnv()), ISOMUX_AGENT_TOKEN: token };
  }

  // The env of a Claude or Codex one-shot prompt (topic, conversation
  // summary) on `modelFamily`: the office sign-in while the agent's turns
  // run there or the member's fallback covers that family, else the
  // member's own. No agent token: a one-shot has no tools. No session pin:
  // it resumes no conversation. OpenCode one-shots use the member's server,
  // which follows the fallback by itself.
  function oneShotEnv(
    managed: ManagedAgent,
    modelFamily: string,
  ): { [key: string]: string | undefined } | undefined {
    const { userId, agentType: provider } = managed.info;
    const base = buildEnvForUserId(userId);
    if (provider === "opencode") return base;
    const office =
      managed.officeFallback || officeWanted(userId, provider, modelFamily)
        ? officeAccountDir(provider)
        : null;
    if (!office) return base;
    const name = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    return { ...(base ?? getAgentHost().baseEnv()), [name]: office };
  }

  // Fallback to the office sign-in (server/provider-fallback.ts). The state
  // is per member and provider. Each agent follows it at its next turn start
  // (alignAccount), which moves the conversation to the account it wants.
  const fallbackState = (): ProviderFallback =>
    deps.providerFallback ?? providerFallback();

  // The office sign-in a member's agents fall back to, or null when the
  // office has none for the provider.
  function officeFallbackAccount(
    provider: FallbackProvider,
  ): FallbackAccount | null {
    if (deps.fallbackOfficeAccount) return deps.fallbackOfficeAccount(provider);
    try {
      if (provider === "opencode") {
        const source = envSourceForUserId(null, "OPENCODE_API_KEY");
        const key = buildEnvForUserId(null)?.OPENCODE_API_KEY;
        return key &&
          (source === "office_variable" || source === "office_secret")
          ? { apiKey: key }
          : null;
      }
      const target = officeUsageTarget(provider);
      const signedIn =
        provider === "claude"
          ? isClaudeCodeAuthenticated(target.env)
          : isCodexAuthenticated(target.env);
      return signedIn ? { dir: target.dir } : null;
    } catch {
      return null;
    }
  }

  // The office account folder, signed in or not: where an agent on the
  // office sign-in keeps its conversation.
  function officeAccountDir(provider: "claude" | "codex"): string | null {
    if (deps.fallbackOfficeAccount) {
      const account = deps.fallbackOfficeAccount(provider);
      return account && "dir" in account ? account.dir : null;
    }
    try {
      return officeUsageTarget(provider).dir;
    } catch {
      return null;
    }
  }

  // The account the member's agents use without a fallback, and whether it
  // is the member's own sign-in: a personal provider home, or an
  // OPENCODE_API_KEY the member set.
  function ownAccount(
    userId: string | null | undefined,
    provider: FallbackProvider,
  ): { account: FallbackAccount; own: boolean } | null {
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildEnvForUserId(userId);
    } catch {
      return null;
    }
    if (provider === "opencode") {
      const key = env?.OPENCODE_API_KEY;
      if (!key) return null;
      const source = userId
        ? envSourceForUserId(userId, "OPENCODE_API_KEY")
        : null;
      return {
        account: { apiKey: key },
        own: source === "member_variable" || source === "member_secret",
      };
    }
    const dir = effectiveProviderDirectory(
      provider,
      env ?? getAgentHost().baseEnv(),
    );
    let own = false;
    try {
      own =
        !!userId &&
        resolve(dir) === resolve(personalProviderHome(userId, provider));
    } catch {
      own = false;
    }
    return { account: { dir }, own };
  }

  function sameAccount(a: FallbackAccount, b: FallbackAccount): boolean {
    if ("dir" in a && "dir" in b) return resolve(a.dir) === resolve(b.dir);
    if ("apiKey" in a && "apiKey" in b) return a.apiKey === b.apiKey;
    return false;
  }

  // The member's own sign-in and the office's, while a fallback from one to
  // the other can apply: the switch is on, the member's agents run on their
  // own sign-in, and the office has another one.
  function fallbackPair(
    userId: string | null | undefined,
    provider: FallbackProvider,
  ): { member: FallbackAccount; office: FallbackAccount } | null {
    if (!userId || !fallbackState().isEnabled()) return null;
    const own = ownAccount(userId, provider);
    if (!own?.own) return null;
    const office = officeFallbackAccount(provider);
    if (!office || sameAccount(own.account, office)) return null;
    return { member: own.account, office };
  }

  // The fallback the member's sessions on `modelFamily` run on now, or null.
  function officeWanted(
    userId: string | null | undefined,
    provider: FallbackProvider,
    modelFamily: string | undefined,
  ): { office: FallbackAccount; entry: FallbackEntry } | null {
    // The entry first: it is nearly always absent, and the pair reads the
    // member's and the office's env.
    if (!userId || !fallbackState().isEnabled()) return null;
    const entry = fallbackState().entry(userId, provider);
    if (!entry) return null;
    if (provider === "claude" && !entryCovers(entry, modelFamily)) return null;
    const pair = fallbackPair(userId, provider);
    return pair ? { office: pair.office, entry } : null;
  }

  // Whether a Codex thread may be in either home.
  function fallbackInPlay(managed: ManagedAgent): boolean {
    return managed.officeFallback || fallbackState().isEnabled();
  }

  // The homes a Codex thread of the agent can be in, besides the one its
  // env picks.
  function fallbackHomes(managed: ManagedAgent): string[] {
    const own = ownAccount(managed.info.userId, "codex");
    const office = officeAccountDir("codex");
    return [
      ...(own && "dir" in own.account ? [own.account.dir] : []),
      ...(office ? [office] : []),
    ];
  }

  // The account the live session started on.
  function liveAccount(managed: ManagedAgent): FallbackAccount | null {
    if (!managed.sessionManager.session) return null;
    if (managed.info.agentType === "opencode")
      return managed.launchedOpenCodeKey
        ? { apiKey: managed.launchedOpenCodeKey }
        : null;
    if (managed.info.agentType === "claude")
      return managed.launchedClaudeConfigDir
        ? { dir: managed.launchedClaudeConfigDir }
        : null;
    return managed.billingAccount ? { dir: managed.billingAccount.dir } : null;
  }

  // The folder that holds the agent's conversation now, or null when it
  // has none on disk.
  function conversationDir(
    managed: ManagedAgent,
    sessionId: string,
  ): string | null {
    const live = liveAccount(managed);
    const liveDir = live && "dir" in live ? live.dir : undefined;
    if (managed.info.agentType === "claude")
      return (
        getSessionClaudeConfigDir(managed.info.id, sessionId) ?? liveDir ?? null
      );
    const homes = [...(liveDir ? [liveDir] : []), ...fallbackHomes(managed)];
    return codexHomeOfThread(sessionId, homes) ?? liveDir ?? null;
  }

  // Busy work on the live session: it is not replaced for an account check.
  function accountSwitchBlocked(managed: ManagedAgent): boolean {
    const sm = managed.sessionManager;
    return (
      sm.session !== null &&
      (sm.pendingTurn !== null ||
        sm.abortPromise !== null ||
        managed.info.sessionSwapping ||
        inMultiStepFlow(managed))
    );
  }

  // The account check at a turn start, before the turn captures its session
  // (design: task 2008c993). The agent's sessions go to the office sign-in
  // while its member's fallback wants that, and back otherwise. A live
  // session on the other account is closed, the conversation moves, and a
  // new session resumes it there. One chat line at each switch. "failed":
  // the move failed, and the agent stays where it was.
  // null: nothing to check, decided without yielding, so a turn start with
  // no fallback in play keeps its timing.
  const accountChecks = new Map<
    string,
    Promise<"same" | "switched" | "failed">
  >();
  function alignAccount(
    agentId: string,
    managed: ManagedAgent,
  ): Promise<"same" | "switched" | "failed"> | null {
    const running = accountChecks.get(agentId);
    if (running) return running;
    const wanted = officeWanted(
      managed.info.userId,
      managed.info.agentType,
      managed.info.modelFamily,
    );
    if (!wanted && !managed.officeFallback) return null;
    const check = alignAccountNow(agentId, managed, wanted).finally(() =>
      accountChecks.delete(agentId),
    );
    accountChecks.set(agentId, check);
    return check;
  }

  async function alignAccountNow(
    agentId: string,
    managed: ManagedAgent,
    wanted: { office: FallbackAccount; entry: FallbackEntry } | null,
  ): Promise<"same" | "switched" | "failed"> {
    const provider = managed.info.agentType;
    const toOffice = wanted !== null;
    const target =
      wanted?.office ?? ownAccount(managed.info.userId, provider)?.account;
    if (!target) return "same";
    const sm = managed.sessionManager;
    const live = liveAccount(managed);
    const liveMoves =
      sm.session !== null && !(live && sameAccount(live, target));
    if (!liveMoves && managed.officeFallback === toOffice) return "same";
    if (accountSwitchBlocked(managed)) return "same";
    const sessionId = sm.sessionId;
    if (liveMoves)
      await sm.closeAndDrainSession(managed, {
        reason: prepareRelease(managed, "idle"),
      });
    // Claude and Codex keep the conversation in the account folder.
    if (sessionId && "dir" in target && provider !== "opencode") {
      const from = conversationDir(managed, sessionId);
      if (from && resolve(from) !== resolve(target.dir)) {
        const move: SessionMove =
          provider === "claude"
            ? {
                engine: "claude",
                sessionId,
                cwd: managed.info.cwd,
                fromRoot: from,
                toRoot: target.dir,
              }
            : {
                engine: "codex",
                threadId: sessionId,
                fromHome: from,
                toHome: target.dir,
              };
        try {
          await copySessionFilesInAgentSpace(move);
          if (provider === "claude")
            setSessionClaudeConfigDir(agentId, sessionId, target.dir);
        } catch (err) {
          console.error(
            `[provider-fallback] ${agentId}: the conversation stays on its account; its move failed:`,
            errMessage(err),
          );
          if (liveMoves) reinstallAfterAccountCheck(managed);
          return "failed";
        }
        await removeSessionSourceInAgentSpace(move).catch((err: unknown) =>
          console.error(
            `[provider-fallback] ${agentId}: the moved conversation's old files stay:`,
            errMessage(err),
          ),
        );
      }
    }
    if (managed.officeFallback !== toOffice) {
      managed.officeFallback = toOffice;
      // The next send tells the agent. A move back before that send
      // withdraws the notice: the agent never learned it had moved.
      const signIn: SignIn = toOffice ? "office" : "individual";
      managed.signInNotice =
        managed.signInNotice && managed.signInNotice !== signIn ? null : signIn;
      if (agents.get(agentId) === managed) persistAll();
      const providerName = providerDisplayName(provider);
      addLogEntry(
        agentId,
        "system",
        wanted
          ? msg("systemEntries.providerFallback.toOffice", {
              provider: providerName,
              at: { time: wanted.entry.until, shape: "weekdayDateTime" },
              relative: { relative: wanted.entry.until },
            })
          : msg("systemEntries.providerFallback.backToOwn", {
              provider: providerName,
            }),
      );
    }
    // One OpenCode server serves all of the member's OpenCode work: no turn
    // starts until it runs with the key this agent now wants.
    if (provider === "opencode") await awaitOpenCodeServer(managed);
    if (liveMoves) reinstallAfterAccountCheck(managed);
    return "switched";
  }

  async function awaitOpenCodeServer(managed: ManagedAgent): Promise<void> {
    const backend = getBackend("opencode");
    if (!backend.awaitCurrentServer) return;
    const userId = managed.info.userId;
    try {
      await backend.awaitCurrentServer({
        environmentKey: environmentSourceKeyForUserId(userId),
        env: buildOpenCodeLaunchEnvironmentForUserId(userId),
        environmentRevision: openCodeEnvironmentRevisionForUserId(userId),
        mcpServers: agentMcpServers(userId),
      });
    } catch (err) {
      console.error(
        `[provider-fallback] ${managed.info.id}: the OpenCode server did not move to the new key:`,
        errMessage(err),
      );
    }
  }

  // The check closed the live session: the conversation resumes at once,
  // with no wake line unless the close carried an environment change or
  // ended background work (noteSwitchRelease). A failure leaves no session;
  // the wake that follows reports it.
  function reinstallAfterAccountCheck(managed: ManagedAgent): void {
    if (managed.sessionManager.session) return;
    try {
      const sessionId = pickAutoResumeSessionId(managed);
      // Read before installSession moves the slot.
      const reason = managed.sessionManager.releasedReason;
      managed.sessionManager.installSession(
        managed,
        sessionId ? createSession(managed, sessionId) : createSession(managed),
      );
      deps.noteSwitchRelease(managed, reason);
    } catch (err) {
      console.error(
        `[provider-fallback] ${managed.info.id}: no session after the account check:`,
        errMessage(err),
      );
    }
  }

  // The sign-in the agent runs on: its member's own ("individual") or the
  // office's ("office"). Read by GET /api/agents/:id/subscription. A key or
  // token in the env decides first: the CLI uses it over the account folder,
  // and whoever set it pays. Else the live session's account, and with no
  // live account the one the next turn starts on (alignAccount).
  function signInOf(managed: ManagedAgent): SignIn {
    const { userId, agentType: provider, modelFamily } = managed.info;
    if (provider !== "opencode") {
      for (const name of CREDENTIAL_VARIABLES[provider]) {
        let source: ReturnType<typeof envSourceForUserId> = null;
        try {
          source = envSourceForUserId(userId, name);
        } catch {
          source = null;
        }
        if (!source) continue;
        return source === "member_variable" || source === "member_secret"
          ? "individual"
          : "office";
      }
    }
    const own = ownAccount(userId, provider);
    if (!own?.own) return "office";
    const live = liveAccount(managed);
    if (live) return sameAccount(live, own.account) ? "individual" : "office";
    return officeWanted(userId, provider, modelFamily)
      ? "office"
      : "individual";
  }

  // A usage limit stopped the running turn. On the member's own sign-in,
  // with a fallback to go to, the member's entry starts and the turn's end
  // queues the continue (turnFlags.limitStopFallback). On the office
  // sign-in, the resume waits for the earlier of the two resets. Returns the
  // reset time the turn's end arms the resume at, or null.
  function fallbackStop(
    managed: ManagedAgent,
    stop: { resetsAtMs?: number; family?: FallbackFamily },
  ): number | null {
    const today = stop.resetsAtMs ?? null;
    const provider = managed.info.agentType;
    const userId = managed.info.userId;
    const pair = fallbackPair(userId, provider);
    const live = liveAccount(managed);
    if (!pair || !live || !userId) return today;
    if (sameAccount(live, pair.member)) {
      fallbackState().start(userId, provider, {
        until:
          stop.resetsAtMs ??
          limitResumeClock.now() + OPENCODE_FALLBACK_RETRY_MS,
        ...(provider === "claude" && stop.family
          ? { family: stop.family }
          : {}),
      });
      // Her agents on this engine with no live session start their next
      // turn on the office sign-in from now on.
      for (const other of agents.values())
        if (other.info.userId === userId && other.info.agentType === provider)
          deps.refreshSignIn(other);
      managed.turnFlags.limitStopFallback = true;
      return today;
    }
    if (managed.officeFallback && sameAccount(live, pair.office)) {
      const entry = fallbackState().entry(userId, provider);
      if (entry)
        return today === null ? entry.until : Math.min(today, entry.until);
    }
    return today;
  }

  // The turn the fallback continues on the office sign-in. With the
  // agent's resume after a limit off, none: its next turn moves.
  function queueFallbackContinue(agentId: string, managed: ManagedAgent): void {
    if (managed.info.limitResume === false) return;
    const self = getAgentDisplay(agentId);
    if (!self) return;
    const result = enqueueMessage(agentId, {
      sender: {
        kind: "agent",
        agentId,
        agentName: self.name,
        roomName: self.roomName,
      },
      text: FALLBACK_CONTINUE_TEXT,
      fallbackContinue: true,
      limitResumeMemberIds: [...managed.info.turnMemberIds],
    });
    if (!result.ok)
      console.warn(
        `Continue on the office sign-in not queued for ${agentId}: ${result.status} ${result.error}`,
      );
  }

  // Re-derive each agent's limitedClaudeFamilies and claudeFamilyModels after
  // office variables (userId undefined: every agent) or one member's personal
  // variables were saved, and send the agents where either changed.
  function refreshLimitedClaudeFamilies(userId?: string): void {
    for (const [agentId, managed] of agents) {
      if (userId !== undefined && managed.info.userId !== userId) continue;
      const limited = limitedClaudeFamiliesForUserId(managed.info.userId);
      const models = claudeFamilyModelsForUserId(managed.info.userId);
      if (
        (managed.info.limitedClaudeFamilies ?? []).join(",") ===
          limited.join(",") &&
        JSON.stringify(managed.info.claudeFamilyModels ?? {}) ===
          JSON.stringify(models)
      )
        continue;
      for (const event of officeState.updateAgent(agentId, {
        limitedClaudeFamilies: limited,
        claudeFamilyModels: models,
      }))
        emit(event);
    }
  }

  return {
    buildSessionEnv,
    oneShotEnv,
    fallbackState,
    officeWanted,
    alignAccount,
    signInOf,
    fallbackStop,
    queueFallbackContinue,
    refreshLimitedClaudeFamilies,
  };
}
