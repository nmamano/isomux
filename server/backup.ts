// Backup of ~/.isomux to a folder copy in a local backup folder (task
// 1426371a; before it, a verified tarball). The office owner sets how often
// (default every 24 hours), how many copies to keep (default 7) and the
// folder; ISOMUX_BACKUP_DIR, when set, fixes the folder. Each check reads the
// settings once, so a change needs no restart. The layout of a copy is in
// server/backup-copies.ts; restore is in internal-docs/backup-restore.md.
//
// A run walks the state root once to plan, without the credential stores and
// what Isomux makes again (backup-exclusions.ts) and without the live
// database. A file with the same size, mtime and ctime as in the previous
// copy's manifest is a hard link to that copy's file; every other file is
// copied, and the database is a fresh snapshot. Every copy is whole, so any
// copy can be deleted by hand. The free-space check is from the plan, before
// any write, and again during the copy. On a filesystem without hard links
// every file is copied.
//
// The run writes into a 0700 partial folder, checks it against its manifest,
// writes the marker (backup.json) and then renames it: the rename publishes
// it. A file that is gone since the plan is skipped with a warning; a file
// or folder the office cannot read fails the run, as tar's "Cannot open" did.
// A file that changes during its copy is kept as copied, and its manifest
// line has no times, so the next run copies it again. Two source paths that
// are one inode become two files in the copy. Nothing changes a file after it
// is linked: every copy that shares it would change.
//
// Retention runs only after publication and counts only verified copies of
// this office: folder copies with a marker, and the tar.gz copies of older
// releases with a matching .verified.json, which age out. A failed run
// therefore cannot displace a good backup.

import { randomUUID } from "crypto";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";
import { basename, dirname, isAbsolute, join, relative, sep } from "path";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  closeSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  promises as fsp,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statfsSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { errMessage } from "../shared/errors.ts";
import { OFFICE_DATABASE } from "./audit-store.ts";
import { pacer } from "./backup-pacer.ts";
import {
  COPY_MANIFEST,
  COPY_MARKER,
  readCopyMarker,
  type CopyMarker,
} from "./backup-copies.ts";
import {
  BACKUP_EXCLUSIONS,
  escapeGlob,
  regenerableBackupPaths,
  tarGlobSource,
} from "./backup-exclusions.ts";
import { STATE_ROOT } from "./config.ts";
import { memberSpaceExcluded } from "./member-space-exclusions.ts";
import { MOVE_MEMBERS_DIR } from "./office-move.ts";
import {
  copyMemberSpace,
  findPreviousMemberTree,
  type MemberBackupSource,
  type MemberCopyResult,
  type PreviousMemberTree,
} from "./member-backup.ts";
import { loadBackupSettingsRaw, saveBackupSettingsRaw } from "./persistence.ts";
import { snapshotOfficeDatabase } from "./sqlite-snapshot.ts";

const RETENTION = 7;
const HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = HOUR_MS;
// The newest backup is stale this long after one interval has passed.
const HEALTH_SLACK_MS = 2 * HOUR_MS;
// The margin the free-space check keeps, and how often (in bytes copied)
// the run checks again.
const MIN_HEADROOM_BYTES = 256 * 1024 * 1024; // 256 MiB
const FILENAME_PATTERN = /^isomux-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.tar\.gz$/;
const PARTIAL_PATTERN = /^\.isomux-backup-.*\.partial$/;

/** An entry a backup run makes in the backup folder: a copy (a tar.gz or a
 *  folder), its check record, a partial copy, a database snapshot. An office
 *  move deletes these of the new machine's empty office
 *  (office-move-swap.ts), and nothing else of the folder. */
export function isBackupEntryName(name: string): boolean {
  return (
    /^isomux-\d{4}-\d{2}-\d{2}(?:-\d+)?(?:\.tar\.gz(?:\.verified\.json|\.invalid\.json)?)?$/.test(
      name,
    ) ||
    PARTIAL_PATTERN.test(name) ||
    name.startsWith(".sqlite-snapshot-")
  );
}

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

