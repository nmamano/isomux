// The office's app supervisor router (internal-docs/member-os-user-design.md,
// slice 3b of task b94dfd25), with the member's supervisor as production
// builds it (createMemberAppHost + createAppSupervisor) and only the runner
// transport faked (fake-member-runner.ts, a model of their user manager).
// The properties:
// - an app goes to the supervisor of its owner's host; an isolated member's
//   app never reaches the office's, and her calls run as her, queued
//   (--no-block), with her files in her home and agent space;
// - a reconnect gives a new supervisor, and the old transport gets nothing;
// - a runner that is not ready: member_os_user, states unknown, no proof;
// - no user manager: apps_not_supported from her own check, and a delete
//   that removes every file of the app from her host; a manager whose bus
//   fails is not "no manager";
// - the delete asks her host fresh, never the held answer;
// - states ask each host once; appUid names the uid that runs the app;
// - a lock disables and the unlock enables only the office's apps, and only
//   where the office's supervisor has the enabled bit (task 367596bc).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stableBunPath } from "../stable-bun-path.ts";
import { freezeAppHostDomain } from "../app-domain.ts";
import { AppSupervisorError } from "../app-supervisor.ts";
import {
  createAppSupervisorRouter,
  type AppOwnerTarget,
} from "../app-supervisor-router.ts";
import { createFakeAppSupervisor } from "./fake-app-supervisor.ts";
import { lockdownApps } from "../lockdown-apps.ts";
import {
  disableAppsForLock,
  LOCKDOWN_DISABLED_APPS_FILE,
  restartAppsAfterLock,
} from "../lockdown.ts";
import {
  createFakeMemberRunner,
  type FakeMemberRunner,
} from "./fake-member-runner.ts";
import type { AppRecord } from "../../shared/types.ts";

beforeAll(() => {
  freezeAppHostDomain();
});

const ALICE = "u-alice";
const ALICE_UID = 4711;
const HOME = "/home/isomux-alice";
const AGENT_ROOT = join(HOME, ".isomux-agent");

const record = (over: Partial<AppRecord> = {}): AppRecord => ({
  name: "hello",
  hostLabel: "hello",
  hostGen: 1,
  port: 21000,
  command: "bun run serve.ts",
  cwd: HOME,
  dataDir: join(AGENT_ROOT, "apps", "data", "hello"),
  userId: ALICE,
  username: "Alice",
  createdBy: "AppBot",
  createdAt: 1,
  ...over,
});

const OFFICE_APP = record({
  name: "office-app",
  hostLabel: "office-app",
  port: 21001,
  userId: "u-owner",
  username: "Owner",
  dataDir: "/state/apps/data/office-app",
});

function setup(
  opts: {
    apps?: AppRecord[];
    target?: () => AppOwnerTarget;
    isolated?: boolean;
    // The office's units that are enabled: the office's supervisor gets the
    // lock's enabled bit (a systemd host), with each query and change logged.
    enabled?: string[];
  } = {},
) {
  const apps = opts.apps ?? [record(), OFFICE_APP];
  const office = createFakeAppSupervisor();
  const bit = { queries: [] as string[][], changes: [] as string[] };
  if (opts.enabled) {
    const enabled = new Set(opts.enabled);
    Object.assign(office, {
      enabledApps: (names: readonly string[]) => {
        bit.queries.push([...names]);
        return names.filter((n) => enabled.has(n));
      },
      enable: (name: string) => {
        bit.changes.push(`enable:${name}`);
        enabled.add(name);
      },
      disable: (name: string) => {
        bit.changes.push(`disable:${name}`);
        enabled.delete(name);
      },
    });
  }
  // One model of her host; each connection is its own transport, counted.
  const runner = createFakeMemberRunner({
    uid: ALICE_UID,
    home: HOME,
    agentRoot: AGENT_ROOT,
  });
  const connections: { requests: number }[] = [];
  let key: object = {};
  const memberTarget = (): AppOwnerTarget => ({
    kind: "member",
    key,
    uid: ALICE_UID,
    socketPath: "/run/isomux/alice.sock",
    home: HOME,
    agentRoot: AGENT_ROOT,
    runtimeBinDir: "/share/alice/runtime/current",
  });
  let target = opts.target ?? memberTarget;
  const connect = () => {
    const connection = { requests: 0 };
    connections.push(connection);
    return ((request, input, bound) => {
      connection.requests++;
      return runner.call(request, input, bound);
    }) as FakeMemberRunner["call"];
  };
  const router = createAppSupervisorRouter({
    office,
    officeAppUid: () => 1000,
    owners: (names) =>
      new Map(
        apps
          .filter((app) => names.includes(app.name))
          .map((app) => [app.name, app.userId]),
      ),
    anyIsolated: () => opts.isolated ?? true,
    target: (userId) => (userId === ALICE ? target() : { kind: "office" }),
    memberName: (userId) => (userId === ALICE ? "Alice" : userId),
    memberHostCall: () => connect(),
    log: () => {},
  });
  return {
    router,
    office,
    bit,
    lockApps: () => lockdownApps(router, { list: () => apps }),
    connections,
    runner: () => runner,
    reconnect: () => {
      key = {};
    },
    setTarget: (next: () => AppOwnerTarget) => {
      target = next;
    },
    memberTarget,
  };
}

