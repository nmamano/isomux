import { snapshotOfficeDatabase } from "./sqlite-snapshot.ts";
import { OFFICE_DATABASE } from "./audit-store.ts";
// Backup of ~/.isomux to a verified local tarball. The office owner sets how
// often (default every 24 hours), how many copies to keep (default 7) and the
// folder; ISOMUX_BACKUP_DIR, when set, fixes the folder. Each check reads the
// settings once, so a change needs no restart.
//
// A backup is published in three steps: write a uniquely named partial file,
// walk the whole archive with `tar -tzf`, then rename it and write a verification
// marker. The marker records the final file's size and mtime, when the run
// started (the interval counts from that) and the office's state root (two
// offices can share a folder; each counts only its own). A final file with
// no matching marker is not a backup: the process may have stopped between the
// rename and the marker write, or an older release may have written it directly.
// The next tick verifies such legacy/orphaned files before it trusts them.
//
// Retention runs only after publication and considers only verified finals. A
// failed run therefore cannot displace a good backup. Restore is documented in
// internal-docs/backup-restore.md.

import { basename, dirname, isAbsolute, join, relative } from "path";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  closeSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { errMessage } from "../shared/errors.ts";
import {
  BACKEND_CREDENTIAL_PATHS,
  type BackendCredentialPath,
} from "./backend-credential-paths.ts";
import { STATE_ROOT } from "./config.ts";
import { loadBackupSettingsRaw, saveBackupSettingsRaw } from "./persistence.ts";

const RETENTION = 7;
const HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = HOUR_MS;
// The newest backup is stale this long after one interval has passed.
const HEALTH_SLACK_MS = 2 * HOUR_MS;
const FIRST_BACKUP_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const MIN_HEADROOM_BYTES = 256 * 1024 * 1024; // 256 MiB
const FILENAME_PATTERN = /^isomux-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.tar\.gz$/;
const PARTIAL_PATTERN = /^\.isomux-backup-.*\.partial$/;

// Next to the state root and named after it: ~/.isomux backs up to
// ~/isomux-backups, as it always has. An office started with its own
// ISOMUX_HOME gets its own folder, so its retention never prunes another
// office's backups.
export function defaultBackupDir(stateRoot: string): string {
  return join(
    dirname(stateRoot),
    `${basename(stateRoot).replace(/^\./, "")}-backups`,
  );
}

// The three backup settings, kept in office-config.json. dir null means the
// default folder. ISOMUX_BACKUP_DIR, when set, wins over dir.
export interface BackupSettings {
  intervalHours: number;
  retention: number;
  dir: string | null;
}

// An omitted field keeps its value; dir null resets the folder.
export interface BackupSettingsInput {
  intervalHours?: number;
  retention?: number;
  dir?: string | null;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  intervalHours: 24,
  retention: RETENTION,
  dir: null,
};

export const BACKUP_INTERVAL_HOURS_RANGE = { min: 1, max: 720 } as const;
export const BACKUP_RETENTION_RANGE = { min: 1, max: 100 } as const;

export type BackupDirSource = "env" | "setting" | "default";

// ISOMUX_BACKUP_DIR, then the setting, then the folder next to the state root.
export function resolveBackupDir(
  envDir: string | undefined,
  settingDir: string | null,
  stateRoot: string,
): { dir: string; source: BackupDirSource } {
  if (envDir) return { dir: envDir, source: "env" };
  if (settingDir) return { dir: settingDir, source: "setting" };
  return { dir: defaultBackupDir(stateRoot), source: "default" };
}

