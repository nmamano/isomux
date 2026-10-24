// Converging the runtime grants of a database that is ALREADY governed and
// deployed: what every Hosted redeploy does (`cli.ts regovern`, run by
// deploy.sh after the owner migrations).
//
// The properties, each staged against a real engine:
//
//   - a catalog that already carries the matrix is not written at all;
//   - a catalog that lacks part of the matrix, or holds more than it, ends at
//     EXACTLY the matrix, with live sessions of LOGIN roles connected, and the
//     result names every privilege that was granted and revoked;
//   - every structural precondition refuses BEFORE anything is written - the
//     owner's configuration not already ours, a runtime identity with a
//     membership or ownership edge, a budget or bound that has drifted, PUBLIC
//     holding privileges, CREATE on the schema, a sequence privilege.
//
// LOCAL ENGINE ONLY, like the other role suites: these create and drop
// cluster-wide roles.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import {
  applyGrantMatrix,
  applyRolePosture,
  convergeMatrix,
  convergeIsExact,
} from "./bootstrap.ts";
import { Store } from "./store.ts";
import {
  PROVISIONER_ROLE,
  WEB_ROLE,
  grantKeys,
  matrixSql,
  residueIsInert,
  roleIdentitySql,
  runtimeRoles,
  type RoleIdentity,
  type MatrixRow,
  type RolePosture,
} from "./roles.ts";
import {
  LOCAL_DATABASE_URL,
  PG_DROP_DATABASE_HOOK_TIMEOUT_MS,
  TARGET_IS_LOCAL,
  inCleanupPool,
} from "./testing/pg.ts";
import { ownedScratchDatabase } from "./testing/case-owner.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

/**
 * Role names are cluster-wide, and the local engine is one cluster shared by
 * every process on the box. A suite that governs the literal `cp_web` collides
 * with any other process doing the same, which `serial` cannot see. So every
 * role here, runtime pair and auxiliaries alike, is a fresh name owned by this
 * process and recorded, and cleanup proves each one gone. The roster keeps the
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
/** The current matrix, under this case's role names. */
let TEST_CURRENT: readonly RolePosture[] = [];

/** Every case that touches a role runs alone, under names of its own, and
 * governs an owner of its own (`ownedScratchDatabase`), so no other process
 * shares a role with it. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> => {
    const names = [uniqueRole("cp_rw"), uniqueRole("cp_rp")];
    [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE] = names;
    TEST_CURRENT = renamed(runtimeRoles(), names);
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
const databases: string[] = [];
/** Each scratch database's owner, dropped after every other role. */
const owners: string[] = [];
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
  const { name, owner, dsn } = await ownedScratchDatabase(admin, "cp_cv");
  databases.push(name);
  owners.push(owner);
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
    // The owners last: the databases and the runtime roles are gone.
    for (const role of [...createdRoles, ...owners]) {
      if (role === WEB_ROLE || role === PROVISIONER_ROLE) {
        throw new Error(`refusing to drop production runtime role ${role}`);
      }
      await admin
        .query(`drop role if exists ${role}`)
        .catch((error: unknown) => failures.push(error));
    }
    const leftovers = await admin.query<{ n: string }>(
      "select count(*)::text as n from pg_roles where rolname = any($1)",
      [[...createdRoles, ...owners]],
    );
    expect(leftovers.rows[0]?.n).toBe("0");
    expect(await productionRoleSnapshot()).toEqual(productionRolesBefore);
    if (failures.length > 0) {
      throw new AggregateError(failures, "failed to clean up scratch state");
    }
  } finally {
    await admin.end().catch(() => {});
  }
  // This hook drops one database per case: see PG_DROP_DATABASE_HOOK_TIMEOUT_MS.
}, PG_DROP_DATABASE_HOOK_TIMEOUT_MS);

/** A schema-ready database governed and deployed as the Hosted VPS is: the
 * catalog carrying exactly the current matrix, both runtime roles able to log
 * in, and a live session open as each. The two governance phases of
 * bootstrapDatabase, without its owner migrations (Store.open's schema already
 * holds what they add) or its report. */
