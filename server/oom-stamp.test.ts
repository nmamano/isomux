// server/oom-stamp.ts - the sweep that marks the office's own processes as the
// first to be killed, exercised against a fake /proc.
//
// Real pids are useless here: the interesting cases are a refused write, a pid
// recycled mid-stamp, and a write the kernel accepts and then ignores, none of
// which is reproducible on demand against a live /proc. The module reads and
// writes through a `procRoot` seam for exactly that reason - the same seam
// deploy/oom-protect.sh has as PROC_ROOT, and the same lesson behind it: a value
// nobody read back was wrong for a week (task c5b4e89e).
//
// The behaviour that has to stay pinned is not "it writes a number". It is that
// it never LOWERS one, that it will not report a success it could not verify,
// and that it stays quiet once the box has converged - this runs every ten
// seconds forever, so a line per sweep would be a log flood.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AGENT_OOM_SCORE_ADJ,
  createAgentOomStamper,
  descendantsOf,
  stampProcess,
} from "./oom-stamp.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oom-stamp-test-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake /proc entry: a parent, a start time, and a score. */
function fakeProc(
  procRoot: string,
  pid: number,
  opts: {
    ppid?: number;
    starttime?: number;
    score?: string;
    comm?: string;
    readOnlyScore?: boolean;
  } = {},
): { ppid: number; starttime: string } {
  const d = join(procRoot, String(pid));
  mkdirSync(d, { recursive: true });
  // Laid out as the kernel does: field 1 the pid, field 2 the name in
  // parentheses, field 3 the state, then filler up to the start time at field
  // 22. Names carrying spaces and parentheses are what break naive splitting,
  // so that is what the default is.
  const comm = opts.comm ?? "we ird (name";
  const filler = Array(17).fill("0").join(" ");
  writeFileSync(
    join(d, "stat"),
    `${pid} (${comm}) S ${opts.ppid ?? 1} ${filler} ${opts.starttime ?? 12345} 0 0\n`,
  );
  const score = join(d, "oom_score_adj");
  writeFileSync(score, `${opts.score ?? "100"}\n`);
  if (opts.readOnlyScore) chmodSync(score, 0o444);
  return { ppid: opts.ppid ?? 1, starttime: String(opts.starttime ?? 12345) };
}

function adjOf(procRoot: string, pid: number): string {
  return readFileSync(
    join(procRoot, String(pid), "oom_score_adj"),
    "utf8",
  ).trim();
}

describe("descendantsOf", () => {
  it("finds children and grandchildren, and never the office itself", () => {
    fakeProc(dir, 500, { ppid: 1 }); // the office
    fakeProc(dir, 501, { ppid: 500, comm: "claude" });
    fakeProc(dir, 502, { ppid: 501, comm: "bun" });
    fakeProc(dir, 600, { ppid: 1, comm: "tailscaled" });
    const tree = descendantsOf(dir, 500);
    expect([...tree.keys()].sort()).toEqual([501, 502]);
  });

  it("visits a parent before its own children", () => {
    // Not cosmetic: a child born between the two stamps inherits its parent's
    // value instead of needing one of its own.
    fakeProc(dir, 500, { ppid: 1 });
    fakeProc(dir, 502, { ppid: 501 });
    fakeProc(dir, 501, { ppid: 500 });
    expect([...descendantsOf(dir, 500).keys()]).toEqual([501, 502]);
  });

  it("drops a process that was reparented away from us", () => {
    // When an intermediate process dies its children are adopted by init, so
    // they are no longer ours to stamp. They keep the value they inherited.
    fakeProc(dir, 500, { ppid: 1 });
    fakeProc(dir, 501, { ppid: 500 });
    fakeProc(dir, 502, { ppid: 1 });
    expect([...descendantsOf(dir, 500).keys()]).toEqual([501]);
  });

  it("reads past a process name containing spaces and parentheses", () => {
    fakeProc(dir, 500, { ppid: 1 });
    fakeProc(dir, 501, { ppid: 500, comm: "we ird (name", starttime: 8675309 });
    expect(descendantsOf(dir, 500).get(501)?.starttime).toBe("8675309");
  });

  it("ignores the non-numeric entries every /proc has", () => {
    mkdirSync(join(dir, "self"), { recursive: true });
    writeFileSync(join(dir, "meminfo"), "MemTotal: 1 kB\n");
    fakeProc(dir, 500, { ppid: 1 });
    fakeProc(dir, 501, { ppid: 500 });
    expect([...descendantsOf(dir, 500).keys()]).toEqual([501]);
  });

  it("is empty rather than throwing when there is no /proc at all", () => {
    expect(descendantsOf(join(dir, "nope"), 500).size).toBe(0);
  });

  it("steps over an entry it cannot make sense of", () => {
    // A pid directory with no stat file (the process exited between the readdir
    // and the read) and one with a stat file that parses to nothing. Neither is
    // allowed to cost us the rest of the tree.
    fakeProc(dir, 500, { ppid: 1 });
    fakeProc(dir, 501, { ppid: 500 });
    mkdirSync(join(dir, "700"), { recursive: true });
    mkdirSync(join(dir, "701"), { recursive: true });
    writeFileSync(join(dir, "701", "stat"), "not a stat line at all\n");
    expect([...descendantsOf(dir, 500).keys()]).toEqual([501]);
  });
});

