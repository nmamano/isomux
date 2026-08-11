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
import { bootstrapDatabase, reportBootstrap } from "../bootstrap.ts";

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
  if (!result.schemaReady || !result.zeroUserData) process.exit(1);
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
    default:
      console.error(
        "usage: bun control-plane/exercises/neon.ts " +
          "<branches|branch|measure|run|bootstrap> [--flags] [-- command...]",
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
