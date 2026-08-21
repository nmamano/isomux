// The one deploy that turns staged provider credentials into live ones.
//
//   bun control-plane/deploy/activate.ts --plan      what it would do, and why
//   bun control-plane/deploy/activate.ts --execute   the deploy
//
// `--redeploy` upgrades an ALREADY-ARMED deployment: it skips only the
// first-arming production check (whose question - may production be GIVEN
// provider credentials - history has answered) and instead requires the four
// provider names to already be on the app. Every other precondition holds
// unchanged. Added 2026-08-21, when the first activation's gate correctly
// refused to run twice: production carries cp2's provider-linked asset by
// design, so the arming path is permanently closed to upgrades.
//
// THIS IS THE ARMING STEP, and it is a program rather than a flyctl line for
// two reasons that are not style. A shell `flyctl deploy` either uses whatever
// ambient identity `~/.fly` holds - which on this box belongs to another
// project - or needs `FLY_API_TOKEN` expanded by a shell, which the loop's
// secrets ruling forbids. So the token is read inside this process and handed
// to the child in its environment, and the argv is the COMMITTED `DEPLOY_ARGV`
// rather than a string a caller passes: no app, no config, no dockerfile and no
// flag comes from outside this repository.
//
// IT IS NOT `provisioner-move --execute`. That program rotates
// `CONTROL_PLANE_DB`, which is exactly what this step must not do.
//
// FOUR PRECONDITIONS, ALL RE-TAKEN IN THIS PROCESS moments before the spawn,
// because a precondition satisfied by a transcript is a memory:
//
//   PRODUCTION   nothing in it would make the loop touch a box the moment it
//                can (preflight.ts).
//   THE NAMES    the four provider secrets are actually on the app.
//   THE SOURCE   `fly deploy .` ships the WORKING DIRECTORY, so a dirty tree is
//                a live artifact nobody can reconstruct from a commit. The
//                decision is `judgeSource`, shared with the credential move
//                rather than restated here (reviewer finding, 2026-08-12).
//   THE MACHINES exactly one, started. `--ha=false` reasons about replacing one
//                machine; a second one makes that assumption false, and the
//                reading is `readMachineListing`, again the move's own.
//
// EVERY POST-SPAWN OUTCOME IS AMBIGUOUS. A deploy that returns non-zero may
// still have replaced the machine; a deploy that returns zero may have left a
// process behind. So this program NEVER retries and never deploys a rollback:
// it reports what it saw and stops, and the next action is a human reading the
// machine's own state through `deploy/probe.ts`.
//
// AND A THROW IS AN OUTCOME, NOT AN ESCAPE. Every seam is called inside a
// catch: a throw before the spawn is a refusal, a throw at the spawn is
// AMBIGUOUS (the child may well have run), and the error object is discarded
// rather than printed - a driver or CLI error can carry a host, a path or a
// credential fragment.
//
// WHAT IT PRINTS: fixed labels, booleans, small integers and exit codes. Not
// the child's bytes, not the token, not a DSN, not an error object.

import { DEPLOY_ARGV, RELEASE_BUILD_ARGS } from "./provisioner-role.ts";
import {
  APP,
  CONTABO_ENV_FILE,
  FLYCTL,
  FLY_TOKEN_FILE,
  type BoundedResult,
  type BoundedSpawn,
  boundedAdapter,
  readSecretFile,
  realBoundedSpawn,
  type Spawn,
} from "./fly-cli.ts";
import { NOTHING_OBSERVED, mayRun } from "./landing.ts";
import { runPreflight } from "./preflight.ts";
import { namesPresent } from "./secrets.ts";
import { PROVIDER_ONLY_NAMES } from "./provider-secrets.ts";
import {
  CONTEXT_RULES_PATH,
  IMAGE_PATHSPEC,
  isSingleStarted,
  readMachineListing,
  type MachineReading,
} from "./provisioner-move-run.ts";
import { judgeSource, type SourceVerdict } from "./tree-state.ts";
import { REPO_ROOT, contextRules, shipsToImage } from "./build-context.ts";