/** The backup folder now: the owner export keeps its files in it. */
export function currentBackupDir(): string {
  return currentBackupConfig().backupDir;
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

// Why a settings input is refused on its shape alone, or null: the interval
// and the count in range, the folder an absolute path or null. It touches no
// disk, so the backup-settings ask (server/step-asks.ts) checks with it at
// create; the save checks the folder itself after it.
export function backupSettingsShapeError(input: {
  intervalHours?: unknown;
  retention?: unknown;
  dir?: unknown;
}): string | null {
  if (
    input.intervalHours !== undefined &&
    !inRange(input.intervalHours, BACKUP_INTERVAL_HOURS_RANGE)
  )
    return `intervalHours must be a whole number from ${BACKUP_INTERVAL_HOURS_RANGE.min} to ${BACKUP_INTERVAL_HOURS_RANGE.max}`;
  if (
    input.retention !== undefined &&
    !inRange(input.retention, BACKUP_RETENTION_RANGE)
  )
    return `retention must be a whole number from ${BACKUP_RETENTION_RANGE.min} to ${BACKUP_RETENTION_RANGE.max}`;
  if (input.dir !== undefined && input.dir !== null) {
    if (typeof input.dir !== "string") return "dir must be a path or null";
    if (!isAbsolute(input.dir))
      return "the backup folder must be an absolute path";
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
  const shape = backupSettingsShapeError(input);
  if (shape) return { ok: false, error: shape };
  if (input.intervalHours !== undefined)
    next.intervalHours = input.intervalHours;
  if (input.retention !== undefined) next.retention = input.retention;
  if (input.dir !== undefined && input.dir !== current.dir) {
    if (envDir)
      return {
        ok: false,
        error: "ISOMUX_BACKUP_DIR sets the backup folder",
      };
    if (input.dir !== null) {
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
  // The members of the newest copy whose space it did not copy in its run
  // (carried from an earlier copy, or skipped), by name.
  membersSkipped?: string[];
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
  minHeadroomBytes: number;
}

export interface BackupDeps {
  now(): number;
  // Called before the run and again during the copy, so a test can make
  // space run out mid-run.
  availableBytes(dir: string): number;
  // Only the check of an older tar.gz copy (`tar -tzf`) spawns.
  spawn?(argv: string[]): Subprocess;
  // Hard-links an unchanged file to the previous copy's file (fs.linkSync).
  link?: (existing: string, newPath: string) => void;
  // Copies a new or changed file (fs.promises.copyFile).
  copyFile?: (src: string, dst: string) => Promise<void>;
  // Runs after the plan walk and before the first write.
  afterPlan?(): void | Promise<void>;
}

interface Subprocess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

const DEFAULT_DEPS: Required<BackupDeps> = {
  now: () => Date.now(),
  spawn: (argv) => Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }),
  availableBytes: (dir) => {
    const fs = statfsSync(dir);
    // Bun 1.3.11 on Intel macOS returns statfs with its fields shifted
    // (bsize 0), checked 2026-09-26. df gives the same number portably.
    if (Number(fs.bsize) > 0) return Number(fs.bavail) * Number(fs.bsize);
    return dfAvailableBytes(dir);
  },
  link: (existing, newPath) => linkSync(existing, newPath),
  // A reflink where the filesystem has them (btrfs, XFS), else a copy.
  copyFile: (src, dst) => fsp.copyFile(src, dst, fsConstants.COPYFILE_FICLONE),
  afterPlan: () => {},
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

interface VerifiedBackup {
  kind: "folder" | "tar";
  file: string;
  path: string;
  // When it finished: the marker's finishedAt for a folder copy, the
  // archive's mtime for a tar.gz.
  mtimeMs: number;
  // When the run that wrote it started. Absent in tar.gz markers from older
  // releases and for archives certified after the fact.
  startedAt?: number;
  // The state root of the office that wrote it. Absent as for startedAt.
  office?: string;
  // A folder copy's id (backup-copies.ts).
  id?: string;
}

interface VerificationMarker {
  size: number;
  mtimeMs: number;
  startedAt?: number;
  office?: string;
}

// The office a marker names: its state root. Two offices can share a backup
// folder, and each one's retention, status and schedule count only its own
// copies, plus the unnamed tar.gz ones from before markers named an office.
function officeOf(config: BackupConfig): string {
  return join(config.stateRootParent, config.stateRootName);
}

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
    ...membersSkippedOf(newest),
  };
}

// The members the newest copy did not copy, by name, when there are any.
function membersSkippedOf(newest: VerifiedBackup | null): {
  membersSkipped?: string[];
} {
  if (newest?.kind !== "folder") return {};
  const marker = readCopyMarker(dirname(newest.path), newest.file);
  const ids = marker?.membersSkipped ?? [];
  if (ids.length === 0) return {};
  const sources = memberSources;
  return {
    membersSkipped: ids.map((id) => (sources ? sources.name(id) : id)),
  };
}

// The isolated members whose agent space each copy also holds
// (member-backup.ts), set at boot. Null: no member's space.
export interface BackupMemberSources {
  list(): MemberBackupSource[];
  name(userId: string): string;
}
let memberSources: BackupMemberSources | null = null;

export function setBackupMemberSources(next: BackupMemberSources | null): void {
  memberSources = next;
}

// ---- Older tar.gz copies -------------------------------------------------
// Releases before task 1426371a wrote tar.gz archives. They stay readable,
// count in retention beside the folder copies and age out; none is written.

function markerPath(archivePath: string): string {
  return `${archivePath}.verified.json`;
}

function invalidMarkerPath(archivePath: string): string {
  return `${archivePath}.invalid.json`;
}

function readVerifiedArchive(dir: string, file: string): VerifiedBackup | null {
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
      kind: "tar",
      file,
      path,
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

function readVerifiedFolder(dir: string, file: string): VerifiedBackup | null {
  const marker = readCopyMarker(dir, file);
  if (!marker) return null;
  return {
    kind: "folder",
    file,
    path: join(dir, file),
    mtimeMs: marker.finishedAt,
    startedAt: marker.startedAt,
    office: marker.office,
    id: marker.id,
  };
}

// This office's verified backups of both kinds in its folder, oldest first.
function listVerifiedBackups(config: BackupConfig): VerifiedBackup[] {
  const dir = config.backupDir;
  if (!existsSync(dir)) return [];
  const office = officeOf(config);
  return readdirSync(dir)
    .map(
      (file) => readVerifiedFolder(dir, file) ?? readVerifiedArchive(dir, file),
    )
    .filter(
      (item): item is VerifiedBackup =>
        item !== null && (item.office === undefined || item.office === office),
    )
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
}

function newestVerifiedBackup(config: BackupConfig): VerifiedBackup | null {
  return listVerifiedBackups(config).at(-1) ?? null;
}

function writeMarker(archivePath: string): void {
  const stat = statSync(archivePath);
  const finalMarker = markerPath(archivePath);
  const tempMarker = `${finalMarker}.${process.pid}.tmp`;
  try {
    const fd = openSync(tempMarker, "wx", 0o600);
    try {
      writeFileSync(
        fd,
        `${JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs })}\n`,
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

async function runTar(
  argv: string[],
  deps: BackupDeps,
): Promise<{
  exitCode: number;
  stderr: string;
  firstLine: string;
}> {
  const proc = (deps.spawn ?? DEFAULT_DEPS.spawn)(argv);
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

// A tar.gz with no matching marker: the process may have stopped between the
// rename and the marker write, or an older release may have written it
// directly. It is walked once; a valid one gets a marker and joins retention,
// an invalid one gets an .invalid.json marker and is checked again only when
// its size or mtime changes.
async function certifyUnmarkedArchives(
  config: BackupConfig,
  deps: BackupDeps,
): Promise<void> {
  if (!existsSync(config.backupDir)) return;
  const candidates = readdirSync(config.backupDir)
    .filter((file) => FILENAME_PATTERN.test(file))
    .filter((file) => !readVerifiedArchive(config.backupDir, file))
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

// ---- Folder copies -------------------------------------------------------

function dateStr(now: number): string {
  const d = new Date(now);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// The day's next name: after every name of that day in the folder, of both
// kinds, so names grow through the day even after a prune or a copy deleted
// by hand, and a folder copy never takes the name of a tar.gz.
function allocateFinalPath(dir: string, now: number): string {
  const stem = `isomux-${dateStr(now)}`;
  const same = new RegExp(
    `^${stem}(?:-(\\d+))?(?:\\.tar\\.gz(?:\\.verified\\.json|\\.invalid\\.json)?)?$`,
  );
  let last = 0;
  for (const name of readdirSync(dir)) {
    const match = same.exec(name);
    if (match) last = Math.max(last, match[1] ? Number(match[1]) : 1);
  }
  return join(dir, last === 0 ? stem : `${stem}-${last + 1}`);
}

function partialPath(dir: string, now: number): string {
  return join(
    dir,
    `.isomux-backup-${process.pid}-${now}-${Math.random().toString(36).slice(2)}.partial`,
  );
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

// Sets u+rwx on each folder of a tree, so a read-only folder (a Go module
// cache is 0555) can be emptied. Symlinks are never followed.
function* foldersToOpen(root: string): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    try {
      const mode = lstatSync(dir).mode;
      if ((mode & 0o700) !== 0o700) chmodSync(dir, (mode & 0o7777) | 0o700);
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) stack.push(join(dir, entry.name));
    } catch {}
    yield dir;
  }
}

// Removes a copy or a partial: a folder (its read-only folders opened first)
// or a file (a partial of an older release). Paced, and the removal itself
// runs off the event loop: a partial can hold as many entries as the state
// root.
async function removeCopyTree(path: string): Promise<void> {
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    const pace = pacer();
    for (const _ of foldersToOpen(path)) await pace();
  }
  await fsp.rm(path, { recursive: true, force: true });
}

async function prepareBackupDirectory(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // This runs once, before the scheduler can own a partial. A partial can
  // survive only when the previous server process stopped during a run or a
  // prune, so every matching entry here is an orphan to reclaim. The
  // snapshot folders are from releases that staged the database there.
  for (const file of readdirSync(dir)) {
    if (file.startsWith(".sqlite-snapshot-") || PARTIAL_PATTERN.test(file))
      await removeCopyTree(join(dir, file));
  }
}

// What the run leaves out, as a test on a path relative to the state root:
// the credential stores (tar globs, as older releases passed them to tar),
// what Isomux makes again (literal paths), the live database and the backup
// folder itself when ISOMUX_BACKUP_DIR puts it inside the state root.
function exclusionTest(
  config: BackupConfig,
  stateRoot: string,
): (rel: string) => boolean {
  const root = config.stateRootName;
  const sources = BACKUP_EXCLUSIONS.flatMap((entry) =>
    entry.archivePatterns(escapeGlob(root)),
  ).map(tarGlobSource);
  // As tar did not enter an excluded folder, a pattern covers all it holds.
  const glob = new RegExp(`^(?:${sources.join("|")})(?:/.*)?$`);
  const literal = new Set([
    ...regenerableBackupPaths(stateRoot),
    OFFICE_DATABASE,
    `${OFFICE_DATABASE}-wal`,
    `${OFFICE_DATABASE}-shm`,
  ]);
  const backupRel = relative(stateRoot, config.backupDir);
  if (backupRel && !backupRel.startsWith("..") && !isAbsolute(backupRel))
    literal.add(backupRel.split(sep).join("/"));
  return (rel) =>
    literal.has(rel) || glob.test(`${root}/${rel}`) || movedHomeExcluded(rel);
}

// Slice 5c-2 (task 78733adf): the home of a member who came with an office
// move waits in move-members/<id>/home until the enable command places it.
// The copy holds what her member backup holds: her agent space, less what
// memberSpaceExcluded leaves out. The rest of her home stays out.
// Her agent space's name in her home (agent-host.ts MEMBER_AGENT_DIR).
const MEMBER_AGENT_SPACE = ".isomux-agent";
function movedHomeExcluded(rel: string): boolean {
  const parts = rel.split("/");
  if (parts[0] !== MOVE_MEMBERS_DIR || parts[2] !== "home" || parts.length < 4)
    return false;
  if (parts[3] !== MEMBER_AGENT_SPACE) return true;
  return memberSpaceExcluded(parts.slice(4).join("/"));
}

interface ManifestFile {
  s: number;
  m?: string;
  c?: string;
}

// One manifest line. p: the path in the copy's state root; k: d (folder),
// f (file) or l (symlink); s: the size in the copy; m and c: the source's
// mtime and ctime in ns when the file in the copy is the source as it was at
// those times (absent when it changed during the copy, and for the database
// snapshot, so the next run copies it again).
interface ManifestLine extends Partial<ManifestFile> {
  p: string;
  k: "d" | "f" | "l";
}

// The callback forms of node:zlib run on the thread pool; Bun.gzipSync and
// the *Sync forms would hold the event loop for a manifest of the whole
// state root (~0.2 s each way at 167k entries).
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// The manifest's files, parsed line by line and paced.
async function readManifest(
  copyDir: string,
): Promise<Map<string, ManifestFile> | null> {
  try {
    const text = (
      await gunzipAsync(await fsp.readFile(join(copyDir, COPY_MANIFEST)))
    ).toString("utf8");
    const files = new Map<string, ManifestFile>();
    const pace = pacer();
    for (let start = 0; start < text.length;) {
      let end = text.indexOf("\n", start);
      if (end < 0) end = text.length;
      const line = text.slice(start, end);
      start = end + 1;
      await pace();
      if (!line) continue;
      const entry = JSON.parse(line) as ManifestLine;
      if (entry.k === "f" && typeof entry.s === "number")
        files.set(entry.p, { s: entry.s, m: entry.m, c: entry.c });
    }
    return files;
  } catch {
    return null;
  }
}

async function writeManifest(
  path: string,
  manifest: ManifestLine[],
): Promise<void> {
  const lines: string[] = [];
  const pace = pacer();
  for (const line of manifest) {
    lines.push(JSON.stringify(line));
    await pace();
  }
  lines.push("");
  await fsp.writeFile(path, await gzipAsync(lines.join("\n")), {
    mode: 0o600,
  });
}

interface PlanEntry {
  rel: string;
  kind: "d" | "f" | "l";
  mode: number;
  size: number;
  atimeNs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  target?: string;
  // A file the previous copy holds as it is now: the path to link to.
  linkFrom?: string;
}

interface Plan {
  entries: PlanEntry[];
  folders: number;
  copyBytes: number;
}

interface PreviousCopy {
  name: string;
  id: string;
  root: string;
  files: Map<string, ManifestFile>;
}

function cannotRead(rel: string, err: unknown): Error {
  return new Error(`cannot read ${rel || "."}: ${errMessage(err)}`, {
    cause: err,
  });
}

// One walk of the state root with sync calls, paced (above). Sockets, FIFOs and devices are left out, as tar
// left sockets out. An entry that is gone since its folder was listed is
// skipped; one that cannot be read fails the run, as tar's "Cannot open" did.
async function planCopy(
  stateRoot: string,
  excluded: (rel: string) => boolean,
  previous: PreviousCopy | null,
): Promise<Plan> {
  const rootStat = statSync(stateRoot, { bigint: true });
  const entries: PlanEntry[] = [
    {
      rel: "",
      kind: "d",
      mode: Number(rootStat.mode),
      size: 0,
      atimeNs: rootStat.atimeNs,
      mtimeNs: rootStat.mtimeNs,
      ctimeNs: rootStat.ctimeNs,
    },
  ];
  let folders = 1;
  let copyBytes = 0;
  const pace = pacer();
  const stack = [""];
  while (stack.length > 0) {
    const dirRel = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(join(stateRoot, dirRel));
    } catch (err) {
      if (errCode(err) === "ENOENT") continue;
      throw cannotRead(dirRel, err);
    }
    for (const name of names) {
      await pace();
      const rel = dirRel ? `${dirRel}/${name}` : name;
      if (excluded(rel)) continue;
      const path = join(stateRoot, rel);
      let st;
      try {
        st = lstatSync(path, { bigint: true });
      } catch (err) {
        if (errCode(err) === "ENOENT") continue;
        throw cannotRead(rel, err);
      }
      const base = {
        rel,
        mode: Number(st.mode),
        size: Number(st.size),
        atimeNs: st.atimeNs,
        mtimeNs: st.mtimeNs,
        ctimeNs: st.ctimeNs,
      };
      if (st.isDirectory()) {
        entries.push({ ...base, kind: "d", size: 0 });
        folders++;
        stack.push(rel);
      } else if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = readlinkSync(path);
        } catch (err) {
          if (errCode(err) === "ENOENT") continue;
          throw cannotRead(rel, err);
        }
        entries.push({ ...base, kind: "l", target });
      } else if (st.isFile()) {
        const before = previous?.files.get(rel);
        if (
          previous &&
          before &&
          before.s === base.size &&
          before.m === String(st.mtimeNs) &&
          before.c === String(st.ctimeNs)
        )
          entries.push({
            ...base,
            kind: "f",
            linkFrom: join(previous.root, rel),
          });
        else {
          entries.push({ ...base, kind: "f" });
          copyBytes += base.size;
        }
      }
    }
  }
  return { entries, folders, copyBytes };
}

const nsToSeconds = (ns: bigint) => Number(ns / 1000n) / 1e6;

// The file in the previous copy is still what its manifest says: a file of
// that size, with that mtime to the ms (utimes is not exact to the ns). A file
// someone edited in place inside a copy is copied again, not spread.
function previousFileIntact(path: string, entry: PlanEntry): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return (
    st !== undefined &&
    st.isFile() &&
    st.size === entry.size &&
    Math.abs(st.mtimeMs - Number(entry.mtimeNs / 1000n) / 1000) < 1
  );
}

const LINK_UNSUPPORTED = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
]);

