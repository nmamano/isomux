#!/usr/bin/env bun
// The operator's half of the Neon rig. Every guard lives in `neon-api.ts`; this
// file is the command surface over it, and its whole output contract is that
// each line is a BOOLEAN or a count.
//
// Usage:
//   bun control-plane/exercises/neon.ts branches
//   bun control-plane/exercises/neon.ts branch --create suites
//   bun control-plane/exercises/neon.ts branch --delete suites
//   bun control-plane/exercises/neon.ts measure --branch suites
//   bun control-plane/exercises/neon.ts run --branch suites -- bun test control-plane
//   bun control-plane/exercises/neon.ts bootstrap --branch production
//   bun control-plane/exercises/neon.ts regovern --branch suites
//   bun control-plane/exercises/neon.ts regovern --branch suites --reverse

import pg from "pg";
import { redactConnectionDetails } from "../store.ts";
import {
  PRODUCTION_BRANCH,
  SUITES_BRANCH,
  branchNamed,
  branches,
  createBranch,
  deleteBranch,
  liveBranchId,
  project,
  targetFor,
} from "./neon-api.ts";
import {
  EXPECTED_TABLES,
  applyGovernance,
  bootstrapDatabase,
  reapplyMatrix,
  reportBootstrap,
  ungovern,
} from "../bootstrap.ts";
import { GOVERNED_SETTINGS } from "../store.ts";
import {
  ALL_VERBS,
  type EffectiveRow,
  PROVISIONER_ROLE,
  WEB_ROLE,
  budgetFor,
  effectivePrivilegeSql,
  failedClaims,
  judgeEffective,
  judgeMatrix,
  labelFor,
  matrixSql,
  postureLine,
  readRolePosture,
  runtimeRoles,
  schemaPrivilegeSql,
  sequencePrivilegeSql,
} from "../roles.ts";

function die(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  flags: Map<string, string>;
  rest: string[];
} {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (argv[i].startsWith("--")) {
      const name = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, "true");
      }
    }
  }
  return { flags, rest };
}

async function cmdBranches(): Promise<void> {
  const { id } = await project();
  console.log("project matched: true");
  for (const b of await branches(id)) {
    // The NAME is ours - we chose it. The id is not printed.
    console.log(
      `branch ${b.name}: default=${b.isDefault} has-parent=${b.hasParent}`,
    );
  }
}

async function cmdBranchCreate(name: string): Promise<void> {
  if (name === PRODUCTION_BRANCH) die("this rig does not create production");
  const { id: projectId } = await project();
  if ((await branches(projectId)).some((b) => b.name === name)) {
    die(`a branch named ${name} already exists`);
  }
  const parent = await branchNamed(projectId, PRODUCTION_BRANCH);
  if (!parent.isDefault) die("the branch named production is not the default");
  await createBranch(projectId, name, parent);
  const made = await branchNamed(projectId, name);
  console.log("created: true");
  console.log(`is default: ${made.isDefault}`);
  console.log(`has parent: ${made.hasParent}`);
}

async function cmdBranchDelete(name: string): Promise<void> {
  if (name === PRODUCTION_BRANCH) die("this rig does not delete production");
  const { id: projectId } = await project();
  const branch = await branchNamed(projectId, name);
  if (branch.isDefault) die("refusing to delete the default branch");
  if (!branch.hasParent) die("refusing to delete a branch with no parent");
  await deleteBranch(projectId, branch);
  const left = (await branches(projectId)).filter((b) => b.name === name);
  console.log(`deleted: ${left.length === 0}`);
}

/**
 * The measurement the manager asked for before anything depends on it: does the
 * engine on a real connection carry its own branch id, and is it the id the API
 * reports for that branch?
 */
