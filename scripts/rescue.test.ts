// The rescue host command (task cdd7883d) on a user-unit install, where it
// does every step itself. The host is a fake: systemctl keeps a unit state
// and runs hooks at stop and start, the process table is a list, kills are
// recorded. The state root and the root-marker dir are temp dirs; the audit
// rows are read back from the real office.sqlite the command writes.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
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
  LOCKDOWN_DIR_PREFIX,
  QUARANTINED_FILES,
  ROOT_MARKER_FILE,
  lockMarkerBody,
  writeStateMarker,
} from "../server/lockdown.ts";
import {
  INSTRUCTION_FILE_NAMES,
  agentBrief,
  loadRescueConfig,
  renameInstructionFiles,
  runRescue,
  type ProcessInfo,
  type RescueConfig,
  type RescueHost,
} from "./rescue.ts";

const NOW = new Date("2026-11-06T10:00:00.000Z");
const OFFICE_UID = 1001;
const AGENT_UID = 3000;
// The unit's main pid: every process the office started carries it in
// ISOMUX_OFFICE_PID (server/stop-reap.ts).
const OFFICE_PID = 4242;
const OUTSIDE_CGROUP = "0::/user.slice/user-1001.slice/session-3.scope\n";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

interface Bed {
  config: RescueConfig;
  stateRoot: string;
  host: RescueHost;
  unit: { active: boolean; enabled: boolean };
  /** Every systemctl call, flags included. */
  calls: string[][];
  /** The systemctl verbs in order, flags dropped. */
  verbs(): string[];
  killed: number[];
  out: { log: string[]; err: string[] };
  /** What the hooks saw at each stop and start. */
  seen: {
    stop: { marker: boolean; lockdownAudits: number }[];
    start: { marker: boolean; lockdownAudits: number }[];
  };
  run(argv: string[]): Promise<number>;
}

const VERBS = new Set([
  "stop",
  "start",
  "restart",
  "enable",
  "disable",
  "is-active",
  "is-enabled",
  "show",
  "reset-failed",
  "daemon-reload",
]);

function auditRows(
  stateRoot: string,
): { actor_kind: string; operation: string; record: string }[] {
  const path = join(stateRoot, "office.sqlite");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const table = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='audit'",
      )
      .get();
    if (!table) return [];
    return db
      .query(
        "SELECT actor_kind, operation, record FROM audit ORDER BY sequence",
      )
      .all() as { actor_kind: string; operation: string; record: string }[];
  } finally {
    db.close();
  }
}

function lockdownAudits(stateRoot: string): number {
  return auditRows(stateRoot).filter((r) => r.operation === "office.lockdown")
    .length;
}

function bed(
  opts: {
    active?: boolean;
    enabled?: boolean;
    selfCgroup?: string;
    processes?: ProcessInfo[];
    /** /readyz answers while the unit is active (default: per the marker). */
    readyz?: () => { status: number; body: string } | null;
    /** Runs at each start, before the unit is active. */
    onStart?: () => void;
  } = {},
): Bed {
  dir = mkdtempSync(join(tmpdir(), "rescue-test-"));
  const stateRoot = join(dir, "state");
  const etc = join(dir, "etc");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(etc, { recursive: true });
  const unit = { active: opts.active ?? true, enabled: opts.enabled ?? true };
  const calls: string[][] = [];
  const killed: number[] = [];
  const out = { log: [] as string[], err: [] as string[] };
  const seen: Bed["seen"] = { stop: [], start: [] };
  let clock = +NOW;
  const markerNow = () => existsSync(join(stateRoot, LOCK_MARKER_FILE));
  const onStop = () => {
    seen.stop.push({
      marker: markerNow(),
      lockdownAudits: lockdownAudits(stateRoot),
    });
    // The server writes its sessions from memory as it shuts down.
    if (unit.active) writeFileSync(join(stateRoot, "sessions.json"), "flushed");
    unit.active = false;
  };
  const onStart = () => {
    opts.onStart?.();
    seen.start.push({
      marker: markerNow(),
      lockdownAudits: lockdownAudits(stateRoot),
    });
    unit.active = true;
  };
  const config: RescueConfig = {
    stateRoot,
    serviceName: "isomux",
    serviceKind: "user",
    deploymentKind: "git",
    serviceUser: null,
    baseUrl: "http://127.0.0.1:4000",
    rootMarkerDir: etc,
    statusDir: null,
  };
  const host: RescueHost = {
    systemctl(args) {
      calls.push([...args]);
      const verb = args.find((a) => VERBS.has(a)) ?? "";
      const now = args.includes("--now");
      switch (verb) {
        case "is-active":
          return unit.active
            ? { code: 0, stdout: "active\n" }
            : { code: 3, stdout: "inactive\n" };
        case "is-enabled":
          return unit.enabled
            ? { code: 0, stdout: "enabled\n" }
            : { code: 1, stdout: "disabled\n" };
        case "show": {
          const value = args.join(" ").includes("ExecMainPID")
            ? OFFICE_PID
            : unit.active
              ? OFFICE_PID
              : 0;
          const name = args.join(" ").includes("ExecMainPID")
            ? "ExecMainPID"
            : "MainPID";
          return {
            code: 0,
            stdout: args.includes("--value")
              ? `${value}\n`
              : `${name}=${value}\n`,
          };
        }
        case "stop":
          onStop();
          return { code: 0, stdout: "" };
        case "start":
          onStart();
          return { code: 0, stdout: "" };
        case "restart":
          if (unit.active) onStop();
          onStart();
          return { code: 0, stdout: "" };
        case "enable":
          unit.enabled = true;
          if (now) onStart();
          return { code: 0, stdout: "" };
        case "disable":
          unit.enabled = false;
          if (now) onStop();
          return { code: 0, stdout: "" };
        default:
          return { code: 0, stdout: "" };
      }
    },
    journal: () => "journal line\n",
    readyz: async () => {
      if (!unit.active) return null;
      if (opts.readyz) return opts.readyz();
      return markerNow()
        ? { status: 200, body: "locked\n" }
        : { status: 200, body: "ok\n" };
    },
    processes: () => opts.processes ?? [],
    kill: (pid) => {
      killed.push(pid);
    },
    selfPid: 500,
    selfCgroup: opts.selfCgroup ?? OUTSIDE_CGROUP,
    splitAgentUid: AGENT_UID,
    officeUid: OFFICE_UID,
    diskFree: () => 50e9,
    checkoutPosition: () => ({ branch: null, previousCommit: null }),
    readStdin: async () => "",
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    // The agent subcommand's host (slice 5); its tests replace these.
    home: dir,
    checkoutDir: dir,
    isTty: () => false,
    which: () => null,
    spawnCli: async () => 0,
    readBrief: () => "",
  };
  return {
    config,
    stateRoot,
    host,
    unit,
    calls,
    verbs: () =>
      calls
        .map((c) => c.find((a) => VERBS.has(a)) ?? "")
        .filter((v) => !["is-active", "is-enabled", "show"].includes(v)),
    killed,
    out,
    seen,
    run: (argv) =>
      runRescue(argv, config, host, {
        log: (line) => out.log.push(line),
        err: (line) => out.err.push(line),
      }),
  };
}

