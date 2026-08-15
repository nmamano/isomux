// Changing the matrix on a database that is ALREADY governed, and getting back.
//
// This is not the same operation as putting the posture on for the first time,
// and the difference is the whole reason the path exists. Production has
// carried the governed owner pair and both runtime roles since G2, so
// `govern`'s before-state - an owner carrying NOTHING - cannot truthfully hold
// there; and `ungovern` drops both roles, which is an outage lever rather than
// the reverse of one incremental grant change.
//
// The properties, each staged against a real engine:
//
//   - forward moves the catalog to EXACTLY the current matrix, and the verbs
//     the audit removed are gone rather than merely unused;
//   - reverse restores EXACTLY the old matrix, in one transaction;
//   - a round trip leaves the catalog byte for byte where it started;
//   - every precondition refuses BEFORE anything is written - the before-matrix
//     inexact, the owner's configuration not already ours, a role that can log
//     in, a budget that has drifted.
//
// LOCAL ENGINE ONLY, like the other role suites: these create and drop
// cluster-wide roles.

import { afterAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { applyGovernance, reapplyIsExact, reapplyMatrix } from "./bootstrap.ts";
import {
  PROVISIONER_GRANTS,
  PROVISIONER_ROLE,
  PRIOR_PROVISIONER_GRANTS,
  WEB_ROLE,
  grantMatrixStatements,
  judgeMatrix,
  matrixSql,
  priorRuntimeRoles,
  residueIsInert,
  roleIdentitySql,
  type RoleIdentity,
} from "./roles.ts";
import { Store } from "./store.ts";
import { LOCAL_DATABASE_URL, TARGET_IS_LOCAL } from "./testing/pg.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

/** Roles are cluster-wide, so every case that touches one runs alone. */
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
  const name = `cp_re_${Math.random().toString(36).slice(2, 10)}`;
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

async function run(dsn: string, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await ask(dsn, statement);
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
    await ask(dsn, `alter role ${role} connection limit -1`).catch(() => []);
    await ask(dsn, `alter role ${role} nologin`).catch(() => []);
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
}, 30_000);

/** A schema-ready database governed exactly as PRODUCTION is today: the roles
 * in place and the catalog carrying the PRIOR matrix. */
async function asProductionIsToday(): Promise<string> {
  const dsn = await scratchDatabase();
  await (await Store.open(dsn)).close();
  await applyGovernance(dsn);
  await run(dsn, grantMatrixStatements(priorRuntimeRoles()));
  return dsn;
}

/** Every direct grant both runtime roles hold, as a sorted set of strings, so
 * two catalogs can be compared rather than described. */
async function matrixOf(dsn: string): Promise<string[]> {
  const rows = await ask<{ role: string; table: string; verb: string }>(
    dsn,
    matrixSql(),
    [[WEB_ROLE, PROVISIONER_ROLE]],
  );
  return rows.map((r) => `${r.role}:${r.table}:${r.verb}`).sort();
}

suite("the incremental matrix change", () => {
  test(
    "forward lands exactly the current matrix and removes what the audit dropped",
    () =>
      serial(async () => {
        const dsn = await asProductionIsToday();
        const before = await matrixOf(dsn);
        expect(before).toContain(`${PROVISIONER_ROLE}:accounts:SELECT`);
        expect(before).not.toContain(
          `${PROVISIONER_ROLE}:name_reservations:SELECT`,
        );

        const applied = await reapplyMatrix(dsn, "forward");
        expect(applied.exact).toBe(true);
        for (const [, verdict] of [...applied.direct, ...applied.effective]) {
          expect(verdict.missing).toBe(0);
          expect(verdict.excess).toBe(0);
        }
        // Acceptance says the WHOLE posture, not the half the transaction
        // touched: a run that only re-read what it wrote could not see a
        // transaction that did more than it meant to.
        expect(applied.schemaUsageOnly.map(([, ok]) => ok)).toEqual([
          true,
          true,
        ]);
        expect(applied.sequencePrivilegesHeld).toBe(0);
        expect(applied.noMemberships.map(([, ok]) => ok)).toEqual([true, true]);

        const after = await matrixOf(dsn);
        // The read the live probe was refused, now granted.
        expect(after).toContain(`${PROVISIONER_ROLE}:name_reservations:SELECT`);
        // And the four the call-graph audit found unreachable, actually gone -
        // `GRANT` only adds, so this is the convergence being load-bearing.
        for (const gone of [
          "accounts:SELECT",
          "subscriptions:SELECT",
          "provider_assets:INSERT",
          "create_intents:UPDATE",
        ]) {
          expect(after).not.toContain(`${PROVISIONER_ROLE}:${gone}`);
        }
        await dropRoles(dsn);
      }),
    60_000,
  );

  test(
    "reverse restores exactly the old matrix",
    () =>
      serial(async () => {
        const dsn = await asProductionIsToday();
        await reapplyMatrix(dsn, "forward");
        const applied = await reapplyMatrix(dsn, "reverse");
        expect(applied.exact).toBe(true);
        expect(applied.schemaUsageOnly.map(([, ok]) => ok)).toEqual([
          true,
          true,
        ]);
        expect(applied.sequencePrivilegesHeld).toBe(0);
        expect(applied.noMemberships.map(([, ok]) => ok)).toEqual([true, true]);
        const rows = await ask<{ role: string; table: string; verb: string }>(
          dsn,
          matrixSql(),
          [[WEB_ROLE, PROVISIONER_ROLE]],
        );
        expect(
          judgeMatrix(rows, PROVISIONER_ROLE, PRIOR_PROVISIONER_GRANTS).exact,
        ).toBe(true);
        expect(
          judgeMatrix(rows, PROVISIONER_ROLE, PROVISIONER_GRANTS).exact,
        ).toBe(false);
        await dropRoles(dsn);
      }),
    60_000,
  );

  test(
    "a round trip leaves the catalog where it started",
    () =>
      serial(async () => {
        const dsn = await asProductionIsToday();
        const start = await matrixOf(dsn);
        await reapplyMatrix(dsn, "forward");
        await reapplyMatrix(dsn, "reverse");
        expect(await matrixOf(dsn)).toEqual(start);
        await dropRoles(dsn);
      }),
    60_000,
  );

  test(
    "the roles themselves are not touched",
    () =>
      serial(async () => {
        const dsn = await asProductionIsToday();
        const roleState = async () =>
          ask<{ role: string; limit: number; config: string[] | null }>(
            dsn,
            "select rolname as role, rolconnlimit as limit, rolconfig as config " +
              "from pg_roles where rolname = any($1) order by rolname",
            [[WEB_ROLE, PROVISIONER_ROLE]],
          );
        const before = await roleState();
        await reapplyMatrix(dsn, "forward");
        expect(await roleState()).toEqual(before);
        await dropRoles(dsn);
      }),
    60_000,
  );
});

