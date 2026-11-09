// The operator's attention commands, run as the ROLE THE DEPLOYED PROVISIONER
// AUTHENTICATES AS.
//
// On 2026-11-09 `cli.ts attention --ack` in the provisioner container failed
// with 42501 and left the reason unacknowledged: the command opened the store
// with the schema statements, which that role may not run. So these cases run
// the REAL CLI, unmodified, with the database string in the environment and
// the identity the container sets, against a schema the owner bootstrapped,
// as a role holding exactly `PROVISIONER_GRANTS`. Every read-back is the
// owner's: what is under test is that the restricted role could WRITE.
//
// LOCAL ENGINE ONLY: it creates a login role.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { raiseAttention } from "./attention.ts";
import { DATABASE_IDENTITY_ENV } from "./boot.ts";
import { writeDatabaseIdentity } from "./bootstrap.ts";
import { PROMISE_BROKEN } from "./lifecycle.ts";
import { PROVISIONER_GRANTS } from "./roles.ts";
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

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

const CLI = path.join(import.meta.dir, "cli.ts");
const INSTANCE = "inst-att-1";
const IDENTITY = "hosted-identity-att-0001";
/** Each case spawns one or two CLI processes; about 1 s each when measured. */
const CASE_TIMEOUT_MS = 20_000;

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
  ownerDsn: string;
  roleDsn: string;
  home: string;
}

/** A bootstrapped schema with one live instance, its identity row written by
 * the owner, and the provisioner's role on it. */
async function bed(): Promise<Bed> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-attention-lp-"));
  temps.push(home);
  const ownerDsn = await testDsn();
  const store = await openTestStoreOn(ownerDsn);
  await store.createInstance({
    id: INSTANCE,
    run_id: null,
    name: "cp-att.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "live",
    access_window_expires_at: null,
  });
  await store.close();
  await writeDatabaseIdentity(ownerDsn, IDENTITY);
  return {
    ownerDsn,
    roleDsn: await leastPrivilegedDsn({
      dsn: ownerDsn,
      grants: PROVISIONER_GRANTS,
    }),
    home,
  };
}

async function raise(b: Bed, sourceOpId: string): Promise<void> {
  const store = await openTestStoreOn(b.ownerDsn);
  await raiseAttention(store, {
    instanceId: INSTANCE,
    reasonClass: "operation_condition",
    sourceOpId,
    reason: `test reason ${sourceOpId}`,
    severity: "critical",
  });
  await store.close();
}

/**
 * The command as the container runs it. `CONTROL_PLANE_DB` and the identity
 * are set for THIS CHILD only, and HOME points the CLI's state folder at a
 * temp dir.
 */
function cli(b: Bed, argv: string[], identity = IDENTITY) {
  const proc = Bun.spawnSync(["bun", CLI, ...argv], {
    env: {
      ...process.env,
      HOME: b.home,
      CONTROL_PLANE_DB: b.roleDsn,
      [DATABASE_IDENTITY_ENV]: identity,
    },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

async function reasons(b: Bed) {
  const store = await openTestStoreOn(b.ownerDsn);
  const rows = await store.sqlAll<{
    source_op_id: string;
    acknowledged_at: number | null;
    acknowledged_by: string | null;
    cleared_at: number | null;
  }>(
    "select source_op_id, acknowledged_at, acknowledged_by, cleared_at " +
      "from attention_reasons where instance_id = $1 order by source_op_id",
    [INSTANCE],
  );
  const audit = (await store.auditEvents()).map((e) => e.action);
  await store.close();
  return { rows, audit };
}

suite("attention and ops under the provisioner's exact grant matrix", () => {
  test(
    "--ACK completes, and acknowledges without clearing",
    async () => {
      const b = await bed();
      await raise(b, "op-ack-1");
      const r = cli(b, ["attention", "--ack", INSTANCE, "--by", "lead-sre"]);
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      // The listing after the ack is the same command's read, as this role.
      expect(r.out).toContain(INSTANCE);

      const { rows, audit } = await reasons(b);
      expect(rows).toHaveLength(1);
      expect(rows[0].acknowledged_at).not.toBeNull();
      expect(rows[0].acknowledged_by).toBe("lead-sre");
      expect(rows[0].cleared_at).toBeNull();
      expect(audit).toContain("acknowledge_attention");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "--RESOLVE completes on a broken promise, and leaves other reasons open",
    async () => {
      const b = await bed();
      await raise(b, PROMISE_BROKEN);
      await raise(b, "op-other-1");
      const r = cli(b, [
        "attention",
        "--resolve",
        INSTANCE,
        "--by",
        "lead-sre",
      ]);
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });

      const { rows, audit } = await reasons(b);
      const bySource = Object.fromEntries(
        rows.map((row) => [row.source_op_id, row.cleared_at !== null]),
      );
      expect(bySource).toEqual({
        [PROMISE_BROKEN]: true,
        "op-other-1": false,
      });
      expect(audit).toContain("resolve_attention");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "ops completes, with and without --run",
    async () => {
      const b = await bed();
      for (const argv of [["ops"], ["ops", "--run", "att-1"]]) {
        const r = cli(b, argv);
        expect({ argv, code: r.code, err: r.err }).toEqual({
          argv,
          code: 0,
          err: "",
        });
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a database that is not the one the container names gets no ack",
    async () => {
      // The control for the case above: the same role and command succeed
      // with the right identity, so this refusal is the identity proof.
      const b = await bed();
      await raise(b, "op-ack-2");
      const r = cli(
        b,
        ["attention", "--ack", INSTANCE, "--by", "lead-sre"],
        "hosted-identity-att-0002",
      );
      expect(r.code).not.toBe(0);
      expect(r.err).not.toContain("42501");
      const { rows } = await reasons(b);
      expect(rows[0].acknowledged_at).toBeNull();

      const ok = cli(b, ["attention", "--ack", INSTANCE, "--by", "lead-sre"]);
      expect(ok.code).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});
