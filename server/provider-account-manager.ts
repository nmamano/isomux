import { homedir } from "node:os";
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

export const CLAUDE_CONFIG_REFUSAL =
  "Claude sign-in from the browser needs your own Claude config directory. Set CLAUDE_CONFIG_DIR in your env file, and then try again.";
export const CODEX_HOME_REFUSAL =
  "Set your Env File Path in User Settings. In that file, set CODEX_HOME to an absolute directory for Codex. Then return here and refresh.";
const CLAUDE_OFFICE_TERMINAL =
  "To change the office account, sign in from the built-in terminal.";
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
  ) {}

  private userOnlyEnv(userId: string): Record<string, string> {
    return this.userEnv(userId);
  }

  private normalizePersonal(
    value: string | undefined,
    refusal: string,
  ): string {
    const trimmed = value?.trim();
    if (!trimmed || !isAbsolute(trimmed)) throw new Error(refusal);
    return resolve(trimmed);
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
        };
      }
      const dir = this.normalizePersonal(own.CODEX_HOME, CODEX_HOME_REFUSAL);
      if (dir === officeDir) throw new Error(CODEX_HOME_REFUSAL);
      for (const other of this.users()) {
        if (other.id === userId) continue;
        const otherValue = this.userOnlyEnv(other.id).CODEX_HOME?.trim();
        if (otherValue && isAbsolute(otherValue) && resolve(otherValue) === dir)
          throw new Error(CODEX_HOME_REFUSAL);
      }
      return {
        provider,
        scope,
        key: `codex:${dir}`,
        dir,
        shared: false,
        env: { ...(this.envForUser(userId) ?? process.env), CODEX_HOME: dir },
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
      };
    }

    // This is an accident barrier, not hostile-member isolation. Comparisons
    // are lexical; authenticated members already have shell-equivalent access.
    const dir = this.normalizePersonal(
      own.CLAUDE_CONFIG_DIR,
      CLAUDE_CONFIG_REFUSAL,
    );
    const refused = new Set<string>([resolve(homedir(), ".claude"), officeDir]);
    const officeValue = this.officeFileEnv().CLAUDE_CONFIG_DIR?.trim();
    if (officeValue) refused.add(resolve(officeValue));
    const processValue = process.env.CLAUDE_CONFIG_DIR?.trim();
    if (processValue) refused.add(resolve(processValue));
    for (const other of this.users()) {
      if (other.id === userId) continue;
      const otherValue = this.userOnlyEnv(other.id).CLAUDE_CONFIG_DIR?.trim();
      if (otherValue) refused.add(resolve(otherValue));
    }
    if (refused.has(dir)) throw new Error(CLAUDE_CONFIG_REFUSAL);
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
    if (provider === "claude" && scope === "office") {
      return {
        provider,
        scope,
        accountStatus: "unavailable",
        loginStatus: "idle",
        shared: target.shared,
        canBrowserLogin: false,
        fallbackToTerminal: true,
      };
    }
    const running = this.active.get(target.key);
    if (running?.userId === userId) return running.wire;
    const cacheKey = this.cacheKey(userId, target);
    const cached = this.statusCache.get(cacheKey);
    if (
      !refresh &&
      cached &&
      Date.now() - cached.checkedAt < ACCOUNT_STATUS_TTL_MS
    )
      return cached.wire;
    let probe = this.probes.get(cacheKey);
    if (!probe) {
      probe = this.probe(target).finally(() => this.probes.delete(cacheKey));
      this.probes.set(cacheKey, probe);
    }
    const wire = await probe;
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
    if (provider === "claude" && scope === "office")
      return this.failure(
        422,
        "browser_login_unavailable",
        CLAUDE_OFFICE_TERMINAL,
      );
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
        account = await active.client.read();
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
