import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { getAgentHost } from "../../agent-host.ts";
import { ADMIN_SOCKET_PATH, STATE_ROOT } from "../../config.ts";
import { AGENT_ROOT } from "../../split/roots.ts";
import { runAtServerStop } from "../../server-stop.ts";
import { openCodeUnsupportedReason, resolveOpenCodeBinary } from "./runtime.ts";
import { openCodeProfilePaths } from "./profile-paths.ts";
import type { AgentMcpServer } from "../../mcp-servers.ts";
import { openCodeToolEnvironment } from "./config-layers.ts";
import { openCodeAuthHeader } from "./server-startup.ts";
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

type OpenCodeRule = {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
};
const rule = (
  action: string,
  effect: OpenCodeRule["effect"],
): OpenCodeRule => ({
  action,
  resource: "*",
  effect,
});
// OpenCode asks before shell and edit, so Isomux can apply the office policy
// and the member's approval mode, and before a path outside the folder,
// which 1.18.35 asked by default and a key-for-key rename loses (gate C1).
const BASE_RULES: OpenCodeRule[] = [
  rule("shell", "ask"),
  rule("edit", "ask"),
  rule("question", "deny"),
  rule("external_directory", "ask"),
];

// The full rule list of an agent Isomux runs sessions with. The transport
// sends it at session create and when it switches the agent: rules set on a
// session come after the agent's own (core/src/permission.ts), so a session
// created in another mode would keep that mode's rules.
export function openCodeAgentRules(agent: string): OpenCodeRule[] {
  if (agent === OPENCODE_INTERACTIVE_BYPASS_AGENT)
    return [...BASE_RULES, rule("subagent", "allow")];
  if (agent === OPENCODE_CRON_AGENT)
    return [...BASE_RULES, rule("subagent", "deny")];
  return [...BASE_RULES];
}

