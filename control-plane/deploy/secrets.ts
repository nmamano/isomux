// Put the provisioner's three FIRST-DEPLOY secrets on its machine, and prove
// nothing leaked.
//
// READ THIS BEFORE RUNNING IT ON A LIVE DEPLOYMENT: this program builds
// `CONTROL_PLANE_DB` from the operator's own env file, which holds the
// break-glass OWNER string. Running it against a deployment that has been moved
// onto a least-privileged role would stage the owner credential, and the next
// deploy would make it live. It is the bootstrap for a deployment that has none
// of its secrets yet. Provider credentials are `provider-secrets.ts`; a
// database credential move is `provisioner-move.ts`.
//
//   bun control-plane/deploy/secrets.ts --canary        what does flyctl echo?
//   bun control-plane/deploy/secrets.ts --unset-canary  remove that one name
//   bun control-plane/deploy/secrets.ts                 the real import
//   bun control-plane/deploy/secrets.ts --verify        are all boot names set?
//
// THE ORDER IS THE PROCEDURE. The canary runs first, with a value that is
// published in this file, and answers the one question a scanner cannot answer
// afterwards: does this version of flyctl repeat what it was given? If it does,
// nothing real goes near it.
//
// THE BRANCH IS PROVED BEFORE ANYTHING IS EMITTED. The database this deployment
// gets pointed at must be the project's one default branch - the API says so,
// and `targetFor` then takes its endpoint host from the API rather than from a
// hostname somebody edited. Pointing a customer's control plane at a scratch
// branch that gets deleted is the failure this refuses, and it is the mirror
// image of what testing/target.ts refuses for the suites.
//
// WHAT THIS PROGRAM PRINTS: fixed names, booleans, and an exit code. Not the
// child's output, not a digest, not a fragment of anything it read.

import {
  PRODUCTION_BRANCH,
  type Target,
  branches,
  project,
  targetFor,
} from "../exercises/neon-api.ts";
import { BRANCH_PIN_ENV } from "../boot.ts";
import {
  APP,
  CONTABO_SECRET_NAMES,
  FLYCTL,
  FLY_TOKEN_FILE,
  MINT_TOKEN_NAME,
  inspectMintFile,
  mintFileUsable,
  readSecretFile,
  realSpawn,
  type Pair,
  type Spawn,
} from "./fly-cli.ts";
import {
  CERTIFICATE_SECRET_NAMES,
  STRIPE_SECRET_NAME,
} from "./secret-names.ts";

export type { Pair };

/** The database string's name, which is the one secret the credential move
 * rotates on its own. Named here so that program cannot spell it differently. */
export const DB_SECRET_NAME = "CONTROL_PLANE_DB";

/**
 * The only names this program may set. Anything else is a refusal.
 *
 * THREE, AND THE PROVIDER CREDENTIALS ARE DELIBERATELY NOT AMONG THEM.
 * D4 added them here first, which looked tidy - one importer, one allowlist -
 * and was a live-reachable defect (reviewer finding, 2026-08-12). This program
 * builds `CONTROL_PLANE_DB` from the operator's env file, and since D3.5's
 * cutover that file holds the BREAK-GLASS OWNER string, deployed nowhere. So an
 * import that carried provider credentials would ALSO have staged the owner DSN,
 * and the deploy that followed would have moved the provisioner off its capped
 * `cp_provisioner` role and back onto the owner - undoing R-2026-08-11-1's
 * closure as a side effect of a step about provider credentials.
 *
 * The provider four live in `provider-secrets.ts`, whose allowlist is disjoint
 * from this one and pinned so by a test. The separation is structural rather
 * than procedural, because a procedure is followed from whatever transcript
 * somebody has open.
 */
export const SECRET_NAMES = [
  DB_SECRET_NAME,
  BRANCH_PIN_ENV,
  MINT_TOKEN_NAME,
] as const;

/** Every Fly secret the provisioner needs to boot and complete its work. */
export const BOOT_REQUIRED_NAMES = [
  ...SECRET_NAMES,
  ...CONTABO_SECRET_NAMES,
  STRIPE_SECRET_NAME,
  ...CERTIFICATE_SECRET_NAMES,
] as const;

/**
 * The echo probe's value, published on purpose.
 *
 * A random value would have been a secret nobody needed, and a leak of it would
 * have been indistinguishable from a leak that mattered. This one can be
 * printed, searched for and quoted in a report.
 */
export const CANARY_NAME = "PROBE_CANARY";
export const CANARY_VALUE = "isomux-d2-public-canary";

export interface PushOutcome {
  /** False when validation refused, in which case no child ever ran. */
  spawned: boolean;
  exitCode: number | null;
  /** Fixed sentences. A problem never quotes the value that caused it. */
  problems: string[];
  /** Did flyctl repeat any value we gave it? Diagnostic, not the guarantee. */
  valueInChildOutput: boolean;
}

