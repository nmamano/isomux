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
//   - `ALTER ROLE ... SET` replaces only the settings it names, so a stale
//     entry survived a rerun - and `Store.openRuntime` then refuses the role,
//     because it requires EXACTLY the governed pair.
//
// Converging the grants of a deployed database, and refusing a runtime
// identity that is not an inert residue, are staged in
// governance-converge.test.ts through `convergeMatrix`, which every redeploy
// runs.
//
// LOCAL ENGINE ONLY, for the same reason as store-governance.test.ts: these
// create and drop roles, and a shared managed branch is not the place for it.
// The local engine is still one shared PostgreSQL cluster, so these tests are
// collision-free rather than hermetic: each serialized case owns fresh role
// names and cleanup proves those names are gone without touching production
// defaults.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import {
  EXPECTED_TABLES,
  applyGrantMatrix,
  bootstrapDatabase,
} from "./bootstrap.ts";
import {
  ALL_VERBS,
  type EffectiveRow,
  type MatrixRow,
  PROVISIONER_BUDGET,
  PROVISIONER_GRANTS,
  PROVISIONER_ROLE,
  type RolePosture,
  WEB_BUDGET,
  WEB_GRANTS,
  WEB_ROLE,
  boundsAreExact,
  effectivePrivilegeSql,
  judgeEffective,
  judgeMatrix,
  matrixSql,
} from "./roles.ts";
import { GOVERNED_SETTINGS } from "./store.ts";
import {
  LOCAL_DATABASE_URL,
  PG_DROP_DATABASE_HOOK_TIMEOUT_MS,
  TARGET_IS_LOCAL,
  inCleanupPool,
} from "./testing/pg.ts";
import { ownedScratchDatabase } from "./testing/case-owner.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

function caseNames(): { roster: readonly RolePosture[] } {
  const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    roster: [
      { role: `cp_gw_${suffix}`, budget: WEB_BUDGET, grants: WEB_GRANTS },
      {
        role: `cp_gp_${suffix}`,
        budget: PROVISIONER_BUDGET,
        grants: PROVISIONER_GRANTS,
      },
    ],
  };
}

let TEST_ROSTER: readonly RolePosture[] = [];
let TEST_WEB_ROLE = "";
let TEST_PROVISIONER_ROLE = "";

/**
 * A database per case, its own owner, and its own role names.
 *
 * The database is for the schema; it does NOT isolate roles, and an earlier
 * version of this comment claimed it did. Roles are cluster-wide: two cases
 * governing `cp_web` in parallel would be one case watching the other's
 * catalog, whatever database each was connected to. So every mutating case runs
 * through `serial`, which is the only thing here that makes a BEFORE snapshot
 * mean anything. Other processes cannot see `serial`, so each case also
 * governs role names and an owner (`ownedScratchDatabase`) no other process
 * uses.
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> => {
    const names = caseNames();
    TEST_ROSTER = names.roster;
    TEST_WEB_ROLE = names.roster[0].role;
    TEST_PROVISIONER_ROLE = names.roster[1].role;
    return fn();
  };
  const next = queue.then(run, run);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const admin = new pg.Pool({ connectionString: LOCAL_DATABASE_URL, max: 2 });
admin.on("error", () => {});
const databases: {
  name: string;
  roster: readonly RolePosture[];
  owner: string;
}[] = [];
let productionRolesBefore: Record<string, unknown>[] = [];

async function productionRoleSnapshot(): Promise<Record<string, unknown>[]> {
  return (
    await admin.query(
      "select rolname, rolcanlogin, rolconnlimit, rolconfig from pg_roles " +
        "where rolname = any($1) order by rolname",
      [[WEB_ROLE, PROVISIONER_ROLE]],
    )
  ).rows;
}

beforeAll(async () => {
  productionRolesBefore = await productionRoleSnapshot();
});

/** What a refused call said, awaited: a case that moved on while the call was
 * still running would read the catalog mid-call, and let the next case start
 * under it. */
const NO_REFUSAL = "it did not refuse";
async function refusal(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => NO_REFUSAL,
    (err: Error) => err.message,
  );
}