function seedCredentials(stateRoot: string): void {
  for (const name of QUARANTINED_FILES)
    writeFileSync(join(stateRoot, name), `before ${name}`);
}

/** Every credential file that ended in a lockdown dir, by name: content. */
function quarantined(stateRoot: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const d of readdirSync(stateRoot).filter((n) =>
    n.startsWith(LOCKDOWN_DIR_PREFIX),
  ))
    for (const name of readdirSync(join(stateRoot, d)))
      found[name] = readFileSync(join(stateRoot, d, name), "utf8");
  return found;
}

const proc = (
  pid: number,
  ppid: number,
  uid: number,
  officePid: number | null,
): ProcessInfo => ({
  pid,
  ppid,
  uid,
  env: officePid === null ? {} : { ISOMUX_OFFICE_PID: String(officePid) },
});

describe("lockdown", () => {
  test("marks, stops, audits, ends this office's leftovers only, moves the credentials aside after the stop's flush, and starts the office locked", async () => {
    const b = bed({
      processes: [
        // Escaped the unit's group (a tmux an agent started): a leftover.
        proc(600, 1, OFFICE_UID, OFFICE_PID),
        // An agent of the split agent user: a leftover too.
        proc(604, 1, AGENT_UID, OFFICE_PID),
        // Another office of the same user (a scratch office): not ours.
        proc(601, 1, OFFICE_UID, 9999),
        // Another user's process that carries the marker: not ours.
        proc(602, 1, 2000, OFFICE_PID),
        // The user's own shell, no marker.
        proc(603, 1, OFFICE_UID, null),
        // Rescue itself, run from a shell that escaped the office's group:
        // never itself or an ancestor.
        proc(300, 1, OFFICE_UID, OFFICE_PID),
        proc(400, 300, OFFICE_UID, OFFICE_PID),
        proc(500, 400, OFFICE_UID, OFFICE_PID),
      ],
    });
    seedCredentials(b.stateRoot);
    const code = await b.run(["lockdown", "--reason", "leaked PAT"]);
    if (code !== 0) console.error(b.out);

    const verbs = b.verbs();
    expect({
      code,
      // Stopped once, then started (locked) at the end.
      firstStop: verbs.indexOf("stop"),
      lastIsStart: ["start", "restart"].includes(verbs[verbs.length - 1]),
      unit: { ...b.unit },
      // The marker came first: a cut after the stop leaves a locked office.
      // The audit came while the unit was down: one writer on office.sqlite.
      atStop: b.seen.stop[0],
      atStart: b.seen.start[b.seen.start.length - 1],
      killed: [...new Set(b.killed)].sort(),
    }).toEqual({
      code: 0,
      firstStop: 0,
      lastIsStart: true,
      unit: { active: true, enabled: true },
      atStop: { marker: true, lockdownAudits: 0 },
      atStart: { marker: true, lockdownAudits: 1 },
      killed: [600, 604],
    });

    // The sessions the server flushed at its stop are the ones moved aside.
    for (const name of QUARANTINED_FILES)
      expect(existsSync(join(b.stateRoot, name))).toBe(false);
    expect(quarantined(b.stateRoot)).toEqual({
      "sessions.json": "flushed",
      "api-tokens.json": "before api-tokens.json",
      "invites.json": "before invites.json",
      "browser-connections.json": "before browser-connections.json",
    });

    const marker = JSON.parse(
      readFileSync(join(b.stateRoot, LOCK_MARKER_FILE), "utf8"),
    );
    expect(marker).toMatchObject({ reason: "leaked PAT" });
    const audits = auditRows(b.stateRoot);
    expect(audits.map((r) => [r.actor_kind, r.operation])).toEqual([
      ["admin_cli", "office.lockdown"],
    ]);
    expect(audits[0].record).toContain("leaked PAT");
  });

  test("--stop leaves the unit stopped and disabled, still marked, audited and with the credentials moved", async () => {
    const b = bed();
    seedCredentials(b.stateRoot);
    const code = await b.run([
      "lockdown",
      "--stop",
      "--reason",
      "hole in HTTP",
    ]);
    expect({
      code,
      unit: { ...b.unit },
      starts: b.seen.start.length,
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
      moved: Object.keys(quarantined(b.stateRoot)).sort(),
      audits: auditRows(b.stateRoot).map((r) => r.operation),
    }).toEqual({
      code: 0,
      unit: { active: false, enabled: false },
      starts: 0,
      marker: true,
      moved: [...QUARANTINED_FILES].sort(),
      audits: ["office.lockdown"],
    });
  });

  // `systemctl stop` ends every process in the unit's group, rescue too, so
  // run from an office terminal or agent shell it would die between the
  // stop and the quarantine.
  for (const [where, cgroup] of [
    [
      "the user unit itself",
      "0::/user.slice/user-1001.slice/user@1001.service/app.slice/isomux.service\n",
    ],
    [
      "a sub-group of the user unit",
      "0::/user.slice/user-1001.slice/user@1001.service/app.slice/isomux.service/agent-7.scope\n",
    ],
    ["the system unit", "0::/system.slice/isomux.service\n"],
  ] as const) {
    test(`refuses to run inside the office unit's group (${where}), before it marks or stops anything`, async () => {
      const b = bed({ selfCgroup: cgroup });
      seedCredentials(b.stateRoot);
      const code = await b.run(["lockdown", "--reason", "x"]);
      expect({
        refused: code !== 0,
        said: b.out.err.length > 0,
        verbs: b.verbs(),
        marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
        unit: { ...b.unit },
      }).toEqual({
        refused: true,
        said: true,
        verbs: [],
        marker: false,
        unit: { active: true, enabled: true },
      });
    });
  }

  test("a group whose name only starts like the office unit's is outside it", async () => {
    const b = bed({
      selfCgroup:
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/isomux-rescue-1.scope\n",
    });
    const code = await b.run(["lockdown", "--reason", "x"]);
    expect({
      code,
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
    }).toEqual({ code: 0, marker: true });
  });
});