/**
 * Everything that has to be true before a value may be handed to a child.
 *
 * A newline would end one NAME=VALUE line and begin another, so a value
 * carrying one could set a name nobody asked for. A NUL is the same argument
 * one layer down. Both are checked here, before the child exists.
 */
export function validatePairs(
  pairs: Pair[],
  allowed: readonly string[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (!allowed.includes(pair.name)) {
      problems.push(`not an allowed secret name: ${pair.name}`);
      continue;
    }
    if (seen.has(pair.name)) problems.push(`named twice: ${pair.name}`);
    seen.add(pair.name);
    if (pair.value.length === 0) problems.push(`empty value: ${pair.name}`);
    if (/[\n\r]/.test(pair.value)) {
      problems.push(`value carries a line break: ${pair.name}`);
    }
    if (pair.value.includes("\0")) {
      problems.push(`value carries a NUL: ${pair.name}`);
    }
  }
  return problems;
}

/**
 * Validate, then spawn flyctl with the values on its stdin.
 *
 * The child's bytes are scanned and then dropped. They are not returned, not
 * logged and not attached to an error: the caller cannot print what it was
 * never given, which is the property that does not depend on a scanner being
 * complete.
 */
export async function pushSecrets(opts: {
  pairs: Pair[];
  allowed: readonly string[];
  flyToken: string;
  spawn: Spawn;
  app?: string;
}): Promise<PushOutcome> {
  const problems = validatePairs(opts.pairs, opts.allowed);
  if (problems.length > 0) {
    return {
      spawned: false,
      exitCode: null,
      problems,
      valueInChildOutput: false,
    };
  }
  const stdin = `${opts.pairs.map((p) => `${p.name}=${p.value}`).join("\n")}\n`;
  const result = await opts.spawn(
    [FLYCTL, "secrets", "import", "-a", opts.app ?? APP, "--stage"],
    { FLY_API_TOKEN: opts.flyToken },
    stdin,
  );
  const seen = `${result.stdout}\n${result.stderr}`;
  return {
    spawned: true,
    exitCode: result.code,
    problems: [],
    valueInChildOutput: opts.pairs.some((p) => seen.includes(p.value)),
  };
}

/**
 * The echo probe, as an operation with NO ARGUMENTS.
 *
 * Deliberately not "call pushSecrets with these two strings": a mode that takes
 * a name and a value is a mode that can set any name, and this one runs before
 * anything real has been imported. The name, the value and the allowlist are
 * all constants of this function, so the only secret it can create is the one
 * published in this file.
 */
export async function pushCanary(opts: {
  flyToken: string;
  spawn: Spawn;
  app?: string;
}): Promise<PushOutcome> {
  return pushSecrets({
    pairs: [{ name: CANARY_NAME, value: CANARY_VALUE }],
    allowed: [CANARY_NAME],
    flyToken: opts.flyToken,
    spawn: opts.spawn,
    app: opts.app,
  });
}

/**
 * Remove the probe, and only the probe.
 *
 * The name is a constant here for the same reason it is a constant above: a
 * procedure with a hand-typed secret name in it is one typo away from removing
 * something the machine needs.
 */
export async function unsetCanary(opts: {
  flyToken: string;
  spawn: Spawn;
  app?: string;
}): Promise<{ exitCode: number }> {
  const result = await opts.spawn(
    [FLYCTL, "secrets", "unset", CANARY_NAME, "-a", opts.app ?? APP, "--stage"],
    { FLY_API_TOKEN: opts.flyToken },
    "",
  );
  // The child's bytes are dropped here too, for the same reason as everywhere
  // else in this file.
  return { exitCode: result.code };
}

/**
 * Which of the required names the app carries, from a listing that is parsed
 * and discarded.
 *
 * `flyctl secrets list` prints a DIGEST beside each name. A digest is derived
 * from the value, so it is not ours to print - the answer here is a boolean
 * about names we already know.
 */
export async function namesPresent(opts: {
  /** Which names to ask about. Passed in, because two programs ask about two
   * disjoint sets and neither may answer for the other's. */
  required: readonly string[];
  flyToken: string;
  spawn: Spawn;
  app?: string;
}): Promise<{ present: boolean; readable: boolean }> {
  const result = await opts.spawn(
    [FLYCTL, "secrets", "list", "-a", opts.app ?? APP, "--json"],
    { FLY_API_TOKEN: opts.flyToken },
    "",
  );
  if (result.code !== 0) return { present: false, readable: false };
  let names: string[];
  try {
    const rows = JSON.parse(result.stdout) as {
      Name?: string;
      name?: string;
    }[];
    names = rows.map((r) => r.Name ?? r.name ?? "");
  } catch {
    return { present: false, readable: false };
  }
  return {
    present: opts.required.every((n) => names.includes(n)),
    readable: true,
  };
}

