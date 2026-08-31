import { homedir } from "node:os";
import { resolve } from "node:path";
import { readEnvFile } from "./persistence.ts";
import { getUserEnvFileById, listUsers } from "./users.ts";
import {
  buildEnvForUserId,
  environmentSourceKeyForUserId,
} from "./env-loader.ts";
import {
  ISOMUX_CODEX_HOME,
  withIsomuxCodexHome,
} from "./backends/codex/native-bin.ts";
import { CodexAccountClient } from "./backends/codex/account.ts";
import type { HandlerErrorStatus } from "./routes/executor.ts";
import type {
  ProviderAccountProvider,
  ProviderAccountWire,
  ProviderLoginStartRes,
} from "../shared/types.ts";

export const CLAUDE_CONFIG_REFUSAL =
  "Claude sign-in from the browser needs your own Claude config directory. Set CLAUDE_CONFIG_DIR in your env file, and then try again.";
const ACCOUNT_STATUS_TTL_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

type Active = {
  userId: string;
  cacheKey: string;
  client: CodexAccountClient;
  loginId: string;
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
  ) {}

  private userOnlyEnv(userId: string): Record<string, string> {
    const file = getUserEnvFileById(userId);
    return file ? readEnvFile(file) : {};
  }

  private target(
    userId: string,
    provider: ProviderAccountProvider,
  ): { key: string; dir: string; shared: boolean } {
    const own = this.userOnlyEnv(userId);
    if (provider === "codex") {
      const effective = withIsomuxCodexHome(buildEnvForUserId(userId));
      const dir = resolve(effective.CODEX_HOME ?? ISOMUX_CODEX_HOME);
      return {
        key: `codex:${dir}`,
        dir,
        shared: dir === resolve(ISOMUX_CODEX_HOME) && listUsers().length > 1,
      };
    }
    const value = own.CLAUDE_CONFIG_DIR?.trim();
    if (!value) throw new Error(CLAUDE_CONFIG_REFUSAL);
    const dir = resolve(value);
    if (dir === resolve(homedir(), ".claude"))
      throw new Error(CLAUDE_CONFIG_REFUSAL);
    for (const other of listUsers()) {
      if (other.id === userId) continue;
      const otherValue = this.userOnlyEnv(other.id).CLAUDE_CONFIG_DIR?.trim();
      if (otherValue && resolve(otherValue) === dir)
        throw new Error(CLAUDE_CONFIG_REFUSAL);
    }
    return { key: `claude:${dir}`, dir, shared: false };
  }

  async list(userId: string, refresh = false): Promise<ProviderAccountWire[]> {
    const codexTarget = this.target(userId, "codex");
    const cacheKey = `${codexTarget.key}:${this.environmentKeyForUser(userId)}`;
    const running = this.active.get(codexTarget.key);
    if (running?.userId === userId)
      return [running.wire, this.claudeWire(userId)];
    const cached = this.statusCache.get(cacheKey);
    if (
      !refresh &&
      cached &&
      Date.now() - cached.checkedAt < ACCOUNT_STATUS_TTL_MS
    )
      return [
        { ...cached.wire, shared: codexTarget.shared },
        this.claudeWire(userId),
      ];
    let probe = this.probes.get(cacheKey);
    if (!probe) {
      probe = this.probeCodex(userId, codexTarget.shared).finally(() =>
        this.probes.delete(cacheKey),
      );
      this.probes.set(cacheKey, probe);
    }
    const wire = await probe;
    this.statusCache.set(cacheKey, { checkedAt: Date.now(), wire });
    return [wire, this.claudeWire(userId)];
  }

  private async probeCodex(
    userId: string,
    shared: boolean,
  ): Promise<ProviderAccountWire> {
    let client: CodexAccountClient | null = null;
    try {
      client = this.createCodex(this.envForUser(userId));
      await client.start();
      const status = await client.read();
      return {
        provider: "codex",
        accountStatus: status.connected ? "connected" : "not_connected",
        loginStatus: "idle",
        accountLabel: status.label,
        shared,
        canBrowserLogin: true,
      };
    } catch (err) {
      return {
        provider: "codex",
        accountStatus: "unavailable",
        loginStatus: "idle",
        shared,
        canBrowserLogin: false,
        fallbackToTerminal: true,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await client?.close();
    }
  }

  private claudeWire(userId: string): ProviderAccountWire {
    try {
      this.target(userId, "claude");
      return {
        provider: "claude",
        accountStatus: "unavailable",
        loginStatus: "idle",
        canBrowserLogin: false,
        fallbackToTerminal: true,
        error:
          "Claude browser sign-in is not available yet. Use the terminal instead.",
      };
    } catch (err) {
      return {
        provider: "claude",
        accountStatus: "unavailable",
        loginStatus: "idle",
        canBrowserLogin: false,
        fallbackToTerminal: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async startLogin(
    userId: string,
    method: "browser" | "device",
  ): Promise<
    | { ok: true; value: ProviderLoginStartRes }
    | { ok: false; status: HandlerErrorStatus; code: string; message: string }
  > {
    const target = this.target(userId, "codex");
    const cacheKey = `${target.key}:${this.environmentKeyForUser(userId)}`;
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
    const client = this.createCodex(this.envForUser(userId));
    try {
      await client.start();
      const start = await client.login(method);
      const wire: ProviderAccountWire = {
        provider: "codex",
        accountStatus: "not_connected",
        loginStatus: "waiting_external",
        shared: target.shared,
        canBrowserLogin: true,
      };
      this.active.set(target.key, {
        userId,
        cacheKey,
        client,
        loginId: start.loginId,
        authUrl: start.authUrl,
        userCode: start.userCode,
        wire,
      });
      this.emit(userId, await this.list(userId));
      void this.finish(target.key);
      return {
        ok: true,
        value: {
          account: wire,
          authUrl: start.authUrl,
          userCode: start.userCode,
        },
      };
    } catch (err) {
      await client.close();
      return {
        ok: false,
        status: 502,
        code: "provider_error",
        message: err instanceof Error ? err.message : String(err),
      };
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
      const account = await active.client.read();
      active.wire = {
        ...active.wire,
        accountStatus: account.connected ? "connected" : "not_connected",
        accountLabel: account.label,
        loginStatus: done.success && account.connected ? "succeeded" : "failed",
        error:
          done.success && account.connected
            ? undefined
            : (done.error ?? "Codex did not report a connected account."),
      };
      this.statusCache.set(active.cacheKey, {
        checkedAt: Date.now(),
        wire: active.wire,
      });
      this.emit(active.userId, [active.wire, this.claudeWire(active.userId)]);
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
        this.emit(active.userId, [active.wire, this.claudeWire(active.userId)]);
      }
    } finally {
      if (this.active.get(key) === active) this.active.delete(key);
      await active.client.close();
    }
  }

  private withLoginDeadline<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Sign-in timed out. Start again.")),
        this.loginTimeoutMs,
      );
      timer.unref?.();
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  async cancel(userId: string): Promise<boolean> {
    const target = this.target(userId, "codex");
    const active = this.active.get(target.key);
    if (!active || active.userId !== userId) return false;
    this.active.delete(target.key);
    await active.client.cancel(active.loginId).catch(() => {});
    await active.client.close();
    this.emit(userId, await this.list(userId));
    return true;
  }
}
