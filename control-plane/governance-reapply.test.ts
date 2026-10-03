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
//     inexact, the owner's configuration not already ours, a runtime identity
//     with a membership or ownership edge, a budget that has drifted.
//
// LOCAL ENGINE ONLY, like the other role suites: these create and drop
// cluster-wide roles.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { applyGovernance, reapplyIsExact, reapplyMatrix } from "./bootstrap.ts";
import {
  PROVISIONER_GRANTS,
  PROVISIONER_ROLE,
  PRIOR_PROVISIONER_GRANTS,
  PRIOR_WEB_GRANTS,
  WEB_GRANTS,
  WEB_ROLE,
  grantMatrixStatements,
  judgeMatrix,
  matrixSql,
  priorRuntimeRoles,
  residueIsInert,
  roleIdentitySql,
  runtimeRoles,
  type RoleIdentity,
  type RolePosture,
} from "./roles.ts";
import { Store } from "./store.ts";
import {
  LOCAL_DATABASE_URL,
  PG_TEST_HOOK_TIMEOUT_MS,
  TARGET_IS_LOCAL,
  inCleanupPool,
} from "./testing/pg.ts";
import { withRoleSuiteLock } from "./testing/role-suite-lock.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

/**
 * Role names are cluster-wide, and the local engine is one cluster shared by
 * every process on the box. A suite that governs the literal `cp_web` collides
 * with any other process doing the same, which `serial` cannot see. So every
 * role here, runtime pair and auxiliaries alike, is a fresh name owned by this
 * process and recorded, and cleanup proves each one gone. The rosters keep the
 * production budgets and grants; only the names differ.
 */
const createdRoles: string[] = [];
function uniqueRole(prefix: string): string {
  const role = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  createdRoles.push(role);
  return role;
}

function renamed(
  roster: readonly RolePosture[],
  names: readonly string[],
): RolePosture[] {
  return roster.map((entry, i) => ({ ...entry, role: names[i] }));
}

let TEST_WEB_ROLE = "";
let TEST_PROVISIONER_ROLE = "";
/** The current matrix and the one production held on 2026-08-21. */
let TEST_CURRENT: readonly RolePosture[] = [];
let TEST_PRIOR: readonly RolePosture[] = [];
const testRosters = () => ({ prior: TEST_PRIOR, current: TEST_CURRENT });

/** Every case that touches a role runs alone, under names of its own. The
 * owner role is still shared, so `withRoleSuiteLock` keeps it alone across
 * processes too. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> =>
    withRoleSuiteLock(async () => {
      const names = [uniqueRole("cp_rw"), uniqueRole("cp_rp")];
      [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE] = names;
      TEST_CURRENT = renamed(runtimeRoles(), names);
      TEST_PRIOR = renamed(priorRuntimeRoles(), names);
      return fn();
    });
  const next = queue.then(run, run);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const admin = new pg.Pool({ connectionString: LOCAL_DATABASE_URL, max: 2 });
admin.on("error", () => {});
const databases: string[] = [];
const liveRuntimes = new Map<string, Map<string, pg.Client>>();
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

async function closeRuntimes(dsn: string): Promise<void> {
  const live = liveRuntimes.get(dsn);
  liveRuntimes.delete(dsn);
  await Promise.all(
    [...(live?.values() ?? [])].map((client) => client.end().catch(() => {})),
  );
}

/**
 * Roles are dropped ONCE, after the last scratch database is gone. A role that
 * still holds a grant in any database refuses to drop, so dropping per
 * database while a sibling still granted to it left the roles behind on every
 * green run. Dropping the databases first takes every grant with them.
 */
