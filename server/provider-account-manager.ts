import { homedir } from "node:os";
import { unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readEnvFile } from "./persistence.ts";
import { getUserEnvFileById, listUsers } from "./users.ts";
import {
  buildEnvForUserId,
  buildOfficeEnv,
  environmentSourceKeyForUserId,
  readOfficeEnvFile,
} from "./env-loader.ts";
import {
  ISOMUX_CODEX_HOME,
  withIsomuxCodexHome,
} from "./backends/codex/native-bin.ts";
import { CodexAccountClient } from "./backends/codex/account.ts";
import { ClaudeAccountClient } from "./backends/claude/account.ts";
import type { HandlerErrorStatus } from "./routes/executor.ts";
import type {
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

export const CLAUDE_CONFIG_INVALID =
  "CLAUDE_CONFIG_DIR must be an absolute directory.";
export const CODEX_HOME_INVALID = "CODEX_HOME must be an absolute directory.";
const ACCOUNT_STATUS_TTL_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

type AccountClient = CodexAccountClient | ClaudeAccountClient;
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
type Active = {
  userId: string;
  target: Target;
  cacheKey: string;
  client: AccountClient;
  loginId?: string;
  authUrl: string;
  userCode?: string;
  wire: ProviderAccountWire;
};

export class ProviderAccountManager {
  private active = new Map<string, Active>();
  private statusCache = new Map<
    string,
    { checkedAt: number; wire: ProviderAccountWire }
  >();
  private probes = new Map<string, Promise<ProviderAccountWire>>();
  private cacheGenerations = new Map<string, number>();

  constructor(
    private readonly emit: (
      userId: string,
      accounts: ProviderAccountWire[],
    ) => void,
    private readonly createCodex: (
      env?: Record<string, string | undefined>,
    ) => CodexAccountClient = (env) => new CodexAccountClient(env),
    private readonly loginTimeoutMs = LOGIN_TIMEOUT_MS,
    private readonly environmentKeyForUser: (
      userId: string,
    ) => string = environmentSourceKeyForUserId,
    private readonly envForUser: (
      userId: string,
    ) => Record<string, string | undefined> | undefined = buildEnvForUserId,
    private readonly createClaude: (
      env?: Record<string, string | undefined>,
    ) => ClaudeAccountClient = (env) => new ClaudeAccountClient(env),
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
    ) => {
      const file = getUserEnvFileById(userId);
      return file ? readEnvFile(file) : {};
    },
    private readonly users: () => Array<{ id: string }> = listUsers,
    private readonly personalHome: typeof personalProviderHome = personalProviderHome,
    private readonly ensurePersonalHome: typeof ensurePersonalProviderHome = ensurePersonalProviderHome,
    private readonly personalActive: typeof isPersonalProviderActive = isPersonalProviderActive,
    private readonly activatePersonal: typeof activatePersonalProvider = activatePersonalProvider,
    private readonly deactivatePersonal: typeof deactivatePersonalProvider = deactivatePersonalProvider,
  ) {}

  private userOnlyEnv(userId: string): Record<string, string> {
    return this.userEnv(userId);
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
            ...(this.envForUser(userId) ?? process.env),
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
        env: { ...(this.envForUser(userId) ?? process.env), CODEX_HOME: dir },
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
        ...(this.envForUser(userId) ?? process.env),
        CLAUDE_CONFIG_DIR: dir,
      },
      autoPersonal,
      externalCli: false,
      explicitDirectory: Boolean(explicit),
    };
  }

  async list(userId: string, refresh = false): Promise<ProviderAccountWire[]> {
    const pairs: Array<[ProviderAccountProvider, ProviderAccountScope]> = [
      ["codex", "office"],
      ["codex", "personal"],
      ["claude", "office"],
      ["claude", "personal"],
    ];
    return Promise.all(
      pairs.map(([provider, scope]) =>
        this.wireFor(userId, provider, scope, refresh),
      ),
    );
  }

  private async wireFor(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
    refresh: boolean,
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
        fallbackToTerminal: provider === "claude",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (
      scope === "personal" &&
      target.autoPersonal &&
      !this.personalActive(userId, provider)
    ) {
      return {
        provider,
        scope,
        accountStatus: "not_connected",
        loginStatus: "idle",
        shared: false,
        canBrowserLogin: true,
        externalCli: target.externalCli,
        explicitDirectory: target.explicitDirectory,
      };
    }
    const running = this.active.get(target.key);
    if (running?.userId === userId) return running.wire;
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
    probe ??= this.probe(target);
    const wire = await probe;
    if ((this.cacheGenerations.get(cacheKey) ?? 0) === cacheGeneration)
      this.statusCache.set(cacheKey, { checkedAt: Date.now(), wire });
    return wire;
  }

  private cacheKey(userId: string, target: Target): string {
    return `${target.key}:${target.scope}:${this.environmentKeyForUser(userId)}`;
  }

  private async probe(target: Target): Promise<ProviderAccountWire> {
    let client: AccountClient | null = null;
    try {
      client = this.clientFor(target);
      await client.start();
      const status = await client.read();
      return {
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
    } catch (err) {
      return {
        provider: target.provider,
        scope: target.scope,
        accountStatus: "unavailable",
        loginStatus: "idle",
        shared: target.shared,
        canBrowserLogin: false,
        fallbackToTerminal: true,
        externalCli: target.externalCli,
        explicitDirectory: target.explicitDirectory,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await client?.close();
    }
  }

  async startLogin(
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
    method: "browser" | "device",
  ): Promise<
    | { ok: true; value: ProviderLoginStartRes }
    | { ok: false; status: HandlerErrorStatus; code: string; message: string }
  > {
    let target: Target;
    try {
      target = this.target(userId, provider, scope);
    } catch (err) {
      return this.failure(422, "browser_login_unavailable", err);
    }
    if (target.autoPersonal) this.ensurePersonalHome(userId, provider);
    const existing = this.active.get(target.key);
    if (existing)
      return existing.userId === userId
        ? {
            ok: true,
            value: {
              account: existing.wire,
              authUrl: existing.authUrl,
              userCode: existing.userCode,
            },
          }
        : {
            ok: false,
            status: 409,
            code: "shared_login_in_progress",
            message: "Another user is signing in to this shared Codex account.",
          };
    const client = this.clientFor(target);
    try {
      await client.start();
      // Widened annotation: TS narrows `"loginId" in start` on the raw union
      // to `unknown` for the member that lacks the field; both starts are
      // assignable to this shape, so the reads below stay string | undefined.
      const start: { authUrl: string; loginId?: string; userCode?: string } =
        provider === "codex"
          ? await (client as CodexAccountClient).login(method)
          : await (client as ClaudeAccountClient).login();
      const wire: ProviderAccountWire = {
        provider,
        scope,
        accountStatus: "not_connected",
        loginStatus: "waiting_external",
        shared: target.shared,
        canBrowserLogin: true,
        externalCli: target.externalCli,
        explicitDirectory: target.explicitDirectory,
      };
      const active: Active = {
        userId,
        target,
        cacheKey: this.cacheKey(userId, target),
        client,
        loginId: "loginId" in start ? start.loginId : undefined,
        authUrl: start.authUrl,
        userCode: "userCode" in start ? start.userCode : undefined,
        wire,
      };
      this.active.set(target.key, active);
      this.emit(userId, await this.list(userId));
      void this.finish(target.key);
      return {
        ok: true,
        value: {
          account: wire,
          authUrl: start.authUrl,
          userCode: active.userCode,
        },
      };
    } catch (err) {
      await client.close();
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
    try {
      await (active.client as ClaudeAccountClient).submitCode(code);
      return { ok: true, value: { submitted: true } };
    } catch (err) {
      return this.failure(502, "provider_error", err);
    }
  }

  private async finish(key: string): Promise<void> {
    const active = this.active.get(key);
    if (!active) return;
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
  ): Promise<boolean> {
    const target = this.target(userId, provider, scope);
    const active = this.active.get(target.key);
    if (!active || active.userId !== userId) return false;
    this.active.delete(target.key);
    if (provider === "codex" && active.loginId)
      await (active.client as CodexAccountClient)
        .cancel(active.loginId)
        .catch(() => {});
    await active.client.close();
    this.emit(userId, await this.list(userId));
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
