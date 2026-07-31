// The office server renames its own process so that out-of-memory protection
// can shield it by name without also shielding agent builds (task a51393e7).
//
// These run in real subprocesses on purpose. /proc/self/comm is per-thread and
// the rename is a live kernel side effect, so asserting it in-process would
// rename the test runner itself - and a renamed test runner is exactly the
// contamination that would make earlyoom's view of the box wrong on a dev
// machine. Each case spawns a throwaway process, renames that, and reads the
// kernel back.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { OFFICE_PROCESS_NAME } from "./process-name.ts";

const MODULE = `${import.meta.dir}/process-name.ts`;
const SRC = readFileSync(`${import.meta.dir}/isomux-office.ts`, "utf8");

/** Run `code` in a fresh bun process and return its trimmed stdout. */
async function inSubprocess(code: string): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", code], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`subprocess exited ${exit}: ${err}`);
  return out.trim();
}

/** Field 2 of /proc/PID/stat is the process name, in parentheses. */
const READ_STAT_NAME = `readFileSync("/proc/self/stat","utf8").split(" ")[1]`;

describe("setProcessName", () => {
  test("renames the running process as the kernel reports it", async () => {
    const out = await inSubprocess(`
      const { readFileSync } = require("fs");
      const { setProcessName } = await import("${MODULE}");
      const before = readFileSync("/proc/self/comm", "utf8").trim();
      const ok = setProcessName();
      const comm = readFileSync("/proc/self/comm", "utf8").trim();
      console.log(JSON.stringify({ before, ok, comm, stat: ${READ_STAT_NAME} }));
    `);
    const got = JSON.parse(out);
    expect(got.before).toBe("bun");
    expect(got.ok).toBe(true);
    // Both readbacks matter: /proc/PID/comm is the interface we write, and
    // /proc/PID/stat is the one earlyoom actually parses to pick a victim.
    expect(got.comm).toBe(OFFICE_PROCESS_NAME);
    expect(got.stat).toBe(`(${OFFICE_PROCESS_NAME})`);
  });

  test("a bun child of a renamed server is still named bun", async () => {
    const out = await inSubprocess(`
      const { execSync } = require("child_process");
      const { setProcessName } = await import("${MODULE}");
      setProcessName();
      // The case that matters: an agent's build is a bun process exec'd below
      // the server. It must come out named "bun" so that shielding "isomux"
      // does not shield it - the collision this change exists to remove. Asking
      // a real bun child what the kernel calls it, rather than asserting the
      // weaker "not isomux".
      console.log(
        execSync("bun -e 'process.stdout.write(require(\\"fs\\").readFileSync(\\"/proc/self/comm\\",\\"utf8\\"))'")
          .toString().trim(),
      );
    `);
    expect(out).toBe("bun");
  });

  test("truncates to the 15 characters the kernel stores", async () => {
    const out = await inSubprocess(`
      const { readFileSync } = require("fs");
      const { setProcessName } = await import("${MODULE}");
      setProcessName("aaaaaaaaaaaaaaaaaaaaaa");
      console.log(readFileSync("/proc/self/comm", "utf8").trim());
    `);
    expect(out).toBe("a".repeat(15));
  });

  test("the name matches the one deploy/oom-protect.sh shields", () => {
    const oom = readFileSync(
      `${import.meta.dir}/../deploy/oom-protect.sh`,
      "utf8",
    );
    const avoid = oom.match(/--avoid '\^\(([^)]*)\)\$'/);
    expect(avoid).not.toBeNull();
    expect(avoid![1].split("|")).toContain(OFFICE_PROCESS_NAME);
    // The collision this whole change exists to remove.
    expect(avoid![1].split("|")).not.toContain("bun");
  });
});

describe("wiring", () => {
  test("runOfficeMain renames the process before booting the server", () => {
    const main = SRC.slice(SRC.indexOf("export async function runOfficeMain"));
    const rename = main.indexOf("setProcessName()");
    const boot = main.indexOf("await startServer()");
    const cli = main.indexOf('process.argv[2] === "owner-login"');
    expect(rename).toBeGreaterThan(-1);
    // After the CLI fast-path: `owner-login` is a different program and exits
    // before the boot, so it keeps its own name.
    expect(rename).toBeGreaterThan(cli);
    expect(rename).toBeLessThan(boot);
  });

  test("the rename is not a side effect of importing a server module", () => {
    const mod = readFileSync(MODULE, "utf8");
    // A top-level call would rename anything that imports this, including bun
    // test workers - which would both break the tests above and put a wrong
    // name in front of earlyoom on a dev box.
    expect(mod).not.toMatch(/^setProcessName\(/m);
  });
});
