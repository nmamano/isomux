// The four provider credentials, and NOTHING ELSE, onto the provisioner.
//
//   bun control-plane/deploy/provider-secrets.ts            stage the four
//   bun control-plane/deploy/provider-secrets.ts --verify   are the four set?
//
// WHY THIS IS ITS OWN PROGRAM, and the defect that made it one. D4 first added
// the provider names to `deploy/secrets.ts`'s allowlist, which looked like the
// tidy choice: one importer, one allowlist, one procedure. It was not. That
// program is the FIRST-DEPLOY bootstrap, and it builds `CONTROL_PLANE_DB` from
// the operator's own env file - which since D3.5's cutover holds the BREAK-GLASS
// OWNER string, deployed nowhere. Importing its full set and deploying would
// have moved the provisioner off `cp_provisioner` and back onto the owner
// credential, silently, as a side effect of a step whose stated purpose was
// provider credentials - undoing the finding D3.5 closed the night before
// (reviewer finding, 2026-08-12; the worker wrote the defect).
//
// So the separation is structural rather than procedural. This program cannot
// name the database string, the branch pin or the seam bearer: its allowlist is
// the four provider names, `validatePairs` refuses anything outside it before a
// child exists, and it never opens the Neon API or the mint file at all. The
// old program cannot name the provider four for the mirror-image reason.
//
// Everything else is the shape `deploy/secrets.ts` established and this file
// reuses rather than restates: values read inside this process, never expanded
// by a shell, never in argv, handed to flyctl over stdin, and the child's bytes
// captured and dropped rather than forwarded.

import {
  CONTABO_SECRET_NAMES,
  FLY_TOKEN_FILE,
  boundedAdapter,
  contaboFileUsable,
  inspectContaboFile,
  readSecretFile,
  realBoundedSpawn,
  runIsAmbiguous,
} from "./fly-cli.ts";
import { namesPresent, pushSecrets } from "./secrets.ts";
import { NOTHING_OBSERVED, mayRun } from "./landing.ts";
import { runPreflight } from "./preflight.ts";
import { LIGHT_DEADLINE_MS } from "./provisioner-move-run.ts";

/**
 * What a staging run means, and why it has three outcomes rather than two.
 *
 * A validation refusal never started a child, so nothing happened. But once the
 * child exists, a deadline, a surviving process group or a non-zero exit all
 * leave the SAME question open: the import may have taken effect. That is
 * AMBIGUOUS, and the answer to it is never a retry - a second import of four
 * credentials into an unknown state is how one uncertainty becomes two.
 */
export function classifyStage(
  outcome: { spawned: boolean; valueInChildOutput: boolean },
  child: { last: () => unknown; threw: () => boolean },
  report: (line: string) => void,
): number {
  if (!outcome.spawned) {
    report("staging: refused before any child ran");
    return 2;
  }
  if (outcome.valueInChildOutput) {
    report("staging: the child repeated a value it was given");
    return 1;
  }
  if (runIsAmbiguous(child as never)) {
    report("staging: AMBIGUOUS - the import may or may not have taken effect");
    report(
      "next: STOP. Read the app's secret names with --verify and escalate. " +
        "Do not re-run this program",
    );
    return 3;
  }
  report("staging: completed");
  return 0;
}

/**
 * The only names this program may set - the same constant the provisioner's own
 * credential reader takes from the environment, so a name spelled differently
 * on either side is impossible rather than merely unlikely.
 */
export const PROVIDER_ONLY_NAMES = CONTABO_SECRET_NAMES;

/** The three this program must never be able to touch. Named so the test can
 * assert the refusal by name rather than by absence. */
export const NOT_THIS_PROGRAM_S_NAMES = [
  "CONTROL_PLANE_DB",
  "CONTROL_PLANE_DB_BRANCH",
  "CONTROL_PLANE_MINT_TOKEN",
] as const;

