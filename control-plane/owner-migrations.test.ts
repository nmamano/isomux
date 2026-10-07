// The owner migrations as deploy.sh runs them: `cli.ts migrate-all`, with the
// new image, before every redeploy starts the new release.
//
// The roster cases need no database. The migrate-all cases run the real CLI
// against the local engine and take a bootstrapped schema back to before each
// migration: LOCAL ENGINE ONLY.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import * as bootstrap from "./bootstrap.ts";
import { OWNER_MIGRATIONS } from "./bootstrap.ts";
import { PROVISIONER_GRANTS } from "./roles.ts";
import { Store } from "./store.ts";
import {
  TARGET_IS_LOCAL,
  freshDsn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
} from "./testing/least-privilege.ts";

describe("the owner migration roster", () => {
  test("holds every migration bootstrap.ts exports, once", () => {
    const exported = Object.entries(bootstrap)
      .filter(([name]) => /^migrate[A-Z]/.test(name))
      .map(([, value]) => value);
    // Widened so that any export can be looked up in it.
    const runs: readonly unknown[] = OWNER_MIGRATIONS.map((m) => m.run);
    expect(exported.length).toBeGreaterThan(0);
    expect(new Set(runs).size).toBe(runs.length);
    expect(runs.length).toBe(exported.length);
    for (const migration of exported) expect(runs).toContain(migration);
  });

  test("the CLI exposes no migrate command outside it but migrate-all", () => {
    const commands = OWNER_MIGRATIONS.map((m) => m.command);
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands).not.toContain("migrate-all");
    const cli = fs.readFileSync(path.join(import.meta.dir, "cli.ts"), "utf8");
    expect([...new Set(cli.match(/["'`]migrate-[a-z-]+/g))]).toEqual([
      '"migrate-all',
    ]);
  });
});

const suite = TARGET_IS_LOCAL ? describe : describe.skip;
// A bootstrap, a least-privileged role and up to two CLI runs: well over the
// 5 s default on a loaded box.
const DB_CASE_MS = 60_000;

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await dropLeastPrivilegedRoles();
}, PG_TEST_HOOK_TIMEOUT_MS);

function migrateAll(dsn: string): { code: number; out: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-all-"));
  try {
    const run = Bun.spawnSync(
      ["bun", path.join(import.meta.dir, "cli.ts"), "migrate-all"],
      {
        env: { PATH: process.env.PATH, HOME: home, CONTROL_PLANE_DB: dsn },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: run.exitCode,
      out: run.stdout.toString() + run.stderr.toString(),
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A bootstrapped schema with the given statements run as its owner, and a
 * DSN for a role holding exactly the provisioner's matrix on it. */
async function schemaAfter(statements: readonly string[]): Promise<{
  ownerDsn: string;
  roleDsn: string;
  owner: pg.Pool;
}> {
  const ownerDsn = await freshDsn();
  await (await Store.open(ownerDsn)).close();
  const roleDsn = await leastPrivilegedDsn({
    dsn: ownerDsn,
    grants: PROVISIONER_GRANTS,
  });
  const owner = new pg.Pool({ connectionString: ownerDsn, max: 1 });
  owner.on("error", () => {});
  for (const statement of statements) await owner.query(statement);
  return { ownerDsn, roleDsn, owner };
}

async function hasColumn(
  owner: pg.Pool,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await owner.query(
    "select 1 from pg_attribute where attrelid = to_regclass($1) " +
      "and attname = $2 and attnum > 0 and not attisdropped",
    [table, column],
  );
  return rows.rowCount === 1;
}

async function hasLegacyConstraint(owner: pg.Pool): Promise<boolean> {
  const rows = await owner.query(
    "select 1 from pg_constraint where conname = 'legacy_one_office'",
  );
  return rows.rowCount === 1;
}

// One change per migration, each one undone the way the database looked
// before that migration shipped.
const CUSTOMER_SSH_KEY_UNDONE =
  "alter table instances drop column customer_ssh_key";
const CANCELLATION_INDEX_UNDONE =
  "drop index provider_assets_provider_id_unique";
const MULTI_OFFICE_UNDONE =
  "alter table name_reservations add constraint legacy_one_office unique (account_id)";
const PRE_MIGRATION = [
  CUSTOMER_SSH_KEY_UNDONE,
  CANCELLATION_INDEX_UNDONE,
  "alter table subscriptions drop column cancellation_policy",
  MULTI_OFFICE_UNDONE,
  "alter table name_reservations drop column checkout_session_id",
  "alter table instances drop column certificate_contact_next_check_at",
];

suite("migrate-all", () => {
  test(
    "brings a schema from before every migration to current, and again is a no-op",
    async () => {
      const { roleDsn, ownerDsn, owner } = await schemaAfter(PRE_MIGRATION);
      try {
        const before = await Store.openRuntime(roleDsn).then(
          async (store) => {
            await store.close();
            return "opened";
          },
          () => "refused",
        );
        expect(before).toBe("refused");
        const first = migrateAll(ownerDsn);
        expect(first.code).toBe(0);
        // Every migration reported, in the roster's order.
        const reported = first.out
          .split("\n")
          .filter((line) => line.endsWith(": ready"));
        expect(reported).toEqual(
          OWNER_MIGRATIONS.map((m) => `${m.ready}: ready`),
        );
        await (await Store.openRuntime(roleDsn)).close();
        expect(migrateAll(ownerDsn).code).toBe(0);
        await (await Store.openRuntime(roleDsn)).close();
      } finally {
        await owner.end().catch(() => {});
      }
    },
    DB_CASE_MS,
  );

  test(
    "stops at the first failure and keeps what the earlier migrations applied",
    async () => {
      // Two assets on one provider id: the cancellation migration refuses to
      // build its unique index over them.
      const asset = (id: string) =>
        "insert into provider_assets (id, instance_id, provider, provider_id, " +
        "asset_state, next_reconcile_at, version, created_at, updated_at) " +
        `values ('${id}', 'inst-${id}', 'contabo', 'dup', 'active', 0, 1, 0, 0)`;
      const { ownerDsn, owner } = await schemaAfter([
        CUSTOMER_SSH_KEY_UNDONE,
        CANCELLATION_INDEX_UNDONE,
        MULTI_OFFICE_UNDONE,
        asset("a1"),
        asset("a2"),
      ]);
      try {
        const order = OWNER_MIGRATIONS.map((m) => m.command);
        expect(order.indexOf("migrate-customer-ssh-key")).toBeLessThan(
          order.indexOf("migrate-hosted-cancellation"),
        );
        expect(order.indexOf("migrate-hosted-cancellation")).toBeLessThan(
          order.indexOf("migrate-multi-office"),
        );
        const run = migrateAll(ownerDsn);
        expect(run.code).not.toBe(0);
        expect(await hasColumn(owner, "instances", "customer_ssh_key")).toBe(
          true,
        );
        expect(await hasLegacyConstraint(owner)).toBe(true);
      } finally {
        await owner.end().catch(() => {});
      }
    },
    DB_CASE_MS,
  );
});
