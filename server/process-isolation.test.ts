// The PID-namespace probe and status (server/process-isolation.ts). The probe
// runs through a host `run`; here that is the local host, with bwrap swapped
// for a script where a case needs bwrap to fail, to be missing or to skip the
// namespace. Cases that need a working bwrap skip where this host cannot make
// a PID namespace: they check that independently, never through the probe.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { localAgentHost, type RunOptions } from "./agent-host.ts";
import {
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
      const { deps } = hostWithBwrap(noNamespace);
      expect((await probeProcessIsolation(deps)).available).toBe(false);
      // The control: the real bwrap through the same swap is available.
      const { deps: realDeps } = hostWithBwrap(real);
      expect(await probeProcessIsolation(realDeps)).toEqual({
        available: true,
      });
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