/**
 * The one branch a deployment may be pointed at, and the direct endpoint that
 * belongs to it - proved from the API before any value is built.
 *
 * Exported because the credential move rotates the same secret against the same
 * branch: two programs deciding separately which branch is production is two
 * chances to point a deployment at a scratch branch that gets deleted.
 */
export async function provenProductionTarget(): Promise<Target> {
  const { id: projectId } = await project();
  const all = await branches(projectId);
  const defaults = all.filter((b) => b.isDefault && !b.hasParent);
  if (defaults.length !== 1) {
    throw new Error(
      `refusing: the project shows ${defaults.length} default branches ` +
        `without a parent, and a deployment may only be pointed at one`,
    );
  }
  if (defaults[0].name !== PRODUCTION_BRANCH) {
    throw new Error(
      `refusing: the project's default branch is not named ${PRODUCTION_BRANCH}`,
    );
  }
  const target = await targetFor(PRODUCTION_BRANCH);
  if (target.branch.id !== defaults[0].id) {
    throw new Error("refusing: the resolved branch is not the default one");
  }
  if (!target.hostFromApi) {
    throw new Error(
      "refusing: the endpoint host did not come from the API, and a deployment " +
        "is not the place for the fallback",
    );
  }
  return target;
}

/**
 * The database string and the branch id it must prove at boot, built in this
 * process and never written down.
 */
async function neonProductionPair(): Promise<Pair[]> {
  const target = await provenProductionTarget();
  return [
    { name: DB_SECRET_NAME, value: target.dsn },
    { name: BRANCH_PIN_ENV, value: target.branch.id },
  ];
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  const flyToken = readSecretFile(FLY_TOKEN_FILE);

  if (mode === "--canary") {
    // A PUBLIC value, so a leak of it is an observation rather than an
    // incident. If flyctl echoes this, no real value goes near it.
    const outcome = await pushCanary({ flyToken, spawn: realSpawn });
    console.log(`canary_name: ${CANARY_NAME}`);
    console.log(`spawned: ${outcome.spawned}`);
    console.log(`flyctl_exit: ${outcome.exitCode}`);
    console.log(`canary_echoed: ${outcome.valueInChildOutput}`);
    process.exitCode =
      outcome.exitCode === 0 && !outcome.valueInChildOutput ? 0 : 1;
    return;
  }

  if (mode === "--unset-canary") {
    const outcome = await unsetCanary({ flyToken, spawn: realSpawn });
    console.log(`unset_name: ${CANARY_NAME}`);
    console.log(`flyctl_exit: ${outcome.exitCode}`);
    process.exitCode = outcome.exitCode === 0 ? 0 : 1;
    return;
  }

  if (mode === "--verify") {
    const answer = await namesPresent({
      required: BOOT_REQUIRED_NAMES,
      flyToken,
      spawn: realSpawn,
    });
    console.log(`listing_readable: ${answer.readable}`);
    console.log(`required_secret_names_present: ${answer.present}`);
    for (const name of BOOT_REQUIRED_NAMES) console.log(`  required: ${name}`);
    process.exitCode = answer.present ? 0 : 1;
    return;
  }

  // The credential file is checked HERE, by the process that is about to use
  // it, against the exact shape it was promised to have. A check somebody ran
  // earlier is a statement about a file that has since had time to change.
  const mint = inspectMintFile();
  console.log(`mint_file_present: ${mint.checks.present}`);
  console.log(`mint_file_regular: ${mint.checks.regularFile}`);
  console.log(`mint_file_mode_600: ${mint.checks.mode600}`);
  console.log(`mint_file_shape_ok: ${mint.checks.shapeOk}`);
  if (!mintFileUsable(mint.checks)) {
    console.log("refusing: the seam credential file is not in the ruled shape");
    process.exitCode = 2;
    return;
  }

  const pairs = [
    ...(await neonProductionPair()),
    { name: MINT_TOKEN_NAME, value: mint.token },
  ];
  const outcome = await pushSecrets({
    pairs,
    allowed: SECRET_NAMES,
    flyToken,
    spawn: realSpawn,
  });
  for (const name of SECRET_NAMES) console.log(`  set: ${name}`);
  console.log(`branch_proved_default_production: true`);
  console.log(`validated: ${outcome.problems.length === 0}`);
  for (const problem of outcome.problems) console.log(`  problem: ${problem}`);
  console.log(`spawned: ${outcome.spawned}`);
  console.log(`flyctl_exit: ${outcome.exitCode}`);
  console.log(`value_in_child_output: ${outcome.valueInChildOutput}`);
  process.exitCode =
    outcome.spawned && outcome.exitCode === 0 && !outcome.valueInChildOutput
      ? 0
      : 1;
}

if (import.meta.main) {
  await main();
}
