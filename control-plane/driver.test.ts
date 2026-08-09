import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  authorizedKeysPathFor,
  formatExpiry,
  formatOnCalendar,
  identityFor,
  parseLaunch,
  parseTick,
  proveRemoval,
  renderCleanupUnits,
  rewriteKeyWithExpiry,
  onCalendarFromExpiry,
  parseTimerEvidence,
  timerIsArmed,
  waitForAuthenticatedSsh,
} from "./driver.ts";
import {
  SshClient,
  type Exec,
  type ExecResult,
  type SshTarget,
} from "./ssh.ts";

const target: SshTarget = {
  host: "box.example",
  user: "root",
  identityFile: "/run/key",
  knownHostsFile: "/run/known_hosts",
};

const KEY = { algorithm: "ssh-ed25519", blob: "AAAAC3NzaC1lZDI1NTE5AAAAI" };

/** A scripted process seam: driver logic is exercised with no box anywhere. */
class FakeExec implements Exec {
  calls: { argv: string[]; stdin?: string }[] = [];
  constructor(private readonly replies: ExecResult[]) {}
  run(argv: string[], opts?: { stdin?: string }): Promise<ExecResult> {
    this.calls.push({ argv, stdin: opts?.stdin });
    return Promise.resolve(
      this.replies.shift() ?? { code: 0, stdout: "", stderr: "" },
    );
  }
}

/** Run something expected to fail and return its message, so the assertion is
 * on the message rather than on a matcher's own thenability. */
async function captureError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "(no error thrown)";
}

const clockReply: ExecResult = {
  code: 0,
  stdout: "2026-08-09T12:00:00Z\n",
  stderr: "",
};

describe("expiry formatting", () => {
  test("renders sshd's absolute UTC instant", () => {
    expect(formatExpiry(new Date(Date.UTC(2026, 7, 9, 5, 4, 3)))).toBe(
      "20260809050403Z",
    );
  });
  test("renders systemd's OnCalendar for the same instant", () => {
    expect(formatOnCalendar(new Date(Date.UTC(2026, 7, 9, 5, 4, 3)))).toBe(
      "2026-08-09 05:04:03 UTC",
    );
  });
});

