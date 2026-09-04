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
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OFFICE_PROCESS_NAME } from "./process-name.ts";

const MODULE = `${import.meta.dir}/process-name.ts`;
const ENTRY_POINT = `${import.meta.dir}/isomux-office.ts`;

/** Run `code` in a fresh bun process and return its trimmed stdout. */
async function inSubprocess(
  code: string,
  env?: Record<string, string | undefined>,
): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", code], {
    env,
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
  test("importing the office entry point does not rename the process", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "isomux-process-name-"));
    try {
      const out = await inSubprocess(
        `
          const { readFileSync } = require("fs");
          await import("${ENTRY_POINT}");
          process.stdout.write(readFileSync("/proc/self/comm", "utf8"));
        `,
        {
          ...process.env,
          HOME: stateDir,
          ISOMUX_HOME: stateDir,
          ISOMUX_BACKUP_DIR: stateDir,
          XDG_CONFIG_HOME: stateDir,
          PORT: "0",
        },
      );
      expect(out).toBe("bun");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test(
    "the office entry point renames its own process on a normal boot",
    async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "isomux-process-name-"));
      const startedAt = performance.now();
      const proc = Bun.spawn(["bun", "run", ENTRY_POINT], {
        env: {
          ...process.env,
          HOME: stateDir,
          ISOMUX_HOME: stateDir,
          ISOMUX_BACKUP_DIR: stateDir,
          XDG_CONFIG_HOME: stateDir,
          PORT: "0",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderrPromise = new Response(proc.stderr).text();
      const deadline = startedAt + 15_000;
      let firstComm: string | undefined;
      let lastComm: string | undefined;
      let observedRenameMs: number | undefined;
      let failure: Error | undefined;

      try {
        while (performance.now() < deadline) {
          try {
            lastComm = readFileSync(`/proc/${proc.pid}/comm`, "utf8").trim();
          } catch (error) {
            const exitCode = await proc.exited;
            const stderr = await stderrPromise;
            const phase =
              firstComm === undefined
                ? "spawn error before first read"
                : "exited before rename";
            failure = new Error(
              `office child ${phase}: last comm=${lastComm ?? "unread"}, alive=false, exit=${exitCode}, stderr=${JSON.stringify(stderr)}`,
              { cause: error },
            );
            break;
          }

          if (firstComm === undefined) {
            firstComm = lastComm;
            if (firstComm !== "bun") {
              failure = new Error(
                `office child was not observed before rename: first comm=${firstComm}`,
              );
              break;
            }
          }
          if (lastComm === OFFICE_PROCESS_NAME) {
            observedRenameMs = performance.now() - startedAt;
            break;
          }
          await Bun.sleep(50);
        }

        if (observedRenameMs === undefined && failure === undefined) {
          const alive = proc.exitCode === null;
          if (alive) proc.kill();
          const exitCode = await proc.exited;
          const stderr = await stderrPromise;
          failure = new Error(
            `office child did not rename before deadline: last comm=${lastComm ?? "unread"}, alive=${alive}, exit=${exitCode}, stderr=${JSON.stringify(stderr)}`,
          );
        }
      } finally {
        if (proc.exitCode === null) proc.kill();
        await proc.exited;
        await stderrPromise;
        rmSync(stateDir, { recursive: true, force: true });
      }

      if (failure) throw failure;
      expect(firstComm).toBe("bun");
      expect(lastComm).toBe(OFFICE_PROCESS_NAME);
    },
    30_000,
  );
});