const spawns = (runner: FakeMemberRunner) =>
  runner.requests.flatMap((r) => (r.op === "spawn" ? [r] : []));
const verbs = (runner: FakeMemberRunner) =>
  spawns(runner).map((r) => r.argv.slice(0, 3).join(" "));
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof AppSupervisorError ? error.code : "other";
  }
};

describe("the router sends each app to its owner's host", () => {
  // MUTANT: install routes every app to the office (dies at her start: her
  // host has no unit).
  it("installs, starts and stops a member's app as her, and the office's app on the office", () => {
    const s = setup();
    s.router.install(record());
    s.router.stop("hello");
    s.router.start("hello");
    s.router.restart("hello");
    s.router.install(OFFICE_APP);
    expect(s.office.calls).toEqual(["install:office-app"]);
    const runner = s.runner();
    const queued = spawns(runner)
      .filter((r) => ["start", "stop", "restart"].includes(r.argv[2] ?? ""))
      .map((r) => [r.argv[2], r.argv.includes("--no-block")]);
    expect(queued).toEqual([
      ["start", true],
      ["stop", true],
      ["start", true],
      ["restart", true],
    ]);
    // Her environment only: her runtime folder and bus, the system PATH.
    const envs = new Set(
      spawns(runner).map((r) => JSON.stringify(r.fullEnv ?? null)),
    );
    expect(
      [...envs].map((e) => JSON.parse(e) as Record<string, string>),
    ).toEqual([
      {
        PATH: expect.any(String),
        HOME,
        XDG_RUNTIME_DIR: `/run/user/${ALICE_UID}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${ALICE_UID}/bus`,
      },
    ]);
    const files = runner.appFiles("hello");
    // Unit and enable link in her unit folder; launcher and token in her
    // agent space.
    const unitDir = join(HOME, ".config", "systemd", "user") + "/";
    const appsDir = join(AGENT_ROOT, "apps") + "/";
    expect(
      files.filter((p) => !p.startsWith(unitDir) && !p.startsWith(appsDir)),
    ).toEqual([]);
    expect(files.filter((p) => p.startsWith(unitDir)).length).toBe(2);
    // The launcher is private: it holds agent-written code.
    const launcher = files.find((path) => path.endsWith("/hello.sh"))!;
    const node = runner.fs.get(launcher);
    expect(node?.kind === "file" ? node.mode & 0o077 : -1).toBe(0);
  });

  it("gives her token file mode 0600 in her agent space, and never writes the office's", () => {
    const s = setup();
    s.router.install(record());
    s.router.provisionToken("hello", "tok-secret");
    const runner = s.runner();
    const tokenFile = runner
      .appFiles("hello")
      .find(
        (path) =>
          path.endsWith("/hello.env") &&
          path.startsWith(join(AGENT_ROOT, "apps", "units")),
      );
    const node = tokenFile ? runner.fs.get(tokenFile) : undefined;
    expect(
      node?.kind === "file"
        ? [node.text.includes("tok-secret"), node.mode]
        : null,
    ).toEqual([true, 0o600]);
    expect(s.office.calls.filter((c) => c.includes("hello"))).toEqual([]);
  });

  // MUTANT: the router keeps a supervisor across a new key (dies on the
  // old runner's request count).
  it("takes a new supervisor after her runner connects again, and the old transport gets nothing", () => {
    const s = setup();
    s.router.install(record());
    const first = s.connections[0]!;
    const before = first.requests;
    s.reconnect();
    s.router.stop("hello");
    expect([s.connections.length, first.requests - before]).toEqual([2, 0]);
  });

  it("asks each host once for the states of many apps", () => {
    const apps = [
      record(),
      record({ name: "second", hostLabel: "second", port: 21002 }),
      OFFICE_APP,
    ];
    const s = setup({ apps });
    s.router.install(apps[0]!);
    s.router.install(apps[1]!);
    s.office.calls.length = 0;
    const runner = s.runner();
    const showsBefore = verbs(runner).filter((v) => v.endsWith(" show")).length;
    const states = s.router.states(["hello", "office-app", "second"]);
    expect([...states.keys()]).toEqual(["hello", "office-app", "second"]);
    expect(states.get("hello")?.state).toBe("running");
    expect(s.office.calls).toEqual(["states:office-app"]);
    expect(
      verbs(runner).filter((v) => v.endsWith(" show")).length - showsBefore,
    ).toBe(1);
  });

  it("names the uid that runs each app, and none for a member who is not ready", () => {
    const s = setup();
    expect([s.router.appUid("hello"), s.router.appUid("office-app")]).toEqual([
      ALICE_UID,
      1000,
    ]);
    s.setTarget(() => ({ kind: "not_ready" }));
    expect(s.router.appUid("hello")).toBeNull();
  });

  it("goes straight to the office while no member is isolated", () => {
    const s = setup({ isolated: false });
    s.router.start("hello");
    expect([s.office.calls, s.connections.length]).toEqual([
      ["start:hello"],
      0,
    ]);
  });
});

