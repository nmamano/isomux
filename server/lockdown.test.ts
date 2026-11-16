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
  LOCKDOWN_DISABLED_APPS_FILE,
  LOCKDOWN_DIR_PREFIX,
  QUARANTINED_FILES,
  ROOT_MARKER_FILE,
  disableAppsForLock,
  lockMarkerBody,
  quarantineCredentials,
  readLockState,
  removeStateMarker,
  restartAppsAfterLock,
  stopAppsForLock,
  writeStateMarker,
  type LockdownApps,
} from "./lockdown.ts";
import { applyLockEffects } from "./locked-office.ts";
import { EXPORTS_SUBDIR } from "./office-export-jobs.ts";

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

// `enabled`: the units are systemd units, and these are enabled (a reboot
// starts them). Without it the host has no unit control (a container).
function fakeApps(registered: string[], active: string[], enabled?: string[]) {
  const running = new Set(active);
  const enabledSet = new Set(enabled ?? []);
  const calls: string[] = [];
  /** Each enabledApps query, with the names it asked about. */
  const queries: string[][] = [];
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
  if (enabled) {
    apps.enabledApps = (names) => {
      queries.push([...names]);
      return names.filter((n) => enabledSet.has(n));
    };
    apps.disable = (name) => {
      calls.push(`disable ${name}`);
      enabledSet.delete(name);
    };
    apps.enable = (name) => {
      calls.push(`enable ${name}`);
      enabledSet.add(name);
    };
  }
  return { apps, calls, running, enabled: enabledSet, queries };
}

const readRecord = (stateRoot: string, file: string): string[] =>
  (JSON.parse(readFileSync(join(stateRoot, file), "utf8")) as string[]).sort();

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