/**
 * The FOLD, on its own.
 *
 * `reapplyMatrix` reads five kinds of fact and decides one boolean from them.
 * The facts are checked against a real engine above; the decision cannot be,
 * because "the transaction granted CREATE on the schema" is not a state a
 * database can be put into from outside. So the verdict is a pure function and
 * every field has to be able to fail it alone - otherwise a field could be
 * read, reported, and quietly left out of the answer.
 */
describe("the acceptance verdict counts every fact it reports", () => {
  const exact = { missing: 0, excess: 0, exact: true };
  const green = {
    direct: [[WEB_ROLE, exact] as [string, typeof exact]],
    effective: [[WEB_ROLE, exact] as [string, typeof exact]],
    schemaUsageOnly: [[WEB_ROLE, true] as [string, boolean]],
    sequencePrivilegesHeld: 0,
    noMemberships: [[WEB_ROLE, true] as [string, boolean]],
  };

  test("all green is exact", () => {
    expect(reapplyIsExact(green)).toBe(true);
  });

  const spoiled: [string, Partial<typeof green>][] = [
    [
      "an inexact direct matrix",
      { direct: [[WEB_ROLE, { missing: 1, excess: 0, exact: false }]] },
    ],
    [
      "an inexact effective matrix",
      { effective: [[WEB_ROLE, { missing: 0, excess: 1, exact: false }]] },
    ],
    ["CREATE on the schema", { schemaUsageOnly: [[WEB_ROLE, false]] }],
    ["a sequence privilege", { sequencePrivilegesHeld: 1 }],
    ["a membership", { noMemberships: [[WEB_ROLE, false]] }],
    ["an unreadable sequence count", { sequencePrivilegesHeld: -1 }],
  ];
  for (const [name, patch] of spoiled) {
    test(`${name} alone makes it inexact`, () => {
      expect(reapplyIsExact({ ...green, ...patch })).toBe(false);
    });
  }
});

/**
 * THE OWNER'S OWN MEMBERSHIP, staged on a real engine.
 *
 * Postgres 16+ grants a NON-SUPERUSER creator ADMIN OPTION in the role it
 * creates. The container's own owner is a superuser and records no such row, so
 * nothing in this repo could see the condition until it was measured on the
 * provider - both the Neon suites branch and production carry it (2026-08-12,
 * one member each, the owner, with admin option, owner not superuser).
 *
 * So the condition is staged here rather than asserted about: a non-superuser
 * role with CREATEROLE creates a role, and what the catalog then says is read
 * from both sides. Without this, the `<> current_user` clause in
 * `roleIdentitySql` would be exercised only in production.
 */