// Task a77cc175: her OS user cannot search the office user's home, so her
// unit PATH names her own runtime (the bun her runner runs), and her app
// folder's node_modules/.bin as she sees it.
describe("her app's PATH", () => {
  const OFFICE_BUN_DIR = dirname(stableBunPath());
  const RUNTIME = "/share/alice/runtime/current";
  const pathOf = (unit: string): string[] | null => {
    const prefix = 'Environment="PATH=';
    const line = unit
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length, -1).split(":") : null;
  };
  // The unit itself, not its enable link in a .wants folder.
  const herUnitPath = (runner: FakeMemberRunner): string | undefined =>
    runner
      .appFiles("hello")
      .find(
        (p) =>
          dirname(p) === join(HOME, ".config", "systemd", "user") &&
          p.endsWith(".service"),
      );
  const herUnit = (runner: FakeMemberRunner): string => {
    const path = herUnitPath(runner);
    const node = path ? runner.fs.get(path) : undefined;
    return node?.kind === "file" ? node.text : "";
  };

  // MUTANT: defaultMemberSupervisor without runtimeBinDir (dies on the
  // runtime entry).
  it("names her runtime folder and the .bin folders only her host sees, never the office's bun", () => {
    const s = setup();
    const runner = s.runner();
    const bin = join(HOME, "node_modules", ".bin");
    runner.fs.set(join(HOME, "node_modules"), { kind: "dir" });
    runner.fs.set(bin, { kind: "dir" });
    expect(existsSync(bin)).toBe(false);
    s.router.install(record());
    const path = pathOf(herUnit(runner));
    expect(path?.slice(0, 2)).toEqual([bin, RUNTIME]);
    expect(OFFICE_BUN_DIR).not.toBe(RUNTIME);
    expect(path).not.toContain(OFFICE_BUN_DIR);
  });

  it("checks her installed unit against her runtime folder", () => {
    const s = setup();
    s.router.install(record());
    const runner = s.runner();
    expect(s.router.unitPathHasRuntime("hello")).toBe(true);
    const unitPath = herUnitPath(runner)!;
    const node = runner.fs.get(unitPath);
    if (node?.kind !== "file") throw new Error("no unit");
    const current = pathOf(node.text)!.join(":");
    // The unit as the bug wrote it: the office user's bun folder.
    const stale = node.text.replace(
      `PATH=${current}`,
      `PATH=${OFFICE_BUN_DIR}:/usr/bin:/bin`,
    );
    expect(stale).not.toBe(node.text);
    runner.fs.set(unitPath, { ...node, text: stale });
    expect(s.router.unitPathHasRuntime("hello")).toBe(false);
  });
});