describe("first contact", () => {
  // MANAGER RULING (2026-08-09, slice 1, clause 1): "The driver itself refuses
  // to rewrite an authorized_keys line without an absolute expiry instant - a
  // missing ceiling stops the run at every layer: argument parsing rejects it
  // AND the driver treats a missing instant as a precondition failure."
  test("refuses to rewrite without an absolute expiry instant", async () => {
    const exec = new FakeExec([]);
    const ssh = new SshClient(target, exec);
    expect(
      await captureError(() =>
        rewriteKeyWithExpiry(ssh, identityFor("root"), KEY, undefined),
      ),
    ).toMatch(/without an absolute expiry instant/);
    // The precondition fires before anything touches the box.
    expect(exec.calls.length).toBe(0);
  });

  test("refuses an invalid instant just as firmly", async () => {
    const ssh = new SshClient(target, new FakeExec([]));
    expect(
      await captureError(() =>
        rewriteKeyWithExpiry(
          ssh,
          identityFor("root"),
          KEY,
          new Date("nonsense"),
        ),
      ),
    ).toMatch(/without an absolute expiry instant/);
  });

  // M4. Believing our own write is how a box ends up holding an unexpiring key
  // while provisioning reports the step complete.
  test("fails when the read-back shows our key WITHOUT the expiry option", async () => {
    const ssh = new SshClient(
      target,
      new FakeExec([
        {
          code: 0,
          stdout: `RESULT: ok\nREADBACK: ${KEY.algorithm} ${KEY.blob} isomux\n`,
          stderr: "",
        },
        clockReply,
      ]),
    );
    expect(
      await captureError(() =>
        rewriteKeyWithExpiry(
          ssh,
          identityFor("root"),
          KEY,
          new Date(Date.UTC(2026, 7, 10)),
        ),
      ),
    ).toMatch(/unexpiring key/);
  });

  test("fails when the key is not on the box at all", async () => {
    const ssh = new SshClient(
      target,
      new FakeExec([
        { code: 1, stdout: "RESULT: key-not-present\n", stderr: "" },
      ]),
    );
    expect(
      await captureError(() =>
        rewriteKeyWithExpiry(
          ssh,
          identityFor("root"),
          KEY,
          new Date(Date.UTC(2026, 7, 10)),
        ),
      ),
    ).toMatch(/expiry rewrite failed/);
  });

  test("accepts a read-back that carries the exact option, and reports the box clock", async () => {
    const expiresAt = new Date(Date.UTC(2026, 7, 10, 6, 0, 0));
    const expiry = formatExpiry(expiresAt);
    const ssh = new SshClient(
      target,
      new FakeExec([
        {
          code: 0,
          stdout: `RESULT: ok\nREADBACK: expiry-time="${expiry}" ${KEY.algorithm} ${KEY.blob} isomux\n`,
          stderr: "",
        },
        clockReply,
      ]),
    );
    const out = await rewriteKeyWithExpiry(
      ssh,
      identityFor("root"),
      KEY,
      expiresAt,
    );
    expect(out.expiry).toBe(expiry);
    expect(out.boxClockUtc).toBe("2026-08-09T12:00:00Z");
  });

  test("a non-root login user gets sudo; root does not", async () => {
    const rootExec = new FakeExec([{ code: 1, stdout: "", stderr: "" }]);
    await rewriteKeyWithExpiry(
      new SshClient(target, rootExec),
      identityFor("root"),
      KEY,
      new Date(Date.UTC(2026, 7, 10)),
    ).catch(() => undefined);
    expect(rootExec.calls[0]?.argv).not.toContain("sudo");

    const userExec = new FakeExec([{ code: 1, stdout: "", stderr: "" }]);
    await rewriteKeyWithExpiry(
      new SshClient(target, userExec),
      identityFor("ubuntu"),
      KEY,
      new Date(Date.UTC(2026, 7, 10)),
    ).catch(() => undefined);
    expect(userExec.calls[0]?.argv).toContain("sudo");
  });

  test("the authorized_keys path follows the account our key landed on", () => {
    expect(authorizedKeysPathFor("root")).toBe("/root/.ssh/authorized_keys");
    expect(authorizedKeysPathFor("ubuntu")).toBe(
      "/home/ubuntu/.ssh/authorized_keys",
    );
  });
});

describe("launch outcomes", () => {
  test("CONFIRMED carries the runId", () => {
    expect(
      parseLaunch({ code: 0, stdout: "CONFIRMED run-7\n", stderr: "" }),
    ).toEqual({
      kind: "confirmed",
      runId: "run-7",
    });
  });

  // A timeout is NOT a failure. Relaunching an unconfirmed run is the same
  // error class as replaying an ambiguous create.
  test("a publication timeout is unconfirmed, not failed", () => {
    expect(
      parseLaunch({
        code: 5,
        stdout: "UNCONFIRMED publication timed out\n",
        stderr: "",
      }).kind,
    ).toBe("unconfirmed");
  });

  test("a held lock is unconfirmed, not failed", () => {
    expect(
      parseLaunch({
        code: 3,
        stdout: "LOCKED another run holds the lock\n",
        stderr: "",
      }).kind,
    ).toBe("unconfirmed");
  });

  test("a supervisor that died before publishing is a real failure", () => {
    expect(
      parseLaunch({
        code: 4,
        stdout: "FAILED supervisor died before publication\n",
        stderr: "",
      }).kind,
    ).toBe("failed");
  });
});