describe("unlock", () => {
  test("removes the marker, audits, and restarts a running locked office", async () => {
    const b = bed();
    writeStateMarker(b.stateRoot, { reason: "x", by: "host", now: NOW });
    const code = await b.run(["unlock"]);
    expect({
      code,
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
      // The office came back after the marker went: it boots unlocked.
      atStart: b.seen.start.map((s) => s.marker),
      unit: { ...b.unit },
      audits: auditRows(b.stateRoot).map((r) => [r.actor_kind, r.operation]),
    }).toEqual({
      code: 0,
      marker: false,
      atStart: [false],
      unit: { active: true, enabled: true },
      audits: [["admin_cli", "office.unlock"]],
    });
  });

  test("enables and starts again an office that lockdown --stop disabled", async () => {
    const b = bed({ active: false, enabled: false });
    writeStateMarker(b.stateRoot, { reason: "x", by: "host", now: NOW });
    const code = await b.run(["unlock"]);
    expect({
      code,
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
      atStart: b.seen.start.map((s) => s.marker),
      unit: { ...b.unit },
    }).toEqual({
      code: 0,
      marker: false,
      atStart: [false],
      unit: { active: true, enabled: true },
    });
  });
});

// A lock from inside the office (POST /api/office/lockdown) writes the state
// marker and stops the office; a unit with Restart=on-failure, or no unit,
// leaves it stopped, so no locked boot moves the credentials aside. Unlock
// does it (task b1a56ba0): nothing mints a credential while the office is
// locked, so every credential file present at the unlock predates the lock.
describe("unlock moves aside the credentials a lock left", () => {
  const inRoot = (stateRoot: string) =>
    QUARANTINED_FILES.filter((n) => existsSync(join(stateRoot, n)));
  const unlockAudits = (stateRoot: string) =>
    auditRows(stateRoot).filter((r) => r.operation === "office.unlock").length;
  // The quarantine's directory name for NOW is taken by a dangling link:
  // existsSync says free, mkdir fails with EEXIST. The command's clock is
  // the host's, which is NOW until the first sleep.
  function breakQuarantine(stateRoot: string): string {
    const stamp = NOW.toISOString().replace(/[:.]/g, "-");
    const link = join(stateRoot, `${LOCKDOWN_DIR_PREFIX}${stamp}`);
    symlinkSync(join(dir, "nowhere"), link);
    return link;
  }

  test("a lock that no locked boot followed: the credentials are moved aside before the office starts, and the marker is gone", async () => {
    const atStart: string[][] = [];
    const b = bed({
      active: false,
      onStart: () => atStart.push(inRoot(b.stateRoot)),
    });
    seedCredentials(b.stateRoot);
    writeStateMarker(b.stateRoot, {
      reason: "suspected stolen session",
      by: "Ann",
      now: NOW,
    });
    const code = await b.run(["unlock"]);
    expect({
      code,
      atStart,
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
      inRoot: inRoot(b.stateRoot),
      quarantined: quarantined(b.stateRoot),
      unit: { ...b.unit },
    }).toEqual({
      code: 0,
      atStart: [[]],
      marker: false,
      inRoot: [],
      quarantined: Object.fromEntries(
        QUARANTINED_FILES.map((n) => [n, `before ${n}`]),
      ),
      unit: { active: true, enabled: true },
    });
  });

  test("on an office with no lock marker, unlock moves nothing", async () => {
    const b = bed({ active: false });
    seedCredentials(b.stateRoot);
    const code = await b.run(["unlock"]);
    expect({
      code,
      // The condition of this test: unlock ran to the start.
      started: b.seen.start.length,
      inRoot: inRoot(b.stateRoot),
      dirs: readdirSync(b.stateRoot).filter((n) =>
        n.startsWith(LOCKDOWN_DIR_PREFIX),
      ),
    }).toEqual({
      code: 0,
      started: 1,
      inRoot: [...QUARANTINED_FILES],
      dirs: [],
    });
  });

  test("a quarantine that fails keeps the marker: no unlock audit, no start, exit non-zero", async () => {
    const b = bed({ active: false, enabled: false });
    seedCredentials(b.stateRoot);
    writeStateMarker(b.stateRoot, { reason: "x", by: "Ann", now: NOW });
    breakQuarantine(b.stateRoot);
    const code = await b.run(["unlock"]);
    expect({
      failed: code !== 0,
      // The owner reads why, not a stack trace.
      told: b.out.err.length > 0,
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
      inRoot: inRoot(b.stateRoot),
      verbs: b.verbs(),
      unlockAudits: unlockAudits(b.stateRoot),
      unit: { ...b.unit },
    }).toEqual({
      failed: true,
      told: true,
      marker: true,
      inRoot: [...QUARANTINED_FILES],
      verbs: [],
      unlockAudits: 0,
      unit: { active: false, enabled: false },
    });
  });

  test("a root marker refuses the unlock before anything moves", async () => {
    const b = bed({ active: false });
    seedCredentials(b.stateRoot);
    writeStateMarker(b.stateRoot, { reason: "x", by: "Ann", now: NOW });
    writeFileSync(
      join(b.config.rootMarkerDir, ROOT_MARKER_FILE),
      lockMarkerBody(b.stateRoot, { reason: "x", by: "host", now: NOW }),
    );
    const code = await b.run(["unlock"]);
    expect({
      code,
      // The condition of this test: the root marker refused it.
      refused: b.out.err.some((l) =>
        l.includes(join(b.config.rootMarkerDir, ROOT_MARKER_FILE)),
      ),
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
      inRoot: inRoot(b.stateRoot),
      verbs: b.verbs(),
    }).toEqual({
      code: 1,
      refused: true,
      marker: true,
      inRoot: [...QUARANTINED_FILES],
      verbs: [],
    });
  });

  // The root wrapper's unlock (both flows) calls this step before it starts
  // the office, so the wrapper itself needs no change.
  test("the root step remove-state-marker: no marker moves nothing; a failed quarantine keeps the marker and exits non-zero; then it moves the credentials and removes the marker", async () => {
    const b = bed({ active: false });
    seedCredentials(b.stateRoot);
    const noMarker = await b.run(["_step", "remove-state-marker"]);
    const afterNoMarker = inRoot(b.stateRoot);

    writeStateMarker(b.stateRoot, { reason: "x", by: "Ann", now: NOW });
    const link = breakQuarantine(b.stateRoot);
    const broken = await b.run(["_step", "remove-state-marker"]);
    const afterBroken = {
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
      inRoot: inRoot(b.stateRoot),
    };

    rmSync(link);
    const fixed = await b.run(["_step", "remove-state-marker"]);
    expect({
      noMarker,
      afterNoMarker,
      brokenFailed: broken !== 0,
      afterBroken,
      fixed,
      marker: existsSync(join(b.stateRoot, LOCK_MARKER_FILE)),
      inRoot: inRoot(b.stateRoot),
      quarantined: quarantined(b.stateRoot),
      // A step never touches the unit: the wrapper starts it.
      verbs: b.verbs(),
    }).toEqual({
      noMarker: 0,
      afterNoMarker: [...QUARANTINED_FILES],
      brokenFailed: true,
      afterBroken: { marker: true, inRoot: [...QUARANTINED_FILES] },
      fixed: 0,
      marker: false,
      inRoot: [],
      quarantined: Object.fromEntries(
        QUARANTINED_FILES.map((n) => [n, `before ${n}`]),
      ),
      verbs: [],
    });
  });
});

