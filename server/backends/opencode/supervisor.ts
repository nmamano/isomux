import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { STATE_ROOT } from "../../config.ts";
import { resolveOpenCodeBinary } from "./runtime.ts";
import { openCodeProfilePaths } from "./login-wrapper.ts";

export const OPENCODE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
export const OPENCODE_REPLACEMENT_DRAIN_MS = 2 * 60 * 1000;
export const OPENCODE_AUTH_LOGIN_PENDING_TTL_MS = 10 * 60 * 1000;

interface ServerRecord {
  pid: number;
  port: number;
  password: string;
  binary: string;
  profileDir: string;
  environmentRevision: string;
  configRevision: string;
}

export const OPENCODE_CRON_AGENT = "isomux-cron";

const DEFAULT_OPENCODE_CONFIG: Record<string, unknown> = {
  autoupdate: false,
  share: "disabled",
  permission: { bash: "ask", edit: "ask", question: "deny" },
  agent: {
    [OPENCODE_CRON_AGENT]: {
      description: "Isomux unattended cron run",
      mode: "primary",
      permission: {
        bash: "allow",
        edit: "allow",
        task: "deny",
        question: "deny",
      },
    },
  },
};

function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableConfigValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableConfigValue(entry)]),
  );
}

export function openCodeConfigRevision(config: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(stableConfigValue(config)))
    .digest("hex");
}

export interface OpenCodeLease {
  baseUrl: string;
  authHeader: string;
  profileDir: string;
  pid: number;
  release(): void;
  beginTurn(): Promise<void>;
  endTurn(): void;
}

export interface OpenCodeSupervisorOptions {
  profileDir?: string;
  binary?: string;
  config?: Record<string, unknown>;
  serverCwd?: string;
  idleShutdownMs?: number;
  launchEnv?: Record<string, string | undefined>;
  replacementDrainMs?: number;
  pendingLoginTtlMs?: number;
  environmentRevision?: string;
}

export class OpenCodeSupervisor {
  private leases = 0;
  private activeTurns = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private record: ServerRecord | null = null;
  readonly profileDir: string;
  readonly recordPath: string;
  private readonly binary: string;
  private config: Record<string, unknown>;
  private configRevision: string;
  private readonly serverCwd: string;
  private readonly idleShutdownMs: number;
  private launchEnv: Record<string, string | undefined>;
  private environmentRevision: string;
  private readonly replacementDrainMs: number;
  private readonly pendingLoginTtlMs: number;
  private replacementPromise: Promise<void> | null = null;
  private replacementRequested = false;

  constructor(options: OpenCodeSupervisorOptions = {}) {
    this.profileDir = options.profileDir ?? join(STATE_ROOT, "opencode", "profiles", "default");
    this.recordPath = join(this.profileDir, "server.lock");
    this.binary = options.binary ?? resolveOpenCodeBinary();
    this.config = {
      ...(options.config ?? DEFAULT_OPENCODE_CONFIG),
      autoupdate: false,
    };
    this.configRevision = openCodeConfigRevision(this.config);
    this.serverCwd = options.serverCwd ?? STATE_ROOT;
    this.idleShutdownMs = options.idleShutdownMs ?? OPENCODE_IDLE_SHUTDOWN_MS;
    this.launchEnv = options.launchEnv ?? {};
    this.environmentRevision = options.environmentRevision ?? "default";
    this.replacementDrainMs = options.replacementDrainMs ?? OPENCODE_REPLACEMENT_DRAIN_MS;
    this.pendingLoginTtlMs = options.pendingLoginTtlMs ?? OPENCODE_AUTH_LOGIN_PENDING_TTL_MS;
    this.clearPendingLogin();
  }

