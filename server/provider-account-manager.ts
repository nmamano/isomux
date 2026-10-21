import { homedir } from "node:os";
import { unlinkSync } from "node:fs";
import type { MemberProviderStatus } from "../shared/contract-shapes.ts";
import { isAbsolute, resolve } from "node:path";
import { managedUserEnvExists, readManagedUserEnv } from "./user-env.ts";
import { listUsers } from "./users.ts";
import {
  buildEnvForUserId,
  buildOfficeEnv,
  envSourceForUserId,
  environmentSourceKeyForUserId,
  readOfficeEnvFile,
} from "./env-loader.ts";
import {
  codexEnvApiKeyWins,
  ISOMUX_CODEX_HOME,
  withIsomuxCodexHome,
} from "./backends/codex/native-bin.ts";
import { CodexAccountClient } from "./backends/codex/account.ts";
import { ClaudeAccountClient } from "./backends/claude/account.ts";
import { isClaudeCloudSelected } from "./backends/claude-install-check.ts";
import type { HandlerErrorStatus } from "./routes/executor.ts";
import type {
  EnvVariableSource,
  ProviderAccountProvider,
  ProviderAccountScope,
  ProviderAccountWire,
  ProviderLoginStartRes,
} from "../shared/types.ts";
import {
  activatePersonalProvider,
  deactivatePersonalProvider,
  ensurePersonalProviderHome,
  isPersonalProviderActive,
  personalProviderHome,
} from "./provider-homes.ts";
import { memberUsageCap } from "./member-usage-cap.ts";
import { clearClaudeConnectors } from "./claude-connectors.ts";
import { getAgentHost } from "./agent-host.ts";

export const CLAUDE_CONFIG_INVALID =
  "CLAUDE_CONFIG_DIR must be an absolute directory.";
export const CODEX_HOME_INVALID = "CODEX_HOME must be an absolute directory.";
const ACCOUNT_STATUS_TTL_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
// Five isolated probes per provider on 2026-09-16 took 648-2,609 ms for Codex
// and 1,007-1,295 ms for Claude. This is about 5.7x the slowest healthy probe.
const ACCOUNT_STATUS_TIMEOUT_MS = 15_000;

type ScheduleAccountStatusTimeout = (onTimeout: () => void) => () => void;
const PROBE_TIMED_OUT = Symbol("probeTimedOut");
type ProbedAccountWire = ProviderAccountWire & {
  [PROBE_TIMED_OUT]?: true;
};
// Keep the message empty: probe() exposes Error.message on the wire, and the
// card would otherwise render uncatalogued server English.
class AccountStatusTimeout extends Error {}

export interface ProviderAccountReadOptions {
  provider: ProviderAccountProvider;
  scope: ProviderAccountScope;
  refresh: true;
  signal: AbortSignal;
}

type AccountClient = CodexAccountClient | ClaudeAccountClient;

export type CreateCodexAccountClient = (
  env?: Record<string, string | undefined>,
) => CodexAccountClient;
export type CreateClaudeAccountClient = (
  env?: Record<string, string | undefined>,
) => ClaudeAccountClient;
type Target = {
  provider: ProviderAccountProvider;
  scope: ProviderAccountScope;
  key: string;
  dir: string;
  shared: boolean;
  env: Record<string, string | undefined>;
  autoPersonal?: boolean;
  externalCli: boolean;
  explicitDirectory: boolean;
};

export type EffectiveProviderAccountTarget = Pick<
  Target,
  "provider" | "scope" | "dir"
>;

export function effectiveProviderDirectory(
  provider: ProviderAccountProvider,
  env: Record<string, string | undefined>,
): string {
  return provider === "claude"
    ? resolve(
        env.CLAUDE_CONFIG_DIR?.trim() ||
          resolve(getAgentHost().home(), ".claude"),
      )
    : resolve(withIsomuxCodexHome(env).CODEX_HOME ?? ISOMUX_CODEX_HOME);
}
type LoginStartOutcome =
  | { ok: true; value: ProviderLoginStartRes }
  | {
      ok: false;
      status: HandlerErrorStatus;
      code: string;
      message?: string;
      detail?: Record<string, unknown>;
    };

// A login holds its directory from the first call to startLogin: while it is
// "starting" it waits for running probes and has no client or URL yet.
type Active = {
  userId: string;
  holderName: string;
  startedAt: number;
  target: Target;
  cacheKey: string;
  wire: ProviderAccountWire;
} & (
  | { phase: "starting"; started: Promise<LoginStartOutcome> }
  | {
      phase: "started";
      client: AccountClient;
      loginId?: string;
      authUrl: string;
      userCode?: string;
    }
);

