// The apps of isolated members while the office is locked
// (locked-member-apps.ts, slice 3b of task b94dfd25), over a fake runner.
// The properties:
// - the locked office reaches her runner only when its "info" names her
//   recorded uid and user; it stops her running app there and the lock
//   records it;
// - a runner that does not answer: the lock goes on without her app, and a
//   pass every 60 s stops it once her runner answers, then the passes end;
// - those later stops are not recorded.
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeAppHostDomain } from "../app-domain.ts";
import {
  AppSupervisorError,
  unitNameFor,
  unitPrefixFor,
} from "../app-supervisor.ts";
import { AGENT_ROOT, AGENT_ROOT_IS_DEFAULT } from "../split/roots.ts";
import {
  keepStoppingMemberApps,
  lockedAppSupervisor,
} from "../locked-member-apps.ts";
import {
  LOCKDOWN_APPS_FILE,
  stopAppsForLock,
  type LockdownApps,
} from "../lockdown.ts";
import { MEMBER_AGENT_DIR } from "../agent-host.ts";
import { createFakeAppSupervisor } from "./fake-app-supervisor.ts";
import {
  createFakeMemberRunner,
  type FakeMemberRunner,
} from "./fake-member-runner.ts";
import type { AppRecord } from "../../shared/types.ts";

beforeAll(() => {
  freezeAppHostDomain();
});

const ALICE = "u-alice";
const UID = 4711;
const USER = "isomux-alice";
const HOME = "/home/isomux-alice";

const record = (name: string, userId: string | null): AppRecord => ({
  name,
  hostLabel: name,
  hostGen: 1,
  port: 21000 + name.length,
  command: "bun run serve.ts",
  cwd: HOME,
  dataDir: join(HOME, MEMBER_AGENT_DIR, "apps", "data", name),
  userId,
  username: null,
  createdBy: "AppBot",
  createdAt: 1,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const apps = [record("hers", ALICE), record("board", null)];
  const office = createFakeAppSupervisor();
  office.install(apps[1]!);
  const runner = createFakeMemberRunner({
    uid: UID,
    home: HOME,
    agentRoot: join(HOME, MEMBER_AGENT_DIR),
    user: USER,
  });
  // Her app runs on her host (the box boot started it).
  const unitDir = join(HOME, ".config", "systemd", "user");
  runner.fs.set(unitDir, { kind: "dir" });
  // The unit name her supervisor (production's) gives the app.
  const unit = unitNameFor(
    unitPrefixFor(AGENT_ROOT, AGENT_ROOT_IS_DEFAULT),
    "hers",
  );
  runner.fs.set(join(unitDir, unit), {
    kind: "file",
    text: "[Unit]",
    mode: 0o644,
  });
  runner.units.set(unit, "active");
  let up = true;
  const clock = { t: 1_000_000 };
  const transport = { calls: 0 };
  const supervisor = lockedAppSupervisor({
    office,
    owners: (names) =>
      new Map(
        apps
          .filter((a) => names.includes(a.name))
          .map((a) => [a.name, a.userId]),
      ),
    anyIsolated: () => true,
    memberState: (userId) =>
      userId === ALICE
        ? { kind: "isolated", osUser: { name: USER, uid: UID } }
        : { kind: "none" },
    socketPath: (name) => `/run/isomux/${name}.sock`,
    // passwd's answer, never the runner's.
    home: (name, uid) => (name === USER && uid === UID ? HOME : null),
    call: () => (request, input, bound) => {
      transport.calls++;
      return up ? runner.call(request, input, bound) : null;
    },
    now: () => clock.t,
    log: () => {},
  });
  const lockApps: LockdownApps = {
    list: () => apps.map((a) => a.name),
    isActive: (name) =>
      supervisor.states([name]).get(name)?.state !== "stopped",
    stop: (name) => supervisor.stop(name),
    start: (name) => supervisor.start(name),
  };
  const stateRoot = mkdtempSync(join(tmpdir(), "locked-member-apps-"));
  dirs.push(stateRoot);
  return {
    runner,
    office,
    unit,
    supervisor,
    lockApps,
    stateRoot,
    clock,
    transport,
    setUp: (next: boolean) => {
      up = next;
    },
  };
}

const stops = (runner: FakeMemberRunner) =>
  runner.requests.filter((r) => r.op === "spawn" && r.argv[2] === "stop")
    .length;
const recorded = (stateRoot: string) => {
  const path = join(stateRoot, LOCKDOWN_APPS_FILE);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as string[]).sort()
    : null;
};