// A lock with --stop starts no locked office, so nothing stops the apps after
// a reboot unless their units are disabled (task 367596bc). Every lock
// disables them; the first normal boot enables the ones it disabled.
describe("the app units a lock disables", () => {
  test("disables each registered app whose unit is enabled, running or stopped, with one query; a later lock adds to the record and never drops a name", () => {
    const { stateRoot } = bed();
    // "off" was disabled before the lock; "ghost" is a unit of no registered
    // app.
    const first = fakeApps(
      ["board", "idle", "off"],
      ["board"],
      ["board", "idle", "ghost"],
    );
    const result = disableAppsForLock(stateRoot, first.apps);
    expect({
      disabled: [...result.disabled].sort(),
      failed: result.failed,
      queries: first.queries.map((q) => [...q].sort()),
      stillEnabled: [...first.enabled],
      record: readRecord(stateRoot, LOCKDOWN_DISABLED_APPS_FILE),
    }).toEqual({
      disabled: ["board", "idle"],
      failed: [],
      queries: [["board", "idle", "off"]],
      stillEnabled: ["ghost"],
      record: ["board", "idle"],
    });

    // A second lock: someone enabled "late" by hand meanwhile.
    const second = fakeApps(["board", "idle", "off", "late"], [], ["late"]);
    expect(disableAppsForLock(stateRoot, second.apps).disabled).toEqual([
      "late",
    ]);
    // A third finds nothing enabled.
    const third = fakeApps(["board", "idle", "off", "late"], [], []);
    expect(disableAppsForLock(stateRoot, third.apps).disabled).toEqual([]);
    expect(readRecord(stateRoot, LOCKDOWN_DISABLED_APPS_FILE)).toEqual([
      "board",
      "idle",
      "late",
    ]);
  });

  test("a unit that does not disable is named as failed and kept out of the record; the others are still disabled", () => {
    const { stateRoot } = bed();
    const fake = fakeApps(["board", "idle"], [], ["board", "idle"]);
    const apps: LockdownApps = {
      ...fake.apps,
      disable: (name) => {
        if (name === "board") throw new Error("Access denied");
        fake.apps.disable?.(name);
      },
    };
    const result = disableAppsForLock(stateRoot, apps);
    expect({
      result,
      stillEnabled: [...fake.enabled],
      record: readRecord(stateRoot, LOCKDOWN_DISABLED_APPS_FILE),
    }).toEqual({
      result: { disabled: ["idle"], failed: ["board"] },
      stillEnabled: ["board"],
      record: ["idle"],
    });
  });

  test("when the enabled units cannot be read, every registered app is named as failed; a host with no unit control disables nothing and writes no record", () => {
    const { stateRoot } = bed();
    const fake = fakeApps(["board", "idle"], [], ["board"]);
    const unread = disableAppsForLock(stateRoot, {
      ...fake.apps,
      enabledApps: () => {
        throw new Error("Failed to connect to bus");
      },
    });
    expect({
      disabled: unread.disabled,
      failed: [...unread.failed].sort(),
    }).toEqual({ disabled: [], failed: ["board", "idle"] });

    const container = fakeApps(["board", "idle"], ["board"]);
    expect({
      result: disableAppsForLock(stateRoot, container.apps),
      calls: container.calls,
    }).toEqual({ result: { disabled: [], failed: [] }, calls: [] });
    expect(existsSync(join(stateRoot, LOCKDOWN_DISABLED_APPS_FILE))).toBe(
      false,
    );
  });

  test("the first normal boot enables the recorded units still registered, then starts the recorded apps it may run, and drops both records; a unit disabled before the lock stays disabled", () => {
    const { stateRoot } = bed();
    const lock = fakeApps(
      ["board", "chat", "idle", "off", "gone"],
      ["board", "chat", "gone"],
      ["board", "chat", "idle", "gone"],
    );
    stopAppsForLock(stateRoot, lock.apps);
    disableAppsForLock(stateRoot, lock.apps);

    // Unlocked: "gone" was removed meanwhile, "chat" may no longer run.
    const normal = fakeApps(["board", "chat", "idle", "off"], [], []);
    const started = restartAppsAfterLock(
      stateRoot,
      normal.apps,
      (n) => n !== "chat",
    );
    const firstStart = normal.calls.findIndex((c) => c.startsWith("start "));
    expect({
      started,
      // Every enable comes before the first start.
      enables: normal.calls
        .slice(0, firstStart === -1 ? undefined : firstStart)
        .sort(),
      starts: normal.calls.filter((c) => c.startsWith("start ")),
      enabled: [...normal.enabled].sort(),
      records: [LOCKDOWN_APPS_FILE, LOCKDOWN_DISABLED_APPS_FILE].filter((f) =>
        existsSync(join(stateRoot, f)),
      ),
    }).toEqual({
      started: ["board"],
      enables: ["enable board", "enable chat", "enable idle"],
      starts: ["start board"],
      enabled: ["board", "chat", "idle"],
      records: [],
    });
  });

  test("a unit that does not enable stays in the record, so the next normal boot tries it again", () => {
    const { stateRoot } = bed();
    disableAppsForLock(
      stateRoot,
      fakeApps(["board", "idle"], [], ["board", "idle"]).apps,
    );
    const first = fakeApps(["board", "idle"], [], []);
    restartAppsAfterLock(
      stateRoot,
      {
        ...first.apps,
        enable: (name) => {
          if (name === "idle") throw new Error("Access denied");
          first.apps.enable?.(name);
        },
      },
      () => true,
    );
    const firstRecord = readRecord(stateRoot, LOCKDOWN_DISABLED_APPS_FILE);
    const next = fakeApps(["board", "idle"], [], []);
    restartAppsAfterLock(stateRoot, next.apps, () => true);
    expect({
      firstEnabled: [...first.enabled],
      firstRecord,
      nextCalls: next.calls,
      record: existsSync(join(stateRoot, LOCKDOWN_DISABLED_APPS_FILE)),
    }).toEqual({
      firstEnabled: ["board"],
      firstRecord: ["idle"],
      nextCalls: ["enable idle"],
      record: false,
    });
  });

  test("a record of disabled units with no record of stopped apps (the unlock of an older release dropped it) is still enabled and dropped", () => {
    const { stateRoot } = bed();
    disableAppsForLock(stateRoot, fakeApps(["idle"], [], ["idle"]).apps);
    expect(existsSync(join(stateRoot, LOCKDOWN_APPS_FILE))).toBe(false);
    const normal = fakeApps(["idle"], [], []);
    expect(restartAppsAfterLock(stateRoot, normal.apps, () => true)).toEqual(
      [],
    );
    expect({
      calls: normal.calls,
      record: existsSync(join(stateRoot, LOCKDOWN_DISABLED_APPS_FILE)),
    }).toEqual({ calls: ["enable idle"], record: false });
  });
});

