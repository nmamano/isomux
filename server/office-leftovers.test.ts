// endLeftovers (task cdd7883d, slice 4): the lockdown route's stop ends the
// processes the office started on every install, not only under an Isomux
// unit. Real child processes, real /proc reads and real signals.
//
// Safety: the process list is cut down to this test's own children and the
// kill refuses any other pid, so a wrong rule (one that skips the
// ISOMUX_OFFICE_PID check, say) can only reach those children, never the
// processes of the member running the test (Isomux Reviewer 1, 2026-11-06).

import { afterEach, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
  endLeftovers,
  LEFTOVER_KILL_GRACE_MS,
  readProcesses,
} from "./office-leftovers.ts";
import { OFFICE_PID_ENV } from "./stop-reap.ts";

const children: Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await child.exited;
  }
});

function start(argv: string[], officePid: string | null): Subprocess {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  if (officePid !== null) env[OFFICE_PID_ENV] = officePid;
  const child = Bun.spawn(argv, { env, stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}

// Whether `pid` is one of this test's children or below one.
function descendsFromOurs(pid: number): boolean {
  const ours = new Set(children.map((c) => c.pid));
  const parents = new Map(readProcesses().map((p) => [p.pid, p.ppid]));
  for (let at = pid, steps = 0; at > 1 && steps < 64; steps++) {
    if (ours.has(at)) return true;
    at = parents.get(at) ?? 0;
  }
  return false;
}

// Whether the child ended within `ms`.
async function endedWithin(child: Subprocess, ms: number): Promise<boolean> {
  return await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(ms).then(() => false),
  ]);
}

test.skipIf(process.platform !== "linux")(
  "ends every process that carries this office's pid, SIGKILLs one that ignores SIGTERM after the grace, and leaves another office's and an unmarked process alone",
  async () => {
    const officePid = String(process.pid);
    const plain = start(["sleep", "30"], officePid);
    // A shell that ignores SIGTERM, as `trap '' TERM` passes on (stop-reap.ts).
    const stubborn = start(
      ["bash", "-c", "trap '' TERM; while :; do sleep 0.05; done"],
      officePid,
    );
    const otherOffice = start(["sleep", "30"], String(process.pid + 1));
    const unmarked = start(["sleep", "30"], null);
    const ours = new Set(children.map((c) => c.pid));
    // The condition the test needs: /proc shows each child with its marker.
    const deadline = performance.now() + 2_000;
    let seen = readProcesses().filter((p) => ours.has(p.pid));
    while (
      seen.filter((p) => p.env[OFFICE_PID_ENV] === officePid).length < 2 &&
      performance.now() < deadline
    ) {
      await Bun.sleep(20);
      seen = readProcesses().filter((p) => ours.has(p.pid));
    }
    expect(
      seen
        .filter((p) => p.env[OFFICE_PID_ENV] === officePid)
        .map((p) => p.pid)
        .sort(),
    ).toEqual([plain.pid, stubborn.pid].sort());

    const foreign: number[] = [];
    const listed = new Set<number>();
    const sleeps: number[] = [];
    const ended = await endLeftovers({
      officePid: process.pid,
      uids: [process.getuid!()],
      selfPid: process.pid,
      // The stubborn shell's loop starts sleeps that carry the marker too.
      // A pid is killable only once this list named it: a short-lived sleep
      // may be gone by its kill, and /proc can no longer place it.
      processes: () => {
        const list = readProcesses().filter((p) => descendsFromOurs(p.pid));
        for (const p of list) listed.add(p.pid);
        return list;
      },
      kill: (pid, signal) => {
        if (!listed.has(pid)) {
          foreign.push(pid);
          return;
        }
        process.kill(pid, signal);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        // Long enough for a process that takes SIGTERM to go.
        await Bun.sleep(200);
      },
    });

    expect(foreign).toEqual([]);
    expect(ended).toContain(plain.pid);
    expect(ended).toContain(stubborn.pid);
    expect(ended).not.toContain(otherOffice.pid);
    expect(ended).not.toContain(unmarked.pid);
    expect(sleeps).toEqual([LEFTOVER_KILL_GRACE_MS]);
    expect(await endedWithin(plain, 1_000)).toBe(true);
    expect(await endedWithin(stubborn, 1_000)).toBe(true);
    expect({ plain: plain.signalCode, stubborn: stubborn.signalCode }).toEqual({
      plain: "SIGTERM",
      stubborn: "SIGKILL",
    });
    expect(await endedWithin(otherOffice, 100)).toBe(false);
    expect(await endedWithin(unmarked, 100)).toBe(false);
  },
);

test("a process that is gone before its kill is skipped, and the rest are still ended", async () => {
  const kills: string[] = [];
  const ended = await endLeftovers({
    officePid: 100,
    uids: [1000],
    selfPid: 1,
    processes: () => [
      { pid: 201, ppid: 100, uid: 1000, env: { [OFFICE_PID_ENV]: "100" } },
      { pid: 202, ppid: 100, uid: 1000, env: { [OFFICE_PID_ENV]: "100" } },
    ],
    kill: (pid, signal) => {
      kills.push(`${pid} ${signal}`);
      if (pid === 201)
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    },
    sleep: async () => {},
  });
  expect(ended).toContain(202);
  expect(kills).toContain("202 SIGTERM");
  expect(kills).toContain("202 SIGKILL");
});
