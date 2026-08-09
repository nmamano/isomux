// The poll-once handlers, against a fake process seam.
//
// A live run cannot be made to crash between two chosen instructions on demand,
// which is exactly where the interesting behaviour is: the installer's
// persisted-runId-before-launch ordering, the known_hosts remove-then-record
// ordering, and the rule that a tick result about somebody else's generation is
// never our verdict.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mintInviteHandler,
  runInstallerHandler,
  waitForPackageManagerHandler,
  waitForSshHandler,
  type HandlerDeps,
} from "./handlers.ts";
import { Reporter, type Sink } from "./report.ts";
import { saveRun, type RunRecord } from "./run-record.ts";
import { Store } from "./store.ts";
import type { ExecResult, Exec, ExecOptions } from "./ssh.ts";
import { RemoteBudget, type HandlerContext } from "./tick.ts";

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-handlers-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class FakeExec implements Exec {
  readonly calls: { argv: string[]; stdin?: string }[] = [];
  constructor(
    private readonly responder: (
      argv: string[],
      stdin?: string,
    ) => ExecResult | Promise<ExecResult>,
  ) {}
  async run(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ argv, stdin: opts?.stdin });
    return this.responder(argv, opts?.stdin);
  }
}

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

interface Bed {
  dir: string;
  store: Store;
  deps: HandlerDeps;
  lines: string[];
  reporter: Reporter;
  rec: RunRecord;
  audits: string[];
  ctx(evidence: unknown, budget?: RemoteBudget): HandlerContext;
}

function bed(exec: Exec): Bed {
  const dir = tempDir();
  const store = new Store(path.join(dir, "cp.db"));
  const lines: string[] = [];
  const audits: string[] = [];
  const sink: Sink = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  };
  const reporter = new Reporter(sink);
  const rec: RunRecord = {
    runId: "run-1",
    state: "reachable",
    host: "cp1.test.isomux.app",
    instanceId: "203474835",
    ipv4: "169.58.97.2",
    loginUser: "root",
    privateKeyPath: path.join(dir, "key"),
    publicKeyPath: path.join(dir, "key.pub"),
    algorithm: "ssh-ed25519",
    blob: "AAAAC3NzaC1lZDI1NTE5AAAAITESTBLOB",
    knownHostsFile: path.join(dir, "run-1.known_hosts"),
    expiry: "20260809180423Z",
  };
  saveRun(dir, rec);
  const installer = path.join(dir, "install.sh");
  fs.writeFileSync(installer, "#!/bin/bash\necho installer\n");
  store.createInstance({
    id: "inst-1",
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal: "live",
    access_window_expires_at: Date.parse("2026-08-09T18:04:23Z"),
  });
  const deps: HandlerDeps = {
    exec,
    reporter,
    runsDir: dir,
    keysDir: dir,
    installerPath: installer,
  };
  return {
    dir,
    store,
    deps,
    lines,
    reporter,
    rec,
    audits,
    ctx(evidence: unknown, budget?: RemoteBudget): HandlerContext {
      const nonce = Math.random().toString(36).slice(2);
      const op = store.enqueue({
        id: `op-${nonce}`,
        instance_id: "inst-1",
        // Unique per context: the one-active index is real, and these fakes are
        // exercising handlers rather than the chain.
        kind: `scratch-${nonce}`,
        inactivity_deadline_at: 0,
        absolute_deadline_at: 0,
        evidence,
      });
      // Leased, because that is what a handler always receives - and the mint
      // now writes through its fence, which an unleased row would refuse.
      const leased = store.tryLease(
        op.id,
        op.version,
        "holder-a",
        Date.now() + 300_000,
        Date.now(),
      )!;
      return {
        store,
        op: leased,
        instance: store.getInstance("inst-1")!,
        asset: null,
        fence: { id: leased.id, version: leased.version, holder: "holder-a" },
        budget:
          budget ??
          new RemoteBudget(Date.now() + 60_000, Date.now() + 300_000, () =>
            Date.now(),
          ),
        now: 1_000_000,
        report: (l) => lines.push(l),
        audit: (action, outcome, detail) => {
          audits.push(`${action}:${outcome}${detail ? `:${detail}` : ""}`);
        },
      };
    },
  };
}