export class ProviderAccountManager {
  private active = new Map<string, Active>();
  private statusCache = new Map<
    string,
    { checkedAt: number; wire: ProviderAccountWire }
  >();
  private probes = new Map<string, Promise<ProviderAccountWire>>();
  // Running probes per directory (target.key), for startLogin to wait on.
  private inflight = new Map<string, Set<Promise<unknown>>>();
  private cacheGenerations = new Map<string, number>();
  // Told when a sign-in or sign-out changes the account at `dir`. The office
  // points it at the agent manager.
  onAccountChanged: (provider: ProviderAccountProvider, dir: string) => void =
    () => {};

  constructor(
    private readonly emit: (
      userId: string,
      accounts: ProviderAccountWire[],
    ) => void,
    private readonly createCodex: CreateCodexAccountClient = (env) =>
      new CodexAccountClient(env),
    private readonly loginTimeoutMs = LOGIN_TIMEOUT_MS,
    private readonly environmentKeyForUser: (
      userId: string,
    ) => string = environmentSourceKeyForUserId,
    private readonly envForUser: (
      userId: string,
    ) => Record<string, string | undefined> | undefined = buildEnvForUserId,
    private readonly createClaude: CreateClaudeAccountClient = (env) =>
      new ClaudeAccountClient(env),
    private readonly officeEnv: () => Record<
      string,
      string | undefined
    > = buildOfficeEnv,
    private readonly officeFileEnv: () => Record<
      string,
      string
    > = readOfficeEnvFile,
    private readonly userEnv: (userId: string) => Record<string, string> = (
      userId,
    ) =>
      managedUserEnvExists(userId) ? (readManagedUserEnv(userId) ?? {}) : {},
    private readonly users: () => Array<{
      id: string;
      name?: string;
    }> = listUsers,
    private readonly personalHome: typeof personalProviderHome = personalProviderHome,
    private readonly ensurePersonalHome: typeof ensurePersonalProviderHome = ensurePersonalProviderHome,
    private readonly personalActive: typeof isPersonalProviderActive = isPersonalProviderActive,
    private readonly activatePersonal: typeof activatePersonalProvider = activatePersonalProvider,
    private readonly deactivatePersonal: typeof deactivatePersonalProvider = deactivatePersonalProvider,
    private readonly scheduleAccountStatusTimeout: ScheduleAccountStatusTimeout = (
      onTimeout,
    ) => {
      const timer = setTimeout(onTimeout, ACCOUNT_STATUS_TIMEOUT_MS);
      return () => clearTimeout(timer);
    },
    // Where the member's agents get OPENAI_API_KEY. Read on every read,
    // never cached.
    private readonly apiKeySource: (
      userId: string,
    ) => EnvVariableSource | null = (userId) =>
      envSourceForUserId(userId, "OPENAI_API_KEY"),
  ) {}

  private userOnlyEnv(userId: string): Record<string, string> {
    return this.userEnv(userId);
  }

  effectiveTarget(
    userId: string,
    provider: ProviderAccountProvider,
  ): EffectiveProviderAccountTarget {
    const office = this.target(userId, provider, "office");
    const env = this.envForUser(userId) ?? getAgentHost().baseEnv();
    if (provider === "claude" && isClaudeCloudSelected(env)) {
      const target = isClaudeCloudSelected(this.userOnlyEnv(userId))
        ? this.target(userId, provider, "personal")
        : office;
      return { provider, scope: target.scope, dir: target.dir };
    }
    const effectiveDir = effectiveProviderDirectory(provider, env);
    if (effectiveDir === resolve(office.dir)) {
      return { provider, scope: "office", dir: effectiveDir };
    }
    const personal = this.target(userId, provider, "personal");
    if (effectiveDir !== resolve(personal.dir)) {
      throw new Error(
        `Cannot map the active ${provider} directory to a scope.`,
      );
    }
    return {
      provider,
      scope: "personal",
      dir: effectiveDir,
    };
  }

  // The directory whose claude.ai connectors a scope's Claude sign-in carries,
  // for the integrations list. Null when the scope cannot be resolved (a
  // collision) or runs on Bedrock or Vertex, which has no claude.ai login.
  claudeConnectorDir(
    userId: string,
    scope: ProviderAccountScope,
  ): string | null {
    let target: Target;
    try {
      target = this.target(userId, "claude", scope);
    } catch {
      return null;
    }
    return isClaudeCloudSelected(target.env) ? null : resolve(target.dir);
  }