/** How long the deploy gets before its whole process group is terminated. */
export const DEPLOY_DEADLINE_MS = 15 * 60_000;
/** How long a git or listing read gets. */
export const READ_DEADLINE_MS = 2 * 60_000;

export type ActivationOutcome =
  /** The child exited 0 and its process group was proved empty. Even this is
   * not "the deployment is correct" - it is "the deploy command completed". */
  | "completed"
  /** Anything else at all: non-zero, a deadline, a surviving group, a throw.
   * All one class on purpose, because all have the same next action. */
  | "ambiguous";

/**
 * What a bounded run means, as a decision with no side effects.
 *
 * The union is deliberately two-valued. A three-valued version with "failed"
 * invites a retry on the failed arm, and a failed deploy is precisely the case
 * where nobody knows what the machine now holds.
 */
export function classifyActivation(result: BoundedResult): ActivationOutcome {
  if (result.timedOut || result.groupSurvived || !result.groupEmpty) {
    return "ambiguous";
  }
  return result.code === 0 ? "completed" : "ambiguous";
}

export interface ActivationSeams {
  spawn: BoundedSpawn;
  listSpawn: Spawn;
  flyToken: string;
  preflight: (report: (line: string) => void) => Promise<{
    verdict: { safe: boolean };
    targetProved: boolean;
  }>;
  names: (args: {
    required: readonly string[];
    flyToken: string;
    spawn: Spawn;
  }) => Promise<{ present: boolean; readable: boolean }>;
  /** Two git reads, answered by whoever knows how to run git here. */
  git: (argv: string[]) => Promise<{ code: number; stdout: string }>;
  machines: () => Promise<MachineReading>;
  report: (line: string) => void;
  now?: () => Date;
}

/** Anything a seam throws becomes a fixed fallback, and the error is dropped. */
async function attempt<T>(
  run: () => Promise<T>,
  fallback: T,
  report: (line: string) => void,
  label: string,
): Promise<T> {
  try {
    return await run();
  } catch {
    // DISCARDED, not reported: a driver, git or CLI error can carry a host, a
    // path or a fragment of a credential, and this program's whole output
    // contract is fixed labels.
    report(`${label}_threw: true`);
    return fallback;
  }
}

/** The source reading, through the shared decision. */
export async function readSource(
  git: ActivationSeams["git"],
): Promise<SourceVerdict & { commit: string | null }> {
  const status = await git([
    "status",
    "--porcelain",
    "-uall",
    "--",
    IMAGE_PATHSPEC,
    CONTEXT_RULES_PATH,
  ]);
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  const commit = head.stdout.trim();
  const commitValid = head.code === 0 && /^[0-9a-f]{40}$/.test(commit);
  const tree = await git([
    "ls-tree",
    "-r",
    "--name-only",
    commitValid ? commit : "--invalid-commit--",
    "--",
    IMAGE_PATHSPEC,
    CONTEXT_RULES_PATH,
  ]);
  const rules = contextRules();
  const headAfter = await git(["rev-parse", "--verify", "HEAD"]);
  const stable = headAfter.code === 0 && headAfter.stdout.trim() === commit;
  return {
    ...judgeSource({
      readable: status.code === 0 && tree.code === 0 && commitValid && stable,
      statusOut: status.stdout,
      treeOut: tree.stdout,
      rulesPath: CONTEXT_RULES_PATH,
      ships: (file) => shipsToImage(rules, file),
    }),
    commit: commitValid && stable ? commit : null,
  };
}

/**
 * Observe, decide, and only then deploy.
 *
 * Returns `ran: false` for every refusal, and the caller cannot tell one
 * refusal from another except by the fixed lines - which is correct, because
 * the action is the same for all of them: fix the thing that is not true yet.
 */