async function scratchDatabase(): Promise<string> {
  const { name, owner, dsn } = await ownedScratchDatabase(admin, "cp_gov");
  databases.push({ name, roster: TEST_ROSTER, owner });
  return dsn;
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

async function dropRoles(
  dsn: string,
  roster: readonly RolePosture[] = TEST_ROSTER,
): Promise<void> {
  for (const role of roster.map((entry) => entry.role)) {
    if (role === WEB_ROLE || role === PROVISIONER_ROLE) {
      throw new Error(`refusing to drop production runtime role ${role}`);
    }
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
  // try/finally: a failing final expect must not leak the admin pool.
  try {
    await inCleanupPool(databases, async (entry) => {
      const { name, roster, owner } = entry;
      const url = new URL(LOCAL_DATABASE_URL);
      url.pathname = `/${name}`;
      if ([WEB_ROLE, PROVISIONER_ROLE].includes(owner)) {
        throw new Error("refusing to drop a production runtime role");
      }
      await dropRoles(url.toString(), roster);
      await admin
        .query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1",
          [name],
        )
        .catch(() => {});
      await admin.query(`drop database if exists ${name}`).catch(() => {});
      // Last: the database and the runtime roles are gone.
      await admin.query(`drop role if exists ${owner}`).catch(() => {});
    });
    const testNames = databases.flatMap(({ roster, owner }) => [
      ...roster.map((entry) => entry.role),
      owner,
    ]);
    const leftovers = await admin.query<{ n: string }>(
      "select count(*)::text as n from pg_roles where rolname = any($1)",
      [testNames],
    );
    expect(leftovers.rows[0]?.n).toBe("0");
    expect(await productionRoleSnapshot()).toEqual(productionRolesBefore);
  } finally {
    await admin.end().catch(() => {});
  }
  // This hook drops one database per case: see PG_DROP_DATABASE_HOOK_TIMEOUT_MS.
}, PG_DROP_DATABASE_HOOK_TIMEOUT_MS);

suite("a fresh, empty database", () => {
  // THE ONE THAT WAS BROKEN. Nothing in this repo had ever run the posture
  // against a database with no tables, because every database anybody had was
  // already bootstrapped.
  test(
    "bootstraps to schema-ready with the roles governed and granted",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        const result = await bootstrapDatabase(dsn, TEST_ROSTER);
        expect(result.schemaReady).toBe(true);
        expect(result.zeroUserData).toBe(true);
        expect(result.governance.roles).toBe(2);
        expect(result.governanceExact).toBe(true);

        // The owner is this case's own (ownedScratchDatabase), and it carries
        // the governed bounds too.
        const [owner] = await ask<{ config: string[] | null }>(
          dsn,
          "select rolconfig as config from pg_roles where rolname = current_user",
        );
        expect(boundsAreExact(owner.config ?? [], GOVERNED_SETTINGS)).toBe(
          true,
        );

        const roles = await ask<{
          role: string;
          limit: number;
          config: string[] | null;
        }>(
          dsn,
          "select rolname as role, rolconnlimit as limit, rolconfig as config " +
            "from pg_roles where rolname = any($1)",
          [[TEST_WEB_ROLE, TEST_PROVISIONER_ROLE]],
        );
        expect(roles.length).toBe(2);
        for (const row of roles) {
          expect(boundsAreExact(row.config ?? [], GOVERNED_SETTINGS)).toBe(
            true,
          );
          expect(row.limit).toBeGreaterThan(0);
        }

        const matrix = await ask<MatrixRow>(dsn, matrixSql(), [
          [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE],
        ]);
        expect(judgeMatrix(matrix, TEST_WEB_ROLE, WEB_GRANTS).exact).toBe(true);
        // The provisioner's reservation UPDATE is per column (2026-10-08), so
        // both reads have to see column grants for this to hold.
        expect(
          judgeMatrix(matrix, TEST_PROVISIONER_ROLE, PROVISIONER_GRANTS),
        ).toEqual({ missing: 0, excess: 0, exact: true });
        const effective = await ask<EffectiveRow>(
          dsn,
          effectivePrivilegeSql(),
          [
            [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE],
            [...EXPECTED_TABLES],
            [...ALL_VERBS],
          ],
        );
        for (const { role, grants } of TEST_ROSTER) {
          expect(judgeEffective(effective, role, grants)).toEqual({
            missing: 0,
            excess: 0,
            exact: true,
          });
        }
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
        await bootstrapDatabase(dsn, TEST_ROSTER);
        await ask(
          dsn,
          "delete from schema_meta where key = 'hosted_cancellation_policy_cutover_ms'",
        );
        await ask(dsn, "drop index provider_assets_provider_id_unique");
        await ask(
          dsn,
          "alter table subscriptions drop column cancellation_policy",
        );

        const result = await bootstrapDatabase(dsn, TEST_ROSTER);
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

suite("a phase is one transaction or none of it", () => {
  test(
    "a grant phase that fails leaves NO partial catalog change",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await bootstrapDatabase(dsn, TEST_ROSTER);
        // A table the matrix names, removed so one grant in the middle of the
        // list must fail. The phase REVOKES every privilege first, so the
        // autocommit version would leave both roles holding nothing.
        await ask(dsn, "drop table subscriptions");
        const grants = async () =>
          (
            await ask<MatrixRow>(dsn, matrixSql(), [
              [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE],
            ])
          )
            .map((r) => `${r.role}:${r.table}:${r.column ?? ""}:${r.verb}`)
            .sort();
        const before = await grants();
        expect(before.length).toBeGreaterThan(10);

        // 42P01: the missing table, not some earlier refusal.
        expect(await refusal(applyGrantMatrix(dsn, TEST_ROSTER))).toMatch(
          /42P01/,
        );
        expect(await grants()).toEqual(before);
        await dropRoles(dsn);
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
        await ask(
          dsn,
          `create role ${TEST_WEB_ROLE} login password 'not-ours'`,
        );
        try {
          expect(await refusal(bootstrapDatabase(dsn, TEST_ROSTER))).toMatch(
            /inert residue/,
          );
          const still = await ask<{ login: boolean; config: string[] | null }>(
            dsn,
            "select rolcanlogin as login, rolconfig as config from pg_roles where rolname = $1",
            [TEST_WEB_ROLE],
          );
          // Untouched: still a login role, still carrying nothing of ours.
          expect(still[0]?.login).toBe(true);
          expect(still[0]?.config ?? []).toEqual([]);
          const other = await ask<{ n: string }>(
            dsn,
            "select count(*)::text as n from pg_roles where rolname = $1",
            [TEST_PROVISIONER_ROLE],
          );
          expect(other[0]?.n).toBe("0");
        } finally {
          await dropRoles(dsn);
        }
      }),
    30_000,
  );
});

suite("a privilege PUBLIC holds is a privilege every role holds", () => {
  // The direct-grant read would have said `exact` here: the grant is not TO the
  // role, so it is not in the role's row of `table_privileges` - and the web
  // tier could delete rows the matrix says it may only read. That the converge
  // refuses it is in governance-converge.test.ts.
  test(
    "the effective sweep sees a PUBLIC verb and a PUBLIC column grant the direct matrix cannot",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await bootstrapDatabase(dsn, TEST_ROSTER);
        await ask(dsn, "grant delete on subscriptions to public");
        await ask(dsn, "grant update (name) on name_reservations to public");
        try {
          const direct = await ask<MatrixRow>(dsn, matrixSql(), [
            [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE],
          ]);
          const effective = await ask<EffectiveRow>(
            dsn,
            effectivePrivilegeSql(),
            [
              [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE],
              [...EXPECTED_TABLES],
              [...ALL_VERBS],
            ],
          );
          expect(judgeMatrix(direct, TEST_WEB_ROLE, WEB_GRANTS).exact).toBe(
            true,
          );
          expect(
            judgeMatrix(direct, TEST_PROVISIONER_ROLE, PROVISIONER_GRANTS)
              .exact,
          ).toBe(true);
          // The web role: the delete. The provisioner: the delete and the
          // column it may not update.
          expect(judgeEffective(effective, TEST_WEB_ROLE, WEB_GRANTS)).toEqual({
            missing: 0,
            excess: 1,
            exact: false,
          });
          expect(
            judgeEffective(
              effective,
              TEST_PROVISIONER_ROLE,
              PROVISIONER_GRANTS,
            ),
          ).toEqual({ missing: 0, excess: 2, exact: false });
        } finally {
          await ask(dsn, "revoke delete on subscriptions from public").catch(
            () => [],
          );
          await ask(
            dsn,
            "revoke update (name) on name_reservations from public",
          ).catch(() => []);
          await dropRoles(dsn);
        }
      }),
    30_000,
  );
});