interface WriteResult {
  manifest: ManifestLine[];
  files: number;
  bytes: number;
  newBytes: number;
  linked: number;
}

async function writeCopy(
  plan: Plan,
  stateRoot: string,
  copyRoot: string,
  config: BackupConfig,
  deps: BackupDeps,
): Promise<WriteResult> {
  const link = deps.link ?? DEFAULT_DEPS.link;
  const copyFile = deps.copyFile ?? DEFAULT_DEPS.copyFile;
  const out: WriteResult = {
    manifest: [],
    files: 0,
    bytes: 0,
    newBytes: 0,
    linked: 0,
  };
  let linking = true;
  let sinceCheck = 0;
  const pace = pacer();
  const copy = async (entry: PlanEntry, dst: string): Promise<void> => {
    const src = join(stateRoot, entry.rel);
    try {
      await copyFile(src, dst);
    } catch (err) {
      if (errCode(err) === "ENOENT" && !existsSync(src)) {
        console.warn(`[backup] ${entry.rel} is gone since the plan; skipped`);
        return;
      }
      // The copy can fail on either side: ENOSPC, EIO or EDQUOT are the
      // backup disk's.
      throw new Error(`cannot copy ${entry.rel}: ${errMessage(err)}`, {
        cause: err,
      });
    }
    const after = lstatSync(src, { bigint: true, throwIfNoEntry: false });
    const size = lstatSync(dst).size;
    const times = after ?? entry;
    chmodSync(dst, entry.mode & 0o7777);
    utimesSync(dst, nsToSeconds(times.atimeNs), nsToSeconds(times.mtimeNs));
    const unchanged =
      after !== undefined &&
      Number(after.size) === entry.size &&
      after.mtimeNs === entry.mtimeNs &&
      after.ctimeNs === entry.ctimeNs;
    out.manifest.push({
      p: entry.rel,
      k: "f",
      s: size,
      ...(unchanged
        ? { m: String(entry.mtimeNs), c: String(entry.ctimeNs) }
        : {}),
    });
    out.files++;
    out.bytes += size;
    out.newBytes += size;
    sinceCheck += size;
    if (sinceCheck >= config.minHeadroomBytes) {
      sinceCheck = 0;
      const available = deps.availableBytes(config.backupDir);
      if (available < config.minHeadroomBytes)
        throw new Error(
          `free space ran out during the copy: ${available} bytes available`,
        );
    }
  };
  for (const entry of plan.entries) {
    await pace();
    const dst = join(copyRoot, entry.rel);
    if (entry.kind === "d") {
      mkdirSync(dst, { mode: 0o700 });
      if (entry.rel) out.manifest.push({ p: entry.rel, k: "d" });
      continue;
    }
    if (entry.kind === "l") {
      symlinkSync(entry.target!, dst);
      const size = lstatSync(dst).size;
      out.manifest.push({ p: entry.rel, k: "l", s: size });
      out.files++;
      out.bytes += size;
      out.newBytes += size;
      continue;
    }
    if (entry.linkFrom && linking) {
      // The source as the plan saw it: gone means skipped, changed means a
      // copy of what it holds now.
      const now = lstatSync(join(stateRoot, entry.rel), {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (!now) {
        console.warn(`[backup] ${entry.rel} is gone since the plan; skipped`);
        continue;
      }
      if (
        Number(now.size) !== entry.size ||
        now.mtimeNs !== entry.mtimeNs ||
        now.ctimeNs !== entry.ctimeNs
      )
        entry.linkFrom = undefined;
    }
    if (
      entry.linkFrom &&
      linking &&
      previousFileIntact(entry.linkFrom, entry)
    ) {
      try {
        link(entry.linkFrom, dst);
        out.manifest.push({
          p: entry.rel,
          k: "f",
          s: entry.size,
          m: String(entry.mtimeNs),
          c: String(entry.ctimeNs),
        });
        out.files++;
        out.bytes += entry.size;
        out.linked++;
        continue;
      } catch (err) {
        const code = errCode(err);
        if (code && LINK_UNSUPPORTED.has(code)) {
          linking = false;
          console.warn(
            `[backup] hard links refused (${code}); this run copies every file`,
          );
        } else if (code !== "EMLINK") throw err;
      }
    }
    await copy(entry, dst);
  }
  return out;
}

// The copy is what the manifest says: every entry there with its kind, each
// file of the size written, and no entry the manifest does not name.
async function verifyCopy(
  copyRoot: string,
  manifest: ManifestLine[],
): Promise<void> {
  const expected = new Map(manifest.map((line) => [line.p, line]));
  let found = 0;
  const pace = pacer();
  const stack = [""];
  while (stack.length > 0) {
    // Also per folder: an empty one has no names to pace.
    await pace();
    const dirRel = stack.pop()!;
    for (const name of readdirSync(join(copyRoot, dirRel))) {
      found++;
      await pace();
      const rel = dirRel ? `${dirRel}/${name}` : name;
      const want = expected.get(rel);
      if (!want)
        throw new Error(`copy verification: ${rel} is not in the manifest`);
      const st = lstatSync(join(copyRoot, rel));
      const kind = st.isDirectory()
        ? "d"
        : st.isSymbolicLink()
          ? "l"
          : st.isFile()
            ? "f"
            : null;
      if (kind !== want.k)
        throw new Error(`copy verification: ${rel} is not a ${want.k}`);
      if (kind === "f" && st.size !== want.s)
        throw new Error(
          `copy verification: ${rel} has ${st.size} bytes, expected ${want.s}`,
        );
      if (kind === "d") stack.push(rel);
    }
  }
  if (found !== expected.size)
    throw new Error(
      `copy verification: ${expected.size - found} entries of the manifest are missing`,
    );
}

// The newest folder copy of this office, with its manifest, or null: then
// every file is copied (the first run, only tar.gz copies, or a manifest that
// does not read).
async function previousCopy(
  config: BackupConfig,
): Promise<PreviousCopy | null> {
  const newest = listVerifiedBackups(config)
    .filter((b) => b.kind === "folder")
    .at(-1);
  if (!newest) return null;
  const files = await readManifest(newest.path);
  if (!files) return null;
  return {
    name: newest.file,
    id: newest.id!,
    root: join(newest.path, config.stateRootName),
    files,
  };
}

async function pruneVerified(config: BackupConfig): Promise<void> {
  const items = listVerifiedBackups(config);
  while (items.length > config.retention) {
    const oldest = items.shift()!;
    if (oldest.kind === "tar") {
      unlinkSync(oldest.path);
      unlinkSync(markerPath(oldest.path));
      continue;
    }
    // Unpublished first: a prune stopped half-way leaves a partial, which the
    // next start removes, never a broken copy that still has its marker.
    const doomed = partialPath(config.backupDir, Date.now());
    renameSync(oldest.path, doomed);
    await removeCopyTree(doomed);
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

export { backupFolderUsage } from "./backup-copies.ts";

export async function prepareBackupDirectoryForTest(
  dir: string,
): Promise<void> {
  await prepareBackupDirectory(dir);
}

// Rough bytes per manifest line before gzip: the free-space check counts it.
const MANIFEST_BYTES_PER_ENTRY = 100;
const FOLDER_BYTES = 4096;

async function runBackup(
  config: BackupConfig,
  deps: BackupDeps = DEFAULT_DEPS,
): Promise<string> {
  mkdirSync(config.backupDir, { recursive: true });
  await certifyUnmarkedArchives(config, deps);
  const startedAt = deps.now();
  const stateRoot = officeOf(config);
  const database = join(stateRoot, OFFICE_DATABASE);
  const databaseSize = lstatSync(database, { throwIfNoEntry: false })?.size;
  const previous = await previousCopy(config);
  const plan = await planCopy(
    stateRoot,
    exclusionTest(config, stateRoot),
    previous,
  );

  // From the plan, before any write: what it copies, its folders and its
  // manifest, plus a margin.
  const copyBytes = plan.copyBytes + (databaseSize ?? 0);
  const required =
    copyBytes +
    plan.folders * FOLDER_BYTES +
    plan.entries.length * MANIFEST_BYTES_PER_ENTRY +
    Math.max(config.minHeadroomBytes, copyBytes / 4);
  const available = deps.availableBytes(config.backupDir);
  if (available < required) {
    throw new Error(
      `not enough free space: ${available} bytes available, ${Math.ceil(required)} required; existing verified backups were kept`,
    );
  }
  await (deps.afterPlan ?? DEFAULT_DEPS.afterPlan)();

  // 0700 whatever the umask and the source modes: every file is inside it.
  const partial = partialPath(config.backupDir, startedAt);
  mkdirSync(partial, { mode: 0o700 });
  try {
    chmodSync(partial, 0o700);
    const copyRoot = join(partial, config.stateRootName);
    const written = await writeCopy(plan, stateRoot, copyRoot, config, deps);
    if (databaseSize !== undefined) {
      const target = join(copyRoot, OFFICE_DATABASE);
      await snapshotOfficeDatabase(database, target);
      chmodSync(target, 0o600);
      const size = lstatSync(target).size;
      written.manifest.push({ p: OFFICE_DATABASE, k: "f", s: size });
      written.files++;
      written.bytes += size;
      written.newBytes += size;
    }
    // Each folder's mode and times after its children: a read-only folder
    // takes no more children.
    const pace = pacer();
    for (let i = plan.entries.length - 1; i >= 0; i--) {
      await pace();
      const entry = plan.entries[i];
      if (entry.kind !== "d") continue;
      const dst = join(copyRoot, entry.rel);
      utimesSync(dst, nsToSeconds(entry.atimeNs), nsToSeconds(entry.mtimeNs));
      chmodSync(dst, entry.mode & 0o7777);
    }
    await verifyCopy(copyRoot, written.manifest);
    const members = await copyMembers(config, deps, partial, startedAt);
    written.files += members.files;
    written.bytes += members.bytes;
    written.newBytes += members.newBytes;

    await writeManifest(join(partial, COPY_MANIFEST), written.manifest);
    const marker: CopyMarker = {
      kind: "folder",
      id: randomUUID(),
      startedAt,
      finishedAt: deps.now(),
      office: stateRoot,
      files: written.files,
      bytes: written.bytes,
      newBytes: written.newBytes,
      linkedFrom:
        previous && (written.linked > 0 || members.linked)
          ? { name: previous.name, id: previous.id }
          : null,
      ...(members.skipped.length > 0
        ? { membersSkipped: members.skipped }
        : {}),
    };
    writeFileSync(join(partial, COPY_MARKER), `${JSON.stringify(marker)}\n`, {
      mode: 0o600,
    });
    // The rename publishes it.
    const final = allocateFinalPath(config.backupDir, startedAt);
    renameSync(partial, final);
    await pruneVerified(config);
    return basename(final);
  } finally {
    if (existsSync(partial)) await removeCopyTree(partial);
  }
}

// Each isolated member's space, after the office's copy is written and
// verified: one at a time, each one checked for free space on its own (the
// office's copy was checked alone, before any write), and nothing of hers
// can fail the run (member-backup.ts).
async function copyMembers(
  config: BackupConfig,
  deps: BackupDeps,
  partial: string,
  startedAt: number,
): Promise<{
  files: number;
  bytes: number;
  newBytes: number;
  skipped: string[];
  linked: boolean;
}> {
  const out = {
    files: 0,
    bytes: 0,
    newBytes: 0,
    skipped: [] as string[],
    linked: false,
  };
  let sources: MemberBackupSource[];
  try {
    sources = memberSources?.list() ?? [];
  } catch (err) {
    console.error("[backup] the isolated members could not be listed:", err);
    return out;
  }
  if (sources.length === 0) return out;
  const copies = listVerifiedBackups(config)
    .filter((b) => b.kind === "folder")
    .reverse()
    .map((b) => ({ name: b.file, path: b.path }));
  const newest = copies[0]?.name;
  for (const source of sources) {
    let previous: PreviousMemberTree | null = null;
    let result: MemberCopyResult;
    try {
      previous = findPreviousMemberTree(copies, source.userId);
      result = await copyMemberSpace(source, {
        partial,
        startedAt,
        previous,
        fits: (bytes, folders, entries) =>
          deps.availableBytes(config.backupDir) >=
          bytes +
            folders * FOLDER_BYTES +
            entries * MANIFEST_BYTES_PER_ENTRY +
            Math.max(config.minHeadroomBytes, bytes / 4),
        checkSpace: () => {
          const available = deps.availableBytes(config.backupDir);
          if (available < config.minHeadroomBytes)
            throw new Error(
              `free space ran out during a member's copy: ${available} bytes available`,
            );
        },
        ...(deps.link ? { link: deps.link } : {}),
        now: () => deps.now(),
      });
    } catch (err) {
      // copyMemberSpace answers for everything of theirs; this is a fault of
      // the office's own, and it fails their part only.
      console.error(`[backup] ${source.userId}: agent space not copied:`, err);
      result = {
        userId: source.userId,
        state: "skipped",
        files: 0,
        bytes: 0,
        newBytes: 0,
      };
    }
    out.files += result.files;
    out.bytes += result.bytes;
    out.newBytes += result.newBytes;
    if (result.state !== "copied") out.skipped.push(source.userId);
    // Her files link to the newest copy only when her tree came from it.
    if (previous?.copyName === newest && result.files > 0) out.linked = true;
  }
  return out;
}

let preTick: (() => Promise<void>) | null = null;

async function tick() {
  if (running) return;
  running = true;
  try {
    // Before the folder is prepared, so a folder problem does not stop it,
    // and before the copy, so the copy holds its result.
    if (preTick) {
      try {
        await preTick();
      } catch (err) {
        console.error("[backup] the step before the backup failed:", err);
      }
    }
    // One snapshot of the settings for the whole check and run.
    const config = currentBackupConfig();
    if (!preparedDirs.has(config.backupDir)) {
      lastAttemptAt = Date.now();
      await prepareBackupDirectory(config.backupDir);
      preparedDirs.add(config.backupDir);
      lastAttemptError = null;
    }
    // Certify an unmarked tar.gz before deciding a backup is due, so an
    // archive left by an older release counts for the schedule.
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

// A step each tick runs first, before it prepares the backup folder: the
// automatic log cleanup (server/storage-retention.ts). Its failure is logged
// and does not stop the backup. null removes it.
export function setBackupPreTick(hook: (() => Promise<void>) | null): void {
  preTick = hook;
}

/** Test-only: one scheduler tick, as the hourly check runs it. */
export async function tickOnceForTest(): Promise<void> {
  await tick();
}

export function startBackupScheduler() {
  // A low-space refusal happens before anything is written. Retrying it
  // hourly costs one metadata walk of the state root, not a copy.
  schedulerStarted = true;
  void tick();
  setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

/** Test-only visibility for names that must never be counted as backups. */
export function isBackupPartialForTest(file: string): boolean {
  return PARTIAL_PATTERN.test(file);
}
