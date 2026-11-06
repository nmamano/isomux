import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { getAgentHost } from "../../agent-host.ts";
import { ADMIN_SOCKET_PATH, STATE_ROOT } from "../../config.ts";
import { AGENT_ROOT } from "../../split/roots.ts";
import { runAtServerStop } from "../../server-stop.ts";
import { openCodeUnsupportedReason, resolveOpenCodeBinary } from "./runtime.ts";
import {
  openCodeConfigFilePath,
  openCodeProfilePaths,
} from "./profile-paths.ts";
import type { AgentMcpServer } from "../../mcp-servers.ts";
import {
  openCodeToolEnvironment,
  openCodeUserConfigDir,
} from "./config-layers.ts";
import { OPENCODE_ISOLATE_ENV, openCodeAuthHeader } from "./server-startup.ts";
import { ISOLATION_SETUP_FAILED } from "../../process-isolation.ts";
import {
  processIsolationNow,
  reportIsolationSetupFailure,
} from "../../process-isolation-state.ts";
import type { AgentAccess } from "../../../shared/agent-access.ts";
import {
  OPENCODE_STOP_AGENTS,
  openCodeStopAgentRules,
  type OpenCodeRule,
} from "./stop-rules.ts";
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
  // pid is the outer bwrap of a PID namespace (server/process-isolation.ts).
  isolated?: boolean;
}

// One server process: a start or a replacement gets a new identity, an
// adoption keeps it.
function recordIdentity(record: ServerRecord): string {
  return `${record.pid}:${record.startTicks ?? ""}`;
}

// The revision a server record carries: the session environment's, with the
// wrap form folded in, so turning isolation on or off replaces an idle
// server (adopted ones too) as a changed environment does.
export function openCodeServerRevision(
  environmentRevision: string,
  isolate: boolean,
): string {
  return isolate ? `${environmentRevision}:pid-namespace` : environmentRevision;
}

export const OPENCODE_CRON_AGENT = "isomux-cron";
export const OPENCODE_INTERACTIVE_BYPASS_AGENT = "isomux-interactive-bypass";

export type { OpenCodeRule };
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

// Isomux's config in the OpenCode 2 keys. Every agent Isomux starts sessions with
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
      // The stops below standard (task e77304b1). The session's rules add
      // the office tools by exact name.
      ...Object.fromEntries(
        Object.entries(OPENCODE_STOP_AGENTS).map(([stop, agent]) => [
          agent,
          {
            description: `Isomux agent at the ${stop} access level`,
            mode: "primary",
            permissions: openCodeStopAgentRules(stop as AgentAccess),
          },
        ]),
      ),
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
  // The member's config dir the server loads (OPENCODE_CONFIG_DIR), or null.
  readonly configDir: string | null;
  // Ends the hold acquire() takes. Until then, or until beginTurn counts the
  // turn, or release(), a pending replacement does not stop this server.
  settle(): void;
  release(): void;
  // release(), and when this acquire started the server and no lease, turn
  // or hold is left on it, stop it now instead of after the idle wait: for
  // work no member waits on (the model check).
  releaseAndStopIfStarted(): void;
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

// The work on a supervisor's server. Leases outlive a server (a replacement
// gives retained leases the new one), and holds exist while a start runs.
interface ServerUse {
  leases: number;
  turns: number;
  // Work on the server that no turn counts yet: an acquired lease until its
  // caller settles it, and a turn entry until the turn counts. A pending
  // replacement waits for it as it waits for turns.
  holds: number;
}

// The server process of a supervisor, with at most one start or stop in
// flight. `running` holds the last server a start gave; whether its process
// still lives is checked at each use. Its idle timer is armed exactly while
// nothing uses it (reconcileIdleTimer).
type ServerPhase =
  | { phase: "none" }
  | {
      phase: "starting";
      // The server the start replaces or adopts, until the start ends.
      previous: ServerRecord | null;
      done: Promise<void>;
      // A stop asked during the start: it runs as the start ends.
      stopAfter: boolean;
    }
  | {
      phase: "running";
      record: ServerRecord;
      idleTimer: ReturnType<typeof setTimeout> | null;
    }
  | {
      phase: "stopping";
      record: ServerRecord | null;
      // A replacement: done also covers the marker and the reload request.
      replace: boolean;
      done: Promise<void>;
    };