// What a lock does to the state, at the lockdown route's stop and at every
// locked boot (task b1a56ba0). The route's stop runs it in the dying office,
// so one failed step must not skip the others.
describe("applyLockEffects", () => {
  function lockBed() {
    const { stateRoot } = bed();
    for (const name of QUARANTINED_FILES)
      writeFileSync(join(stateRoot, name), `before ${name}`);
    const backup = join(dir, "backup");
    mkdirSync(join(backup, EXPORTS_SUBDIR), { recursive: true });
    writeFileSync(join(backup, EXPORTS_SUBDIR, "office-export.zip"), "zip");
    // What the root held when the apps stopped: the credentials go first,
    // so a hung app stop cannot hold them in the root.
    const atAppStop: string[][] = [];
    const fake = fakeApps(["board", "idle"], ["board"], ["board", "idle"]);
    const apps: LockdownApps = {
      ...fake.apps,
      stop: (name) => {
        atAppStop.push(
          QUARANTINED_FILES.filter((n) => existsSync(join(stateRoot, n))),
        );
        fake.apps.stop(name);
      },
    };
    return { stateRoot, backup, apps, fake, atAppStop };
  }

  const inRoot = (stateRoot: string) =>
    QUARANTINED_FILES.filter((n) => existsSync(join(stateRoot, n)));
  const lockdownDirs = (stateRoot: string) =>
    readdirSync(stateRoot).filter((n) => n.startsWith(LOCKDOWN_DIR_PREFIX));

  test("moves the credentials aside first, empties the exports, stops what runs, disables the enabled units and records both", () => {
    const b = lockBed();
    const result = applyLockEffects({
      stateRoot: b.stateRoot,
      apps: b.apps,
      exportBaseDir: b.backup,
      now: NOW,
    });
    const dirs = lockdownDirs(b.stateRoot);
    expect({
      inRoot: inRoot(b.stateRoot),
      dirs: dirs.length,
      moved: readdirSync(join(b.stateRoot, dirs[0] ?? "none")).sort(),
      exports: readdirSync(join(b.backup, EXPORTS_SUBDIR)),
      appCalls: [...b.fake.calls].sort(),
      atAppStop: b.atAppStop,
      record: readRecord(b.stateRoot, LOCKDOWN_APPS_FILE),
      disabledRecord: readRecord(b.stateRoot, LOCKDOWN_DISABLED_APPS_FILE),
      result,
    }).toEqual({
      inRoot: [],
      dirs: 1,
      moved: [...QUARANTINED_FILES].sort(),
      exports: [],
      appCalls: ["disable board", "disable idle", "stop board"],
      atAppStop: [[]],
      record: ["board"],
      disabledRecord: ["board", "idle"],
      result: { revoked: true, appsLeft: [] },
    });
  });

  test("a quarantine that fails still empties the exports and stops the apps, and does not throw", () => {
    const b = lockBed();
    // The quarantine's directory name for NOW is taken by a dangling link:
    // existsSync says free, mkdir fails with EEXIST.
    const stamp = NOW.toISOString().replace(/[:.]/g, "-");
    symlinkSync(
      join(dir, "nowhere"),
      join(b.stateRoot, `${LOCKDOWN_DIR_PREFIX}${stamp}`),
    );
    const result = applyLockEffects({
      stateRoot: b.stateRoot,
      apps: b.apps,
      exportBaseDir: b.backup,
      now: NOW,
    });
    expect({
      // The condition of this test: the quarantine did fail.
      inRoot: inRoot(b.stateRoot).length,
      exports: readdirSync(join(b.backup, EXPORTS_SUBDIR)),
      appCalls: [...b.fake.calls].sort(),
      result,
    }).toEqual({
      inRoot: QUARANTINED_FILES.length,
      exports: [],
      appCalls: ["disable board", "disable idle", "stop board"],
      result: { revoked: false, appsLeft: [] },
    });
  });

  test("apps that cannot be listed do not undo the quarantine or the export sweep, and do not throw", () => {
    const b = lockBed();
    applyLockEffects({
      stateRoot: b.stateRoot,
      apps: {
        ...b.apps,
        list: () => {
          throw new Error("systemctl --user: no bus");
        },
      },
      exportBaseDir: b.backup,
      now: NOW,
    });
    expect({
      inRoot: inRoot(b.stateRoot),
      dirs: lockdownDirs(b.stateRoot).length,
      exports: readdirSync(join(b.backup, EXPORTS_SUBDIR)),
    }).toEqual({ inRoot: [], dirs: 1, exports: [] });
  });

  test("names the apps it could not stop or disable, and still does the rest", () => {
    const b = lockBed();
    const result = applyLockEffects({
      stateRoot: b.stateRoot,
      apps: {
        ...b.apps,
        stop: () => {
          throw new Error("Job for the unit failed");
        },
        disable: (name) => {
          if (name === "idle") throw new Error("Access denied");
          b.apps.disable?.(name);
        },
      },
      exportBaseDir: b.backup,
      now: NOW,
    });
    expect({
      appsLeft: [...result.appsLeft].sort(),
      revoked: result.revoked,
      inRoot: inRoot(b.stateRoot),
      exports: readdirSync(join(b.backup, EXPORTS_SUBDIR)),
      enabled: [...b.fake.enabled],
    }).toEqual({
      appsLeft: ["board", "idle"],
      revoked: true,
      inRoot: [],
      exports: [],
      enabled: ["idle"],
    });
  });
});
