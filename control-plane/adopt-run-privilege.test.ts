// adopt-run, executed by the ROLE THE DEPLOYED PROVISIONER AUTHENTICATES AS.
//
// WHY THIS FILE EXISTS. `adopt-run.test.ts` drives the command as the owner, so
// every statement it makes succeeds by construction and the file proves which
// DECISION each situation earns. That is not the question D4 has to answer.
// The deployed shape runs this command on the provisioner's own machine, as
// `cp_provisioner`, holding exactly `PROVISIONER_GRANTS` - and on 2026-08-12 a
// grant that matrix did not carry took a live credential move down: the invite
// seam's `name_reservations` SELECT was refused 42501, the probe reported a
// refusal, and the move rolled back. The same class of omission here would fail
// the customer pass at the moment a real box is being adopted.
//
// So these cases run the REAL executable, unmodified, through the environment
// DSN path the deployed machine uses, against a store the least-privileged role
// opened. The matrix is the ARGUMENT rather than a copy of one: narrowing
// `roles.ts` changes what these roles may do, and the narrowing case below
// proves that a missing grant fails here rather than in a live run.
//
// LOCAL ENGINE ONLY: it creates a login role.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROVISIONER_GRANTS } from "./roles.ts";
import { accountForDevSignIn, hostnameFor, reserveOffice } from "./signup.ts";
import {
  TARGET_IS_LOCAL,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
} from "./testing/least-privilege.ts";
import type { RunRecord } from "./run-record.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

const SCRIPT = path.join(import.meta.dir, "exercises", "adopt-run.ts");
const temps: string[] = [];

afterEach(async () => {
  await releaseTestStores();
  while (temps.length)
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
}, PG_TEST_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await dropLeastPrivilegedRoles();
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Bed {
  /** The owner's string, for setting the world up and reading it back. */
  ownerDsn: string;
  /** The provisioner's: exactly `grants`, and a login of its own. */
  roleDsn: string;
  runsDir: string;
  instanceId: string;
  runId: string;
}

async function bed(
  grants: readonly (typeof PROVISIONER_GRANTS)[number][] = PROVISIONER_GRANTS,
): Promise<Bed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-adopt-lp-"));
  temps.push(dir);
  const ownerDsn = await testDsn();
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir);

  const store = await openTestStoreOn(ownerDsn);
  const account = await accountForDevSignIn(store, "a@example.com");
  const out = await reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!out.ok) throw new Error("signup failed");
  await store.close();

  const rec: RunRecord = {
    runId: "run-lp-1",
    // A box that has answered SSH: adoption does not read this field, and a
    // value outside the union would be a fixture lying about a shape.
    state: "reachable",
    host: hostnameFor("cp1"),
    instanceId: "203474835",
    ipv4: "169.58.97.2",
    loginUser: "root",
    privateKeyPath: "/dev/null",
    publicKeyPath: "/dev/null",
    algorithm: "ed25519",
    blob: "AAAA",
    knownHostsFile: "/dev/null",
  };
  fs.writeFileSync(
    path.join(runsDir, `${rec.runId}.json`),
    JSON.stringify(rec),
  );

  return {
    ownerDsn,
    roleDsn: await leastPrivilegedDsn({ dsn: ownerDsn, grants }),
    runsDir,
    instanceId: out.reservation.instance_id,
    runId: rec.runId,
  };
}

/**
 * The command as the deployed machine runs it: no `--db`, the database string
 * in the environment, and the role in the string is not the owner.
 *
 * `CONTROL_PLANE_DB` is set for THIS CHILD only. A test that exported it would
 * change what every other command in the same process connects to.
 */