describe("stampProcess", () => {
  const ours = () => true;

  it("raises a process and confirms the value it reads back", () => {
    const info = fakeProc(dir, 501, { ppid: 500, score: "100" });
    const outcome = stampProcess({
      procRoot: dir,
      pid: 501,
      expected: info,
      isOurs: ours,
      target: 300,
    });
    expect(outcome).toBe("stamped");
    expect(adjOf(dir, 501)).toBe("300");
  });

  it("never lowers a score that is already higher", () => {
    // Lowering needs CAP_SYS_RESOURCE and would be refused anyway, and a
    // process that made itself an even better victim should stay one.
    const info = fakeProc(dir, 501, { ppid: 500, score: "500" });
    const outcome = stampProcess({
      procRoot: dir,
      pid: 501,
      expected: info,
      isOurs: ours,
      target: 300,
    });
    expect(outcome).toBe("already");
    expect(adjOf(dir, 501)).toBe("500");
  });

  it("does not write to a pid that was recycled since we looked", () => {
    // The pid we listed exited and a stranger inherited the number. Stamping it
    // would raise an unrelated process's chance of being killed.
    fakeProc(dir, 501, { ppid: 500, score: "100", starttime: 111 });
    const stale = { ppid: 500, starttime: "999" };
    const outcome = stampProcess({
      procRoot: dir,
      pid: 501,
      expected: stale,
      isOurs: ours,
      target: 300,
    });
    expect(outcome).toBe("skipped");
    expect(adjOf(dir, 501)).toBe("100");
  });

  it("does not write to a process that left our tree", () => {
    const info = fakeProc(dir, 501, { ppid: 1, score: "100" });
    const outcome = stampProcess({
      procRoot: dir,
      pid: 501,
      expected: info,
      isOurs: (ppid) => ppid === 500,
      target: 300,
    });
    expect(outcome).toBe("skipped");
    expect(adjOf(dir, 501)).toBe("100");
  });

  it("reports a refused write rather than assuming it took", () => {
    const info = fakeProc(dir, 501, {
      ppid: 500,
      score: "100",
      readOnlyScore: true,
    });
    const outcome = stampProcess({
      procRoot: dir,
      pid: 501,
      expected: info,
      isOurs: ours,
      target: 300,
    });
    expect(outcome).toBe("refused");
    expect(adjOf(dir, 501)).toBe("100");
  });

  it("reports a write that was accepted and then not honoured", () => {
    // The July failure in miniature, and the reason the value is read back at
    // all: the write returns success, the kernel keeps something else, and
    // anything that trusts the write reports a protection that is not there.
    const info = fakeProc(dir, 501, { ppid: 500, score: "100" });
    const outcome = stampProcess({
      procRoot: dir,
      pid: 501,
      expected: info,
      isOurs: ours,
      target: 300,
      writeAdj: () => {},
    });
    expect(outcome).toBe("refused");
    expect(adjOf(dir, 501)).toBe("100");
  });

  it("accepts a process that raised itself past the target mid-write", () => {
    // The readback asks "is it at least what we wanted", not "is it exactly".
    // A process that put itself even higher has satisfied the raise-only
    // invariant, and warning about it would be a false alarm.
    const info = fakeProc(dir, 501, { ppid: 500, score: "100" });
    const outcome = stampProcess({
      procRoot: dir,
      pid: 501,
      expected: info,
      isOurs: ours,
      target: 300,
      writeAdj: (path) => writeFileSync(path, "500"),
    });
    expect(outcome).toBe("stamped");
    expect(adjOf(dir, 501)).toBe("500");
  });

  it("is a silent skip for a pid that is not there at all", () => {
    const outcome = stampProcess({
      procRoot: dir,
      pid: 999,
      expected: { ppid: 500, starttime: "1" },
      isOurs: ours,
      target: 300,
    });
    expect(outcome).toBe("skipped");
  });
});

