// The runner of an ask's command (task c3b91695) with the office's own
// spawn and a real shell: what the command gets (the cwd, only the given
// environment, no input), what comes back (the exit, the output in arrival
// order without escape codes, secrets masked before the tail is cut), and how
// a run ends (a background child does not hold it, the timeout stops the
// whole process group).

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ASK_RUN_OUTPUT_TAIL,
  startAskRun,
  type AskRunOptions,
  type AskRunResult,
} from "./ask-command-runner.ts";
import { setSecretValuesForRedaction } from "./log-redaction.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "isomux-ask-run-")));
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
// Background children a case started, killed at the end whatever happened.
const strays: number[] = [];

afterAll(() => {
  setSecretValuesForRedaction([]);
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
  rmSync(work, { recursive: true, force: true });
});

async function run(
  command: string,
  opts: Partial<AskRunOptions> = {},
): Promise<AskRunResult> {
  const started = await startAskRun({
    command,
    cwd: work,
    env: ENV,
    shell: "/bin/sh",
    ...opts,
  });
  return started.done;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The pid a command printed as "bg=<pid>".
function bgPid(output: string): number {
  const m = /bg=(\d+)/.exec(output);
  if (!m) throw new Error(`no bg pid in: ${output}`);
  const pid = Number(m[1]);
  strays.push(pid);
  return pid;
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 1000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !alive(pid);
}

describe("what the command gets", () => {
  it("runs in the cwd with only the given environment", async () => {
    process.env.C3B91695_SERVER_ONLY = "leaked";
    try {
      const result = await run(
        'pwd; echo "mark=$C3B91695_MARK"; echo "server=$C3B91695_SERVER_ONLY"',
        { env: { ...ENV, C3B91695_MARK: "m1" } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe(`${work}\nmark=m1\nserver=\n`);
    } finally {
      delete process.env.C3B91695_SERVER_ONLY;
    }
  });

  it("gets no input, so a command that reads stdin ends", async () => {
    // cat waits until stdin closes: an open stdin would hold the run.
    const result = await run("cat; echo read-done");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("read-done\n");
  });

  it("rejects when the shell or the cwd is missing", async () => {
    const outcomes: string[] = [];
    // The same call with both present starts: the refusals are the paths.
    for (const opts of [
      {},
      { shell: "/nonexistent/c3b91695-sh" },
      { cwd: join(work, "missing-dir") },
    ])
      outcomes.push(
        await startAskRun({
          command: "true",
          cwd: work,
          env: ENV,
          shell: "/bin/sh",
          ...opts,
        }).then(
          () => "started",
          () => "rejected",
        ),
      );
    expect(outcomes).toEqual(["started", "rejected", "rejected"]);
  });
});

describe("what comes back", () => {
  it("the exit code, and stdout and stderr in arrival order without escape codes", async () => {
    const result = await run(
      "echo one; sleep 0.1; echo two >&2; sleep 0.1; printf '\\033[31mthree\\033[0m\\n'; exit 3",
    );
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      timedOut: false,
      output: "one\ntwo\nthree\n",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(200);
  });

  it("the signal that ended it", async () => {
    const result = await run("kill -USR1 $$");
    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGUSR1",
      timedOut: false,
    });
  });

  it("only the last ASK_RUN_OUTPUT_TAIL characters", async () => {
    const result = await run(
      "head -c 1100000 /dev/zero | tr '\\0' a; printf END",
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("a".repeat(ASK_RUN_OUTPUT_TAIL - 3) + "END");
  });

  it("secrets masked before the tail is cut, so none is half kept", async () => {
    const secret = "C3B91695-secret-value-Zq8Wm2Lp4Rt6Yv9X";
    setSecretValuesForRedaction([secret]);
    try {
      // Unmasked, the tail would begin with the secret's last 20 characters.
      const pad = ASK_RUN_OUTPUT_TAIL - 20;
      const result = await run(
        `printf '%s' '${secret}'; head -c ${pad} /dev/zero | tr '\\0' x`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output.endsWith("x".repeat(pad))).toBe(true);
      const kept = [];
      for (let i = 0; i + 8 <= secret.length; i++)
        if (result.output.includes(secret.slice(i, i + 8)))
          kept.push(secret.slice(i, i + 8));
      expect(kept).toEqual([]);

      const whole = await run(`echo 'token ${secret} end'`);
      expect(whole.output).not.toContain(secret);
      expect(whole.output).toContain("end");
    } finally {
      setSecretValuesForRedaction([]);
    }
  });
});

describe("how a run ends", () => {
  it("when the shell exits, even while a background child keeps the output open", async () => {
    const t0 = Date.now();
    const result = await run('sleep 4 & echo "bg=$!"');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(result.exitCode).toBe(0);
    expect(alive(bgPid(result.output))).toBe(true);
  });

  it("at the timeout, SIGTERM to the whole process group", async () => {
    const result = await run('sleep 30 & echo "bg=$!"; wait', {
      timeoutMs: 300,
    });
    expect(result).toMatchObject({
      timedOut: true,
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(await gone(bgPid(result.output))).toBe(true);
  });

  it("SIGKILL after the grace when the group ignores SIGTERM", async () => {
    const t0 = Date.now();
    const result = await run("trap '' TERM; while :; do sleep 0.1; done", {
      timeoutMs: 300,
      killGraceMs: 300,
    });
    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
