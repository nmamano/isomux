import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  processDescendants,
  processIdentityMatches,
  processIsRunning,
  readProcessStartTicks,
} from "./process-identity.ts";
import { lockDarwinFileUntilExit } from "./darwin-libsystem.ts";
import { openCodeServerHealth } from "./server-health.ts";
import {
  OPENCODE_V2_DATABASE,
  openCodeConfigOverride,
  openCodeServerEnvironment,
  openCodeTmpDir,
} from "./config-layers.ts";
import { buildOpenCodeSafetyPlugin } from "./safety-plugin-build.ts";
import { openCodeSafetyPluginDir } from "./safety-plugin-tool.ts";
import {
  OPENCODE_LOG_ROTATE_BYTES,
  openCodeAuthHeader,
  openCodePortTaken,
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
  // Set while 2.1.4 still imports the OpenCode 1 sessions: such a server is
  // never adopted (a helper that died during the import left it).
  v1Import?: "running";
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
  JSON.parse(required("OPENCODE_SAFETY_ROOTS")) as Parameters<
    typeof buildOpenCodeSafetyPlugin
  >[0],
);
const safetyPlugin = createHash("sha256")
  .update(safetyPluginText)
  .digest("hex");
// 2.1.4 skips a plugin entry that names a file (gate S1): the plugin is a
// folder with an index.js.
const safetyPluginDir = openCodeSafetyPluginDir(profileDir);
const safetyPluginPath = join(safetyPluginDir, "index.js");
// openCodeDatabasePath in profile-paths.ts, which this helper cannot import.
const openCodeDataDir = join(profileDir, "data", "opencode");
const v1Database = join(openCodeDataDir, "opencode.db");
const v2Database = join(openCodeDataDir, OPENCODE_V2_DATABASE);

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
    record.pid === unresponsivePid ||
    record.v1Import !== undefined
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
  // 2.1.4 took up to 1.14 s to exit on SIGTERM with 16 turns (gate P7b), and
  // it stops its own shell tools on the way out.
  if (await exited(record, 3_000)) return;
  // 2.1.4 starts each shell tool as the leader of its own process group
  // (core/src/shell.ts:315), so the server's group does not hold them all.
  // Read them before the kill: a killed server's children get a new parent.
  const descendants = processDescendants(record.pid);
  killIfSame(-record.pid, record.pid, record.startTicks);
  killIfSame(record.pid, record.pid, record.startTicks);
  for (const hop of descendants) {
    killIfSame(-hop.pid, hop.pid, hop.startTicks);
    killIfSame(hop.pid, hop.pid, hop.startTicks);
  }
  await exited(record, 2_000);
}

// SIGKILL to target (a pid, or a process group as -pid) while pid is still
// the process that startTicks names.
function killIfSame(
  target: number,
  pid: number,
  startTicks: string | undefined,
): void {
  if (!processIdentityMatches(pid, startTicks)) return;
  try {
    process.kill(target, "SIGKILL");
  } catch {}
}

async function exited(record: ServerRecord, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!processIsRunning(record.pid)) return true;
    if (!processIdentityMatches(record.pid, record.startTicks)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
}