async function asDeployed(): Promise<string> {
  const dsn = await scratchDatabase();
  await applyRolePosture(dsn, TEST_CURRENT);
  await (await Store.open(dsn)).close();
  await applyGrantMatrix(dsn, TEST_CURRENT);
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

/** Whether the live session of `role` may run `sql`. Every probe matches no
 * row, so nothing moves either way: the privilege check fires before the row
 * count matters. A refusal must be 42501 and nothing else. */
async function liveMay(dsn: string, role: string, sql: string) {
  const live = liveRuntimes.get(dsn)?.get(role);
  if (!live) throw new Error(`the deployed fixture has no live ${role}`);
  const result = await live.query(sql).then(
    () => ({ allowed: true, code: "" }),
    (error: { code?: string }) => ({ allowed: false, code: error.code ?? "" }),
  );
  if (!result.allowed) expect(result.code).toBe("42501");
  return result.allowed;
}
const WEB_UPDATES_RESERVATION =
  "update name_reservations set updated_at = updated_at where id = 'probe-no-row'";
const PROVISIONER_DEFERS_CHECKOUT =
  "update name_reservations set checkout_state = checkout_state where id = 'probe-no-row'";
const WEB_DELETES_ACCOUNT = "delete from accounts where id = 'probe-no-row'";

/** Every direct grant both runtime roles hold, as a sorted set of strings, so
 * two catalogs can be compared rather than described. */
async function matrixOf(dsn: string): Promise<string[]> {
  const rows = await ask<MatrixRow>(dsn, matrixSql(), [
    [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE],
  ]);
  return rows
    .map(
      (r) => `${r.role}:${r.table}${r.column ? `(${r.column})` : ""}:${r.verb}`,
    )
    .sort();
}

function matrixFor(roster: readonly RolePosture[]): string[] {
  return roster
    .flatMap(({ role, grants }) =>
      grants
        .flatMap(grantKeys)
        .map(
          (key) => `${role}:${key.replace(/:(\w+)$/, (v) => v.toUpperCase())}`,
        ),
    )
    .sort();
}

/** The row version of every catalog row a grant statement rewrites: each
 * relation in the schema, and the schema itself. A GRANT or REVOKE updates the
 * row even when the ACL it writes is the one already there, so an unchanged
 * xmin is the proof that nothing was written - which an unchanged matrix
 * cannot be, since a re-grant of the same matrix leaves it identical. */
async function catalogRowVersions(dsn: string): Promise<string[]> {
  const rows = await ask<{ v: string }>(
    dsn,
    "select relname || ' ' || xmin::text as v from pg_class " +
      "where relnamespace = 'public'::regnamespace " +
      "union all select 'schema ' || xmin::text from pg_namespace " +
      "where nspname = 'public' order by 1",
  );
  return rows.map((r) => r.v);
}

async function roleState(dsn: string) {
  return ask<{
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
}

suite("converging the matrix on a deployed database", () => {
  test(
    "a catalog that already carries the matrix is not written",
    () =>
      serial(async () => {
        const dsn = await asDeployed();
        // Each case runs as an owner of its own (testing/case-owner.ts), never
        // as the shared connection user that other processes also govern.
        const [caseOwner] = await ask<{ name: string; ownsDatabase: boolean }>(
          dsn,
          'select r.rolname as name, d.datdba = r.oid as "ownsDatabase" ' +
            "from pg_roles r, pg_database d " +
            "where r.rolname = current_user and d.datname = current_database()",
        );
        expect(caseOwner.name).not.toBe(new URL(LOCAL_DATABASE_URL).username);
        expect(caseOwner.ownsDatabase).toBe(true);
        expect(await matrixOf(dsn)).toEqual(matrixFor(TEST_CURRENT));
        const versions = await catalogRowVersions(dsn);
        expect(versions.length).toBeGreaterThan(10);

        const result = await convergeMatrix(dsn, TEST_CURRENT);
        expect(result.moved).toBe(false);
        expect(result.statements).toBe(0);
        expect(result.granted).toEqual([]);
        expect(result.revoked).toEqual([]);
        // The read-back is the full one even when nothing moved.
        expect(result.exact).toBe(true);
        expect(result.direct.map(([role]) => role).sort()).toEqual(
          [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE].sort(),
        );
        expect(result.effective.map(([role]) => role).sort()).toEqual(
          [TEST_WEB_ROLE, TEST_PROVISIONER_ROLE].sort(),
        );
        expect(result.loginUnchanged.map(([, ok]) => ok)).toEqual([true, true]);

        expect(await catalogRowVersions(dsn)).toEqual(versions);
        await closeRuntimes(dsn);
      }),
    60_000,
  );

  test(
    "missing and extra privileges end at exactly the matrix, and the result names each",
    () =>
      serial(async () => {
        const dsn = await asDeployed();
        const web = TEST_WEB_ROLE;
        const prov = TEST_PROVISIONER_ROLE;
        // Two the matrix grants and the catalog lacks - a table verb and a
        // column grant, the shape of the 2026-10-08 Checkout poll grant - and
        // three the matrix does not grant: a matrix verb, a verb the matrix
        // never uses, and a column grant.
        for (const statement of [
          `revoke update on name_reservations from ${web}`,
          `revoke update (checkout_state) on name_reservations from ${prov}`,
          `grant delete on accounts to ${web}`,
          `grant truncate on audit_events to ${prov}`,
          `grant update (account_id) on name_reservations to ${prov}`,
        ]) {
          await ask(dsn, statement);
        }
        expect(await liveMay(dsn, web, WEB_UPDATES_RESERVATION)).toBe(false);
        expect(await liveMay(dsn, prov, PROVISIONER_DEFERS_CHECKOUT)).toBe(
          false,
        );
        expect(await liveMay(dsn, web, WEB_DELETES_ACCOUNT)).toBe(true);
        const rolesBefore = await roleState(dsn);

        const result = await convergeMatrix(dsn, TEST_CURRENT);
        expect(result.moved).toBe(true);
        expect(result.statements).toBeGreaterThan(0);
        expect(result.granted).toEqual(
          [
            `${web} name_reservations update`,
            `${prov} name_reservations update(checkout_state)`,
          ].sort(),
        );
        expect(result.revoked).toEqual(
          [
            `${web} accounts delete`,
            `${prov} audit_events truncate`,
            `${prov} name_reservations update(account_id)`,
          ].sort(),
        );
        expect(result.exact).toBe(true);
        for (const [, verdict] of [...result.direct, ...result.effective]) {
          expect(verdict.missing).toBe(0);
          expect(verdict.excess).toBe(0);
        }
        expect(result.schemaUsageOnly.map(([, ok]) => ok)).toEqual([
          true,
          true,
        ]);
        expect(result.sequencePrivilegesHeld).toBe(0);
        expect(result.noMemberships.map(([, ok]) => ok)).toEqual([true, true]);
        expect(result.loginUnchanged.map(([, ok]) => ok)).toEqual([true, true]);

        expect(await matrixOf(dsn)).toEqual(matrixFor(TEST_CURRENT));
        // The sessions that were open before the change see it on their next
        // statement.
        expect(await liveMay(dsn, web, WEB_UPDATES_RESERVATION)).toBe(true);
        expect(await liveMay(dsn, prov, PROVISIONER_DEFERS_CHECKOUT)).toBe(
          true,
        );
        expect(await liveMay(dsn, web, WEB_DELETES_ACCOUNT)).toBe(false);
        // The roles themselves - login, budget, bounds - are not touched.
        expect(await roleState(dsn)).toEqual(rolesBefore);

        // And a second run finds nothing to do.
        const again = await convergeMatrix(dsn, TEST_CURRENT);
        expect(again.moved).toBe(false);
        expect(again.statements).toBe(0);
        expect(again.granted).toEqual([]);
        expect(again.revoked).toEqual([]);
        expect(again.exact).toBe(true);
        await closeRuntimes(dsn);
      }),
    60_000,
  );
});

/**
 * The FOLD, on its own.
 *
 * `convergeMatrix` reads five kinds of fact and decides one boolean from them.
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
    expect(convergeIsExact(green)).toBe(true);
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
      expect(convergeIsExact({ ...green, ...patch })).toBe(false);
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
  /** Every refusal case asserts the SAME two things: it threw for the named
   * reason, and the catalog did not move. The catalog is staged one grant
   * short of the matrix first, so a run that wrote before it refused would
   * show: on an exact catalog a re-grant leaves the matrix as it was. */
  const refuses = async (
    stage: (dsn: string) => Promise<void>,
    /** WHICH refusal. A case that only asserts "it threw" passes for any
     * reason at all, including one the staging accidentally caused - which is
     * how a precondition test stops testing its own precondition. */
    because: RegExp,
    roster: () => readonly RolePosture[] = () => TEST_CURRENT,
  ): Promise<void> => {
    const dsn = await asDeployed();
    await ask(dsn, `revoke update on name_reservations from ${TEST_WEB_ROLE}`);
    await stage(dsn);
    const before = await matrixOf(dsn);
    expect(before).not.toEqual(matrixFor(TEST_CURRENT));
    // Awaited to completion before the catalog is read again: the claim is
    // that the refusal left nothing behind, and reading while the call was
    // still running would not be that claim.
    const message = await convergeMatrix(dsn, roster()).then(
      () => "it did not refuse",
      (err: Error) => err.message,
    );
    expect(message).toMatch(because);
    expect(await matrixOf(dsn)).toEqual(before);
    await closeRuntimes(dsn);
  };

  test(
    "when a role the roster names does not exist",
    () =>
      serial(() =>
        refuses(
          async () => {},
          /missing from the deployed posture/,
          () => renamed(runtimeRoles(), [TEST_WEB_ROLE, uniqueRole("cp_rx")]),
        ),
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

  // A privilege that is PUBLIC's reaches every role whatever the matrix
  // grants, and this build does not edit the public ACL.
  test(
    "when PUBLIC holds a privilege on this build's tables",
    () =>
      serial(() =>
        refuses(async (dsn) => {
          await ask(dsn, "grant delete on accounts to public");
        }, /PUBLIC holds privileges/),
      ),
    60_000,
  );

  // THE CLASS A MATRIX READ CANNOT SEE. A role that can CREATE on the schema
  // can make a table the matrix has never heard of, so a posture change made
  // while that is true would be a boundary stated about the wrong thing.
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
          await ask(dsn, "create sequence cp_converge_probe_seq");
          await ask(
            dsn,
            `grant usage on sequence cp_converge_probe_seq to ${TEST_PROVISIONER_ROLE}`,
          );
        }, /CREATE on the schema, or a sequence privilege/),
      ),
    60_000,
  );
});