export class OpenCodeSupervisor {
  private readonly use: ServerUse = { leases: 0, turns: 0, holds: 0 };
  private server: ServerPhase = { phase: "none" };
  // The variables with a value in the env each server process started with.
  // An adopted server matched the environment revision, so it has that env.
  private readonly recordLaunchVariables = new WeakMap<
    ServerRecord,
    ReadonlySet<string>
  >();
  private unresponsive: { pid: number; afterPrompt: boolean } | null = null;
  // The leases the current server process has had, keyed by its identity:
  // each acquire reads the record again, so the object changes.
  private serverLeaseCount: { key: string; count: number } | null = null;
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
      await this.stopInFlight();
      const replacement = await this.replaceServerIfRequested(1);
      const replaceMarked = this.markReplaceable(this.use.turns > 0);
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
    this.changeUse("leases", 1);
    const serverIdentity = recordIdentity(this.record!);
    if (this.serverLeaseCount?.key !== serverIdentity)
      this.serverLeaseCount = { key: serverIdentity, count: 0 };
    this.serverLeaseCount.count++;
    let released = false;
    let turnActive = false;
    const initialRecord = this.record!;
    const currentRecord = () => this.record ?? initialRecord;
    const replacementPending = () => this.recordStale();
    const currentMcpServers = () => this.currentMcpServers;
    // As openCodeServerEnvironment sets it from the launch env.
    const configDir = (): string | null => {
      const dir = openCodeUserConfigDir(this.launchEnv);
      return existsSync(dir) ? dir : null;
    };
    const lease: OpenCodeLease = {
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
      get configDir() {
        return configDir();
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
        this.changeUse("leases", -1);
      },
      releaseAndStopIfStarted: () => {
        if (released) return;
        lease.release();
        // Only this lease ever used the server, and nothing is on it now.
        const record = this.record;
        if (
          !record ||
          recordIdentity(record) !== serverIdentity ||
          this.serverLeaseCount?.key !== serverIdentity ||
          this.serverLeaseCount.count !== 1 ||
          this.inUse()
        )
          return;
        this.shutdown().catch(() => {
          console.error("[opencode] Server stop after a listing failed.");
        });
      },
      beginTurn: async () => {
        if (released || turnActive) return;
        // The acquire's hold, or a new one, ends once the turn counts.
        const drop = entry ?? this.hold();
        entry = null;
        try {
          await this.replaceServerIfRequested(1);
          await this.stopInFlight();
          await this.validateServerForTurn(this.use.turns > 0);
          // A start this entry joined, or a turn that ended during it, can
          // leave a stale server that only this entry holds: replace it now.
          if (
            this.replacementRequested() &&
            (await this.replaceServerIfRequested(1)) === "replaced"
          )
            await this.validateServerForTurn(this.use.turns > 0);
          turnActive = true;
          this.changeUse("turns", 1);
        } finally {
          drop();
        }
      },
      recoverBeforePrompt: async () => {
        if (released || !turnActive) return;
        await this.validateServerForTurn(this.use.turns > 1, true);
      },
      endTurn: () => {
        if (!turnActive) return;
        turnActive = false;
        this.changeUse("turns", -1);
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
    return lease;
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
      if (this.use.turns === 0 && this.use.holds === 0) return;
    }
  }

  private wakeCurrentWaiters(): void {
    const waiters = [...this.currentWaiters];
    this.currentWaiters.clear();
    for (const wake of waiters) wake();
  }

  // A member's reload: a new server process. OpenCode also reloads a folder's
  // plugins and config when their files change (core/src/config/watch.ts),
  // but only a new process starts again what OpenCode reads at start.
  // "reloaded": the server stopped, and retained leases have a new one.
  // "pending": the last turn or hold to end replaces it.
  async requestReload(): Promise<"reloaded" | "pending"> {
    this.reloadRequested = true;
    if (this.use.turns > 0 || this.use.holds > 0) return "pending";
    return (await this.replaceIdleServer()) ? "reloaded" : "pending";
  }

  // Joins a stop in flight. A stop asked during a start runs as that start
  // ends, so no server from it outlives the stop.
  shutdown(): Promise<void> {
    const server = this.server;
    if (server.phase === "stopping") return server.done;
    if (server.phase === "starting") {
      server.stopAfter = true;
      return server.done
        .catch(() => undefined)
        .then(() => {
          const next = this.server;
          return next.phase === "stopping" ? next.done : this.shutdown();
        });
    }
    return this.beginStop(false);
  }

