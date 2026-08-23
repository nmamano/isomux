// The two mode contracts of exercises/adopt-run.ts, driven the way an operator
// drives them - as the command, against a temp database and a temp run record.
//
// What is worth asserting is mostly what does NOT happen: a refusal writes
// nothing, a linked instance is never re-pointed, an asset is never replaced,
// and a second revoke does not open a second revocation.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "./store.ts";
import {
  freshDsn,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";
import { accountForDevSignIn, hostnameFor, reserveOffice } from "./signup.ts";
import type { RunRecord } from "./run-record.ts";

const SCRIPT = path.join(import.meta.dir, "exercises", "adopt-run.ts");
const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-adopt-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await releaseTestStores();
  while (temps.length)
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Bed {
  db: string;
  runsDir: string;
  instanceId: string;
  runId: string;
}

async function bed(over: Partial<RunRecord> = {}): Promise<Bed> {
  const dir = tempDir();
  // The subprocess opens its own store on this connection string, exactly as
  // an operator's would.
  const db = await testDsn();
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir);
  const store = await openTestStoreOn(db);
  const account = await accountForDevSignIn(store, "a@example.com");
  const out = await reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!out.ok) throw new Error("signup failed");
  await store.close();

  const rec: RunRecord = {
    runId: "run-test-1",
    state: "installed",
    host: hostnameFor("cp1"),
    instanceId: "203474835",
    ipv4: "169.58.97.2",
    loginUser: "root",
    privateKeyPath: "/dev/null",
    publicKeyPath: "/dev/null",
    algorithm: "ed25519",
    blob: "AAAA",
    knownHostsFile: "/dev/null",
    ...over,
  } as RunRecord;
  fs.writeFileSync(
    path.join(runsDir, `${rec.runId}.json`),
    JSON.stringify(rec),
  );
  return {
    db,
    runsDir,
    instanceId: out.reservation.instance_id,
    runId: rec.runId,
  };
}

function run(b: Bed, mode: string, over: Partial<Bed> = {}) {
  const proc = Bun.spawnSync([
    "bun",
    SCRIPT,
    "--db",
    over.db ?? b.db,
    "--instance",
    over.instanceId ?? b.instanceId,
    "--run",
    over.runId ?? b.runId,
    "--runs-dir",
    over.runsDir ?? b.runsDir,
    mode,
  ]);
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

async function open(b: Bed): Promise<Store> {
  return await openTestStoreOn(b.db);
}

describe("--start", () => {
  test("links the instance, adopts the asset and opens wait_for_ssh in one go", async () => {
    const b = await bed();
    const r = run(b, "--start");
    expect(r.code).toBe(0);
    const store = await open(b);
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

  test("a hostname that is not the run's box is refused, and writes nothing", async () => {
    const b = await bed({ host: "somebody-else.test.isomux.app" });
    const r = run(b, "--start");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing to point one office at another");
    const store = await open(b);
    expect((await store.getInstance(b.instanceId))!.run_id).toBeNull();
    expect(
      (await store.assetForInstance(b.instanceId))!.provider_id,
    ).toBeNull();
    expect(await store.operationsFor(b.instanceId)).toEqual([]);
    await store.close();
  });

  test("a second --start never re-points a linked instance", async () => {
    const b = await bed();
    expect(run(b, "--start").code).toBe(0);
    const second = run(b, "--start");
    expect(second.code).toBe(1);
    expect(second.err).toContain("already linked");
    const store = await open(b);
    expect(await store.operationsFor(b.instanceId)).toHaveLength(1);
    await store.close();
  });
});

describe("--revoke", () => {
  async function live(b: Bed): Promise<void> {
    const store = await open(b);
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

  test("refuses an instance this run never linked", async () => {
    const b = await bed();
    const r = run(b, "--revoke");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not to run");
  });

  test("refuses a box we never proved was live", async () => {
    const b = await bed();
    run(b, "--start");
    const r = run(b, "--revoke");
    expect(r.code).toBe(1);
    expect(r.err).toContain("never proved was live");
    const store = await open(b);
    expect(
      await store.activeOperation(b.instanceId, "revoke_access"),
    ).toBeNull();
    await store.close();
  });

  test("opens one revocation, and a repeat is an idempotent no-op", async () => {
    const b = await bed();
    run(b, "--start");
    await live(b);
    const first = run(b, "--revoke");
    expect(first.code).toBe(0);
    const second = run(b, "--revoke");
    expect(second.code).toBe(0);
    expect(second.out).toContain("already");
    const store = await open(b);
    const revocations = (await store.operationsFor(b.instanceId)).filter(
      (o) => o.kind === "revoke_access",
    );
    expect(revocations).toHaveLength(1);
    // The attempt is recorded even though nothing changed.
    expect(
      (await store.auditEvents()).filter((e) => e.outcome === "already_active"),
    ).toHaveLength(1);
    // And it never touches the linkage.
    expect((await store.getInstance(b.instanceId))!.run_id).toBe(b.runId);
    expect((await store.assetForInstance(b.instanceId))!.provider_id).toBe(
      "203474835",
    );
    await store.close();
  });

  test("refuses once a revocation has already been proven", async () => {
    const b = await bed();
    run(b, "--start");
    await live(b);
    run(b, "--revoke");
    const store = await open(b);
    await store.sqlRun(
      "update operations set status = 'succeeded' where kind = 'revoke_access'",
    );
    await store.close();
    const again = run(b, "--revoke");
    expect(again.code).toBe(1);
    expect(again.err).toContain("already revoked and proven");
  });
});

describe("it USES a database, it does not build one (D4, 2026-08-12)", () => {
  // The deployed shape runs this as the provisioner's own restricted role, and
  // a restricted role meeting the schema-writing `Store.open` fails with 42501
  // - which is how the first web cutover died on 2026-08-12. The G3 rehearsal
  // proves it once against the real role; this keeps the code from regressing
  // silently afterwards, without building a restricted role here.
  test("an unbuilt database is REFUSED, not created", async () => {
    const b = await bed();
    const empty = await freshDsn();
    const r = run(b, "--start", { db: empty });
    expect(r.code).toBe(1);
    // The runtime open's own refusal: the schema check fires before anything
    // is written, and it says bringing a database up is a separate step.
    expect(`${r.err}${r.out}`).toContain("the store refuses to open");

    // And it built NOTHING on the way to that refusal. `Store.open` would have
    // created the whole schema and seeded the audit sequence before it ever
    // looked at the arguments, and a runtime open of that database would then
    // succeed. It still refuses, so nothing was built.
    let opened = false;
    try {
      const store = await Store.openRuntime(empty);
      opened = true;
      await store.close();
    } catch {
      // The refusal is the expected outcome, and its message is asserted above.
    }
    expect(opened).toBe(false);
  });

  test("the source names the runtime open and not the building one", () => {
    // The behavioural test above proves today's build. This one names the seam,
    // so a future edit that reintroduces the schema-writing open fails here
    // with the reason written next to it rather than only as a refusal
    // somebody has to interpret.
    const source = fs.readFileSync(
      path.join(import.meta.dir, "exercises", "adopt-run.ts"),
      "utf8",
    );
    expect(source).toContain("Store.openRuntime(");
    expect(source).not.toContain("Store.open(");
  });
});

test("exactly one mode is required", async () => {
  const b = await bed();
  const proc = Bun.spawnSync([
    "bun",
    SCRIPT,
    "--db",
    b.db,
    "--instance",
    b.instanceId,
    "--run",
    b.runId,
    "--runs-dir",
    b.runsDir,
  ]);
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain(
    "exactly one of --start or --revoke",
  );
});
