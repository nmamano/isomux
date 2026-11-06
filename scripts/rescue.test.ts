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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCK_MARKER_FILE,
  LOCKDOWN_DIR_PREFIX,
  QUARANTINED_FILES,
  writeStateMarker,
} from "../server/lockdown.ts";
import {
  loadRescueConfig,
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
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
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