function run(b: Bed, mode: string) {
  const proc = Bun.spawnSync(
    [
      "bun",
      SCRIPT,
      "--instance",
      b.instanceId,
      "--run",
      b.runId,
      "--runs-dir",
      b.runsDir,
      mode,
    ],
    { env: { ...process.env, CONTROL_PLANE_DB: b.roleDsn } },
  );
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

/** A succeeded verify_https, written by the OWNER: revoking is only allowed
 * against a box we proved was live, and staging that is not what is under
 * test here. */
async function proveLive(b: Bed): Promise<void> {
  const store = await openTestStoreOn(b.ownerDsn);
  await store.enqueue({
    id: "op-verify_https-99",
    instance_id: b.instanceId,
    kind: "verify_https",
    inactivity_deadline_at: store.now() + 60_000,
    absolute_deadline_at: store.now() + 60_000,
  });
  await store.sqlRun(
    "update operations set status = 'succeeded' where id = $1",
    ["op-verify_https-99"],
  );
  await store.close();
}

suite("adopt-run under the provisioner's exact grant matrix", () => {
  test("--START COMPLETES, and writes every row it promises", async () => {
    const b = await bed();
    const r = run(b, "--start");
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });

    // Read back as the OWNER: what is under test is that the restricted role
    // could WRITE these, and a restricted read-back would prove less.
    const store = await openTestStoreOn(b.ownerDsn);
    const instance = (await store.getInstance(b.instanceId))!;
    const asset = (await store.assetForInstance(b.instanceId))!;
    expect(instance.run_id).toBe(b.runId);
    expect(asset.provider_id).toBe("203474835");
    expect(asset.ipv4).toBe("169.58.97.2");
    expect(asset.asset_state).toBe("active");
    const ops = await store.operationsFor(b.instanceId);
    expect(ops.map((o) => o.kind)).toEqual(["wait_for_ssh"]);
    expect(
      (await store.auditEvents()).some((e) => e.action === "adopt_run"),
    ).toBe(true);
    await store.close();
  });

  test("--REVOKE COMPLETES, and opens the revocation", async () => {
    const b = await bed();
    expect(run(b, "--start").code).toBe(0);
    await proveLive(b);
    const r = run(b, "--revoke");
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });

    const store = await openTestStoreOn(b.ownerDsn);
    const ops = await store.operationsFor(b.instanceId);
    expect(ops.map((o) => o.kind).sort()).toEqual([
      "revoke_access",
      "verify_https",
      "wait_for_ssh",
    ]);
    expect(
      (await store.auditEvents()).some((e) => e.action === "adopt_run_revoke"),
    ).toBe(true);
    await store.close();
  });

  test("a REFUSAL is still the command's own refusal, not a privilege error", async () => {
    // The preconditions have to be reachable from this role too. A revoke
    // before anything is linked must fail on the rule, which means the reads
    // the rule depends on all succeeded.
    const b = await bed();
    const r = run(b, "--revoke");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not to run");
    // Not an authorization failure wearing a rule's clothes: 42501 is what the
    // narrowed case below produces, and it must be absent here.
    expect(r.err).not.toContain("42501");
  });

  test("A NARROWED MATRIX FAILS HERE, which is what makes the case above evidence", async () => {
    // Without this, a matrix that already carried too much would pass every
    // test above and the file would prove nothing about the grants. The
    // operations INSERT is load-bearing: adoption opens wait_for_ssh, and the
    // deployed loop cannot enqueue anything without it.
    const narrowed = PROVISIONER_GRANTS.map((grant) =>
      grant.table === "operations"
        ? { ...grant, verbs: grant.verbs.filter((v) => v !== "insert") }
        : grant,
    );
    const b = await bed(narrowed);
    const r = run(b, "--start");
    expect(r.code).toBe(1);
    // The ENGINE's refusal, by its SQLSTATE, which is the reason a live run
    // would have rolled back rather than a message this test invented. The
    // store's seam scrubs the text - "the database refused a statement
    // (SQLSTATE 42501)" is the whole of what a caller sees - so the code is
    // what there is to assert on, and that is the right thing to assert on.
    const said = `${r.err}${r.out}`;
    expect(said).toContain("42501");
    // The scrubbing itself, checked here because this is one of the few tests
    // that sees a real driver error: no host, no role, no password.
    expect(said).not.toContain("cp_lp_");
    expect(said).not.toContain("postgres://");

    // AND NOTHING WAS HALF-WRITTEN: one transaction, so the link the command
    // made before the refused insert is gone with it.
    const store = await openTestStoreOn(b.ownerDsn);
    const instance = (await store.getInstance(b.instanceId))!;
    const asset = (await store.assetForInstance(b.instanceId))!;
    expect(instance.run_id).toBeNull();
    expect(asset.provider_id).toBeNull();
    expect(await store.operationsFor(b.instanceId)).toEqual([]);
    await store.close();
  });
});
