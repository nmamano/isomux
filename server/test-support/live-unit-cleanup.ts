// The janitor for the gated live-systemd test: make sure nothing that test
// created survives on the machine, and FAIL LOUDLY if anything did.
//
// It lives here, not in the live test file, for one reason: this is
// safety-critical code that only ever runs on a box with real systemd, so it
// would otherwise be the least-tested code in the slice while carrying the
// highest consequence. Extracted like this, its sequence and its failure
// handling are driven by a fake host in the ordinary suite.
//
// THE RULE IT EXISTS TO ENFORCE: a cleanup that cannot verify itself has NOT
// succeeded. The trap is specific and was measured rather than imagined - on a
// box where the user bus is unreachable, `systemctl --user list-units` exits
// non-zero with EMPTY stdout, which is byte-identical to "nothing matched".
// A janitor that reads stdout alone therefore reports a perfectly clean machine
// at exactly the moment it has lost the ability to see anything at all. So the
// bus is PROVED reachable first, and only then is an empty listing evidence.
//
// The second measured subtlety is the mirror image: after a SUCCESSFUL test the
// unit is already gone, and stop/disable/kill/reset-failed then all exit
// non-zero with "not loaded" / "does not exist". Recording every non-zero exit
// as a cleanup failure would fail every green run. So the missing-unit shape is
// tolerated narrowly, and everything else is recorded.
//
// Test-support ONLY; no production path imports this.

import type { SupervisorHost } from "../app-supervisor.ts";

export interface CleanupPaths {
  // Full unit name, e.g. "isomux-app-test-.<hash>-probe.service".
  unit: string;
  unitFile: string;
  enableSymlink: string;
  launcher: string;
  // Glob for the listing checks - the run's own disjoint prefix, never a
  // production one.
  unitGlob: string;
}

export interface CleanupProbe {
  // Does this path exist? Used for the unit file and the launcher.
  exists(path: string): boolean;
  // Does this path exist WITHOUT following symlinks? A dangling enable symlink
  // is residue, and exists() reports it missing.
  lexists(path: string): boolean;
}

export interface CleanupOutcome {
  // Commands that failed for a reason other than "there is no such unit", and
  // anything thrown while removing files.
  errors: string[];
  // Artifacts still on the machine afterwards.
  residue: string[];
}

// systemd's several ways of saying the unit is not there.
const MISSING = /(does not exist|not loaded|no such file|not found)/i;