describe("tick parsing", () => {
  test("reads a finished generation's verdict", () => {
    expect(parseTick("state=finished runId=r1 exit=0 step=report\n")).toEqual({
      state: "finished",
      runId: "r1",
      exit: 0,
      step: "report",
    });
  });
  test("reads a running generation", () => {
    expect(
      parseTick("state=running runId=r1 pid=42 step=build-isomux\n"),
    ).toEqual({
      state: "running",
      runId: "r1",
      pid: "42",
      step: "build-isomux",
    });
  });
  test("distinguishes a crash from progress", () => {
    expect(parseTick("state=crashed runId=r1 step=fetch-isomux\n").state).toBe(
      "crashed",
    );
  });
  test("no generation at all", () => {
    expect(parseTick("state=none\n")).toEqual({ state: "none" });
  });
});

// M3. The proof is the whole guarantee. Only sshd refusing our key counts.
describe("proveRemoval", () => {
  test("a publickey refusal proves removal", async () => {
    const exec = new FakeExec([
      { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    ]);
    expect(await proveRemoval(target, exec)).toEqual({ proven: true });
  });

  test("a successful connection is a FAILED revocation, loudly", async () => {
    const exec = new FakeExec([{ code: 0, stdout: "", stderr: "" }]);
    const out = await proveRemoval(target, exec);
    expect(out.proven).toBe(false);
    if (!out.proven) expect(out.reason).toMatch(/still authenticates/);
  });

  test("an unreachable box proves nothing and must not pass", async () => {
    const exec = new FakeExec([
      {
        code: 255,
        stdout: "",
        stderr: "ssh: connect to host box port 22: Connection timed out",
      },
    ]);
    const out = await proveRemoval(target, exec);
    expect(out.proven).toBe(false);
    if (!out.proven) expect(out.reason).toMatch(/inconclusive/);
  });

  test("a changed host key proves nothing and must not pass", async () => {
    const exec = new FakeExec([
      { code: 255, stdout: "", stderr: "Host key verification failed." },
    ]);
    expect((await proveRemoval(target, exec)).proven).toBe(false);
  });

  test("the proof offers only the removed key", async () => {
    const exec = new FakeExec([
      { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    ]);
    await proveRemoval(target, exec);
    const argv = exec.calls[0]?.argv ?? [];
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).toContain("IdentityAgent=none");
    expect(argv).toContain("-F");
    expect(argv).toContain("/dev/null");
  });
});

describe("cleanup units", () => {
  const units = renderCleanupUnits(
    "/root/.ssh/authorized_keys",
    KEY.blob,
    new Date(Date.UTC(2026, 7, 10, 6, 0, 0)),
  );

  test("an overdue timer still fires after a boot", () => {
    expect(units.timer).toContain("Persistent=true");
    expect(units.timer).toContain("OnCalendar=2026-08-10 06:00:00 UTC");
  });

  // Revocation deletes /var/lib/isomux-cp while this timer is still armed, so
  // nothing it needs may live there.
  test("the cleanup command does not live in the directory revocation deletes", () => {
    const execStart = units.service
      .split("\n")
      .find((l) => l.startsWith("ExecStart="));
    expect(execStart).toBeDefined();
    expect(execStart).not.toContain("/var/lib/isomux-cp");
    expect(execStart).toContain("/usr/local/sbin/isomux-cp-cleanup");
  });

  test("the unit removes the script and itself, rather than the script doing it mid-read", () => {
    expect(units.service).toContain(
      "ExecStartPost=-/bin/rm -f /usr/local/sbin/isomux-cp-cleanup",
    );
    expect(units.service).toContain("isomux-cp-cleanup.timer");
    expect(units.service).toContain("daemon-reload");
  });
});

// Found live on 2026-08-09, not by the stub tier: `accept-new` records a host
// key when the connection is made, BEFORE authentication is decided. During a
// recycle the OLD system answers for minutes after the provider accepts the
// reinstall, so probing straight into the run's known_hosts pins the host key
// of the box being destroyed - and every connection after the rebuild then
// fails as a host-key mismatch, which is meant to be a hard stop.
describe("waitForAuthenticatedSsh", () => {
  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "isomux-cp-pin-"));
  }

  /**
   * A faithful stand-in for `ssh -o StrictHostKeyChecking=accept-new`.
   *
   * The fidelity that matters: accept-new RECORDS a host key only when the file
   * has none for this host, and REFUSES when it holds a different one. It never
   * overwrites. A fake that just writes the current key every time cannot fail
   * on the bug this test exists for, because the last write would win.
   */
  function fakeSsh(opts: {
    rebuildAtProbe: number;
  }): Exec & { probes: number } {
    return {
      probes: 0,
      run(argv: string[]) {
        this.probes++;
        // Before the rebuild the OLD system answers, with the old host key and
        // without our new key. After it, the new host key and our key.
        const rebuilt = this.probes >= opts.rebuildAtProbe;
        const hostKey = rebuilt ? "host-key-REBUILT" : "host-key-OLD-BOX";
        const file = argv
          .find((a) => a.startsWith("UserKnownHostsFile="))!
          .slice("UserKnownHostsFile=".length);
        const existing = fs.existsSync(file)
          ? fs.readFileSync(file, "utf8").trim()
          : "";
        if (existing && existing !== hostKey) {
          return Promise.resolve({
            code: 255,
            stdout: "",
            stderr: "Host key verification failed.",
          });
        }
        if (!existing) fs.writeFileSync(file, `${hostKey}\n`);
        return Promise.resolve(
          rebuilt
            ? { code: 0, stdout: "", stderr: "" }
            : {
                code: 255,
                stdout: "",
                stderr: "Permission denied (publickey).",
              },
        );
      },
    };
  }

  // THE ONE THAT MATTERS. Probing straight into the run's known_hosts pins the
  // host key of the box being destroyed; when the rebuilt box comes back with a
  // different key, every probe after that is a host-key mismatch and the wait
  // can never succeed. Found live 2026-08-09.
  test("pins the REBUILT box's key, not the key of the box being destroyed", async () => {
    const dir = tempDir();
    const pinned = path.join(dir, "known_hosts");
    const exec = fakeSsh({ rebuildAtProbe: 3 });
    let n = 0;
    // The clock ADVANCES. With a frozen clock a probe that can never succeed
    // loops forever, and a hung test reports nothing at all - which is how this
    // assertion silently failed to catch its own regression the first time.
    let clock = 0;
    await waitForAuthenticatedSsh({
      target: { ...target, knownHostsFile: pinned },
      exec,
      tempKnownHosts: () => path.join(dir, `probe.${n++}`),
      timeoutMs: 60_000,
      sleep: () => Promise.resolve(),
      now: () => (clock += 1000),
    });
    expect(fs.readFileSync(pinned, "utf8").trim()).toBe("host-key-REBUILT");
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("probe."))).toEqual(
      [],
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a stale pin from a previous life is cleared before probing", async () => {
    const dir = tempDir();
    const pinned = path.join(dir, "known_hosts");
    fs.writeFileSync(pinned, "host-key-of-the-box-we-just-destroyed\n");
    const exec: Exec = {
      run: (argv) => {
        const file = argv
          .find((a) => a.startsWith("UserKnownHostsFile="))!
          .slice("UserKnownHostsFile=".length);
        fs.writeFileSync(file, "host-key-of-the-rebuilt-box\n");
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    };
    await waitForAuthenticatedSsh({
      target: { ...target, knownHostsFile: pinned },
      exec,
      tempKnownHosts: () => path.join(dir, "probe.0"),
      timeoutMs: 60_000,
      sleep: () => Promise.resolve(),
      now: (() => {
        let c = 0;
        return () => (c += 1000);
      })(),
    });
    expect(fs.readFileSync(pinned, "utf8").trim()).toBe(
      "host-key-of-the-rebuilt-box",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The initial clear only earns its place on the FAILURE path: on success the
  // rename overwrites the target anyway. What must not happen is a run that
  // never authenticates leaving a previous life's host key behind, where the
  // next command would silently trust it.
  test("a stale pin does not survive a wait that never authenticates", async () => {
    const dir = tempDir();
    const pinned = path.join(dir, "known_hosts");
    fs.writeFileSync(pinned, "host-key-of-the-box-we-just-destroyed\n");
    const exec: Exec = {
      run: (argv) => {
        const file = argv
          .find((a) => a.startsWith("UserKnownHostsFile="))!
          .slice("UserKnownHostsFile=".length);
        if (!fs.existsSync(file)) fs.writeFileSync(file, "host-key-REBUILT\n");
        return Promise.resolve({
          code: 255,
          stdout: "",
          stderr: "Permission denied (publickey).",
        });
      },
    };
    let n = 0;
    let clock = 0;
    expect(
      await captureError(() =>
        waitForAuthenticatedSsh({
          target: { ...target, knownHostsFile: pinned },
          exec,
          tempKnownHosts: () => path.join(dir, `probe.${n++}`),
          timeoutMs: 10,
          sleep: () => Promise.resolve(),
          now: () => (clock += 100),
        }),
      ),
    ).toMatch(/never authenticated/);
    expect(fs.existsSync(pinned)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("gives up rather than pinning anything when the key never authenticates", async () => {
    const dir = tempDir();
    const pinned = path.join(dir, "known_hosts");
    let clock = 0;
    const exec: Exec = {
      run: (argv) => {
        const file = argv
          .find((a) => a.startsWith("UserKnownHostsFile="))!
          .slice("UserKnownHostsFile=".length);
        fs.writeFileSync(file, "some-host-key\n");
        return Promise.resolve({
          code: 255,
          stdout: "",
          stderr: "Permission denied (publickey).",
        });
      },
    };
    let n = 0;
    expect(
      await captureError(() =>
        waitForAuthenticatedSsh({
          target: { ...target, knownHostsFile: pinned },
          exec,
          tempKnownHosts: () => path.join(dir, `probe.${n++}`),
          timeoutMs: 10,
          sleep: () => Promise.resolve(),
          now: () => (clock += 100),
        }),
      ),
    ).toMatch(/never authenticated/);
    expect(fs.existsSync(pinned)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// The spec says the expiry rewrite is the driver's first act on the box. Until
// the read-back succeeds the box holds a key with no ceiling, so every command
// issued before it is a command issued under an unbounded key. A clock read is
// harmless in itself, which is exactly why the ordering has to be asserted
// rather than trusted.
describe("first-contact ordering", () => {
  test("the expiry rewrite is the FIRST remote command, before any clock read", async () => {
    const expiresAt = new Date(Date.UTC(2026, 7, 10, 6, 0, 0));
    const expiry = formatExpiry(expiresAt);
    const exec = new FakeExec([
      {
        code: 0,
        stdout: `RESULT: ok\nREADBACK: expiry-time="${expiry}" ${KEY.algorithm} ${KEY.blob} isomux-cp\n`,
        stderr: "",
      },
      clockReply,
    ]);
    await rewriteKeyWithExpiry(
      new SshClient(target, exec),
      identityFor("root"),
      KEY,
      expiresAt,
    );
    expect(exec.calls).toHaveLength(2);
    // First call carries the rewrite script and our expiry as an argument.
    expect(exec.calls[0]?.stdin).toContain("RESULT: key-not-present");
    expect(exec.calls[0]?.argv).toContain(expiry);
    // The clock comes after, and nothing else came before.
    expect(exec.calls[1]?.stdin).toContain("date -u");
  });

  test("a failed rewrite means no further remote command runs at all", async () => {
    const exec = new FakeExec([
      {
        code: 1,
        stdout: "RESULT: key-not-present (exact matches: 0)\n",
        stderr: "",
      },
    ]);
    await captureError(() =>
      rewriteKeyWithExpiry(
        new SshClient(target, exec),
        identityFor("root"),
        KEY,
        new Date(Date.UTC(2026, 7, 10)),
      ),
    );
    expect(exec.calls).toHaveLength(1);
  });
});

// `systemctl enable --now` exiting 0 says the command was accepted, not that a
// timer is loaded, active, persistent and pointed at our instant. R7 gates the
// scratch-key work on this, so it is parsed rather than assumed.
describe("timer evidence", () => {
  const WANTED = "2026-08-09 16:34:07 UTC";
  const armed = [
    "UnitFileState=enabled",
    "ActiveState=active",
    "Persistent=yes",
    "NextElapseUSecRealtime=Sun 2026-08-09 16:34:07 UTC",
    `TimersCalendar={ OnCalendar=${WANTED} ; next_elapse=Sun 2026-08-09 16:34:07 UTC }`,
  ].join("\n");

  test("reads systemd's own answer, including the loaded OnCalendar", () => {
    const ev = parseTimerEvidence(armed);
    expect(ev).toEqual({
      enabled: true,
      active: true,
      persistent: true,
      nextElapseUtc: "Sun 2026-08-09 16:34:07 UTC",
      onCalendar: WANTED,
    });
    expect(timerIsArmed(ev, WANTED)).toBe(true);
  });

  // THE ONE THAT MATTERS. A leftover timer from an earlier run is enabled,
  // active and persistent - it satisfies every check except the only one that
  // says which deadline it enforces. Accepting it would unlock the scratch-key
  // tests against a ceiling that is not ours.
  test("a stale timer for a DIFFERENT deadline is not armed for us", () => {
    // Replace the LOADED SPEC only. A naive string replace hits
    // NextElapseUSecRealtime first and leaves OnCalendar alone, which is a test
    // that cannot fail - it caught me once.
    const stale = armed
      .split("\n")
      .map((l) =>
        l.startsWith("TimersCalendar")
          ? "TimersCalendar={ OnCalendar=2026-08-09 09:00:00 UTC ; next_elapse=Sun 2026-08-09 09:00:00 UTC }"
          : l,
      )
      .join("\n");
    const ev = parseTimerEvidence(stale);
    expect(ev.enabled && ev.active && ev.persistent).toBe(true);
    expect(ev.nextElapseUtc).not.toBe("");
    expect(timerIsArmed(ev, WANTED)).toBe(false);
  });

  test("an absent OnCalendar cannot pass, and neither can an absent expectation", () => {
    const noCal = armed
      .split("\n")
      .filter((l) => !l.startsWith("TimersCalendar"))
      .join("\n");
    expect(timerIsArmed(parseTimerEvidence(noCal), WANTED)).toBe(false);
    expect(timerIsArmed(parseTimerEvidence(armed), "")).toBe(false);
  });

  test.each([
    ["UnitFileState=disabled"],
    ["ActiveState=inactive"],
    ["Persistent=no"],
    ["NextElapseUSecRealtime="],
  ])("%s is NOT armed", (override) => {
    const key = override.split("=")[0];
    const text = armed
      .split("\n")
      .map((l) => (l.startsWith(`${key}=`) ? override : l))
      .join("\n");
    expect(timerIsArmed(parseTimerEvidence(text), WANTED)).toBe(false);
  });

  test("output that says nothing at all is not armed", () => {
    expect(timerIsArmed(parseTimerEvidence(""), WANTED)).toBe(false);
  });

  test("the recorded expiry renders back to the OnCalendar we armed", () => {
    // So a later command can re-check the timer without trusting a second copy
    // of the instant.
    expect(onCalendarFromExpiry("20260809163407Z")).toBe(WANTED);
    expect(onCalendarFromExpiry("nonsense")).toBe("");
  });
});