  async acquire(): Promise<OpenCodeLease> {
    if (this.hasActivePendingLogin()) {
      throw new Error("OpenCode login is in progress for this shared environment.");
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.shutdownPromise) await this.shutdownPromise;
    await this.replaceServerIfRequested();
    await this.ensureServer();
    this.leases++;
    let released = false;
    let turnActive = false;
    const initialRecord = this.record!;
    const currentRecord = () => this.record ?? initialRecord;
    return {
      get baseUrl() {
        return `http://127.0.0.1:${currentRecord().port}`;
      },
      get authHeader() {
        return `Basic ${btoa(`isomux:${currentRecord().password}`)}`;
      },
      profileDir: this.profileDir,
      get pid() {
        return currentRecord().pid;
      },
      release: () => {
        if (released) return;
        released = true;
        this.leases--;
        this.armIdleReap();
      },
      beginTurn: async () => {
        if (released || turnActive) return;
        await this.replaceServerIfRequested();
        if (this.shutdownPromise) await this.shutdownPromise;
        if (!this.record) await this.ensureServer();
        turnActive = true;
        this.activeTurns++;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
      },
      endTurn: () => {
        if (!turnActive) return;
        turnActive = false;
        this.activeTurns--;
        this.armIdleReap();
      },
    };
  }

  updateLaunchEnvironment(
    launchEnv: Record<string, string | undefined>,
    environmentRevision: string,
  ): void {
    if (environmentRevision === this.environmentRevision) return;
    this.launchEnv = launchEnv;
    this.environmentRevision = environmentRevision;
    this.replacementRequested = true;
  }