describe("wait_for_ssh", () => {
  test("removes the pin FIRST and records that it did SECOND", async () => {
    const exec = new FakeExec(() => OK);
    const b = bed(exec);
    fs.writeFileSync(b.rec.knownHostsFile, "stale pin from a previous life\n");
    const result = await waitForSshHandler(b.deps).run(b.ctx({}));
    // The removal has happened; the evidence recording it is only now being
    // returned. A crash here repeats a harmless removal - the other order could
    // skip it and leave the stale pin in place.
    expect(fs.existsSync(b.rec.knownHostsFile)).toBe(false);
    expect(exec.calls).toHaveLength(0);
    expect(result).toMatchObject({ kind: "progress" });
    expect(
      (result as { evidence: { pinReset: boolean } }).evidence.pinReset,
    ).toBe(true);
  });

  test("promotes only the probe that authenticated", async () => {
    const exec = new FakeExec((argv) => {
      // Emulate accept-new: ssh writes the host key when it connects.
      const kh = argv
        .find((a) => a.startsWith("UserKnownHostsFile="))
        ?.slice("UserKnownHostsFile=".length);
      if (kh) fs.writeFileSync(kh, "169.58.97.2 ssh-ed25519 AAAAHOSTKEY\n");
      return OK;
    });
    const b = bed(exec);
    const result = await waitForSshHandler(b.deps).run(
      b.ctx({ pinReset: true, probes: 0 }),
    );
    expect(result.kind).toBe("done");
    expect(fs.readFileSync(b.rec.knownHostsFile, "utf8")).toContain(
      "AAAAHOSTKEY",
    );
  });

  test("a probe that did not authenticate leaves no pin behind", async () => {
    const exec = new FakeExec((argv) => {
      const kh = argv
        .find((a) => a.startsWith("UserKnownHostsFile="))
        ?.slice("UserKnownHostsFile=".length);
      if (kh) fs.writeFileSync(kh, "the box being destroyed\n");
      return { code: 255, stdout: "", stderr: "Connection timed out" };
    });
    const b = bed(exec);
    const result = await waitForSshHandler(b.deps).run(
      b.ctx({ pinReset: true, probes: 0 }),
    );
    expect(result.kind).toBe("progress");
    expect(fs.existsSync(b.rec.knownHostsFile)).toBe(false);
    expect(
      fs.readdirSync(b.dir).filter((f) => f.includes("known_hosts")),
    ).toEqual([]);
  });
});

describe("wait_for_package_manager", () => {
  test("asks for one check, not a loop, and carries the reason as evidence", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: "RESULT: busy (kernel lock on /var/lib/dpkg/lock-frontend)\n",
      stderr: "",
    }));
    const b = bed(exec);
    const result = await waitForPackageManagerHandler(b.deps).run(b.ctx({}));
    expect(exec.calls[0]?.argv).toContain("once");
    expect(result).toMatchObject({ kind: "progress" });
    // Same reason next time: still busy, but no new evidence, so the inactivity
    // deadline is allowed to run down.
    const again = await waitForPackageManagerHandler(b.deps).run(
      b.ctx({
        busy: "RESULT: busy (kernel lock on /var/lib/dpkg/lock-frontend)",
      }),
    );
    expect(again.kind).toBe("waiting");
  });

  test("ready ends the operation", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: "RESULT: ready\n",
      stderr: "",
    }));
    const b = bed(exec);
    expect(
      (await waitForPackageManagerHandler(b.deps).run(b.ctx({}))).kind,
    ).toBe("done");
  });
});