  // The server phase changes only through the methods below.

  // The last server a start gave, until a stop ends: during a start, the one
  // it replaces or adopts.
  private get record(): ServerRecord | null {
    const server = this.server;
    if (server.phase === "running" || server.phase === "stopping")
      return server.record;
    if (server.phase === "starting") return server.previous;
    return null;
  }

  private setServer(next: ServerPhase): void {
    const current = this.server;
    if (current.phase === "running" && current !== next && current.idleTimer)
      this.idleScheduler.clearTimeout(current.idleTimer);
    this.server = next;
    this.reconcileIdleTimer();
  }

  private inUse(): boolean {
    return this.use.leases > 0 || this.use.turns > 0 || this.use.holds > 0;
  }

  private changeUse(kind: keyof ServerUse, by: 1 | -1): void {
    this.use[kind] += by;
    this.reconcileIdleTimer();
  }

  // The idle timer is armed exactly while a server runs and nothing uses it.
  private reconcileIdleTimer(): void {
    const server = this.server;
    if (server.phase !== "running") return;
    if (this.inUse()) {
      if (server.idleTimer) this.idleScheduler.clearTimeout(server.idleTimer);
      server.idleTimer = null;
    } else {
      // A failed stop leaves the server running, with its idle stop armed
      // again; the scheduler does not handle a rejection.
      server.idleTimer ??= this.idleScheduler.setTimeout(
        () =>
          this.shutdown().catch(() => {
            console.error("[opencode] Idle server stop failed.");
          }),
        this.idleShutdownMs,
      );
    }
  }

  private async stopInFlight(): Promise<void> {
    const server = this.server;
    if (server.phase === "stopping") await server.done;
  }

