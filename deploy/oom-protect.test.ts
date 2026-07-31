// deploy/oom-protect.sh — the kill-order logic, exercised against a fake /proc.
//
// This task (c5b4e89e) exists because the original verification trusted
// `systemctl show`, which reports the value that was ASKED for. The kernel held
// something else for a week and nobody noticed. So the behaviour that has to be
// pinned here is not "the tool writes a number" but "the tool reads the number
// back and says so when it did not take" — a later refactor that quietly drops
// the readback would recreate the July bug exactly.
//
// Real pids cannot be used: the interesting cases are a refused write and a pid
// that gets recycled mid-stamp, neither of which is reproducible on demand
// against a live /proc. The script therefore reads and writes through a
// PROC_ROOT variable, and these tests point it at a directory tree they build.
// `main "$@"` is stripped from the copy under test so the functions can be
// sourced; a separate test pins that the real script still calls it.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = new URL("./oom-protect.sh", import.meta.url).pathname;
const SRC = readFileSync(SCRIPT, "utf8");

let dir = "";
let testable = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oom-protect-test-"));
  testable = join(dir, "sourceable.sh");
  // Everything except the entry point call, so sourcing runs no side effects.
  const body = SRC.replace(/\nmain "\$@"\n$/, "\n");
  expect(body).not.toBe(SRC);
  writeFileSync(testable, body);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake /proc holding one process: a start time, a score, and a cgroup. */
function fakeProc(
  procRoot: string,
  pid: number,
  opts: {
    starttime?: number;
    score?: string;
    comm?: string;
    cgroup?: string;
    ppid?: number;
    readOnlyScore?: boolean;
  } = {},
): string {
  const d = join(procRoot, String(pid));
  mkdirSync(d, { recursive: true });
  const comm = opts.comm ?? "bun";
  // Laid out as the kernel does: field 1 the pid, field 2 the name in parens,
  // field 3 the state, then filler up to the start time at field 22. Tests pass
  // names containing spaces and parens, which is what breaks naive splitting.
  const pad = Array(18).fill("0").join(" ");
  writeFileSync(
    join(d, "stat"),
    `${pid} (${comm}) S ${pad} ${opts.starttime ?? 12345} 0 0\n`,
  );
  const score = join(d, "oom_score_adj");
  writeFileSync(score, `${opts.score ?? "0"}\n`);
  if (opts.readOnlyScore) chmodSync(score, 0o444);
  writeFileSync(join(d, "cgroup"), `${opts.cgroup ?? "0::/init.scope"}\n`);
  writeFileSync(
    join(d, "status"),
    `Name:\t${comm}\nPPid:\t${opts.ppid ?? 1}\n`,
  );
  return d;
}

/** Source the script with PROC_ROOT pointed at `procRoot`, then run `code`. */
async function run(
  procRoot: string,
  code: string,
): Promise<{ out: string; exit: number }> {
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      // `set +e` AFTER sourcing: the script sets `-e` itself, and every case
      // here deliberately provokes a non-zero return we then want to inspect.
      `source ${testable}; set +e; PROC_ROOT=${procRoot}; DRY_RUN=""; ${code}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out: out + err, exit: await proc.exited };
}

describe("stamp_pid: the readback that this task exists for", () => {
  it("confirms a value it can actually verify in the kernel", async () => {
    const root = mkdtempSync(join(dir, "proc-ok-"));
    fakeProc(root, 42, { score: "0" });
    const { out } = await run(
      root,
      `stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("confirmed");
    expect(out).toContain("oom_score_adj=-500");
    expect(out).toContain("rc=0");
    expect(readFileSync(join(root, "42", "oom_score_adj"), "utf8").trim()).toBe(
      "-500",
    );
  });

  it("reports the REAL value, loudly, when the write is refused", async () => {
    // The July failure in miniature: the ask is -500, the kernel keeps 100, and
    // the tool must say so rather than report the value it wanted.
    const root = mkdtempSync(join(dir, "proc-refused-"));
    fakeProc(root, 42, { score: "100", readOnlyScore: true });
    const { out } = await run(
      root,
      `stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("kill order NOT applied");
    expect(out).toContain("asked for -500");
    expect(out).toContain("the kernel reports 100");
    expect(out).toContain("rc=1");
    expect(out).not.toContain("confirmed");
  });

  it("does not claim success when the pid was recycled mid-stamp", async () => {
    // The identity check has to bracket the READBACK, not just the write: a
    // stranger that happens to hold the requested value would otherwise be
    // reported as a confirmed success. Start times differ, so it must not be.
    const root = mkdtempSync(join(dir, "proc-recycled-"));
    fakeProc(root, 42, { score: "0" });
    // A marker file, not a shell variable: stamp_pid calls this inside a
    // command substitution, so a counter kept in a variable would be lost with
    // the subshell and both reads would return the same value.
    const { out } = await run(
      root,
      `proc_starttime() {
         if [[ -e ${root}/seen ]]; then echo 999; else touch ${root}/seen; echo 111; fi
       }
       stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("exited mid-write");
    expect(out).toContain("rc=1");
    expect(out).not.toContain("confirmed");
  });

  it("authenticates the READBACK, not just the write", async () => {
    // Pins the ordering, which the case above cannot: there, the two start
    // times differ, so any ordering warns. The real hole was narrower — a
    // process that exits AFTER the identity check and before the value is read.
    // Both start times then come from the original while the value comes from
    // whatever inherited the pid, and a stranger holding the asked-for value by
    // coincidence reads as a confirmed success.
    //
    // Simulated by a stub that keeps the identity stable but rewrites the score
    // to the requested value on its second call, standing in for the stranger.
    // The write itself is refused, so the only way -500 can appear is from the
    // impostor. Read the value before the second identity check and this
    // reports success against the wrong process; read it after and it does not.
    const root = mkdtempSync(join(dir, "proc-impostor-"));
    fakeProc(root, 42, { score: "100", readOnlyScore: true });
    const score = join(root, "42", "oom_score_adj");
    const { out } = await run(
      root,
      `proc_starttime() {
         if [[ -e ${root}/seen ]]; then chmod 644 ${score}; echo -500 > ${score}
         else touch ${root}/seen; fi
         echo 111
       }
       stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).not.toContain("confirmed");
    expect(out).toContain("kill order NOT applied");
    expect(out).toContain("the kernel reports 100");
    expect(out).toContain("rc=1");
  });

  it("treats a vanished process as unconfirmed, not as success", async () => {
    const root = mkdtempSync(join(dir, "proc-gone-"));
    fakeProc(root, 42, { score: "0" });
    const { out } = await run(
      root,
      `proc_starttime() { echo ""; }
       stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("exited mid-write");
    expect(out).toContain("rc=1");
  });

  it("is a silent no-op for a pid that is not there at all", async () => {
    const root = mkdtempSync(join(dir, "proc-empty-"));
    mkdirSync(root, { recursive: true });
    const { out } = await run(root, `stamp_pid 999 -500 "gone"; echo "rc=$?"`);
    expect(out).toContain("rc=1");
    expect(out).not.toContain("warning");
    expect(out).not.toContain("confirmed");
  });

  it("changes nothing under --dry-run", async () => {
    const root = mkdtempSync(join(dir, "proc-dry-"));
    fakeProc(root, 42, { score: "7" });
    const { out } = await run(
      root,
      `DRY_RUN=1; stamp_pid 42 -500 "the office"; echo "rc=$?"`,
    );
    expect(out).toContain("DRY-RUN");
    expect(out).toContain("rc=0");
    expect(readFileSync(join(root, "42", "oom_score_adj"), "utf8").trim()).toBe(
      "7",
    );
  });

  it("reads the start time past a process name containing spaces", async () => {
    const root = mkdtempSync(join(dir, "proc-spacey-"));
    fakeProc(root, 42, { comm: "we ird (name", starttime: 8675309 });
    const { out } = await run(root, `proc_starttime 42`);
    expect(out.trim()).toBe("8675309");
  });
});

