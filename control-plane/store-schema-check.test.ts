// What the open-time schema check can actually see, and what it refuses.
//
// The check exists to stop this build running against a database of the wrong
// shape. It used to ask `information_schema.columns`, which shows a role only
// the objects it holds a privilege on - so on the deployment it matters for, a
// least-privileged runtime role, it inspected the tables it was granted and
// SILENTLY SKIPPED every other one. `stripe_events` was granted to neither
// runtime role at the time, so the column it checks there was never checked in
// production at all. The same clause skipped a table that was not there, because
// "zero columns" and "no such table" are the same answer from that view.
//
// Every case below is therefore run AS A LEAST-PRIVILEGED ROLE, because that is
// the session whose answer was wrong. The owner sees everything and would pass
// either implementation.
//
// LOCAL ENGINE ONLY: these create roles and mutilate schemas.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import pg from "pg";
import { PROVISIONER_GRANTS, type TableGrant } from "./roles.ts";
import {
  migrateCustomerSshKeyColumns,
  migrateHostedCancellationPolicy,
  migrateMultiOfficeReservations,
} from "./bootstrap.ts";
import { PRODUCT_TABLES, Store } from "./store.ts";
import {
  LOCAL_DATABASE_URL,
  TARGET_IS_LOCAL,
  quoteIdentifier,
  freshDsn,
  releaseTestStores,
} from "./testing/pg.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
  schemaOf,
} from "./testing/least-privilege.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

const admin = new pg.Pool({
  connectionString: LOCAL_DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5_000,
});
admin.on("error", () => {});

afterEach(async () => {
  await releaseTestStores();
});

afterAll(async () => {
  await dropLeastPrivilegedRoles();
  await admin.end().catch(() => {});
});

/** A bootstrapped schema, and a DSN for a role holding exactly the
 * provisioner's matrix on it. Both come back: the tests mutilate the schema
 * through the owner and then open as the role. */
async function bootstrappedAndRole(
  grants: readonly TableGrant[] = PROVISIONER_GRANTS,
): Promise<{
  ownerDsn: string;
  roleDsn: string;
  schema: string;
}> {
  // FRESH, and dropped rather than recycled: these cases drop columns and
  // tables, and a recycled schema would carry the damage into whatever test
  // took it next.
  const ownerDsn = await freshDsn();
  await (await Store.open(ownerDsn)).close();
  const roleDsn = await leastPrivilegedDsn({ dsn: ownerDsn, grants });
  return { ownerDsn, roleDsn, schema: schemaOf(ownerDsn) };
}

/**
 * The provisioner's matrix MINUS `stripe_events`, so the no-privilege case has
 * a table to stand on.
 *
 * It used to use the production matrix directly, because `stripe_events` was
 * granted to neither runtime role. That stopped being true on 2026-08-20, when
 * the provisioner began serving the Stripe webhook and was granted the event
 * journal - and the case silently changed meaning, because its "role cannot
 * read this" premise now failed. Deriving the grant set here keeps the property
 * under test (the catalog answers for a table the session cannot read) from
 * depending on which tables a production role happens to hold this month.
 */
const GRANTS_WITHOUT_STRIPE_EVENTS = PROVISIONER_GRANTS.filter(
  (grant) => grant.table !== "stripe_events",
);

