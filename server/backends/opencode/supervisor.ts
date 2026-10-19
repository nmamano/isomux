import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { getAgentHost } from "../../agent-host.ts";
import { ADMIN_SOCKET_PATH, STATE_ROOT } from "../../config.ts";
import { AGENT_ROOT } from "../../split/roots.ts";
import { runAtServerStop } from "../../server-stop.ts";
import { openCodeUnsupportedReason, resolveOpenCodeBinary } from "./runtime.ts";
import { openCodeProfilePaths } from "./profile-paths.ts";
import { OPENCODE_SAFETY_TOOL } from "./safety-plugin-tool.ts";
import type { AgentMcpServer } from "../../mcp-servers.ts";
import {
  processIdentityMatches,
  processIsRunning,
} from "./process-identity.ts";
import {
  openCodeServerHealth,
  type OpenCodeServerEndpoint,
  type OpenCodeServerHealth,
} from "./server-health.ts";

export const OPENCODE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

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

// OpenCode asks before bash and edit, so Isomux can apply the office policy
// and the member's approval mode. Every agent Isomux starts sessions with
// carries the rules: an agent's own block applies after the top-level one, and
// a user or project default_agent would otherwise pick the agent.
const DEFAULT_OPENCODE_CONFIG: Record<string, unknown> = {
  autoupdate: false,
  share: "disabled",
  default_agent: "build",
  permission: {
    bash: "ask",
    edit: "ask",
    question: "deny",
    [OPENCODE_SAFETY_TOOL]: "deny",
  },
  agent: {
    build: {
      permission: { bash: "ask", edit: "ask", question: "deny" },
    },
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
  // One server process: a replacement gets a new key, an adoption keeps it.
  serverKey: string;
  // The running server has older revisions than the current env, secrets or
  // MCP config, the rule replaceServerIfRequested uses: its replacement
  // waits for this server's turns and held work, so a turn that runs now
  // uses the previous settings. The server.replace marker, which no Isomux
  // path writes, is not read here: this getter is sync.
  readonly replacementPending: boolean;
  // Ends the hold acquire() takes. Until then, or until beginTurn counts the
  // turn, or release(), a pending replacement does not stop this server.
  settle(): void;
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
  environmentRevision?: string;
  idleScheduler?: {
    setTimeout(
      callback: () => void | Promise<void>,
      delayMs: number,
    ): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
  turnHealthCheck?: (
    record: OpenCodeServerEndpoint,
  ) => Promise<OpenCodeServerHealth>;
  ensureServerSink?: () => void;
}

export class OpenCodeSupervisor {
  private leases = 0;
  private activeTurns = 0;
  // Work on the server that no turn counts yet: an acquired lease until its
  // caller settles it, and a turn entry until the turn counts. A pending
  // replacement waits for it as it waits for turns.
  private holds = 0;
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
  private replacementPromise: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private readonly idleScheduler: NonNullable<
    OpenCodeSupervisorOptions["idleScheduler"]
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
    this.idleScheduler = options.idleScheduler ?? {
      setTimeout: (callback, delayMs) =>
        setTimeout(() => void callback(), delayMs),
      clearTimeout,
    };
    this.turnHealthCheck = options.turnHealthCheck ?? openCodeServerHealth;
    this.ensureServerSink = options.ensureServerSink ?? (() => undefined);
  }

  async acquire(): Promise<OpenCodeLease> {
    // Taken before the first wait, so no replacement can start between the
    // check below and the caller's work.
    let entry: (() => void) | null = this.hold();
    try {
      if (this.idleTimer) this.idleScheduler.clearTimeout(this.idleTimer);
      this.idleTimer = null;
      if (this.shutdownPromise) await this.shutdownPromise;
      const replacement = await this.replaceServerIfRequested(1);
      const replaceMarked = this.markReplaceable(this.activeTurns > 0);
      // A pending replacement: the helper would not adopt the server under
      // its new revisions and would stop it, so use it as it is.
      const record = this.record;
      if (
        replacement !== "pending" ||
        replaceMarked ||
        !record ||
        !processIdentityMatches(record.pid, record.startTicks)
      )
        await this.ensureServer(replaceMarked);
    } catch (error) {
      entry();
      throw error;
    }
    this.leases++;
    let released = false;
    let turnActive = false;
    const initialRecord = this.record!;
    const currentRecord = () => this.record ?? initialRecord;
    const replacementPending = () => this.recordStale();
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
      get serverKey() {
        const record = currentRecord();
        return `${record.pid}:${record.startTicks ?? ""}:${record.port}`;
      },
      get replacementPending() {
        return replacementPending();
      },
      settle: () => {
        entry?.();
        entry = null;
      },
      release: () => {
        entry?.();
        entry = null;
        if (released) return;
        released = true;
        this.leases--;
        this.armIdleReap();
      },
      beginTurn: async () => {
        if (released || turnActive) return;
        // The acquire's hold, or a new one, ends once the turn counts.
        const drop = entry ?? this.hold();
        entry = null;
        try {
          await this.replaceServerIfRequested(1);
          if (this.shutdownPromise) await this.shutdownPromise;
          await this.validateServerForTurn(this.activeTurns > 0);
          // A start this entry joined, or a turn that ended during it, can
          // leave a stale server that only this entry holds: replace it now.
          if (
            this.recordStale() &&
            (await this.replaceServerIfRequested(1)) === "replaced"
          )
            await this.validateServerForTurn(this.activeTurns > 0);
          turnActive = true;
          this.activeTurns++;
          if (this.idleTimer) this.idleScheduler.clearTimeout(this.idleTimer);
          this.idleTimer = null;
        } finally {
          drop();
        }
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
        this.replaceOnceIdle();
      },
      serverStopped: (pid) => {
        const record = this.record;
        return (
          record?.pid !== pid ||
          !processIdentityMatches(pid, record.startTicks) ||
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

  // True when the revision changed: a running server is then stale.
  updateLaunchEnvironment(
    launchEnv: Record<string, string | undefined>,
    environmentRevision: string,
  ): boolean {
    if (environmentRevision === this.environmentRevision) return false;
    this.launchEnv = launchEnv;
    this.environmentRevision = environmentRevision;
    return true;
  }

  // The config the next server start writes to opencode.json.
  get configuration(): Readonly<Record<string, unknown>> {
    return this.config;
  }

  updateConfiguration(config: Record<string, unknown>): boolean {
    const next = { ...config, autoupdate: false };
    const revision = this.computeConfigRevision(next);
    if (revision === this.configRevision) return false;
    this.config = next;
    this.configRevision = revision;
    return true;
  }

  // Saved settings, with the env and config the next session start passes.
  // The replacement they request runs now on a server where nothing runs,
  // else when the last turn or hold ends.
  updateSettings(
    launchEnv: Record<string, string | undefined>,
    environmentRevision: string,
    config: Record<string, unknown>,
  ): void {
    const configChanged = this.updateConfiguration(config);
    const envChanged = this.updateLaunchEnvironment(
      launchEnv,
      environmentRevision,
    );
    if (configChanged || envChanged) this.replaceOnceIdle();
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

  // One start at a time: a second start with other revisions would stop the
  // server the first brings up, which a lease can already hold. A caller
  // joins the start in flight and takes its server; older revisions on it
  // are a pending replacement, made when the last turn or hold ends.
  private async ensureServer(replaceMarked = false): Promise<void> {
    this.ensureServerSink();
    while (this.starting !== null) {
      await this.starting.catch(() => undefined);
      // A third caller can have started again since.
      if (this.starting !== null) continue;
      const record = this.record;
      if (
        record &&
        processIdentityMatches(record.pid, record.startTicks) &&
        !(replaceMarked && record.pid === this.unresponsive?.pid)
      )
        return;
    }
    this.starting = this.startServer(replaceMarked).finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async startServer(replaceMarked: boolean): Promise<void> {
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
        // After the launch env, which holds the member's variables: the
        // safety plugin uses this process's roots, as Claude's hook does.
        OPENCODE_SAFETY_ROOTS: JSON.stringify({
          home: homedir(),
          env: {
            ISOMUX_HOME: STATE_ROOT,
            ISOMUX_ADMIN_SOCKET: ADMIN_SOCKET_PATH,
          },
        }),
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
    if (!record || !processIdentityMatches(record.pid, record.startTicks)) {
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
        // Do not adopt a server launched with --pure, before user and project
        // config loaded. Names the variable start-server.ts added with them.
        .update("OPENCODE_CONFIG_CONTENT")
        .digest("hex")
    );
  }

  // A replacement is requested while the running server has other revisions
  // than the current ones, or while the marker exists. It never stops a
  // running turn or held work and never waits for them: meanwhile it stays
  // pending, and new turns and acquires use the current server. The last turn
  // or hold to end replaces it (replaceOnceIdle). ownHolds: the caller's own
  // holds, which do not count.
  private async replaceServerIfRequested(
    ownHolds = 0,
  ): Promise<"none" | "pending" | "replaced"> {
    const marker = join(this.profileDir, "server.replace");
    if (!this.replacementPromise) {
      if (!this.recordStale() && !(await getAgentHost().fs.exists(marker)))
        return "none";
    }
    // Another caller can have started the replacement during that await.
    if (!this.replacementPromise) {
      if (this.activeTurns > 0 || this.holds > ownHolds) return "pending";
      this.replacementPromise = (async () => {
        await this.shutdown();
        await getAgentHost().fs.rm(marker);
      })().finally(() => {
        this.replacementPromise = null;
      });
    }
    await this.replacementPromise;
    return "replaced";
  }

  // From the record, not a flag: a server that any start gave the current
  // revisions satisfies a request, and one that a start in flight brought up
  // with older revisions does not. No running server is not stale.
  private recordStale(): boolean {
    const record = this.record;
    return (
      record !== null &&
      (record.environmentRevision !== this.environmentRevision ||
        record.configRevision !== this.configRevision)
    );
  }

  private hold(): () => void {
    this.holds++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holds--;
      this.replaceOnceIdle();
    };
  }

  // At the end of a turn or hold: a pending replacement runs once neither is
  // left. Retained leases get the new server at once, as after a replacement
  // at acquire.
  private replaceOnceIdle(): void {
    if (this.activeTurns > 0 || this.holds > 0) return;
    void (async () => {
      if ((await this.replaceServerIfRequested()) !== "replaced") return;
      if (this.leases > 0 && !this.record) await this.ensureServer();
    })().catch(() => {
      console.error(
        "[opencode] Server replacement after the last turn failed.",
      );
    });
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

// The config file of a profile's server: the defaults and the remote MCP
// servers Isomux registers (server/mcp-servers.ts). The file is the only
// channel for their headers: never the server's argv or environment. OpenCode
// merges config layers deeply, and user and project config load above this
// file, so start-server.ts repeats it without the headers in
// OPENCODE_CONFIG_CONTENT, the top layer (config-layers.ts);
// supervisor.test.ts pins both.
export function openCodeConfigFor(
  mcpServers: AgentMcpServer[],
): Record<string, unknown> {
  if (mcpServers.length === 0) return DEFAULT_OPENCODE_CONFIG;
  return {
    ...DEFAULT_OPENCODE_CONFIG,
    mcp: Object.fromEntries(
      mcpServers.map((server) => [
        server.name,
        {
          type: "remote",
          url: server.url,
          headers: { ...server.headers },
          oauth: false,
          enabled: true,
        },
      ]),
    ),
  };
}

// `mcpServers` undefined keeps the config the profile's server has: callers
// that do not start an agent session (a model list, a transcript read) must
// not drop the servers and restart it.
function launchEnvFor(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {})
      // Agent tokens are per-agent capabilities. A shared OpenCode server must
      // never inherit one agent's token or use it as a profile discriminator.
      // Per-turn tool authority reaches the agent through the authority broker
      // (authority-broker.ts), never through the shared process env.
      .filter(([name]) => name !== "ISOMUX_AGENT_TOKEN")
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function supervisorKey(environmentKey: string): string {
  const profileDir = openCodeProfilePaths(environmentKey).profileDir;
  return profileDir.slice(profileDir.lastIndexOf("/") + 1);
}

// A saved env variable, secret or MCP server, with the inputs a session start
// passes to openCodeSupervisorForEnvironment. Only an existing supervisor
// takes it; none is created.
export function updateOpenCodeSupervisorSettings(
  environmentKey: string,
  env: Record<string, string | undefined> | undefined,
  environmentRevision: string,
  mcpServers: AgentMcpServer[],
): void {
  environmentSupervisors
    .get(supervisorKey(environmentKey))
    ?.updateSettings(
      launchEnvFor(env),
      environmentRevision,
      openCodeConfigFor(mcpServers),
    );
}

export function openCodeSupervisorForEnvironment(
  environmentKey: string | undefined,
  env: Record<string, string | undefined> | undefined,
  environmentRevision = "default",
  mcpServers?: AgentMcpServer[],
): OpenCodeSupervisor {
  const launchEnv = launchEnvFor(env);
  if (!environmentKey) {
    throw new Error("OpenCode session environment identity is required.");
  }
  const profileDir = openCodeProfilePaths(environmentKey).profileDir;
  const key = supervisorKey(environmentKey);
  let supervisor = environmentSupervisors.get(key);
  if (!supervisor) {
    supervisor = new OpenCodeSupervisor({
      profileDir,
      launchEnv,
      environmentRevision,
      config: openCodeConfigFor(mcpServers ?? []),
    });
    environmentSupervisors.set(key, supervisor);
  } else {
    if (mcpServers)
      supervisor.updateConfiguration(openCodeConfigFor(mcpServers));
    supervisor.updateLaunchEnvironment(launchEnv, environmentRevision);
  }
  return supervisor;
}

// Reap the OpenCode servers before the office process exits.
runAtServerStop(() =>
  Promise.all([
    openCodeSupervisor.shutdown(),
    ...[...environmentSupervisors.values()].map((supervisor) =>
      supervisor.shutdown(),
    ),
  ]),
);