// Isomux's config in the 2.1.4 keys. Every agent Isomux starts sessions with
// carries its rules in its own block too: a user or project default_agent
// would otherwise pick the agent, and its block applies after the top-level
// rules. MCP servers are not here: the transport adds them at run time
// (config-layers.ts).
export function openCodeDefaultConfig(): Record<string, unknown> {
  return {
    update: "disable",
    share: "disabled",
    default_agent: "build",
    permissions: openCodeAgentRules("build"),
    agents: {
      build: { permissions: openCodeAgentRules("build") },
      [OPENCODE_INTERACTIVE_BYPASS_AGENT]: {
        description: "Isomux interactive non-asking agent",
        mode: "primary",
        permissions: openCodeAgentRules(OPENCODE_INTERACTIVE_BYPASS_AGENT),
      },
      [OPENCODE_CRON_AGENT]: {
        description: "Isomux unattended cron run",
        mode: "primary",
        permissions: openCodeAgentRules(OPENCODE_CRON_AGENT),
      },
    },
  };
}

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
  // uses the previous settings. False while only a member's reload waits:
  // the /reload-plugins reply says that wait. The server.replace marker is
  // not read here: this getter is sync.
  readonly replacementPending: boolean;
  // A non-empty value for this variable in the env this server process was
  // started with. A saved variable reaches the server only when it is replaced.
  hasLaunchVariable(name: string): boolean;
  // The supervisor's current Isomux MCP servers, read at each turn: a change
  // needs no new server (the transport adds them at run time).
  readonly mcpServers: AgentMcpServer[];
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
  // The Isomux MCP servers the transport adds to each folder at run time.
  mcpServers?: AgentMcpServer[];
  // The skill folders the Isomux config lists under `skills`.
  skillPaths?: string[];
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
  // The variables with a value in the env each server process started with.
  // An adopted server matched the environment revision, so it has that env.
  private readonly recordLaunchVariables = new WeakMap<
    ServerRecord,
    ReadonlySet<string>
  >();
  private unresponsive: { pid: number; afterPrompt: boolean } | null = null;
  // A member's reload waits for the replacement, like a stale record.
  private reloadRequested = false;
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
  // Callers of waitUntilCurrent, woken after each replacement try.
  private currentWaiters = new Set<() => void>();
  private currentMcpServers: AgentMcpServer[];
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
      ...(options.config ?? openCodeDefaultConfig()),
      ...(options.skillPaths ? { skills: [...options.skillPaths] } : {}),
      update: "disable",
    };
    this.configRevision = this.computeConfigRevision(this.config);
    this.serverCwd = options.serverCwd ?? AGENT_ROOT;
    this.idleShutdownMs = options.idleShutdownMs ?? OPENCODE_IDLE_SHUTDOWN_MS;
    this.launchEnv = options.launchEnv ?? {};
    this.environmentRevision = options.environmentRevision ?? "default";
    this.currentMcpServers = options.mcpServers ?? [];
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
    const currentMcpServers = () => this.currentMcpServers;
    return {
      get baseUrl() {
        return `http://127.0.0.1:${currentRecord().port}`;
      },
      get authHeader() {
        return openCodeAuthHeader(currentRecord().password);
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
      hasLaunchVariable: (name: string): boolean =>
        this.recordLaunchVariables.get(currentRecord())?.has(name) === true,
      get mcpServers() {
        return currentMcpServers();
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
            this.replacementRequested() &&
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

  // The Isomux MCP servers the transport adds at its next turn.
  get mcpServers(): AgentMcpServer[] {
    return this.currentMcpServers;
  }

  updateMcpServers(mcpServers: AgentMcpServer[]): void {
    this.currentMcpServers = mcpServers;
  }

  // A session's shell commands get the environment the server would start
  // with from this env, without the server's secrets (1010dd4b): the
  // member's variables reach an agent at its next conversation, while the
  // server keeps the env it started with.
  toolEnvironment(
    env: Record<string, string | undefined> | undefined,
  ): Record<string, string> {
    return openCodeToolEnvironment(
      this.serverLaunchEnv(launchEnvFor(env)),
      this.profileDir,
    );
  }

  // The env the helper starts a server from: the agent user's own and the
  // member's variables. An agent token is a per-agent capability and never
  // part of the shared server's env.
  private serverLaunchEnv(
    launchEnv: Record<string, string | undefined>,
  ): Record<string, string | undefined> {
    return {
      ...getAgentHost().baseEnv(),
      ...launchEnv,
      ISOMUX_AGENT_TOKEN: undefined,
    };
  }

  // The skill folders OpenCode's own skill tool reads. A changed list
  // changes the config revision, so the next acquire replaces the server.
  updateSkillPaths(paths: string[]): boolean {
    return this.updateConfiguration({ ...this.config, skills: [...paths] });
  }

  updateConfiguration(config: Record<string, unknown>): boolean {
    const next = { ...config, update: "disable" };
    const revision = this.computeConfigRevision(next);
    if (revision === this.configRevision) return false;
    this.config = next;
    this.configRevision = revision;
    return true;
  }

  // Saved settings, with the env and MCP servers the next session start
  // passes. An MCP change reaches the next turn without a new server. A
  // changed env requests a replacement, for what OpenCode itself reads from
  // its environment (provider keys, {env:} in configs, local MCP commands);
  // it runs now on a server where nothing runs, else when the last turn or
  // hold ends.
  updateSettings(
    launchEnv: Record<string, string | undefined>,
    environmentRevision: string,
    mcpServers: AgentMcpServer[],
  ): void {
    this.updateMcpServers(mcpServers);
    if (this.updateLaunchEnvironment(launchEnv, environmentRevision))
      this.replaceOnceIdle();
  }

  // Resolves once no running server has older revisions than the current
  // ones: at once when none runs, else after the replacement that the last
  // turn or hold to end runs. A replacement that failed ends the wait too.
  async waitUntilCurrent(): Promise<void> {
    while (this.recordStale()) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.currentWaiters.add(resolve);
      this.replaceOnceIdle();
      await promise;
      if (this.activeTurns === 0 && this.holds === 0) return;
    }
  }

  private wakeCurrentWaiters(): void {
    const waiters = [...this.currentWaiters];
    this.currentWaiters.clear();
    for (const wake of waiters) wake();
  }

  // A member's reload: a new server process. 2.1.4 also reloads a folder's
  // plugins and config when their files change (core/src/config/watch.ts),
  // but only a new process starts again what OpenCode reads at start.
  // "reloaded": the server stopped, and retained leases have a new one.
  // "pending": the last turn or hold to end replaces it.
  async requestReload(): Promise<"reloaded" | "pending"> {
    this.reloadRequested = true;
    if (this.activeTurns > 0 || this.holds > 0) return "pending";
    return (await this.replaceIdleServer()) ? "reloaded" : "pending";
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
    const launchEnv = this.serverLaunchEnv(this.launchEnv);
    const { stdout, stderr, exitCode } = await host.run(this.helperCommand(), {
      cwd: this.serverCwd,
      env: {
        ...launchEnv,
        ...this.helperLockEnvironment(),
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
    this.recordLaunchVariables.set(
      this.record,
      new Set(
        Object.entries(launchEnv)
          .filter(([, value]) => value)
          .map(([name]) => name),
      ),
    );
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
        // Do not adopt a server started with the layers of OpenCode 1. Its
        // binary path differs too; this keeps the rule if that ever changes.
        .update("opencode 2 layers")
        .digest("hex")
    );
  }

  // A replacement is requested while the running server has other revisions
  // than the current ones, after a member's reload, or while the marker
  // exists. It never stops a
  // running turn or held work and never waits for them: meanwhile it stays
  // pending, and new turns and acquires use the current server. The last turn
  // or hold to end replaces it (replaceOnceIdle). ownHolds: the caller's own
  // holds, which do not count.
  private async replaceServerIfRequested(
    ownHolds = 0,
  ): Promise<"none" | "pending" | "replaced"> {
    const marker = join(this.profileDir, "server.replace");
    if (!this.replacementPromise) {
      if (
        !this.replacementRequested() &&
        !(await getAgentHost().fs.exists(marker))
      )
        return "none";
    }
    // Another caller can have started the replacement during that await.
    if (!this.replacementPromise) {
      if (this.activeTurns > 0 || this.holds > ownHolds) return "pending";
      this.replacementPromise = (async () => {
        await this.shutdown();
        // A reload asked for during the shutdown is met too: the next server
        // starts after it.
        this.reloadRequested = false;
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

  private replacementRequested(): boolean {
    return this.recordStale() || this.reloadRequested;
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
    void this.replaceIdleServer()
      .catch(() => {
        console.error(
          "[opencode] Server replacement after the last turn failed.",
        );
      })
      // A waiter checks again: a failed replacement leaves it waiting for
      // the next turn or hold to end.
      .finally(() => this.wakeCurrentWaiters());
  }

  // True when the replacement ran.
  private async replaceIdleServer(): Promise<boolean> {
    if ((await this.replaceServerIfRequested()) !== "replaced") return false;
    if (this.leases > 0 && !this.record) await this.ensureServer();
    return true;
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
    ?.updateSettings(launchEnvFor(env), environmentRevision, mcpServers);
}

// A change a turn must not start without (the office sign-in fallback): the
// existing supervisor takes the new inputs and the caller waits until its
// server runs with them. No supervisor in this process: no server of this
// process runs, and the next acquire starts one with the new inputs.
export async function awaitOpenCodeServerSettings(
  environmentKey: string,
  env: Record<string, string | undefined> | undefined,
  environmentRevision: string,
  mcpServers: AgentMcpServer[],
): Promise<void> {
  const supervisor = environmentSupervisors.get(supervisorKey(environmentKey));
  if (!supervisor) return;
  supervisor.updateSettings(launchEnvFor(env), environmentRevision, mcpServers);
  await supervisor.waitUntilCurrent();
}

// A member's /reload-plugins for the server of this environment key. With no
// supervisor in this process, no server of this process runs, but one an
// earlier process left would be adopted with the old plugins: the
// server.replace marker makes the next acquire stop it instead. No profile
// folder: nothing ever ran, and none is created.
export async function reloadOpenCodeServer(
  environmentKey: string,
): Promise<"reloaded" | "pending"> {
  const supervisor = environmentSupervisors.get(supervisorKey(environmentKey));
  if (supervisor) return supervisor.requestReload();
  const { profileDir } = openCodeProfilePaths(environmentKey);
  const host = getAgentHost();
  if (await host.fs.exists(profileDir))
    await host.fs.writeText(join(profileDir, "server.replace"), "", {
      mode: 0o600,
    });
  return "reloaded";
}

// `mcpServers` undefined keeps the list the profile's supervisor has: callers
// that do not start an agent session (a model list, a transcript read) must
// not drop the servers.
export function openCodeSupervisorForEnvironment(
  environmentKey: string | undefined,
  env: Record<string, string | undefined> | undefined,
  environmentRevision = "default",
  mcpServers?: AgentMcpServer[],
  // Undefined keeps the list the supervisor has, as for mcpServers.
  skillPaths?: string[],
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
      mcpServers: mcpServers ?? [],
      skillPaths,
    });
    environmentSupervisors.set(key, supervisor);
  } else {
    if (mcpServers) supervisor.updateMcpServers(mcpServers);
    if (skillPaths) supervisor.updateSkillPaths(skillPaths);
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