describe("status", () => {
  // Exit 0 healthy, 1 down, 2 locked; locked wins over down.
  type StatusCase = [
    string,
    Parameters<typeof bed>[0] & { locked?: boolean },
    number,
  ];
  const cases: StatusCase[] = [
    ["a serving office", { active: true }, 0],
    ["a stopped office", { active: false }, 1],
    [
      "a running office whose /readyz does not answer",
      { active: true, readyz: () => null },
      1,
    ],
    ["a locked office", { active: true, locked: true }, 2],
    [
      "an office stopped by lockdown --stop",
      { active: false, enabled: false, locked: true },
      2,
    ],
  ];
  for (const [name, { locked, ...setup }, expected] of cases) {
    test(`${name} exits ${expected}`, async () => {
      const b = bed(setup);
      if (locked)
        writeStateMarker(b.stateRoot, { reason: "x", by: "host", now: NOW });
      expect(await b.run(["status"])).toBe(expected);
      // status changes nothing.
      expect(b.verbs()).toEqual([]);
    });
  }
});

describe("restart", () => {
  test("restarts the unit and succeeds once /readyz answers", async () => {
    const b = bed();
    const code = await b.run(["restart"]);
    expect({ code, verbs: b.verbs(), unit: { ...b.unit } }).toEqual({
      code: 0,
      verbs: ["restart"],
      unit: { active: true, enabled: true },
    });
  });

  test("fails when /readyz never answers after the restart", async () => {
    const b = bed({ readyz: () => null });
    expect(await b.run(["restart"])).not.toBe(0);
  });
});