describe("a member whose runner is not ready", () => {
  // MUTANT: routeOwner sends a not-ready owner to the office (dies on the
  // code: the office answers).
  it("gets member_os_user, unknown states, no proof and a refused delete", () => {
    const s = setup({ target: () => ({ kind: "not_ready" }) });
    expect([
      codeOf(() => s.router.start("hello")),
      codeOf(() => s.router.teardown("hello")),
      s.router.states(["hello"]).get("hello")?.state,
      s.router.provablyNotRunning("hello"),
      s.router.ownerAppsRefusal(ALICE)?.code,
    ]).toEqual([
      "member_os_user",
      "member_os_user",
      "unknown",
      false,
      "member_os_user",
    ]);
    expect(s.office.calls).toEqual([]);
  });
});

describe("a member with no systemd user manager", () => {
  it("gets apps_not_supported from her own check, and nothing is written", () => {
    const s = setup();
    s.router.states(["hello"]);
    s.runner().setManager("down");
    s.reconnect();
    expect(codeOf(() => s.router.install(record()))).toBe("apps_not_supported");
    expect(s.router.ownerAppsRefusal(ALICE)?.code).toBe("apps_not_supported");
    expect(s.runner().appFiles("hello")).toEqual([]);
    expect(s.office.calls).toEqual([]);
  });

  // F1(a). MUTANT: the no-manager branch skips her host's files (dies on
  // the files left).
  it("deletes an app whose files are on her host and removes every one of them", () => {
    const s = setup();
    s.router.install(record());
    s.router.provisionToken("hello", "tok");
    const runner = s.runner();
    // The enabling condition: unit, link, launcher, token are there.
    expect(runner.appFiles("hello").length).toBeGreaterThanOrEqual(4);
    runner.setManager("down");
    expect(codeOf(() => s.router.teardown("hello"))).toBeNull();
    expect(runner.appFiles("hello")).toEqual([]);
  });

  // F1(b). MUTANT: a failed show-environment is proof by itself (dies on
  // the teardown that goes on).
  it("refuses the delete while her manager runs but its bus does not answer, and removes nothing", () => {
    const s = setup();
    s.router.install(record());
    const runner = s.runner();
    const files = runner.appFiles("hello");
    runner.setManager("busFails");
    expect([
      codeOf(() => s.router.teardown("hello")),
      s.router.provablyNotRunning("hello"),
    ]).toEqual(["supervisor_failed", false]);
    expect(runner.appFiles("hello")).toEqual(files);
  });

  // MUTANT: managerFolderAbsent() true on any stat error (dies on the
  // teardown that goes on).
  it("refuses the delete when her manager's runtime folder cannot be read, and removes nothing", () => {
    const s = setup();
    s.router.install(record());
    const runner = s.runner();
    const files = runner.appFiles("hello");
    runner.setManager("down");
    runner.statErrors.set(`/run/user/${ALICE_UID}/systemd`, "EACCES");
    expect([
      codeOf(() => s.router.teardown("hello")),
      s.router.provablyNotRunning("hello"),
    ]).toEqual(["supervisor_failed", false]);
    expect(runner.appFiles("hello")).toEqual(files);
  });

  // B3a. MUTANT: teardown reads the held answer (dies on the stop that
  // never comes).
  it("asks her host again at the delete: a manager back up gets the full teardown", () => {
    const s = setup();
    s.router.install(record());
    const runner = s.runner();
    runner.setManager("down");
    // The held answer of a new connection: no manager.
    s.reconnect();
    expect(s.router.canRun(ALICE)).toBe(false);
    runner.setManager("up");
    runner.units.set([...runner.units.keys()][0]!, "active");
    expect(codeOf(() => s.router.teardown("hello"))).toBeNull();
    expect([
      verbs(runner).some((v) => v === "systemctl --user stop"),
      runner.appFiles("hello"),
      [...runner.units.values()],
    ]).toEqual([true, [], ["inactive"]]);
  });
});

