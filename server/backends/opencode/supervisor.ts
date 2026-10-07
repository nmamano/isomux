import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getAgentHost } from "../../agent-host.ts";
import { AGENT_ROOT } from "../../split/roots.ts";
import { openCodeUnsupportedReason, resolveOpenCodeBinary } from "./runtime.ts";
import { openCodeProfilePaths } from "./profile-paths.ts";
import { processIdentityMatches, processIsRunning } from "./process-identity.ts";
import {
  openCodeServerHealth,
  type OpenCodeServerEndpoint,
  type OpenCodeServerHealth,
} from "./server-health.ts";

export const OPENCODE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
export const OPENCODE_REPLACEMENT_DRAIN_MS = 2 * 60 * 1000;

interface ServerRecord {
  pid: number;
  port: number;
  password: string;
  binary: string;
  profileDir: string;
  environmentRevision: string;
  configRevision: string;
  startTicks?: string;
}

export const OPENCODE_CRON_AGENT = "isomux-cron";
export const OPENCODE_INTERACTIVE_BYPASS_AGENT = "isomux-interactive-bypass";

const DEFAULT_OPENCODE_CONFIG: Record<string, unknown> = {
  autoupdate: false,
  share: "disabled",
  permission: { bash: "ask", edit: "ask", question: "deny" },
  agent: {
    [OPENCODE_INTERACTIVE_BYPASS_AGENT]: {
      description: "Isomux interactive non-asking agent",
      mode: "primary",
      permission: {
        bash: "ask",
        edit: "ask",
        task: "allow",
        question: "deny",
      },
    },
    [OPENCODE_CRON_AGENT]: {
      description: "Isomux unattended cron run",
      mode: "primary",
      permission: {
        bash: "ask",
        edit: "ask",
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

export function openCodeConfigRevision(
  config: Record<string, unknown>,
): string {
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
  recoverBeforePrompt(): Promise<void>;
  endTurn(): void;
  // True when the server process with this pid is gone or was replaced.
  serverStopped(pid: number): boolean;
  // A turn on this pid missed its deadline. After the prompt was submitted,
  // the next turn entry or acquisition replaces that server. Before it, the
  // server is replaced only while no other turn is active on it.
  markUnresponsive(pid: number, afterPrompt: boolean): void;
}

export interface OpenCodeSupervisorOptions {
  profileDir?: string;
  binary?: string;
  platform?: NodeJS.Platform;
  config?: Record<string, unknown>;
  serverCwd?: string;
  idleShutdownMs?: number;
  launchEnv?: Record<string, string | undefined>;
  replacementDrainMs?: number;
  environmentRevision?: string;
  idleScheduler?: {
    setTimeout(
      callback: () => void | Promise<void>,
      delayMs: number,
    ): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
  processIdentityMatches?: (
    pid: number,
    startTicks: string | undefined,
  ) => boolean;
  turnHealthCheck?: (
    record: OpenCodeServerEndpoint,
  ) => Promise<OpenCodeServerHealth>;
  ensureServerSink?: () => void;
}

export class OpenCodeSupervisor {
  private leases = 0;
  private activeTurns = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private record: ServerRecord | null = null;
  private unresponsive: { pid: number; afterPrompt: boolean } | null = null;
  readonly profileDir: string;
  readonly recordPath: string;
  private resolvedBinary: string | undefined;
  private readonly platform: NodeJS.Platform;
  private config: Record<string, unknown>;
  private configRevision: string;
  private readonly serverCwd: string;
  private readonly idleShutdownMs: number;
  private launchEnv: Record<string, string | undefined>;
  private environmentRevision: string;
  private readonly replacementDrainMs: number;
  private replacementPromise: Promise<void> | null = null;
  private replacementRequested = false;
  private readonly idleScheduler: NonNullable<
    OpenCodeSupervisorOptions["idleScheduler"]
  >;
  private readonly processIdentityMatches: NonNullable<
    OpenCodeSupervisorOptions["processIdentityMatches"]
  >;
  private readonly turnHealthCheck: NonNullable<
    OpenCodeSupervisorOptions["turnHealthCheck"]
  >;
  private readonly ensureServerSink: NonNullable<
    OpenCodeSupervisorOptions["ensureServerSink"]
  >;

  constructor(options: OpenCodeSupervisorOptions = {}) {
    this.profileDir =
      options.profileDir ?? join(AGENT_ROOT, "opencode", "profiles", "default");
    this.recordPath = join(this.profileDir, "server.lock");
    // Resolved on first use, not here: the default supervisor is built at
    // import time, and a host without OpenCode must still boot the office.
    this.resolvedBinary = options.binary;
    this.platform = options.platform ?? process.platform;
    this.config = {
      ...(options.config ?? DEFAULT_OPENCODE_CONFIG),
      autoupdate: false,
    };
    this.configRevision = this.computeConfigRevision(this.config);
    this.serverCwd = options.serverCwd ?? AGENT_ROOT;
    this.idleShutdownMs = options.idleShutdownMs ?? OPENCODE_IDLE_SHUTDOWN_MS;
    this.launchEnv = options.launchEnv ?? {};
    this.environmentRevision = options.environmentRevision ?? "default";
    this.replacementDrainMs =
      options.replacementDrainMs ?? OPENCODE_REPLACEMENT_DRAIN_MS;
    this.idleScheduler = options.idleScheduler ?? {
      setTimeout: (callback, delayMs) =>
        setTimeout(() => void callback(), delayMs),
      clearTimeout,
    };
    this.processIdentityMatches =
      options.processIdentityMatches ?? processIdentityMatches;
    this.turnHealthCheck = options.turnHealthCheck ?? openCodeServerHealth;
    this.ensureServerSink = options.ensureServerSink ?? (() => undefined);
  }

  async acquire(): Promise<OpenCodeLease> {
    if (this.idleTimer) this.idleScheduler.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.shutdownPromise) await this.shutdownPromise;
    await this.replaceServerIfRequested();
    await this.ensureServer(this.markReplaceable(this.activeTurns > 0));
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
        await this.validateServerForTurn(this.activeTurns > 0);
        turnActive = true;
        this.activeTurns++;
        if (this.idleTimer) this.idleScheduler.clearTimeout(this.idleTimer);
        this.idleTimer = null;
      },
      recoverBeforePrompt: async () => {
        if (released || !turnActive) return;
        await this.validateServerForTurn(this.activeTurns > 1, true);
      },
      endTurn: () => {
        if (!turnActive) return;
        turnActive = false;
        this.activeTurns--;
        this.armIdleReap();
      },
      serverStopped: (pid) => {
        const record = this.record;
        return (
          record?.pid !== pid ||
          !this.processIdentityMatches(pid, record.startTicks) ||
          !processIsRunning(pid)
        );
      },
      markUnresponsive: (pid, afterPrompt) => {
        if (this.record?.pid !== pid) return;
        this.unresponsive = {
          pid,
          afterPrompt:
            afterPrompt ||
            (this.unresponsive?.pid === pid && this.unresponsive.afterPrompt),
        };
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
    const revision = this.computeConfigRevision(next);
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

  private async performShutdown(): Promise<void> {
    if (this.idleTimer) this.idleScheduler.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (openCodeUnsupportedReason(this.platform)) return;
    // The profile, its record and the helper are agent space (design
    // section 3.2): the agent host does all of it as the agent user.
    const host = getAgentHost();
    await host.fs.mkdir(this.profileDir, 0o777);
    await host.run(this.helperCommand(), {
      env: {
        ...host.baseEnv(),
        ...this.helperLockEnvironment(),
        ISOMUX_AGENT_TOKEN: undefined,
        OPENCODE_SERVER_ACTION: "stop",
        OPENCODE_PROFILE_DIR: this.profileDir,
        OPENCODE_SERVER_RECORD: this.recordPath,
      },
      output: "ignore",
    });
    this.record = null;
  }

  // Every start and stop runs under an exclusive lock on the record file:
  // flock(1) on Linux, and the helper's own flock(2) on macOS, which has no
  // flock CLI.
  private helperCommand(): string[] {
    const helper = [
      process.execPath,
      "run",
      join(import.meta.dir, "start-server.ts"),
    ];
    return this.platform === "darwin"
      ? helper
      : ["flock", "--exclusive", this.recordPath, ...helper];
  }

  private helperLockEnvironment(): Record<string, string | undefined> {
    return {
      OPENCODE_SERVER_LOCK: this.platform === "darwin" ? "self" : undefined,
    };
  }

  private get binary(): string {
    this.resolvedBinary ??= resolveOpenCodeBinary(this.platform);
    return this.resolvedBinary;
  }

  private markReplaceable(otherTurnActive: boolean): boolean {
    const mark = this.unresponsive;
    return (
      mark !== null &&
      mark.pid === this.record?.pid &&
      (mark.afterPrompt || !otherTurnActive)
    );
  }

  private async ensureServer(replaceMarked = false): Promise<void> {
    this.ensureServerSink();
    const binary = this.binary;
    const host = getAgentHost();
    await host.fs.mkdir(this.profileDir, 0o777);
    const configPath = join(this.profileDir, "opencode.json");
    await host.fs.writeText(configPath, `${JSON.stringify(this.config)}\n`, {
      mode: 0o600,
    });
    await host.fs.chmod(configPath, 0o600);
    const password = randomBytes(32).toString("base64url");
    const { stdout, stderr, exitCode } = await host.run(this.helperCommand(), {
      cwd: this.serverCwd,
      env: {
        ...host.baseEnv(),
        ...this.launchEnv,
        ...this.helperLockEnvironment(),
        ISOMUX_AGENT_TOKEN: undefined,
        // Debug capture is an operator-only process setting. An agent's
        // configured environment cannot enable secret-bearing output.
        ISOMUX_OPENCODE_DEBUG: process.env.ISOMUX_OPENCODE_DEBUG,
        OPENCODE_PROFILE_DIR: this.profileDir,
        OPENCODE_SERVER_RECORD: this.recordPath,
        OPENCODE_BINARY: binary,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_CWD: this.serverCwd,
        OPENCODE_CONFIG: configPath,
        OPENCODE_ENVIRONMENT_REVISION: this.environmentRevision,
        OPENCODE_CONFIG_REVISION: this.configRevision,
        OPENCODE_SERVER_UNRESPONSIVE_PID:
          replaceMarked && this.unresponsive
            ? String(this.unresponsive.pid)
            : undefined,
      },
    });
    if (exitCode !== 0)
      throw new Error(`OpenCode startup failed: ${stderr.trim()}`);
    JSON.parse(stdout);
    this.record = await this.readRecord();
    if (!this.record)
      throw new Error("OpenCode startup did not write its server record.");
    if (this.record.pid !== this.unresponsive?.pid) this.unresponsive = null;
  }

  private async validateServerForTurn(
    otherTurnActive: boolean,
    beforePrompt = false,
  ): Promise<void> {
    const record = this.record;
    if (
      !record ||
      !this.processIdentityMatches(record.pid, record.startTicks)
    ) {
      await this.ensureServer();
      return;
    }
    // A missed mid-turn stream deadline replaces the server at the next
    // entry even while other turns run on it. A missed pre-prompt deadline
    // keeps the guard: a live server another turn is on is never stopped.
    if (this.unresponsive?.pid === record.pid) {
      if (this.markReplaceable(otherTurnActive)) {
        await this.ensureServer(true);
        return;
      }
      if (beforePrompt)
        throw new Error(
          "OpenCode server missed a deadline during another active turn.",
        );
    }
    // A busy server answers late but is alive; only an unreachable one is
    // replaced.
    if ((await this.turnHealthCheck(record)) !== "unreachable") return;
    if (otherTurnActive)
      throw new Error(
        "OpenCode server health check failed during an active turn.",
      );
    await this.ensureServer();
  }

  private computeConfigRevision(config: Record<string, unknown>): string {
    return (
      createHash("sha256")
        .update(openCodeConfigRevision(config))
        // Do not adopt a server launched before existing-share sync was disabled.
        // This literal is the NAME=value start-server.ts puts in the child
        // environment (the helper runs as a script, so no import); change both.
        .update("OPENCODE_DISABLE_SHARE=1")
        .digest("hex")
    );
  }

  private async replaceServerIfRequested(): Promise<void> {
    const marker = join(this.profileDir, "server.replace");
    if (!this.replacementRequested && !(await getAgentHost().fs.exists(marker)))
      return;
    if (!this.replacementPromise) {
      this.replacementPromise = (async () => {
        const deadline = Date.now() + this.replacementDrainMs;
        while (this.activeTurns > 0 && Date.now() < deadline)
          await Bun.sleep(25);
        if (this.activeTurns > 0) {
          throw new Error(
            "OpenCode configuration changed, but active turns did not drain in time. Send your message again to retry.",
          );
        }
        await this.shutdown();
        await getAgentHost().fs.rm(marker);
        this.replacementRequested = false;
      })().finally(() => {
        this.replacementPromise = null;
      });
    }
    await this.replacementPromise;
  }

  private async readRecord(): Promise<ServerRecord | null> {
    try {
      return JSON.parse(
        await getAgentHost().fs.readText(this.recordPath),
      ) as ServerRecord;
    } catch {
      return null;
    }
  }

  private armIdleReap(): void {
    if (this.leases > 0 || this.activeTurns > 0 || this.idleTimer) return;
    this.idleTimer = this.idleScheduler.setTimeout(
      () => this.shutdown(),
      this.idleShutdownMs,
    );
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
      // Per-turn tool authority reaches the agent through the authority broker
      // (authority-broker.ts), never through the shared process env.
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
    ...[...environmentSupervisors.values()].map((supervisor) =>
      supervisor.shutdown(),
    ),
  ]).finally(() => {
    process.off(signal, signal === "SIGINT" ? onSigint : onSigterm);
    process.kill(process.pid, signal);
  });
}
const onSigint = () => reapAtSignal("SIGINT");
const onSigterm = () => reapAtSignal("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);