  // The Claude config directory of a scope's sign-in for this member, cloud
  // or not: Claude's own settings live there. Null when the scope has none.
  claudeConfigDir(userId: string, scope: ProviderAccountScope): string | null {
    try {
      return resolve(this.target(userId, "claude", scope).dir);
    } catch {
      return null;
    }
  }

  private normalizePersonal(
    value: string | undefined,
    invalid: string,
  ): string {
    const trimmed = value?.trim();
    if (!trimmed || !isAbsolute(trimmed)) throw new Error(invalid);
    return resolve(trimmed);
  }

  private collision(
    provider: ProviderAccountProvider,
    kind: "office" | "member" | "external",
  ): Error {
    const variable = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    const name = provider === "claude" ? "Claude" : "Codex";
    const target =
      kind === "office"
        ? `the office ${name} account directory`
        : kind === "member"
          ? `another member's ${name} account directory`
          : `the box's external ${name} CLI directory`;
    return new Error(
      `${variable} collides with ${target}. Choose a different directory.`,
    );
  }

  private target(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
  ): Target {
    const own = this.userOnlyEnv(userId);
    const officeEnv = this.officeEnv();
    if (provider === "codex") {
      const officeDir = resolve(
        withIsomuxCodexHome(officeEnv).CODEX_HOME ?? ISOMUX_CODEX_HOME,
      );
      if (scope === "office") {
        return {
          provider,
          scope,
          key: `codex:${officeDir}`,
          dir: officeDir,
          shared: this.users().length > 1,
          env: {
            ...(this.envForUser(userId) ?? getAgentHost().baseEnv()),
            CODEX_HOME: officeDir,
          },
          externalCli: officeDir === resolve(homedir(), ".codex"),
          explicitDirectory: false,
        };
      }
      const explicit = own.CODEX_HOME?.trim();
      const autoPersonal = !explicit;
      const dir = explicit
        ? this.normalizePersonal(explicit, CODEX_HOME_INVALID)
        : resolve(this.personalHome(userId, "codex"));
      if (explicit && dir === officeDir)
        throw this.collision("codex", "office");
      if (explicit && dir === resolve(ISOMUX_CODEX_HOME))
        throw this.collision("codex", "office");
      if (explicit && dir === resolve(homedir(), ".codex"))
        throw this.collision("codex", "external");
      const officeValue = this.officeFileEnv().CODEX_HOME?.trim();
      if (explicit && officeValue && resolve(officeValue) === dir)
        throw this.collision("codex", "office");
      const processValue = process.env.CODEX_HOME?.trim();
      if (explicit && processValue && resolve(processValue) === dir)
        throw this.collision("codex", "office");
      for (const other of this.users()) {
        if (other.id === userId) continue;
        const otherValue = this.userOnlyEnv(other.id).CODEX_HOME?.trim();
        if (otherValue && isAbsolute(otherValue) && resolve(otherValue) === dir)
          throw this.collision("codex", "member");
        if (resolve(this.personalHome(other.id, "codex")) === dir)
          throw this.collision("codex", "member");
      }
      return {
        provider,
        scope,
        key: `codex:${dir}`,
        dir,
        shared: false,
        env: {
          ...(this.envForUser(userId) ?? getAgentHost().baseEnv()),
          CODEX_HOME: dir,
        },
        autoPersonal,
        externalCli: false,
        explicitDirectory: Boolean(explicit),
      };
    }

    const officeDir = resolve(
      officeEnv.CLAUDE_CONFIG_DIR?.trim() || resolve(homedir(), ".claude"),
    );
    if (scope === "office") {
      return {
        provider,
        scope,
        key: `claude:${officeDir}`,
        dir: officeDir,
        shared: this.users().length > 1,
        env: { ...officeEnv, CLAUDE_CONFIG_DIR: officeDir },
        externalCli: officeDir === resolve(homedir(), ".claude"),
        explicitDirectory: false,
      };
    }

    // This is an accident barrier, not hostile-member isolation. Comparisons
    // are lexical; authenticated members already have shell-equivalent access.
    const explicit = own.CLAUDE_CONFIG_DIR?.trim();
    const autoPersonal = !explicit;
    const dir = explicit
      ? this.normalizePersonal(explicit, CLAUDE_CONFIG_INVALID)
      : resolve(this.personalHome(userId, "claude"));
    if (explicit && dir === resolve(homedir(), ".claude"))
      throw this.collision("claude", "external");
    if (explicit && dir === officeDir) throw this.collision("claude", "office");
    const officeValue = this.officeFileEnv().CLAUDE_CONFIG_DIR?.trim();
    if (explicit && officeValue && resolve(officeValue) === dir)
      throw this.collision("claude", "office");
    const processValue = process.env.CLAUDE_CONFIG_DIR?.trim();
    if (explicit && processValue && resolve(processValue) === dir)
      throw this.collision("claude", "office");
    for (const other of this.users()) {
      if (other.id === userId) continue;
      const otherValue = this.userOnlyEnv(other.id).CLAUDE_CONFIG_DIR?.trim();
      if (explicit && otherValue && resolve(otherValue) === dir)
        throw this.collision("claude", "member");
      if (explicit && resolve(this.personalHome(other.id, "claude")) === dir)
        throw this.collision("claude", "member");
    }
    return {
      provider,
      scope,
      key: `claude:${dir}`,
      dir,
      shared: false,
      env: {
        ...(this.envForUser(userId) ?? getAgentHost().baseEnv()),
        CLAUDE_CONFIG_DIR: dir,
        // This card measures the member's connection, like its personal home.
        // Office cloud selection belongs to the office card.
        CLAUDE_CODE_USE_BEDROCK: own.CLAUDE_CODE_USE_BEDROCK ?? "",
        CLAUDE_CODE_USE_VERTEX: own.CLAUDE_CODE_USE_VERTEX ?? "",
      },
      autoPersonal,
      externalCli: false,
      explicitDirectory: Boolean(explicit),
    };
  }