export function cleanupLiveTestUnit(
  host: SupervisorHost,
  paths: CleanupPaths,
  probe: CleanupProbe,
): CleanupOutcome {
  const errors: string[] = [];
  const residue: string[] = [];

  // Every step runs regardless of the ones before it: this is a janitor, and
  // the first failure is the LEAST reason to stop cleaning.
  const run = (
    args: string[],
    { tolerateMissing = false }: { tolerateMissing?: boolean } = {},
  ): { code: number; stdout: string; stderr: string } => {
    try {
      const r = host.run(["systemctl", "--user", ...args]);
      const missing = MISSING.test(`${r.stderr} ${r.stdout}`);
      if (r.code !== 0 && !(tolerateMissing && missing)) {
        errors.push(`${args.join(" ")}: exit ${r.code} ${r.stderr.trim()}`);
      }
      return r;
    } catch (err) {
      errors.push(`${args.join(" ")}: threw ${(err as Error).message}`);
      return { code: -1, stdout: "", stderr: String(err) };
    }
  };

  // 1. PROVE the bus answers before trusting anything it says later. Without
  //    this the listings at the end are worthless (see the header).
  const alive = run(["show", "--property=Version"]);
  const busReachable = alive.code === 0;

  // 2. Stop. If it refuses for any reason other than the unit being absent,
  //    escalate to a cgroup-wide SIGKILL and try again - a process that
  //    outlives the test is the whole failure mode this guards against, and
  //    removing its unit file without killing it only makes it harder to find.
  const stopped = run(["stop", paths.unit], { tolerateMissing: true });
  if (
    stopped.code !== 0 &&
    !MISSING.test(`${stopped.stderr} ${stopped.stdout}`)
  ) {
    run(["kill", "--kill-whom=all", "--signal=KILL", paths.unit], {
      tolerateMissing: true,
    });
    run(["stop", paths.unit], { tolerateMissing: true });
  }

  run(["disable", paths.unit], { tolerateMissing: true });

  // 3. Each removal in its own try, so one failure cannot skip the rest.
  for (const [what, path] of [
    ["unit file", paths.unitFile],
    ["enable symlink", paths.enableSymlink],
    ["launcher", paths.launcher],
  ] as const) {
    try {
      host.removeFile(path);
    } catch (err) {
      errors.push(`removing ${what} ${path}: ${(err as Error).message}`);
    }
  }

  run(["daemon-reload"]);
  run(["reset-failed", paths.unit], { tolerateMissing: true });

  // 4. What survived. The file checks stand on their own; the listings are
  //    only meaningful if the bus answered.
  if (probe.exists(paths.unitFile)) residue.push(`unit file ${paths.unitFile}`);
  if (probe.lexists(paths.enableSymlink)) {
    residue.push(`enable symlink ${paths.enableSymlink}`);
  }
  if (probe.exists(paths.launcher)) residue.push(`launcher ${paths.launcher}`);

  if (!busReachable) {
    errors.push(
      "the user bus could not be reached, so an empty unit listing proves nothing " +
        "about what is still running on this machine",
    );
  } else {
    for (const listing of ["list-units", "list-unit-files"]) {
      const args =
        listing === "list-units"
          ? [listing, "--all", "--no-legend", paths.unitGlob]
          : [listing, "--no-legend", paths.unitGlob];
      let r;
      try {
        r = host.run(["systemctl", "--user", ...args]);
      } catch (err) {
        errors.push(`${listing}: threw ${(err as Error).message}`);
        continue;
      }
      // The bus probe above is NOT enough on its own: it proves the bus
      // answered a moment ago, and the bus can die in the window between that
      // answer and this one. Then systemctl exits non-zero with empty stdout
      // and, without the check below, the janitor would report a spotless
      // machine for the third time in this module's history - same blindness,
      // moved into a TOCTOU gap.
      //
      // So each listing's non-zero exits are judged on their own, and only ONE
      // measured shape is benign:
      //   list-units      <no match> -> exit 0        (any non-zero is a fault)
      //   list-unit-files <no match> -> exit 1, stdout AND stderr both empty
      // An unreachable bus also exits 1 with empty stdout, but it says so on
      // stderr, which is what separates the two.
      const benign =
        listing === "list-unit-files" &&
        r.code === 1 &&
        r.stdout.trim() === "" &&
        r.stderr.trim() === "";
      if (r.code !== 0 && !benign) {
        errors.push(
          `${listing}: exit ${r.code} ${r.stderr.trim()} - could not verify what is still on this machine`,
        );
        continue;
      }
      if (r.stdout.trim()) residue.push(`${listing}: ${r.stdout.trim()}`);
    }
  }

  return { errors, residue };
}

// Render an outcome as the error a test should throw, or null when the machine
// really is clean.
export function cleanupFailure(outcome: CleanupOutcome): Error | null {
  if (outcome.errors.length === 0 && outcome.residue.length === 0) return null;
  const parts: string[] = [];
  if (outcome.residue.length > 0) {
    parts.push(
      `residue left on this machine:\n  ${outcome.residue.join("\n  ")}`,
    );
  }
  if (outcome.errors.length > 0) {
    parts.push(`cleanup commands failed:\n  ${outcome.errors.join("\n  ")}`);
  }
  return new Error(`live systemd test cleanup: ${parts.join("\n")}`);
}
