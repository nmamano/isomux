// Daily backup of ~/.isomux to a verified local tarball.
//
// A backup is published in three steps: write a uniquely named partial file,
// walk the whole archive with `tar -tzf`, then rename it and write a verification
// marker. The marker records the final file's size and mtime. A final file with
// no matching marker is not a backup: the process may have stopped between the
// rename and the marker write, or an older release may have written it directly.
// The next tick verifies such legacy/orphaned files before it trusts them.
//
// Retention runs only after publication and considers only verified finals. A
// failed run therefore cannot displace a good backup. Restore is documented in
// internal-docs/backup-restore.md.

import { basename, dirname, join } from "path";
import { homedir, tmpdir } from "os";
import {
  closeSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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

const HOME = homedir();
const STATE_ROOT_PARENT = dirname(STATE_ROOT);
const STATE_ROOT_NAME = basename(STATE_ROOT);
const BACKUP_DIR =
  process.env.ISOMUX_BACKUP_DIR || join(HOME, "isomux-backups");
const RETENTION = 7;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const BACKUP_HEALTH_MAX_AGE_MS = 26 * 60 * 60 * 1000; // 26h
const FIRST_BACKUP_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const MIN_HEADROOM_BYTES = 256 * 1024 * 1024; // 256 MiB
const FILENAME_PATTERN = /^isomux-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.tar\.gz$/;
const PARTIAL_PATTERN = /^\.isomux-backup-.*\.partial$/;
const RESTORE_REPORT_FILE = "RESTORE.txt";

let lastAttemptAt: number | null = null;
let lastAttemptError: string | null = null;
let running = false;
let startupPrepared = false;

export interface BackupStatus {
  backupDir: string;
  retention: number;
  lastBackupAt: number | null;
  lastBackupOk: boolean | null;
  lastBackupError: string | null;
  lastBackupFile: string | null;
  running: boolean;
}

interface BackupConfig {
  backupDir: string;
  stateRootParent: string;
  stateRootName: string;
  retention: number;
  firstBackupMinFreeBytes: number;
  minHeadroomBytes: number;
}

interface BackupDeps {
  now(): number;
  spawn(argv: string[]): Subprocess;
  availableBytes(dir: string): number;
}

interface Subprocess {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array>;
}

const DEFAULT_CONFIG: BackupConfig = {
  backupDir: BACKUP_DIR,
  stateRootParent: STATE_ROOT_PARENT,
  stateRootName: STATE_ROOT_NAME,
  retention: RETENTION,
  firstBackupMinFreeBytes: FIRST_BACKUP_MIN_FREE_BYTES,
  minHeadroomBytes: MIN_HEADROOM_BYTES,
};

const DEFAULT_DEPS: BackupDeps = {
  now: () => Date.now(),
  spawn: (argv) => Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" }),
  availableBytes: (dir) => {
    const fs = statfsSync(dir);
    return Number(fs.bavail) * Number(fs.bsize);
  },
};

interface VerifiedBackup {
  file: string;
  path: string;
  size: number;
  mtimeMs: number;
}

interface VerificationMarker {
  size: number;
  mtimeMs: number;
}

interface BackupExclusion {
  id: string;
  matches: (relativePath: string) => boolean;
  archivePatterns: (stateRootName: string) => string[];
  report?: (paths: string[], stateRoot: string) => string[];
}

function rootedDirectory(root: string, path: string): string[] {
  return [`${root}/${path}`, `${root}/${path}/*`];
}

function backendExclusion(entry: BackendCredentialPath): BackupExclusion {
  return {
    id: entry.id,
    matches: (path) => entry.pattern.test(path),
    archivePatterns: entry.archivePatterns,
    report: (paths, stateRoot) => backendReport(entry.id, paths, stateRoot),
  };
}

// One list drives both tar and RESTORE.txt. Locations are rooted because GNU
// tar exclusion wildcards otherwise match the same directory name inside an
// app's customer-owned data. Backend credential names use the shared matcher
// from backend-credential-paths.ts and can occur in a configured home at any
// depth. Transcripts and logs stay: they can incidentally contain user text,
// but they are not credential stores and removing them would destroy history
// without making an archive secret-free.
const BACKUP_EXCLUSIONS: readonly BackupExclusion[] = [
  {
    id: "restore-report",
    matches: (path) => path === RESTORE_REPORT_FILE,
    // The state root is added one child at a time so this member never enters
    // the recursive walk. An exclude pattern would also reject the fresh
    // synthetic member added from its second -C root.
    archivePatterns: () => [],
  },
  {
    id: "app-runtime-credentials",
    matches: (path) => path === "apps/units" || path.startsWith("apps/units/"),
    archivePatterns: (root) => rootedDirectory(root, "apps/units"),
    report: (paths) => {
      const apps = paths
        .filter((path) => path.endsWith(".env"))
        .map((path) => basename(path, ".env"))
        .sort();
      return [
        `- App runtime credentials were omitted${apps.length ? ` for: ${apps.join(", ")}` : ""}. Isomux re-mints them at startup and restarts only apps that were running. Start previously stopped apps from the Apps page when you need them.`,
      ];
    },
  },
  {
    id: "personal-environment",
    matches: (path) => path === "user-env" || path.startsWith("user-env/"),
    archivePatterns: (root) => rootedDirectory(root, "user-env"),
    report: (paths, stateRoot) => personalEnvironmentReport(paths, stateRoot),
  },
  {
    id: "office-environment",
    matches: (path) => path === "office-env/office.env",
    archivePatterns: (root) => [`${root}/office-env/office.env`],
    report: () => [
      "- Office environment variables were omitted. An office owner must open User Settings > Connections > Environment variables > Variables for every agent in this office and enter them again. Then use /clear on affected agents.",
    ],
  },
  {
    id: "codex-shell-snapshots",
    matches: (path) =>
      /(^|\/)(?:\.codex|codex-home)\/shell_snapshots(?:\/|$)/.test(path) ||
      /^provider-homes\/[^/]+\/codex\/shell_snapshots(?:\/|$)/.test(path),
    archivePatterns: (root) => [
      ...rootedDirectory(root, "codex-home/shell_snapshots"),
      `${root}/*/.codex/shell_snapshots`,
      `${root}/*/.codex/shell_snapshots/*`,
      `${root}/*/codex-home/shell_snapshots`,
      `${root}/*/codex-home/shell_snapshots/*`,
      `${root}/provider-homes/*/codex/shell_snapshots`,
      `${root}/provider-homes/*/codex/shell_snapshots/*`,
    ],
    report: () => [
      "- Codex shell snapshots were omitted because they can contain exported environment variables. Codex regenerates them; no action is required.",
    ],
  },
  {
    id: "legacy-tls-key",
    matches: (path) => path === "tls/cert.key",
    archivePatterns: (root) => [`${root}/tls/cert.key`],
    report: () => [
      "- The legacy state-root TLS private key was omitted. Isomux does not read this file, so nothing needs to be entered again. A same-box restore keeps the active certificate outside the state root; a replacement-box installation obtains its certificate before the state restore.",
    ],
  },
  ...BACKEND_CREDENTIAL_PATHS.map(backendExclusion),
];

export function getBackupStatus(): BackupStatus {
  return statusFromDisk(
    DEFAULT_CONFIG,
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
  const newest = newestVerifiedBackup(config.backupDir);
  const newestAt = newest?.mtimeMs ?? null;
  const stale = newestAt !== null && now - newestAt >= BACKUP_HEALTH_MAX_AGE_MS;
  const failedAfterNewest =
    attemptError !== null &&
    attemptAt !== null &&
    (newestAt === null || attemptAt > newestAt);
  return {
    backupDir: config.backupDir,
    retention: config.retention,
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
        ? "newest verified backup is more than 26 hours old"
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
    if (marker.size !== stat.size || marker.mtimeMs !== stat.mtimeMs)
      return null;
    return { file, path, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function listVerifiedBackups(dir: string): VerifiedBackup[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => readVerifiedBackup(dir, file))
    .filter((item): item is VerifiedBackup => item !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
}

function newestVerifiedBackup(dir: string): VerifiedBackup | null {
  return listVerifiedBackups(dir).at(-1) ?? null;
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

function stateRoot(config: BackupConfig): string {
  return join(config.stateRootParent, config.stateRootName);
}

function stateFiles(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile() || entry.isSymbolicLink())
        files.push(relativePath);
    }
  }
  if (existsSync(root) && lstatSync(root).isDirectory()) visit(root, "");
  return files;
}

function userNames(root: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const parsed = JSON.parse(readFileSync(join(root, "users.json"), "utf8"));
    if (!Array.isArray(parsed)) return names;
    for (const user of parsed) {
      if (
        user &&
        typeof user === "object" &&
        typeof user.id === "string" &&
        typeof user.name === "string"
      ) {
        names.set(user.id, user.name);
      }
    }
  } catch {}
  return names;
}

function personalEnvironmentReport(paths: string[], root: string): string[] {
  const names = userNames(root);
  const users = paths
    .filter((path) => /^user-env\/[^/]+\.env$/.test(path))
    .map((path) => basename(path, ".env"))
    .map((id) => names.get(id) ?? id)
    .sort();
  if (users.length === 0) return [];
  return [
    `- Personal environment variables were omitted for: ${users.map((name) => `user "${name}"`).join(", ")}. Each affected user must open User Settings > Connections > Environment variables > Variables for agents I spawn and enter them again. Then use /clear on affected agents.`,
  ];
}

function backendReport(
  id: BackendCredentialPath["id"],
  paths: string[],
  root: string,
): string[] {
  if (paths.length === 0) return [];
  const names = userNames(root);
  const owners = paths
    .map((path) => /^provider-homes\/([^/]+)\//.exec(path)?.[1])
    .filter((id): id is string => id !== undefined)
    .map((id) => names.get(id) ?? id)
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
  const forUsers = owners.length
    ? ` for: ${owners.map((name) => `user "${name}"`).join(", ")}`
    : "";
  if (id === "claude-login") {
    return [
      `- Claude sign-in credentials were omitted${forUsers}. Each affected user must open User Settings > Connections > Claude and sign in again.`,
    ];
  }
  if (id === "codex-login") {
    return [
      `- Codex sign-in credentials were omitted${forUsers}. Each affected user must open User Settings > Connections > Codex and sign in again.`,
    ];
  }
  if (id === "opencode-login") {
    return [
      "- OpenCode provider credentials were omitted. Each affected user must open User Settings > Connections > Environment variables > Variables for agents I spawn, enter ANTHROPIC_API_KEY or OPENAI_API_KEY, and then use /clear on affected agents.",
    ];
  }
  return [
    "- OpenCode MCP OAuth credentials were omitted. Reconnect each affected server with the profile-scoped command: opencode mcp auth <server-name>.",
  ];
}

function restoreReport(config: BackupConfig): string {
  const root = stateRoot(config);
  const files = stateFiles(root);
  const details = BACKUP_EXCLUSIONS.flatMap((entry) => {
    if (!entry.report) return [];
    const matched = files.filter(entry.matches);
    return matched.length > 0 ? entry.report(matched, root) : [];
  });
  return [
    "ISOMUX RESTORE REPORT",
    "",
    "This backup omitted the credential files and regenerable secret caches listed below.",
    "This report does not claim that the archive is free of secrets.",
    "",
    ...(details.length
      ? details
      : [
          "No listed credential file or regenerable secret cache existed when this backup was made.",
        ]),
    "",
  ].join("\n");
}

function stageRestoreReport(config: BackupConfig): string {
  const staging = mkdtempSync(join(tmpdir(), "isomux-backup-report-"));
  const directory = join(staging, config.stateRootName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, RESTORE_REPORT_FILE);
  writeFileSync(path, restoreReport(config), { mode: 0o600 });
  return staging;
}

function archiveExclusionArgs(stateRootName: string): string[] {
  return BACKUP_EXCLUSIONS.flatMap((entry) =>
    entry
      .archivePatterns(stateRootName)
      .map((pattern) => `--exclude=${pattern}`),
  );
}

function stateArchiveMembers(config: BackupConfig): string[] {
  const report = BACKUP_EXCLUSIONS.find(
    (entry) => entry.id === "restore-report",
  )!;
  return readdirSync(stateRoot(config))
    .filter((name) => !report.matches(name))
    .map((name) => `${config.stateRootName}/${name}`);
}

function prepareBackupDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  // This runs once, before the scheduler can own a partial. A partial can
  // survive only when the previous server process died during tar, so every
  // matching file here is an orphan that the new process must reclaim.
  for (const file of readdirSync(dir)) {
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
}> {
  const proc = deps.spawn(argv);
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr: stderr.trim().slice(0, 500) };
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

async function verifyArchive(path: string, deps: BackupDeps): Promise<void> {
  const checked = await runTar(["tar", "-tzf", path], deps);
  if (checked.exitCode !== 0) {
    throw new Error(
      `archive verification exit ${checked.exitCode}: ${checked.stderr || "no error text"}`,
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
      await verifyArchive(candidate.path, deps);
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
  const files = listVerifiedBackups(config.backupDir);
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
  return runBackup({ ...DEFAULT_CONFIG, ...overrides }, deps);
}

export function backupStatusForTest(
  overrides: Partial<BackupConfig>,
  now: number,
): BackupStatus {
  return statusFromDisk(
    { ...DEFAULT_CONFIG, ...overrides },
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
  config: BackupConfig = DEFAULT_CONFIG,
  deps: BackupDeps = DEFAULT_DEPS,
): Promise<string> {
  mkdirSync(config.backupDir, { recursive: true });
  await certifyUnmarkedArchives(config, deps);
  const newest = newestVerifiedBackup(config.backupDir);
  const required = requiredFreeBytes(newest, config);
  const available = deps.availableBytes(config.backupDir);
  if (available < required) {
    throw new Error(
      `not enough free space: ${available} bytes available, ${Math.ceil(required)} required; existing verified backups were kept`,
    );
  }

  const now = deps.now();
  const partial = partialPath(config.backupDir, now);
  const final = allocateFinalPath(config.backupDir, now);
  let reportStaging: string | null = null;
  try {
    // Reserve the target at its final privacy mode before tar writes. GNU tar
    // truncates an existing file without changing its mode, so the archive is
    // never group/world-readable during a long write. Rename preserves it.
    closeSync(openSync(partial, "wx", 0o600));
    reportStaging = stageRestoreReport(config);
    const created = await runTar(
      [
        "tar",
        "-czf",
        partial,
        "--anchored",
        "--wildcards",
        ...archiveExclusionArgs(config.stateRootName),
        "--no-recursion",
        "-C",
        config.stateRootParent,
        config.stateRootName,
        "--recursion",
        "-C",
        config.stateRootParent,
        ...stateArchiveMembers(config),
        "-C",
        reportStaging,
        `${config.stateRootName}/${RESTORE_REPORT_FILE}`,
      ],
      deps,
    );
    if (created.exitCode >= 2) {
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
    await verifyArchive(partial, deps);
    renameSync(partial, final);
    writeMarker(final);
    pruneVerified(config);
    return basename(final);
  } finally {
    try {
      unlinkSync(partial);
    } catch {}
    if (reportStaging) rmSync(reportStaging, { recursive: true, force: true });
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    if (!startupPrepared) {
      lastAttemptAt = Date.now();
      prepareBackupDirectory(BACKUP_DIR);
      startupPrepared = true;
      lastAttemptError = null;
    }
    // On the first run after this feature ships, certify a legacy archive
    // before deciding it is due. Otherwise an upgrade would read the newest
    // archive once to verify it and immediately write a duplicate.
    await certifyUnmarkedArchives(DEFAULT_CONFIG, DEFAULT_DEPS);
    const newest = newestVerifiedBackup(BACKUP_DIR);
    if (newest && Date.now() - newest.mtimeMs < BACKUP_INTERVAL_MS) return;
    lastAttemptAt = Date.now();
    const file = await runBackup();
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
  void tick();
  setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

/** Test-only visibility for names that must never be counted as backups. */
export function isBackupPartialForTest(file: string): boolean {
  return PARTIAL_PATTERN.test(file);
}