export async function activate(
  seams: ActivationSeams,
  opts: { redeploy?: boolean } = {},
): Promise<{
  ran: boolean;
  outcome: ActivationOutcome | null;
}> {
  const { report } = seams;

  // A redeploy never asks the first-arming question, so it must not run the
  // preflight whose answer would be misread as one. Its licence is the staged
  // names below - the re-read proof that a gated first activation happened.
  const preflight = opts.redeploy
    ? null
    : await attempt(
        () => seams.preflight(report),
        { verdict: { safe: false }, targetProved: false },
        report,
        "preflight",
      );
  if (opts.redeploy) {
    report(
      "first_arming_preflight: skipped - a redeploy upgrades an armed " +
        "deployment; the arming is proved by the staged provider names below",
    );
  }
  const names = await attempt(
    () =>
      seams.names({
        required: PROVIDER_ONLY_NAMES,
        flyToken: seams.flyToken,
        // BOUNDED: this read happens after the credentials exist, and an
        // unbounded child would hold the run open with nothing to escalate.
        spawn: seams.listSpawn,
      }),
    { present: false, readable: false },
    report,
    "secret_names",
  );
  report(`provider_names_listing_readable: ${names.readable}`);
  report(`provider_names_all_set: ${names.present}`);

  const source = await attempt(
    () => readSource(seams.git),
    {
      readable: false,
      rulesCommitted: false,
      shippedUncommitted: -1,
      reconstructible: false,
      commit: null,
    },
    report,
    "source",
  );
  report(`source_readable: ${source.readable}`);
  report(`context_rules_committed: ${source.rulesCommitted}`);
  report(`shipped_paths_uncommitted: ${source.shippedUncommitted}`);

  const machines = await attempt(
    () => seams.machines(),
    { readable: false, count: -1, generation: "", allStarted: false },
    report,
    "machines",
  );
  const topology = isSingleStarted(machines);
  report(`machine_listing_readable: ${machines.readable}`);
  report(`machines: ${machines.count}`);
  report(`machines_all_started: ${machines.allStarted}`);
  report(`topology_is_one_started_machine: ${topology}`);

  const evidence = {
    ...NOTHING_OBSERVED,
    preflightSafe: preflight
      ? preflight.targetProved
        ? preflight.verdict.safe
        : false
      : null,
    providerNamesStaged: names.readable ? names.present : null,
  };
  const permission = mayRun(opts.redeploy ? "redeploy" : "activate", evidence);
  // The source and the topology are activation's own preconditions rather than
  // the order's: they say whether THIS deploy can be reconstructed and whether
  // its one-machine assumption holds, which is not a question about sequence.
  const deployStartedAt = (seams.now ?? (() => new Date()))().toISOString();
  const identityValid =
    source.commit !== null &&
    /^[0-9a-f]{40}$/.test(source.commit) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(deployStartedAt);
  const allowed =
    permission.ok && source.reconstructible && topology && identityValid;
  report(`may_activate: ${allowed}`);
  report(
    `because: ${
      !permission.ok
        ? permission.because
        : !source.reconstructible
          ? "the source fly would ship is not reconstructible from HEAD"
          : !topology
            ? "the app is not exactly one started machine"
            : !identityValid
              ? "the release identity could not be determined"
              : "every precondition was observed true in this process"
    }`,
  );
  if (!allowed) return { ran: false, outcome: null };

  report(`deploying: ${APP}`);
  let result: BoundedResult | null = null;
  try {
    result = await seams.spawn(
      [
        FLYCTL,
        ...DEPLOY_ARGV,
        RELEASE_BUILD_ARGS.flag,
        `${RELEASE_BUILD_ARGS.commit}=${source.commit}`,
        RELEASE_BUILD_ARGS.flag,
        `${RELEASE_BUILD_ARGS.deployStartedAt}=${deployStartedAt}`,
      ],
      { FLY_API_TOKEN: seams.flyToken },
      "",
      DEPLOY_DEADLINE_MS,
    );
  } catch {
    // A THROW AT THE SPAWN IS NOT A REFUSAL. The child may have run, and may
    // have replaced the machine; the only honest classification is ambiguous.
    report("deploy_threw: true");
  }
  const outcome = result ? classifyActivation(result) : "ambiguous";
  report(`child_exit: ${result ? result.code : "none"}`);
  report(`timed_out: ${result ? result.timedOut : "unknown"}`);
  report(`group_survived: ${result ? result.groupSurvived : "unknown"}`);
  report(`group_empty: ${result ? result.groupEmpty : "unknown"}`);
  report(`activation: ${outcome}`);
  report(
    outcome === "completed"
      ? "next: read the machine's own state with deploy/probe.ts - a completed " +
          "deploy command is not a proved deployment"
      : "next: STOP. Read the machine's state with deploy/probe.ts and escalate. " +
          "Do not re-run this program and do not deploy a rollback",
  );
  return { ran: true, outcome };
}

