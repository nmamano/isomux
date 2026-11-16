// Office lockdown (task cdd7883d): the markers that lock an office, the
// credential files a lock moves aside, and the apps a lock stops and disables.
//
// Shared by the server (server/locked-office.ts, the boot gate in
// server/isomux-office.ts) and the host command (scripts/rescue.ts), so it
// imports nothing heavy and reads no module-level state: every function takes
// the state root.
//
// Two markers lock an office; either one is enough:
// - <state root>/LOCKDOWN, written by the host command or the lockdown route.
// - <root marker dir>/lockdown (/etc/isomux/lockdown), written by the root
//   wrapper on root installs. The service user cannot remove it. Its body
//   names the state root it locks, so a root install's lock never locks
//   another office on the same box.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** The state-root marker's file name. */
export const LOCK_MARKER_FILE = "LOCKDOWN";
/** Where root installs keep the root marker. A parameter everywhere it is read. */
export const ROOT_MARKER_DIR = "/etc/isomux";
/** The root marker's file name, in ROOT_MARKER_DIR. */
export const ROOT_MARKER_FILE = "lockdown";
/** Set on every response of a locked office. */
export const LOCKED_HEADER = "X-Isomux-Locked";
/** The /readyz body of a locked office ("ok\n" when not locked). */
export const LOCKED_READY_BODY = "locked\n";
/** The apps a lock stopped, which the first normal boot starts again. */
export const LOCKDOWN_APPS_FILE = "apps-stopped-by-lock.json";
/** The apps of LOCKDOWN_APPS_FILE that the first normal boot could not start
 *  yet: their owner's host was not ready (an isolated member's runner). They
 *  start when it is, or at a later normal boot. A file of its own, so a new
 *  lock's record is never mixed with them. */
export const LOCKDOWN_WAITING_APPS_FILE = "apps-stopped-by-lock-waiting.json";
/** The apps whose unit a lock disabled, which the first normal boot enables
 *  again (task 367596bc). */
export const LOCKDOWN_DISABLED_APPS_FILE = "apps-disabled-by-lock.json";
/** The prefix of the directory a lock moves the credential files into. */
export const LOCKDOWN_DIR_PREFIX = "lockdown-";
/** Credential files a lock moves aside: sign-in sessions, API tokens,
 *  invites, browser extension pairings. */
export const QUARANTINED_FILES = [
  "sessions.json",
  "api-tokens.json",
  "invites.json",
  "browser-connections.json",
] as const;

/** A marker's body. */
export interface LockMarker {
  /** ISO time the lock started. */
  since: string;
  reason: string;
  /** Who locked: "host" for the host command, or a member's name. */
  by: string;
  /** The state root the marker locks (the root marker matches on it). */
  stateRoot: string;
}

export interface LockMarkerReading {
  path: string;
  /** null when the file exists but cannot be read or parsed: it still locks. */
  marker: LockMarker | null;
}

export interface LockState {
  locked: boolean;
  /** Each marker that locks this office. */
  markers: LockMarkerReading[];
}

/** Which markers lock the office at `stateRoot`. A root marker counts when it
 *  names this state root (by realpath) or cannot be read or parsed. */
export function readLockState(
  stateRoot: string,
  rootMarkerDir: string = ROOT_MARKER_DIR,
): LockState {
  const markers: LockMarkerReading[] = [];
  const statePath = join(stateRoot, LOCK_MARKER_FILE);
  if (existsSync(statePath))
    markers.push({ path: statePath, marker: readMarker(statePath) });
  const rootPath = join(rootMarkerDir, ROOT_MARKER_FILE);
  if (existsSync(rootPath)) {
    const marker = readMarker(rootPath);
    if (!marker || sameDir(marker.stateRoot, stateRoot))
      markers.push({ path: rootPath, marker });
  }
  return { locked: markers.length > 0, markers };
}

// A marker that exists but cannot be read or parsed is null: it still locks.
function readMarker(path: string): LockMarker | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    if (
      typeof m.since !== "string" ||
      typeof m.reason !== "string" ||
      typeof m.by !== "string" ||
      typeof m.stateRoot !== "string"
    )
      return null;
    return {
      since: m.since,
      reason: m.reason,
      by: m.by,
      stateRoot: m.stateRoot,
    };
  } catch {
    return null;
  }
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/** The JSON body of a marker for `stateRoot`. */
export function lockMarkerBody(
  stateRoot: string,
  input: { reason: string; by: string; now: Date },
): string {
  const marker: LockMarker = {
    since: input.now.toISOString(),
    reason: input.reason,
    by: input.by,
    stateRoot: resolve(stateRoot),
  };
  return `${JSON.stringify(marker)}\n`;
}

