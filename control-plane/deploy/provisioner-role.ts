// Moving the provisioner onto its own capped role, and the state machine that
// makes an interrupted move recoverable.
//
// G2 put the posture in the production catalog: `cp_provisioner` exists, capped
// at 12, carrying exactly the governed bounds, NOLOGIN and granted its matrix.
// Nothing authenticates as it. This is the step that gives it a credential and
// points the machine at it - and the step where a failure can strand a live
// deployment, so the failure states are enumerated here rather than discovered.
//
// FOUR PHASES, AND THE STATE IS READ FROM THE WORLD, NOT REMEMBERED.
//
//   P1  the role is given LOGIN and a password, generated in this process
//   P2  the new DSN is STAGED as a fly secret (staged: no restart of its own)
//   P3  one deploy, which is when the staged secret becomes live
//   P4  verify and probe
//
// A run that dies between any two of those leaves no note behind - process
// memory is not durable and a lock file would be a second thing to be wrong. So
// a resumed run MEASURES which phase it inherited, from two facts that outlive
// any process: whether the role can log in (the catalog) and whether anything
// is connected as it (pg_stat_activity). `classifyPhase` is that reading, and
// `recoveryFor` is what each reading means.
//
// WHAT THIS FILE PRINTS: booleans, small integers, SQLSTATEs, exit codes and
// fixed labels. The generated password, the DSN, the host, the role name and
// the database name appear on no path, error paths included.

import { PROVISIONER_ROLE, boundsAreExact, runtimeRoles } from "../roles.ts";

/** What a resumed run can learn about where the last one stopped. */
export interface LiveFacts {
  /** The role can authenticate. Only P1 sets this. */
  roleCanLogin: boolean;
  /** Backends connected AS the role. Non-zero means a deployment is using the
   * credential, whatever the last run believed it had done. */
  roleBackends: number;
  /** The owner still carries exactly the governed pair - the rollback path
   * opens a store as the owner, and `openRuntime` refuses a managed session
   * whose role configuration is not exact. */
  ownerBoundsExact: boolean;
}

export type Phase =
  /** Nothing done, or a completed rollback. The forward run may start. */
  | "clean"
  /** P1 ran. P2 and P3 are UNKNOWN, so the recovery assumes the worst that is
   * still recoverable without a deploy: a value may be staged. */
  | "credential_set"
  /** Something is connected as the role, so the deploy took effect whatever the
   * last run reported. */
  | "credential_live"
  /** A backend exists as a role that cannot log in. That is a session that
   * predates the NOLOGIN - grandfathered, since Postgres checks at connect -
   * and it is not a state this program may reason its way out of. */
  | "contradictory";

export function classifyPhase(facts: LiveFacts): Phase {
  if (facts.roleBackends > 0) {
    return facts.roleCanLogin ? "credential_live" : "contradictory";
  }
  return facts.roleCanLogin ? "credential_set" : "clean";
}

/**
 * The ordered recovery for a phase, as fixed step names.
 *
 * Names rather than closures so the plan can be PRINTED before it is run and
 * asserted in a test: an operator reading a transcript should see which
 * sequence was chosen before seeing it happen.
 *
 * The ordering rule that runs through all of them: THE CREDENTIAL IS DISABLED
 * LAST. Disabling it while a machine is still pointed at it turns a rollback
 * into an outage, so the owner DSN goes back first and the role is only closed
 * once nothing is connected as it.
 */
export function recoveryFor(phase: Phase): string[] {
  switch (phase) {
    case "clean":
      return [];
    case "credential_set":
    case "credential_live":
      // THE SAME PATH FOR BOTH, and the reason is that zero backends is not
      // evidence of anything. A deploy can apply the staged DSN and leave the
      // machine stopped, crash-looping, or between boots - all of which read as
      // LOGIN true with nothing connected, exactly like a stage that never went
      // live. Non-zero backends prove the deploy took effect; zero proves
      // nothing, and no provider read available here distinguishes them. So
      // every credential that EXISTS is recovered as though it may be in a
      // machine's configuration: the owner DSN is put back and DEPLOYED before
      // the credential is closed, or the next machine start would read a role
      // it cannot authenticate as.
      //
      // AND THE PROOF THAT THE ROLLBACK LANDED IS THE SAME KIND OF PROOF THE
      // FORWARD RUN NEEDS. An earlier version stopped at "the deploy exited
      // zero and the role holds zero backends right now", which repeats the
      // mistake it was written to avoid one step later: a machine still
      // CONFIGURED for the role reads zero between two opens, during a restart
      // and while it crash-loops. So the rollback proves fly replaced the
      // machine, proves the owner path answers, and then watches a bounded
      // series in which EVERY reading is zero - and only then closes the
      // credential (reviewer finding, 2026-08-11).
      return [
        "stage_owner_dsn",
        "deploy",
        "prove_machine_replaced",
        "probe_owner_path",
        "prove_role_backends_zero",
        "disable_role_credential",
      ];
    case "contradictory":
      return ["stop_and_escalate"];
  }
}

/**
 * May a RECOVERY run at all?
 *
 * The rollback deploys the owner DSN, and the committed runtime opens it
 * through `openRuntime`, which refuses a managed session whose role
 * configuration is not exactly the governed pair. So an owner whose bounds have
 * drifted cannot be rolled back TO: deploying it would replace a machine that
 * cannot open its database with another one that cannot either. That is a stop,
 * not a step.
 */
