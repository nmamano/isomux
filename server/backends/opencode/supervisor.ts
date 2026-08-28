import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { STATE_ROOT } from "../../config.ts";
import { resolveOpenCodeBinary } from "./runtime.ts";

export const OPENCODE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

interface ServerRecord {
  pid: number;
  port: number;
  password: string;
  binary: string;
  profileDir: string;
}

export interface OpenCodeLease {
  baseUrl: string;
  authHeader: string;
  profileDir: string;
  pid: number;
  release(): void;
  beginTurn(): void;
  endTurn(): void;
}

export interface OpenCodeSupervisorOptions {
  profileDir?: string;
  binary?: string;
  config?: Record<string, unknown>;
  serverCwd?: string;
  idleShutdownMs?: number;
  launchEnv?: Record<string, string | undefined>;
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
  private readonly config: Record<string, unknown>;
  private readonly serverCwd: string;
  private readonly idleShutdownMs: number;
  private readonly launchEnv: Record<string, string | undefined>;

  constructor(options: OpenCodeSupervisorOptions = {}) {
    this.profileDir = options.profileDir ?? join(STATE_ROOT, "opencode", "profiles", "default");
    this.recordPath = join(this.profileDir, "server.lock");
    this.binary = options.binary ?? resolveOpenCodeBinary();
    this.config = options.config ?? { autoupdate: false, share: "disabled" };
    this.serverCwd = options.serverCwd ?? STATE_ROOT;
    this.idleShutdownMs = options.idleShutdownMs ?? OPENCODE_IDLE_SHUTDOWN_MS;
    this.launchEnv = options.launchEnv ?? {};
  }

  async acquire(): Promise<OpenCodeLease> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.shutdownPromise) await this.shutdownPromise;
    await this.ensureServer();
    this.leases++;
    let released = false;
    let turnActive = false;
    const record = this.record!;
    return {
      baseUrl: `http://127.0.0.1:${record.port}`,
      authHeader: `Basic ${btoa(`isomux:${record.password}`)}`,
      profileDir: this.profileDir,
      pid: record.pid,
      release: () => {
        if (released) return;
        released = true;
        this.leases--;
        this.armIdleReap();
      },
      beginTurn: () => {
        if (released || turnActive) return;
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

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
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
  const key = environmentKey
    ? createHash("sha256").update(environmentKey).digest("hex").slice(0, 16)
    : "default";
  let supervisor = environmentSupervisors.get(key);
  if (!supervisor) {
    supervisor = new OpenCodeSupervisor({
      profileDir: join(STATE_ROOT, "opencode", "profiles", key),
      launchEnv,
    });
    environmentSupervisors.set(key, supervisor);
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
