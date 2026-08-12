// The coordinator that actually performs the provisioner's credential move.
//
// The decisions live in `provisioner-role.ts`; this is the thing that follows
// them, and it is separate for one reason: a separately approved library cannot
// establish that the executable obeys it. Every provider effect is a SEAM, so
// the orchestration - the order, the refusals, what happens after a process
// dies mid-move - is tested with fakes, and only the real provider call is
// gated behind an authorization.
//
// WHAT THE SEAMS HIDE, and why each one is a seam rather than a call: the
// database (a password reaches exactly one statement), the Neon API (the direct
// host and the DSNs are built in memory), fly (a staged secret over stdin, and
// a deploy whose result is ambiguous by construction), the probe (a fixed
// verdict), and the source tree (a deploy ships the working directory, so a
// dirty tree is a deploy nobody can reconstruct).
//
// THE PASSWORD EXISTS IN TWO PLACES AND NOWHERE ELSE: the SQL statement that
// sets it, and the bytes written to fly's stdin. It is never an argument, never
// a return value, never in a report line, and never attached to an error.

import {
  DEPLOY_ARGV,
  type ForwardPreconditions,
  type LiveFacts,
  type Phase,
  classifyPhase,
  closeCredentialSql,
  generatedPassword,
  mayGoForward,
  mayRecover,
  openCredentialSql,
  recoveryFor,
} from "./provisioner-role.ts";

/** What a deploy attempt tells us, which is less than it looks. */
export interface DeployResult {
  /** Null when the call threw or timed out - which is not distinguishable from
   * a slow success, and is treated the same way. */
  exitCode: number | null;
  threw: boolean;
}

export interface Seams {
  source: {
    /** The commit the working tree is at, or null when it cannot be read. */
    committedSha(): Promise<string | null>;
    /** A deploy ships the working DIRECTORY, so anything uncommitted would be
     * shipped without being reviewable afterwards. */
    treeIsClean(): Promise<boolean>;
  };
  db: {
    /** The two durable facts a resumed run reads, plus the owner's bounds. */
    facts(): Promise<LiveFacts>;
    branchProved(): Promise<boolean>;
    roleGovernedExactly(): Promise<boolean>;
    /** Does THIS EXACT connection string open? The argument is the point: the
     * string proved is the string staged. */
    opens(dsn: string): Promise<boolean>;
    /** The ONE place a generated password is interpolated. */
    run(sql: string): Promise<void>;
    /**
     * Run `action`, COUNTING BACKENDS WHILE IT RUNS and then through a bounded
     * settlement series.
     *
     * A series taken after a deploy returns can prove a steady state and cannot
     * see the thing the budget was sized against: the moment when the machine
     * being replaced and the machine replacing it are both connected. That
     * moment only exists while the deploy is in flight, so the sampling has to
     * be concurrent with it rather than after it (reviewer finding,
     * 2026-08-11). Bounded by construction in both halves - a deploy that never
     * returns stops the sampler at a fixed count.
     */
    sampleAcross<T>(action: () => Promise<T>): Promise<SampledRun<T>>;
    /**
     * A bounded settlement series on its own, for the rollback: every reading
     * must be zero before a credential may be closed.
     *
     * There is deliberately no "read the count once" seam. Nothing in this
     * program may act on a single reading - zero at one instant is the one-way
     * evidence the whole design refuses - so the shape that cannot express it
     * is the shape offered.
     */
    backendSamples(): Promise<number[]>;
  };
  api: {
    /**
     * ONE resolution, and both DSNs come out of it.
     *
     * The proof has to be bound to the value: asking "does the owner DSN open"
     * and later asking "what is the owner DSN" are two questions that can be
     * answered about two different strings. So the host is classified once and
     * both connection strings are built from THAT host - the one classified as
     * direct is the one that gets used.
     */
    resolve(): Promise<{
      hostIsPooler: boolean;
      ownerDsn: string;
      roleDsnFor(password: string): string;
    }>;
  };
  fly: {
    /** Stage ONE existing secret name. Returns whether the child repeated the
     * value it was given, which is a diagnostic rather than the guarantee. */
    stage(value: string): Promise<{ ok: boolean; valueEchoed: boolean }>;
    deploy(argv: readonly string[]): Promise<DeployResult>;
    /**
     * Read the machine topology and capture the baseline a replacement will be
     * compared against, immediately before a deploy.
     *
     * SEPARATE FROM THE DEPLOY so that "a reading taken while the deploy ran"
     * means it: with the listing inside `deploy`, the sampler's first reading
     * was concurrent with reconnaissance rather than with the child. False when
     * the app is not one started machine this program can identify.
     */
    prepareDeploy(): Promise<boolean>;
    /** Name presence only - it does NOT say which value is staged or live. */
    secretNamesPresent(): Promise<boolean>;
    machineReplaced(): Promise<boolean>;
    /** Exactly one machine, started, with an identity this program can read.
     * The shape the overlap arithmetic assumes, asked BEFORE anything is
     * written rather than at the deploy. */
    singleStartedMachine(): Promise<boolean>;
  };
  probe(): Promise<boolean>;
  report(line: string): void;
}