describe("find_user_isomux_pid: the server, not the agents beside it", () => {
  const USER_CG =
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/isomux.service";

  it("picks the service root over its own descendants", async () => {
    // The office and everything it spawns share one cgroup. Stamping an agent
    // instead of the server would protect exactly the wrong process, so the
    // one whose parent sits outside the cgroup is the one that counts.
    const root = mkdtempSync(join(dir, "proc-user-"));
    fakeProc(root, 500, { cgroup: USER_CG, ppid: 1 });
    fakeProc(root, 501, { cgroup: USER_CG, ppid: 500, comm: "claude" });
    fakeProc(root, 502, { cgroup: USER_CG, ppid: 501, comm: "bun" });
    const { out } = await run(root, `find_user_isomux_pid`);
    expect(out.trim()).toBe("500");
  });

  it("finds nothing on a box with no user-level office", async () => {
    const root = mkdtempSync(join(dir, "proc-system-"));
    fakeProc(root, 600, { cgroup: "0::/system.slice/isomux.service" });
    const { out, exit } = await run(root, `find_user_isomux_pid`);
    expect(out.trim()).toBe("");
    expect(exit).not.toBe(0);
  });

  it("leaves the user-level branch a no-op when there is no match", async () => {
    const root = mkdtempSync(join(dir, "proc-none-"));
    fakeProc(root, 600, { cgroup: "0::/system.slice/isomux.service" });
    const { out } = await run(
      root,
      `configure_user_level_office; echo "rc=$?"`,
    );
    expect(out).not.toContain("found a user-level office");
    expect(out).toContain("rc=0");
  });

  it("stamps and confirms a user-level office when there is one", async () => {
    const root = mkdtempSync(join(dir, "proc-user2-"));
    fakeProc(root, 500, { cgroup: USER_CG, ppid: 1, score: "100" });
    const { out } = await run(root, `configure_user_level_office`);
    expect(out).toContain("found a user-level office (pid 500)");
    expect(out).toContain("oom_score_adj=-500 confirmed");
    expect(out).toContain("lasts until the office restarts");
  });
});

describe("the shipped script", () => {
  it("still calls main, which the sourceable copy strips", () => {
    expect(SRC.endsWith('\nmain "$@"\n')).toBe(true);
  });

  it("never verifies a score with systemctl show", () => {
    // systemctl reports the configured value, not the effective one. Resolving
    // MainPID with it is fine; believing it about a score is the original bug.
    for (const line of SRC.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      if (!line.includes("systemctl show")) continue;
      expect(line).toContain("MainPID");
      expect(line).not.toContain("OOMScoreAdjust");
    }
  });

  it("reads every score back through the seam, never a hardcoded /proc", () => {
    const body = SRC.split("\n").filter((l) => !l.trim().startsWith("#"));
    const hardcoded = body.filter((l) => /\/proc\/\$/.test(l));
    expect(hardcoded).toEqual([]);
  });
});
