// The PID-namespace probe and status (server/process-isolation.ts). The probe
// runs through a host `run`; here that is the local host, with bwrap swapped
// for a script where a case needs bwrap to fail, to be missing or to skip the
// namespace. Cases that need a working bwrap skip where this host cannot make
// a PID namespace: they check that independently, never through the probe.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { localAgentHost, type RunOptions } from "./agent-host.ts";
import {
  APPARMOR_CANARY,
  isolatedArgv,
  probeProcessIsolation,
  processIsolationStatus,
  type ProcessIsolationProbe,
} from "./process-isolation.ts";
import {
  bwrapMakesPidNamespace,
  killMarked,
  pidsWith,
  waitFor,
} from "./test-support/process-markers.ts";

const pidNamespaces = bwrapMakesPidNamespace();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "process-isolation-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// The local host's run, with every run of bwrap sent to `bwrap` instead (a
// script, or a path that does not exist). Records the argv of each run.
function hostWithBwrap(bwrap: string) {
  const runs: string[][] = [];
  return {
    runs,
    deps: {
      platform: "linux" as NodeJS.Platform,
      env: process.env,
      run(argv: string[], options?: RunOptions) {
        runs.push(argv);
        const swapped =
          basename(argv[0]) === "bwrap" ? [bwrap, ...argv.slice(1)] : argv;
        return localAgentHost.run(swapped, options);
      },
    },
  };
}

describe("process isolation probe", () => {
  it("is not available off Linux, and runs nothing there", async () => {
    const { runs, deps } = hostWithBwrap("/bin/false");
    const probe = await probeProcessIsolation({ ...deps, platform: "darwin" });
    expect(probe).toMatchObject({ available: false, reason: "needs_linux" });
    expect(runs).toEqual([]);
  });

  it("reports no bwrap when bwrap cannot start", async () => {
    const { runs, deps } = hostWithBwrap(join(dir, "no-such-bwrap"));
    const probe = await probeProcessIsolation(deps);
    expect(probe).toMatchObject({ available: false, reason: "no_bwrap" });
    // The enabling condition: the probe did try bwrap.
    expect(runs.some((argv) => basename(argv[0]) === "bwrap")).toBe(true);
  });

  it("reports a denial with bwrap's own message as the detail", async () => {
    const denial =
      "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.";
    const { deps } = hostWithBwrap(
      script("bwrap", `echo "${denial}" >&2\nexit 1`),
    );
    const probe = await probeProcessIsolation(deps);
    expect(probe).toMatchObject({ available: false, reason: "denied" });
    expect((probe as { detail: string }).detail).toContain(denial);
  });

  it("does not take a bwrap that exits 0 and shows nothing as available", async () => {
    const { deps } = hostWithBwrap(script("bwrap", "exit 0"));
    expect((await probeProcessIsolation(deps)).available).toBe(false);
  });

  // The same real bwrap with its PID namespace taken out: the command runs and
  // sees every process on the host. Only a probe that reads what the command
  // sees can tell this from a working namespace.
  it.skipIf(!pidNamespaces)(
    "does not take a bwrap that runs the command without a PID namespace as available",
    async () => {
      const real = Bun.which("bwrap")!;
      const noNamespace = script(
        "bwrap",
        `args=(); skip=0
for a in "$@"; do
  if [ $skip = 1 ]; then skip=0; continue; fi
  case "$a" in --unshare-pid) ;; --proc) skip=1 ;; *) args+=("$a") ;; esac
done
exec ${real} "\${args[@]}"`,
      );
      // The reason, not only "not available": on a host with AppArmor the
      // label step would turn this off too.
      const { deps } = hostWithBwrap(noNamespace);
      expect(await probeProcessIsolation(deps)).toMatchObject({
        available: false,
        reason: "denied",
      });
      // The control: the real bwrap through the same swap passes the PID step.
      // On a host with AppArmor, the label step after it says apparmor.
      const { deps: realDeps } = hostWithBwrap(real);
      const control = await probeProcessIsolation(realDeps);
      expect(control.available || control.reason === "apparmor").toBe(true);
    },
  );
});