describe("a locked boot", () => {
  // MUTANT: the target takes the runner's answer without the uid check
  // (dies on the stop of hers).
  it("stops her running app through her runner and records it with the office's", () => {
    const s = setup();
    expect(stopAppsForLock(s.stateRoot, s.lockApps).sort()).toEqual([
      "board",
      "hers",
    ]);
    expect([s.runner.units.get(s.unit), recorded(s.stateRoot)]).toEqual([
      "inactive",
      ["board", "hers"],
    ]);
  });

  // MUTANT: the target takes info's home (dies on HOME).
  it("runs her systemctl with her passwd home, not the home her runner names", () => {
    const s = setup();
    s.runner.info = { uid: UID, user: USER, home: "/tmp/elsewhere" };
    s.supervisor.stop("hers");
    const homes = new Set(
      s.runner.requests.flatMap((r) =>
        r.op === "spawn" ? [r.fullEnv?.HOME ?? ""] : [],
      ),
    );
    expect([...homes]).toEqual([HOME]);
  });

  it("does not ask a runner whose OS user has no passwd home", () => {
    const s = setup();
    const before = s.runner.requests.length;
    const home = lockedAppSupervisor({
      office: s.office,
      owners: () => new Map([["hers", ALICE]]),
      anyIsolated: () => true,
      memberState: () => ({
        kind: "isolated",
        osUser: { name: USER, uid: UID },
      }),
      socketPath: () => "/run/isomux/x.sock",
      home: () => null,
      call: () => s.runner.call,
      log: () => {},
    });
    expect(home.appUid("hers")).toBeNull();
    expect(s.runner.requests.length - before).toBe(0);
  });

  for (const [label, info] of [
    ["another uid", { uid: UID + 1, user: USER, home: HOME }],
    ["another user", { uid: UID, user: "isomux-bob", home: HOME }],
  ] as const) {
    // MUTANT: no uid (or user) compare on the info answer (dies on the
    // code: her runner is used).
    it(`does not use a runner whose info names ${label}`, () => {
      const s = setup();
      s.runner.info = { ...info };
      let code: string | null = null;
      try {
        s.supervisor.stop("hers");
      } catch (error) {
        code = error instanceof AppSupervisorError ? error.code : "other";
      }
      expect([code, stops(s.runner)]).toEqual(["member_os_user", 0]);
    });
  }
});

describe("a runner that answers later", () => {
  // MUTANT: no 30 s hold after a failed ask (dies on the call count).
  it("is asked again every 60 s until her app is stopped, and those stops are not recorded", () => {
    const s = setup();
    s.setUp(false);
    // The lock itself: the office's app is stopped and recorded, hers is not.
    stopAppsForLock(s.stateRoot, s.lockApps);
    expect([recorded(s.stateRoot), s.runner.units.get(s.unit)]).toEqual([
      ["board"],
      "active",
    ]);
    const afterLock = s.transport.calls;
    let tick: (() => void) | null = null;
    let cleared = false;
    const lines: string[] = [];
    keepStoppingMemberApps({
      apps: s.lockApps,
      isMemberApp: (name) => name === "hers",
      setInterval: (fn, ms) => {
        expect(ms).toBe(60_000);
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
      log: (line) => void lines.push(line),
    });
    expect([tick !== null, cleared, s.runner.units.get(s.unit)]).toEqual([
      true,
      false,
      "active",
    ]);
    // The lock asked once; within the 30 s hold the first pass asks no more.
    expect([afterLock, s.transport.calls]).toEqual([1, 1]);
    s.setUp(true);
    s.clock.t += 60_000;
    tick!();
    expect([
      s.runner.units.get(s.unit),
      cleared,
      recorded(s.stateRoot),
    ]).toEqual(["inactive", true, ["board"]]);
    expect(lines.length).toBe(2);
  });

  it("ends at once when nothing of a member runs", () => {
    const s = setup();
    s.runner.units.set(s.unit, "inactive");
    let scheduled = false;
    keepStoppingMemberApps({
      apps: s.lockApps,
      isMemberApp: (name) => name === "hers",
      setInterval: () => {
        scheduled = true;
        return 1;
      },
      clearInterval: () => {},
      log: () => {},
    });
    expect(scheduled).toBe(false);
  });
});
