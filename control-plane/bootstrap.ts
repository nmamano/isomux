// Bring an empty database to schema-ready, and say so in booleans.
//
// The procedure is `Store.open` and nothing else: it runs SCHEMA, checks the
// catalog, creates the late indexes and seeds the audit sequence. What this
// module adds is the EVIDENCE, produced by the same command that did the work
// rather than by a query somebody runs afterwards and reports by hand.
//
// Two booleans, and each one answers a different question:
//
//   schema-ready    every table the schema names is present in the catalog.
//   zero-user-data  every one of those tables holds zero rows.
//
// The second is CONTENTS evidence and is deliberately not offered as identity
// evidence: an empty database proves nothing about WHICH database it is. That
// proof belongs to the caller - `exercises/neon.ts bootstrap` makes it from the
// Neon API and the engine's own branch id before this runs.
//
// It does NOT go through cli.ts's `openStore`, which also imports the legacy
// intent journal from `~/.isomux-control-plane/intents`: a bootstrap that
// imported an operator box's local intent files would put rows a customer
// database has no business holding into the branch it is preparing.

import pg from "pg";
import {
  GOVERNED_SETTINGS,
  PRODUCT_TABLES,
  Store,
  redactConnectionDetails,
} from "./store.ts";
import type { SqlArgs } from "./store.ts";
import {
  ALL_VERBS,
  type EffectiveRow,
  type MatrixVerdict,
  PROVISIONER_ROLE,
  type RoleIdentity,
  WEB_ROLE,
  boundsAreExact,
  effectivePrivilegeSql,
  governanceStatements,
  grantMatrixStatements,
  judgeEffective,
  judgeMatrix,
  matrixSql,
  ownerConfigIsAcceptable,
  roleFactsSql,
  schemaPrivilegeSql,
  sequencePrivilegeSql,
  priorRuntimeRoles,
  residueIsInert,
  roleIdentitySql,
  governedRoleCount,
  readRolePosture,
  rolePostureStatements,
  runtimeRoles,
  ungovernStatements,
} from "./roles.ts";

/**
 * Every table SCHEMA creates. The list is the check: a table missing from the
 * catalog is a schema that did not come up, whatever the open reported.
 *
 * ONE ROSTER, DEFINED WHERE THE TABLES ARE. It used to be a second copy here,
 * which meant the open-time check and this evidence could disagree about what a
 * complete database is - and a roster that can drift is a roster that will. The
 * name stays because a dozen callers use it.
 */
export const EXPECTED_TABLES = PRODUCT_TABLES;

/**
 * The tables a bootstrap EXPECTS to have rows, because the open writes them.
 *
 * `sequences` carries the audit seed and `schema_meta` the schema's own
 * bookkeeping. Neither is user data, and counting them as such would make
 * zero-user-data false on every correct bootstrap - which is the quietest way
 * to make a boolean stop meaning anything.
 */
const SEEDED = new Set(["sequences", "schema_meta"]);

export type BootstrapResult = {
  schemaReady: boolean;
  zeroUserData: boolean;
  /** Both runtime roles carry their exact budget and exactly the governed
   * pair. A bootstrap that leaves either wrong is not a success. */
  governanceExact: boolean;
  missing: string[];
  counts: [string, number][];
  /** What the posture step did on the way in: how many statements it ran, and
   * how many roles the catalog then shows as governed (a limit AND bounds). */
  governance: { statements: number; roles: number };
};

/**
 * Run a list of statements as ONE transaction, or leave nothing behind.
 *
 * The reason is measured rather than theoretical: an earlier version sent each
 * statement as its own autocommit, a mid-list refusal (the owner's connection
 * limit, which this provider does not allow) left the runtime roles created and
 * the owner ungoverned, and the operator was left to work out which half had
 * landed. Production cannot be told that story. Postgres makes CREATE ROLE,
 * ALTER ROLE and GRANT transactional, so a coherent phase is one transaction
 * and a failure is a no-op.
 */
