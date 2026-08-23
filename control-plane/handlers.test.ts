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
  firstContactHandler,
  mintInviteHandler,
  installCustomerKeyHandler,
  revokeAccessHandler,
  runInstallerHandler,
  setDnsHandler,
  verifyHttpsHandler,
  waitForPackageManagerHandler,
  waitForAddressHandler,
  waitForSshHandler,
  type HandlerDeps,
} from "./handlers.ts";
import { Reporter, type Sink } from "./report.ts";
import { saveRun, type RunRecord } from "./run-record.ts";
import { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import type { ExecResult, Exec, ExecOptions } from "./ssh.ts";
import { RemoteBudget, Ticker, type HandlerContext } from "./tick.ts";
import { raiseAttentionIn } from "./attention.ts";

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-handlers-"));
  temps.push(dir);
  return dir;
}

describe("wait_for_address", () => {
  test("writes provider truth to the asset and its prepared run mirror", async () => {
    const b = await bed(new FakeExec(() => OK));
    await b.store.sqlRun(
      "update provider_assets set ipv4=null where id='asset-1'",
    );
    saveRun(b.dir, {
      ...b.rec,
      state: "prepared",
      instanceId: "203474835",
      ipv4: null,
    });
    const result = await waitForAddressHandler({
      ...b.deps,
      getCreatedAsset: async () => ({
        assetState: "active",
        powerState: "running",
        ipv4: "169.58.97.9",
        raw: null,
      }),
    }).run(await b.ctx({}));
    expect(result.kind).toBe("done");
    expect((await b.store.assetForInstance("inst-1"))?.ipv4).toBe(
      "169.58.97.9",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(b.dir, "run-1.json"), "utf8")),
    ).toMatchObject({
      state: "reachable",
      ipv4: "169.58.97.9",
    });
  });
});

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

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

function validKey(): string {
  const name = Buffer.from("ssh-ed25519");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return `ssh-ed25519 ${Buffer.concat([length, name, Buffer.alloc(32, 9)]).toString("base64")}`;
}

interface Bed {
  dir: string;
  store: Store;
  deps: HandlerDeps;
  lines: string[];
  reporter: Reporter;
  rec: RunRecord;
  audits: string[];
  ctx(evidence: unknown, budget?: RemoteBudget): Promise<HandlerContext>;
}