function inRange(
  value: unknown,
  range: { min: number; max: number },
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

// The stored settings, with defaults for absent or invalid fields.
export function loadBackupSettings(): BackupSettings {
  const raw = loadBackupSettingsRaw();
  return {
    intervalHours: inRange(raw.intervalHours, BACKUP_INTERVAL_HOURS_RANGE)
      ? raw.intervalHours
      : DEFAULT_BACKUP_SETTINGS.intervalHours,
    retention: inRange(raw.retention, BACKUP_RETENTION_RANGE)
      ? raw.retention
      : DEFAULT_BACKUP_SETTINGS.retention,
    dir:
      typeof raw.dir === "string" && isAbsolute(raw.dir)
        ? raw.dir
        : DEFAULT_BACKUP_SETTINGS.dir,
  };
}

// A snapshot of the settings for one run. A save during a run never changes
// the folder or the count the run already holds.
function currentBackupConfig(
  envDir: string | undefined = process.env.ISOMUX_BACKUP_DIR,
  stateRoot: string = STATE_ROOT,
): BackupConfig {
  const settings = loadBackupSettings();
  const { dir, source } = resolveBackupDir(envDir, settings.dir, stateRoot);
  return Object.freeze({
    backupDir: dir,
    backupDirFromEnv: source === "env",
    stateRootParent: dirname(stateRoot),
    stateRootName: basename(stateRoot),
    retention: settings.retention,
    intervalMs: settings.intervalHours * HOUR_MS,
    firstBackupMinFreeBytes: FIRST_BACKUP_MIN_FREE_BYTES,
    minHeadroomBytes: MIN_HEADROOM_BYTES,
  });
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// The real path `dir` has or will have once created: the real path of its
// nearest existing ancestor plus the rest.
function prospectiveRealPath(dir: string): string {
  let existing = dir;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

// null when `dir` can hold backups; otherwise why not. Creates the folder.
function backupDirError(dir: string, stateRoot: string): string | null {
  if (!isAbsolute(dir)) return "the backup folder must be an absolute path";
  const realRoot = existsSync(stateRoot) ? realpathSync(stateRoot) : stateRoot;
  const insideRoot = (path: string) =>
    isInside(path, realRoot) || isInside(path, stateRoot);
  const outside = "the backup folder must be outside the office state folder";
  try {
    // Checked before the mkdir too, so a refused folder is never created
    // inside the state root.
    if (insideRoot(prospectiveRealPath(dir))) return outside;
    mkdirSync(dir, { recursive: true });
    if (insideRoot(realpathSync(dir))) return outside;
    accessSync(dir, fsConstants.W_OK);
  } catch (err) {
    return `the backup folder cannot be used: ${errMessage(err)}`;
  }
  return null;
}

export type SaveBackupSettingsResult =
  | { ok: true; status: BackupStatus; oldBackupsDir: string | null }
  | { ok: false; error: string };

// Validates the whole input before it writes anything. The folder must be
// absolute, creatable and writable, and its real path must not be the state
// root or inside it. A folder change is refused while ISOMUX_BACKUP_DIR is
// set. A run that already started keeps the settings it started with.
export function saveBackupSettings(
  input: BackupSettingsInput,
  opts: { stateRoot?: string; envDir?: string | undefined } = {},
): SaveBackupSettingsResult {
  const stateRoot = opts.stateRoot ?? STATE_ROOT;
  const envDir = "envDir" in opts ? opts.envDir : process.env.ISOMUX_BACKUP_DIR;
  const current = loadBackupSettings();
  const next: BackupSettings = { ...current };
  if (input.intervalHours !== undefined) {
    if (!inRange(input.intervalHours, BACKUP_INTERVAL_HOURS_RANGE))
      return {
        ok: false,
        error: `intervalHours must be a whole number from ${BACKUP_INTERVAL_HOURS_RANGE.min} to ${BACKUP_INTERVAL_HOURS_RANGE.max}`,
      };
    next.intervalHours = input.intervalHours;
  }
  if (input.retention !== undefined) {
    if (!inRange(input.retention, BACKUP_RETENTION_RANGE))
      return {
        ok: false,
        error: `retention must be a whole number from ${BACKUP_RETENTION_RANGE.min} to ${BACKUP_RETENTION_RANGE.max}`,
      };
    next.retention = input.retention;
  }
  if (input.dir !== undefined && input.dir !== current.dir) {
    if (envDir)
      return {
        ok: false,
        error: "ISOMUX_BACKUP_DIR sets the backup folder",
      };
    if (input.dir !== null) {
      if (typeof input.dir !== "string")
        return { ok: false, error: "dir must be a path or null" };
      const error = backupDirError(input.dir, stateRoot);
      if (error) return { ok: false, error };
    }
    next.dir = input.dir;
  }
  const before = resolveBackupDir(envDir, current.dir, stateRoot).dir;
  try {
    saveBackupSettingsRaw(next);
  } catch (err) {
    return {
      ok: false,
      error: `could not save the backup settings: ${errMessage(err)}`,
    };
  }
  const config = currentBackupConfig(envDir, stateRoot);
  requestBackupTick();
  return {
    ok: true,
    status: statusFromDisk(
      config,
      Date.now(),
      lastAttemptAt,
      lastAttemptError,
      running,
    ),
    oldBackupsDir: config.backupDir === before ? null : before,
  };
}

let schedulerStarted = false;

// Runs one scheduler check now, so a shorter interval acts at once. Does
// nothing when the scheduler did not start (test and harness boots).
export function requestBackupTick(): void {
  if (schedulerStarted) void tick();
}

// Whether a backup is due at `now`: the interval is counted from the time the
// newest verified backup STARTED (its marker), or its mtime for an older
// marker that has no start time. Counted from the finish, an hourly check
// one interval after the start would find it not quite due and wait an hour.
function backupDue(config: BackupConfig, now: number): boolean {
  const newest = newestVerifiedBackup(config);
  if (!newest) return true;
  return now - (newest.startedAt ?? newest.mtimeMs) >= config.intervalMs;
}

export function backupDueForTest(
  overrides: Partial<BackupConfig>,
  now: number,
): boolean {
  return backupDue({ ...currentBackupConfig(), ...overrides }, now);
}

let lastAttemptAt: number | null = null;
let lastAttemptError: string | null = null;
let running = false;
// Folders whose leftovers from a stopped process were removed. Each folder is
// prepared once, before this process can own a partial in it.
const preparedDirs = new Set<string>();

export interface BackupStatus {
  backupDir: string;
  // ISOMUX_BACKUP_DIR set the folder.
  backupDirFromEnv: boolean;
  retention: number;
  intervalHours: number;
  lastBackupAt: number | null;
  lastBackupOk: boolean | null;
  lastBackupError: string | null;
  lastBackupFile: string | null;
  running: boolean;
}

export interface BackupConfig {
  backupDir: string;
  backupDirFromEnv: boolean;
  stateRootParent: string;
  stateRootName: string;
  retention: number;
  intervalMs: number;
  firstBackupMinFreeBytes: number;
  minHeadroomBytes: number;
}

interface BackupDeps {
  now(): number;
  spawn(argv: string[]): Subprocess;
  availableBytes(dir: string): number;
  // Defaults to asking `tar --version`.
  tarFlavor?(): Promise<TarFlavor>;
}

interface Subprocess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

// GNU tar on Linux; bsdtar (libarchive) is the macOS system tar. They differ in
// the options below and in what a non-zero exit means.
type TarFlavor = "gnu" | "bsd";

const DEFAULT_DEPS: BackupDeps = {
  now: () => Date.now(),
  spawn: (argv) => Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }),
  availableBytes: (dir) => {
    const fs = statfsSync(dir);
    // Bun 1.3.11 on Intel macOS returns statfs with its fields shifted
    // (bsize 0), checked 2026-09-26. df gives the same number portably.
    if (Number(fs.bsize) > 0) return Number(fs.bavail) * Number(fs.bsize);
    return dfAvailableBytes(dir);
  },
};

export function dfAvailableBytes(dir: string): number {
  const df = Bun.spawnSync(["df", "-Pk", dir], { stderr: "pipe" });
  const kib = Number(
    df.stdout.toString().trim().split("\n").at(-1)?.split(/\s+/)[3],
  );
  if (df.exitCode !== 0 || !Number.isFinite(kib))
    throw new Error(
      `could not read free space: df exit ${df.exitCode}: ${df.stderr.toString().trim()}`,
    );
  return kib * 1024;
}

async function detectTarFlavor(): Promise<TarFlavor> {
  const tar = Bun.spawn(["tar", "--version"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [version] = await Promise.all([
    new Response(tar.stdout).text(),
    tar.exited,
  ]);
  if (/bsdtar|libarchive/.test(version)) return "bsd";
  if (/GNU tar/.test(version)) return "gnu";
  throw new Error(
    `unsupported tar: ${version.split("\n")[0] || "no version output"}`,
  );
}

interface VerifiedBackup {
  file: string;
  path: string;
  size: number;
  mtimeMs: number;
  // When the run that wrote it started. Absent in markers from older
  // releases and for archives certified after the fact.
  startedAt?: number;
  // The state root of the office that wrote it. Absent as for startedAt.
  office?: string;
}

interface VerificationMarker {
  size: number;
  mtimeMs: number;
  startedAt?: number;
  office?: string;
}

// The office a marker names: its state root. Two offices can share a backup
// folder, and each one's retention, status and schedule count only its own
// archives, plus the unnamed ones from before markers named an office.
function officeOf(config: BackupConfig): string {
  return join(config.stateRootParent, config.stateRootName);
}

interface BackupExclusion {
  id: string;
  archivePatterns: (stateRootName: string) => string[];
}

function rootedDirectory(root: string, path: string): string[] {
  return [`${root}/${path}`, `${root}/${path}/*`];
}

function backendExclusions(entry: BackendCredentialPath): BackupExclusion[] {
  if (entry.backup === "keep") return [];
  return [{ id: entry.id, archivePatterns: entry.archivePatterns }];
}

// One list drives the tar exclusions. Locations are rooted because GNU
// tar exclusion wildcards otherwise match the same directory name inside an
// app's customer-owned data. Backend credential names use the shared matcher
// from backend-credential-paths.ts and can occur in a configured home at any
// depth. Transcripts and logs stay: they can incidentally contain user text,
// but they are not credential stores and removing them would destroy history
// without making an archive secret-free.
const BACKUP_EXCLUSIONS: readonly BackupExclusion[] = [
  {
    id: "app-runtime-credentials",
    archivePatterns: (root) => rootedDirectory(root, "apps/units"),
  },
  // The container app supervisor keeps each app's raw token beside its runtime
  // state (deploy/container/supervisor.py); the .tmp is the token mid-write.
  {
    id: "container-app-tokens",
    archivePatterns: (root) => [
      `${root}/container-runtime/*.token.json`,
      `${root}/container-runtime/*.token.tmp`,
    ],
  },
  {
    id: "personal-environment",
    archivePatterns: (root) => rootedDirectory(root, "user-env"),
  },
  // The whole directory, so a temp file mid-write stays out too.
  {
    id: "office-environment",
    archivePatterns: (root) => rootedDirectory(root, "office-env"),
  },
  // Secret values (internal-docs/secrets-design.md), office and members.
  {
    id: "secret-store",
    archivePatterns: (root) => rootedDirectory(root, "secrets"),
  },
  // Remote MCP server registrations (integrations A2): the URL path of some
  // hosted servers carries a token. After a restore, members add them again.
  {
    id: "mcp-server-registrations",
    archivePatterns: (root) => rootedDirectory(root, "mcp-servers"),
  },
  {
    id: "codex-shell-snapshots",
    archivePatterns: (root) => [
      ...rootedDirectory(root, "codex-home/shell_snapshots"),
      `${root}/*/.codex/shell_snapshots`,
      `${root}/*/.codex/shell_snapshots/*`,
      `${root}/*/codex-home/shell_snapshots`,
      `${root}/*/codex-home/shell_snapshots/*`,
      `${root}/provider-homes/*/codex/shell_snapshots`,
      `${root}/provider-homes/*/codex/shell_snapshots/*`,
    ],
  },
  // Webhook signing secrets (D5). After a restore, the owner rotates once per
  // hook. The temp file is the secrets file in the middle of a write.
  {
    id: "webhook-secrets",
    archivePatterns: (root) => [
      `${root}/webhooks/secrets.json`,
      `${root}/webhooks/secrets.json.tmp`,
    ],
  },
  // The pager's Discord webhook URLs. After a restore, each member enters
  // theirs again.
  {
    id: "pager-discord-webhooks",
    archivePatterns: (root) => [
      `${root}/pager-settings.json`,
      `${root}/pager-settings.json.tmp`,
      `${root}/pager-settings.json.corrupt-*`,
    ],
  },
  // The Web Push VAPID private key and the device endpoints. After a
  // restore, the server makes new keys and members turn notifications on
  // again.
  {
    id: "web-push",
    archivePatterns: (root) => [
      `${root}/web-push.json`,
      `${root}/web-push.json.tmp`,
      `${root}/web-push.json.corrupt-*`,
    ],
  },
  {
    id: "legacy-tls-key",
    archivePatterns: (root) => [`${root}/tls/cert.key`],
  },
  ...BACKEND_CREDENTIAL_PATHS.flatMap(backendExclusions),
];

export function getBackupStatus(): BackupStatus {
  return statusFromDisk(
    currentBackupConfig(),
    Date.now(),
    lastAttemptAt,
    lastAttemptError,
    running,
  );
}

function statusFromDisk(
  config: BackupConfig,
  now: number,
  attemptAt: number | null,
  attemptError: string | null,
  isRunning: boolean,
): BackupStatus {
  const newest = newestVerifiedBackup(config);
  const newestAt = newest?.mtimeMs ?? null;
  const staleAfterMs = config.intervalMs + HEALTH_SLACK_MS;
  const stale = newestAt !== null && now - newestAt >= staleAfterMs;
  const failedAfterNewest =
    attemptError !== null &&
    attemptAt !== null &&
    (newestAt === null || attemptAt > newestAt);
  return {
    backupDir: config.backupDir,
    backupDirFromEnv: config.backupDirFromEnv,
    retention: config.retention,
    intervalHours: config.intervalMs / (60 * 60 * 1000),
    lastBackupAt: failedAfterNewest ? attemptAt : newestAt,
    lastBackupOk:
      newestAt === null
        ? failedAfterNewest
          ? false
          : null
        : !failedAfterNewest && !stale,
    lastBackupError: failedAfterNewest
      ? attemptError
      : stale
        ? `newest verified backup is more than ${staleAfterMs / HOUR_MS} hours old`
        : null,
    lastBackupFile: newest?.file ?? null,
    running: isRunning,
  };
}

function markerPath(archivePath: string): string {
  return `${archivePath}.verified.json`;
}

function invalidMarkerPath(archivePath: string): string {
  return `${archivePath}.invalid.json`;
}

function readVerifiedBackup(dir: string, file: string): VerifiedBackup | null {
  if (!FILENAME_PATTERN.test(file)) return null;
  const path = join(dir, file);
  try {
    const stat = statSync(path);
    const marker = JSON.parse(
      readFileSync(markerPath(path), "utf8"),
    ) as VerificationMarker;
    // A 0-byte archive is never a backup, whatever its marker says. Older
    // releases verified such files on macOS, where bsdtar lists them as
    // empty archives.
    if (
      stat.size === 0 ||
      marker.size !== stat.size ||
      marker.mtimeMs !== stat.mtimeMs
    )
      return null;
    return {
      file,
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(typeof marker.startedAt === "number"
        ? { startedAt: marker.startedAt }
        : {}),
      ...(typeof marker.office === "string" ? { office: marker.office } : {}),
    };
  } catch {
    return null;
  }
}

// This office's verified backups in its folder, oldest first.
function listVerifiedBackups(config: BackupConfig): VerifiedBackup[] {
  const dir = config.backupDir;
  if (!existsSync(dir)) return [];
  const office = officeOf(config);
  return readdirSync(dir)
    .map((file) => readVerifiedBackup(dir, file))
    .filter(
      (item): item is VerifiedBackup =>
        item !== null && (item.office === undefined || item.office === office),
    )
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
}

function newestVerifiedBackup(config: BackupConfig): VerifiedBackup | null {
  return listVerifiedBackups(config).at(-1) ?? null;
}

function dateStr(now: number): string {
  const d = new Date(now);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function allocateFinalPath(dir: string, now: number): string {
  const stem = `isomux-${dateStr(now)}`;
  let sequence = 1;
  for (;;) {
    const suffix = sequence === 1 ? "" : `-${sequence}`;
    const path = join(dir, `${stem}${suffix}.tar.gz`);
    if (!existsSync(path) && !existsSync(markerPath(path))) return path;
    sequence++;
  }
}

function partialPath(dir: string, now: number): string {
  return join(
    dir,
    `.isomux-backup-${process.pid}-${now}-${Math.random().toString(36).slice(2)}.partial`,
  );
}

// A state root named like a glob (".isomux[1]") must match only itself, or
// its credential exclusions would miss. Both tars honor a backslash escape.
function escapeGlob(name: string): string {
  return name.replace(/[\\*?[\]]/g, "\\$&");
}

function archiveExclusionArgs(stateRootName: string): string[] {
  return BACKUP_EXCLUSIONS.flatMap((entry) =>
    entry
      .archivePatterns(escapeGlob(stateRootName))
      .map((pattern) => `--exclude=${pattern}`),
  );
}

function prepareBackupDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  // This runs once, before the scheduler can own a partial. A partial can
  // survive only when the previous server process died during tar, so every
  // matching file here is an orphan that the new process must reclaim.
  for (const file of readdirSync(dir)) {
    if (file.startsWith(".sqlite-snapshot-")) {
      rmSync(join(dir, file), { recursive: true, force: true });
      continue;
    }
    if (!PARTIAL_PATTERN.test(file)) continue;
    unlinkSync(join(dir, file));
  }
}

function requiredFreeBytes(
  newest: VerifiedBackup | null,
  config: BackupConfig,
): number {
  if (!newest) return config.firstBackupMinFreeBytes;
  return newest.size + Math.max(config.minHeadroomBytes, newest.size / 4);
}

async function runTar(
  argv: string[],
  deps: BackupDeps,
): Promise<{
  exitCode: number;
  stderr: string;
  firstLine: string;
}> {
  const proc = deps.spawn(argv);
  const [exitCode, stderr, firstLine] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    readFirstLine(proc.stdout),
  ]);
  return { exitCode, stderr: stderr.trim().slice(0, 500), firstLine };
}

// Reads the whole stream, so a long listing never blocks tar on a full pipe,
// but keeps only its first line.
async function readFirstLine(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let head = "";
  let complete = false;
  for await (const chunk of stream) {
    if (complete) continue;
    head += decoder.decode(chunk, { stream: true });
    const end = head.indexOf("\n");
    if (end >= 0) {
      head = head.slice(0, end);
      complete = true;
    }
  }
  return head;
}

function writeMarker(
  archivePath: string,
  run?: { startedAt: number; office: string },
): void {
  const stat = statSync(archivePath);
  const finalMarker = markerPath(archivePath);
  const tempMarker = `${finalMarker}.${process.pid}.tmp`;
  try {
    const fd = openSync(tempMarker, "wx", 0o600);
    try {
      writeFileSync(
        fd,
        `${JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, ...run })}\n`,
      );
    } finally {
      closeSync(fd);
    }
    renameSync(tempMarker, finalMarker);
    try {
      unlinkSync(invalidMarkerPath(archivePath));
    } catch {}
  } finally {
    try {
      unlinkSync(tempMarker);
    } catch {}
  }
}

function invalidMarkerMatches(archivePath: string): boolean {
  try {
    const stat = statSync(archivePath);
    const marker = JSON.parse(
      readFileSync(invalidMarkerPath(archivePath), "utf8"),
    ) as VerificationMarker;
    return marker.size === stat.size && marker.mtimeMs === stat.mtimeMs;
  } catch {
    return false;
  }
}

function writeInvalidMarker(archivePath: string): void {
  const stat = statSync(archivePath);
  writeFileSync(
    invalidMarkerPath(archivePath),
    `${JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs })}\n`,
    { mode: 0o600 },
  );
}

async function verifyArchive(
  path: string,
  stateRootName: string,
  deps: BackupDeps,
): Promise<void> {
  const checked = await runTar(["tar", "-tzf", path], deps);
  if (checked.exitCode !== 0) {
    throw new Error(
      `archive verification exit ${checked.exitCode}: ${checked.stderr || "no error text"}`,
    );
  }
  // bsdtar lists an empty file as an empty archive and exits 0. A real backup
  // starts with the state root directory.
  if (checked.firstLine !== `${stateRootName}/`) {
    throw new Error(
      `archive verification: first entry is ${JSON.stringify(checked.firstLine)}, expected "${stateRootName}/"`,
    );
  }
}

async function certifyUnmarkedArchives(
  config: BackupConfig,
  deps: BackupDeps,
): Promise<void> {
  if (!existsSync(config.backupDir)) return;
  const candidates = readdirSync(config.backupDir)
    .filter((file) => FILENAME_PATTERN.test(file))
    .filter((file) => !readVerifiedBackup(config.backupDir, file))
    .map((file) => ({ file, path: join(config.backupDir, file) }))
    .filter((candidate) => !invalidMarkerMatches(candidate.path))
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  for (const candidate of candidates) {
    try {
      await verifyArchive(candidate.path, config.stateRootName, deps);
      writeMarker(candidate.path);
    } catch (err) {
      writeInvalidMarker(candidate.path);
      console.error(
        `[backup] existing archive ${candidate.file} is not verified: ${errMessage(err)}`,
      );
    }
  }
}

function pruneVerified(config: BackupConfig): void {
  const files = listVerifiedBackups(config);
  while (files.length > config.retention) {
    const oldest = files.shift()!;
    unlinkSync(oldest.path);
    unlinkSync(markerPath(oldest.path));
  }
}

export async function runBackupOnceForTest(
  overrides: Partial<BackupConfig>,
  deps: BackupDeps,
): Promise<string> {
  return runBackup({ ...currentBackupConfig(), ...overrides }, deps);
}

export function backupStatusForTest(
  overrides: Partial<BackupConfig>,
  now: number,
): BackupStatus {
  return statusFromDisk(
    { ...currentBackupConfig(), ...overrides },
    now,
    null,
    null,
    false,
  );
}

export function prepareBackupDirectoryForTest(dir: string): void {
  prepareBackupDirectory(dir);
}

async function runBackup(
  config: BackupConfig,
  deps: BackupDeps = DEFAULT_DEPS,
): Promise<string> {
  mkdirSync(config.backupDir, { recursive: true });
  await certifyUnmarkedArchives(config, deps);
  const newest = newestVerifiedBackup(config);
  const required = requiredFreeBytes(newest, config);
  const available = deps.availableBytes(config.backupDir);
  if (available < required) {
    throw new Error(
      `not enough free space: ${available} bytes available, ${Math.ceil(required)} required; existing verified backups were kept`,
    );
  }

  const flavor = await (deps.tarFlavor ?? detectTarFlavor)();
  const now = deps.now();
  const partial = partialPath(config.backupDir, now);
  const final = allocateFinalPath(config.backupDir, now);
  const staging = mkdtempSync(join(config.backupDir, ".sqlite-snapshot-"));
  const stagedRoot = join(staging, config.stateRootName);
  const database = join(
    config.stateRootParent,
    config.stateRootName,
    OFFICE_DATABASE,
  );
  const hasDatabase = existsSync(database);
  try {
    if (hasDatabase) {
      mkdirSync(stagedRoot, { mode: 0o700 });
      await snapshotOfficeDatabase(
        database,
        join(stagedRoot, ".office-snapshot"),
      );
    }
    // Reserve the target at its final privacy mode before tar writes. GNU tar
    // truncates an existing file without changing its mode, so the archive is
    // never group/world-readable during a long write. Rename preserves it.
    closeSync(openSync(partial, "wx", 0o600));
    const created = await runTar(
      [
        "tar",
        "-czf",
        partial,
        // bsdtar rejects these two, and its exclusions are always globs.
        // Unanchored at the start, its patterns can only exclude more.
        ...(flavor === "gnu" ? ["--anchored", "--wildcards"] : []),
        ...archiveExclusionArgs(config.stateRootName),
        ...[
          OFFICE_DATABASE,
          OFFICE_DATABASE + "-wal",
          OFFICE_DATABASE + "-shm",
        ].map(
          (name) => `--exclude=${escapeGlob(config.stateRootName)}/${name}`,
        ),
        ...(hasDatabase
          ? flavor === "gnu"
            ? ["--transform=s|/\\.office-snapshot$|/office.sqlite|"]
            : ["-s", "|/\\.office-snapshot$|/office.sqlite|"]
          : []),
        "-C",
        config.stateRootParent,
        config.stateRootName,
        ...(hasDatabase
          ? ["-C", staging, `${config.stateRootName}/.office-snapshot`]
          : []),
      ],
      deps,
    );
    // GNU tar exits 1 only when a file changed while it was read. bsdtar
    // exits 1 for every error, so any non-zero bsdtar exit is a failure.
    if (created.exitCode >= 2 || (flavor === "bsd" && created.exitCode !== 0)) {
      throw new Error(
        `tar exit ${created.exitCode}: ${created.stderr || "no error text"}`,
      );
    }
    if (created.exitCode === 1) {
      console.warn(
        "[backup] tar exit 1 (file changed during archive; verifying before publication)",
      );
    }
    chmodSync(partial, 0o600);
    await verifyArchive(partial, config.stateRootName, deps);
    renameSync(partial, final);
    writeMarker(final, { startedAt: now, office: officeOf(config) });
    pruneVerified(config);
    return basename(final);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    try {
      unlinkSync(partial);
    } catch {}
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // One snapshot of the settings for the whole check and run.
    const config = currentBackupConfig();
    if (!preparedDirs.has(config.backupDir)) {
      lastAttemptAt = Date.now();
      prepareBackupDirectory(config.backupDir);
      preparedDirs.add(config.backupDir);
      lastAttemptError = null;
    }
    // On the first run after this feature ships, certify a legacy archive
    // before deciding it is due. Otherwise an upgrade would read the newest
    // archive once to verify it and immediately write a duplicate.
    await certifyUnmarkedArchives(config, DEFAULT_DEPS);
    if (!backupDue(config, Date.now())) return;
    lastAttemptAt = Date.now();
    const file = await runBackup(config);
    lastAttemptError = null;
    console.log(`[backup] wrote and verified ${file}`);
  } catch (err) {
    lastAttemptError = errMessage(err);
    console.error("[backup] failed; existing verified backups were kept:", err);
  } finally {
    running = false;
  }
}

export function startBackupScheduler() {
  // A low-space refusal happens before tar reads the state root. Retrying it
  // hourly is therefore a cheap statfs check, not an hourly full archive.
  schedulerStarted = true;
  void tick();
  setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

/** Test-only visibility for names that must never be counted as backups. */
export function isBackupPartialForTest(file: string): boolean {
  return PARTIAL_PATTERN.test(file);
}