  private beginStart(replaceMarked: boolean): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const previous = this.record;
    const starting: Extract<ServerPhase, { phase: "starting" }> = {
      phase: "starting",
      previous,
      done: promise,
      stopAfter: false,
    };
    this.setServer(starting);
    this.startServer(replaceMarked).then(
      (record) => {
        this.setServer({ phase: "running", record, idleTimer: null });
        this.stopAfterStart(starting);
        resolve();
      },
      (error: unknown) => {
        // As before the start: the helper may have stopped that server; its
        // liveness is checked at use.
        this.setServer(
          previous
            ? { phase: "running", record: previous, idleTimer: null }
            : { phase: "none" },
        );
        this.stopAfterStart(starting);
        reject(error);
      },
    );
    return promise;
  }

  private stopAfterStart(
    starting: Extract<ServerPhase, { phase: "starting" }>,
  ): void {
    if (!starting.stopAfter) return;
    // shutdown() waits on this stop and reports its failure.
    this.beginStop(false).catch(() => undefined);
  }

  // A replacement also ends the reload request and removes the marker
  // before the phase leaves stopping, so no caller sees it unmet.
  private beginStop(replace: boolean): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const record = this.record;
    this.setServer({ phase: "stopping", record, replace, done: promise });
    void (async () => {
      try {
        await this.performShutdown();
      } catch (error) {
        this.setServer(
          record
            ? { phase: "running", record, idleTimer: null }
            : { phase: "none" },
        );
        throw error;
      }
      try {
        if (replace) {
          // A reload asked for during the stop is met too: the next server
          // starts after it.
          this.reloadRequested = false;
          await getAgentHost().fs.rm(this.replaceMarkerPath);
        }
      } finally {
        this.setServer({ phase: "none" });
      }
    })().then(resolve, reject);
    return promise;
  }

  private async performShutdown(): Promise<void> {
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
  // are a pending replacement, made when the last turn or hold ends. A start
  // waits for a stop in flight. Without a start or stop to join, it starts.
  private async ensureServer(replaceMarked = false): Promise<void> {
    this.ensureServerSink();
    let joined = false;
    for (;;) {
      const server = this.server;
      if (server.phase === "starting" || server.phase === "stopping") {
        await server.done.catch(() => undefined);
        joined = true;
        continue;
      }
      const record = this.record;
      if (
        joined &&
        record &&
        processIdentityMatches(record.pid, record.startTicks) &&
        !(replaceMarked && record.pid === this.unresponsive?.pid)
      )
        return;
      await this.beginStart(replaceMarked);
      // A stop asked during this start runs now: start again after it.
      if (this.server.phase === "running") return;
      joined = true;
    }
  }

  // The revision a server started now gets: the shared server of a member's
  // OpenCode agents runs in its own PID namespace while isolation is on.
  private serverRevision(): string {
    return openCodeServerRevision(
      this.environmentRevision,
      processIsolationNow().state === "on",
    );
  }

  private async startServer(
    replaceMarked: boolean,
    retried = false,
  ): Promise<ServerRecord> {
    const binary = this.binary;
    const isolate = processIsolationNow().state === "on";
    const host = getAgentHost();
    await host.fs.mkdir(this.profileDir, 0o777);
    const configPath = openCodeConfigFilePath(this.profileDir);
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
        OPENCODE_ENVIRONMENT_REVISION: openCodeServerRevision(
          this.environmentRevision,
          isolate,
        ),
        [OPENCODE_ISOLATE_ENV]: isolate ? "1" : undefined,
        OPENCODE_CONFIG_REVISION: this.configRevision,
        OPENCODE_SERVER_UNRESPONSIVE_PID:
          replaceMarked && this.unresponsive
            ? String(this.unresponsive.pid)
            : undefined,
      },
    });
    if (exitCode !== 0) {
      // A wrap that the probe passed but bwrap could not set up: probe again,
      // and start once more in the form the new result gives.
      if (isolate && !retried && stderr.includes(ISOLATION_SETUP_FAILED)) {
        await reportIsolationSetupFailure();
        return this.startServer(replaceMarked, true);
      }
      throw new Error(`OpenCode startup failed: ${stderr.trim()}`);
    }
    JSON.parse(stdout);
    const record = await this.readRecord();
    if (!record)
      throw new Error("OpenCode startup did not write its server record.");
    this.recordLaunchVariables.set(
      record,
      new Set(
        Object.entries(launchEnv)
          .filter(([, value]) => value)
          .map(([name]) => name),
      ),
    );
    if (record.pid !== this.unresponsive?.pid) this.unresponsive = null;
    return record;
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
  // exists. It never stops a running turn or held work and never waits for
  // them: meanwhile it stays pending, and new turns and acquires use the
  // current server. The last turn or hold to end replaces it
  // (replaceOnceIdle). A start or stop in flight ends first, and the request
  // is read again after it. ownHolds: the caller's own holds, which do not
  // count.
  private async replaceServerIfRequested(
    ownHolds = 0,
  ): Promise<"none" | "pending" | "replaced"> {
    for (;;) {
      if (!this.replacing()) {
        if (
          !this.replacementRequested() &&
          !(await getAgentHost().fs.exists(this.replaceMarkerPath))
        )
          return "none";
      }
      // Another caller can have started the replacement during that await.
      const server = this.server;
      if (server.phase === "stopping" && server.replace) {
        await server.done;
        return "replaced";
      }
      if (this.use.turns > 0 || this.use.holds > ownHolds) return "pending";
      if (server.phase === "starting" || server.phase === "stopping") {
        await server.done.catch(() => undefined);
        continue;
      }
      await this.beginStop(true);
      return "replaced";
    }
  }

  private replacing(): boolean {
    return this.server.phase === "stopping" && this.server.replace;
  }

  private get replaceMarkerPath(): string {
    return join(this.profileDir, "server.replace");
  }

  // From the record, not a flag: a server that any start gave the current
  // revisions satisfies a request, and one that a start in flight brought up
  // with older revisions does not. No running server is not stale.
  private recordStale(): boolean {
    const record = this.record;
    return (
      record !== null &&
      (record.environmentRevision !== this.serverRevision() ||
        record.configRevision !== this.configRevision)
    );
  }

  private replacementRequested(): boolean {
    return this.recordStale() || this.reloadRequested;
  }

  private hold(): () => void {
    this.changeUse("holds", 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.changeUse("holds", -1);
      this.replaceOnceIdle();
    };
  }

  // At the end of a turn or hold: a pending replacement runs once neither is
  // left. Retained leases get the new server at once, as after a replacement
  // at acquire.
  private replaceOnceIdle(): void {
    if (this.use.turns > 0 || this.use.holds > 0) return;
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
    if (this.use.leases > 0 && !this.record) await this.ensureServer();
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