// AppArmor (task ffb7007c): on Ubuntu, bwrap's children run under a profile
// that stacks onto any program with its own profile, and in that stack Chrome
// and other browsers cannot open a network socket. The probe leaves isolation
// off when the command inside the namespace has a confining label that it
// does not have outside.
describe("process isolation probe and AppArmor", () => {
  const LABEL_PATH = "/proc/self/attr/apparmor/current";

  // The probe as it runs, with the label it reads from LABEL_PATH taken from
  // a file: `inside` for the run in the namespace, `outside` for every other
  // run (null: no such file, as on a host without AppArmor). bwrap is a script
  // that runs the probe's command without a namespace and rewrites only its
  // pid and systemctl lines, so the rest of the probe's own output is real.
  // The canary (deploy/bwrap-apparmor.sh) is a script that prints `canary`
  // and leaves a mark when it runs (null: not installed).
  function hostWithLabels(
    inside: string | null,
    outside: string | null,
    canary: string | null = null,
  ) {
    const file = (name: string, label: string | null) => {
      const path = join(dir, name);
      if (label !== null) writeFileSync(path, label);
      return path;
    };
    const insidePath = file("inside-label", inside);
    const outsidePath = file("outside-label", outside);
    const canaryMark = join(dir, "canary-ran");
    const canaryPath =
      canary === null
        ? join(dir, "no-canary")
        : script(
            "canary",
            `touch ${canaryMark}\ncat ${file("canary-label", canary)}`,
          );
    const bwrap = script(
      "bwrap",
      `while [ "$1" != "--" ]; do shift; done; shift
"$@" | sed -E 's/^self=[0-9]+$/self=2/; s/^pids=[0-9]+$/pids=3/; s/^systemctl=[0-9]+$/systemctl=0/'
exit \${PIPESTATUS[0]}`,
    );
    const runs: string[][] = [];
    return {
      canaryRan: () => existsSync(canaryMark),
      wrappedRuns: () => runs.filter((argv) => basename(argv[0]) === "bwrap"),
      // The runs other than the one in the namespace that read the label.
      outsideReads: () =>
        runs.filter(
          (argv) =>
            basename(argv[0]) !== "bwrap" &&
            argv.some((arg) => arg.includes(LABEL_PATH)),
        ),
      insideReads: () =>
        runs.filter(
          (argv) =>
            basename(argv[0]) === "bwrap" &&
            argv.some((arg) => arg.includes(LABEL_PATH)),
        ),
      deps: {
        platform: "linux" as NodeJS.Platform,
        env: process.env,
        run(argv: string[], options?: RunOptions) {
          runs.push(argv);
          const wrapped = basename(argv[0]) === "bwrap";
          const label = wrapped ? insidePath : outsidePath;
          const swapped = argv.map((arg) =>
            arg
              .replaceAll(LABEL_PATH, label)
              .replaceAll(APPARMOR_CANARY, canaryPath),
          );
          if (wrapped) swapped[0] = bwrap;
          return localAgentHost.run(swapped, options);
        },
      },
    };
  }

  // The kernel ends the label with a newline.
  const UNPRIV = "bwrap//&unpriv_bwrap (enforce)\n";

  it.each([
    ["enforce", UNPRIV],
    ["complain", "bwrap//&unpriv_bwrap (complain)\n"],
    ["mixed", "bwrap//&chrome//&unpriv_bwrap (mixed)\n"],
  ])(
    "is not available when the namespace adds a confining label (%s)",
    async (_mode, inside) => {
      const host = hostWithLabels(inside, "unconfined\n");
      const probe = await probeProcessIsolation(host.deps);
      // The enabling condition: both reads went to the files above.
      expect(host.insideReads().length).toBe(1);
      expect(host.outsideReads().length).toBe(1);
      expect(probe).toMatchObject({ available: false, reason: "apparmor" });
      expect((probe as { detail: string }).detail).toContain(inside.trim());
    },
  );

  // A failed read must not turn isolation on.
  it("is not available when the label outside cannot be read", async () => {
    const host = hostWithLabels(UNPRIV, null);
    const probe = await probeProcessIsolation(host.deps);
    expect(host.outsideReads().length).toBe(1);
    expect(probe).toMatchObject({ available: false, reason: "apparmor" });
  });

  // deploy/bwrap-apparmor.sh's rule is live: the canary, a program with its
  // own profile, keeps the namespace's label instead of stacking its profile.
  it("is available when the canary in the namespace keeps the namespace's label", async () => {
    const host = hostWithLabels(UNPRIV, "unconfined\n", UNPRIV);
    expect(await probeProcessIsolation(host.deps)).toEqual({
      available: true,
    });
    expect(host.canaryRan()).toBe(true);
  });

  // The rule is not live, or the canary is not there.
  it.each([
    [
      "stacks its own profile",
      "bwrap//&isomux-apparmor-canary//&unpriv_bwrap (mixed)\n",
    ],
    ["prints nothing", ""],
    ["has the label outside the namespace", "unconfined\n"],
    ["is not installed", null],
  ])("is not available when the canary %s", async (_case, canary) => {
    const host = hostWithLabels(UNPRIV, "unconfined\n", canary);
    const probe = await probeProcessIsolation(host.deps);
    // The enabling condition: the canary ran wherever it exists.
    expect(host.canaryRan()).toBe(canary !== null);
    expect(probe).toMatchObject({ available: false, reason: "apparmor" });
  });

  // The detail tells an owner whether the step never ran or its rule is not
  // live.
  it("names a missing canary differently from one that stacks its own profile", async () => {
    const detail = async (canary: string | null) =>
      (
        (await probeProcessIsolation(
          hostWithLabels(UNPRIV, "unconfined\n", canary).deps,
        )) as { detail: string }
      ).detail;
    const missing = await detail(null);
    const stacked = await detail(
      "bwrap//&isomux-apparmor-canary//&unpriv_bwrap (mixed)\n",
    );
    expect(missing).not.toBe(stacked);
  });

  // bwrap's first exec takes the bwrap profile's own transition, so a canary
  // run as bwrap's command always keeps the pair label: it must run from the
  // probe's shell.
  it("runs the canary from the shell in the namespace, never as bwrap's command", async () => {
    const host = hostWithLabels(UNPRIV, "unconfined\n", UNPRIV);
    await probeProcessIsolation(host.deps);
    const wrapped = host.wrappedRuns();
    expect(wrapped.length).toBeGreaterThan(0);
    for (const argv of wrapped) {
      const command = argv.slice(argv.indexOf("--") + 1);
      expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
      expect(command.filter((arg) => arg === APPARMOR_CANARY)).toEqual([]);
    }
    expect(wrapped.some((argv) => argv.at(-1)!.includes(APPARMOR_CANARY))).toBe(
      true,
    );
  });

  // A server that runs confined itself: bwrap adds nothing.
  it("is available when the label is the same inside and outside", async () => {
    const label = "snap.isomux.server (enforce)\n";
    const host = hostWithLabels(label, label);
    expect(await probeProcessIsolation(host.deps)).toEqual({
      available: true,
    });
    expect(host.outsideReads().length).toBe(1);
  });

  // No AppArmor, or no confinement inside: nothing to compare, so the probe
  // starts no second run.
  it.each([
    ["no label file", null],
    ["an empty label", ""],
    ["unconfined", "unconfined\n"],
    ["a profile in unconfined mode", "bwrap (unconfined)\n"],
  ])(
    "is available with %s inside, without a read outside",
    async (_case, inside) => {
      const host = hostWithLabels(inside, UNPRIV);
      expect(await probeProcessIsolation(host.deps)).toEqual({
        available: true,
      });
      expect(host.insideReads().length).toBe(1);
      expect(host.outsideReads()).toEqual([]);
    },
  );
});