describe("run_installer", () => {
  function installerExec(tickOut: string, launchOut = "") {
    return new FakeExec((argv, stdin) => {
      // A file upload runs `install -m ... /dev/stdin <path>` as the remote
      // command; the wrapper's launch and tick arrive as script bodies.
      if (argv.includes("install")) return OK;
      if (stdin?.includes(" launch ")) {
        return { code: 0, stdout: launchOut, stderr: "" };
      }
      if (stdin?.includes(" tick")) {
        return { code: 0, stdout: tickOut, stderr: "" };
      }
      return OK;
    });
  }

  test("staging does not launch anything", async () => {
    const exec = installerExec("state=none");
    const b = bed(exec);
    const result = await runInstallerHandler(b.deps).run(b.ctx({}));
    expect((result as { evidence: { phase: string } }).evidence.phase).toBe(
      "staged",
    );
    // Every remote call this phase makes is a file upload. Matching on the
    // stdin text would not do: the wrapper's own source contains the word
    // "launch", and it travels as the payload of an upload.
    expect(exec.calls.every((c) => c.argv.includes("install"))).toBe(true);
  });

  test("the runId is persisted BEFORE any launch is issued", async () => {
    const exec = installerExec("state=none");
    const b = bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      b.ctx({ phase: "staged", attempts: [] }),
    );
    const ev = (result as { evidence: { phase: string; runId: string } })
      .evidence;
    expect(ev.phase).toBe("launching");
    expect(ev.runId).toBeTruthy();
    // Nothing remote happened on the tick that allocated it. A crash here leaves
    // a runId and no generation, which the next tick resolves by ticking.
    expect(exec.calls).toHaveLength(0);
  });

  test("a crash after the launch is resolved by the wrapper, not by a second installer", async () => {
    // The box already has the generation: our launch DID reach it before we
    // died, and the wrapper says so rather than starting a second run.
    const exec = installerExec(
      "state=none",
      "FAILED generation install-1 already exists",
    );
    const b = bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      b.ctx({ phase: "launching", runId: "install-1", attempts: [] }),
    );
    const ev = (result as { evidence: { phase: string; runId: string } })
      .evidence;
    expect(ev.phase).toBe("running");
    expect(ev.runId).toBe("install-1");
    const launches = exec.calls.filter((c) => c.stdin?.includes("launch"));
    expect(launches).toHaveLength(1);
  });

  test("an unconfirmed launch is never relaunched", async () => {
    const exec = installerExec(
      "state=none",
      "UNCONFIRMED publication timed out; resolve with tick, do not relaunch",
    );
    const b = bed(exec);
    const first = await runInstallerHandler(b.deps).run(
      b.ctx({ phase: "launching", runId: "install-1", attempts: [] }),
    );
    expect((first as { evidence: { phase: string } }).evidence.phase).toBe(
      "awaiting_publication",
    );

    const exec2 = installerExec("state=none");
    const b2 = bed(exec2);
    const second = await runInstallerHandler(b2.deps).run(
      b2.ctx({
        phase: "awaiting_publication",
        runId: "install-1",
        attempts: [],
      }),
    );
    expect(second.kind).toBe("waiting");
    expect(exec2.calls.some((c) => c.stdin?.includes("launch"))).toBe(false);
  });

  test("a tick about another generation is never our verdict", async () => {
    const exec = installerExec(
      "state=finished runId=install-OTHER exit=0 step=done",
    );
    const b = bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      b.ctx({ phase: "running", runId: "install-1", attempts: [] }),
    );
    expect(result.kind).toBe("ambiguous");
    expect((result as { reason: string }).reason).toMatch(/not ours/);
  });

  test("a crashed predecessor left in `current` does not block the retry's launch", async () => {
    // Live case, 2026-08-09: after a crash the box's `current` still points at
    // the DEAD generation. Treating that as "not our verdict" and stopping would
    // wedge the retry forever - our generation has simply not published yet, and
    // the wrapper is what decides whether launching it is safe.
    const exec = installerExec(
      "state=crashed runId=install-OLD step=install-browser",
      "CONFIRMED install-NEW",
    );
    const b = bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      b.ctx({ phase: "launching", runId: "install-NEW", attempts: [] }),
    );
    const ev = (result as { evidence: { phase: string; runId: string } })
      .evidence;
    expect(ev.phase).toBe("running");
    expect(ev.runId).toBe("install-NEW");
    expect(
      exec.calls.filter((c) => c.stdin?.includes(" launch ")),
    ).toHaveLength(1);
  });

  test("exit 0 on OUR generation finishes it", async () => {
    const exec = installerExec(
      "state=finished runId=install-1 exit=0 step=assert-hardening",
    );
    const b = bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      b.ctx({ phase: "running", runId: "install-1", attempts: [] }),
    );
    expect(result.kind).toBe("done");
  });

  test("a crashed generation re-stages, so the retry allocates a FRESH runId", async () => {
    const exec = installerExec(
      "state=crashed runId=install-1 step=install-browser",
    );
    const b = bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      b.ctx({ phase: "running", runId: "install-1", attempts: [] }),
    );
    expect(result.kind).toBe("retry");
    const ev = (result as { evidence: { phase: string; attempts: unknown[] } })
      .evidence;
    expect(ev.phase).toBe("staged");
    // The old generation's verdict is archived, not overwritten.
    expect(ev.attempts).toEqual([
      { runId: "install-1", verdict: "crashed", step: "install-browser" },
    ]);
  });
});

