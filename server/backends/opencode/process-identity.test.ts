import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linuxProcessIdentityMatches,
  parsePsParentTable,
  processDescendants,
  parseLinuxProcessHop,
  parseLinuxProcessState,
  parseLinuxProcessStartTicks,
  readLinuxProcessStartTicks,
} from "./process-identity.ts";

describe("Linux process identity", () => {
  it("parses start ticks after a comm containing spaces and close-parens", () => {
    const fields = [
      "S",
      "4321",
      ...Array.from({ length: 17 }, (_, i) => String(i + 2)),
      "424242",
      "23",
    ];
    expect(
      parseLinuxProcessStartTicks(`99 (a) b (c) ${fields.join(" ")}`),
    ).toBe("424242");
    expect(parseLinuxProcessState(`99 (a) b (c) ${fields.join(" ")}`)).toBe(
      "S",
    );
    // The authority broker walks ancestry with this parser.
    expect(
      parseLinuxProcessHop(99, `99 (a) b (c) ${fields.join(" ")}`),
    ).toEqual({ pid: 99, parentPid: 4321, startTicks: "424242" });
  });

  it("matches both pid and kernel start ticks", () => {
    const ticks = readLinuxProcessStartTicks(process.pid);
    expect(ticks).not.toBeNull();
    expect(linuxProcessIdentityMatches(process.pid, ticks!)).toBe(true);
    expect(linuxProcessIdentityMatches(process.pid, `${ticks}0`)).toBe(false);
    expect(linuxProcessIdentityMatches(process.pid, undefined)).toBe(false);
  });
});

// M3 (task 75904a56): 2.1.4 starts each shell tool as the leader of its own
// process group (core/src/shell.ts:315), so a stop finds them by parent.
describe("process descendants", () => {
  it.skipIf(process.platform !== "linux")(
    "finds every descendant by parent, across process groups, with its start ticks",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "isomux-descendants-"));
      const pids: number[] = [];
      try {
        const marker = join(dir, "pids");
        // root -> a detached child (its own group) -> a grandchild.
        const grandchild = `setInterval(() => {}, 1000)`;
        const child = `const { spawn } = require("node:child_process"); const { appendFileSync } = require("node:fs"); const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); appendFileSync(${JSON.stringify(marker)}, process.pid + " " + g.pid + "\\n"); setInterval(() => {}, 1000);`;
        const root = spawn(
          process.execPath,
          [
            "-e",
            `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore", detached: true }); setInterval(() => {}, 1000);`,
          ],
          { stdio: "ignore" },
        );
        // Not under the root: never a descendant.
        const stranger = spawn(process.execPath, ["-e", grandchild], {
          stdio: "ignore",
        });
        pids.push(root.pid!, stranger.pid!);
        let line = "";
        for (let i = 0; i < 200 && !line; i++) {
          line = (await readFile(marker, "utf8").catch(() => "")).trim();
          if (!line) await Bun.sleep(25);
        }
        const [childPid, grandchildPid] = line.split(" ").map(Number);
        pids.push(childPid, grandchildPid);
        const found = processDescendants(root.pid!);
        expect(found.map((hop) => hop.pid).sort()).toEqual(
          [childPid, grandchildPid].sort(),
        );
        for (const hop of found)
          expect(hop.startTicks, String(hop.pid)).toBe(
            readLinuxProcessStartTicks(hop.pid)!,
          );
        expect(found.find((hop) => hop.pid === grandchildPid)?.parentPid).toBe(
          childPid,
        );
        expect(processDescendants(stranger.pid!)).toEqual([]);
      } finally {
        for (const pid of pids)
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        await rm(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  // macOS has no /proc: ps gives the parent of every process.
  it("reads the parent table that ps -A -o pid=,ppid= prints", () => {
    expect(
      parsePsParentTable("    1     0\n  412     1\n\n 9000   412\nbad line\n"),
    ).toEqual([
      { pid: 1, parentPid: 0 },
      { pid: 412, parentPid: 1 },
      { pid: 9000, parentPid: 412 },
    ]);
  });
});