describe("process isolation status", () => {
  const available: ProcessIsolationProbe = { available: true };
  const denied: ProcessIsolationProbe = {
    available: false,
    reason: "denied",
    detail: "bwrap: ...",
  };

  it("is on only when the probe passed and the owner's switch is on", () => {
    expect(processIsolationStatus(available, true)).toEqual({ state: "on" });
    expect(processIsolationStatus(available, false)).toEqual({
      state: "off",
      reason: "turned_off",
    });
  });

  // Turning the switch on would not help, so the status says why.
  it("names the probe's reason when this host cannot run it, switch on or off", () => {
    expect(processIsolationStatus(denied, true)).toEqual({
      state: "off",
      reason: "denied",
    });
    expect(processIsolationStatus(denied, false)).toEqual({
      state: "off",
      reason: "denied",
    });
  });
});

// The OpenCode server outlives the helper that starts it, so its wrap has no
// --die-with-parent; an agent session's wrap has it.
describe.skipIf(!pidNamespaces)("isolated argv and the parent's death", () => {
  async function innerSurvivesOuterKill(
    dieWithParent: boolean,
  ): Promise<boolean> {
    const marker = `iso-dwp-${process.pid}-${Date.now()}-${dieWithParent}`;
    // The marker is in the script, not in argv: the outer bwrap and the
    // namespace init carry argv in their command lines too.
    const sleeper = script(
      `sleeper-${dieWithParent}`,
      `exec -a ${marker} sleep 300`,
    );
    const argv = isolatedArgv([sleeper], { dieWithParent });
    const outer = spawn(argv[0], argv.slice(1), {
      stdio: "ignore",
      detached: true,
    });
    try {
      expect(await waitFor(() => pidsWith(marker).length === 1)).toBe(true);
      process.kill(outer.pid!, "SIGKILL");
      await Bun.sleep(300);
      return pidsWith(marker).length > 0;
    } finally {
      killMarked(marker);
    }
  }

  it("ends the inner tree with the outer bwrap only for a session", async () => {
    expect(await innerSurvivesOuterKill(true)).toBe(false);
    expect(await innerSurvivesOuterKill(false)).toBe(true);
  });
});