export function mayRecover(facts: LiveFacts): boolean {
  if (classifyPhase(facts) === "contradictory") return false;
  return facts.ownerBoundsExact;
}

/**
 * May the forward run start?
 *
 * Every one of these is read before a password exists. A false answer is a stop,
 * not a repair: this program does not tidy live state it did not create.
 */
export interface ForwardPreconditions {
  branchProved: boolean;
  ownerDsnReconstructsAndOpens: boolean;
  /** The owner still carries EXACTLY the governed pair. Required before the
   * forward run too, not only before a rollback: the rollback is the forward
   * run's only way back, and starting a move you cannot reverse is the thing
   * this whole gate exists to prevent. */
  ownerBoundsExact: boolean;
  hostIsPooler: boolean;
  roleGovernedExactly: boolean;
  /**
   * EXACTLY ONE STARTED MACHINE, read before a password exists.
   *
   * The overlap arithmetic is a statement about one machine being replaced by
   * one machine: a pool of five, twice, inside a cap of twelve. Two machines
   * already running would make a replacement three pools - fifteen requested
   * against a cap of twelve - and zero machines or a stopped one means the
   * deployed shape is not the shape any of this was measured on. Checking it
   * only at the deploy would be checking it after the credential exists and
   * after a secret was staged, which is a recovery rather than a refusal
   * (reviewer finding, 2026-08-11).
   */
  singleStartedMachine: boolean;
  sourceIsCommitted: boolean;
  treeIsClean: boolean;
  phase: Phase;
}

export function mayGoForward(pre: ForwardPreconditions): boolean {
  return (
    pre.branchProved &&
    pre.ownerDsnReconstructsAndOpens &&
    pre.ownerBoundsExact &&
    pre.hostIsPooler === false &&
    pre.roleGovernedExactly &&
    pre.singleStartedMachine &&
    pre.sourceIsCommitted &&
    pre.treeIsClean &&
    pre.phase === "clean"
  );
}

/**
 * Is the role exactly what G2 left, before this run touches it?
 *
 * The budget and the bounds, from the catalog. A role whose cap has drifted is
 * not the role the posture was approved for, and giving it a credential would
 * deploy against an aggregate nobody has agreed to.
 */
export function roleIsGovernedExactly(facts: {
  connectionLimit: number;
  config: readonly string[];
  bounds: readonly (readonly [string, string])[];
}): boolean {
  const budget = runtimeRoles().find(
    (r) => r.role === PROVISIONER_ROLE,
  )?.budget;
  return (
    budget !== undefined &&
    facts.connectionLimit === budget &&
    boundsAreExact(facts.config, facts.bounds)
  );
}

/**
 * A password for a role, generated here and held nowhere else.
 *
 * Hex only: it goes into one SQL statement and one connection string, and a
 * value that needs no quoting in either cannot be mis-escaped into a different
 * statement. 256 bits from the platform's CSPRNG.
 */
export function generatedPassword(): string {
  return (
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "")
  );
}

/**
 * The statement that opens the credential, and the one that closes it.
 *
 * `password null` on the way back, not just NOLOGIN: a role that cannot log in
 * but still holds a password is a credential nobody is watching. The forward
 * statement takes the value as an argument because there is exactly one place
 * it may be interpolated, and this is it.
 */
export function openCredentialSql(password: string): string {
  if (!/^[0-9a-f]{32,}$/.test(password)) {
    throw new Error(
      "refusing to build a credential statement around a value that is not the " +
        "hex this program generates",
    );
  }
  return `alter role ${PROVISIONER_ROLE} with login password '${password}'`;
}

export function closeCredentialSql(): string {
  return `alter role ${PROVISIONER_ROLE} with nologin password null`;
}

/**
 * The deploy, exactly as D2 established it and no further.
 *
 * `--ha=false` is what keeps this to ONE machine, and it is the argument the
 * overlap arithmetic rests on: the engine cap of 12 is the hard bound, and two
 * process pools of 5 is the worst shape that can be reached under a rolling
 * update of a single machine. A strategy that stood up a second machine
 * alongside the first - bluegreen - would change that arithmetic, which is why
 * `deploy/provisioner-role.test.ts` asserts fly.toml names none.
 */
export const DEPLOY_ARGV = [
  "deploy",
  ".",
  "--config",
  "control-plane/deploy/fly.toml",
  "--dockerfile",
  "control-plane/deploy/Dockerfile",
  "-a",
  "isomux-provisioner",
  "--depot=true",
  "--depot-scope",
  "app",
  "--ha=false",
  "--now",
] as const;

/**
 * What a deploy's exit code is allowed to mean.
 *
 * NOT "nothing changed". A deploy that returns non-zero may have replaced the
 * machine, may have applied the staged secret, or may have done neither, and
 * the caller cannot tell from the code alone. So every outcome after the deploy
 * has been INVOKED - success, failure, throw or timeout - goes down the same
 * path: measure the world, classify, and recover from what is actually there.
 */
export function deployOutcomeIsAmbiguous(): boolean {
  return true;
}

/** The steps a forward run performs, in order, for the transcript. */
export const FORWARD_STEPS = [
  "preflight",
  "open_credential",
  "stage_new_dsn",
  "deploy",
  "verify_secrets",
  "probe",
] as const;