// The export's content has its own tests (server/office-export.test.ts);
// these check the command: where it writes, what it prints, its exit codes.
describe("export", () => {
  test("writes to the dir given and prints it; with the office up or down, no unit change", async () => {
    const b = bed({ active: false });
    mkdirSync(join(b.stateRoot, "memory"));
    writeFileSync(join(b.stateRoot, "memory", "office.md"), "kept-memory-line");
    const out = join(dir, "given");
    const code = await b.run(["export", out]);
    expect({
      code,
      readme: existsSync(join(out, "README.md")),
      memory: existsSync(join(out, "memory", "office.md"))
        ? readFileSync(join(out, "memory", "office.md"), "utf8")
        : null,
      printed: b.out.log.some((line) => line.includes(out)),
      verbs: b.verbs(),
    }).toEqual({
      code: 0,
      readme: true,
      memory: "kept-memory-line",
      printed: true,
      verbs: [],
    });
  });

  test("without a dir it writes next to the state root, never inside it", async () => {
    const b = bed();
    const before = readdirSync(dir);
    expect(await b.run(["export"])).toBe(0);
    const made = readdirSync(dir).filter((n) => !before.includes(n));
    expect(made).toHaveLength(1);
    expect(made[0].startsWith("state-export-")).toBe(true);
    expect(existsSync(join(dir, made[0], "README.md"))).toBe(true);
    expect(b.out.log.some((line) => line.includes(join(dir, made[0])))).toBe(
      true,
    );
  });

  test("exits 1 and leaves the dir alone when it has content", async () => {
    const b = bed();
    const out = join(dir, "busy");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "mine");
    const code = await b.run(["export", out]);
    expect({
      code,
      left: readdirSync(out),
      said: b.out.err.length > 0,
    }).toEqual({ code: 1, left: ["keep.txt"], said: true });
  });
});

describe("loadRescueConfig", () => {
  const CONF = "/etc/isomux/update.conf";
  test("a root install reads the updater's config, never sourced, and tolerates keys it does not know", () => {
    const conf = [
      "# Written by the isomux installer",
      "REPO_DIR=/home/isomux/isomux",
      "REPO_URL=https://github.com/nmamano/isomux.git",
      "SERVICE_NAME=isomux",
      "SERVICE_KIND=system",
      "SERVICE_USER=isomux",
      "STATE_ROOT=/home/isomux/.isomux",
      "STATUS_DIR=/var/lib/isomux-update",
      "BUN=/usr/local/bin/bun",
      "BASE_URL=http://127.0.0.1:4000",
      "A_KEY_FROM_A_NEWER_UPDATER=$(touch /tmp/x)",
      "",
    ].join("\n");
    const config = loadRescueConfig(
      {},
      (path) => (path === CONF ? conf : null),
      "/root",
    );
    expect(config).toEqual({
      stateRoot: "/home/isomux/.isomux",
      serviceName: "isomux",
      serviceKind: "system",
      deploymentKind: "git",
      serviceUser: "isomux",
      baseUrl: "http://127.0.0.1:4000",
      rootMarkerDir: "/etc/isomux",
      statusDir: "/var/lib/isomux-update",
    });
  });

  test("a container install names the container unit", () => {
    const conf = [
      "DEPLOYMENT_KIND=container",
      "SERVICE_KIND=system",
      "SERVICE_NAME=isomux-container",
      "REPO_URL=https://github.com/nmamano/isomux.git",
      "STATUS_DIR=/var/lib/isomux-update",
      "BASE_URL=http://127.0.0.1:10000",
    ].join("\n");
    const config = loadRescueConfig(
      {},
      (path) => (path === CONF ? conf : null),
      "/root",
    );
    expect(config).toMatchObject({
      serviceName: "isomux-container",
      serviceKind: "system",
      deploymentKind: "container",
      baseUrl: "http://127.0.0.1:10000",
    });
  });

  test("without the updater's config: ISOMUX_HOME or ~/.isomux, the user unit, port 4000", () => {
    const none = () => null;
    expect(
      loadRescueConfig({ ISOMUX_HOME: "/srv/office" }, none, "/home/ann"),
    ).toEqual({
      stateRoot: "/srv/office",
      serviceName: "isomux",
      serviceKind: "user",
      deploymentKind: "git",
      serviceUser: null,
      baseUrl: "http://127.0.0.1:4000",
      rootMarkerDir: "/etc/isomux",
      statusDir: null,
    });
    expect(loadRescueConfig({}, none, "/home/ann").stateRoot).toBe(
      "/home/ann/.isomux",
    );
  });
});

// The release root passes, checked here too: it is printed as it comes.
describe("status --release", () => {
  test("prints the release root passed, and ignores one that is not a release tag", async () => {
    const b = bed();
    expect(
      await b.run(["status", "--no-journal", "--release", "v2026.11.6"]),
    ).toBe(0);
    expect(b.out.log.some((l) => l.includes("v2026.11.6"))).toBe(true);
    const bad = bed();
    const forged = "v2026.11.6-forged$(id)";
    expect(await bad.run(["status", "--no-journal", "--release", forged])).toBe(
      0,
    );
    expect(bad.out.log.some((l) => l.includes("forged"))).toBe(false);
  });
});