async function cmdMeasure(branchName: string): Promise<void> {
  const target = await targetFor(branchName);
  console.log("project matched: true");
  console.log(`branch is default: ${target.branch.isDefault}`);
  console.log(`branch has a parent: ${target.branch.hasParent}`);
  console.log(`endpoint host came from the API: ${target.hostFromApi}`);
  console.log("host carries -pooler: false");
  console.log("credentials came from the env DSN: true");

  const live = await liveBranchId(target.dsn);
  console.log(`neon.branch_id present on the session: ${live !== null}`);
  console.log(
    `live branch id equals the API's branch id: ${live === target.branch.id}`,
  );

  // The raw query is wrapped: a driver failure here carries the address and, on
  // a 28P01, the role, and letting it reach `main()` would print exactly what
  // ruling 8 forbids. It is transformed at the boundary, not after capture.
  const pool = new pg.Pool({
    connectionString: target.dsn,
    connectionTimeoutMillis: 30_000,
  });
  pool.on("error", () => {});
  try {
    const tables = await pool.query<{ c: number }>(
      "select count(*)::int as c from pg_tables where schemaname = 'public'",
    );
    console.log(`public tables on this branch: ${tables.rows[0].c}`);
  } catch (err) {
    throw redactConnectionDetails(err, target.dsn);
  } finally {
    await pool.end().catch(() => {});
  }

  // A measurement command that printed `false` and exited 0 would let a failed
  // predicate pass for a successful run - and this is the predicate the whole
  // branch proof rests on.
  if (live === null || live !== target.branch.id) {
    die("the engine did not confirm which branch is answering");
  }
}

