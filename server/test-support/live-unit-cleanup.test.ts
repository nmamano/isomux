// The live test's janitor, driven against a fake host so it is covered by the
// ordinary suite rather than only by the gated run it belongs to.
//
// That inversion is the point: the janitor only ever executes on a box with
// real systemd, so without this it would be the least-tested code in the slice
// while carrying the highest consequence - a silent failure here means the
// suite goes green with a real service still running on someone's machine.
//
// Zero LLM, zero subprocesses.

import { describe, it, expect } from "bun:test";
import {
  cleanupFailure,
  cleanupLiveTestUnit,
  type CleanupPaths,
  type CleanupProbe,
} from "./live-unit-cleanup.ts";
import type { RunResult, SupervisorHost } from "../app-supervisor.ts";

const PATHS: CleanupPaths = {
  unit: "isomux-app-test-.abc-probe.service",
  unitFile: "/units/isomux-app-test-.abc-probe.service",
  enableSymlink:
    "/units/default.target.wants/isomux-app-test-.abc-probe.service",
  launcher: "/launchers/probe.sh",
  unitGlob: "isomux-app-test-.abc-*",
};

// Nothing exists: the state after a cleanup that worked.
const CLEAN_PROBE: CleanupProbe = { exists: () => false, lexists: () => false };

interface FakeHost extends SupervisorHost {
  runs: string[][];
  removed: string[];
}

function fakeHost(
  over: (argv: string[]) => Partial<RunResult> | undefined = () => undefined,
  removeThrowsOn: string[] = [],
): FakeHost {
  const runs: string[][] = [];
  const removed: string[] = [];
  return {
    unitDir: "/units",
    launcherDir: "/launchers",
    runs,
    removed,
    writeFile: () => {},
    readFile: () => null,
    removeFile: (path) => {
      if (removeThrowsOn.includes(path)) {
        throw new Error(`EACCES removing ${path}`);
      }
      removed.push(path);
    },
    run: (argv) => {
      runs.push(argv);
      return { code: 0, stdout: "", stderr: "", ...over(argv) };
    },
  };
}

const verbs = (host: FakeHost): string[] => host.runs.map((a) => a[2]);

// What every command answers once the unit is already gone - measured on
// systemd 255, and the ordinary state after a test that cleaned up after
// itself: stop exits 5, disable/kill/reset-failed exit 1, all saying so.
const missingUnit = (argv: string[]): Partial<RunResult> | undefined =>
  ["stop", "disable", "kill", "reset-failed"].includes(argv[2])
    ? { code: argv[2] === "stop" ? 5 : 1, stderr: "Unit ... not loaded." }
    : undefined;

describe("live-test janitor: the clean case", () => {
  it("reports success when the unit was already gone", () => {
    // The commonest run by far, and the one a literal "record every non-zero
    // exit" rule would fail every single time.
    const host = fakeHost(missingUnit);
    const outcome = cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE);
    expect(outcome).toEqual({ errors: [], residue: [] });
    expect(cleanupFailure(outcome)).toBeNull();
  });

  it("proves the bus answers before believing an empty listing", () => {
    const host = fakeHost(missingUnit);
    cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE);
    // The liveness probe comes FIRST, before anything is judged by its silence.
    expect(host.runs[0]).toEqual([
      "systemctl",
      "--user",
      "show",
      "--property=Version",
    ]);
  });
});

describe("live-test janitor: a unit that will not stop", () => {
  it("escalates to a cgroup-wide SIGKILL and retries the stop", () => {
    // Removing a running app's unit file without killing it leaves a process
    // nothing can find. The kill is what makes "leaves no residue" true rather
    // than merely reported.
    const host = fakeHost((argv) =>
      argv[2] === "stop"
        ? { code: 1, stderr: "Job for ... timed out" }
        : undefined,
    );
    const outcome = cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE);
    expect(verbs(host)).toEqual([
      "show",
      "stop",
      "kill",
      "stop",
      "disable",
      "daemon-reload",
      "reset-failed",
      "list-units",
      "list-unit-files",
    ]);
    expect(host.runs[2]).toContain("--kill-whom=all");
    expect(host.runs[2]).toContain("--signal=KILL");
    // Still reported: the machine may be clean now, but a stop that needed a
    // SIGKILL is not a silent success.
    expect(outcome.errors.join(" ")).toContain("stop");
  });

  it("does NOT escalate when the unit is merely absent", () => {
    const host = fakeHost(missingUnit);
    expect(verbs(fakeHostAfter(host))).not.toContain("kill");
  });
});

// Helper so the assertion above reads as one line.
function fakeHostAfter(host: FakeHost): FakeHost {
  cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE);
  return host;
}