afterAll(async () => {
  const failures: unknown[] = [];
  try {
    await Promise.all([...liveRuntimes.keys()].map(closeRuntimes));
    // Under the case lock, for the reason governance-apply.test.ts gives: a
    // database drop waits for a checkpoint, slow while other cases run.
    await withRoleSuiteLock(async () => {
      await inCleanupPool(databases, async (name) => {
        try {
          await admin.query(
            "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1",
            [name],
          );
          await admin.query(`drop database if exists ${name}`);
        } catch (error) {
          failures.push(error);
        }
      });
      for (const role of createdRoles) {
        if (role === WEB_ROLE || role === PROVISIONER_ROLE) {
          throw new Error(`refusing to drop production runtime role ${role}`);
        }
        await admin
          .query(`drop role if exists ${role}`)
          .catch((error: unknown) => failures.push(error));
      }
    });
    const leftovers = await admin.query<{ n: string }>(
      "select count(*)::text as n from pg_roles where rolname = any($1)",
      [createdRoles],
    );
    expect(leftovers.rows[0]?.n).toBe("0");
    expect(await productionRoleSnapshot()).toEqual(productionRolesBefore);
    if (failures.length > 0) {
      throw new AggregateError(failures, "failed to clean up scratch state");
    }
  } finally {
    await admin.end().catch(() => {});
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

/** A schema-ready database governed exactly as PRODUCTION is today: the roles
 * in place and the catalog carrying the PRIOR matrix. */
async function asProductionIsToday(): Promise<string> {
  const dsn = await scratchDatabase();
  await (await Store.open(dsn)).close();
  await applyGovernance(dsn, TEST_CURRENT);
  await run(dsn, grantMatrixStatements(TEST_PRIOR));
  const password = crypto.randomUUID().replace(/-/g, "");
  for (const role of [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE]) {
    await ask(dsn, `alter role ${role} login password '${password}'`);
  }
  const live = new Map<string, pg.Client>();
  for (const role of [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE]) {
    const runtimeDsn = new URL(dsn);
    runtimeDsn.username = role;
    runtimeDsn.password = password;
    const client = new pg.Client({ connectionString: runtimeDsn.toString() });
    client.on("error", () => {});
    await client.connect();
    await client.query("select 1");
    live.set(role, client);
  }
  liveRuntimes.set(dsn, live);
  return dsn;
}

async function runtimeSelects(
  dsn: string,
  role: string,
  table: "stripe_events" | "reinstatement_attempts",
  allowed: boolean,
): Promise<void> {
  const live = liveRuntimes.get(dsn)?.get(role);
  if (!live) throw new Error(`the production fixture has no live ${role}`);
  const result = await live.query(`select 1 from ${table} limit 1`).then(
    () => ({ allowed: true, code: "" }),
    (error: { code?: string }) => ({ allowed: false, code: error.code ?? "" }),
  );
  expect(result.allowed).toBe(allowed);
  if (!allowed) expect(result.code).toBe("42501");
}

async function provisionerInsertsStripeEvent(
  dsn: string,
  allowed: boolean,
): Promise<void> {
  const live = liveRuntimes.get(dsn)?.get(TEST_PROVISIONER_ROLE);
  if (!live) throw new Error("the production fixture has no live provisioner");
  const result = await live
    .query(
      "insert into stripe_events " +
        "(id, type, created, received_at, outcome) values ($1, $2, $3, $4, $5)",
      [crypto.randomUUID(), "test.event", 1, 1, "accepted"],
    )
    .then(
      () => ({ allowed: true, code: "" }),
      (error: { code?: string }) => ({
        allowed: false,
        code: error.code ?? "",
      }),
    );
  expect(result.allowed).toBe(allowed);
  if (!allowed) expect(result.code).toBe("42501");
}

async function webUpdatesReservation(
  dsn: string,
  allowed: boolean,
): Promise<void> {
  const live = liveRuntimes.get(dsn)?.get(TEST_WEB_ROLE);
  if (!live) throw new Error("the production fixture has no live web role");
  // Zero rows match, so nothing moves either way: the privilege check fires
  // before the row count matters, which is all this probe needs.
  const result = await live
    .query(
      "update name_reservations set updated_at = updated_at where id = $1",
      ["probe-no-such-row"],
    )
    .then(
      () => ({ allowed: true, code: "" }),
      (error: { code?: string }) => ({
        allowed: false,
        code: error.code ?? "",
      }),
    );
  expect(result.allowed).toBe(allowed);
  if (!allowed) expect(result.code).toBe("42501");
}

/** Every direct grant both runtime roles hold, as a sorted set of strings, so
 * two catalogs can be compared rather than described. */
async function matrixOf(dsn: string): Promise<string[]> {
  const rows = await ask<{ role: string; table: string; verb: string }>(
    dsn,
    matrixSql(),
    [[TEST_WEB_ROLE, TEST_PROVISIONER_ROLE]],
  );
  return rows.map((r) => `${r.role}:${r.table}:${r.verb}`).sort();
}

function matrixFor(roster: readonly RolePosture[]): string[] {
  return roster
    .flatMap(({ role, grants }) =>
      grants.flatMap(({ table, verbs }) =>
        verbs.map((verb) => `${role}:${table}:${verb.toUpperCase()}`),
      ),
    )
    .sort();
}

suite("the incremental matrix change", () => {
  test(
    "forward lands exactly the current matrix from production's observed baseline",
    () =>
      serial(async () => {
        const dsn = await asProductionIsToday();
        const before = await matrixOf(dsn);
        expect(before).toEqual(matrixFor(TEST_PRIOR));
        const rows = await ask<{ role: string; table: string; verb: string }>(
          dsn,
          matrixSql(),
          [[TEST_WEB_ROLE, TEST_PROVISIONER_ROLE]],
        );
        expect(judgeMatrix(rows, TEST_WEB_ROLE, PRIOR_WEB_GRANTS).exact).toBe(
          true,
        );
        expect(
          judgeMatrix(rows, TEST_PROVISIONER_ROLE, PRIOR_PROVISIONER_GRANTS)
            .exact,
        ).toBe(true);
        expect(before).not.toContain(
          `${TEST_WEB_ROLE}:name_reservations:UPDATE`,
        );
        // Grants already in the baseline stay exercisable; the pending one
        // refuses. Together they prove the live sessions test real privilege.
        await provisionerInsertsStripeEvent(dsn, true);
        await runtimeSelects(
          dsn,
          TEST_WEB_ROLE,
          "reinstatement_attempts",
          true,
        );
        await webUpdatesReservation(dsn, false);

        const applied = await reapplyMatrix(dsn, "forward", testRosters());
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
        expect(after).toEqual(matrixFor(TEST_CURRENT));
        expect(after).toContain(`${TEST_WEB_ROLE}:name_reservations:UPDATE`);
        await webUpdatesReservation(dsn, true);
        await closeRuntimes(dsn);
      }),
    60_000,
  );

  test(
    "reverse restores exactly the old matrix",
    () =>
      serial(async () => {
        const dsn = await asProductionIsToday();
        await reapplyMatrix(dsn, "forward", testRosters());
        await webUpdatesReservation(dsn, true);
        const applied = await reapplyMatrix(dsn, "reverse", testRosters());
        await webUpdatesReservation(dsn, false);
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
          [[TEST_WEB_ROLE, TEST_PROVISIONER_ROLE]],
        );
        expect(
          judgeMatrix(rows, TEST_PROVISIONER_ROLE, PRIOR_PROVISIONER_GRANTS)
            .exact,
        ).toBe(true);
        expect(judgeMatrix(rows, TEST_WEB_ROLE, PRIOR_WEB_GRANTS).exact).toBe(
          true,
        );
        // The provisioner's prior equals its current matrix (measured
        // 2026-08-24), so only the web role reads as moved-away-from.
        expect(
          judgeMatrix(rows, TEST_PROVISIONER_ROLE, PROVISIONER_GRANTS).exact,
        ).toBe(true);
        expect(judgeMatrix(rows, TEST_WEB_ROLE, WEB_GRANTS).exact).toBe(false);
        expect(await matrixOf(dsn)).toEqual(matrixFor(TEST_PRIOR));
        await closeRuntimes(dsn);
      }),
    60_000,
  );

  test(
    "a round trip leaves the catalog where it started",
    () =>
      serial(async () => {
        const dsn = await asProductionIsToday();
        const start = await matrixOf(dsn);
        await reapplyMatrix(dsn, "forward", testRosters());
        await reapplyMatrix(dsn, "reverse", testRosters());
        expect(await matrixOf(dsn)).toEqual(start);
        await closeRuntimes(dsn);
      }),
    60_000,
  );

  test(
    "the roles themselves are not touched",
    () =>
      serial(async () => {
        const dsn = await asProductionIsToday();
        const roleState = async () =>
          ask<{
            role: string;
            limit: number;
            config: string[] | null;
            canLogin: boolean;
          }>(
            dsn,
            "select rolname as role, rolconnlimit as limit, rolconfig as config, " +
              'rolcanlogin as "canLogin" ' +
              "from pg_roles where rolname = any($1) order by rolname",
            [[TEST_WEB_ROLE, TEST_PROVISIONER_ROLE]],
          );
        const before = await roleState();
        await reapplyMatrix(dsn, "forward", testRosters());
        expect(await roleState()).toEqual(before);
        await closeRuntimes(dsn);
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
    loginUnchanged: [[WEB_ROLE, true] as [string, boolean]],
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
    ["a changed login state", { loginUnchanged: [[WEB_ROLE, false]] }],
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
        const creator = uniqueRole("cp_creator");
        const child = uniqueRole("cp_child");
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
    rosters: () => ReturnType<typeof testRosters> = testRosters,
  ): Promise<void> => {
    const dsn = await asProductionIsToday();
    await stage(dsn);
    const before = await matrixOf(dsn);
    // Awaited to completion before the catalog is read again: the claim is
    // that the refusal left nothing behind, and reading while the call was
    // still running would not be that claim.
    const message = await reapplyMatrix(dsn, direction, rosters()).then(
      () => "it did not refuse",
      (err: Error) => err.message,
    );
    expect(message).toMatch(because);
    expect(await matrixOf(dsn)).toEqual(before);
    await closeRuntimes(dsn);
  };

  test(
    "when the two rosters do not name the same roles",
    () =>
      serial(() =>
        refuses(
          async () => {},
          /do not name the same roles/,
          "forward",
          () => ({
            prior: TEST_PRIOR,
            current: renamed(runtimeRoles(), [
              TEST_WEB_ROLE,
              uniqueRole("cp_rx"),
            ]),
          }),
        ),
      ),
    60_000,
  );

  test(
    "when the catalog is not exactly the matrix being moved away from",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(
            dsn,
            `grant delete on accounts to ${TEST_PROVISIONER_ROLE}`,
          );
        }, /does not carry exactly the matrix/),
      ),
    60_000,
  );

  test(
    "when the web role already holds the reservation persist grant",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(
            dsn,
            `grant update on name_reservations to ${TEST_WEB_ROLE}`,
          );
        }, /does not carry exactly the matrix/),
      ),
    60_000,
  );

  test(
    "when the forward change has already been applied",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await reapplyMatrix(dsn, "forward", testRosters());
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
    "when a runtime role belongs to another role",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          const parent = uniqueRole("cp_parent");
          await ask(dsn, `create role ${parent}`);
          await ask(dsn, `grant ${parent} to ${TEST_PROVISIONER_ROLE}`);
        }, /not exactly the deployed identity/),
      ),
    60_000,
  );

  test(
    "when a runtime role has a member other than its owner",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          const member = uniqueRole("cp_member");
          await ask(dsn, `create role ${member}`);
          await ask(dsn, `grant ${TEST_PROVISIONER_ROLE} to ${member}`);
        }, /not exactly the deployed identity/),
      ),
    60_000,
  );

  test(
    "when a runtime role owns an object",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, `create schema authorization ${TEST_WEB_ROLE}`);
        }, /not exactly the deployed identity/),
      ),
    60_000,
  );

  test(
    "when a budget has drifted from the approved posture",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, `alter role ${TEST_WEB_ROLE} connection limit 7`);
        }, /not exactly the role/),
      ),
    60_000,
  );

  // THE CLASS A MATRIX READ CANNOT SEE. A role that can CREATE on the schema
  // can make a table the matrix has never heard of, so a posture change made
  // while that is true would be a boundary stated about the wrong thing.
  // A BEFORE-STATE THAT CAN ALREADY DO MORE THAN THE OLD MATRIX. The direct
  // grants are untouched here - the privilege is PUBLIC's - so this is the case
  // the effective read exists for. In practice the PUBLIC sweep in
  // `reapplyPreflight` reaches it first, which is why the message is that one:
  // the two guards
  // overlap on purpose, and the property (refused, nothing written) is what is
  // being asserted rather than which read caught it.
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
          await ask(dsn, `grant create on schema public to ${TEST_WEB_ROLE}`);
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
            `grant usage on sequence cp_reapply_probe_seq to ${TEST_PROVISIONER_ROLE}`,
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
          await ask(dsn, `alter role ${TEST_WEB_ROLE} set lock_timeout = '5s'`);
        }, /not exactly the role/),
      ),
    60_000,
  );
});