async function bed(exec: Exec): Promise<Bed> {
  const dir = tempDir();
  const store = await openTestStore();
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
  await store.createInstance({
    id: "inst-1",
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal: "live",
    access_window_expires_at: Date.parse("2026-08-09T18:04:23Z"),
  });
  await store.sqlRun(
    "insert into name_reservations (name, id, account_id, instance_id, plan, coupon_id, version, created_at, updated_at) " +
      "values ('cp1', 'reservation-inst-1', 'account-inst-1', 'inst-1', 'monthly', null, 1, $1, $1)",
    [store.now()],
  );
  await store.createAsset({
    id: "asset-1",
    instance_id: "inst-1",
    provider: "contabo",
    provider_id: "203474835",
    intent_id: null,
    asset_state: "active",
    ipv4: "169.58.97.2",
    service_ends_at: null,
    host_key_fingerprint: null,
    next_reconcile_at: 0,
  });
  const deps: HandlerDeps = {
    exec,
    reporter,
    runsDir: dir,
    keysDir: dir,
    installerPath: installer,
    certificateEndpoint:
      "https://certificates.test/internal/certificates/renew",
  };
  return {
    dir,
    store,
    deps,
    lines,
    reporter,
    rec,
    audits,
    async ctx(
      evidence: unknown,
      budget?: RemoteBudget,
    ): Promise<HandlerContext> {
      const nonce = Math.random().toString(36).slice(2);
      const op = await store.enqueue({
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
      const leased = (await store.tryLease(
        op.id,
        op.version,
        "holder-a",
        Date.now() + 300_000,
        Date.now(),
      ))!;
      return {
        store,
        op: leased,
        instance: (await store.getInstance("inst-1"))!,
        asset: await store.getAsset("asset-1"),
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
          return Promise.resolve();
        },
      };
    },
  };
}

describe("wait_for_ssh", () => {
  test("removes the pin FIRST and records that it did SECOND", async () => {
    const exec = new FakeExec(() => OK);
    const b = await bed(exec);
    fs.writeFileSync(b.rec.knownHostsFile, "stale pin from a previous life\n");
    const result = await waitForSshHandler(b.deps).run(await b.ctx({}));
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
    const b = await bed(exec);
    const result = await waitForSshHandler(b.deps).run(
      await b.ctx({ pinReset: true, probes: 0 }),
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
    const b = await bed(exec);
    const result = await waitForSshHandler(b.deps).run(
      await b.ctx({ pinReset: true, probes: 0 }),
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
    const b = await bed(exec);
    const result = await waitForPackageManagerHandler(b.deps).run(
      await b.ctx({}),
    );
    expect(exec.calls[0]?.argv).toContain("once");
    expect(result).toMatchObject({ kind: "progress" });
    // Same reason next time: still busy, but no new evidence, so the inactivity
    // deadline is allowed to run down.
    const again = await waitForPackageManagerHandler(b.deps).run(
      await b.ctx({
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
    const b = await bed(exec);
    expect(
      (await waitForPackageManagerHandler(b.deps).run(await b.ctx({}))).kind,
    ).toBe("done");
  });
});

describe("first_contact", () => {
  test("refuses an existing prelaunch ceiling over seven days before touching the box", async () => {
    const exec = new FakeExec(() => OK);
    const b = await bed(exec);
    const instance = (await b.store.getInstance("inst-1"))!;
    await b.store.sqlRun(
      "update instances set access_window_expires_at = $1 where id = $2",
      [instance.created_at + 30 * 24 * 60 * 60 * 1000, instance.id],
    );
    const result = await firstContactHandler(b.deps).run(await b.ctx({}));
    expect(result).toMatchObject({ kind: "fatal" });
    expect((result as { reason: string }).reason).toContain(
      "delete and recreate",
    );
    expect(exec.calls).toHaveLength(0);
  });
});

describe("install_customer_key", () => {
  test("a skipped key completes without touching the box", async () => {
    const exec = new FakeExec(() => OK);
    const b = await bed(exec);
    const result = await installCustomerKeyHandler(b.deps).run(await b.ctx({}));
    expect(result).toEqual({ kind: "done", evidence: { skipped: true } });
    expect(exec.calls).toHaveLength(0);
    expect((await b.store.getInstance("inst-1"))?.ssh_login_user).toBe("root");
  });

  test("installs, records the fingerprint, and retains the key until revocation", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: "RESULT: customer key installed\n",
      stderr: "",
    }));
    const b = await bed(exec);
    const before = (await b.store.getInstance("inst-1"))!;
    await b.store.casInstance(before.id, before.version, {
      customer_ssh_key: validKey(),
    });
    const result = await installCustomerKeyHandler(b.deps).run(await b.ctx({}));
    expect(result).toEqual({
      kind: "done",
      evidence: { installed: true, line: "added" },
    });
    const after = await b.store.getInstance("inst-1");
    expect(after?.customer_ssh_key).toBe(validKey());
    expect(after?.customer_ssh_key_fingerprint).toStartWith("SHA256:");
    expect(
      b.audits.find((line) => line.startsWith("install_customer_ssh_key:")),
    ).toStartWith("install_customer_ssh_key:succeeded:SHA256:");
  });
});

describe("revoke_access", () => {
  test("clears the stored key only after removal is proven", async () => {
    const exec = new FakeExec((argv, stdin) =>
      stdin?.includes("RESULT: removed")
        ? {
            code: 0,
            stdout: "RESULT: removed\nCUSTOMER-KEY: present\n",
            stderr: "",
          }
        : { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    );
    const b = await bed(exec);
    fs.writeFileSync(b.rec.privateKeyPath, "private");
    fs.writeFileSync(b.rec.publicKeyPath, "public");
    const before = (await b.store.getInstance("inst-1"))!;
    await b.store.casInstance(before.id, before.version, {
      customer_ssh_key: validKey(),
      customer_ssh_key_fingerprint: "SHA256:test",
      ssh_login_user: "root",
    });
    const result = await revokeAccessHandler(b.deps).run(await b.ctx({}));
    expect(result).toEqual({
      kind: "done",
      evidence: { proven: true, customerKey: "present" },
    });
    const after = await b.store.getInstance("inst-1");
    expect(after?.customer_ssh_key).toBeNull();
    expect(after?.customer_ssh_key_fingerprint).toBe("SHA256:test");
    expect(fs.existsSync(b.rec.privateKeyPath)).toBe(false);
  });

  test("re-reads and retries once when the instance CAS loses", async () => {
    const exec = new FakeExec((argv, stdin) =>
      stdin?.includes("RESULT: removed")
        ? {
            code: 0,
            stdout: "RESULT: removed\nCUSTOMER-KEY: present\n",
            stderr: "",
          }
        : { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    );
    const b = await bed(exec);
    fs.writeFileSync(b.rec.privateKeyPath, "private");
    fs.writeFileSync(b.rec.publicKeyPath, "public");
    const before = (await b.store.getInstance("inst-1"))!;
    await b.store.casInstance(before.id, before.version, {
      customer_ssh_key: validKey(),
    });
    const realCas = b.store.casInstance.bind(b.store);
    let calls = 0;
    b.store.casInstance = async (...args) => {
      calls++;
      return calls === 1 ? null : realCas(...args);
    };
    const result = await revokeAccessHandler(b.deps).run(await b.ctx({}));
    expect(result.kind).toBe("done");
    expect(calls).toBe(2);
    expect((await b.store.getInstance("inst-1"))?.customer_ssh_key).toBeNull();
    expect(fs.existsSync(b.rec.privateKeyPath)).toBe(false);
  });

  test("destroys our private key even when both clearing CAS attempts lose", async () => {
    const exec = new FakeExec((argv, stdin) =>
      stdin?.includes("RESULT: removed")
        ? { code: 0, stdout: "RESULT: removed\n", stderr: "" }
        : { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    );
    const b = await bed(exec);
    fs.writeFileSync(b.rec.privateKeyPath, "private");
    fs.writeFileSync(b.rec.publicKeyPath, "public");
    b.store.casInstance = async () => null;
    const result = await revokeAccessHandler(b.deps).run(await b.ctx({}));
    expect(result.kind).toBe("ambiguous");
    expect(fs.existsSync(b.rec.privateKeyPath)).toBe(false);
  });

  test("a missing customer key raises attention but does not block revocation", async () => {
    const exec = new FakeExec((argv, stdin) =>
      stdin?.includes("RESULT: removed")
        ? {
            code: 0,
            stdout: "RESULT: removed\nCUSTOMER-KEY: missing\n",
            stderr: "",
          }
        : { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    );
    const b = await bed(exec);
    fs.writeFileSync(b.rec.privateKeyPath, "private");
    fs.writeFileSync(b.rec.publicKeyPath, "public");
    const before = (await b.store.getInstance("inst-1"))!;
    await b.store.casInstance(before.id, before.version, {
      customer_ssh_key: validKey(),
    });
    const result = await revokeAccessHandler(b.deps).run(await b.ctx({}));
    expect(result).toEqual({
      kind: "done",
      evidence: { proven: true, customerKey: "missing" },
    });
    expect(await b.store.openReasons("inst-1")).toHaveLength(1);
    expect((await b.store.getInstance("inst-1"))?.customer_ssh_key).toBeNull();
  });

  test("the tick leaves the instance-level missing-key warning open", async () => {
    const exec = new FakeExec((argv, stdin) =>
      stdin?.includes("RESULT: removed")
        ? {
            code: 0,
            stdout: "RESULT: removed\nCUSTOMER-KEY: missing\n",
            stderr: "",
          }
        : { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    );
    const b = await bed(exec);
    fs.writeFileSync(b.rec.privateKeyPath, "private");
    fs.writeFileSync(b.rec.publicKeyPath, "public");
    const before = (await b.store.getInstance("inst-1"))!;
    await b.store.casInstance(before.id, before.version, {
      customer_ssh_key: validKey(),
    });
    const ticker = new Ticker({
      store: b.store,
      handlers: [revokeAccessHandler(b.deps)],
      holder: "tick-holder",
    });
    await ticker.enqueue("inst-1", "revoke_access");
    await ticker.once();
    const reasons = await b.store.openReasons("inst-1");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.source_op_id).toBe("");
    expect(reasons[0]?.reason).toContain("customer's SSH key changed");
    const audits = await b.store.auditEvents();
    expect(
      audits.some((row) => row.action === "observe_customer_ssh_key"),
    ).toBe(true);
  });
});

describe("set_dns owns the office and wildcard A records", () => {
  test("retries without an address because reconcile is its only source", async () => {
    const b = await bed(new FakeExec(() => OK));
    await b.store.sqlRun(
      "update provider_assets set ipv4 = null where instance_id = 'inst-1'",
    );
    const result = await setDnsHandler(b.deps).run(await b.ctx({}));
    expect(result).toEqual({
      kind: "retry",
      reason: "the instance has no IPv4 address to set office DNS against",
    });
  });

  test("a missing writer raises attention and retries instead of doing nothing", async () => {
    const b = await bed(new FakeExec(() => OK));
    const result = await setDnsHandler(b.deps).run(await b.ctx({}));
    expect(result.kind).toBe("retry");
    expect((await b.store.openReasons("inst-1"))[0]?.reason).toBe(
      "the Cloudflare office DNS writer is not configured",
    );
  });

  test("success clears the missing-writer attention and audits the resolution", async () => {
    const b = await bed(new FakeExec(() => OK));
    const ctx = await b.ctx({});
    await setDnsHandler(b.deps).run(ctx);
    expect(await b.store.openReasons("inst-1")).toHaveLength(1);
    const result = await setDnsHandler({
      ...b.deps,
      officeDns: {
        officeARecords: async () => [],
        removeOfficeARecords: async () => true,
        replaceOfficeARecords: async () => {},
      },
    }).run(ctx);
    expect(result.kind).toBe("done");
    expect(await b.store.openReasons("inst-1")).toHaveLength(0);
    expect(
      (await b.store.auditEvents()).some(
        (event) => event.action === "clear_attention",
      ),
    ).toBe(true);
  });

  test("replaces both exact names with the reconciled asset address", async () => {
    const b = await bed(new FakeExec(() => OK));
    const calls: unknown[] = [];
    const result = await setDnsHandler({
      ...b.deps,
      officeDns: {
        officeARecords: async () => [],
        removeOfficeARecords: async () => true,
        replaceOfficeARecords: async (...args) => {
          calls.push(args);
        },
      },
    }).run(await b.ctx({}));
    expect(result).toMatchObject({
      kind: "done",
      evidence: {
        host: "cp1.test.isomux.app",
        wildcard: "*.cp1.test.isomux.app",
        ipv4: "169.58.97.2",
      },
    });
    expect(calls).toEqual([["cp1.test.isomux.app", "169.58.97.2"]]);
  });
});

describe("verify_https includes app wildcard readiness", () => {
  const dns = (a: string[], aaaa: string[] = []) => ({
    a,
    aaaa,
    absent: a.length === 0 && aaaa.length === 0,
  });

  test("missing, wrong, extra, and IPv6 answers block with one precise attention reason", async () => {
    for (const answer of [
      dns([]),
      dns(["169.58.97.3"]),
      dns(["169.58.97.2", "169.58.97.3"]),
      dns(["169.58.97.2"], ["2001:db8::2"]),
    ]) {
      const b = await bed(new FakeExec(() => OK));
      let livenessCalls = 0;
      const result = await verifyHttpsHandler({
        ...b.deps,
        resolveDns: async () => answer,
        probeHttps: async () => {
          livenessCalls++;
          return { rung: "ok", detail: "ok" };
        },
      }).run(await b.ctx({}));
      expect(result.kind).toBe("progress");
      expect(livenessCalls).toBe(0);
      const open = await b.store.openReasons("inst-1");
      expect(open).toHaveLength(1);
      expect(open[0].reason).toContain(
        "the wildcard DNS record *.cp1.test.isomux.app",
      );
      expect(open[0].reason).toContain("169.58.97.2");
      await b.store.close();
    }
  });

  test("an unchanged refusal waits, while a changed answer is progress", async () => {
    const b = await bed(new FakeExec(() => OK));
    const handler = verifyHttpsHandler({
      ...b.deps,
      resolveDns: async () => dns([]),
      probeHttps: async () => ({ rung: "ok", detail: "ok" }),
    });
    const first = await handler.run(await b.ctx({}));
    const ev = (first as { evidence: unknown }).evidence;
    expect(first.kind).toBe("progress");
    expect((await handler.run(await b.ctx(ev))).kind).toBe("waiting");
    const moved = verifyHttpsHandler({
      ...b.deps,
      resolveDns: async () => dns(["169.58.97.3"]),
      probeHttps: async () => ({ rung: "ok", detail: "ok" }),
    });
    expect((await moved.run(await b.ctx(ev))).kind).toBe("progress");
    await b.store.close();
  });

  test("a resolver failure retries, records the failed read, and never probes HTTPS", async () => {
    const b = await bed(new FakeExec(() => OK));
    let livenessCalls = 0;
    const result = await verifyHttpsHandler({
      ...b.deps,
      resolveDns: async () => {
        throw new Error("SERVFAIL");
      },
      probeHttps: async () => {
        livenessCalls++;
        return { rung: "ok", detail: "ok" };
      },
    }).run(await b.ctx({}));
    expect(result).toMatchObject({ kind: "retry" });
    expect(livenessCalls).toBe(0);
    expect(b.audits).toEqual(["dns_probe:started", "dns_probe:failed"]);
    await b.store.close();
  });

  test("a missing asset address retries without blaming DNS or opening attention", async () => {
    const b = await bed(new FakeExec(() => OK));
    let dnsCalls = 0;
    const ctx = await b.ctx({});
    const result = await verifyHttpsHandler({
      ...b.deps,
      resolveDns: async () => {
        dnsCalls++;
        return dns(["169.58.97.2"]);
      },
    }).run({ ...ctx, asset: null });
    expect(result).toMatchObject({ kind: "retry" });
    expect(dnsCalls).toBe(0);
    expect(await b.store.openReasons("inst-1")).toHaveLength(0);
    await b.store.close();
  });

  test("a correct wildcard clears its reason and advances into the distinct HTTPS rung", async () => {
    const b = await bed(new FakeExec(() => OK));
    const blocked = verifyHttpsHandler({
      ...b.deps,
      resolveDns: async () => dns([]),
      probeHttps: async () => ({ rung: "ok", detail: "ok" }),
    });
    const firstCtx = await b.ctx({});
    const first = await blocked.run(firstCtx);
    expect(first.kind).toBe("progress");
    expect(await b.store.openReasons("inst-1")).toHaveLength(1);
    await b.store.tx(() =>
      raiseAttentionIn(b.store, {
        instanceId: "inst-1",
        sourceOpId: firstCtx.op.id,
        reasonClass: "operation_condition",
        reason:
          "the wildcard DNS record *.cp1.test.isomux.app needs an IPv4 address",
        severity: "warning",
      }),
    );
    expect(await b.store.openReasons("inst-1")).toHaveLength(2);

    const ready = verifyHttpsHandler({
      ...b.deps,
      resolveDns: async () => dns(["169.58.97.2"]),
      probeHttps: async () => ({ rung: "tls", detail: "waiting for TLS" }),
    });
    const result = await ready.run({
      ...firstCtx,
      op: {
        ...firstCtx.op,
        evidence: JSON.stringify((first as { evidence: unknown }).evidence),
      },
    });
    expect(result).toMatchObject({
      kind: "progress",
      evidence: { rung: "tls" },
    });
    expect(await b.store.openReasons("inst-1")).toHaveLength(0);
    await b.store.close();
  });

  test("it completes only after the wildcard and office HTTPS both pass", async () => {
    const b = await bed(new FakeExec(() => OK));
    const result = await verifyHttpsHandler({
      ...b.deps,
      resolveDns: async () => dns(["169.58.97.2"]),
      probeHttps: async () => ({ rung: "ok", detail: "ok" }),
    }).run(await b.ctx({ rung: "tls" }));
    expect(result.kind).toBe("done");
    await b.store.close();
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
    const b = await bed(exec);
    const result = await runInstallerHandler(b.deps).run(await b.ctx({}));
    expect((result as { evidence: { phase: string } }).evidence.phase).toBe(
      "staged",
    );
    // Every remote call this phase makes is a file upload. Matching on the
    // stdin text would not do: the wrapper's own source contains the word
    // "launch", and it travels as the payload of an upload.
    expect(
      exec.calls.every(
        (c) => c.argv.includes("install") || c.stdin?.includes("install -d"),
      ),
    ).toBe(true);
  });

  test("the runId is persisted BEFORE any launch is issued", async () => {
    const exec = installerExec("state=none");
    const b = await bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      await b.ctx({ phase: "staged", attempts: [] }),
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
    const b = await bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      await b.ctx({ phase: "launching", runId: "install-1", attempts: [] }),
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
    const b = await bed(exec);
    const first = await runInstallerHandler(b.deps).run(
      await b.ctx({ phase: "launching", runId: "install-1", attempts: [] }),
    );
    expect((first as { evidence: { phase: string } }).evidence.phase).toBe(
      "awaiting_publication",
    );

    const exec2 = installerExec("state=none");
    const b2 = await bed(exec2);
    const second = await runInstallerHandler(b2.deps).run(
      await b2.ctx({
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
    const b = await bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      await b.ctx({ phase: "running", runId: "install-1", attempts: [] }),
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
    const b = await bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      await b.ctx({ phase: "launching", runId: "install-NEW", attempts: [] }),
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
    const b = await bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      await b.ctx({ phase: "running", runId: "install-1", attempts: [] }),
    );
    expect(result.kind).toBe("done");
  });

  test("a crashed generation re-stages, so the retry allocates a FRESH runId", async () => {
    const exec = installerExec(
      "state=crashed runId=install-1 step=install-browser",
    );
    const b = await bed(exec);
    const result = await runInstallerHandler(b.deps).run(
      await b.ctx({ phase: "running", runId: "install-1", attempts: [] }),
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
    const b = await bed(exec);
    const ctx = await b.ctx({ phase: "minting" });
    const result = await mintInviteHandler(b.deps).run(ctx);
    expect(result.kind).toBe("done");
    expect(b.lines.join("\n")).toContain(URL);

    // Not in the evidence, not in any audit row, not in the redacted transcript.
    expect(
      JSON.stringify((result as { evidence: unknown }).evidence),
    ).not.toContain("abc123secret");
    await b.store.tx(
      async () =>
        await b.store.appendAudit({
          actor: "t",
          instance_id: "inst-1",
          action: "mint_invite",
          target: "cp1.test.isomux.app",
          outcome: "succeeded",
          detail: null,
        }),
    );
    expect(JSON.stringify(await b.store.auditEvents())).not.toContain(
      "abc123secret",
    );
    expect(b.reporter.transcript.join("\n")).not.toContain("abc123secret");
  });

  test("a re-mint tells the operator the earlier link is dead", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: `${URL}\n`,
      stderr: "",
    }));
    const b = await bed(exec);
    await mintInviteHandler(b.deps).run(
      await b.ctx({ phase: "minting", minted: true }),
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
    const b = await bed(exec);
    const result = await mintInviteHandler(b.deps).run(
      await b.ctx({ phase: "minting" }),
    );
    expect(result.kind).toBe("retry");
    expect((result as { reason: string }).reason).toBe(
      "minting the invite failed",
    );
  });
});

/**
 * Slice 4b, and the property the whole invite seam rests on: a customer's link
 * goes to the provisioner's memory, and a process that cannot deliver it mints
 * NOTHING rather than falling back to printing it.
 */
describe("mint_invite for the dashboard", () => {
  const URL = "https://cp1.test.isomux.app/i/dashboardsecret";

  function held(): {
    calls: { op: string; instance: string; url: string }[];
    hold(op: string, instance: string, url: string): void;
  } {
    const calls: { op: string; instance: string; url: string }[] = [];
    return {
      calls,
      hold(op, instance, url) {
        calls.push({ op, instance, url });
      },
    };
  }

  test("the URL goes to the hold, and NEVER to the operator", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: `${URL}\n`,
      stderr: "",
    }));
    const b = await bed(exec);
    const deliver = held();
    const ctx = await b.ctx({ phase: "minting", via: "dashboard" });
    const result = await mintInviteHandler({ ...b.deps, deliver }).run(ctx);

    expect(result.kind).toBe("done");
    expect(deliver.calls).toHaveLength(1);
    expect(deliver.calls[0]).toMatchObject({
      op: ctx.op.id,
      instance: "inst-1",
      url: URL,
    });
    // The operator's terminal and the redacted transcript both stay clean: this
    // credential belongs to the customer, and a journal on our side is not
    // theirs.
    expect(b.lines.join("\n")).not.toContain("dashboardsecret");
    expect(b.reporter.transcript.join("\n")).not.toContain("dashboardsecret");
    expect(
      JSON.stringify((result as { evidence: unknown }).evidence),
    ).not.toContain("dashboardsecret");
  });

  test("no delivery channel: fatal, and nothing is minted at all", async () => {
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: `${URL}\n`,
      stderr: "",
    }));
    const b = await bed(exec);
    const result = await mintInviteHandler(b.deps).run(
      await b.ctx({ via: "dashboard" }),
    );
    expect(result.kind).toBe("fatal");
    // BEFORE the remote call, which is the point: a URL that exists has to go
    // somewhere, so the refusal happens while there is still nothing to place.
    expect(exec.calls).toHaveLength(0);
    expect(b.lines.join("\n")).not.toContain("dashboardsecret");
  });

  test("the stamp survives the recovery marker, so a retry cannot leak", async () => {
    // The marker write REPLACES the evidence. If it dropped `via`, the next
    // attempt would read an operator row and print a customer's link.
    const exec = new FakeExec(() => ({
      code: 0,
      stdout: `${URL}\n`,
      stderr: "",
    }));
    const b = await bed(exec);
    const deliver = held();
    const ctx = await b.ctx({ via: "dashboard" });
    await mintInviteHandler({ ...b.deps, deliver }).run(ctx);
    const after = (await b.store.getOperation(ctx.op.id))!;
    expect(JSON.parse(after.evidence).via).toBe("dashboard");
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
    const b = await bed(exec);
    const ctx = await b.ctx({});
    const result = await mintInviteHandler(b.deps).run(ctx);
    expect(result.kind).toBe("done");
    // The marker was persisted through the fence in THIS invocation...
    const after = (await b.store.getOperation(ctx.op.id))!;
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
    const b = await bed(exec);
    const ctx = await b.ctx({ phase: "minting" });
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
    const b = await bed(exec);
    const ctx = await b.ctx({ pinReset: true, probes: 0 });
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
    const b = await bed(exec);
    const ctx = await b.ctx({});
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
    const b = await bed(exec);
    const ctx = await b.ctx({});
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
        return ctx.audit("mint_invite", phase, kind);
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
    const b = await bed(exec);
    const ctx = await b.ctx({});
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