/** git, bounded, with its bytes captured. */
function realGit(spawn: BoundedSpawn): ActivationSeams["git"] {
  return async (argv) => {
    const result = await spawn(
      ["git", "-C", REPO_ROOT, ...argv],
      {},
      "",
      READ_DEADLINE_MS,
    );
    const clean =
      !result.timedOut && !result.groupSurvived && result.groupEmpty;
    return { code: clean ? (result.code ?? 1) : 1, stdout: result.stdout };
  };
}

function realMachines(
  spawn: BoundedSpawn,
  flyToken: string,
): ActivationSeams["machines"] {
  return async () => {
    const result = await spawn(
      [FLYCTL, "machines", "list", "-a", APP, "--json"],
      { FLY_API_TOKEN: flyToken },
      "",
      READ_DEADLINE_MS,
    );
    const clean =
      !result.timedOut && !result.groupSurvived && result.groupEmpty;
    if (!clean || result.code !== 0) {
      return { readable: false, count: -1, generation: "", allStarted: false };
    }
    return readMachineListing(result.stdout);
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const redeploy = args.includes("--redeploy");
  const rest = args.filter((arg) => arg !== "--redeploy");
  const mode = rest.length === 1 ? rest[0] : "";
  if (
    (mode !== "--plan" && mode !== "--execute") ||
    new Set(args).size !== args.length
  ) {
    console.log("usage: activate.ts [--redeploy] --plan | --execute");
    process.exitCode = 2;
    return;
  }

  if (mode === "--plan") {
    console.log(`app: ${APP}`);
    console.log(`mode: ${redeploy ? "redeploy" : "first-arming"}`);
    if (redeploy) {
      console.log(
        "note: the first-arming production check is skipped; the staged " +
          "provider names must already be on the app",
      );
    }
    console.log(`argv_from_repository: true`);
    for (const arg of DEPLOY_ARGV) console.log(`  arg: ${arg}`);
    console.log(`deadline_ms: ${DEPLOY_DEADLINE_MS}`);
    console.log(`token_file: ${FLY_TOKEN_FILE}`);
    console.log(`provider_file: ${CONTABO_ENV_FILE}`);
    console.log(
      "note: this program never retries and never deploys a rollback",
    );
    process.exitCode = 0;
    return;
  }

  let flyToken: string;
  try {
    flyToken = readSecretFile(FLY_TOKEN_FILE);
  } catch {
    console.log("token_file_readable: false");
    process.exitCode = 2;
    return;
  }
  const { ran, outcome } = await activate(
    {
      spawn: realBoundedSpawn,
      listSpawn: boundedAdapter(realBoundedSpawn, READ_DEADLINE_MS).spawn,
      flyToken,
      preflight: runPreflight,
      names: namesPresent,
      git: realGit(realBoundedSpawn),
      machines: realMachines(realBoundedSpawn, flyToken),
      report: (line) => console.log(line),
    },
    { redeploy },
  );
  process.exitCode = !ran ? 1 : outcome === "completed" ? 0 : 3;
}

if (import.meta.main) {
  await main();
}
