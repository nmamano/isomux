// Applying the posture to a real database: the order it needs, the atomicity it
// needs, and the convergence that makes the matrix a destination rather than a
// floor.
//
// Every case here was a reviewer finding on a version that looked right:
//
//   - a fresh bootstrap ran the GRANTS before the schema existed, so the first
//     `grant ... on accounts` met a table that had not been created yet. It
//     worked everywhere the schema was already there, which is every database
//     anybody had run it against;
//   - the statements went out as separate autocommits, and a mid-list refusal
//     had already been MEASURED to leave half a posture behind;
//   - `GRANT` only adds, so narrowing the matrix and re-running left the wider
//     privilege in the catalog while this repo's static tests went on asserting
//     it was absent;
//   - `ALTER ROLE ... SET` replaces only the settings it names, so a stale
//     entry survived a rerun - and `Store.openRuntime` then refuses the role,
//     because it requires EXACTLY the governed pair.
//
// LOCAL ENGINE ONLY, for the same reason as store-governance.test.ts: these
// create and drop roles, and a shared managed branch is not the place for it.

import { afterAll, describe, expect, test } from "bun:test";
import pg from "pg";
import {
  EXPECTED_TABLES,
  applyGrantMatrix,
  applyGovernance,
  applyRolePosture,
  bootstrapDatabase,
} from "./bootstrap.ts";
import {
  ALL_VERBS,
  type EffectiveRow,
  PROVISIONER_ROLE,
  WEB_GRANTS,
  WEB_ROLE,
  boundsAreExact,
  effectivePrivilegeSql,
  judgeEffective,
  judgeMatrix,
  matrixSql,
} from "./roles.ts";
import { GOVERNED_SETTINGS, Store } from "./store.ts";
import { LOCAL_DATABASE_URL, TARGET_IS_LOCAL } from "./testing/pg.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