// A live process that a record without startTicks (written before they were
// recorded) names. It may be an OpenCode server that writes this profile's
// database. A record with startTicks names a process this user can read: a
// live pid with other or unreadable start ticks is a reused one.
function unverifiedLiveProcess(record: ServerRecord): boolean {
  if (record.startTicks) return false;
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  if (!pidExists(record.pid)) return false;
  // An unreadable start time can be another user's process, which this
  // helper cannot check either.
  if (readProcessStartTicks(record.pid) === null) return pidExists(record.pid);
  return processIsRunning(record.pid);
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

// 2.1.4 rewrites the database it opens, a version 1 one included (gate M5).
// So 2.1.4 runs on a copy, opencode-v2.db (OPENCODE_DB), made once, at the
// first start that is not an adoption, with no server running on the
// profile. opencode.db, its -wal and the log stay as OpenCode 1 left them,
// for a rollback to the previous release. A failed copy fails the start:
// 2.1.4 on an empty database would mark the profile migrated, and the
// history would never be copied.
async function copyVersionOneDatabase(): Promise<void> {
  if (existsSync(v2Database) || !existsSync(v1Database)) return;
  const log = join(openCodeDataDir, "log", "opencode.log");
  if (existsSync(log)) {
    const v1Log = join(openCodeDataDir, "log", "opencode-v1.log");
    await copyFile(log, v1Log);
    await chmod(v1Log, 0o600);
  }
  const next = `${v2Database}.tmp`;
  try {
    // A crash can leave a half copy, and VACUUM INTO needs an empty target.
    await rm(next, { force: true });
    // Read-only, so nothing checkpoints the -wal into opencode.db. Never
    // immutable=1: that reads opencode.db without its -wal.
    const source = new Database(v1Database, { readonly: true });
    try {
      source.query("VACUUM INTO ?").run(next);
    } finally {
      source.close();
    }
    await chmod(next, 0o600);
    await rename(next, v2Database);
  } catch (error) {
    await rm(next, { force: true });
    throw new Error(
      `OpenCode did not start: Isomux could not copy its OpenCode 1 database for OpenCode 2 (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
}

// 2.1.4 imports the OpenCode 1 sessions of its database in the background
// after it answers health (core/src/database/v1-migration.bun.ts): 2.3-3.3 s
// for 28 sessions on a 241 MB database, 2026-10-25. Until the import ends, a
// stored session is not there yet. The record counts once the import
// completed, and opencode-v2.db.ready tells storage.ts that the file holds
// every session. A database without OpenCode 1 sessions answers "completed"
// at once. Returns null when the import completed, else the reason.
const OPENCODE_V1_IMPORT_LIMIT_MS = 10 * 60_000;

async function waitForV1Import(record: ServerRecord): Promise<string | null> {
  const deadline = Date.now() + OPENCODE_V1_IMPORT_LIMIT_MS;
  while (Date.now() < deadline) {
    if (!processIsRunning(record.pid))
      return "OpenCode did not start: it exited while it imported its OpenCode 1 conversations. Send your message again to retry.";
    let response: Response;
    try {
      response = await fetch(
        `http://127.0.0.1:${record.port}/api/experimental/migration/v1`,
        {
          headers: { authorization: openCodeAuthHeader(record.password) },
          signal: AbortSignal.timeout(2_000),
        },
      );
    } catch (error) {
      // A server busy with the import can answer late.
      if ((error as { name?: unknown } | null)?.name === "TimeoutError")
        continue;
      return "OpenCode did not start: it did not report its import of OpenCode 1 conversations.";
    }
    const body = (await response.json().catch(() => null)) as {
      status?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok || !body)
      return `OpenCode did not start: it did not report its import of OpenCode 1 conversations (HTTP ${response.status}).`;
    if (body.status === "completed") return null;
    if (body.status === "error")
      return `OpenCode did not start: it could not import its OpenCode 1 conversations (${typeof body.error === "string" ? body.error : "no details"}).`;
    // "required" after health: the import ended without completing, and no
    // later answer of this server changes that.
    if (body.status !== "running")
      return "OpenCode did not start: its import of OpenCode 1 conversations stopped before the end. Send your message again to retry.";
    await Bun.sleep(100);
  }
  return "OpenCode did not start: its import of OpenCode 1 conversations took over 10 minutes. Send your message again to continue it.";
}

async function writeRecord(record: ServerRecord | null): Promise<void> {
  await writeFile(recordPath, record ? `${JSON.stringify(record)}\n` : "", {
    mode: 0o600,
  });
  await chmod(recordPath, 0o600);
}

// T8: 2.1.4 needs an explicit port (no port 0). Another process can take it
// before the server binds; openCodePortTaken reads that case.
async function freeLoopbackPort(): Promise<number> {
  const socket = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = socket.port;
  socket.stop(true);
  return port;
}

await mkdir(profileDir, { recursive: true });
// The profile holds sign-ins (opencode.db) and OpenCode's log: owner-only, at
// every start and adoption, so an older profile converges too. The folder
// closes everything below it; the database files are owner-only as well, in
// case the folder mode is widened. A profile this user cannot change stays as
// it is: the server still starts.
try {
  await chmod(profileDir, 0o700);
  for (const database of [v1Database, v2Database])
    for (const file of [database, `${database}-wal`, `${database}-shm`])
      if (existsSync(file)) await chmod(file, 0o600);
} catch (error) {
  process.stderr.write(
    `The OpenCode profile keeps its modes: ${(error as NodeJS.ErrnoException).code ?? "error"}.\n`,
  );
}
// An adopted server can be importing the file for a new folder: a changed
// build replaces it in one rename, never by truncation. The temp file is
// outside the plugin folder, which 2.1.4 reads, and is removed when the
// rename fails.
await mkdir(safetyPluginDir, { recursive: true, mode: 0o700 });
await chmod(safetyPluginDir, 0o700);
if (
  (await readFile(safetyPluginPath, "utf8").catch(() => null)) !==
  safetyPluginText
) {
  const next = join(profileDir, `isomux-safety-plugin.index.js.${process.pid}`);
  try {
    await writeFile(next, safetyPluginText, { mode: 0o600 });
    await chmod(next, 0o600);
    await rename(next, safetyPluginPath);
  } catch (error) {
    await rm(next, { force: true });
    throw error;
  }
}
// The OpenCode 1 plugin file.
await rm(join(profileDir, "isomux-safety-plugin.js"), { force: true });
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
if (prior) {
  // A second server beside a live one splits the profile's history.
  if (unverifiedLiveProcess(prior))
    throw new Error(
      `Process ${prior.pid} may be an OpenCode server that is still running. Stop process ${prior.pid}, then try again.`,
    );
  await stop(prior);
}
await copyVersionOneDatabase();