/** Writes <stateRoot>/LOCKDOWN (0600). Returns its path. */
export function writeStateMarker(
  stateRoot: string,
  input: { reason: string; by: string; now: Date },
): string {
  const path = join(stateRoot, LOCK_MARKER_FILE);
  writeFileSync(path, lockMarkerBody(stateRoot, input), { mode: 0o600 });
  // writeFileSync keeps the mode of a file that already exists.
  chmodSync(path, 0o600);
  return path;
}

/** Removes <stateRoot>/LOCKDOWN. Returns whether it existed. */
export function removeStateMarker(stateRoot: string): boolean {
  const path = join(stateRoot, LOCK_MARKER_FILE);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** The unlock of the state root: when <state>/LOCKDOWN exists, moves the
 *  credential files aside (quarantineCredentials), then removes the marker.
 *  Nothing can mint a credential while the office is locked, so every file
 *  present at the unlock predates the lock. No marker: nothing moves. A
 *  quarantine that throws keeps the marker and throws. */
export function unlockStateMarker(
  stateRoot: string,
  now: Date,
): { removed: boolean; quarantineDir: string | null } {
  if (!existsSync(join(stateRoot, LOCK_MARKER_FILE)))
    return { removed: false, quarantineDir: null };
  const { dir } = quarantineCredentials(stateRoot, now);
  removeStateMarker(stateRoot);
  return { removed: true, quarantineDir: dir };
}

/** Moves each QUARANTINED_FILES entry present in `stateRoot` into a new
 *  <stateRoot>/lockdown-<time>/ (0700). Nothing to move: no directory, a
 *  null dir. */
export function quarantineCredentials(
  stateRoot: string,
  now: Date,
): { dir: string | null; moved: string[] } {
  const present = QUARANTINED_FILES.filter((name) =>
    existsSync(join(stateRoot, name)),
  );
  if (present.length === 0) return { dir: null, moved: [] };
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  // A second lock in the same second gets its own directory, never the
  // first one's.
  let dir = join(stateRoot, `${LOCKDOWN_DIR_PREFIX}${stamp}`);
  for (let n = 2; existsSync(dir); n++)
    dir = join(stateRoot, `${LOCKDOWN_DIR_PREFIX}${stamp}-${n}`);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const moved: string[] = [];
  for (const name of present) {
    renameSync(join(stateRoot, name), join(dir, name));
    moved.push(name);
  }
  return { dir, moved };
}

/** The apps the office starts, stops and lists, as a lock needs them. */
export interface LockdownApps {
  /** Every registered app. */
  list(): string[];
  isActive(name: string): boolean;
  stop(name: string): void;
  start(name: string): void;
  /** The named apps whose unit is enabled, in one call. Only a host whose
   *  apps are systemd units has this and the two below. */
  enabledApps?(names: readonly string[]): string[];
  disable?(name: string): void;
  enable?(name: string): void;
}

/** At every lock: disables the unit of every registered app that is enabled,
 *  so a reboot does not start it while the office stays locked or stopped,
 *  and adds the ones it disabled to LOCKDOWN_DISABLED_APPS_FILE. Returns
 *  them, and the ones it could not disable. A host without enabledApps has
 *  nothing to disable. */
export function disableAppsForLock(
  stateRoot: string,
  apps: LockdownApps,
): { disabled: string[]; failed: string[] } {
  if (!apps.enabledApps || !apps.disable) return { disabled: [], failed: [] };
  const registered = apps.list();
  let enabled: string[];
  try {
    enabled = apps.enabledApps(registered);
  } catch (err) {
    console.error(
      "[lockdown] could not read which app units are enabled:",
      err,
    );
    return { disabled: [], failed: registered };
  }
  const disabled: string[] = [];
  const failed: string[] = [];
  for (const name of enabled) {
    try {
      apps.disable(name);
      disabled.push(name);
    } catch (err) {
      console.error(`[lockdown] the app ${name} was not disabled:`, err);
      failed.push(name);
    }
  }
  if (disabled.length > 0) {
    // A later lock adds to the record: the first lock's names still need
    // their enable at the unlock.
    const record = join(stateRoot, LOCKDOWN_DISABLED_APPS_FILE);
    const names = new Set([...readNames(record), ...disabled]);
    writeFileSync(record, `${JSON.stringify([...names])}\n`, { mode: 0o600 });
  }
  return { disabled, failed };
}

// The names in a record file; none when it is missing or does not read.
function readNames(record: string): string[] {
  if (!existsSync(record)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(record, "utf8"));
    if (Array.isArray(raw))
      return raw.filter((n): n is string => typeof n === "string");
  } catch (err) {
    console.error(`[lockdown] ${record} is unreadable:`, err);
  }
  return [];
}