suite("a role created by a non-superuser owner", () => {
  test(
    "carries its creator as a member, and is still adoptable BY that creator",
    () =>
      serial(async () => {
        const dsn = await scratchDatabase();
        const creator = `cp_creator_${Math.random().toString(36).slice(2, 8)}`;
        const child = `cp_child_${Math.random().toString(36).slice(2, 8)}`;
        const password = crypto.randomUUID().replace(/-/g, "");
        await ask(
          dsn,
          `create role ${creator} login createrole password '${password}'`,
        );
        const asCreator = new URL(dsn);
        asCreator.username = creator;
        asCreator.password = password;
        try {
          // The creator, not the superuser, makes the role - which is the
          // whole point: a superuser creator records no membership at all.
          await ask(asCreator.toString(), `create role ${child} nologin`);

          const fromCreator = await ask<RoleIdentity>(
            asCreator.toString(),
            roleIdentitySql(),
            [[child]],
          );
          expect(fromCreator[0].members_of_it).toBe(1);
          // ... and it is not a third party, because it IS this session.
          expect(fromCreator[0].members_other_than_owner).toBe(0);
          expect(fromCreator[0].belongs_to).toBe(0);
          expect(residueIsInert(fromCreator[0])).toBe(true);

          // FROM ANOTHER SESSION the same row IS a third party, and the
          // predicate says so. The exemption is about who is asking, which is
          // what makes it narrow: the bootstrap asks as the owner.
          const fromSuperuser = await ask<RoleIdentity>(
            dsn,
            roleIdentitySql(),
            [[child]],
          );
          expect(fromSuperuser[0].members_of_it).toBe(1);
          expect(fromSuperuser[0].members_other_than_owner).toBe(1);
          expect(residueIsInert(fromSuperuser[0])).toBe(false);
        } finally {
          await ask(dsn, `drop role if exists ${child}`).catch(() => []);
          await ask(dsn, `drop role if exists ${creator}`).catch(() => []);
        }
      }),
    60_000,
  );
});

suite("it refuses before writing anything", () => {
  /** Every refusal case asserts the SAME two things: it threw, and the catalog
   * did not move. A precondition that refuses after mutating has already done
   * the thing it was guarding. */
  const refuses = async (
    stage: (dsn: string) => Promise<void>,
    /** WHICH refusal. A case that only asserts "it threw" passes for any
     * reason at all, including one the staging accidentally caused - which is
     * how a precondition test stops testing its own precondition. */
    because: RegExp,
    direction: "forward" | "reverse" = "forward",
  ): Promise<void> => {
    const dsn = await asProductionIsToday();
    await stage(dsn);
    const before = await matrixOf(dsn);
    // Awaited to completion before the catalog is read again: the claim is
    // that the refusal left nothing behind, and reading while the call was
    // still running would not be that claim.
    const message = await reapplyMatrix(dsn, direction).then(
      () => "it did not refuse",
      (err: Error) => err.message,
    );
    expect(message).toMatch(because);
    expect(await matrixOf(dsn)).toEqual(before);
    await dropRoles(dsn);
  };

  test(
    "when the catalog is not exactly the matrix being moved away from",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, `grant delete on accounts to ${PROVISIONER_ROLE}`);
        }, /does not carry exactly the matrix/),
      ),
    60_000,
  );

  test(
    "when the forward change has already been applied",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await reapplyMatrix(dsn, "forward");
        }, /does not carry exactly the matrix/),
      ),
    60_000,
  );

  test(
    "when the owner does not already carry exactly the governed bounds",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          const owner = (
            await ask<{ owner: string }>(dsn, "select current_user as owner")
          )[0].owner;
          await ask(dsn, `alter role ${owner} reset all`);
        }, /owner role does not already carry/),
      ),
    60_000,
  );

  test(
    "when a runtime role can log in",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, `alter role ${PROVISIONER_ROLE} login`);
        }, /not an inert residue/),
      ),
    60_000,
  );

  test(
    "when a budget has drifted from the approved posture",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, `alter role ${WEB_ROLE} connection limit 7`);
        }, /not exactly the role/),
      ),
    60_000,
  );

  // THE CLASS A MATRIX READ CANNOT SEE. A role that can CREATE on the schema
  // can make a table the matrix has never heard of, so a posture change made
  // while that is true would be a boundary stated about the wrong thing.
  // A BEFORE-STATE THAT CAN ALREADY DO MORE THAN THE OLD MATRIX. The direct
  // grants are untouched here - the privilege is PUBLIC's - so this is the case
  // the effective read exists for. In practice the PUBLIC sweep in `preflight`
  // reaches it first, which is why the message is that one: the two guards
  // overlap on purpose, and the property (refused, nothing written) is what is
  // being asserted rather than which line caught it.
  test(
    "when PUBLIC can do something the matrix does not carry",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, "grant delete on accounts to public");
        }, /PUBLIC holds privileges/),
      ),
    60_000,
  );

  test(
    "when a runtime role holds CREATE on the schema",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, `grant create on schema public to ${WEB_ROLE}`);
        }, /CREATE on the schema, or a sequence privilege/),
      ),
    60_000,
  );

  test(
    "when a runtime role holds a sequence privilege",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, "create sequence cp_reapply_probe_seq");
          await ask(
            dsn,
            `grant usage on sequence cp_reapply_probe_seq to ${PROVISIONER_ROLE}`,
          );
        }, /CREATE on the schema, or a sequence privilege/),
      ),
    60_000,
  );

  test(
    "when a role's bounds have drifted",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, `alter role ${WEB_ROLE} set lock_timeout = '5s'`);
        }, /not exactly the role/),
      ),
    60_000,
  );
});
