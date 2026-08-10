// The hard-timeout seam, tested directly rather than through a fake.
//
// Everything about the whole-handler budget rests on two claims that no mocked
// Exec can make: that SpawnExec really kills a child and really THROWS, and that
// a client handed a shrinking budget passes the current figure to each child. A
// fake that ignores ExecOptions would let both regress silently.

import { describe, expect, test } from "bun:test";
import {
  RemoteTimeoutError,
  SpawnExec,
  SshClient,
  classifyAuth,
  resolveTimeout,
  type Exec,
  type ExecOptions,
  type ExecResult,
} from "./ssh.ts";

describe("SpawnExec", () => {
  test("kills a real child that outlives its bound, and throws", async () => {
    const started = Date.now();
    let thrown: unknown;
    try {
      await new SpawnExec().run(["sleep", "30"], { timeoutMs: 300 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RemoteTimeoutError);
    // It really did not wait 30 seconds for the process.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a timeout is NEVER an ExecResult", async () => {
    // This is the whole reason it throws. classifyAuth reads any exit status
    // other than ssh's own 255 as "the remote command ran, so authentication
    // had already succeeded" - so a timeout coming back as, say, exit 124 would
    // certify an authentication that never happened.
    expect(classifyAuth({ code: 124, stdout: "", stderr: "" })).toEqual({
      kind: "authenticated",
    });
    let thrown: unknown;
    try {
      await new SpawnExec().run(["sleep", "30"], { timeoutMs: 200 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RemoteTimeoutError);
  });

  test("a child that finishes inside its bound is unaffected", async () => {
    const res = await new SpawnExec().run(["true"], { timeoutMs: 10_000 });
    expect(res.code).toBe(0);
  });
});

describe("the timeout source", () => {
  test("a budget with nothing left refuses before anything is spawned", async () => {
    expect(() => resolveTimeout(() => 0)).toThrow(RemoteTimeoutError);
    expect(() => resolveTimeout(() => -1)).toThrow(RemoteTimeoutError);
    expect(resolveTimeout(() => 5_000)).toBe(5_000);
    expect(resolveTimeout(undefined)).toBeUndefined();
  });

  test("each child of one client gets the CURRENT remaining figure", async () => {
    const seen: (number | undefined)[] = [];
    const exec: Exec = {
      run(_argv: string[], opts?: ExecOptions): Promise<ExecResult> {
        seen.push(opts?.timeoutMs);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    };
    // A budget that shrinks by 20s per call, as a real one does while a handler
    // runs several children.
    let remaining = 60_000;
    const ssh = new SshClient(
      {
        host: "h",
        user: "root",
        identityFile: "/tmp/k",
        knownHostsFile: "/tmp/kh",
      },
      exec,
      "yes",
      () => {
        const now = remaining;
        remaining -= 20_000;
        return now;
      },
    );
    await ssh.script("true\n");
    await ssh.script("true\n");
    await ssh.script("true\n");
    expect(seen).toEqual([60_000, 40_000, 20_000]);
    // The fourth child would have nothing left, and is refused rather than run.
    let refused: unknown;
    try {
      await ssh.script("true\n");
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(RemoteTimeoutError);
    expect(seen).toHaveLength(3);
  });
});