export type Outcome =
  | "refused_precondition"
  | "moved"
  | "rolled_back"
  | "escalate";

/** What `sampleAcross` returns: the action's own answer, the readings taken
 * while it ran and after it, and how many of them were taken WHILE it ran. */
export interface SampledRun<T> {
  value: T;
  samples: number[];
  during: number;
}

/** Steady state for one machine: its pool is capped at 5, and the engine cap of
 * 12 is what makes the ceiling a fact rather than a hope. */
const STEADY_MIN = 1;
const STEADY_MAX = 5;
const HARD_CAP = 12;

/**
 * Put the owner DSN back and prove the deployment is on it, then close the
 * credential.
 *
 * ONE SHAPE FOR EVERY CREDENTIAL THAT EXISTS. See `recoveryFor`: zero backends
 * is not evidence that the staged value never went live, so a recovery that
 * skipped the deploy could leave the next machine start pointed at a role it
 * cannot authenticate as.
 *
 * IT DISABLES NOTHING IT CANNOT PROVE IS UNUSED. A failed rollback deploy, a
 * failed owner probe, or backends that will not reach zero all leave the
 * credential ENABLED and escalate - a live machine with a working credential is
 * a bad state, and a live machine with a credential we just revoked is a worse
 * one.
 */
/**
 * Everything a RECOVERY has to be true before it writes anything.
 *
 * A rollback is a deploy, so it needs the same ground the forward run needed:
 * the branch it is talking to, an owner DSN that actually opens, owner bounds
 * the committed runtime will accept, a readable commit and a clean tree. An
 * earlier version tested only the owner's bounds, which meant an inherited
 * credential would stage and deploy an owner DSN that had already been proved
 * unusable - a rollback into a machine that cannot open its database.
 *
 * EVERY READ IS INSIDE THE CATCH. A rejected branch query or catalog read is
 * not a different kind of answer from a false one: both mean this program
 * cannot establish the ground a rollback needs, and both must end as a refusal
 * to write rather than as an exception leaving the caller with a live
 * credential and no transcript (reviewer finding, 2026-08-11).
 */
async function recoveryPreconditions(
  seams: Seams,
  ownerDsn: string,
  hostIsPooler: boolean,
): Promise<boolean> {
  let checks: [string, boolean][];
  try {
    checks = [
      ["recovery_branch_proved", await seams.db.branchProved()],
      ["recovery_owner_dsn_opens", await seams.db.opens(ownerDsn)],
      ["recovery_host_is_direct", hostIsPooler === false],
      [
        "recovery_source_commit_readable",
        (await seams.source.committedSha()) !== null,
      ],
      ["recovery_tree_clean", await seams.source.treeIsClean()],
    ];
  } catch {
    seams.report("recovery_preconditions_unreadable: true");
    return false;
  }
  let ok = true;
  for (const [name, value] of checks) {
    seams.report(`${name}: ${value}`);
    if (!value) ok = false;
  }
  return ok;
}

/**
 * Put the owner DSN back and prove the deployment is on it, then close the
 * credential.
 *
 * ONE SHAPE FOR EVERY CREDENTIAL THAT EXISTS. See `recoveryFor`: zero backends
 * is not evidence that the staged value never went live, so a recovery that
 * skipped the deploy could leave the next machine start pointed at a role it
 * cannot authenticate as.
 *
 * IT DISABLES NOTHING IT CANNOT PROVE IS UNUSED. A failed rollback deploy, a
 * failed owner probe, an echoed secret, or backends that will not reach zero
 * all leave the credential ENABLED and escalate - a live machine with a working
 * credential is a bad state, and a live machine with a credential we just
 * revoked is a worse one.
 */