describe("rollback", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";

  test("a user-unit checkout gets the manual steps back to the commit before HEAD's last move, with the UI build and the way back to its branch, and nothing runs", async () => {
    const b = bed();
    b.host.checkoutPosition = () => ({
      branch: "main",
      previousCommit: COMMIT,
    });
    const code = await b.run(["rollback"]);
    const said = [...b.out.log, ...b.out.err].join("\n");
    expect({
      code,
      commit: said.includes(`git checkout ${COMMIT}`),
      install: said.includes("bun install"),
      build: said.includes("bun run build:ui"),
      back: said.includes("git checkout main"),
      verbs: b.verbs(),
      unit: { ...b.unit },
    }).toEqual({
      code: 1,
      commit: true,
      install: true,
      build: true,
      back: true,
      verbs: [],
      unit: { active: true, enabled: true },
    });
    // The build comes after the install, and both after the checkout.
    const at = (s: string) => said.indexOf(s);
    expect(at(`git checkout ${COMMIT}`)).toBeLessThan(at("bun install"));
    expect(at("bun install")).toBeLessThan(at("bun run build:ui"));
  });

  test("a checkout with no earlier position still gets the steps, and no invented commit", async () => {
    const b = bed();
    b.host.checkoutPosition = () => ({ branch: null, previousCommit: null });
    const code = await b.run(["rollback"]);
    const said = [...b.out.log, ...b.out.err].join("\n");
    expect({
      code,
      build: said.includes("bun run build:ui"),
      hash: /\b[0-9a-f]{40}\b/.test(said),
      verbs: b.verbs(),
    }).toEqual({ code: 1, build: true, hash: false, verbs: [] });
  });

  for (const [kind, set] of [
    ["a root install", (c: RescueConfig) => (c.serviceKind = "system")],
    [
      "a container install",
      (c: RescueConfig) => (c.deploymentKind = "container"),
    ],
  ] as const) {
    test(`${kind} is sent to the root command, and nothing runs`, async () => {
      const b = bed();
      set(b.config);
      b.host.checkoutPosition = () => ({
        branch: "main",
        previousCommit: COMMIT,
      });
      const code = await b.run(["rollback"]);
      const said = [...b.out.log, ...b.out.err].join("\n");
      expect({
        code,
        root: said.includes("isomux-rescue rollback"),
        manual: said.includes(COMMIT),
        verbs: b.verbs(),
      }).toEqual({ code: 1, root: true, manual: false, verbs: [] });
    });
  }
});