suite("a bootstrap rerun converges the role settings", () => {
  // The one that would have made the posture refuse ITSELF: a stale rolconfig
  // entry survives `ALTER ROLE ... SET`, and `openRuntime` requires exactly the
  // governed pair - so the role this program had just declared governed would
  // have been refused at the next boot. The converge refuses this drift; only
  // a bootstrap rerun erases it.
  test(
    "an excess role setting is erased by a rerun",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        await bootstrapDatabase(dsn, TEST_ROSTER);
        await ask(dsn, `alter role ${TEST_WEB_ROLE} set lock_timeout = '5s'`);
        let config = await ask<{ config: string[] | null }>(
          dsn,
          "select rolconfig as config from pg_roles where rolname = $1",
          [TEST_WEB_ROLE],
        );
        expect(boundsAreExact(config[0]?.config ?? [], GOVERNED_SETTINGS)).toBe(
          false,
        );

        await bootstrapDatabase(dsn, TEST_ROSTER);

        config = await ask<{ config: string[] | null }>(
          dsn,
          "select rolconfig as config from pg_roles where rolname = $1",
          [TEST_WEB_ROLE],
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
        await ask(dsn, "alter role current_user set lock_timeout = '5s'");
        try {
          expect(await refusal(bootstrapDatabase(dsn, TEST_ROSTER))).toMatch(
            /did not put there/,
          );
          const roles = await ask<{ n: string }>(
            dsn,
            "select count(*)::text as n from pg_roles where rolname = any($1)",
            [[TEST_WEB_ROLE, TEST_PROVISIONER_ROLE]],
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
