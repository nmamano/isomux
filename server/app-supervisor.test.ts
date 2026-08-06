// The app supervisor: unit generation, the systemctl call sequences, state
// reads, and journald logs - all against a FAKE host, so this file never
// touches the box's systemd (see the isolation rail in app-supervisor.ts).
//
// Two things are pinned harder than the rest, because both are the kind of bug
// that looks like success:
//   - the ORDER of the calls install and teardown make, since teardown's whole
//     contract is "the caller may now tombstone the name", and
//   - the difference between "systemd refused" and "the app's own process
//     died", which the register route turns into a 500 or a 201.
//
// Zero LLM, zero subprocesses.

import { describe, it, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  APP_LOG_LINES_MAX,
  AppSupervisorError,
  computeAppPath,
  createAppSupervisor,
  createSystemdHost,
  parseSystemctlShow,
  renderLauncher,
  renderUnit,
  unitNameFor,
  unitPrefixFor,
  type RunResult,
  type SupervisorHost,
} from "./app-supervisor.ts";
import type { AppRecord } from "../shared/types.ts";

// --- fixtures ---------------------------------------------------------------

const record = (over: Partial<AppRecord> = {}): AppRecord => ({
  name: "hello",
  port: 21000,
  command: "bun run serve.ts",
  cwd: "/srv/hello",
  dataDir: "/state/apps/data/hello",
  userId: "u1",
  username: "Alice",
  createdBy: "AppBot",
  createdAt: 1,
  ...over,
});

interface FakeHost extends SupervisorHost {
  files: Map<string, string>;
  modes: Map<string, number | undefined>;
  runs: string[][];
}