describe("report", () => {
  test("writes the file given, 0600, with the journal and the note, and prints its path; no unit change", async () => {
    const b = bed();
    const file = join(dir, "incident.md");
    const code = await b.run(["report", file, "--note", "tried-a-restart"]);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect({
      code,
      mode: existsSync(file) ? statSync(file).mode & 0o777 : null,
      journal: text.includes("journal line"),
      note: text.includes("tried-a-restart"),
      printed: b.out.log.some((l) => l.includes(file)),
      verbs: b.verbs(),
    }).toEqual({
      code: 0,
      mode: 0o600,
      journal: true,
      note: true,
      printed: true,
      verbs: [],
    });
  });

  test("without a file it writes next to the state root", async () => {
    const b = bed();
    const before = readdirSync(dir);
    expect(await b.run(["report"])).toBe(0);
    const made = readdirSync(dir).filter((n) => !before.includes(n));
    expect(made).toHaveLength(1);
    expect(made[0]).toContain("incident");
    expect(readdirSync(b.stateRoot).some((n) => n.includes("incident"))).toBe(
      false,
    );
  });

  test("refuses a file that exists and leaves it as it was", async () => {
    const b = bed();
    const file = join(dir, "mine.md");
    writeFileSync(file, "my own notes");
    expect(await b.run(["report", file])).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("my own notes");
  });

  // A dangling link to elsewhere is an existing name too: following it would
  // write where the link points.
  test("refuses a link at the file's name", async () => {
    const b = bed();
    const file = join(dir, "link.md");
    const target = join(dir, "elsewhere.md");
    symlinkSync(target, file);
    expect(await b.run(["report", file])).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  test("refuses a file inside the state root", async () => {
    const b = bed();
    const file = join(b.stateRoot, "incident.md");
    expect(await b.run(["report", file])).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  // The root wrapper's step: root read the journal and the updater's files,
  // which the service user cannot, and passes them in.
  test("the root step takes the journal from stdin and the releases and update result root passed", async () => {
    const b = bed();
    b.host.readStdin = async () => "piped-journal-line\n";
    const file = join(dir, "step.md");
    const code = await b.run([
      "_step",
      "report",
      file,
      "--journal-stdin",
      "--release",
      "v2026.11.6",
      "--previous",
      "v2026.11.5",
      "--update-result",
      "update-result-text",
    ]);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect({
      code,
      piped: text.includes("piped-journal-line"),
      ownJournal: text.includes("journal line"),
      release: text.includes("v2026.11.6"),
      previous: text.includes("v2026.11.5"),
      result: text.includes("update-result-text"),
    }).toEqual({
      code: 0,
      piped: true,
      ownJournal: false,
      release: true,
      previous: true,
      result: true,
    });
  });

  test("the root step with - writes the report to stdout and no file", async () => {
    const b = bed();
    b.host.readStdin = async () => "piped-journal-line\n";
    const before = readdirSync(dir);
    const code = await b.run(["_step", "report", "-", "--journal-stdin"]);
    expect({
      code,
      out: b.out.log.join("\n").includes("piped-journal-line"),
      made: readdirSync(dir).filter((n) => !before.includes(n)),
    }).toEqual({ code: 0, out: true, made: [] });
  });

  test("a release root passed that is not a release tag is not written", async () => {
    const b = bed();
    const file = join(dir, "forged.md");
    expect(
      await b.run([
        "_step",
        "report",
        file,
        "--release",
        "v2026.11.6-forged",
        "--previous",
        "forged-prev",
      ]),
    ).toBe(0);
    expect(readFileSync(file, "utf8").includes("forged")).toBe(false);
  });
});

// The agent subcommand on a checkout (slice 5): a new folder with office/
// (the export), report.md and the brief as AGENTS.md and CLAUDE.md, then the
// coding agent's CLI started there. The CLI is a fake that records what it
// was given and what the folder held when it started.
describe("agent", () => {
  const BRIEF =
    "# brief\nRun RESCUE_COMMAND status, then RESCUE_COMMAND lockdown.\n";
  const PROMPT_NAMES = "report.md";

  interface Start {
    argv: string[];
    cwd: string;
    /** Relative paths under the folder, at the start. */
    files: string[];
    /** Lines printed before the start. */
    printedBefore: number;
  }

  function agentBed(
    opts: {
      tty?: boolean;
      clis?: string[];
      cliExit?: number;
    } = {},
  ) {
    const b = bed();
    const starts: Start[] = [];
    const lookups: string[] = [];
    const clis = opts.clis ?? ["claude", "codex"];
    b.host.isTty = () => opts.tty ?? true;
    b.host.which = (name) => {
      lookups.push(name);
      return clis.includes(name) ? `/fake/bin/${name}` : null;
    };
    b.host.readBrief = () => BRIEF;
    b.host.checkoutDir = "/srv/office-checkout";
    b.host.spawnCli = async (argv, cwd) => {
      starts.push({
        argv: [...argv],
        cwd,
        files: existsSync(cwd)
          ? (readdirSync(cwd, { recursive: true }) as string[]).sort()
          : [],
        printedBefore: b.out.log.length + b.out.err.length,
      });
      return opts.cliExit ?? 0;
    };
    // Content the export copies, with instruction files in it.
    mkdirSync(join(b.stateRoot, "memory"), { recursive: true });
    writeFileSync(join(b.stateRoot, "memory", "office.md"), "kept-memory-line");
    mkdirSync(join(b.stateRoot, "skills", "s1"), { recursive: true });
    writeFileSync(join(b.stateRoot, "skills", "s1", "CLAUDE.md"), "injected-1");
    mkdirSync(join(b.stateRoot, "member-skills", "m1", "deep"), {
      recursive: true,
    });
    writeFileSync(
      join(b.stateRoot, "member-skills", "m1", "deep", "Agents.MD"),
      "injected-2",
    );
    return { b, starts, lookups };
  }

  const isInstructionName = (path: string) =>
    INSTRUCTION_FILE_NAMES.includes(path.split("/").pop()!.toLowerCase());

  test("fills a new folder, 0700, with the export, the report and the brief, then starts the CLI there with one opening prompt and returns its exit code", async () => {
    const { b, starts } = agentBed({ cliExit: 7 });
    const folder = join(dir, "given-folder");
    const code = await b.run(["agent", folder]);
    if (code !== 7) console.error(b.out);
    const prefix = "cd /srv/office-checkout && bun run rescue";
    const start = starts[0];
    const read = (rel: string) =>
      existsSync(join(folder, rel))
        ? readFileSync(join(folder, rel), "utf8")
        : null;
    const mode = (rel: string) =>
      existsSync(join(folder, rel))
        ? statSync(join(folder, rel)).mode & 0o777
        : null;
    expect({
      code,
      starts: starts.length,
      cwd: start?.cwd,
      cli: start?.argv[0],
      // One opening prompt, and it sends the agent to the report.
      args: start?.argv.length,
      prompt: start?.argv[1]?.includes(PROMPT_NAMES),
      // Everything was in place when the CLI started.
      atStart: {
        readme: start?.files.includes(join("office", "README.md")),
        memory: start?.files.includes(join("office", "memory", "office.md")),
        report: start?.files.includes("report.md"),
        agents: start?.files.includes("AGENTS.md"),
        claude: start?.files.includes("CLAUDE.md"),
      },
      folderMode: mode(""),
      fileModes: [mode("report.md"), mode("AGENTS.md"), mode("CLAUDE.md")],
      agentsMd: read("AGENTS.md"),
      claudeMd: read("CLAUDE.md"),
      reportHasJournal: read("report.md")?.includes("journal line"),
      memory: read(join("office", "memory", "office.md")),
      // The closing line names the folder to delete.
      closing: b.out.log
        .slice(start?.printedBefore ?? 0)
        .concat(b.out.err)
        .some((l) => l.includes(folder)),
      verbs: b.verbs(),
    }).toEqual({
      code: 7,
      starts: 1,
      cwd: folder,
      cli: "/fake/bin/claude",
      args: 2,
      prompt: true,
      atStart: {
        readme: true,
        memory: true,
        report: true,
        agents: true,
        claude: true,
      },
      folderMode: 0o700,
      fileModes: [0o600, 0o600, 0o600],
      agentsMd: agentBrief(BRIEF, prefix),
      claudeMd: agentBrief(BRIEF, prefix),
      reportHasJournal: true,
      memory: "kept-memory-line",
      closing: true,
      verbs: [],
    });
  });

  // Claude Code loads a nested CLAUDE.md as instructions when it reads files
  // in that folder, so member-written text would steer the agent.
  test("office/ holds no instruction file under its own name when the CLI starts; the content stays, renamed", async () => {
    const { b, starts } = agentBed();
    const folder = join(dir, "renamed");
    expect(await b.run(["agent", folder])).toBe(0);
    const office = join(folder, "office");
    const all = (readdirSync(office, { recursive: true }) as string[]).sort();
    const renamed = all.filter((p) => {
      const name = p.split("/").pop()!;
      return name.startsWith("_") && isInstructionName(name.slice(1));
    });
    expect({
      seededFound:
        starts[0].files.filter((p) => p.startsWith("office/")).length > 0,
      atStart: starts[0].files.filter(
        (p) => p.startsWith("office/") && isInstructionName(p),
      ),
      after: all.filter(isInstructionName),
      renamed: renamed.length,
      kept: renamed.map((p) => readFileSync(join(office, p), "utf8")).sort(),
    }).toEqual({
      seededFound: true,
      atStart: [],
      after: [],
      renamed: 2,
      kept: ["injected-1", "injected-2"],
    });
  });

  test("without a folder it makes isomux-rescue-<stamp> in the home", async () => {
    const { b, starts } = agentBed();
    const before = readdirSync(dir);
    expect(await b.run(["agent"])).toBe(0);
    const made = readdirSync(dir).filter((n) => !before.includes(n));
    expect({
      made: made.length,
      named: made[0]?.startsWith("isomux-rescue-"),
      cwd: starts[0]?.cwd,
    }).toEqual({ made: 1, named: true, cwd: join(dir, made[0] ?? "") });
  });

  test("refuses a folder that exists, empty or not, and starts nothing", async () => {
    for (const content of [[], ["keep.txt"]]) {
      const { b, starts } = agentBed();
      const folder = join(dir, "exists");
      mkdirSync(folder);
      for (const name of content) writeFileSync(join(folder, name), "mine");
      const code = await b.run(["agent", folder]);
      expect({
        code,
        starts: starts.length,
        left: readdirSync(folder),
      }).toEqual({
        code: 1,
        starts: 0,
        left: content,
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses without a terminal on stdin, before it writes anything", async () => {
    const { b, starts } = agentBed({ tty: false });
    const before = readdirSync(dir).sort();
    const code = await b.run(["agent"]);
    const refused = {
      code,
      starts: starts.length,
      made: readdirSync(dir).sort(),
      said: b.out.err.length > 0,
    };
    // The control: the same bed with a terminal starts.
    b.host.isTty = () => true;
    const control = await b.run(["agent"]);
    expect({
      refused,
      control: { code: control, starts: starts.length },
    }).toEqual({
      refused: { code: 1, starts: 0, made: before, said: true },
      control: { code: 0, starts: 1 },
    });
  });

  test("picks claude, else codex; --cli picks one and is never swapped for the other", async () => {
    const cases: {
      clis: string[];
      argv: string[];
      want: string | null;
    }[] = [
      { clis: ["claude", "codex"], argv: [], want: "/fake/bin/claude" },
      { clis: ["codex"], argv: [], want: "/fake/bin/codex" },
      {
        clis: ["claude", "codex"],
        argv: ["--cli", "codex"],
        want: "/fake/bin/codex",
      },
      { clis: ["codex"], argv: ["--cli", "claude"], want: null },
      { clis: ["claude", "codex"], argv: ["--cli", "bash"], want: null },
      { clis: [], argv: [], want: null },
    ];
    const got: (string | null)[] = [];
    const codes: number[] = [];
    const made: number[] = [];
    for (const c of cases) {
      const { b, starts } = agentBed({ clis: c.clis });
      const before = readdirSync(dir).length;
      codes.push(await b.run(["agent", ...c.argv]));
      got.push(starts[0]?.argv[0] ?? null);
      // A refusal comes before the export: no folder.
      made.push(readdirSync(dir).length - before);
      rmSync(dir, { recursive: true, force: true });
    }
    expect({ got, codes, made }).toEqual({
      got: cases.map((c) => c.want),
      codes: cases.map((c) => (c.want ? 0 : 1)),
      made: cases.map((c) => (c.want ? 1 : 0)),
    });
  });
});

describe("renameInstructionFiles", () => {
  test("renames every instruction file name in any case and at any depth with a _ prefix, and nothing else", () => {
    dir = mkdtempSync(join(tmpdir(), "rescue-test-"));
    const files = [
      "CLAUDE.md",
      "a/claude.local.md",
      "a/b/AGENTS.md",
      "a/b/agents.override.MD",
      // Not instruction names.
      "a/CLAUDE.md.bak",
      "a/my-agents.md",
      "a/README.md",
    ];
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), f);
    }
    const returned = renameInstructionFiles(dir).sort();
    const left = (readdirSync(dir, { recursive: true }) as string[])
      .filter((p) => statSync(join(dir, p)).isFile())
      .sort();
    expect({ returned, left }).toEqual({
      returned: [
        join(dir, "_CLAUDE.md"),
        join(dir, "a", "_claude.local.md"),
        join(dir, "a", "b", "_AGENTS.md"),
        join(dir, "a", "b", "_agents.override.MD"),
      ].sort(),
      left: [
        "_CLAUDE.md",
        "a/CLAUDE.md.bak",
        "a/README.md",
        "a/_claude.local.md",
        "a/b/_AGENTS.md",
        "a/b/_agents.override.MD",
        "a/my-agents.md",
      ].sort(),
    });
  });
});

describe("agentBrief", () => {
  test("replaces every placeholder with the prefix, taken literally", () => {
    expect(
      agentBrief(
        "a RESCUE_COMMAND b\nRESCUE_COMMAND c",
        "cd /o$&p$1 && bun run rescue",
      ),
    ).toBe("a cd /o$&p$1 && bun run rescue b\ncd /o$&p$1 && bun run rescue c");
  });

  test("the shipped brief keeps no placeholder once filled", () => {
    const text = readFileSync(join(import.meta.dir, "rescue-agent.md"), "utf8");
    expect(text.includes("RESCUE_COMMAND")).toBe(true);
    expect(
      agentBrief(text, "sudo isomux-rescue").includes("RESCUE_COMMAND"),
    ).toBe(false);
  });
});