/** At a locked boot: stops every registered app that runs, and records the
 *  ones it stopped in LOCKDOWN_APPS_FILE unless that file already exists
 *  (the first locked boot's record wins). Returns the names it stopped. */
export function stopAppsForLock(
  stateRoot: string,
  apps: LockdownApps,
): string[] {
  return stopAppsForLockWithFailures(stateRoot, apps).stopped;
}

/** stopAppsForLock, and the apps that did not stop. */
export function stopAppsForLockWithFailures(
  stateRoot: string,
  apps: LockdownApps,
): { stopped: string[]; failed: string[] } {
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const name of apps.list()) {
    if (!apps.isActive(name)) continue;
    try {
      apps.stop(name);
      stopped.push(name);
    } catch (err) {
      console.error(`[lockdown] the app ${name} did not stop:`, err);
      failed.push(name);
    }
  }
  const record = join(stateRoot, LOCKDOWN_APPS_FILE);
  if (!existsSync(record))
    writeFileSync(record, `${JSON.stringify(stopped)}\n`, { mode: 0o600 });
  return { stopped, failed };
}

/** At the first normal boot after a lock: enables each app in
 *  LOCKDOWN_DISABLED_APPS_FILE that is still registered (one that does not
 *  enable stays in its record for the next boot), then starts each app in
 *  LOCKDOWN_APPS_FILE and LOCKDOWN_WAITING_APPS_FILE that is still
 *  registered and `mayRun` allows, and removes LOCKDOWN_APPS_FILE. An app
 *  whose owner's host is not `reachable` yet keeps its name in
 *  LOCKDOWN_WAITING_APPS_FILE for a later call (an isolated member's runner
 *  connect); that file goes when no name is left. Returns the names it
 *  started. */
export function restartAppsAfterLock(
  stateRoot: string,
  apps: LockdownApps,
  mayRun: (name: string) => boolean,
  reachable: (name: string) => boolean = () => true,
): string[] {
  // The enabled bit first, with or without a record of stopped apps (the
  // unlock of an older release drops that one and keeps this one).
  const disabledRecord = join(stateRoot, LOCKDOWN_DISABLED_APPS_FILE);
  const record = join(stateRoot, LOCKDOWN_APPS_FILE);
  const waiting = join(stateRoot, LOCKDOWN_WAITING_APPS_FILE);
  if (
    !existsSync(disabledRecord) &&
    !existsSync(record) &&
    !existsSync(waiting)
  )
    return [];
  const registered = new Set(apps.list());
  if (existsSync(disabledRecord)) {
    // A unit that does not enable stays in the record: the next normal boot
    // tries it again.
    const notEnabled: string[] = [];
    for (const name of readNames(disabledRecord)) {
      if (!registered.has(name)) continue;
      try {
        apps.enable?.(name);
      } catch (err) {
        console.error(`[lockdown] the app ${name} was not enabled:`, err);
        notEnabled.push(name);
      }
    }
    if (notEnabled.length > 0)
      writeFileSync(disabledRecord, `${JSON.stringify(notEnabled)}\n`, {
        mode: 0o600,
      });
    else rmSync(disabledRecord, { force: true });
  }
  if (!existsSync(record) && !existsSync(waiting)) return [];
  const names = [...new Set([...readNames(record), ...readNames(waiting)])];
  const started: string[] = [];
  const kept: string[] = [];
  for (const name of names) {
    if (!registered.has(name)) continue;
    if (!reachable(name)) {
      kept.push(name);
      continue;
    }
    if (!mayRun(name)) continue;
    try {
      apps.start(name);
      started.push(name);
    } catch (err) {
      console.error(`[lockdown] the app ${name} did not start:`, err);
    }
  }
  if (kept.length > 0)
    writeFileSync(waiting, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
  else rmSync(waiting, { force: true });
  rmSync(record, { force: true });
  return started;
}