suite("the schema check reads the catalog, not the privilege view", () => {
  test("a least-privileged role opens a database that is actually current", async () => {
    const { roleDsn } = await bootstrappedAndRole();
    const store = await Store.openRuntime(roleDsn);
    await store.close();
  });

  test("a least-privileged role refuses the legacy account uniqueness constraint", async () => {
    const { ownerDsn, roleDsn } = await bootstrappedAndRole();
    const owner = new pg.Pool({ connectionString: ownerDsn, max: 1 });
    owner.on("error", () => {});
    try {
      await owner.query(
        "alter table name_reservations add constraint legacy_one_office unique (account_id)",
      );
      expect(Store.openRuntime(roleDsn)).rejects.toThrow(
        /multi-office owner migration/,
      );
    } finally {
      await owner.end().catch(() => {});
    }
  });

  test("the multi-office migration preserves rows and is idempotent", async () => {
    const ownerDsn = await freshDsn();
    const store = await Store.open(ownerDsn);
    await store.sqlRun(
      "insert into accounts (id, email, version, created_at, updated_at) " +
        "values ('acct-existing', 'existing@example.com', 1, 1, 1)",
    );
    await store.sqlRun(
      "insert into name_reservations " +
        "(name, id, account_id, instance_id, plan, version, created_at, updated_at) " +
        "values ('test-nil', 'res-existing', 'acct-existing', 'inst-existing', 'office', 1, 1, 1)",
    );
    await store.sqlRun(
      "alter table name_reservations add constraint legacy_one_office unique (account_id)",
    );
    await store.close();

    await migrateMultiOfficeReservations(ownerDsn);
    await migrateMultiOfficeReservations(ownerDsn);

    const migrated = await Store.open(ownerDsn);
    expect(
      await migrated.sqlAll<{ name: string }>(
        "select name from name_reservations order by name",
      ),
    ).toEqual([{ name: "test-nil" }]);
    await migrated.sqlRun(
      "insert into name_reservations " +
        "(name, id, account_id, instance_id, plan, version, created_at, updated_at) " +
        "values ('test-nil-two', 'res-second', 'acct-existing', 'inst-second', 'office', 1, 2, 2)",
    );
    expect(
      migrated.sqlRun(
        "insert into name_reservations " +
          "(name, id, account_id, instance_id, plan, version, created_at, updated_at) " +
          "values ('test-nil', 'res-collision', 'acct-existing', 'inst-third', 'office', 1, 3, 3)",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await migrated.close();
  });

  // THE ONE THAT WAS VOID. Under the privilege view, a role holding nothing on
  // `stripe_events` saw zero columns for it and skipped the check - which was
  // the deployed provisioner's own situation until it began serving the Stripe
  // webhook. The catalog answers for a table the session cannot read a single
  // row of, which is what makes the check mean something in production.
  test("a table the role holds NO privilege on is still inspected", async () => {
    const { ownerDsn, roleDsn, schema } = await bootstrappedAndRole(
      GRANTS_WITHOUT_STRIPE_EVENTS,
    );
    // Proof of the premise, not an assumption: this role cannot select from it.
    const asRole = new pg.Pool({ connectionString: roleDsn, max: 1 });
    asRole.on("error", () => {});
    try {
      const refusal = await asRole.query("select 1 from stripe_events").then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal).toEqual(expect.objectContaining({ code: "42501" }));
    } finally {
      await asRole.end().catch(() => {});
    }

    await admin.query(
      `alter table ${quoteIdentifier(schema)}.stripe_events drop column type`,
    );
    expect(Store.openRuntime(roleDsn)).rejects.toThrow(
      /stripe_events has no type column/,
    );
    // And the owner, whose privilege view showed the column all along, refuses
    // for the same reason - the check no longer depends on who is asking.
    expect(Store.openRuntime(ownerDsn)).rejects.toThrow(
      /stripe_events has no type column/,
    );
  });

  test("a missing column on a GRANTED table refuses", async () => {
    const { roleDsn, schema } = await bootstrappedAndRole();
    await admin.query(
      `alter table ${quoteIdentifier(schema)}.operations drop column absolute_flagged`,
    );
    expect(Store.openRuntime(roleDsn)).rejects.toThrow(
      /operations has no absolute_flagged column/,
    );
  });

  test("the owner migration repairs the customer SSH carriage columns", async () => {
    const { ownerDsn, roleDsn, schema } = await bootstrappedAndRole();
    await admin.query(
      `alter table ${quoteIdentifier(schema)}.instances drop column customer_ssh_key`,
    );
    expect(Store.openRuntime(roleDsn)).rejects.toThrow(
      /instances has no customer_ssh_key column/,
    );
    await migrateCustomerSshKeyColumns(ownerDsn);
    const store = await Store.openRuntime(roleDsn);
    await store.close();
  });

  test("runtime refuses cancellation schema before the owner migration", async () => {
    const { ownerDsn, roleDsn, schema } = await bootstrappedAndRole();
    await admin.query(
      `drop index ${quoteIdentifier(schema)}.provider_assets_provider_id_unique`,
    );
    await admin.query(
      `alter table ${quoteIdentifier(schema)}.subscriptions drop column cancellation_policy`,
    );
    expect(Store.openRuntime(roleDsn)).rejects.toThrow(
      /subscriptions has no cancellation_policy column/,
    );
    await migrateHostedCancellationPolicy(ownerDsn, 1_786_579_200_000);
    const store = await Store.openRuntime(roleDsn);
    await store.close();
  });

  test("runtime separately refuses a missing provider-ID unique index", async () => {
    const { roleDsn, schema } = await bootstrappedAndRole();
    await admin.query(
      `drop index ${quoteIdentifier(schema)}.provider_assets_provider_id_unique`,
    );
    expect(Store.openRuntime(roleDsn)).rejects.toThrow(
      /no valid unique provider-ID index/,
    );
  });

  test("cancellation migration keeps its first cutover on a rerun", async () => {
    const { ownerDsn, schema } = await bootstrappedAndRole();
    await migrateHostedCancellationPolicy(ownerDsn, 111);
    await migrateHostedCancellationPolicy(ownerDsn, 222);
    const result = await admin.query<{ value: string }>(
      `select value from ${quoteIdentifier(schema)}.schema_meta ` +
        `where key = 'hosted_cancellation_policy_cutover_ms'`,
    );
    expect(result.rows[0]?.value).toBe("111");
  });

  // THE ONE THE FIRST FIX STILL MISSED. `name_reservations` has no entry in the
  // required-COLUMN list, so a check whose table set came from that list never
  // asked about it - and it is the very table the 2026-08-12 incident was
  // about: the provisioner would boot cleanly and fail on the first invite.
  // Existence is asked of the whole product roster for this reason.
  test("a table with no version column of its own must still be there", async () => {
    const { roleDsn, schema } = await bootstrappedAndRole();
    await admin.query(
      `drop table ${quoteIdentifier(schema)}.name_reservations cascade`,
    );
    expect(Store.openRuntime(roleDsn)).rejects.toThrow(
      /has no name_reservations table/,
    );
  });

  // Every table in the roster, one at a time: a roster entry that is never
  // asked about is the defect above wearing a different table's name.
  test("every table in the product roster is asked about", async () => {
    for (const table of PRODUCT_TABLES) {
      const { roleDsn, schema } = await bootstrappedAndRole();
      await admin.query(
        `drop table ${quoteIdentifier(schema)}.${quoteIdentifier(table)} cascade`,
      );
      const refusal = await Store.openRuntime(roleDsn).then(
        () => "opened",
        (err: Error) => err.message,
      );
      expect([table, refusal.includes(`has no ${table} table`)]).toEqual([
        table,
        true,
      ]);
      await releaseTestStores();
    }
  }, 60_000);

  // A MISSING TABLE USED TO PASS, for everyone: it answers zero columns exactly
  // as an unprivileged one does, and the old guard read that as "not ours".
  test("a required table that is not there refuses", async () => {
    const { roleDsn, schema } = await bootstrappedAndRole();
    await admin.query(
      `drop table ${quoteIdentifier(schema)}.subscriptions cascade`,
    );
    expect(Store.openRuntime(roleDsn)).rejects.toThrow(
      /has no subscriptions table/,
    );
  });

  // A VIEW IS NOT A TABLE. Something carrying the right name and the right
  // column names is not something a statement can write to, and a check that
  // accepted it would report a database this build can run against when it
  // cannot.
  test("a view wearing a required table's name refuses", async () => {
    const { roleDsn, schema } = await bootstrappedAndRole();
    const q = quoteIdentifier(schema);
    await admin.query(`drop table ${q}.stripe_events cascade`);
    await admin.query(
      `create view ${q}.stripe_events as select 'x'::text as id, 'y'::text as type`,
    );
    expect(Store.openRuntime(roleDsn)).rejects.toThrow(
      /has no stripe_events table/,
    );
  });

  // The check runs on the runtime path, which may write NOTHING - not a table,
  // not an index, not the audit seed.
  test("the check writes nothing on the way through", async () => {
    const { roleDsn, schema } = await bootstrappedAndRole();
    const before = await admin.query<{ n: string }>(
      "select count(*)::text as n from pg_class c join pg_namespace n " +
        "on n.oid = c.relnamespace where n.nspname = $1",
      [schema],
    );
    const store = await Store.openRuntime(roleDsn);
    await store.close();
    const after = await admin.query<{ n: string }>(
      "select count(*)::text as n from pg_class c join pg_namespace n " +
        "on n.oid = c.relnamespace where n.nspname = $1",
      [schema],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
