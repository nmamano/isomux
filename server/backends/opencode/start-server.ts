import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  linuxProcessIdentityMatches,
  parseLinuxProcessState,
  readLinuxProcessStartTicks,
} from "./process-identity.ts";

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

const OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS = 2_000;

const profileDir = required("OPENCODE_PROFILE_DIR");
const recordPath = required("OPENCODE_SERVER_RECORD");
const action = process.env.OPENCODE_SERVER_ACTION ?? "start";
const prior = await readRecord();
if (action === "stop") {
  if (prior) await stop(prior);
  await writeFile(recordPath, "", { mode: 0o600 });
  await chmod(recordPath, 0o600);
  process.stdout.write(JSON.stringify({ stopped: prior?.pid ?? null }));
  process.exit(0);
}
const binary = required("OPENCODE_BINARY");
const password = required("OPENCODE_SERVER_PASSWORD");
const serverCwd = required("OPENCODE_SERVER_CWD");
const configPath = required("OPENCODE_CONFIG");
const environmentRevision = required("OPENCODE_ENVIRONMENT_REVISION");
// Keep this below the stop early-return. Stop intentionally receives only the
// action, profile and record; requiring start-only state above it breaks the
// replacement path that this revision protects.
const configRevision = required("OPENCODE_CONFIG_REVISION");
const username = "isomux";
const keepDebugOutput = process.env.ISOMUX_OPENCODE_DEBUG === "1";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function authHeader(secret: string): string {
  return `Basic ${btoa(`${username}:${secret}`)}`;
}

async function healthy(record: ServerRecord): Promise<boolean> {
  if (
    record.binary !== binary ||
    record.profileDir !== profileDir ||
    record.environmentRevision !== environmentRevision ||
    record.configRevision !== configRevision
  )
    return false;
  try {
    process.kill(record.pid, 0);
    const response = await fetch(
      `http://127.0.0.1:${record.port}/global/health`,
      {
        headers: { authorization: authHeader(record.password) },
        signal: AbortSignal.timeout(OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as {
      healthy?: boolean;
      version?: string;
    };
    return response.ok && body.healthy === true && body.version === "1.18.23";
  } catch {
    return false;
  }
}

async function readRecord(): Promise<ServerRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath, "utf8")) as ServerRecord;
  } catch {
    return null;
  }
}

async function stop(record: ServerRecord): Promise<void> {
  if (!linuxProcessIdentityMatches(record.pid, record.startTicks)) {
    process.stderr.write(
      `Refusing to signal unverifiable OpenCode process ${record.pid}.\n`,
    );
    return;
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 40; i++) {
    if (!(await running(record.pid))) return;
    if (!linuxProcessIdentityMatches(record.pid, record.startTicks)) return;
    await Bun.sleep(25);
  }
  try {
    if (linuxProcessIdentityMatches(record.pid, record.startTicks))
      process.kill(record.pid, "SIGKILL");
  } catch {}
}

async function running(pid: number): Promise<boolean> {
  try {
    const state = parseLinuxProcessState(
      await readFile(`/proc/${pid}/stat`, "utf8"),
    );
    return state !== "Z";
  } catch {
    return false;
  }
}

async function waitHealthy(
  child: ChildProcess,
  port: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null || !child.pid) return false;
    try {
      process.kill(child.pid, 0);
      const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
        headers: { authorization: authHeader(password) },
        signal: AbortSignal.timeout(300),
      });
      const body = (await response.json()) as {
        healthy?: boolean;
        version?: string;
      };
      if (response.ok && body.healthy && body.version === "1.18.23")
        return true;
    } catch {}
    await Bun.sleep(50);
  }
  return false;
}

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("OPENCODE_") && name !== "ISOMUX_OPENCODE_DEBUG",
    ),
  );
}

function bindFailure(stderr: string): boolean {
  return /EADDRINUSE|address already in use/i.test(stderr);
}

await mkdir(profileDir, { recursive: true });
if (prior && (await healthy(prior))) {
  const startTicks = readLinuxProcessStartTicks(prior.pid);
  if (startTicks) {
    if (prior.startTicks !== startTicks) {
      prior.startTicks = startTicks;
      await writeFile(recordPath, `${JSON.stringify(prior)}\n`, {
        mode: 0o600,
      });
      await chmod(recordPath, 0o600);
    }
    process.stdout.write(
      JSON.stringify({ pid: prior.pid, port: prior.port, adopted: true }),
    );
    process.exit(0);
  }
}
if (prior) await stop(prior);

let started: ServerRecord | null = null;
for (let attempt = 0; attempt < 40; attempt++) {
  const port = 22000 + Math.floor(Math.random() * 1000);
  const debugDir = await mkdtemp(join(tmpdir(), "isomux-opencode-debug-"));
  const stdoutPath = join(debugDir, "stdout.log");
  const stderrPath = join(debugDir, "stderr.log");
  const stdout = await open(stdoutPath, "w", 0o600);
  const stderr = await open(stderrPath, "w", 0o600);
  const child = spawn(
    binary,
    [
      "serve",
      "--pure",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--print-logs",
      "--log-level",
      "INFO",
    ],
    {
      cwd: serverCwd,
      detached: true,
      // OC1 logs raw provider errors, including response bodies. Startup output
      // goes only to a private /tmp file. It is unlinked as soon as the server
      // is healthy unless an operator explicitly enables debug capture.
      stdio: ["ignore", stdout.fd, stderr.fd],
      env: {
        ...sanitizedChildEnvironment(),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: join(profileDir, "home"),
        XDG_CONFIG_HOME: join(profileDir, "config"),
        XDG_DATA_HOME: join(profileDir, "data"),
        XDG_STATE_HOME: join(profileDir, "state"),
        XDG_CACHE_HOME: join(profileDir, "cache"),
        OPENCODE_CONFIG: configPath,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      },
    },
  );
  child.on("error", () => {});
  await Promise.all([stdout.close(), stderr.close()]);
  child.unref();
  let identityLostAfterHealth = false;
  if (child.pid && (await waitHealthy(child, port))) {
    const startTicks = readLinuxProcessStartTicks(child.pid);
    if (startTicks) {
      started = {
        pid: child.pid,
        port,
        password,
        binary,
        profileDir,
        environmentRevision,
        configRevision,
        startTicks,
      };
      if (!keepDebugOutput)
        await rm(debugDir, { recursive: true, force: true });
      break;
    }
    identityLostAfterHealth = true;
  }
  if (child.pid)
    await stop({
      pid: child.pid,
      port,
      password,
      binary,
      profileDir,
      environmentRevision,
      configRevision,
      startTicks: readLinuxProcessStartTicks(child.pid) ?? undefined,
    });
  const startupError = await readFile(stderrPath, "utf8").catch(() => "");
  if (!keepDebugOutput) await rm(debugDir, { recursive: true, force: true });
  if (identityLostAfterHealth) continue;
  if (!bindFailure(startupError)) {
    const debugAdvice = keepDebugOutput
      ? ` Debug output is in ${debugDir}.`
      : " Set ISOMUX_OPENCODE_DEBUG=1 to keep private startup output under /tmp.";
    throw new Error(
      `Pinned OpenCode server failed during startup.${debugAdvice}`,
    );
  }
}
if (!started)
  throw new Error(
    "Pinned OpenCode server did not start in the reserved port range 22000-22999.",
  );
await writeFile(recordPath, `${JSON.stringify(started)}\n`, { mode: 0o600 });
await chmod(recordPath, 0o600);
process.stdout.write(
  JSON.stringify({ pid: started.pid, port: started.port, adopted: false }),
);
