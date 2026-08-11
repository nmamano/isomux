// Where a session's governed bounds are allowed to come from, and what happens
// when they are not there.
//
// The store used to acquire both bounds one way - it built the `options` string
// itself and read the answer back. On the managed engine this build deploys on,
// they now come from the ROLE, because that is the only channel a pooled
// endpoint delivers (the pooled one refuses `options` outright, SQLSTATE 08P01,
// measured 2026-08-11) and because a bound on the role applies to every session
// whether or not the caller asked for it.
//
// The risk that creates is the one these tests exist for: if a managed session
// could quietly fall back to the client-side mechanism when the role lost its
// configuration, then a reverted `ALTER ROLE` would look exactly like a healthy
// deployment. So on a managed session there is NO fallback, and the checks are
// EXACT - a missing entry, a changed value, an extra one, and a role that lost
// its configuration entirely all refuse to open.
//
// MANAGED IS SIMULATED HONESTLY. `neon.branch_id` is a namespaced setting, so a
// connection can carry one through `options` without any global state and
// without a Neon connection - the store's predicate is the presence of that
// setting, and this is the same presence it would see in production. Each test
// gets its own login role, so one test's `rolconfig` is never another's.
//
// LOCAL ENGINE ONLY. Pointed at a real managed branch this file cannot state
// its own premise: every session there reports a branch id, so the unmanaged
// half has no way to exist, and the roles it creates would be churn on a shared
// branch. It skips rather than adapting - the properties are about an engine
// whose shape the test controls.

import { afterAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { Store } from "./store.ts";
import {
  LOCAL_DATABASE_URL,
  TARGET_IS_LOCAL,
  freshDsn,
  testDsn,
} from "./testing/pg.ts";

/** Every block here needs an engine whose shape this file controls. */
const suite = TARGET_IS_LOCAL ? describe : describe.skip;

const BRANCH = "br-governance-test";
const roles: string[] = [];

/** The admin connection: the container's own owner, which is what creates and
 * drops the per-test roles. */
const admin = new pg.Pool({
  connectionString: LOCAL_DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5_000,
});
admin.on("error", () => {});

function schemaOf(dsn: string): string {
  const options = new URL(dsn).searchParams.get("options") ?? "";
  const match = options.match(/search_path=([a-z0-9_]+)/);
  if (!match) throw new Error("the test DSN carries no search_path");
  return match[1];
}

/**
 * A login role with exactly the `rolconfig` a case wants, and a DSN for it.
 *
 * `managed` decides whether the connection reports a branch id, which is the
 * store's own predicate for "this is a managed deployment". Both travel in
 * `options`, so nothing here changes a setting any other test can see.
 */
async function roleDsn(args: {
  dsn: string;
  config: string[];
  managed: boolean;
  extraOptions?: string;
}): Promise<string> {
  const schema = schemaOf(args.dsn);
  const name = `cp_gov_${Math.random().toString(36).slice(2, 10)}`;
  const password = crypto.randomUUID().replace(/-/g, "");
  await admin.query(`create role ${name} login password '${password}'`);
  roles.push(name);
  await admin.query(`grant usage on schema ${schema} to ${name}`);
  await admin.query(
    `grant select, insert, update on all tables in schema ${schema} to ${name}`,
  );
  for (const entry of args.config) {
    const [setting, value] = entry.split("=");
    await admin.query(`alter role ${name} set ${setting} = '${value}'`);
  }
  const url = new URL(args.dsn);
  url.username = name;
  url.password = password;
  const options = [
    `-c search_path=${schema}`,
    args.managed ? `-c neon.branch_id=${BRANCH}` : "",
    args.extraOptions ?? "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  url.searchParams.set("options", options);
  return url.toString();
}

const GOVERNED = [
  "statement_timeout=30s",
  "idle_in_transaction_session_timeout=30s",
];

afterAll(async () => {
  for (const name of roles) {
    // Revokes first: a role that still holds a grant refuses to drop with
    // SQLSTATE 2BP01, and `drop owned by` needs a membership the owner of these
    // tests does not have. Learned the hard way on a live branch.
    await admin
      .query(
        `revoke all privileges on all tables in schema public from ${name}`,
      )
      .catch(() => {});
    for (const schema of new Set(schemas)) {
      await admin
        .query(
          `revoke all privileges on all tables in schema ${schema} from ${name}`,
        )
        .catch(() => {});
      await admin
        .query(`revoke all privileges on schema ${schema} from ${name}`)
        .catch(() => {});
    }
    await admin.query(`drop role if exists ${name}`).catch(() => {});
  }
  await admin.end().catch(() => {});
});

const schemas: string[] = [];

suite("a managed session takes its bounds from the role, or refuses", () => {
  test("opens when the role carries exactly the governed pair", async () => {
    const dsn = await testDsn();
    schemas.push(schemaOf(dsn));
    await (await Store.open(dsn)).close();
    const asRole = await roleDsn({ dsn, config: GOVERNED, managed: true });
    const store = await Store.openRuntime(asRole);
    const bound = await store.sqlGet<{ v: string }>(
      "select current_setting('statement_timeout') as v",
    );
    expect(bound?.v).toBe("30s");
    await store.close();
  });

  test("refuses when one of the two is missing from the role", async () => {
    const dsn = await testDsn();
    schemas.push(schemaOf(dsn));
    await (await Store.open(dsn)).close();
    const asRole = await roleDsn({
      dsn,
      config: ["statement_timeout=30s"],
      managed: true,
    });
    expect(Store.openRuntime(asRole)).rejects.toThrow(/does not carry exactly/);
  });

  test("refuses a value that is not the one this build guarantees", async () => {
    const dsn = await testDsn();
    schemas.push(schemaOf(dsn));
    await (await Store.open(dsn)).close();
    const asRole = await roleDsn({
      dsn,
      config: [
        "statement_timeout=45s",
        "idle_in_transaction_session_timeout=30s",
      ],
      managed: true,
    });
    expect(Store.openRuntime(asRole)).rejects.toThrow(/does not carry exactly/);
  });

  test("refuses an EXTRA entry, because the posture is a set and not a floor", async () => {
    const dsn = await testDsn();
    schemas.push(schemaOf(dsn));
    await (await Store.open(dsn)).close();
    const asRole = await roleDsn({
      dsn,
      config: [...GOVERNED, "lock_timeout=5s"],
      managed: true,
    });
    expect(Store.openRuntime(asRole)).rejects.toThrow(/does not carry exactly/);
  });

  // THE ONE THAT MATTERS. A reverted ALTER ROLE, with a connection string that
  // still asks for both bounds the old way: the session would report them
  // correctly, and the deployment would look healthy while the guarantee that
  // every session inherits them had quietly stopped being true.
  test("refuses a reverted role even when the DSN itself asks for the bounds", async () => {
    const dsn = await testDsn();
    schemas.push(schemaOf(dsn));
    await (await Store.open(dsn)).close();
    const asRole = await roleDsn({
      dsn,
      config: [],
      managed: true,
      extraOptions:
        "-c statement_timeout=30s -c idle_in_transaction_session_timeout=30s",
    });
    expect(Store.openRuntime(asRole)).rejects.toThrow(/does not carry exactly/);
  });
});

suite("an unmanaged session keeps the mechanism it always had", () => {
  test("opens against a database with no role configuration at all", async () => {
    const store = await Store.open(await testDsn());
    const bound = await store.sqlGet<{ v: string }>(
      "select current_setting('statement_timeout') as v",
    );
    expect(bound?.v).toBe("30s");
    await store.close();
  });

  test("a role with no configuration still gets bounded sessions", async () => {
    const dsn = await testDsn();
    schemas.push(schemaOf(dsn));
    await (await Store.open(dsn)).close();
    const asRole = await roleDsn({ dsn, config: [], managed: false });
    const store = await Store.openRuntime(asRole);
    const bound = await store.sqlGet<{ v: string }>(
      "select current_setting('idle_in_transaction_session_timeout') as v",
    );
    expect(bound?.v).toBe("30s");
    await store.close();
  });
});

suite("a runtime open reads the database and does not build it", () => {
  test("refuses a database that was never bootstrapped", async () => {
    const dsn = await freshDsn();
    expect(Store.openRuntime(dsn)).rejects.toThrow();
  });

  test("creates no table on a schema that has none", async () => {
    const dsn = await freshDsn();
    await Store.openRuntime(dsn).catch(() => {});
    const schema = schemaOf(dsn);
    const tables = await admin.query<{ n: string }>(
      "select count(*)::text as n from pg_tables where schemaname = $1",
      [schema],
    );
    expect(tables.rows[0]?.n).toBe("0");
  });

  test("does not seed the audit sequence it asserts", async () => {
    const dsn = await testDsn();
    const built = await Store.open(dsn);
    await built.sqlRun("delete from sequences where name = 'audit'");
    await built.close();
    expect(Store.openRuntime(dsn)).rejects.toThrow(/audit sequence/);
    const store = await Store.open(dsn);
    await store.close();
  });
});