  async list(
    userId: string,
    refresh = false,
    selection?: ProviderAccountReadOptions,
  ): Promise<ProviderAccountWire[]> {
    const pairs: Array<[ProviderAccountProvider, ProviderAccountScope]> = [
      ["codex", "office"],
      ["codex", "personal"],
      ["claude", "office"],
      ["claude", "personal"],
    ];
    const wires = await Promise.all(
      pairs
        .filter(
          ([provider, scope]) =>
            !selection ||
            (provider === selection.provider && scope === selection.scope),
        )
        .map(([provider, scope]) =>
          this.wireFor(userId, provider, scope, refresh, selection?.signal),
        ),
    );
    return this.withApiKeySource(userId, wires);
  }

  // The viewer's OPENAI_API_KEY source on each Codex wire, read now: a
  // cached or queued wire may carry another read's or member's. Only when
  // the key is what the viewer's agents use, i.e. their CODEX_HOME holds no
  // stored sign-in.
  private async withApiKeySource(
    userId: string,
    wires: ProviderAccountWire[],
  ): Promise<ProviderAccountWire[]> {
    let source: EnvVariableSource | null;
    try {
      source = this.apiKeySource(userId);
      if (
        source &&
        !(await codexEnvApiKeyWins(
          this.envForUser(userId) ?? getAgentHost().baseEnv(),
        ))
      )
        source = null;
    } catch {
      // An env file waiting for import: the wires say so on their own.
      source = null;
    }
    return wires.map((wire) => {
      if (wire.provider !== "codex") return wire;
      const next = { ...wire };
      delete next.apiKeySource;
      if (source) next.apiKeySource = source;
      return next;
    });
  }

  // Assemble an existing full snapshot without starting unrelated providers.
  // If any scope is still unknown, leave the browser's current snapshot alone.
  async cachedList(
    userId: string,
    fresh: ProviderAccountWire[] = [],
  ): Promise<ProviderAccountWire[] | null> {
    const accounts: ProviderAccountWire[] = [];
    for (const provider of ["codex", "claude"] as const) {
      for (const scope of ["office", "personal"] as const) {
        let target: Target;
        try {
          target = this.target(userId, provider, scope);
        } catch {
          return null;
        }
        if (
          scope === "personal" &&
          target.autoPersonal &&
          !this.personalActive(userId, provider) &&
          !(provider === "claude" && isClaudeCloudSelected(target.env))
        ) {
          accounts.push(this.inactivePersonal(target));
          continue;
        }
        const running = this.active.get(target.key);
        const cached = this.statusCache.get(this.cacheKey(userId, target));
        const wire =
          running?.userId === userId
            ? running.wire
            : running
              ? this.queuedWire(running)
              : cached && Date.now() - cached.checkedAt < ACCOUNT_STATUS_TTL_MS
                ? cached.wire
                : null;
        const refreshed = fresh.find(
          (value) => value.provider === provider && value.scope === scope,
        );
        if (!wire && !refreshed) return null;
        accounts.push(
          refreshed
            ? {
                ...refreshed,
                loginStatus:
                  running?.userId === userId
                    ? running.wire.loginStatus
                    : refreshed.loginStatus,
              }
            : wire!,
        );
      }
    }
    return this.withApiKeySource(userId, accounts);
  }