describe("live-test janitor: could-not-ask is never proof", () => {
  it("FAILS when the bus is unreachable, even though every listing looks empty", () => {
    // The measured trap: with the user bus down, `list-units` exits non-zero
    // with EMPTY stdout - byte-identical to "nothing matched". A janitor
    // reading stdout alone declares the machine spotless at the exact moment it
    // has gone blind.
    const host = fakeHost(() => ({
      code: 1,
      stdout: "",
      stderr: "Failed to connect to bus",
    }));
    const outcome = cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE);
    expect(outcome.residue).toEqual([]);
    expect(cleanupFailure(outcome)).not.toBeNull();
    expect(outcome.errors.join(" ")).toContain("could not be reached");
    // And it does not pretend the listings meant anything.
    expect(verbs(host)).not.toContain("list-units");
  });

  it("reports what a reachable bus actually found", () => {
    const host = fakeHost((argv) =>
      argv[2] === "list-units"
        ? { stdout: "isomux-app-test-.abc-probe.service loaded active running" }
        : undefined,
    );
    const outcome = cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE);
    expect(outcome.residue.join(" ")).toContain("active running");
    expect(cleanupFailure(outcome)).not.toBeNull();
  });

  it("FAILS when the bus dies AFTER the probe, before list-units", () => {
    // The TOCTOU version: the probe answered, so the janitor believes it can
    // see - and then the bus goes away before the listing. Non-zero with empty
    // stdout would otherwise read as "nothing left".
    const host = fakeHost((argv) =>
      argv[2] === "list-units"
        ? { code: 1, stdout: "", stderr: "Failed to connect to bus" }
        : missingUnit(argv),
    );
    const outcome = cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE);
    expect(outcome.residue).toEqual([]);
    expect(cleanupFailure(outcome)).not.toBeNull();
    expect(outcome.errors.join(" ")).toContain("could not verify");
  });

  it("FAILS when list-unit-files fails for a reason that is not no-match", () => {
    // Same window, the other listing. Distinguished from the benign no-match
    // shape by stderr: an unreachable bus says so, a pattern matching nothing
    // is silent.
    const host = fakeHost((argv) =>
      argv[2] === "list-unit-files"
        ? { code: 1, stdout: "", stderr: "Failed to connect to bus" }
        : missingUnit(argv),
    );
    expect(
      cleanupFailure(cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE)),
    ).not.toBeNull();
  });

  it("treats an empty list-unit-files as clean despite its non-zero exit", () => {
    // Measured: list-unit-files exits 1 when its pattern matches NOTHING, which
    // is the clean case. Recording that as a failure would fail every green run
    // - the bus probe is what separates it from a real fault.
    const host = fakeHost((argv) =>
      argv[2] === "list-unit-files"
        ? { code: 1, stdout: "" }
        : missingUnit(argv),
    );
    expect(
      cleanupFailure(cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE)),
    ).toBeNull();
  });
});

describe("live-test janitor: everything runs, everything is reported", () => {
  it("keeps cleaning after a removal throws, and still reports it", () => {
    const host = fakeHost(missingUnit, [PATHS.unitFile]);
    const outcome = cleanupLiveTestUnit(host, PATHS, CLEAN_PROBE);
    // The failing removal did not skip the two after it.
    expect(host.removed).toEqual([PATHS.enableSymlink, PATHS.launcher]);
    // Nor the commands after them.
    expect(verbs(host)).toContain("daemon-reload");
    expect(verbs(host)).toContain("list-units");
    expect(outcome.errors.join(" ")).toContain("EACCES");
    expect(cleanupFailure(outcome)).not.toBeNull();
  });

  it("counts a surviving file as residue, dangling symlink included", () => {
    const host = fakeHost(missingUnit);
    const outcome = cleanupLiveTestUnit(host, PATHS, {
      exists: (p) => p === PATHS.launcher,
      // exists() follows the link and would report a dangling one missing.
      lexists: (p) => p === PATHS.enableSymlink,
    });
    expect(outcome.residue.join(" ")).toContain("enable symlink");
    expect(outcome.residue.join(" ")).toContain("launcher");
  });

  it("names both the residue and the failed commands in what it throws", () => {
    const host = fakeHost((argv) =>
      argv[2] === "daemon-reload"
        ? { code: 1, stderr: "refused" }
        : missingUnit(argv),
    );
    const outcome = cleanupLiveTestUnit(host, PATHS, {
      exists: (p) => p === PATHS.unitFile,
      lexists: () => false,
    });
    const err = cleanupFailure(outcome);
    expect(err?.message).toContain("unit file");
    expect(err?.message).toContain("daemon-reload");
  });
});
