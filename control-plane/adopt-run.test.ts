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
import { accountForDevSignIn, hostnameFor, reserveOffice } from "./signup.ts";
import type { RunRecord } from "./run-record.ts";

const SCRIPT = path.join(import.meta.dir, "exercises", "adopt-run.ts");
const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-adopt-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length)
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

interface Bed {
  db: string;
  runsDir: string;
  instanceId: string;
  runId: string;
}

function bed(over: Partial<RunRecord> = {}): Bed {
  const dir = tempDir();
  const db = path.join(dir, "cp.db");
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir);
  const store = new Store(db);
  const account = accountForDevSignIn(store, "a@example.com");
  const out = reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!out.ok) throw new Error("signup failed");
  store.close();

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

function open(b: Bed): Store {
  return new Store(b.db);
}

describe("--start", () => {
  test("links the instance, adopts the asset and opens wait_for_ssh in one go", () => {
    const b = bed();
    const r = run(b, "--start");
    expect(r.code).toBe(0);
    const store = open(b);
    const instance = store.getInstance(b.instanceId)!;
    const asset = store.assetForInstance(b.instanceId)!;
    expect(instance.run_id).toBe(b.runId);
    expect(asset.provider_id).toBe("203474835");
    expect(asset.ipv4).toBe("169.58.97.2");
    expect(asset.asset_state).toBe("active");
    const ops = store.operationsFor(b.instanceId);
    expect(ops.map((o) => o.kind)).toEqual(["wait_for_ssh"]);
    expect(store.auditEvents().some((e) => e.action === "adopt_run")).toBe(
      true,
    );
    store.close();
  });

  test("a hostname that is not the run's box is refused, and writes nothing", () => {
    const b = bed({ host: "somebody-else.test.isomux.app" });
    const r = run(b, "--start");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing to point one office at another");
    const store = open(b);
    expect(store.getInstance(b.instanceId)!.run_id).toBeNull();
    expect(store.assetForInstance(b.instanceId)!.provider_id).toBeNull();
    expect(store.operationsFor(b.instanceId)).toEqual([]);
    store.close();
  });

  test("a second --start never re-points a linked instance", () => {
    const b = bed();
    expect(run(b, "--start").code).toBe(0);
    const second = run(b, "--start");
    expect(second.code).toBe(1);
    expect(second.err).toContain("already linked");
    const store = open(b);
    expect(store.operationsFor(b.instanceId)).toHaveLength(1);
    store.close();
  });
});

describe("--revoke", () => {
  function live(b: Bed): void {
    const store = open(b);
    store.enqueue({
      id: "op-verify_https-99",
      instance_id: b.instanceId,
      kind: "verify_https",
      inactivity_deadline_at: store.now() + 60_000,
      absolute_deadline_at: store.now() + 60_000,
    });
    store.db.run("update operations set status = 'succeeded' where id = ?", [
      "op-verify_https-99",
    ]);
    store.close();
  }

  test("refuses an instance this run never linked", () => {
    const b = bed();
    const r = run(b, "--revoke");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not to run");
  });

  test("refuses a box we never proved was live", () => {
    const b = bed();
    run(b, "--start");
    const r = run(b, "--revoke");
    expect(r.code).toBe(1);
    expect(r.err).toContain("never proved was live");
    const store = open(b);
    expect(store.activeOperation(b.instanceId, "revoke_access")).toBeNull();
    store.close();
  });

  test("opens one revocation, and a repeat is an idempotent no-op", () => {
    const b = bed();
    run(b, "--start");
    live(b);
    const first = run(b, "--revoke");
    expect(first.code).toBe(0);
    const second = run(b, "--revoke");
    expect(second.code).toBe(0);
    expect(second.out).toContain("already");
    const store = open(b);
    const revocations = store
      .operationsFor(b.instanceId)
      .filter((o) => o.kind === "revoke_access");
    expect(revocations).toHaveLength(1);
    // The attempt is recorded even though nothing changed.
    expect(
      store.auditEvents().filter((e) => e.outcome === "already_active"),
    ).toHaveLength(1);
    // And it never touches the linkage.
    expect(store.getInstance(b.instanceId)!.run_id).toBe(b.runId);
    expect(store.assetForInstance(b.instanceId)!.provider_id).toBe("203474835");
    store.close();
  });

  test("refuses once a revocation has already been proven", () => {
    const b = bed();
    run(b, "--start");
    live(b);
    run(b, "--revoke");
    const store = open(b);
    store.db.run(
      "update operations set status = 'succeeded' where kind = 'revoke_access'",
    );
    store.close();
    const again = run(b, "--revoke");
    expect(again.code).toBe(1);
    expect(again.err).toContain("already revoked and proven");
  });
});

test("exactly one mode is required", () => {
  const b = bed();
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