describe("mint_invite", () => {
  const URL = "https://cp1.test.isomux.app/i/abc123secret";

  test("the URL reaches the operator and nothing durable", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: `${URL}\n`,
      stderr: "",
    }));
    const b = bed(exec);
    const ctx = b.ctx({ phase: "minting" });
    const result = await mintInviteHandler(b.deps).run(ctx);
    expect(result.kind).toBe("done");
    expect(b.lines.join("\n")).toContain(URL);

    // Not in the evidence, not in any audit row, not in the redacted transcript.
    expect(
      JSON.stringify((result as { evidence: unknown }).evidence),
    ).not.toContain("abc123secret");
    b.store.tx(() =>
      b.store.appendAudit({
        actor: "t",
        instance_id: "inst-1",
        action: "mint_invite",
        target: "cp1.test.isomux.app",
        outcome: "succeeded",
        detail: null,
      }),
    );
    expect(JSON.stringify(b.store.auditEvents())).not.toContain("abc123secret");
    expect(b.reporter.transcript.join("\n")).not.toContain("abc123secret");
  });

  test("a re-mint tells the operator the earlier link is dead", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: `${URL}\n`,
      stderr: "",
    }));
    const b = bed(exec);
    await mintInviteHandler(b.deps).run(
      b.ctx({ phase: "minting", minted: true }),
    );
    expect(b.lines.join("\n")).toContain(
      "the invite printed earlier is no longer valid; use this one",
    );
  });

  test("a failure carries no remote output", async () => {
    const exec = new FakeExec(() => ({
      code: 1,
      stdout: URL,
      stderr: `failed after ${URL}`,
    }));
    const b = bed(exec);
    const result = await mintInviteHandler(b.deps).run(
      b.ctx({ phase: "minting" }),
    );
    expect(result.kind).toBe("retry");
    expect((result as { reason: string }).reason).toBe(
      "minting the invite failed",
    );
  });
});

describe("mint_invite after an unrecorded attempt", () => {
  const URL2 = "https://cp1.test.isomux.app/i/second-link";

  test("the NORMAL path: one invocation, one link, no warning", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: `${URL2}\n`,
      stderr: "",
    }));
    const b = bed(exec);
    const ctx = b.ctx({});
    const result = await mintInviteHandler(b.deps).run(ctx);
    expect(result.kind).toBe("done");
    // The marker was persisted through the fence in THIS invocation...
    const after = b.store.getOperation(ctx.op.id)!;
    expect(after.version).toBeGreaterThan(ctx.op.version);
    // ...and the mint happened in the same one, so the operator sees exactly
    // one link and is told nothing about a link that never existed.
    const printed = b.lines.filter((l) => l.includes(URL2));
    expect(printed).toHaveLength(1);
    expect(b.lines.join("\n")).not.toContain("no longer valid");
  });

  test("killed between printing and recording: the remint WARNS", async () => {
    // The crash the reviewer described. The durable state at that instant is
    // exactly {phase:"minting"} with attempt=0 - the intent recorded, the
    // outcome not - and a link is already in the operator's hands. Only an
    // invocation that ENTERS with the marker is recovery.
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: `${URL2}\n`,
      stderr: "",
    }));
    const b = bed(exec);
    const ctx = b.ctx({ phase: "minting" });
    expect(ctx.op.attempt).toBe(0);
    await mintInviteHandler(b.deps).run(ctx);
    expect(b.lines.join("\n")).toContain(
      "the invite printed earlier is no longer valid; use this one",
    );
    expect(b.lines.filter((l) => l.includes(URL2))).toHaveLength(1);
  });
});