// User and project plugins and config load as in a stock install; Isomux's
// own config is the file layer and the top layer, which also loads the
// safety plugin last.
const configOverride = JSON.stringify(
  openCodeConfigOverride(
    JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>,
    safetyPluginDir,
  ),
);
const tmpDir = openCodeTmpDir(profileDir);
await mkdir(tmpDir, { recursive: true, mode: 0o700 });
await chmod(tmpDir, 0o700);
// OpenCode appends every log line, provider error bodies included, to
// XDG_DATA_HOME/opencode/log/opencode.log (openCodeLogPath in
// profile-paths.ts) and never rotates it. This runs before the server does
// (an adoption exits above), so the folder exists owner-only before OpenCode
// writes into it, and no server writes the file while a log over
// OPENCODE_LOG_ROTATE_BYTES moves to opencode.log.1, replacing the one before.
// OpenCode opens the file for append, so a file made owner-only here stays
// that way; an older profile converges at its next start that is not an
// adoption. A log this user cannot change (another user's, from before split
// mode) stays as it is: the server still starts.
try {
  await mkdir(openCodeDataDir, { recursive: true });
  const openCodeLogDir = join(openCodeDataDir, "log");
  await mkdir(openCodeLogDir, { recursive: true, mode: 0o700 });
  await chmod(openCodeLogDir, 0o700);
  const openCodeLog = join(openCodeLogDir, "opencode.log");
  const size = await stat(openCodeLog).then(
    (info) => info.size,
    () => 0,
  );
  if (size > OPENCODE_LOG_ROTATE_BYTES) {
    await rename(openCodeLog, `${openCodeLog}.1`);
    await chmod(`${openCodeLog}.1`, 0o600);
  }
  await (await open(openCodeLog, "a", 0o600)).close();
  await chmod(openCodeLog, 0o600);
} catch (error) {
  process.stderr.write(
    `OpenCode's log keeps its modes: ${(error as NodeJS.ErrnoException).code ?? "error"}.\n`,
  );
}
let started: ServerRecord | null = null;
// R5: a lost port gets a new one, at most 3 times.
const OPENCODE_PORT_RETRIES = 3;
let lostPorts = 0;
// Retry only when a healthy child exits before its identity can be captured,
// or when another process took its port.
for (let attempt = 0; attempt < 40; attempt++) {
  const port = await freeLoopbackPort();
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
      String(port),
      "--print-logs",
      // 2.1.4 refuses an uppercase level at start (T8).
      "--log-level",
      "info",
    ],
    {
      cwd: serverCwd,
      detached: true,
      // OpenCode logs raw provider errors, including response bodies. Its own
      // owner-only log above keeps the same lines. This private /tmp copy is
      // read for startup and unlinked as soon as the server is healthy unless
      // an operator explicitly enables debug capture.
      stdio: ["ignore", stdout.fd, stderr.fd],
      // One builder with the session's tool environment (supervisor.ts).
      env: openCodeServerEnvironment(process.env, {
        profileDir,
        configPath,
        configContent: configOverride,
        password,
      }),
    },
  );
  child.on("error", () => {});
  await Promise.all([stdout.close(), stderr.close()]);
  child.unref();
  let identityLostAfterHealth = false;
  const healthy = child.pid ? await waitHealthy(child, port, password) : false;
  if (child.pid && healthy) {
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
      port,
      password,
      binary,
      profileDir,
      environmentRevision,
      configRevision,
      startTicks: readProcessStartTicks(child.pid) ?? undefined,
    });
  const portTaken =
    child.exitCode === 1 &&
    openCodePortTaken(await readFile(stderrPath, "utf8").catch(() => ""), port);
  if (!keepDebugOutput) await rm(debugDir, { recursive: true, force: true });
  if (identityLostAfterHealth) continue;
  if (portTaken && lostPorts < OPENCODE_PORT_RETRIES) {
    lostPorts++;
    continue;
  }
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
// The record holds the server from here on, so a helper that dies during
// the import leaves no server unrecorded beside the next one (gate M1).
await writeRecord({ ...started, v1Import: "running" });
const importProblem = await waitForV1Import(started);
if (importProblem) {
  await stop(started);
  await writeRecord(null);
  throw new Error(importProblem);
}
const importedMarker = `${v2Database}.ready`;
if (!existsSync(importedMarker)) {
  await writeFile(importedMarker, "", { mode: 0o600 });
  await chmod(importedMarker, 0o600);
}
await writeRecord(started);
process.stdout.write(
  JSON.stringify({ pid: started.pid, port: started.port, adopted: false }),
);