async function recover(seams: Seams, phase: Phase): Promise<Outcome> {
  seams.report(`recovery_phase: ${phase}`);
  let facts: LiveFacts;
  let target: Awaited<ReturnType<Seams["api"]["resolve"]>>;
  try {
    facts = await seams.db.facts();
    target = await seams.api.resolve();
  } catch {
    // The world cannot be read, so nothing about it can be asserted - including
    // that a rollback happened. The credential is left exactly as it is.
    seams.report("recovery_state_unreadable: true");
    return "escalate";
  }
  if (!mayRecover(facts)) {
    // Either a session outlived its NOLOGIN, or the owner's own bounds have
    // drifted - and the rollback deploys the owner DSN, which the committed
    // runtime opens through a check that would refuse it.
    seams.report("recovery_possible: false");
    return "escalate";
  }
  if (
    !(await recoveryPreconditions(seams, target.ownerDsn, target.hostIsPooler))
  ) {
    seams.report("recovery_allowed: false");
    return "escalate";
  }
  for (const step of recoveryFor(phase)) {
    seams.report(`recovery_step: ${step}`);
    try {
      const outcome = await recoveryStep(seams, step, target.ownerDsn);
      if (outcome !== null) return outcome;
    } catch {
      // A THROWING PROVIDER DOES NOT ESCAPE THIS FUNCTION. The caller of a
      // rollback is an operator reading a transcript, and an exception from a
      // dead flyctl would tell them less than the escalation does - while
      // leaving the credential enabled, which is what an unfinished rollback
      // must do. The error itself is dropped: it is a child process's free text
      // and it can carry a DSN.
      seams.report(`recovery_step_threw: ${step}`);
      return "escalate";
    }
  }
  return "rolled_back";
}

/** One recovery step. Null means "carry on"; anything else ends the recovery. */
async function recoveryStep(
  seams: Seams,
  step: string,
  ownerDsn: string,
): Promise<Outcome | null> {
  if (step === "stage_owner_dsn") {
    const staged = await seams.fly.stage(ownerDsn);
    seams.report(`owner_dsn_staged: ${staged.ok}`);
    seams.report(`value_in_child_output: ${staged.valueEchoed}`);
    // RULING 8 APPLIES TO THE ROLLBACK TOO. A child that repeated the value it
    // was given has put a DSN somewhere this program does not control, and
    // carrying on would end with the credential disabled and that fact buried
    // under a successful-looking rollback.
    if (!staged.ok || staged.valueEchoed) return "escalate";
  }
  if (step === "deploy") {
    // The rollback deploy needs the same ground the forward one needs: one
    // started machine, and a baseline its replacement can be compared against.
    const prepared = await seams.fly.prepareDeploy();
    seams.report(`rollback_deploy_baseline: ${prepared}`);
    if (!prepared) return "escalate";
    const result = await seams.fly.deploy(DEPLOY_ARGV);
    seams.report(`rollback_deploy_exit: ${result.exitCode ?? "unknown"}`);
    if (result.threw || result.exitCode !== 0) return "escalate";
  }
  if (step === "prove_machine_replaced") {
    // THE ROLLBACK DEPLOY HAS TO HAVE LANDED. A zero exit says flyctl finished,
    // not that the machine running now is the one that was deployed - and every
    // reading after this step is a statement about that machine.
    const replaced = await seams.fly.machineReplaced();
    seams.report(`rollback_machine_replaced: ${replaced}`);
    if (!replaced) return "escalate";
  }
  if (step === "probe_owner_path") {
    const green = await seams.probe();
    seams.report(`owner_path_probe: ${green}`);
    if (!green) return "escalate";
  }
  if (step === "prove_role_backends_zero") {
    // A SERIES, ALL OF IT ZERO. One reading is the same one-way evidence this
    // design refuses everywhere else: a machine still configured for the role
    // shows zero between two opens, through a restart and while it crash-loops,
    // so a single zero cannot say the configuration will not use the role at
    // its next open. Anything else leaves the credential alone - revoking it
    // here is how a rollback becomes the outage it was meant to prevent.
    const series = await seams.db.backendSamples();
    seams.report(`rollback_backend_samples: ${series.length}`);
    const allZero =
      series.length > 0 && series.every((n) => Number.isInteger(n) && n === 0);
    seams.report(`rollback_backends_all_zero: ${allZero}`);
    if (!allZero) return "escalate";
  }
  if (step === "disable_role_credential") {
    await seams.db.run(closeCredentialSql());
    seams.report("credential_disabled: true");
  }
  if (step === "stop_and_escalate") return "escalate";
  return null;
}

/**
 * The move, once.
 *
 * ONE FORWARD ATTEMPT. Every failure after the credential exists goes to the
 * recovery, and every outcome after the deploy has been INVOKED - success,
 * failure, throw, timeout - is treated as though the staged value may now be
 * live, because a deploy's exit code is not evidence about what changed.
 */
