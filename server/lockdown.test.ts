// The lock markers, the credential quarantine and the apps a lock stops
// (task cdd7883d). Every function takes its paths, so each test owns a
// temp state root and a temp root-marker dir and never reads /etc/isomux.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCK_MARKER_FILE,
  LOCKDOWN_APPS_FILE,
  LOCKDOWN_DIR_PREFIX,
  QUARANTINED_FILES,
  ROOT_MARKER_FILE,
  lockMarkerBody,
  quarantineCredentials,
  readLockState,
  removeStateMarker,
  restartAppsAfterLock,
  stopAppsForLock,
  writeStateMarker,
  type LockdownApps,
} from "./lockdown.ts";

const NOW = new Date("2026-11-06T10:00:00.000Z");
let dir = "";

afterEach(() => {
  if (dir) {
    // A test may leave a file it made unreadable.
    try {
      chmodSync(join(dir, "etc", ROOT_MARKER_FILE), 0o644);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  dir = "";
});

function bed(): { stateRoot: string; etc: string } {
  dir = mkdtempSync(join(tmpdir(), "lockdown-test-"));
  const stateRoot = join(dir, "state");
  const etc = join(dir, "etc");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(etc, { recursive: true });
  return { stateRoot, etc };
}

describe("readLockState", () => {
  test("an office with no marker is not locked", () => {
    const { stateRoot, etc } = bed();
    expect(readLockState(stateRoot, etc)).toEqual({
      locked: false,
      markers: [],
    });
  });

  test("the state marker written by writeStateMarker locks, with its reason, and removeStateMarker unlocks", () => {
    const { stateRoot, etc } = bed();
    const path = writeStateMarker(stateRoot, {
      reason: "leaked token",
      by: "host",
      now: NOW,
    });
    expect(path).toBe(join(stateRoot, LOCK_MARKER_FILE));
    // The marker can name a reason an attacker should not read.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const state = readLockState(stateRoot, etc);
    expect(state.locked).toBe(true);
    expect(state.markers.map((m) => m.path)).toEqual([path]);
    expect(state.markers[0].marker).toMatchObject({
      reason: "leaked token",
      by: "host",
      since: NOW.toISOString(),
    });
    expect(removeStateMarker(stateRoot)).toBe(true);
    expect(readLockState(stateRoot, etc).locked).toBe(false);
    expect(removeStateMarker(stateRoot)).toBe(false);
  });

  // The root wrapper writes the root marker from lockMarkerBody, so a box
  // with two offices (a root install and a self-hoster's user unit) locks
  // only the office the marker names.
  test("a root marker locks the office it names, by realpath, and no other", () => {
    const { stateRoot, etc } = bed();
    const other = join(dir, "other-state");
    mkdirSync(other);
    const link = join(dir, "state-link");
    symlinkSync(stateRoot, link);
    writeFileSync(
      join(etc, ROOT_MARKER_FILE),
      lockMarkerBody(link, { reason: "incident", by: "host", now: NOW }),
    );
    const mine = readLockState(stateRoot, etc);
    expect(mine.locked).toBe(true);
    expect(mine.markers.map((m) => m.path)).toEqual([
      join(etc, ROOT_MARKER_FILE),
    ]);
    expect(mine.markers[0].marker).toMatchObject({ reason: "incident" });
    expect(readLockState(other, etc)).toEqual({ locked: false, markers: [] });
  });

  test("a marker that cannot be parsed still locks (fail safe), in either place", () => {
    const { stateRoot, etc } = bed();
    writeFileSync(join(etc, ROOT_MARKER_FILE), "{not json");
    const root = readLockState(stateRoot, etc);
    expect(root.locked).toBe(true);
    expect(root.markers).toEqual([
      { path: join(etc, ROOT_MARKER_FILE), marker: null },
    ]);
    rmSync(join(etc, ROOT_MARKER_FILE));
    writeFileSync(join(stateRoot, LOCK_MARKER_FILE), "");
    const state = readLockState(stateRoot, etc);
    expect(state.locked).toBe(true);
    expect(state.markers).toEqual([
      { path: join(stateRoot, LOCK_MARKER_FILE), marker: null },
    ]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a root marker that exists but cannot be read still locks",
    () => {
      const { stateRoot, etc } = bed();
      const path = join(etc, ROOT_MARKER_FILE);
      writeFileSync(
        path,
        lockMarkerBody(join(dir, "elsewhere"), {
          reason: "x",
          by: "host",
          now: NOW,
        }),
      );
      chmodSync(path, 0o000);
      expect(readLockState(stateRoot, etc)).toEqual({
        locked: true,
        markers: [{ path, marker: null }],
      });
    },
  );

  test("both markers are reported when both lock", () => {
    const { stateRoot, etc } = bed();
    writeStateMarker(stateRoot, { reason: "a", by: "host", now: NOW });
    writeFileSync(
      join(etc, ROOT_MARKER_FILE),
      lockMarkerBody(stateRoot, { reason: "b", by: "host", now: NOW }),
    );
    expect(
      readLockState(stateRoot, etc)
        .markers.map((m) => m.path)
        .sort(),
    ).toEqual(
      [join(stateRoot, LOCK_MARKER_FILE), join(etc, ROOT_MARKER_FILE)].sort(),
    );
  });
});

describe("quarantineCredentials", () => {
  test("moves exactly the credential files into one private directory, bytes intact, and is a no-op the second time", () => {
    const { stateRoot } = bed();
    // Not users.json, asks.json or office.sqlite: the office's content stays.
    const kept = ["users.json", "asks.json", "office.sqlite"];
    for (const name of [...QUARANTINED_FILES, ...kept])
      writeFileSync(join(stateRoot, name), `content of ${name}`);
    expect([...QUARANTINED_FILES].sort() as string[]).toEqual(
      [
        "api-tokens.json",
        "browser-connections.json",
        "invites.json",
        "sessions.json",
      ].sort(),
    );

    const first = quarantineCredentials(stateRoot, NOW);
    expect(first.dir).not.toBeNull();
    const moved = first.dir!;
    expect(moved.startsWith(join(stateRoot, LOCKDOWN_DIR_PREFIX))).toBe(true);
    expect(statSync(moved).mode & 0o777).toBe(0o700);
    expect([...first.moved].sort()).toEqual([...QUARANTINED_FILES].sort());
    expect(readdirSync(moved).sort()).toEqual([...QUARANTINED_FILES].sort());
    for (const name of QUARANTINED_FILES) {
      expect(existsSync(join(stateRoot, name))).toBe(false);
      expect(readFileSync(join(moved, name), "utf8")).toBe(
        `content of ${name}`,
      );
    }
    for (const name of kept)
      expect(readFileSync(join(stateRoot, name), "utf8")).toBe(
        `content of ${name}`,
      );

    const second = quarantineCredentials(stateRoot, new Date(+NOW + 60_000));
    expect(second).toEqual({ dir: null, moved: [] });
    expect(
      readdirSync(stateRoot).filter((n) => n.startsWith(LOCKDOWN_DIR_PREFIX)),
    ).toHaveLength(1);
  });

  // The server rewrites sessions.json from memory, so a file can come back
  // after a first quarantine (a stop that flushed it). A second lockdown at
  // the same second must not overwrite the first one's files.
  test("a second quarantine that finds a file again keeps the first one's files", () => {
    const { stateRoot } = bed();
    writeFileSync(join(stateRoot, "sessions.json"), "first");
    const first = quarantineCredentials(stateRoot, NOW);
    writeFileSync(join(stateRoot, "sessions.json"), "second");
    const second = quarantineCredentials(stateRoot, NOW);
    expect(second.moved).toEqual(["sessions.json"]);
    expect(second.dir).not.toBe(first.dir);
    expect(readFileSync(join(first.dir!, "sessions.json"), "utf8")).toBe(
      "first",
    );
    expect(readFileSync(join(second.dir!, "sessions.json"), "utf8")).toBe(
      "second",
    );
  });
});

function fakeApps(registered: string[], active: string[]) {
  const running = new Set(active);
  const calls: string[] = [];
  const apps: LockdownApps = {
    list: () => [...registered],
    isActive: (name) => running.has(name),
    stop: (name) => {
      calls.push(`stop ${name}`);
      running.delete(name);
    },
    start: (name) => {
      calls.push(`start ${name}`);
      running.add(name);
    },
  };
  return { apps, calls, running };
}

describe("the apps a lock stops", () => {
  test("every locked boot stops what runs; the first boot's record wins; the normal boot starts the recorded apps it may run and drops the record", () => {
    const { stateRoot } = bed();
    const first = fakeApps(
      ["board", "chat", "idle", "gone"],
      ["board", "chat", "gone"],
    );
    expect(stopAppsForLock(stateRoot, first.apps).sort()).toEqual([
      "board",
      "chat",
      "gone",
    ]);
    expect([...first.running]).toEqual([]);
    expect(existsSync(join(stateRoot, LOCKDOWN_APPS_FILE))).toBe(true);

    // A reboot while locked: the user manager started "idle" (WantedBy=
    // default.target) before the office. It is stopped, but it was not
    // running when the lock came, so it is not started at unlock.
    const reboot = fakeApps(
      ["board", "chat", "idle", "gone"],
      ["idle", "board"],
    );
    expect(stopAppsForLock(stateRoot, reboot.apps).sort()).toEqual([
      "board",
      "idle",
    ]);
    expect([...reboot.running]).toEqual([]);

    // Unlocked: "gone" was removed meanwhile, "chat" may no longer run.
    const normal = fakeApps(["board", "chat", "idle"], []);
    expect(
      restartAppsAfterLock(stateRoot, normal.apps, (n) => n !== "chat"),
    ).toEqual(["board"]);
    expect(normal.calls).toEqual(["start board"]);
    expect(existsSync(join(stateRoot, LOCKDOWN_APPS_FILE))).toBe(false);

    // The next normal boot has no record and starts nothing.
    const later = fakeApps(["board", "chat", "idle"], []);
    expect(restartAppsAfterLock(stateRoot, later.apps, () => true)).toEqual([]);
    expect(later.calls).toEqual([]);
  });
});