async function main(): Promise<void> {
  // EXACTLY no arguments, or exactly `--verify`. Anything else refuses BEFORE a
  // secret file or a token is read: with a permissive check, a typo like
  // `--verfiy` would fall through to the branch that stages live credentials
  // (reviewer finding, 2026-08-12).
  const args = process.argv.slice(2);
  const verify = args.length === 1 && args[0] === "--verify";
  if (args.length > 1 || (args.length === 1 && !verify)) {
    console.log("usage: provider-secrets.ts [--verify]");
    console.log("refusing: unrecognised arguments, and nothing was read");
    process.exitCode = 2;
    return;
  }

  const flyToken = readSecretFile(FLY_TOKEN_FILE);

  if (verify) {
    const reader = boundedAdapter(realBoundedSpawn, LIGHT_DEADLINE_MS);
    const answer = await namesPresent({
      required: PROVIDER_ONLY_NAMES,
      flyToken,
      spawn: reader.spawn,
    });
    console.log(`listing_readable: ${answer.readable}`);
    console.log(`provider_names_present: ${answer.present}`);
    for (const name of PROVIDER_ONLY_NAMES) console.log(`  required: ${name}`);
    process.exitCode = answer.present ? 0 : 1;
    return;
  }

  // STAGING IS GATED ON A FRESH PRODUCTION OBSERVATION. A staged secret is
  // inert until a deploy, but it is a credential that exists on the platform,
  // and the question of whether production may be armed at all is the same
  // question. The preflight runs HERE rather than being read off an operator's
  // earlier transcript (reviewer finding, 2026-08-12: the order module was a
  // policy nothing consulted).
  let preflight = { verdict: { safe: false }, targetProved: false };
  try {
    preflight = await runPreflight((line) => console.log(line));
  } catch {
    // Discarded: an API or driver error can carry a host. The refusal below is
    // what the operator acts on.
    console.log("preflight_threw: true");
  }
  const permission = mayRun("stage", {
    ...NOTHING_OBSERVED,
    preflightSafe: preflight.targetProved ? preflight.verdict.safe : false,
  });
  console.log(`may_stage: ${permission.ok}`);
  console.log(`because: ${permission.because}`);
  if (!permission.ok) {
    process.exitCode = 1;
    return;
  }

  // The file is checked HERE, by the process about to use it, against the exact
  // shape it was promised to have - a check somebody ran earlier is a statement
  // about a file that has since had time to change.
  const contabo = inspectContaboFile();
  console.log(`contabo_file_present: ${contabo.checks.present}`);
  console.log(`contabo_file_regular: ${contabo.checks.regularFile}`);
  console.log(`contabo_file_mode_600: ${contabo.checks.mode600}`);
  console.log(`contabo_file_shape_ok: ${contabo.checks.shapeOk}`);
  if (!contaboFileUsable(contabo.checks)) {
    console.log(
      "refusing: the provider credential file is not in the ruled shape",
    );
    process.exitCode = 2;
    return;
  }

  // BOUNDED, because this child is handed four live credentials. A flyctl that
  // never returns would hold them, might leave descendants alive, and would
  // give nobody an outcome to escalate (fly-cli.ts says so itself).
  const child = boundedAdapter(realBoundedSpawn, LIGHT_DEADLINE_MS);
  const outcome = await pushSecrets({
    pairs: contabo.pairs,
    allowed: PROVIDER_ONLY_NAMES,
    flyToken,
    spawn: child.spawn,
  });
  for (const name of PROVIDER_ONLY_NAMES) console.log(`  set: ${name}`);
  console.log(`validated: ${outcome.problems.length === 0}`);
  for (const problem of outcome.problems) console.log(`  problem: ${problem}`);
  console.log(`spawned: ${outcome.spawned}`);
  console.log(`children_started: ${child.runs()}`);
  console.log(`value_in_child_output: ${outcome.valueInChildOutput}`);
  process.exitCode = classifyStage(outcome, child, (line) => console.log(line));
}

if (import.meta.main) {
  await main();
}