export async function moveProvisioner(seams: Seams): Promise<Outcome> {
  /**
   * Everything after P1 goes through here.
   *
   * A REJECTED PROMISE IS NOT A DIFFERENT KIND OF FAILURE from a bad return
   * value: flyctl dying, a socket timing out and a deploy answering non-zero
   * are the same situation - the world may have changed and this process does
   * not know how. So every one of them lands on the same path: drop the free
   * text (a child's error can carry a DSN), re-read the world, recover.
   */
  const after = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> => {
    try {
      return { ok: true, value: await fn() };
    } catch {
      seams.report(`${label}_threw: true`);
      return { ok: false };
    }
  };
  const recoverFromWorld = async (): Promise<Outcome> => {
    let phase: Phase;
    try {
      phase = classifyPhase(await seams.db.facts());
    } catch {
      seams.report("recovery_state_unreadable: true");
      return "escalate";
    }
    return recover(seams, phase);
  };

  // EVERY OPENING READ IS INSIDE THE CATCH, not just the first four. A rejected
  // branch query, catalog read or machine listing is the same situation as an
  // unreadable one: this program cannot establish the ground it needs, and a
  // raw exception from a driver or a child is free text it does not print.
  //
  // WHAT AN UNREADABLE WORLD MEANS DEPENDS ON WHETHER A CREDENTIAL EXISTS. With
  // nothing written it is a refusal. Once `facts` has shown an inherited
  // credential it is an ESCALATION instead, because "refused, nothing was
  // done" would be a claim about a world nobody could read - and the credential
  // stays enabled with no provider write attempted (reviewer finding,
  // 2026-08-11).
  //
  // THE PHASE-DEFINING READ COMES FIRST, AND ITS FAILURE IS NEVER A REFUSAL.
  // `facts` is the only thing that can tell a fresh G2 state from an
  // interrupted G3 one, so a run that could not take it does not know whether a
  // credential is live - and "refused, nothing was written" would be a claim
  // about exactly the thing it failed to read. It escalates instead, which is
  // the outcome that sends a person to look (reviewer finding, 2026-08-11).
  let facts: LiveFacts;
  try {
    facts = await seams.db.facts();
  } catch {
    seams.report("credential_state_unknown: true");
    return "escalate";
  }
  const inheritedPhase = classifyPhase(facts);

  let sha: string | null;
  let clean: boolean;
  let target: Awaited<ReturnType<Seams["api"]["resolve"]>>;
  let pre: ForwardPreconditions;
  try {
    sha = await seams.source.committedSha();
    clean = await seams.source.treeIsClean();
    target = await seams.api.resolve();
    pre = {
      branchProved: await seams.db.branchProved(),
      ownerDsnReconstructsAndOpens: await seams.db.opens(target.ownerDsn),
      ownerBoundsExact: facts.ownerBoundsExact,
      hostIsPooler: target.hostIsPooler,
      roleGovernedExactly: await seams.db.roleGovernedExactly(),
      singleStartedMachine: await seams.fly.singleStartedMachine(),
      sourceIsCommitted: sha !== null,
      treeIsClean: clean,
      phase: inheritedPhase,
    };
  } catch {
    // A read that failed AFTER the facts proved a clean world is a refusal:
    // nothing was written and nothing exists to be uncertain about. The same
    // failure with a credential already in the catalog is an escalation.
    seams.report("preflight_unreadable: true");
    if (inheritedPhase !== "clean") {
      seams.report("inherited_credential_unreadable_world: true");
      return "escalate";
    }
    return "refused_precondition";
  }
  seams.report(`source_commit_readable: ${sha !== null}`);
  if (sha !== null) seams.report(`source_commit: ${sha}`);
  seams.report(`runtime_tree_clean: ${clean}`);
  const phase = pre.phase;
  seams.report(`inherited_phase: ${phase}`);
  for (const [name, value] of Object.entries(pre)) {
    if (typeof value === "boolean") seams.report(`${name}: ${value}`);
  }
  if (!mayGoForward(pre)) {
    // A phase other than clean means a previous run left something behind, and
    // that is a recovery rather than a refusal - with its OWN preflight, since
    // a rollback writes too.
    if (phase !== "clean") return recover(seams, phase);
    seams.report("forward_allowed: false");
    return "refused_precondition";
  }

  // NO CREDENTIAL VALUE EXISTS UNTIL THE RUN IS ALLOWED TO GO FORWARD. Building
  // it above meant a refused run generated a password it had nowhere to put,
  // and an inherited credential built a role string it would never use - on a
  // path where a throw from `roleDsnFor` would have escaped before the recovery
  // could run (reviewer finding, 2026-08-11).
  const password = generatedPassword();
  let roleDsn: string;
  try {
    roleDsn = target.roleDsnFor(password);
  } catch {
    // Nothing has been written, so this is a refusal. The error is dropped: it
    // is about a connection string.
    seams.report("role_dsn_buildable: false");
    return "refused_precondition";
  }

  // ------------------------------------------------------------------ P1
  //
  // AN ERROR HERE IS AMBIGUOUS. `ALTER ROLE` can commit and the client still
  // see a failure - a socket that dies after the server applied it looks
  // exactly like one that died before. So a throw goes to the recovery, which
  // re-reads whether the credential exists, rather than to a refusal.
  const opened = await after("open_credential", () =>
    seams.db.run(openCredentialSql(password)),
  );
  if (!opened.ok) return recoverFromWorld();
  seams.report("credential_opened: true");

  // ------------------------------------------------------------------ P2
  const staged = await after("stage", () => seams.fly.stage(roleDsn));
  if (!staged.ok) return recoverFromWorld();
  seams.report(`new_dsn_staged: ${staged.value.ok}`);
  seams.report(`value_in_child_output: ${staged.value.valueEchoed}`);
  if (!staged.value.ok || staged.value.valueEchoed) return recoverFromWorld();

  // ------------------------------------------------------------------ P3
  //
  // THE SAMPLING RUNS THROUGH THE DEPLOY, not after it. The overlap the budget
  // was sized against - the machine being replaced and the machine replacing it
  // both connected - exists only while the deploy is in flight, so a series
  // that starts when the deploy returns cannot see it however long it runs.
  //
  // The topology read and the baseline capture happen HERE rather than inside
  // the deploy, so that the sampled window contains the child and nothing else.
  const prepared = await after("prepare_deploy", () =>
    seams.fly.prepareDeploy(),
  );
  if (!prepared.ok) return recoverFromWorld();
  seams.report(`deploy_baseline_captured: ${prepared.value}`);
  if (!prepared.value) return recoverFromWorld();

  const run = await after("deploy", () =>
    seams.db.sampleAcross(() => seams.fly.deploy(DEPLOY_ARGV)),
  );
  if (!run.ok) return recoverFromWorld();
  const result = run.value.value;
  const series = run.value.samples;
  seams.report(`deploy_exit: ${result.exitCode ?? "unknown"}`);
  seams.report(`backend_samples_during_deploy: ${run.value.during}`);
  if (result.threw || result.exitCode !== 0) return recoverFromWorld();

  // ------------------------------------------------------------------ P4
  const names = await after("verify_secret_names", () =>
    seams.fly.secretNamesPresent(),
  );
  if (!names.ok) return recoverFromWorld();
  // NAME PRESENCE ONLY. It does not say which value is staged or live, so it is
  // reported as what it is and the probe is what says the deployment works.
  seams.report(`secret_names_present: ${names.value}`);

  const green = await after("probe", () => seams.probe());
  if (!green.ok) return recoverFromWorld();
  seams.report(`probe_green: ${green.value}`);

  const replaced = await after("machine_replaced", () =>
    seams.fly.machineReplaced(),
  );
  if (!replaced.ok) return recoverFromWorld();
  seams.report(`machine_replaced: ${replaced.value}`);

  // THE SERIES TAKEN ACROSS THE DEPLOY, judged. The engine cap of 12 is the
  // bound; these are the supporting measurement the overlap argument promised.
  // At least one reading has to have been taken while the deploy was pending,
  // or the series is a steady-state observation wearing an overlap's clothes.
  seams.report(`backend_samples: ${series.length}`);
  const observedDeploy = run.value.during >= 1;
  seams.report(`overlap_observed: ${observedDeploy}`);
  const insideCap =
    series.length > 0 &&
    series.every((n) => Number.isInteger(n) && n >= 0 && n <= HARD_CAP);
  seams.report(`every_sample_inside_cap: ${insideCap}`);
  const settled = series.length > 0 ? series[series.length - 1] : -1;
  seams.report(`settled_backends: ${settled}`);
  const steady = settled >= STEADY_MIN && settled <= STEADY_MAX;
  seams.report(`settled_backends_steady: ${steady}`);

  if (
    !names.value ||
    !green.value ||
    !replaced.value ||
    !observedDeploy ||
    !insideCap ||
    !steady
  ) {
    return recoverFromWorld();
  }
  seams.report("acceptance: true");
  return "moved";
}