describe("every ssh child is recorded", () => {
  test("a step that issues two commands leaves two started/outcome pairs", async () => {
    const exec = new FakeExec(() => OK);
    const b = bed(exec);
    const ctx = b.ctx({ pinReset: true, probes: 0 });
    // wait_for_package_manager runs one child; arm_revocation's unit install
    // runs two. Drive the two-child shape directly through a labelled client.
    const { SshClient } = await import("./ssh.ts");
    const ssh = new SshClient(
      {
        host: "h",
        user: "root",
        identityFile: "/tmp/k",
        knownHostsFile: "/tmp/kh",
      },
      exec,
      "yes",
      undefined,
      (phase, kind) => ctx.audit("install_cleanup_units", phase, kind),
    );
    await ssh.script("true\n");
    await ssh.script("true\n");
    expect(b.audits).toEqual([
      "install_cleanup_units:started:script",
      "install_cleanup_units:succeeded:script",
      "install_cleanup_units:started:script",
      "install_cleanup_units:succeeded:script",
    ]);
  });

  test("a timeout is recorded as ambiguous, never as failed", async () => {
    const { RemoteTimeoutError, SshClient } = await import("./ssh.ts");
    const exec = new FakeExec(() => {
      throw new RemoteTimeoutError("killed");
    });
    const b = bed(exec);
    const ctx = b.ctx({});
    const ssh = new SshClient(
      {
        host: "h",
        user: "root",
        identityFile: "/tmp/k",
        knownHostsFile: "/tmp/kh",
      },
      exec,
      "yes",
      undefined,
      (phase, kind) => ctx.audit("revoke_key", phase, kind),
    );
    try {
      await ssh.script("true\n");
    } catch {
      // expected
    }
    // "failed" would be a claim that nothing happened on the box, and a killed
    // child has not earned it.
    expect(b.audits).toEqual([
      "revoke_key:started:script",
      "revoke_key:ambiguous:script",
    ]);
  });

  test("a call whose recording fails is recorded as ambiguous too", async () => {
    const exec = new FakeExec(() => OK);
    const b = bed(exec);
    const ctx = b.ctx({});
    const { SshClient } = await import("./ssh.ts");
    let firstSucceeded = true;
    const ssh = new SshClient(
      {
        host: "h",
        user: "root",
        identityFile: "/tmp/k",
        knownHostsFile: "/tmp/kh",
      },
      exec,
      "yes",
      undefined,
      (phase, kind) => {
        if (phase === "succeeded" && firstSucceeded) {
          firstSucceeded = false;
          throw new Error("disk full");
        }
        ctx.audit("mint_invite", phase, kind);
      },
    );
    try {
      await ssh.script("true\n");
    } catch {
      // expected
    }
    expect(b.audits).toEqual([
      "mint_invite:started:script",
      "mint_invite:ambiguous:script",
    ]);
  });

  test("a child whose recording fails reports the call as unrecorded, not failed", async () => {
    const exec = new FakeExec(() => OK);
    const b = bed(exec);
    const ctx = b.ctx({});
    const { ObserverWriteFailed, SshClient } = await import("./ssh.ts");
    const ssh = new SshClient(
      {
        host: "h",
        user: "root",
        identityFile: "/tmp/k",
        knownHostsFile: "/tmp/kh",
      },
      exec,
      "yes",
      undefined,
      (phase) => {
        if (phase === "succeeded") throw new Error("disk full");
      },
    );
    let thrown: unknown;
    try {
      await ssh.script("true\n");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ObserverWriteFailed);
    void ctx;
  });
});