async function cmdRun(branchName: string, command: string[]): Promise<void> {
  if (command.length === 0) die("nothing to run after --");
  if (branchName === PRODUCTION_BRANCH) {
    die("refusing to run a command against production");
  }
  const target = await targetFor(branchName);
  if (target.branch.isDefault) {
    die("refusing to run a command against the default branch");
  }
  if (!target.branch.hasParent) {
    die("refusing to run a command against a branch with no parent");
  }
  if ((await liveBranchId(target.dsn)) !== target.branch.id) {
    die("the engine did not confirm which branch is answering");
  }
  console.log("branch is default: false");
  console.log("engine confirmed the branch: true");
  const child = Bun.spawn(command, {
    env: { ...process.env, CONTROL_PLANE_DB: target.dsn },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(await child.exited);
}

/**
 * Bring the PRODUCTION branch from empty to schema-ready, and prove the target
 * before a single statement is written.
 *
 * The proof runs from two directions, because a supplied DSN is not evidence of
 * anything: the API says which branch this host belongs to and whether it is
 * the default with no parent, and then the ENGINE says which branch is
 * answering. Only when both agree does the generic bootstrap open a store.
 */
async function cmdBootstrap(branchName: string): Promise<void> {
  if (branchName !== PRODUCTION_BRANCH) {
    die(
      `bootstrap targets ${PRODUCTION_BRANCH}; it was asked for ${branchName}`,
    );
  }
  const target = await targetFor(branchName);
  console.log("project matched: true");
  console.log(`endpoint host came from the API: ${target.hostFromApi}`);
  console.log("host carries -pooler: false");
  console.log("credentials came from the env DSN: true");
  console.log(`branch is default: ${target.branch.isDefault}`);
  console.log(`branch has a parent: ${target.branch.hasParent}`);
  if (!target.branch.isDefault || target.branch.hasParent) {
    die("this is not the production branch");
  }
  const live = await liveBranchId(target.dsn);
  console.log(
    `engine branch id matches the API branch id: ${live === target.branch.id}`,
  );
  if (live !== target.branch.id) {
    die("the engine did not confirm which branch is answering");
  }

  const result = await bootstrapDatabase(target.dsn);
  reportBootstrap(result);
  if (!result.schemaReady || !result.zeroUserData || !result.governanceExact) {
    process.exit(1);
  }
}

/**
 * Put the connection posture on a branch, and prove what it did NOT change.
 *
 * The same program for every branch, because the risky one is production and a
 * step that is rehearsed somewhere else is a step nobody has run. What differs
 * is only the evidence it prints about the rows it found.
 *
 * TWO REFUSALS BEFORE ANY STATEMENT. The engine has to confirm which branch is
 * answering - the same proof every other command here makes - and the OWNER's
 * live backend count has to fit inside the budget it is about to be given.
 * `rolconnlimit` is checked when a backend is created, so sessions that already
 * exist are grandfathered and only the NEXT one would be refused: applying a
 * cap of 30 while 31 owner sessions are open would leave a database nobody can
 * open a new connection to, and finding that out afterwards is not a plan.
 *
 * Every line is a boolean or a small integer. Row counts are compared and
 * reported as UNCHANGED rather than printed: what a customer database holds is
 * not transcript material, and the question this step has to answer is whether
 * it moved.
 */
async function cmdGovern(branchName: string): Promise<void> {
  const target = await targetFor(branchName);
  // ON PRODUCTION the account predicate is ruling 4's, and it is checked BEFORE
  // any mutation as well as after: the default branch carries the one real
  // account and nothing else. A child branch is where test rows belong, so the
  // predicate is branched on PROVED branch identity rather than on a flag.
  const isProduction = target.branch.isDefault && !target.branch.hasParent;
  const verdict: [string, boolean][] = [];
  const claim = (name: string, ok: boolean): boolean => {
    verdict.push([name, ok]);
    console.log(`${name}: ${ok}`);
    return ok;
  };

  console.log("project matched: true");
  console.log(`endpoint host came from the API: ${target.hostFromApi}`);
  console.log(`targets_production: ${isProduction}`);
  const live = await liveBranchId(target.dsn);
  claim("engine_branch_matches_api", live === target.branch.id);
  if (live !== target.branch.id) {
    die("the engine did not confirm which branch is answering");
  }

  const pool = new pg.Pool({
    connectionString: target.dsn,
    connectionTimeoutMillis: 30_000,
  });
  pool.on("error", () => {});
  const ask = async <T extends pg.QueryResultRow>(
    sql: string,
    args: unknown[] = [],
  ): Promise<T[]> => {
    try {
      return (await pool.query<T>(sql, args)).rows;
    } catch (err) {
      throw redactConnectionDetails(err, target.dsn);
    }
  };

  try {
    const owner =
      (await ask<{ owner: string }>("select current_user as owner"))[0]
        ?.owner ?? "";

    const backends = Number(
      (
        await ask<{ n: string }>(
          "select count(*)::text as n from pg_stat_activity where usename = current_user",
        )
      )[0]?.n ?? -1,
    );
    console.log(`owner_backends_now: ${backends}`);

    // THE OWNER'S BASELINE, fixed and proved before any write. `ungovern`
    // resets the two bounds to nothing, so a rollback is only EXACT if the
    // owner carried nothing when this ran. Requiring it here is what makes the
    // reverse exact rather than approximately exact.
    const ownerConfig =
      (
        await ask<{ config: string[] | null }>(
          "select rolconfig as config from pg_roles where rolname = current_user",
        )
      )[0]?.config ?? [];
    claim("owner_config_empty_before", ownerConfig.length === 0);

    const counts = async (): Promise<Map<string, number>> => {
      const out = new Map<string, number>();
      for (const table of EXPECTED_TABLES) {
        const row = await ask<{ c: number }>(
          `select count(*)::int as c from ${table}`,
        );
        out.set(table, row[0]?.c ?? -1);
      }
      return out;
    };
    const before = await counts();
    const accountsBefore = before.get("accounts") === 1;
    if (isProduction) claim("accounts_exactly_1_before", accountsBefore);
    else console.log(`accounts_before: ${before.get("accounts") !== -1}`);

    // EVERY PREDICATE THAT MUST HOLD BEFORE A WRITE is settled here, so a
    // refusal costs nothing. A program that mutates and then reports a failed
    // predicate has already done the thing the predicate was guarding.
    if (failedClaims(verdict).length > 0) {
      die("a precondition does not hold; nothing was written");
    }

    const applied = await applyGovernance(target.dsn);
    console.log(`governance_statements: ${applied.statements}`);

    const after = await counts();
    if (isProduction)
      claim("accounts_exactly_1_after", after.get("accounts") === 1);
    let moved = 0;
    for (const table of EXPECTED_TABLES) {
      const same = before.get(table) === after.get(table);
      if (!same) moved++;
      console.log(`  ${table}_unchanged: ${same}`);
    }
    claim("user_tables_unchanged", moved === 0);

    // DIRECT grants, and then what the roles can ACTUALLY do - which accounts
    // for PUBLIC and for memberships, and is the only one of the two that
    // describes the boundary.
    const matrixRows = await ask<{ role: string; table: string; verb: string }>(
      matrixSql(),
      [[WEB_ROLE, PROVISIONER_ROLE]],
    );
    const effectiveRows = await ask<EffectiveRow>(effectivePrivilegeSql(), [
      [WEB_ROLE, PROVISIONER_ROLE],
      [...EXPECTED_TABLES],
      [...ALL_VERBS],
    ]);
    for (const { role, grants } of runtimeRoles()) {
      const label = labelFor(role, owner);
      const direct = judgeMatrix(matrixRows, role, grants);
      const effective = judgeEffective(effectiveRows, role, grants);
      claim(`${label}_matrix_exact`, direct.exact);
      claim(`${label}_effective_privilege_exact`, effective.exact);
      console.log(`    ${label}_effective_missing: ${effective.missing}`);
      console.log(`    ${label}_effective_excess: ${effective.excess}`);
    }

    // The SCHEMA and the SEQUENCES, effectively. The statements intend usage
    // without create and no sequence privilege at all; this proves it from the
    // engine rather than inferring it from what was asked for.
    const schemaRows = await ask<{
      role: string;
      usage: boolean;
      create: boolean;
    }>(schemaPrivilegeSql(), [[WEB_ROLE, PROVISIONER_ROLE]]);
    for (const { role } of runtimeRoles()) {
      const label = labelFor(role, owner);
      const row = schemaRows.find((r) => r.role === role);
      claim(
        `${label}_schema_usage_only`,
        row?.usage === true && row.create === false,
      );
    }
    const heldSequences = await ask<{ held: number }>(sequencePrivilegeSql(), [
      [WEB_ROLE, PROVISIONER_ROLE],
    ]);
    claim("no_sequence_privileges", (heldSequences[0]?.held ?? -1) === 0);

    const posture = await readRolePosture(
      (sql, args) => ask(sql, args),
      GOVERNED_SETTINGS,
      owner,
    );
    for (const [role, facts] of posture) {
      const label = labelFor(role, owner);
      const budget = budgetFor(role, owner);
      claim(`${label}_role_present`, facts.present);
      if (label === "owner") {
        claim("owner_uncapped_break_glass", facts.connectionLimit === -1);
      } else {
        claim(
          `${label}_connection_limit_exact`,
          facts.connectionLimit === budget,
        );
        claim(`${label}_is_nologin`, facts.canLogin === false);
        claim(`${label}_no_memberships`, facts.memberships === 0);
      }
      claim(`${label}_bounds_exact`, facts.boundsExact);
    }
    console.log(postureLine());

    // ONE VERDICT, from every predicate, and the exit code is that verdict.
    // Printing a false predicate and exiting zero is how a gate becomes a
    // formality.
    const failed = failedClaims(verdict);
    console.log(`acceptance: ${failed.length === 0}`);
    if (failed.length > 0) {
      die(`${failed.length} acceptance predicates do not hold`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * CHANGE THE MATRIX ON A BRANCH THAT IS ALREADY GOVERNED.
 *
 * A DIFFERENT PATH FROM `govern`, NOT A RERUN OF IT, and the difference is what
 * production holds. `govern` requires the owner to carry NO configuration
 * before it writes - the baseline that makes `ungovern` an exact reverse - and
 * production has carried the governed pair since G2, so that predicate cannot
 * truthfully pass there. Running `govern` again would either refuse or, worse,
 * be made to pass by weakening the predicate that keeps the reverse exact.
 *
 * And `ungovern` is not this step's rollback. It drops both roles; the reverse
 * of one incremental grant change is the OLD MATRIX RESTORED, in one
 * transaction, with the roles left exactly as they are. `--reverse` is that,
 * and it is the same program with the two rosters swapped rather than a second
 * one that has to be kept in agreement.
 *
 * The evidence is the same shape as `govern`'s because an operator reads both:
 * booleans and counts, no role names, row counts compared and reported as
 * UNCHANGED rather than printed, and the exit code IS the verdict.
 */
async function cmdRegovern(
  branchName: string,
  reverse: boolean,
): Promise<void> {
  const target = await targetFor(branchName);
  const isProduction = target.branch.isDefault && !target.branch.hasParent;
  const verdict: [string, boolean][] = [];
  const claim = (name: string, ok: boolean): boolean => {
    verdict.push([name, ok]);
    console.log(`${name}: ${ok}`);
    return ok;
  };

  console.log("project matched: true");
  console.log(`endpoint host came from the API: ${target.hostFromApi}`);
  console.log(`targets_production: ${isProduction}`);
  console.log(`direction: ${reverse ? "reverse" : "forward"}`);
  const live = await liveBranchId(target.dsn);
  claim("engine_branch_matches_api", live === target.branch.id);
  if (live !== target.branch.id) {
    die("the engine did not confirm which branch is answering");
  }

  const pool = new pg.Pool({
    connectionString: target.dsn,
    connectionTimeoutMillis: 30_000,
  });
  pool.on("error", () => {});
  const ask = async <T extends pg.QueryResultRow>(
    sql: string,
    args: unknown[] = [],
  ): Promise<T[]> => {
    try {
      return (await pool.query<T>(sql, args)).rows;
    } catch (err) {
      throw redactConnectionDetails(err, target.dsn);
    }
  };

  try {
    const owner =
      (await ask<{ owner: string }>("select current_user as owner"))[0]
        ?.owner ?? "";

    // THE OWNER'S BASELINE IS THE OPPOSITE OF `govern`'S. This step runs on a
    // database this build already governed, so the honest predicate is "the
    // owner carries exactly our pair" - and a `govern`-shaped
    // `owner_config_empty_before` here would be a false claim.
    const ownerConfig =
      (
        await ask<{ config: string[] | null }>(
          "select rolconfig as config from pg_roles where rolname = current_user",
        )
      )[0]?.config ?? [];
    claim(
      "owner_config_already_exact",
      ownerConfig.length === GOVERNED_SETTINGS.length,
    );

    const counts = async (): Promise<Map<string, number>> => {
      const out = new Map<string, number>();
      for (const table of EXPECTED_TABLES) {
        const row = await ask<{ c: number }>(
          `select count(*)::int as c from ${table}`,
        );
        out.set(table, row[0]?.c ?? -1);
      }
      return out;
    };
    const before = await counts();
    if (isProduction) {
      claim("accounts_exactly_1_before", before.get("accounts") === 1);
    } else {
      console.log(`accounts_before: ${before.get("accounts") !== -1}`);
    }

    if (failedClaims(verdict).length > 0) {
      die("a precondition does not hold; nothing was written");
    }

    // Every remaining precondition - the roles inert, their budgets and bounds
    // exact, PUBLIC holding nothing, and the OLD matrix exactly as it must be -
    // is read inside this call, before its transaction opens. A refusal there
    // arrives as an exception with nothing written.
    const applied = await reapplyMatrix(
      target.dsn,
      reverse ? "reverse" : "forward",
    );
    console.log(`matrix_statements: ${applied.statements}`);

    const after = await counts();
    if (isProduction) {
      claim("accounts_exactly_1_after", after.get("accounts") === 1);
    }
    let moved = 0;
    for (const table of EXPECTED_TABLES) {
      const same = before.get(table) === after.get(table);
      if (!same) moved++;
      console.log(`  ${table}_unchanged: ${same}`);
    }
    claim("user_tables_unchanged", moved === 0);
    claim("all_expected_tables_counted", after.size === EXPECTED_TABLES.length);

    for (const [role, direct] of applied.direct) {
      claim(`${labelFor(role, owner)}_matrix_exact`, direct.exact);
    }
    for (const [role, effective] of applied.effective) {
      const label = labelFor(role, owner);
      claim(`${label}_effective_privilege_exact`, effective.exact);
      console.log(`    ${label}_effective_missing: ${effective.missing}`);
      console.log(`    ${label}_effective_excess: ${effective.excess}`);
    }
    // THE POSTURE OUTSIDE THE TABLE MATRIX, which a matrix read cannot see and
    // which G2's evidence checked: a role that can CREATE on the schema can
    // make a table this matrix has never heard of, and a sequence privilege is
    // a write the table sweep does not cover.
    for (const [role, ok] of applied.schemaUsageOnly) {
      claim(`${labelFor(role, owner)}_schema_usage_only`, ok);
    }
    claim("no_sequence_privileges", applied.sequencePrivilegesHeld === 0);
    for (const [role, ok] of applied.noMemberships) {
      claim(`${labelFor(role, owner)}_no_memberships`, ok);
    }

    // The roles themselves must be exactly what they were: this step changes
    // what they may touch and nothing else.
    const posture = await readRolePosture(
      (sql, args) => ask(sql, args),
      GOVERNED_SETTINGS,
      owner,
    );
    for (const { role } of runtimeRoles()) {
      const label = labelFor(role, owner);
      const facts = posture.get(role);
      claim(
        `${label}_connection_limit_exact`,
        facts?.connectionLimit === budgetFor(role, owner),
      );
      claim(`${label}_is_nologin`, facts?.canLogin === false);
      claim(`${label}_bounds_exact`, facts?.boundsExact === true);
    }
    console.log(postureLine());

    const failed = failedClaims(verdict);
    console.log(`acceptance: ${failed.length === 0}`);
    if (failed.length > 0) {
      die(`${failed.length} acceptance predicates do not hold`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * The reverse of `govern`, for a posture no deployment is using yet.
 *
 * Fixed output, so a rehearsal and a real rollback read the same. It refuses if
 * either runtime role can log in - see `ungovern` - which is what keeps this
 * from being an outage lever rather than a rollback one.
 */
async function cmdUngovern(branchName: string): Promise<void> {
  const target = await targetFor(branchName);
  console.log(`branch is default: ${target.branch.isDefault}`);
  const live = await liveBranchId(target.dsn);
  console.log(
    `engine branch id matches the API branch id: ${live === target.branch.id}`,
  );
  if (live !== target.branch.id) {
    die("the engine did not confirm which branch is answering");
  }
  const pool = new pg.Pool({
    connectionString: target.dsn,
    connectionTimeoutMillis: 30_000,
  });
  pool.on("error", () => {});
  try {
    const before = new Map<string, number>();
    for (const table of EXPECTED_TABLES) {
      const row = await pool.query<{ c: number }>(
        `select count(*)::int as c from ${table}`,
      );
      before.set(table, row.rows[0]?.c ?? -1);
    }
    const result = await ungovern(target.dsn);
    console.log(`ungovern_statements: ${result.statements}`);
    console.log(`runtime_roles_remaining: ${result.rolesLeft}`);
    console.log(`runtime_grants_remaining: ${result.grantsLeft}`);
    console.log(`runtime_backends_remaining: ${result.backendsLeft}`);
    console.log(`owner_config_entries_after: ${result.ownerConfigEntries}`);
    let moved = 0;
    for (const table of EXPECTED_TABLES) {
      const row = await pool.query<{ c: number }>(
        `select count(*)::int as c from ${table}`,
      );
      if ((row.rows[0]?.c ?? -1) !== before.get(table)) moved++;
    }
    console.log(`user_tables_unchanged: ${moved === 0}`);
    const owner = await pool.query<{ n: string }>(
      "select coalesce(array_length(rolconfig, 1), 0)::text as n from pg_roles " +
        "where rolname = current_user",
    );
    console.log(`owner_rolconfig_entries: ${owner.rows[0]?.n ?? "unreadable"}`);
    // The reverse is judged by every one of its own predicates, not by two of
    // them: roles gone, grants gone, nobody connected as either, the owner's
    // configuration back to the baseline this build requires before it writes,
    // and no user row moved.
    const acceptance =
      result.rolesLeft === 0 &&
      result.grantsLeft === 0 &&
      result.backendsLeft === 0 &&
      result.ownerConfigEntries === 0 &&
      moved === 0;
    console.log(`acceptance: ${acceptance}`);
    if (!acceptance) {
      die("the reverse did not leave the database as it found it");
    }
  } catch (err) {
    throw redactConnectionDetails(err, target.dsn);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseArgs(argv);
  switch (cmd) {
    case "branches":
      return cmdBranches();
    case "branch": {
      const create = flags.get("create");
      const remove = flags.get("delete");
      if (create && create !== "true") return cmdBranchCreate(create);
      if (remove && remove !== "true") return cmdBranchDelete(remove);
      return die("branch takes --create <name> or --delete <name>");
    }
    case "measure":
      return cmdMeasure(flags.get("branch") ?? SUITES_BRANCH);
    case "run":
      return cmdRun(flags.get("branch") ?? SUITES_BRANCH, rest);
    case "bootstrap":
      return cmdBootstrap(flags.get("branch") ?? PRODUCTION_BRANCH);
    case "govern":
      return cmdGovern(flags.get("branch") ?? SUITES_BRANCH);
    case "regovern":
      return cmdRegovern(
        flags.get("branch") ?? SUITES_BRANCH,
        flags.get("reverse") === "true",
      );
    case "ungovern":
      return cmdUngovern(flags.get("branch") ?? SUITES_BRANCH);
    default:
      console.error(
        "usage: bun control-plane/exercises/neon.ts " +
          "<branches|branch|measure|run|bootstrap|govern|regovern|ungovern> " +
          "[--flags] " +
          "[-- command...]",
      );
      process.exit(2);
  }
}

try {
  await main();
} catch (err) {
  // Every guard in the library throws rather than exits, so this is the one
  // place a refusal becomes an exit code. The message is the library's, which
  // is boolean-and-count shaped by construction.
  die(err instanceof Error ? err.message : String(err));
}