/**
 * A database per case, and a LOCK around every case that mutates a role.
 *
 * The database is for the schema; it does NOT isolate roles, and an earlier
 * version of this comment claimed it did. Roles are cluster-wide: two cases
 * governing `cp_web` in parallel would be one case watching the other's
 * catalog, whatever database each was connected to. So every mutating case runs
 * through `serial`, which is the only thing here that makes a BEFORE snapshot
 * mean anything.
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const admin = new pg.Pool({ connectionString: LOCAL_DATABASE_URL, max: 2 });
admin.on("error", () => {});
const databases: string[] = [];

async function scratchDatabase(): Promise<string> {
  const name = `cp_gov_${Math.random().toString(36).slice(2, 10)}`;
  await admin.query(`create database ${name}`);
  databases.push(name);
  const url = new URL(LOCAL_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function ask<T extends pg.QueryResultRow>(
  dsn: string,
  sql: string,
  args: unknown[] = [],
): Promise<T[]> {
  const pool = new pg.Pool({ connectionString: dsn, max: 2 });
  pool.on("error", () => {});
  try {
    return (await pool.query<T>(sql, args)).rows;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function dropRoles(dsn: string): Promise<void> {
  for (const role of [WEB_ROLE, PROVISIONER_ROLE]) {
    await ask(
      dsn,
      `revoke all privileges on all tables in schema public from ${role}`,
    ).catch(() => []);
    await ask(dsn, `revoke all privileges on schema public from ${role}`).catch(
      () => [],
    );
    await ask(dsn, `drop role if exists ${role}`).catch(() => []);
  }
}

afterAll(async () => {
  for (const name of databases) {
    const url = new URL(LOCAL_DATABASE_URL);
    url.pathname = `/${name}`;
    await dropRoles(url.toString());
    await admin
      .query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1",
        [name],
      )
      .catch(() => {});
    await admin.query(`drop database if exists ${name}`).catch(() => {});
  }
  await admin.end().catch(() => {});
});

suite("a fresh, empty database", () => {
  // THE ONE THAT WAS BROKEN. Nothing in this repo had ever run the posture
  // against a database with no tables, because every database anybody had was
  // already bootstrapped.
  test(
    "bootstraps to schema-ready with the roles governed and granted",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        const result = await bootstrapDatabase(dsn);
        expect(result.schemaReady).toBe(true);
        expect(result.zeroUserData).toBe(true);

        const roles = await ask<{
          role: string;
          limit: number;
          config: string[] | null;
        }>(
          dsn,
          "select rolname as role, rolconnlimit as limit, rolconfig as config " +
            "from pg_roles where rolname = any($1)",
          [[WEB_ROLE, PROVISIONER_ROLE]],
        );
        expect(roles.length).toBe(2);
        for (const row of roles) {
          expect(boundsAreExact(row.config ?? [], GOVERNED_SETTINGS)).toBe(
            true,
          );
          expect(row.limit).toBeGreaterThan(0);
        }

        const matrix = await ask<{ role: string; table: string; verb: string }>(
          dsn,
          matrixSql(),
          [[WEB_ROLE, PROVISIONER_ROLE]],
        );
        expect(judgeMatrix(matrix, WEB_ROLE, WEB_GRANTS).exact).toBe(true);
        await dropRoles(dsn);
      }),
    30_000,
  );

  test(
    "the grant phase alone cannot run before the schema exists",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await applyRolePosture(dsn);
        // The roles exist and are governed; the tables do not exist yet.
        expect(applyGrantMatrix(dsn)).rejects.toThrow();
        await dropRoles(dsn);
      }),
    30_000,
  );
});

suite("an existing database from before cancellation launch", () => {
  test(
    "bootstrap migrates the old shape before its runtime schema gate",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await bootstrapDatabase(dsn);
        await ask(
          dsn,
          "delete from schema_meta where key = 'hosted_cancellation_policy_cutover_ms'",
        );
        await ask(dsn, "drop index provider_assets_provider_id_unique");
        await ask(
          dsn,
          "alter table subscriptions drop column cancellation_policy",
        );

        const result = await bootstrapDatabase(dsn);
        expect(result.schemaReady).toBe(true);
        const column = await ask<{ n: string }>(
          dsn,
          "select count(*)::text as n from information_schema.columns " +
            "where table_schema = current_schema() and table_name = 'subscriptions' " +
            "and column_name = 'cancellation_policy'",
        );
        expect(column[0]?.n).toBe("1");
      }),
    30_000,
  );
});

suite("the migration is one transaction or none of it", () => {
  test(
    "a statement that fails leaves NO partial catalog change",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await (await Store.open(dsn)).close();
        // ROLES ARE CLUSTER-WIDE, so this case owns neither the runtime roles nor
        // the owner's configuration until it says so: both are read BEFORE, and the
        // claim is that the failed transaction left them exactly as they were.
        await dropRoles(dsn);
        const ownerBefore =
          (
            await ask<{ config: string[] | null }>(
              dsn,
              "select rolconfig as config from pg_roles where rolname = current_user",
            )
          )[0]?.config ?? [];

        // A table the matrix names, removed so one grant in the middle of the list
        // must fail. Everything before it in the same transaction has to disappear
        // with it - which is the property the autocommit version did not have.
        await ask(dsn, "drop table subscriptions");

        expect(applyGovernance(dsn)).rejects.toThrow();

        const roles = await ask<{ n: string }>(
          dsn,
          "select count(*)::text as n from pg_roles where rolname = any($1)",
          [[WEB_ROLE, PROVISIONER_ROLE]],
        );
        expect(roles[0]?.n).toBe("0");
        const ownerAfter =
          (
            await ask<{ config: string[] | null }>(
              dsn,
              "select rolconfig as config from pg_roles where rolname = current_user",
            )
          )[0]?.config ?? [];
        expect(ownerAfter).toEqual(ownerBefore);
      }),
    30_000,
  );
});

suite("a name that is already taken is not taken over", () => {
  // THESE ARE CLUSTER-GLOBAL NAMES. `create if absent` followed by `reset all`
  // and a fresh grant set would adopt whatever role happened to be sitting
  // there - including one another system is authenticating as - and every
  // symptom of that would look like a successful posture change.
  test(
    "a same-named role that can LOG IN refuses, and nothing is written",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await (await Store.open(dsn)).close();
        await dropRoles(dsn);
        await ask(dsn, `create role ${WEB_ROLE} login password 'not-ours'`);
        try {
          expect(applyGovernance(dsn)).rejects.toThrow(/inert residue/);
          const still = await ask<{ login: boolean; config: string[] | null }>(
            dsn,
            "select rolcanlogin as login, rolconfig as config from pg_roles where rolname = $1",
            [WEB_ROLE],
          );
          // Untouched: still a login role, still carrying nothing of ours.
          expect(still[0]?.login).toBe(true);
          expect(still[0]?.config ?? []).toEqual([]);
          const other = await ask<{ n: string }>(
            dsn,
            "select count(*)::text as n from pg_roles where rolname = $1",
            [PROVISIONER_ROLE],
          );
          expect(other[0]?.n).toBe("0");
        } finally {
          await dropRoles(dsn);
        }
      }),
    30_000,
  );

  test(
    "a same-named role that OWNS an object refuses",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await (await Store.open(dsn)).close();
        await dropRoles(dsn);
        await ask(dsn, `create role ${WEB_ROLE} nologin`);
        await ask(dsn, `grant create on schema public to ${WEB_ROLE}`);
        await ask(dsn, `create table someone_elses (id text) `);
        await ask(dsn, `alter table someone_elses owner to ${WEB_ROLE}`);
        try {
          expect(applyGovernance(dsn)).rejects.toThrow(/inert residue/);
        } finally {
          await ask(dsn, "drop table if exists someone_elses").catch(() => []);
          await dropRoles(dsn);
        }
      }),
    30_000,
  );
});

suite("a privilege PUBLIC holds is a privilege every role holds", () => {
  // The direct-grant read would have said `exact` here: the grant is not TO the
  // role, so it is not in the role's row of `table_privileges` - and the web
  // tier could delete rows the matrix says it may only read.
  test(
    "a PUBLIC grant on a product table refuses rather than being edited away",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await (await Store.open(dsn)).close();
        await dropRoles(dsn);
        await ask(dsn, "grant delete on subscriptions to public");
        try {
          expect(applyGovernance(dsn)).rejects.toThrow(
            /PUBLIC holds privileges/,
          );
          // The public ACL is not this build's to edit, so it is still there.
          const held = await ask<{ v: boolean }>(
            dsn,
            "select has_table_privilege('public', 'subscriptions', 'delete') as v",
          );
          expect(held[0]?.v).toBe(true);
          const roles = await ask<{ n: string }>(
            dsn,
            "select count(*)::text as n from pg_roles where rolname = any($1)",
            [[WEB_ROLE, PROVISIONER_ROLE]],
          );
          expect(roles[0]?.n).toBe("0");
        } finally {
          await ask(dsn, "revoke delete on subscriptions from public").catch(
            () => [],
          );
        }
      }),
    30_000,
  );

  test(
    "the effective sweep sees a PUBLIC verb the direct matrix cannot",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await bootstrapDatabase(dsn);
        await ask(dsn, "grant delete on subscriptions to public");
        try {
          const direct = await ask<{
            role: string;
            table: string;
            verb: string;
          }>(dsn, matrixSql(), [[WEB_ROLE, PROVISIONER_ROLE]]);
          const effective = await ask<EffectiveRow>(
            dsn,
            effectivePrivilegeSql(),
            [
              [WEB_ROLE, PROVISIONER_ROLE],
              [...EXPECTED_TABLES],
              [...ALL_VERBS],
            ],
          );
          // The direct read is blind to it; the effective one is not.
          expect(judgeMatrix(direct, WEB_ROLE, WEB_GRANTS).exact).toBe(true);
          expect(judgeEffective(effective, WEB_ROLE, WEB_GRANTS).excess).toBe(
            1,
          );
        } finally {
          await ask(dsn, "revoke delete on subscriptions from public").catch(
            () => [],
          );
          await dropRoles(dsn);
        }
      }),
    30_000,
  );
});

suite("the bootstrap report is evidence, not a summary of intent", () => {
  // The drifted-role cases are unit tests over `governedRoleCount` in
  // roles.test.ts, and deliberately so: a SECOND bootstrap converges the drift
  // away before it reports, which is the behaviour we want and makes it the
  // wrong instrument for asking what the report can distinguish.
  test(
    "a clean bootstrap reports both roles exact",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        try {
          const result = await bootstrapDatabase(dsn);
          expect(result.governance.roles).toBe(2);
          expect(result.governanceExact).toBe(true);
        } finally {
          await dropRoles(dsn);
        }
      }),
    30_000,
  );
});

suite("a role other roles belong to is not adoptable", () => {
  // The membership direction the first version missed. Adopting this role and
  // granting it the matrix would hand every one of its members the app's
  // privileges, silently.
  test(
    "another role being a MEMBER of cp_web refuses, and nothing is written",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await (await Store.open(dsn)).close();
        await dropRoles(dsn);
        await ask(dsn, `create role ${WEB_ROLE} nologin`);
        await ask(dsn, "create role cp_probe_member nologin");
        await ask(dsn, `grant ${WEB_ROLE} to cp_probe_member`);
        try {
          expect(applyGovernance(dsn)).rejects.toThrow(/inert residue/);
          const config = await ask<{ config: string[] | null; limit: number }>(
            dsn,
            "select rolconfig as config, rolconnlimit as limit from pg_roles where rolname = $1",
            [WEB_ROLE],
          );
          expect(config[0]?.config ?? []).toEqual([]);
          expect(config[0]?.limit).toBe(-1);
        } finally {
          await ask(dsn, `revoke ${WEB_ROLE} from cp_probe_member`).catch(
            () => [],
          );
          await ask(dsn, "drop role if exists cp_probe_member").catch(() => []);
          await dropRoles(dsn);
        }
      }),
    30_000,
  );

  test(
    "a role that owns a SCHEMA refuses",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await (await Store.open(dsn)).close();
        await dropRoles(dsn);
        await ask(dsn, `create role ${WEB_ROLE} nologin`);
        await ask(dsn, `create schema someone_elses authorization ${WEB_ROLE}`);
        try {
          expect(applyGovernance(dsn)).rejects.toThrow(/inert residue/);
        } finally {
          await ask(dsn, "drop schema if exists someone_elses cascade").catch(
            () => [],
          );
          await dropRoles(dsn);
        }
      }),
    30_000,
  );
});

suite("the posture converges rather than accumulating", () => {
  test(
    "an excess table privilege is REVOKED by a rerun",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await bootstrapDatabase(dsn);
        // A privilege the matrix does not carry, granted by hand: a delete on a
        // table the web tier may only read, which is exactly the shape a narrowed
        // matrix would leave behind.
        await ask(dsn, `grant delete on subscriptions to ${WEB_ROLE}`);
        let matrix = await ask<{ role: string; table: string; verb: string }>(
          dsn,
          matrixSql(),
          [[WEB_ROLE, PROVISIONER_ROLE]],
        );
        expect(judgeMatrix(matrix, WEB_ROLE, WEB_GRANTS).excess).toBe(1);

        await applyGovernance(dsn);

        matrix = await ask<{ role: string; table: string; verb: string }>(
          dsn,
          matrixSql(),
          [[WEB_ROLE, PROVISIONER_ROLE]],
        );
        const verdict = judgeMatrix(matrix, WEB_ROLE, WEB_GRANTS);
        expect(verdict.excess).toBe(0);
        expect(verdict.exact).toBe(true);
        await dropRoles(dsn);
      }),
    30_000,
  );

  // The one that would have made the posture refuse ITSELF: a stale rolconfig
  // entry survives `ALTER ROLE ... SET`, and `openRuntime` requires exactly the
  // governed pair - so the role this program had just declared governed would
  // have been refused at the next boot.
  test(
    "an excess role setting is erased by a rerun",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await bootstrapDatabase(dsn);
        await ask(dsn, `alter role ${WEB_ROLE} set lock_timeout = '5s'`);
        let config = await ask<{ config: string[] | null }>(
          dsn,
          "select rolconfig as config from pg_roles where rolname = $1",
          [WEB_ROLE],
        );
        expect(boundsAreExact(config[0]?.config ?? [], GOVERNED_SETTINGS)).toBe(
          false,
        );

        await applyGovernance(dsn);

        config = await ask<{ config: string[] | null }>(
          dsn,
          "select rolconfig as config from pg_roles where rolname = $1",
          [WEB_ROLE],
        );
        expect(boundsAreExact(config[0]?.config ?? [], GOVERNED_SETTINGS)).toBe(
          true,
        );
        await dropRoles(dsn);
      }),
    30_000,
  );

  // The owner is NOT converged: its configuration can carry things this build
  // did not put there, and erasing them silently is not a posture change.
  test(
    "an owner carrying unknown configuration REFUSES before mutating",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await (await Store.open(dsn)).close();
        await ask(dsn, "alter role current_user set lock_timeout = '5s'");
        try {
          expect(applyGovernance(dsn)).rejects.toThrow(/did not put there/);
          const roles = await ask<{ n: string }>(
            dsn,
            "select count(*)::text as n from pg_roles where rolname = any($1)",
            [[WEB_ROLE, PROVISIONER_ROLE]],
          );
          expect(roles[0]?.n).toBe("0");
        } finally {
          await ask(dsn, "alter role current_user reset lock_timeout").catch(
            () => [],
          );
        }
      }),
    30_000,
  );
});