describe("createAgentOomStamper", () => {
  function stamper(opts: Parameters<typeof createAgentOomStamper>[0] = {}) {
    const logs: string[] = [];
    const warns: string[] = [];
    return {
      logs,
      warns,
      ...createAgentOomStamper({
        procRoot: dir,
        rootPid: 500,
        log: (m) => logs.push(m),
        warn: (m) => warns.push(m),
        ...opts,
      }),
    };
  }

  it("stamps the whole tree and says so once, then goes quiet", () => {
    // Silence is the contract: this runs every ten seconds for the life of the
    // office, so a line per sweep would bury everything else in the log.
    fakeProc(dir, 500, { ppid: 1, score: "100" });
    fakeProc(dir, 501, { ppid: 500, score: "100", comm: "claude" });
    fakeProc(dir, 502, { ppid: 501, score: "100", comm: "bun" });
    const s = stamper();

    const first = s.sweep();
    expect(first.stamped.sort()).toEqual([501, 502]);
    expect(adjOf(dir, 501)).toBe(String(AGENT_OOM_SCORE_ADJ));
    expect(adjOf(dir, 502)).toBe(String(AGENT_OOM_SCORE_ADJ));
    expect(s.logs.length).toBe(1);
    expect(s.logs[0]).toContain(`oom_score_adj=${AGENT_OOM_SCORE_ADJ}`);
    expect(s.logs[0]).toContain("this server is at 100");

    const second = s.sweep();
    expect(second.stamped).toEqual([]);
    expect(second.already).toBe(2);
    expect(s.logs.length).toBe(1);
    expect(s.warns).toEqual([]);
  });

  it("leaves the office server's own score alone", () => {
    fakeProc(dir, 500, { ppid: 1, score: "-500" });
    fakeProc(dir, 501, { ppid: 500, score: "-500" });
    const s = stamper();
    s.sweep();
    expect(adjOf(dir, 500)).toBe("-500");
    expect(adjOf(dir, 501)).toBe(String(AGENT_OOM_SCORE_ADJ));
    expect(s.logs[0]).toContain("this server is at -500");
  });

  it("names the process it could not mark, once", () => {
    fakeProc(dir, 500, { ppid: 1, score: "100" });
    fakeProc(dir, 501, { ppid: 500, score: "100", readOnlyScore: true });
    const s = stamper();
    s.sweep();
    s.sweep();
    expect(s.warns.length).toBe(1);
    expect(s.warns[0]).toContain("pid 501");
    expect(s.warns[0]).toContain(`asked for ${AGENT_OOM_SCORE_ADJ}`);
    expect(s.warns[0]).toContain("the kernel reports 100");
    // Nothing was stamped, so there is nothing to announce either.
    expect(s.logs).toEqual([]);
  });

  it("does not warn about a process that ended up above the target", () => {
    fakeProc(dir, 500, { ppid: 1, score: "100" });
    fakeProc(dir, 501, { ppid: 500, score: "100" });
    const s = stamper({ writeAdj: (path) => writeFileSync(path, "500") });
    const result = s.sweep();
    expect(result.stamped).toEqual([501]);
    expect(s.warns).toEqual([]);
  });

  it("keeps working when one process in the tree cannot be touched", () => {
    fakeProc(dir, 500, { ppid: 1, score: "100" });
    fakeProc(dir, 501, { ppid: 500, score: "100", readOnlyScore: true });
    fakeProc(dir, 502, { ppid: 500, score: "100" });
    const s = stamper();
    const result = s.sweep();
    expect(result.stamped).toEqual([502]);
    expect(result.refused.map((r) => r.pid)).toEqual([501]);
    expect(adjOf(dir, 502)).toBe(String(AGENT_OOM_SCORE_ADJ));
  });
});