// `over` scripts individual commands; anything it does not answer succeeds
// silently, which is what systemctl does on a happy path.
function fakeHost(
  over: (argv: string[]) => Partial<RunResult> | undefined = () => undefined,
): FakeHost {
  const files = new Map<string, string>();
  const modes = new Map<string, number | undefined>();
  const runs: string[][] = [];
  return {
    unitDir: "/units",
    launcherDir: "/launchers",
    files,
    modes,
    runs,
    writeFile: (path, contents, mode) => {
      files.set(path, contents);
      modes.set(path, mode);
    },
    removeFile: (path) => void files.delete(path),
    run: (argv) => {
      runs.push(argv);
      const scripted = over(argv);
      if (scripted) return { code: 0, stdout: "", stderr: "", ...scripted };
      // An unscripted `show` answers the way systemd answers about a unit it
      // does not have: an explicit not-found block per unit asked about. The
      // empty string would be a FICTION - systemd never returns nothing - and
      // tests resting on it would be asserting against a state the real thing
      // cannot produce.
      if (argv[2] === "show") {
        const units = argv.slice(3).filter((a) => !a.startsWith("--"));
        return {
          code: 0,
          stdout: units
            .map((u) => showBlock(u, "not-found", "inactive"))
            .join("\n"),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

const showBlock = (
  id: string,
  loadState: string,
  activeState: string,
  nRestarts = 0,
): string =>
  `NRestarts=${nRestarts}\nId=${id}\nLoadState=${loadState}\nActiveState=${activeState}\nSubState=x\n`;

const isRun = (argv: string[], ...expected: string[]): boolean =>
  expected.every((e, i) => argv[i] === e);

// The verbs a run was, in order: "daemon-reload", "enable", "start"...
const verbs = (host: FakeHost): string[] =>
  host.runs.map((argv) => (argv[0] === "systemctl" ? argv[2] : argv[0]));

// Unit-file lines that actually configure something - comments and blanks
// dropped. Golden-testing THESE means the directives are frozen while the
// explanatory prose in the generated file stays editable.
const directives = (unit: string): string[] =>
  unit
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

const supervisor = (host: FakeHost, now: () => number = () => 0) =>
  createAppSupervisor({
    host,
    unitPrefix: "isomux-app-",
    runtimeBinDir: "/rt/bin",
    now,
  });

// --- the unit namespace -----------------------------------------------------

describe("app-supervisor: the unit namespace follows the state root", () => {
  it("gives the default state root the bare production namespace", () => {
    expect(unitPrefixFor("/home/nil/.isomux", true)).toBe("isomux-app-");
    expect(unitNameFor(unitPrefixFor("/home/nil/.isomux", true), "hello")).toBe(
      "isomux-app-hello.service",
    );
  });

  it("gives any other state root a namespace of its own, derived from the path", () => {
    const a = unitPrefixFor("/tmp/office-a", false);
    const b = unitPrefixFor("/tmp/office-b", false);
    // Findable under the glob the standing rail asks test units to carry.
    expect(a.startsWith("isomux-app-test-")).toBe(true);
    expect(a).not.toBe("isomux-app-");
    // Two offices on one box get two namespaces, or one office's delete would
    // stop the other office's app.
    expect(a).not.toBe(b);
    // Derived, not random: the same office gets the same units after a restart,
    // otherwise it would lose track of everything it started.
    expect(unitPrefixFor("/tmp/office-a", false)).toBe(a);
  });

  it("cannot be reached by ANY production app name, whatever it is called", () => {
    // The isolation property, stated as the thing it has to be: not "a
    // collision is unlikely" but "a collision is unconstructible". The state
    // root is not a secret, so a namespace separated only by a digest could be
    // collided with ON PURPOSE by someone who names an app after it.
    const testPrefix = unitPrefixFor("/tmp/whatever", false);
    // Every app name is a DNS label - no dots - so no production unit name can
    // ever start with this.
    expect(testPrefix).toContain(".");
    const appNameGrammar = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
    const productionPrefix = "isomux-app-";
    // The one name that WOULD collide if the dot were not there: everything
    // after the production prefix, offered as an app name.
    const wouldCollide = testPrefix.slice(productionPrefix.length) + "sneaky";
    expect(appNameGrammar.test(wouldCollide)).toBe(false);
  });

  it("stays inside systemd's unit-name limit at the longest legal app name", () => {
    const longestName = "a".repeat(63); // one DNS label, the registry's cap
    const unit = unitNameFor(
      unitPrefixFor("/tmp/some/office", false),
      longestName,
    );
    // systemd's limit is 255; this is the worst case the registry can produce.
    expect(unit.length).toBeLessThan(255);
    expect(unit.endsWith(".service")).toBe(true);
  });
});

// --- rendering --------------------------------------------------------------

describe("app-supervisor: unit generation", () => {
  it("renders the directives an app needs, and only those", () => {
    const unit = renderUnit(record(), {
      launcherPath: "/launchers/hello.sh",
      path: "/p:/q",
      unitName: "isomux-app-hello.service",
    });
    expect(directives(unit)).toEqual([
      "[Unit]",
      "Description=Isomux app hello",
      "After=network.target",
      // Explicit, not systemd's defaults: measured against a real broken app,
      // the defaults did not trip and it looped past 15 restarts.
      "StartLimitIntervalSec=60",
      "StartLimitBurst=5",
      "[Service]",
      "Type=simple",
      // NOT quoted: systemd reads WorkingDirectory as a bare path and refuses
      // a quoted one as "path is not absolute" (found by the live test).
      "WorkingDirectory=/srv/hello",
      'Environment="PORT=21000"',
      'Environment="ISOMUX_APP_NAME=hello"',
      'Environment="ISOMUX_APP_DATA_DIR=/state/apps/data/hello"',
      'Environment="PATH=/p:/q"',
      'ExecStart=/bin/sh "/launchers/hello.sh"',
      "Restart=on-failure",
      "RestartSec=2",
      "TimeoutStopSec=10",
      "MemoryMax=512M",
      "CPUQuota=100%",
      "SyslogIdentifier=isomux-app-hello",
      "[Install]",
      "WantedBy=default.target",
    ]);
  });

  it("never puts the start command in the unit - only in the launcher", () => {
    const app = record({ command: "bun run dev --host" });
    const unit = renderUnit(app, {
      launcherPath: "/launchers/hello.sh",
      path: "/p",
      unitName: "isomux-app-hello.service",
    });
    expect(unit).not.toContain("bun run dev");
    expect(renderLauncher(app)).toContain("bun run dev --host");
  });

  it("writes the command byte for byte, however shell-shaped it is", () => {
    // Quotes, a percent sign, a pipe, a variable, and a compound command: every
    // one of these is either a systemd specifier or a quoting hazard, and the
    // launcher exists precisely so none of them has to be escaped.
    const command = `PORT=$PORT sh -c 'echo "100% done" | tee log.txt' && ./run`;
    const launcher = renderLauncher(record({ command }));
    expect(launcher).toContain(`\n${command}\n`);
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    // No `exec`: it would change what a compound command means.
    expect(launcher).not.toContain("exec ");
  });

  it("escapes each directive the way systemd actually parses it", () => {
    const unit = renderUnit(
      record({
        cwd: `/srv/my app 100% back\\slash "q"`,
        dataDir: `/data/50% "off"\\x`,
      }),
      {
        launcherPath: `/launchers/50% "q"\\hello.sh`,
        path: "/p",
        unitName: "isomux-app-hello.service",
      },
    );
    // WorkingDirectory takes the rest of the line as a literal path: the space
    // needs no quoting and quoting would BREAK it (systemd reads the leading
    // quote as part of the path), and a backslash and a quote are literal
    // there too. Only `%` has to be doubled, because only specifier expansion
    // applies.
    expect(unit).toContain(
      'WorkingDirectory=/srv/my app 100%% back\\slash "q"',
    );
    // Environment and ExecStart ARE quote-parsed, so those values are quoted
    // with the backslash and quote escaped - otherwise the space would split
    // the value and the backslash would eat the character after it.
    expect(unit).toContain(
      'Environment="ISOMUX_APP_DATA_DIR=/data/50%% \\"off\\"\\\\x"',
    );
    expect(unit).toContain(
      'ExecStart=/bin/sh "/launchers/50%% \\"q\\"\\\\hello.sh"',
    );
  });

  it("refuses a value with a line break rather than emitting a broken unit", () => {
    expect(() =>
      renderUnit(record({ cwd: "/srv/two\nlines" }), {
        launcherPath: "/launchers/hello.sh",
        path: "/p",
        unitName: "isomux-app-hello.service",
      }),
    ).toThrow(AppSupervisorError);
  });
});

describe("app-supervisor: PATH", () => {
  it("walks node_modules/.bin upward, nearest first, then the runtime, then the system", () => {
    const present = new Set([
      "/srv/app/node_modules/.bin",
      "/srv/node_modules/.bin",
    ]);
    const path = computeAppPath("/srv/app/web", "/rt/bin", (p) =>
      present.has(p),
    );
    expect(path.split(":")).toEqual([
      "/srv/app/node_modules/.bin",
      "/srv/node_modules/.bin",
      "/rt/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/local/sbin",
      "/usr/sbin",
    ]);
  });

  it("still names the runtime's own directory when there is no node_modules at all", () => {
    // The common case, and the one that matters: `bun run ...` under a systemd
    // user unit has no PATH to find bun on without this.
    const path = computeAppPath("/srv/app", "/home/x/.bun/bin", () => false);
    expect(path.split(":")[0]).toBe("/home/x/.bun/bin");
  });
});

// --- install ----------------------------------------------------------------

describe("app-supervisor: install", () => {
  it("writes the launcher before the unit, then loads, enables and starts", () => {
    const host = fakeHost();
    supervisor(host).install(record());
    expect([...host.files.keys()]).toEqual([
      "/launchers/hello.sh",
      "/units/isomux-app-hello.service",
    ]);
    // No state read on the happy path: systemd already said the start
    // succeeded, so asking it again would be a subprocess for nothing.
    expect(verbs(host)).toEqual(["daemon-reload", "enable", "start"]);
    expect(
      host.runs.some((r) =>
        isRun(r, "systemctl", "--user", "enable", "isomux-app-hello.service"),
      ),
    ).toBe(true);
  });

  it("stops at the first systemd refusal instead of pressing on", () => {
    const host = fakeHost((argv) =>
      argv[2] === "daemon-reload"
        ? { code: 1, stderr: "Failed to reload daemon" }
        : undefined,
    );
    expect(() => supervisor(host).install(record())).toThrow(
      /could not load the new unit.*Failed to reload daemon/s,
    );
    // enable and start never ran: a unit systemd would not load is not a unit
    // to start.
    expect(verbs(host)).toEqual(["daemon-reload"]);
  });

  it("writes the launcher not-world-readable, since an agent wrote its contents", () => {
    const host = fakeHost();
    supervisor(host).install(record());
    expect(host.modes.get("/launchers/hello.sh")).toBe(0o600);
  });

  it("really puts 0600 on disk, and never publishes it laxer even for an instant", () => {
    // Asserting the fake received 0o600 only proves we ASKED. This checks the
    // actual filesystem, and checks the window: the mode has to land on the
    // temp inode BEFORE the rename, or the file is briefly readable at the
    // ambient umask. Pre-seeding a stale .tmp at 0644 covers the case that
    // makes writeFileSync's own `mode` option insufficient - it only applies
    // when the file is created.
    const dir = mkdtempSync(join(tmpdir(), "isomux-launcher-mode-"));
    try {
      const target = join(dir, "hello.sh");
      writeFileSync(target + ".tmp", "stale", { mode: 0o644 });
      chmodSync(target + ".tmp", 0o644);
      const host = createSystemdHost();
      host.writeFile(target, "#!/bin/sh\necho hi\n", 0o600);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns a raw filesystem failure into a recorded supervisor failure", () => {
    // An unwritable unit directory throws a plain Error from fs. Left as one it
    // escapes the recorder AND the register handler's catch, and an app that
    // WAS registered comes back as a bare 500 with no startError - the retry
    // trap (retry -> name_taken) the 201 contract exists to remove.
    for (const failOn of ["/launchers/hello.sh", "/units"]) {
      const host = fakeHost();
      const realWrite = (path: string, contents: string, mode?: number) => {
        host.files.set(path, contents);
        host.modes.set(path, mode);
      };
      host.writeFile = (path, contents, mode) => {
        if (path.startsWith(failOn)) {
          throw Object.assign(new Error("EACCES: permission denied"), {
            code: "EACCES",
          });
        }
        realWrite(path, contents, mode);
      };
      const sup = supervisor(host);
      expect(() => sup.install(record())).toThrow(AppSupervisorError);
      const startError = sup.states(["hello"]).get("hello")?.startError;
      expect(startError).toContain("could not be written");
      expect(startError).toContain("EACCES");
    }
  });

  it("remembers WHICH step refused, so a 201 can still say why", () => {
    // The register route answers 201 whatever happens here, because the
    // registration has already committed - so this recorded reason is the only
    // thing that can explain a dead app to an agent, which cannot read the
    // server log and has no journald line to read either when the unit never
    // installed.
    const cases: [string, RegExp][] = [
      ["daemon-reload", /could not load the new unit/],
      ["enable", /could not enable/],
      ["start", /could not be started/],
    ];
    for (const [verb, expected] of cases) {
      const host = fakeHost((argv) =>
        argv[2] === verb ? { code: 1, stderr: "systemd said no" } : undefined,
      );
      const sup = supervisor(host);
      expect(() => sup.install(record())).toThrow(expected);
      const runtime = sup.states(["hello"]).get("hello");
      expect(runtime?.startError).toMatch(expected);
      expect(runtime?.startError).toContain("systemd said no");
    }
  });

  it("clears a spent start limit BEFORE starting, or recovery cannot recover", () => {
    // Measured on systemd 255: once a unit burns its StartLimitBurst, every
    // later `start` is refused with "start request repeated too quickly" until
    // reset-failed clears the counter. Since the generated unit sets an
    // explicit start limit, that is precisely the state a crash-looping app
    // comes to rest in - so without this ordering the restart verb would fail
    // in the one case it exists for.
    const host = fakeHost();
    const sup = supervisor(host);
    for (const verb of ["restart", "start"] as const) {
      host.runs.length = 0;
      sup[verb]("hello");
      // The exact sequence, not an index comparison: `indexOf` returns -1 for
      // a call that never happened, and -1 is less than every real index, so
      // an ordering assertion alone passes for free when the reset is missing
      // entirely. (Caught by mutation-checking this very test.)
      expect(verbs(host)).toEqual(["reset-failed", verb]);
    }
  });

  it("drops the cached state even when the control call FAILS", () => {
    // systemctl can change state and still exit non-zero, so the failure path
    // is exactly as stale as the success path.
    const host = fakeHost((argv) =>
      argv[2] === "stop"
        ? { code: 1, stderr: "nope" }
        : argv[2] === "show"
          ? {
              stdout: showBlock("isomux-app-hello.service", "loaded", "active"),
            }
          : undefined,
    );
    const sup = supervisor(host);
    sup.states(["hello"]);
    expect(() => sup.stop("hello")).toThrow();
    sup.states(["hello"]);
    expect(host.runs.filter((r) => r[2] === "show").length).toBe(2);
  });

  it("forgets the reason once the app starts, and keeps it across a stop", () => {
    let failing = true;
    const host = fakeHost((argv) =>
      (argv[2] === "start" || argv[2] === "restart") && failing
        ? { code: 1, stderr: "boom" }
        : argv[2] === "show"
          ? {
              stdout: showBlock("isomux-app-hello.service", "loaded", "active"),
            }
          : undefined,
    );
    const sup = supervisor(host);
    expect(() => sup.install(record())).toThrow();
    expect(sup.states(["hello"]).get("hello")?.startError).toBeDefined();

    failing = false;
    sup.start("hello");
    expect(sup.states(["hello"]).get("hello")?.startError).toBeUndefined();

    // A stop is something somebody ASKED for. It is not a start error and it
    // does not erase one - an app that failed and was then stopped on purpose
    // should still be able to say why it failed.
    failing = true;
    expect(() => sup.restart("hello")).toThrow();
    sup.stop("hello");
    expect(sup.states(["hello"]).get("hello")?.startError).toBeDefined();
  });
});

// --- teardown ---------------------------------------------------------------

describe("app-supervisor: teardown", () => {
  it("stops, disables, removes both files, reloads, and clears the failed state", () => {
    const host = fakeHost();
    const sup = supervisor(host);
    sup.install(record());
    host.runs.length = 0;
    sup.teardown("hello");
    expect(verbs(host)).toEqual([
      "stop",
      "disable",
      "daemon-reload",
      "reset-failed",
      "show",
    ]);
    // Both generated files gone - a leftover launcher is a stale copy of a
    // command for an app that no longer exists.
    expect(host.files.size).toBe(0);
  });

  it("forgets a deleted app's recorded failure", () => {
    // Names are never reused, so nothing would ever overwrite this entry: with
    // no delete it sits in the map for the life of the process, describing an
    // app that no longer exists.
    let failing = true;
    const host = fakeHost((argv) =>
      argv[2] === "daemon-reload" && failing
        ? { code: 1, stderr: "boom" }
        : undefined,
    );
    const sup = supervisor(host);
    expect(() => sup.install(record())).toThrow();
    expect(sup.states(["hello"]).get("hello")?.startError).toBeDefined();

    failing = false;
    sup.teardown("hello");
    expect(sup.states(["hello"]).get("hello")?.startError).toBeUndefined();
  });

  it("finishes cleaning up an app whose unit was never installed", () => {
    // The path a delete takes after a failed install: stop and disable both
    // fail against a unit that is not there, and neither is a reason to refuse
    // the delete.
    const host = fakeHost((argv) =>
      argv[2] === "stop" || argv[2] === "disable"
        ? { code: 1, stderr: "Unit isomux-app-hello.service not loaded." }
        : undefined,
    );
    expect(() => supervisor(host).teardown("hello")).not.toThrow();
  });

  it("REFUSES when it cannot ASK whether the app is still running", () => {
    // The subtle version of the same failure, and the one that reads as
    // success: stop fails, the files are deleted anyway, and the state query
    // ALSO fails. Collapsing that query failure into `unknown` would pass the
    // not-running check and let the caller tombstone the name while the process
    // is possibly still alive and holding its port - unrecoverable, because
    // nothing in isomux can reach an app whose name the registry has retired.
    // "I could not tell" must never be evidence of "it is stopped".
    const host = fakeHost((argv) =>
      argv[2] === "stop"
        ? { code: 1, stderr: "Failed to stop: connection terminated" }
        : argv[2] === "show"
          ? { code: 1, stderr: "Failed to connect to bus" }
          : undefined,
    );
    expect(() => supervisor(host).teardown("hello")).toThrow(
      /could not be asked whether it is still running/,
    );
  });

  it("does not remove the unit files when the app could not be stopped", () => {
    const host = fakeHost((argv) =>
      argv[2] === "stop"
        ? { code: 1, stderr: "Failed to stop" }
        : argv[2] === "show"
          ? {
              stdout: showBlock("isomux-app-hello.service", "loaded", "active"),
            }
          : undefined,
    );
    const sup = supervisor(host);
    sup.install(record());
    const before = host.files.size;
    expect(() => sup.teardown("hello")).toThrow(/could not be stopped/);
    // Still on disk: a delete that removed the unit of a running app would
    // orphan the process from systemd's own management.
    expect(host.files.size).toBe(before);
  });

  it("propagates an unexpected disable failure instead of deleting under it", () => {
    // Tolerating this would leave an enabled symlink pointing at a unit file we
    // then delete, which systemd complains about on every later reload.
    const host = fakeHost((argv) =>
      argv[2] === "disable" ? { code: 1, stderr: "Access denied" } : undefined,
    );
    expect(() => supervisor(host).teardown("hello")).toThrow(
      /could not be disabled/,
    );
  });

  it("accepts ONLY an explicit systemd answer as proof that nothing runs", () => {
    // The whitelist, branch by branch. Everything not on it must refuse,
    // because the caller tombstones a name permanently on the strength of it.
    const safe = [
      ["not-found", "inactive"], // no unit at all - what a removed one looks like
      ["loaded", "inactive"],
      ["loaded", "failed"],
    ];
    const unsafe: [string, string][] = [
      ["loaded", "active"],
      ["loaded", "activating"],
      ["loaded", "reloading"],
      // The one the lossy wire mapping calls "stopped": deactivating means the
      // stop is still IN PROGRESS and processes may be alive.
      ["loaded", "deactivating"],
      ["loaded", "some-future-state"],
      ["masked", "inactive"],
      ["error", "inactive"],
    ];
    for (const [load, active] of safe) {
      const host = fakeHost((argv) =>
        argv[2] === "show"
          ? { stdout: showBlock("isomux-app-hello.service", load, active) }
          : undefined,
      );
      expect(() => supervisor(host).teardown("hello")).not.toThrow();
    }
    for (const [load, active] of unsafe) {
      const host = fakeHost((argv) =>
        argv[2] === "show"
          ? { stdout: showBlock("isomux-app-hello.service", load, active) }
          : undefined,
      );
      expect(() => supervisor(host).teardown("hello")).toThrow(
        /still running|NOT deleted/,
      );
    }
  });

  it("REFUSES a successful query that says nothing about this unit", () => {
    // A truncated answer, or one for some other unit, is not an answer. Reading
    // it as "nothing is running" is the same unrecoverable mistake as reading a
    // failed query that way.
    for (const stdout of [
      "", // nothing at all
      "LoadState=loaded\nActiveState=inactive\n", // a block with no Id
      showBlock("some-other.service", "loaded", "inactive"), // wrong unit
      "Id=isomux-app-hello.service\n", // our unit, no states
    ]) {
      const host = fakeHost((argv) =>
        argv[2] === "show" ? { stdout } : undefined,
      );
      expect(() => supervisor(host).teardown("hello")).toThrow();
    }
  });

  it("REFUSES when the app is still running, so its name is not tombstoned", () => {
    // The load-bearing failure. The delete route tombstones only after this
    // returns; a teardown that reported success while the process lived would
    // strand a live app holding a port under a name the registry has forgotten,
    // and nothing in isomux could ever clean it up.
    const host = fakeHost((argv) =>
      argv[2] === "show"
        ? { stdout: showBlock("isomux-app-hello.service", "loaded", "active") }
        : undefined,
    );
    expect(() => supervisor(host).teardown("hello")).toThrow(
      /still running.*NOT deleted/s,
    );
  });
});

// --- state ------------------------------------------------------------------

describe("app-supervisor: reading state", () => {
  it("parses blocks whatever order the properties arrive in", () => {
    // Measured on systemd 255: `show` does not echo the order asked for -
    // NRestarts came back before Id - so a positional parser would report
    // every app's state as another app's.
    const parsed = parseSystemctlShow(
      showBlock("a.service", "loaded", "active", 3) +
        "\n" +
        showBlock("b.service", "not-found", "inactive"),
    );
    expect(parsed.get("a.service")).toEqual({
      state: "running",
      restartCount: 3,
    });
    // A unit that does not exist reads `unknown`, never `stopped`: nothing is
    // arranged to run it, which is a different fact from isomux holding it
    // still on purpose.
    expect(parsed.get("b.service")).toEqual({
      state: "unknown",
      restartCount: 0,
    });
  });

  it("degrades ONE malformed block to unknown instead of poisoning the batch", () => {
    // A block systemd truncated, or a property set we do not recognise, must
    // cost exactly the unit it belongs to. Losing the whole read would make
    // every other app on the Apps tab go unknown at once.
    const parsed = parseSystemctlShow(
      "LoadState=loaded\nActiveState=active\n" + // no Id at all
        "\n" +
        showBlock("b.service", "loaded", "active", 2) +
        "\n" +
        "Id=c.service\n", // no LoadState or ActiveState
    );
    expect(parsed.get("b.service")).toEqual({
      state: "running",
      restartCount: 2,
    });
    expect(parsed.get("c.service")?.state).toBe("unknown");
  });

  it("treats an ActiveState it has never heard of as unknown, not as an error", () => {
    const parsed = parseSystemctlShow(
      showBlock("a.service", "loaded", "some-future-state"),
    );
    expect(parsed.get("a.service")?.state).toBe("unknown");
  });

  it("maps activating and failed to their own states", () => {
    const parsed = parseSystemctlShow(
      showBlock("a.service", "loaded", "activating") +
        "\n" +
        showBlock("b.service", "loaded", "failed"),
    );
    expect(parsed.get("a.service")?.state).toBe("starting");
    expect(parsed.get("b.service")?.state).toBe("failed");
  });

  it("asks once for a whole list of apps, not once per app", () => {
    const host = fakeHost((argv) =>
      argv[2] === "show"
        ? {
            stdout:
              showBlock("isomux-app-one.service", "loaded", "active", 2) +
              "\n" +
              showBlock("isomux-app-two.service", "loaded", "failed"),
          }
        : undefined,
    );
    const states = supervisor(host).states(["one", "two"]);
    expect(host.runs.length).toBe(1);
    expect(states.get("one")).toEqual({ state: "running", restartCount: 2 });
    expect(states.get("two")?.state).toBe("failed");
  });

  it("asks nothing at all for an empty list", () => {
    const host = fakeHost();
    expect(supervisor(host).states([]).size).toBe(0);
    expect(host.runs.length).toBe(0);
  });

  it("reports unknown - never stopped - when systemd cannot be asked", () => {
    const host = fakeHost(() => ({ code: 127, stderr: "systemctl not found" }));
    expect(supervisor(host).states(["one"]).get("one")).toEqual({
      state: "unknown",
      restartCount: 0,
    });
  });

  it("serves a repeat read from cache, and re-reads once it goes stale", () => {
    let clock = 0;
    const host = fakeHost((argv) =>
      argv[2] === "show"
        ? { stdout: showBlock("isomux-app-one.service", "loaded", "active") }
        : undefined,
    );
    const sup = supervisor(host, () => clock);
    sup.states(["one"]);
    sup.states(["one"]);
    expect(host.runs.length).toBe(1);
    clock = 10_000;
    sup.states(["one"]);
    expect(host.runs.length).toBe(2);
  });

  it("re-reads for a name the cache has never seen", () => {
    const host = fakeHost((argv) =>
      argv[2] === "show"
        ? { stdout: showBlock("isomux-app-one.service", "loaded", "active") }
        : undefined,
    );
    const sup = supervisor(host);
    sup.states(["one"]);
    sup.states(["one", "two"]);
    expect(host.runs.length).toBe(2);
  });

  it("drops the cache when it changes what is running", () => {
    // A stop that answered from a cache filled a moment earlier would report
    // the app as still running - the one moment the reader is guaranteed to be
    // asking BECAUSE something just changed.
    const host = fakeHost((argv) =>
      argv[2] === "show"
        ? { stdout: showBlock("isomux-app-one.service", "loaded", "active") }
        : undefined,
    );
    const sup = supervisor(host);
    sup.states(["one"]);
    sup.stop("one");
    sup.states(["one"]);
    expect(host.runs.filter((r) => r[2] === "show").length).toBe(2);
  });
});

// --- logs -------------------------------------------------------------------

describe("app-supervisor: logs", () => {
  it("asks journald for the app's unit and returns the lines", () => {
    const host = fakeHost((argv) =>
      argv[0] === "journalctl" ? { stdout: "line one\nline two\n" } : undefined,
    );
    expect(supervisor(host).logs("hello", 2)).toEqual(["line one", "line two"]);
    expect(host.runs[0]).toEqual([
      "journalctl",
      "--user",
      "-u",
      "isomux-app-hello.service",
      "-n",
      "2",
      "--no-pager",
      "--output=short-iso",
    ]);
  });

  it("clamps what a caller may ask for", () => {
    const host = fakeHost();
    const sup = supervisor(host);
    sup.logs("hello", 10 ** 9);
    sup.logs("hello", 0);
    sup.logs("hello", -5);
    const asked = host.runs.map((r) => r[r.indexOf("-n") + 1]);
    expect(asked).toEqual([String(APP_LOG_LINES_MAX), "1", "1"]);
  });

  it("surfaces a journald failure instead of reporting an empty log", () => {
    const host = fakeHost(() => ({ code: 1, stderr: "No journal files" }));
    expect(() => supervisor(host).logs("hello", 10)).toThrow(
      /logs could not be read/,
    );
  });
});