async function inTransaction(
  pool: pg.Pool,
  dsn: string,
  statements: readonly string[],
): Promise<number> {
  const client = await pool.connect().catch((err: unknown) => {
    throw redactConnectionDetails(err, dsn);
  });
  try {
    await client.query("begin");
    for (const statement of statements) await client.query(statement);
    await client.query("commit");
    return statements.length;
  } catch (err) {
    // The rollback's own failure must not replace the error that caused it.
    await client.query("rollback").catch(() => {});
    throw redactConnectionDetails(err, dsn);
  } finally {
    client.release();
  }
}

async function openPool(dsn: string): Promise<pg.Pool> {
  const pool = new pg.Pool({
    connectionString: dsn,
    connectionTimeoutMillis: 30_000,
  });
  pool.on("error", () => {});
  return pool;
}

/** Owner-role migration for the deployed database. Runtime roles cannot DDL. */
export async function migrateCustomerSshKeyColumns(dsn: string): Promise<void> {
  const pool = await openPool(dsn);
  try {
    await inTransaction(pool, dsn, [
      "alter table instances add column if not exists customer_ssh_key text",
      "alter table instances add column if not exists customer_ssh_key_fingerprint text",
      "alter table instances add column if not exists ssh_login_user text",
    ]);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** The owner's name and its current role configuration, read before anything
 * is written. */
async function ownerState(
  pool: pg.Pool,
  dsn: string,
): Promise<{ owner: string; config: string[] }> {
  try {
    const row = await pool.query<{ owner: string; config: string[] | null }>(
      "select current_user as owner, rolconfig as config from pg_roles " +
        "where rolname = current_user",
    );
    return {
      owner: row.rows[0]?.owner ?? "",
      config: row.rows[0]?.config ?? [],
    };
  } catch (err) {
    throw redactConnectionDetails(err, dsn);
  }
}

/**
 * Refuse before mutating if anything about the ground is not what we think.
 *
 * TWO QUESTIONS, and both are about names this build does not own exclusively.
 * `cp_web` and `cp_provisioner` are CLUSTER-GLOBAL in production, so a role
 * that is already there might be a previous run's inert residue or might be
 * somebody else's live identity - and `create if absent` followed by
 * `reset all` cannot tell the difference. And a privilege held by PUBLIC is a
 * privilege every role has, so a matrix that reads only direct grants can be
 * exact while the boundary it describes is not.
 *
 * Neither is repaired here. A live same-named role and a PUBLIC grant on a
 * product table are both states somebody has to look at, and quietly
 * overwriting them is how a posture change becomes an incident.
 */
async function preflight(
  pool: pg.Pool,
  dsn: string,
  schemaExists: boolean,
): Promise<void> {
  let identities: RoleIdentity[];
  try {
    identities = (
      await pool.query<RoleIdentity>(roleIdentitySql(), [
        [WEB_ROLE, PROVISIONER_ROLE],
      ])
    ).rows;
  } catch (err) {
    throw redactConnectionDetails(err, dsn);
  }
  for (const identity of identities) {
    if (!residueIsInert(identity)) {
      throw new Error(
        "refusing to govern: a role with one of this build's names already " +
          "exists and is not an inert residue of a previous run - it can log " +
          "in, belongs to a role, has a member OTHER than the owner that " +
          "created it, owns an object, or has a live session. The owner's own " +
          "membership is not one of these: a non-superuser creator is granted " +
          "it by Postgres itself. These names are cluster-global, so taking " +
          "one over could adopt another system's identity. Resolve it by hand " +
          "first.",
      );
    }
  }
  if (!schemaExists) return;
  // PUBLIC, over every product table and every verb. Read, never written: the
  // public ACL is not this build's to edit.
  let held: number;
  try {
    const rows = await pool.query<EffectiveRow>(effectivePrivilegeSql(), [
      ["public"],
      [...EXPECTED_TABLES],
      [...ALL_VERBS],
    ]);
    held = rows.rows.filter((row) => row.allowed).length;
  } catch (err) {
    throw redactConnectionDetails(err, dsn);
  }
  if (held > 0) {
    throw new Error(
      "refusing to govern: PUBLIC holds privileges on this build's tables, so " +
        "every role would have them whatever the matrix grants. This build " +
        "does not edit the public ACL - resolve it by hand first.",
    );
  }
}

/**
 * PHASE ONE: create and govern the roles. Safe on an EMPTY database.
 *
 * It names no table, so it runs before a schema exists - which is the ordering
 * a fresh bootstrap needs, because a grant on a table that has not been created
 * is a refusal and not a warning.
 *
 * It REFUSES BEFORE MUTATING if the owner's configuration carries anything we
 * did not put there: converging the owner's settings would erase a provider or
 * operator default silently, and a posture that quietly deletes somebody else's
 * configuration is not one to run against production.
 */
export async function applyRolePosture(dsn: string): Promise<number> {
  const pool = await openPool(dsn);
  try {
    await preflight(pool, dsn, false);
    const { owner, config } = await ownerState(pool, dsn);
    if (!ownerConfigIsAcceptable(config, GOVERNED_SETTINGS)) {
      throw new Error(
        "refusing to govern: the owner role already carries configuration this " +
          "build did not put there, and converging it would erase settings " +
          "nobody here can account for. Resolve the role's configuration by " +
          "hand first.",
      );
    }
    // AWAITED, not returned bare: the `finally` below closes the pool, and a
    // bare `return` of a promise runs that finally before the transaction has
    // settled - which destroys the pool underneath the statements and shows up
    // as a connection timeout with no failing statement to point at.
    return await inTransaction(
      pool,
      dsn,
      rolePostureStatements({ ownerRole: owner, bounds: GOVERNED_SETTINGS }),
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

/** PHASE TWO: the exact table matrix. Needs the schema to exist. */
export async function applyGrantMatrix(dsn: string): Promise<number> {
  const pool = await openPool(dsn);
  try {
    return await inTransaction(pool, dsn, grantMatrixStatements());
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Both phases at once, for a database that already carries its schema.
 *
 * ONE TRANSACTION, because nothing has to happen between them here and a
 * production migration that can land halfway is not a gated reversible step.
 */
export async function applyGovernance(
  dsn: string,
): Promise<{ statements: number; roles: number }> {
  const pool = await openPool(dsn);
  try {
    await preflight(pool, dsn, true);
    const { owner, config } = await ownerState(pool, dsn);
    if (!ownerConfigIsAcceptable(config, GOVERNED_SETTINGS)) {
      throw new Error(
        "refusing to govern: the owner role already carries configuration this " +
          "build did not put there, and converging it would erase settings " +
          "nobody here can account for. Resolve the role's configuration by " +
          "hand first.",
      );
    }
    const statements = await inTransaction(
      pool,
      dsn,
      governanceStatements({ ownerRole: owner, bounds: GOVERNED_SETTINGS }),
    );
    const roles = await pool.query<{ n: string }>(
      "select count(*)::text as n from pg_roles where rolconnlimit <> -1 " +
        "and rolconfig is not null",
    );
    return { statements, roles: Number(roles.rows[0]?.n ?? 0) };
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * CHANGE THE MATRIX ON A DATABASE THAT IS ALREADY GOVERNED, in one transaction.
 *
 * IT IS NOT `applyGovernance` AND IT IS NOT `ungovern`, and the reason is what
 * production actually holds. `applyGovernance` is written for a database this
 * build has not governed yet: it requires the owner to carry NOTHING, which
 * production cannot satisfy - the owner has carried the governed pair since
 * G2, so `owner_config_empty_before` cannot truthfully pass and the honest
 * before-state has to be "already exactly ours" instead. And `ungovern` is not
 * the rollback for one incremental grant: it drops both roles, which is an
 * outage lever rather than a reverse of a matrix change.
 *
 * SO THE BEFORE-STATE IS AN EXACT DESTINATION TOO. The catalog must carry
 * EXACTLY the matrix this change is moving away from - not "at least" it - and
 * both directions run the same convergent statements, so the reverse is the
 * forward with the two rosters swapped. A run that finds anything else refuses
 * before it writes, which is what makes "one transaction restoring the old
 * exact matrix" a true description of the rollback rather than a hope.
 *
 * EVERY PRECONDITION IS READ BEFORE ANY STATEMENT: the roles inert (NOLOGIN,
 * nothing connected as them, owning nothing), their budgets and bounds exact,
 * the owner carrying exactly the governed pair, PUBLIC holding nothing, and the
 * before-matrix exact. The read-back afterwards is DIRECT and EFFECTIVE, so
 * what the caller reports is what the engine says a role can do rather than
 * what this function asked for.
 */
export interface ReapplyResult {
  statements: number;
  /** Per role, the two read-backs after the transaction. */
  direct: [string, MatrixVerdict][];
  effective: [string, MatrixVerdict][];
  /** Per role: USAGE on the schema and NOT create. */
  schemaUsageOnly: [string, boolean][];
  /** Effective USAGE, SELECT or UPDATE on any sequence, over both roles. Zero
   * is the only acceptable answer; the schema has no sequences at all. */
  sequencePrivilegesHeld: number;
  /** Per role, after the transaction. A membership hands somebody everything
   * the matrix just granted, so acceptance says it rather than assuming it. */
  noMemberships: [string, boolean][];
  exact: boolean;
}

/**
 * IS THE WHOLE POSTURE EXACT? Separated from the run that reads it, so the
 * verdict is a function a test can drive rather than a boolean assembled inside
 * a database call.
 *
 * The separation is the point: a run can only be observed in the states a
 * database can be put into, and "the transaction granted CREATE on the schema"
 * is not one of them - which would leave the FOLD, the step that decides
 * whether a fact counts, untested while every fact around it was checked. Every
 * field below has to be able to fail the verdict on its own.
 */
export function reapplyIsExact(facts: {
  direct: readonly [string, MatrixVerdict][];
  effective: readonly [string, MatrixVerdict][];
  schemaUsageOnly: readonly [string, boolean][];
  sequencePrivilegesHeld: number;
  noMemberships: readonly [string, boolean][];
}): boolean {
  return (
    [...facts.direct, ...facts.effective].every(([, v]) => v.exact) &&
    facts.schemaUsageOnly.every(([, ok]) => ok) &&
    facts.sequencePrivilegesHeld === 0 &&
    facts.noMemberships.every(([, ok]) => ok)
  );
}

/**
 * The posture that is NOT a table grant, read from the engine.
 *
 * A matrix read alone cannot see it, and it is exactly the class G2's evidence
 * checked: a role with CREATE on the schema can make itself a table the matrix
 * has never heard of, and a sequence privilege is a write the table sweep does
 * not cover. So it is proved BEFORE the change as a precondition and AFTER it
 * as acceptance - the second is not implied by the first, because a transaction
 * that touched more than it meant to is the thing acceptance exists to catch.
 */
async function readNonTablePosture(
  ask: <T extends pg.QueryResultRow>(
    sql: string,
    args?: unknown[],
  ) => Promise<T[]>,
  roles: readonly string[],
): Promise<{
  schemaUsageOnly: [string, boolean][];
  sequencePrivilegesHeld: number;
}> {
  const schemaRows = await ask<{
    role: string;
    usage: boolean;
    create: boolean;
  }>(schemaPrivilegeSql(), [roles]);
  const schemaUsageOnly: [string, boolean][] = roles.map((role) => {
    const row = schemaRows.find((r) => r.role === role);
    return [role, row?.usage === true && row.create === false];
  });
  const held = await ask<{ held: number }>(sequencePrivilegeSql(), [roles]);
  return {
    schemaUsageOnly,
    sequencePrivilegesHeld: Number(held[0]?.held ?? -1),
  };
}

export async function reapplyMatrix(
  dsn: string,
  direction: "forward" | "reverse",
): Promise<ReapplyResult> {
  const from = direction === "forward" ? priorRuntimeRoles() : runtimeRoles();
  const to = direction === "forward" ? runtimeRoles() : priorRuntimeRoles();
  const pool = await openPool(dsn);
  const ask = async <T extends pg.QueryResultRow>(
    sql: string,
    args: unknown[] = [],
  ): Promise<T[]> => {
    try {
      return (await pool.query<T>(sql, args)).rows;
    } catch (err) {
      throw redactConnectionDetails(err, dsn);
    }
  };
  try {
    // The roles are inert and PUBLIC holds nothing on this build's tables.
    await preflight(pool, dsn, true);
    const { owner, config } = await ownerState(pool, dsn);
    if (!boundsAreExact(config, GOVERNED_SETTINGS)) {
      throw new Error(
        "refusing to re-apply the matrix: the owner role does not already " +
          "carry exactly the governed bounds. A governed database is the only " +
          "thing this step knows how to change, and a database in any other " +
          "state is a governance run rather than an incremental one.",
      );
    }
    const posture = await readRolePosture(
      (sql, args) => ask(sql, args),
      GOVERNED_SETTINGS,
      owner,
    );
    for (const { role, budget } of to) {
      const facts = posture.get(role);
      if (
        !facts?.present ||
        facts.connectionLimit !== budget ||
        !facts.boundsExact ||
        facts.canLogin ||
        facts.memberships !== 0
      ) {
        throw new Error(
          "refusing to re-apply the matrix: a runtime role is not exactly the " +
            "role this posture was approved for - its budget, its bounds, its " +
            "login state or its memberships have moved. Changing what it may " +
            "touch while what it IS has drifted is not an incremental step.",
        );
      }
    }
    const roleNames = to.map((r) => r.role);
    const before = await ask<{ role: string; table: string; verb: string }>(
      matrixSql(),
      [roleNames],
    );
    // DIRECT AND EFFECTIVE, both. The direct read lists grants whose grantee is
    // the role itself; the effective one answers what the role can actually do,
    // which accounts for PUBLIC and for memberships. A before-state proved on
    // the first alone would let a role that can already do more than the old
    // matrix through, and the change would then be measured from a state
    // nobody had established.
    const beforeEffective = await ask<EffectiveRow>(effectivePrivilegeSql(), [
      roleNames,
      [...EXPECTED_TABLES],
      [...ALL_VERBS],
    ]);
    for (const { role, grants } of from) {
      if (
        !judgeMatrix(before, role, grants).exact ||
        !judgeEffective(beforeEffective, role, grants).exact
      ) {
        throw new Error(
          "refusing to re-apply the matrix: the catalog does not carry " +
            "exactly the matrix this change moves away from, so neither the " +
            "change nor its reverse would be a known destination. Resolve the " +
            "difference by hand first.",
        );
      }
    }
    const nonTableBefore = await readNonTablePosture(ask, roleNames);
    if (
      !nonTableBefore.schemaUsageOnly.every(([, ok]) => ok) ||
      nonTableBefore.sequencePrivilegesHeld !== 0
    ) {
      throw new Error(
        "refusing to re-apply the matrix: a runtime role holds something " +
          "outside the table matrix - CREATE on the schema, or a sequence " +
          "privilege. A role that can create a table can make one this matrix " +
          "has never heard of, so changing what it may touch while that is " +
          "true would be a boundary stated about the wrong thing.",
      );
    }

    const statements = await inTransaction(
      pool,
      dsn,
      grantMatrixStatements(to),
    );

    const after = await ask<{ role: string; table: string; verb: string }>(
      matrixSql(),
      [roleNames],
    );
    const effectiveRows = await ask<EffectiveRow>(effectivePrivilegeSql(), [
      roleNames,
      [...EXPECTED_TABLES],
      [...ALL_VERBS],
    ]);
    const direct: [string, MatrixVerdict][] = [];
    const effective: [string, MatrixVerdict][] = [];
    for (const { role, grants } of to) {
      direct.push([role, judgeMatrix(after, role, grants)]);
      effective.push([role, judgeEffective(effectiveRows, role, grants)]);
    }
    // THE WHOLE POSTURE AFTER, not the half this transaction meant to move.
    // Acceptance that only re-reads what was written cannot see a transaction
    // that did more than it intended.
    const nonTableAfter = await readNonTablePosture(ask, roleNames);
    const membershipRows = await ask<{ role: string; memberships: string }>(
      roleFactsSql(),
      [roleNames],
    );
    const noMemberships: [string, boolean][] = roleNames.map((role) => [
      role,
      Number(membershipRows.find((r) => r.role === role)?.memberships ?? -1) ===
        0,
    ]);
    const facts = {
      direct,
      effective,
      schemaUsageOnly: nonTableAfter.schemaUsageOnly,
      sequencePrivilegesHeld: nonTableAfter.sequencePrivilegesHeld,
      noMemberships,
    };
    return { statements, ...facts, exact: reapplyIsExact(facts) };
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Undo the posture exactly, while no deployment authenticates as either role.
 *
 * REFUSES IF EITHER ROLE CAN LOG IN, which is the dependency check that matters:
 * a login role is one a deployment may be holding open, and dropping it turns a
 * rollback into an outage. It also refuses if either role still has a live
 * backend. Both are read before anything is written, and the whole reverse runs
 * as ONE transaction.
 */
export async function ungovern(dsn: string): Promise<{
  statements: number;
  rolesLeft: number;
  ownerConfigEntries: number;
  grantsLeft: number;
  backendsLeft: number;
}> {
  const pool = await openPool(dsn);
  try {
    const { owner } = await ownerState(pool, dsn);
    const guard = await pool
      .query<{
        login: string;
        backends: string;
      }>(
        "select count(*) filter (where r.rolcanlogin)::text as login, " +
          "(select count(*)::text from pg_stat_activity a join pg_roles ar " +
          " on ar.rolname = a.usename where ar.rolname = any($1)) as backends " +
          "from pg_roles r where r.rolname = any($1)",
        [[WEB_ROLE, PROVISIONER_ROLE]],
      )
      .catch((err: unknown) => {
        throw redactConnectionDetails(err, dsn);
      });
    if (Number(guard.rows[0]?.login ?? 0) > 0) {
      throw new Error(
        "refusing to remove the posture: one of the runtime roles can log in, " +
          "so a deployment may be authenticating as it. Roll the deployment " +
          "back to the owner DSN first; the numeric lever (connection limit -1 " +
          "and a reset of the bounds) is the rollback that is safe while a role " +
          "is in use.",
      );
    }
    if (Number(guard.rows[0]?.backends ?? 0) > 0) {
      throw new Error(
        "refusing to remove the posture: a runtime role still holds a backend",
      );
    }
    const statements = await inTransaction(
      pool,
      dsn,
      ungovernStatements({ ownerRole: owner, bounds: GOVERNED_SETTINGS }),
    );
    const left = await pool.query<{ n: string }>(
      "select count(*)::text as n from pg_roles where rolname = any($1)",
      [[WEB_ROLE, PROVISIONER_ROLE]],
    );
    // The evidence the caller refuses on. Read AFTER the transaction, from the
    // catalog, so a rollback that half-worked cannot report success.
    const after = await pool.query<{ config: string[] | null }>(
      "select rolconfig as config from pg_roles where rolname = current_user",
    );
    const grants = await pool.query<{ n: string }>(
      "select count(*)::text as n from information_schema.table_privileges " +
        "where grantee = any($1)",
      [[WEB_ROLE, PROVISIONER_ROLE]],
    );
    const backends = await pool.query<{ n: string }>(
      "select count(*)::text as n from pg_stat_activity where usename = any($1)",
      [[WEB_ROLE, PROVISIONER_ROLE]],
    );
    return {
      statements,
      rolesLeft: Number(left.rows[0]?.n ?? -1),
      ownerConfigEntries: (after.rows[0]?.config ?? []).length,
      grantsLeft: Number(grants.rows[0]?.n ?? -1),
      backendsLeft: Number(backends.rows[0]?.n ?? -1),
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Empty database to schema-ready, in the one order that works.
 *
 * ROLES, THEN SCHEMA, THEN GRANTS. The roles have to exist before the schema
 * because on a managed engine `Store.open` refuses to open unless the
 * connecting role already carries the governed bounds; the grants have to come
 * after the schema because a grant names a table. The middle step is the owner
 * building the tables it will own.
 *
 * If the schema step fails, the roles created by phase one are left behind:
 * NOLOGIN, with no grants and no password, so they can reach nothing. That
 * residue is disclosed rather than cleaned up, because a rollback that dropped
 * roles a previous successful run had created would be worse than the residue.
 */
export async function bootstrapDatabase(dsn: string): Promise<BootstrapResult> {
  const posture = await applyRolePosture(dsn);
  const store = await Store.open(dsn);
  try {
    // INSIDE the try, so a failing grant phase closes the store's pool on the
    // way out instead of leaking it. It used to sit above the try, which left a
    // pool open on every failed bootstrap.
    const granted = await applyGrantMatrix(dsn);
    // COUNTED EXACTLY, not loosely. Counting roles that carry "some limit and
    // some configuration" would print `governed-roles: 2` for a role with the
    // wrong cap and a stale setting - and this report is acceptance evidence,
    // so a count that cannot distinguish those is not evidence of anything.
    // Each role has to carry ITS budget and exactly the governed pair.
    const posture2 = await readRolePosture(
      (sql, args) => store.sqlAll(sql, args as SqlArgs),
      GOVERNED_SETTINGS,
      "",
    );
    const exact = governedRoleCount(posture2);
    const governance = { statements: posture + granted, roles: exact };
    const present = new Set(
      (
        await store.sqlAll<{ tablename: string }>(
          "select tablename from pg_tables where schemaname = current_schema()",
        )
      ).map((r) => r.tablename),
    );
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    const counts: [string, number][] = [];
    for (const table of EXPECTED_TABLES) {
      if (!present.has(table)) continue;
      const row = await store.sqlGet<{ c: number }>(
        `select count(*)::int as c from ${table}`,
      );
      counts.push([table, row?.c ?? 0]);
    }
    return {
      schemaReady: missing.length === 0,
      zeroUserData: counts.every(([t, c]) => c === 0 || SEEDED.has(t)),
      governanceExact: exact === runtimeRoles().length,
      missing,
      counts,
      governance,
    };
  } finally {
    await store.close();
  }
}

/** The transcript half. Booleans first, then the evidence behind them. */
export function reportBootstrap(result: BootstrapResult): void {
  console.log(`governance-statements: ${result.governance.statements}`);
  console.log(`governed-roles-exact: ${result.governance.roles}`);
  console.log(`governance-exact: ${result.governanceExact}`);
  console.log(`schema-ready: ${result.schemaReady}`);
  console.log(`zero-user-data: ${result.zeroUserData}`);
  if (result.missing.length > 0) {
    console.log(`missing tables: ${result.missing.join(" ")}`);
  }
  for (const [table, count] of result.counts) {
    console.log(`  ${table}: ${count} rows`);
  }
}