  updateConfiguration(config: Record<string, unknown>): void {
    const next = { ...config, autoupdate: false };
    const revision = openCodeConfigRevision(next);
    if (revision === this.configRevision) return;
    this.config = next;
    this.configRevision = revision;
    this.replacementRequested = true;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  async prepareForAuthentication(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true });
    const pending = `${this.profileDir}.auth-login-pending`;
    await writeFile(pending, "login pending\n", { mode: 0o600 });
    const deadline = Date.now() + this.replacementDrainMs;
    while (this.activeTurns > 0 && Date.now() < deadline) await Bun.sleep(25);
    if (this.activeTurns > 0) {
      await rm(pending, { force: true });
      throw new Error(
        "OpenCode login is waiting for another turn to finish. Send your message again to retry.",
      );
    }
    await this.shutdown();
  }

  private clearPendingLogin(): void {
    try {
      unlinkSync(`${this.profileDir}.auth-login-pending`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  private hasActivePendingLogin(): boolean {
    const pending = `${this.profileDir}.auth-login-pending`;
    try {
      if (Date.now() - statSync(pending).mtimeMs < this.pendingLoginTtlMs) return true;
      unlinkSync(pending);
      return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async performShutdown(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await mkdir(this.profileDir, { recursive: true });
    const helper = join(import.meta.dir, "start-server.ts");
    const proc = Bun.spawn(
      ["flock", "--exclusive", this.recordPath, process.execPath, "run", helper],
      {
        env: {
          ...process.env,
          ISOMUX_AGENT_TOKEN: undefined,
          OPENCODE_SERVER_ACTION: "stop",
          OPENCODE_PROFILE_DIR: this.profileDir,
          OPENCODE_SERVER_RECORD: this.recordPath,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await proc.exited;
    this.record = null;
  }

  private async ensureServer(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true });
    const configPath = join(this.profileDir, "opencode.json");
    await writeFile(configPath, `${JSON.stringify({ ...this.config, autoupdate: false })}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
    const password = randomBytes(32).toString("base64url");
    const helper = join(import.meta.dir, "start-server.ts");
    const proc = Bun.spawn(
      ["flock", "--exclusive", this.recordPath, process.execPath, "run", helper],
      {
        cwd: this.serverCwd,
        env: {
          ...process.env,
          ...this.launchEnv,
          ISOMUX_AGENT_TOKEN: undefined,
          // Debug capture is an operator-only process setting. An agent's
          // configured environment cannot enable secret-bearing output.
          ISOMUX_OPENCODE_DEBUG: process.env.ISOMUX_OPENCODE_DEBUG,
          OPENCODE_PROFILE_DIR: this.profileDir,
          OPENCODE_SERVER_RECORD: this.recordPath,
          OPENCODE_BINARY: this.binary,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_SERVER_CWD: this.serverCwd,
          OPENCODE_CONFIG: configPath,
          OPENCODE_ENVIRONMENT_REVISION: this.environmentRevision,
          OPENCODE_CONFIG_REVISION: this.configRevision,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`OpenCode startup failed: ${stderr.trim()}`);
    JSON.parse(stdout);
    this.record = await this.readRecord();
    if (!this.record) throw new Error("OpenCode startup did not write its server record.");
  }

  private async replaceServerIfRequested(): Promise<void> {
    const marker = join(this.profileDir, "server.replace");
    if (!existsSync(marker) && !this.replacementRequested) return;
    if (!this.replacementPromise) {
      this.replacementPromise = (async () => {
        const deadline = Date.now() + this.replacementDrainMs;
        while (this.activeTurns > 0 && Date.now() < deadline) await Bun.sleep(25);
        if (this.activeTurns > 0) {
          throw new Error(
            "OpenCode configuration changed, but active turns did not drain in time. Send your message again to retry.",
          );
        }
        await this.shutdown();
        await rm(marker, { force: true });
        this.replacementRequested = false;
      })().finally(() => {
        this.replacementPromise = null;
      });
    }
    await this.replacementPromise;
  }

  private async readRecord(): Promise<ServerRecord | null> {
    try {
      return JSON.parse(await readFile(this.recordPath, "utf8")) as ServerRecord;
    } catch {
      return null;
    }
  }

  private armIdleReap(): void {
    if (this.leases > 0 || this.activeTurns > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => void this.shutdown(), this.idleShutdownMs);
  }
}

export const openCodeSupervisor = new OpenCodeSupervisor();

const environmentSupervisors = new Map<string, OpenCodeSupervisor>();

export function openCodeSupervisorForEnvironment(
  environmentKey: string | undefined,
  env: Record<string, string | undefined> | undefined,
  environmentRevision = "default",
): OpenCodeSupervisor {
  const launchEnv = Object.fromEntries(
    Object.entries(env ?? {})
      // Agent tokens are per-agent capabilities. A shared OpenCode server must
      // never inherit one agent's token or use it as a profile discriminator.
      // S1b has tools disabled; S3 must inject per-session tool authority at a
      // narrower boundary instead of putting it in the shared process env.
      .filter(([name]) => name !== "ISOMUX_AGENT_TOKEN")
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  if (!environmentKey) {
    throw new Error("OpenCode session environment identity is required.");
  }
  const profileDir = openCodeProfilePaths(environmentKey).profileDir;
  const key = profileDir.slice(profileDir.lastIndexOf("/") + 1);
  let supervisor = environmentSupervisors.get(key);
  if (!supervisor) {
    supervisor = new OpenCodeSupervisor({
      profileDir,
      launchEnv,
      environmentRevision,
    });
    environmentSupervisors.set(key, supervisor);
  } else {
    supervisor.updateConfiguration(DEFAULT_OPENCODE_CONFIG);
    supervisor.updateLaunchEnvironment(launchEnv, environmentRevision);
  }
  return supervisor;
}

let shuttingDown = false;
function reapAtSignal(signal: "SIGINT" | "SIGTERM"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.all([
    openCodeSupervisor.shutdown(),
    ...[...environmentSupervisors.values()].map((supervisor) => supervisor.shutdown()),
  ]).finally(() => {
    process.off(signal, signal === "SIGINT" ? onSigint : onSigterm);
    process.kill(process.pid, signal);
  });
}
const onSigint = () => reapAtSignal("SIGINT");
const onSigterm = () => reapAtSignal("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);