  private inactivePersonal(target: Target): ProviderAccountWire {
    return {
      provider: target.provider,
      scope: target.scope,
      accountStatus: "not_connected",
      loginStatus: "idle",
      shared: false,
      canBrowserLogin: true,
      externalCli: target.externalCli,
      explicitDirectory: target.explicitDirectory,
    };
  }

  private queuedWire(active: Active): ProviderAccountWire {
    return {
      ...active.wire,
      loginQueue: {
        holderName: active.holderName,
        startedAt: active.startedAt,
      },
    };
  }

  // Reuse personal resolution and its cache, but expose no account metadata.
  async memberStatuses(userId: string): Promise<MemberProviderStatus[]> {
    return Promise.all(
      (["claude", "codex"] as const).map(async (provider) => {
        // A rejected probe maps to unknown like an unavailable one: one
        // provider failing never drops the other provider or the names.
        let wire: ProviderAccountWire;
        try {
          wire = await this.wireFor(userId, provider, "personal", false);
        } catch {
          return { provider, status: "unknown" as const };
        }
        return {
          provider,
          status:
            wire.accountStatus === "unavailable"
              ? "unknown"
              : wire.accountStatus,
        };
      }),
    );
  }

  private async wireFor(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
    refresh: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderAccountWire> {
    let target: Target;
    try {
      target = this.target(userId, provider, scope);
    } catch (err) {
      return {
        provider,
        scope,
        accountStatus: "unavailable",
        loginStatus: "idle",
        shared: false,
        canBrowserLogin: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (
      scope === "personal" &&
      target.autoPersonal &&
      !this.personalActive(userId, provider) &&
      !(provider === "claude" && isClaudeCloudSelected(target.env))
    ) {
      return this.inactivePersonal(target);
    }
    const running = this.active.get(target.key);
    if (running && running.userId !== userId) return this.queuedWire(running);
    // No read starts a second Claude or Codex process on a directory whose
    // login is running.
    if (running) return running.wire;
    const cacheKey = this.cacheKey(userId, target);
    const cacheGeneration = refresh
      ? (this.cacheGenerations.get(cacheKey) ?? 0) + 1
      : (this.cacheGenerations.get(cacheKey) ?? 0);
    if (refresh) this.cacheGenerations.set(cacheKey, cacheGeneration);
    const cached = this.statusCache.get(cacheKey);
    if (
      !refresh &&
      cached &&
      Date.now() - cached.checkedAt < ACCOUNT_STATUS_TTL_MS
    )
      return cached.wire;
    let probe = refresh ? undefined : this.probes.get(cacheKey);
    if (!probe && !refresh) {
      probe = this.probe(target).finally(() => this.probes.delete(cacheKey));
      this.probes.set(cacheKey, probe);
    }
    probe ??= this.probe(target, signal);
    const wire = (await probe) as ProbedAccountWire;
    if (signal?.aborted) return wire;
    if (wire[PROBE_TIMED_OUT]) return wire;
    if ((this.cacheGenerations.get(cacheKey) ?? 0) === cacheGeneration) {
      this.statusCache.set(cacheKey, { checkedAt: Date.now(), wire });
      return wire;
    }
    // A full-list read started before this scope's forced refresh must not
    // publish its older result after the refreshed snapshot.
    return this.statusCache.get(cacheKey)?.wire ?? wire;
  }

  private cacheKey(userId: string, target: Target): string {
    return `${target.key}:${target.scope}:${this.environmentKeyForUser(userId)}`;
  }

  private probe(
    target: Target,
    signal?: AbortSignal,
  ): Promise<ProviderAccountWire> {
    const running = this.probeOnce(target, signal);
    let onDirectory = this.inflight.get(target.key);
    if (!onDirectory) {
      onDirectory = new Set();
      this.inflight.set(target.key, onDirectory);
    }
    const tracked = onDirectory;
    tracked.add(running);
    const done = () => {
      tracked.delete(running);
      if (tracked.size === 0 && this.inflight.get(target.key) === tracked)
        this.inflight.delete(target.key);
    };
    running.then(done, done);
    return running;
  }

  private async probeOnce(
    target: Target,
    signal?: AbortSignal,
  ): Promise<ProviderAccountWire> {
    let client: AccountClient | null = null;
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!client) return Promise.resolve();
      return (closed ??= client.close());
    };
    let onAbort: (() => void) | undefined;
    let cancelTimeout = () => {};
    try {
      signal?.throwIfAborted();
      client = this.clientFor(target);
      // A factory can abort synchronously; close the returned client too.
      signal?.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        onAbort = () => {
          void close().catch(() => {});
          reject(new Error("Account check cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const read = async () => {
        await client!.start();
        signal?.throwIfAborted();
        return client!.read();
      };
      const timedOut = new Promise<never>((_resolve, reject) => {
        cancelTimeout = this.scheduleAccountStatusTimeout(() => {
          void close().catch(() => {});
          reject(new AccountStatusTimeout());
        });
      });
      const status = await Promise.race([read(), cancelled, timedOut]);
      signal?.throwIfAborted();
      const wire: ProbedAccountWire = {
        provider: target.provider,
        scope: target.scope,
        accountStatus: status.connected ? "connected" : "not_connected",
        loginStatus: "idle",
        accountLabel: status.label,
        shared: target.shared,
        canBrowserLogin: true,
        externalCli: target.externalCli,
        explicitDirectory: target.explicitDirectory,
      };
      return wire;
    } catch (err) {
      const timedOut = err instanceof AccountStatusTimeout;
      const wire: ProbedAccountWire = {
        provider: target.provider,
        scope: target.scope,
        accountStatus: "unavailable",
        loginStatus: "idle",
        shared: target.shared,
        canBrowserLogin: timedOut,
        externalCli: target.externalCli,
        explicitDirectory: target.explicitDirectory,
        error: err instanceof Error ? err.message : String(err),
      };
      if (timedOut) wire[PROBE_TIMED_OUT] = true;
      return wire;
    } finally {
      cancelTimeout();
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      await close();
    }
  }

  async startLogin(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
    method: "browser" | "device",
  ): Promise<LoginStartOutcome> {
    let target: Target;
    try {
      target = this.target(userId, provider, scope);
    } catch (err) {
      return this.failure(422, "browser_login_unavailable", err);
    }
    if (target.autoPersonal) this.ensurePersonalHome(userId, provider);
    const existing = this.active.get(target.key);
    if (existing && existing.userId !== userId)
      return {
        ok: false,
        status: 409,
        code: "shared_login_in_progress",
        detail: {
          holderName: existing.holderName,
          startedAt: existing.startedAt,
        },
      };
    // A second start by the same member shares the first one's outcome.
    if (existing?.phase === "starting") return existing.started;
    if (existing)
      return {
        ok: true,
        value: {
          account: (await this.withApiKeySource(userId, [existing.wire]))[0],
          authUrl: existing.authUrl,
          userCode: existing.userCode,
        },
      };
    // Hold the directory before any await, so no probe and no second login
    // starts on it while this one gets going.
    let settle!: (outcome: LoginStartOutcome) => void;
    const reservation: Active = {
      userId,
      holderName:
        this.users().find((user) => user.id === userId)?.name ?? userId,
      startedAt: Date.now(),
      target,
      cacheKey: this.cacheKey(userId, target),
      wire: {
        provider,
        scope,
        accountStatus: "not_connected",
        loginStatus: "waiting_external",
        shared: target.shared,
        canBrowserLogin: true,
        externalCli: target.externalCli,
        explicitDirectory: target.explicitDirectory,
      },
      phase: "starting",
      started: new Promise((resolvePromise) => {
        settle = resolvePromise;
      }),
    };
    this.active.set(target.key, reservation);
    const outcome = await this.runLogin(reservation, method);
    settle(outcome);
    return outcome;
  }

  private async runLogin(
    reservation: Active & { phase: "starting" },
    method: "browser" | "device",
  ): Promise<LoginStartOutcome> {
    const { target } = reservation;
    const key = target.key;
    const cancelled = () =>
      this.failure(409, "login_cancelled", "Sign-in was cancelled.");
    // A probe always settles: ACCOUNT_STATUS_TIMEOUT_MS ends its read and it
    // then closes its client. So this wait has an end.
    await Promise.allSettled([...(this.inflight.get(key) ?? [])]);
    if (this.active.get(key) !== reservation) return cancelled();
    let client: AccountClient | undefined;
    try {
      client = this.clientFor(target);
      await client.start();
      if (this.active.get(key) !== reservation) {
        await client.close();
        return cancelled();
      }
      // Widened annotation: TS narrows `"loginId" in start` on the raw union
      // to `unknown` for the member that lacks the field; both starts are
      // assignable to this shape, so the reads below stay string | undefined.
      const start: { authUrl: string; loginId?: string; userCode?: string } =
        target.provider === "codex"
          ? await (client as CodexAccountClient).login(method)
          : await (client as ClaudeAccountClient).login();
      if (this.active.get(key) !== reservation) {
        await client.close();
        return cancelled();
      }
      const active: Active = {
        userId: reservation.userId,
        holderName: reservation.holderName,
        startedAt: reservation.startedAt,
        target,
        cacheKey: reservation.cacheKey,
        wire: reservation.wire,
        phase: "started",
        client,
        loginId: "loginId" in start ? start.loginId : undefined,
        authUrl: start.authUrl,
        userCode: "userCode" in start ? start.userCode : undefined,
      };
      this.active.set(key, active);
      this.emit(active.userId, await this.list(active.userId));
      void this.finish(key);
      return {
        ok: true,
        value: {
          account: (
            await this.withApiKeySource(active.userId, [active.wire])
          )[0],
          authUrl: start.authUrl,
          userCode: active.userCode,
        },
      };
    } catch (err) {
      if (this.active.get(key) === reservation) this.active.delete(key);
      await client?.close();
      return this.failure(502, "provider_error", err);
    }
  }

  async submitCode(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
    code: string,
  ): Promise<
    | { ok: true; value: { submitted: true } }
    | { ok: false; status: HandlerErrorStatus; code: string; message: string }
  > {
    let target: Target;
    try {
      target = this.target(userId, provider, scope);
    } catch (err) {
      return this.failure(422, "browser_login_unavailable", err);
    }
    const active = this.active.get(target.key);
    if (provider !== "claude" || !active || active.userId !== userId)
      return this.failure(
        409,
        "no_login_in_progress",
        "No sign-in is in progress.",
      );
    if (active.phase === "starting")
      return this.failure(
        409,
        "no_login_in_progress",
        "No sign-in is in progress.",
      );
    try {
      await (active.client as ClaudeAccountClient).submitCode(code);
      return { ok: true, value: { submitted: true } };
    } catch (err) {
      return this.failure(502, "provider_error", err);
    }
  }

  private async finish(key: string): Promise<void> {
    const active = this.active.get(key);
    if (active?.phase !== "started") return;
    try {
      const done = await this.withLoginDeadline(
        active.client.waitForCompletion(),
      );
      if (this.active.get(key) !== active) return;
      let account;
      if (active.target.provider === "claude") {
        // accountInfo() belongs to the query initialization snapshot. Verify
        // the provider-owned credential by opening a fresh query after OAuth.
        await active.client.close();
        const verifier = this.createClaude(active.target.env);
        try {
          await verifier.start();
          account = await verifier.read();
        } finally {
          await verifier.close();
        }
      } else {
        await active.client.close();
        const verifier = this.createCodex(active.target.env);
        try {
          await verifier.start();
          account = await verifier.read();
        } finally {
          await verifier.close();
        }
      }
      const providerSucceeded =
        active.target.provider === "claude" ||
        Boolean((done as { success?: boolean }).success);
      active.wire = {
        ...active.wire,
        accountStatus: account.connected ? "connected" : "not_connected",
        accountLabel: account.label,
        loginStatus:
          providerSucceeded && account.connected ? "succeeded" : "failed",
        error:
          providerSucceeded && account.connected
            ? undefined
            : ((done as { error?: string | null }).error ??
              `${active.target.provider === "codex" ? "Codex" : "Claude"} did not report a connected account.`),
      };
      if (
        active.target.scope === "personal" &&
        active.target.autoPersonal &&
        providerSucceeded &&
        account.connected
      ) {
        this.activatePersonal(active.userId, active.target.provider);
      }
      this.statusCache.set(active.cacheKey, {
        checkedAt: Date.now(),
        wire: active.wire,
      });
      // The office may now be a different account: drop the cap's reading.
      if (active.target.scope === "office")
        memberUsageCap().invalidate(active.target.provider);
      if (active.target.provider === "claude")
        clearClaudeConnectors(active.target.dir);
      this.onAccountChanged(active.target.provider, active.target.dir);
      this.emit(active.userId, await this.list(active.userId));
    } catch (err) {
      if (this.active.get(key) === active) {
        active.wire = {
          ...active.wire,
          loginStatus: "interrupted",
          error:
            err instanceof Error
              ? err.message
              : "Sign-in was interrupted. Start again.",
        };
        this.emit(active.userId, await this.list(active.userId));
      }
    } finally {
      if (this.active.get(key) === active) this.active.delete(key);
      await active.client.close();
    }
  }

  private withLoginDeadline<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Sign-in timed out. Start again.")),
        this.loginTimeoutMs,
      );
      timer.unref?.();
      promise.then(resolvePromise, reject).finally(() => clearTimeout(timer));
    });
  }

  async cancel(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
    allowForeign = false,
  ): Promise<boolean> {
    const target = this.target(userId, provider, scope);
    const active = this.active.get(target.key);
    if (
      !active ||
      (active.userId !== userId &&
        !(allowForeign && active.target.scope === "office"))
    )
      return false;
    this.active.delete(target.key);
    const publish = async () => {
      this.emit(userId, await this.list(userId));
      if (active.userId !== userId)
        this.emit(active.userId, await this.list(active.userId));
    };
    if (active.phase === "starting") {
      // The start sees its reservation gone and closes its own client. The
      // list may probe the directory, so it waits until that client is closed.
      void active.started.then(publish).catch(() => {});
      return true;
    }
    if (provider === "codex" && active.loginId)
      await (active.client as CodexAccountClient)
        .cancel(active.loginId)
        .catch(() => {});
    await active.client.close();
    await publish();
    return true;
  }

  async disconnect(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
  ): Promise<
    | { ok: true; value: { accounts: ProviderAccountWire[] } }
    | { ok: false; status: HandlerErrorStatus; code: string; message: string }
  > {
    let target: Target;
    try {
      target = this.target(userId, provider, scope);
    } catch (err) {
      return this.failure(422, "disconnect_unavailable", err);
    }
    if (this.active.has(target.key))
      return this.failure(
        409,
        "login_in_progress",
        "A sign-in is already in progress. Cancel it before signing out.",
      );

    let client: AccountClient | null = null;
    try {
      if (provider === "codex") {
        client = this.createCodex(target.env);
        await client.start();
        await client.logout();
        const account = await client.read();
        if (account.connected)
          throw new Error("Codex still reports a connected account.");
      } else {
        try {
          unlinkSync(resolve(target.dir, ".credentials.json"));
        } catch (err) {
          if (
            !err ||
            typeof err !== "object" ||
            !("code" in err) ||
            err.code !== "ENOENT"
          )
            throw err;
        }
        client = this.createClaude(target.env);
        await client.start();
        const account = await client.read();
        if (account.connected)
          throw new Error("Claude still reports a connected account.");
      }
    } catch (err) {
      return this.failure(502, "provider_error", err);
    } finally {
      await client?.close();
    }

    if (scope === "personal" && target.autoPersonal)
      this.deactivatePersonal(userId, provider);
    if (scope === "office") memberUsageCap().invalidate(provider);
    if (provider === "claude") clearClaudeConnectors(target.dir);
    this.onAccountChanged(provider, target.dir);

    const affectedUsers = scope === "office" ? this.users() : [{ id: userId }];
    const prefix = `${target.key}:${scope}:`;
    for (const key of this.statusCache.keys())
      if (key.startsWith(prefix)) this.statusCache.delete(key);

    let actorAccounts: ProviderAccountWire[] = [];
    for (const affected of affectedUsers) {
      const accounts = await this.list(affected.id, true);
      this.emit(affected.id, accounts);
      if (affected.id === userId) actorAccounts = accounts;
    }
    return { ok: true, value: { accounts: actorAccounts } };
  }

  private clientFor(target: Target): AccountClient {
    return target.provider === "codex"
      ? this.createCodex(target.env)
      : this.createClaude(target.env);
  }

  private failure(
    status: HandlerErrorStatus,
    code: string,
    value: unknown,
  ): { ok: false; status: HandlerErrorStatus; code: string; message: string } {
    return {
      ok: false,
      status,
      code,
      message: value instanceof Error ? value.message : String(value),
    };
  }
}