describe("a member's teardown on her host", () => {
  it("refuses while the stop is still running, and removes no file", () => {
    const s = setup();
    s.router.install(record());
    const runner = s.runner();
    const files = runner.appFiles("hello");
    runner.slowStopShows = 1_000;
    const begin = Date.now();
    const error = (() => {
      try {
        s.router.teardown("hello");
        return null;
      } catch (e) {
        return e as AppSupervisorError;
      }
    })();
    expect([error?.code, Date.now() - begin < 6_000]).toEqual([
      "supervisor_failed",
      true,
    ]);
    expect(runner.appFiles("hello")).toEqual(files);
  }, 15_000);

  // MUTANT: teardown without the office's half (dies on the office's
  // calls).
  it("also removes what a failed move left on the office's host", () => {
    const s = setup();
    s.router.install(record());
    s.router.teardown("hello");
    expect(s.office.calls).toEqual(["teardown:hello"]);
  });
});

describe("a member's secrets and data", () => {
  it("writes her app's secrets file through her host with mode 0600, and the office's is the office's", () => {
    const s = setup();
    const file = s.router.secretsFile(record());
    file!.write('KEY="v"\n');
    const runner = s.runner();
    const path = join(AGENT_ROOT, "apps", "secrets", "hello.env");
    const node = runner.fs.get(path);
    expect(node?.kind === "file" ? [node.text, node.mode] : null).toEqual([
      'KEY="v"\n',
      0o600,
    ]);
    expect(file!.read()).toBe('KEY="v"\n');
    expect(s.router.secretsFile(OFFICE_APP)).toBeNull();
  });

  it("makes her app's data folder and sets it aside through her host", () => {
    const s = setup();
    const root = join(AGENT_ROOT, "apps", "data");
    s.router.makeDataDir(ALICE, join(root, "hello"));
    const runner = s.runner();
    expect(runner.fs.get(join(root, "hello"))?.kind).toBe("dir");
    s.router.retireDataDir(ALICE, root, "hello", 77);
    s.router.makeDataDir(ALICE, join(root, "hello"));
    s.router.retireDataDir(ALICE, root, "hello", 77);
    expect(
      [...runner.fs.keys()]
        .filter((p) => p.startsWith(join(root, ".retired") + "/"))
        .sort(),
    ).toEqual([
      join(root, ".retired", "hello-77"),
      join(root, ".retired", "hello-77-2"),
    ]);
    expect(runner.fs.has(join(root, "hello"))).toBe(false);
    // An office owner has no host to make it on.
    expect(codeOf(() => s.router.makeDataDir("u-owner", "/x"))).toBe(
      "supervisor_failed",
    );
  });
});

describe("the lock's enabled bit through the router", () => {
  let stateRoot = "";
  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "router-lock-bit-"));
  });
  afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));
  const fresh = () => {
    rmSync(join(stateRoot, LOCKDOWN_DISABLED_APPS_FILE), { force: true });
  };

  // The office's model answers "enabled" for her app's name too (a unit
  // left there), so a router that asked the office about her app would
  // disable it. MUTANT: officeApp is true for a member (dies on the query).
  for (const [label, target] of [
    ["isolated and connected", undefined],
    ["not ready", () => ({ kind: "not_ready" }) as AppOwnerTarget],
  ] as const) {
    it(`disables and enables only the office's app; a member ${label} is never asked`, () => {
      fresh();
      const s = setup({
        enabled: ["office-app", "hello"],
        ...(target ? { target } : {}),
      });
      const locked = disableAppsForLock(stateRoot, s.lockApps());
      expect([locked, s.bit.queries, s.bit.changes]).toEqual([
        { disabled: ["office-app"], failed: [] },
        [["office-app"]],
        ["disable:office-app"],
      ]);
      expect(
        JSON.parse(
          readFileSync(join(stateRoot, LOCKDOWN_DISABLED_APPS_FILE), "utf8"),
        ),
      ).toEqual(["office-app"]);
      // An enable named for her app (an older record) does nothing.
      s.router.enable!("hello");
      s.router.disable!("hello");
      restartAppsAfterLock(stateRoot, s.lockApps(), () => true);
      expect([s.bit.changes, s.connections.length]).toEqual([
        ["disable:office-app", "enable:office-app"],
        0,
      ]);
    });
  }

  // MUTANT: the bit is always present (dies on failed: the office's
  // enabledApps is missing) / never present (dies in the case above).
  it("has no enabled bit when the office's supervisor has none", () => {
    fresh();
    const s = setup();
    expect([
      "enabledApps" in s.router,
      disableAppsForLock(stateRoot, s.lockApps()),
    ]).toEqual([false, { disabled: [], failed: [] }]);
  });
});
