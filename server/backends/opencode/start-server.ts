import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  processIdentityMatches,
  processIsRunning,
  readProcessStartTicks,
} from "./process-identity.ts";
import { lockDarwinFileUntilExit } from "./darwin-libsystem.ts";
import { openCodeServerHealth } from "./server-health.ts";
import {
  markPluginSdkInstalled,
  openCodeConfigOverride,
  openCodeUserConfigDir,
} from "./config-layers.ts";
import { buildOpenCodeSafetyPlugin } from "./safety-plugin-build.ts";
import {
  OPENCODE_SERVER_USERNAME as username,
  waitHealthy,
} from "./server-startup.ts";

interface ServerRecord {
  pid: number;
  port: number;
  password: string;
  binary: string;
  profileDir: string;
  environmentRevision: string;
  configRevision: string;
  startTicks?: string;
  safetyPlugin?: string;
}

const profileDir = required("OPENCODE_PROFILE_DIR");
const recordPath = required("OPENCODE_SERVER_RECORD");
const action = process.env.OPENCODE_SERVER_ACTION ?? "start";
// macOS has no flock CLI, so there the supervisor asks this helper to take the
// record lock itself, before it reads or writes the record. Linux runs the
// helper under flock(1) instead.
if (process.env.OPENCODE_SERVER_LOCK === "self") lockRecord();
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
const keepDebugOutput = process.env.ISOMUX_OPENCODE_DEBUG === "1";
// A server whose turn saw no event-stream frame within the deadline. It may
// still answer health late, but it is never adopted again.
const unresponsivePid = Number(process.env.OPENCODE_SERVER_UNRESPONSIVE_PID);
// The office safety policy as an OpenCode plugin (safety-plugin.ts), built
// with the Isomux server's roots: this helper's HOME and environment carry the
// member's variables. A server that loaded another build is not adopted.
const safetyPluginText = await buildOpenCodeSafetyPlugin(
  JSON.parse(required("OPENCODE_SAFETY_ROOTS")),
);
const safetyPlugin = createHash("sha256")
  .update(safetyPluginText)
  .digest("hex");
const safetyPluginPath = join(profileDir, "isomux-safety-plugin.js");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function lockRecord(): void {
  if (!lockDarwinFileUntilExit(recordPath))
    throw new Error("Could not lock the OpenCode server record.");
}

async function adoptable(record: ServerRecord): Promise<boolean> {
  if (
    record.binary !== binary ||
    record.profileDir !== profileDir ||
    record.environmentRevision !== environmentRevision ||
    record.configRevision !== configRevision ||
    record.safetyPlugin !== safetyPlugin ||
    record.pid === unresponsivePid
  )
    return false;
  const health = await openCodeServerHealth(record);
  if (health === "healthy") return true;
  // A slow answer is not a dead server: stopping a busy one fails every turn
  // in flight on it.
  return (
    health === "busy" && processIdentityMatches(record.pid, record.startTicks)
  );
}

async function readRecord(): Promise<ServerRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath, "utf8")) as ServerRecord;
  } catch {
    return null;
  }
}

async function stop(record: ServerRecord): Promise<void> {
  if (!processIdentityMatches(record.pid, record.startTicks)) {
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
    if (!processIdentityMatches(record.pid, record.startTicks)) return;
    await Bun.sleep(25);
  }
  try {
    if (processIdentityMatches(record.pid, record.startTicks))
      process.kill(record.pid, "SIGKILL");
  } catch {}
}

async function running(pid: number): Promise<boolean> {
  return processIsRunning(pid);
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        (name === "OPENCODE_API_KEY" || !name.startsWith("OPENCODE_")) &&
        name !== "ISOMUX_OPENCODE_DEBUG",
    ),
  );
}

await mkdir(profileDir, { recursive: true });
// An adopted server can be importing the file for a new folder: a changed
// build replaces it in one rename, never by truncation.
if (
  (await readFile(safetyPluginPath, "utf8").catch(() => null)) !==
  safetyPluginText
) {
  const next = `${safetyPluginPath}.${process.pid}`;
  await writeFile(next, safetyPluginText, { mode: 0o600 });
  await chmod(next, 0o600);
  await rename(next, safetyPluginPath);
}
if (prior && (await adoptable(prior))) {
  const startTicks = readProcessStartTicks(prior.pid);
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

// User and project plugins and config load as in a stock install; Isomux's
// own config is the file layer and, without its MCP headers, the top layer,
// which also loads the safety plugin last. OpenCode creates and installs into
// every config folder it is given, so a missing user folder is left out.
const userConfigDir = openCodeUserConfigDir(process.env);
const configOverride = JSON.stringify(
  openCodeConfigOverride(
    JSON.parse(await readFile(configPath, "utf8")),
    pathToFileURL(safetyPluginPath).href,
  ),
);
// Before it loads a plugin, OpenCode installs its plugin SDK from npm into
// every config folder without one. Nothing in the profile's own folder uses
// it, and the safety plugin imports nothing, so the profile skips the install.
await markPluginSdkInstalled(join(profileDir, "config", "opencode"));
let started: ServerRecord | null = null;
// Retry only when a healthy child exits before its identity can be captured.
for (let attempt = 0; attempt < 40; attempt++) {
  const debugDir = await mkdtemp(join(tmpdir(), "isomux-opencode-debug-"));
  const stdoutPath = join(debugDir, "stdout.log");
  const stderrPath = join(debugDir, "stderr.log");
  const stdout = await open(stdoutPath, "w", 0o600);
  const stderr = await open(stderrPath, "w", 0o600);
  const child = spawn(
    binary,
    [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
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
        OPENCODE_CONFIG_CONTENT: configOverride,
        OPENCODE_CONFIG_DIR: existsSync(userConfigDir)
          ? userConfigDir
          : undefined,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        // share: "disabled" blocks new shares; this also stops existing-share sync.
        OPENCODE_DISABLE_SHARE: "1",
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      },
    },
  );
  child.on("error", () => {});
  await Promise.all([stdout.close(), stderr.close()]);
  child.unref();
  let identityLostAfterHealth = false;
  const port = child.pid
    ? await waitHealthy(child, stdoutPath, password)
    : null;
  if (child.pid && port !== null) {
    const startTicks = readProcessStartTicks(child.pid);
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
        safetyPlugin,
      };
      if (!keepDebugOutput)
        await rm(debugDir, { recursive: true, force: true });
      break;
    }
    identityLostAfterHealth = true;
  }
  if (child.pid && !childExited(child))
    await stop({
      pid: child.pid,
      port: port ?? 0,
      password,
      binary,
      profileDir,
      environmentRevision,
      configRevision,
      startTicks: readProcessStartTicks(child.pid) ?? undefined,
    });
  if (!keepDebugOutput) await rm(debugDir, { recursive: true, force: true });
  if (identityLostAfterHealth) continue;
  const debugAdvice = keepDebugOutput
    ? ` Debug output is in ${debugDir}.`
    : " Set ISOMUX_OPENCODE_DEBUG=1 to keep private startup output under /tmp.";
  throw new Error(
    `Pinned OpenCode server failed during startup.${debugAdvice}`,
  );
}
if (!started)
  throw new Error(
    "Pinned OpenCode server exited before its identity could be captured.",
  );
await writeFile(recordPath, `${JSON.stringify(started)}\n`, { mode: 0o600 });
await chmod(recordPath, 0o600);
process.stdout.write(
  JSON.stringify({ pid: started.pid, port: started.port, adopted: false }),
);
