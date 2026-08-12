// The provisioner's credential move, bound to the real world and run.
//
//   bun control-plane/deploy/provisioner-move-run.ts --plan           print it
//   bun control-plane/deploy/provisioner-move-run.ts --source-state   git only
//   bun control-plane/deploy/provisioner-move-run.ts --machine-state  one read
//   bun control-plane/deploy/provisioner-move-run.ts --execute        do it
//
// The first two contact no provider at all. `--machine-state` is one read-only
// flyctl listing, and it exists so the field names a deploy's evidence rests on
// are established before a run depends on them. Only `--execute` writes.
//
// `provisioner-move.ts` holds the orchestration and knows nothing about
// providers; this is the half that decides what its seams actually DO. The two
// are separate because a reviewed library cannot establish that the executable
// obeys it - and separate does not mean untested: every adapter below takes its
// provider primitive as an argument, so the argv a deploy runs, the bytes a
// stage writes, the verdict a probe parses and the error a driver throws are
// all asserted in `provisioner-move-run.test.ts` with no provider credential
// and no live call.
//
// WHAT EACH ADAPTER IS FOR, in the order a run meets them:
//
//   source   `fly deploy .` ships the working DIRECTORY, so the guard asks
//            whether any path THE IMAGE CARRIES differs from HEAD - through the
//            same .dockerignore rules the image test asserts, not a hand-written
//            list that can drift from them.
//   api      ONE resolution of the production target, memoised, so the branch
//            proved, the owner string opened and the role string staged all
//            come from the same reading.
//   db       every statement goes through `redactConnectionDetails`, which is
//            the ruling-8 boundary for a driver whose errors carry the host on a
//            refused socket and the ROLE on a bad password.
//   fly      `pushSecrets` for one name over stdin, and one deploy of exactly
//            `DEPLOY_ARGV`. A child that dies is not a different kind of failure
//            from a child that answers non-zero: both become the coordinator's
//            ambiguity, with the child's text dropped rather than reported.
//   probe    the child's WHOLE transcript, typed and recomputed - not its exit
//            code and not one line of it. A program that trusts either accepts
//            a child whose own readings contradict its verdict. It also tells a
//            machine that is still coming up from one that is wrong, and waits
//            only for the first, under an absolute deadline and an attempt cap.
//
// THIS PROGRAM PRINTS booleans, small integers, exit codes and fixed labels.
// The generated password, the connection strings, the host, the role name and
// the branch id appear on no path, error paths included.

import pg from "pg";
import * as path from "node:path";
import { PROVISIONER_ROLE, boundsAreExact, roleFactsSql } from "../roles.ts";
import { GOVERNED_SETTINGS, redactConnectionDetails } from "../store.ts";
import {
  type Target,
  liveBranchId as realLiveBranchId,
} from "../exercises/neon-api.ts";
import {
  APP,
  type BoundedSpawn,
  FLYCTL,
  FLY_TOKEN_FILE,
  KILL_GRACE_MS,
  type Spawn,
  readSecretFile,
  realBoundedSpawn,
} from "./fly-cli.ts";
import {
  DB_SECRET_NAME,
  provenProductionTarget,
  pushSecrets,
  requiredNamesPresent,
} from "./secrets.ts";
import {
  REPO_ROOT,
  contextRules as realContextRules,
  shipsToImage,
} from "./build-context.ts";
import {
  classifyAgainstHead,
  headPathsFrom,
  parsePorcelain,
} from "./tree-state.ts";
import {
  DEPLOY_ARGV,
  FORWARD_STEPS,
  type Phase,
  recoveryFor,
  roleIsGovernedExactly,
} from "./provisioner-role.ts";
import {
  type Outcome,
  type Seams,
  moveProvisioner,
} from "./provisioner-move.ts";
import { classifyProbeRun } from "./probe-transcript.ts";

/** The probe, run as a child so its own credential never enters this process. */
export const PROBE_SCRIPT = path.join(import.meta.dir, "probe.ts");

/**
 * The only part of the repository the image COPYs.
 *
 * The Dockerfile carries `control-plane` and the deploy manifest that lives
 * under it, so a change anywhere else cannot reach the machine. Narrowing the
 * git commands to this pathspec is what keeps the guard from failing on a
 * working tree that is busy somewhere the image never sees.
 */
export const IMAGE_PATHSPEC = "control-plane";

/** The rules that decide what the copied path actually contains. Outside the
 * pathspec above, and a build input all the same. */
export const CONTEXT_RULES_PATH = ".dockerignore";

/** How many backend readings a move takes after its deploy, and how far apart.
 * Bounded by construction: this waits for a fixed number of samples, never for
 * a number to settle. */
export const BACKEND_SAMPLES = 6;
export const BACKEND_SAMPLE_GAP_MS = 5_000;

/** The most readings taken WHILE a deploy is in flight - about ten minutes at
 * the gap above, which is longer than any deploy this app has run and short
 * enough that a deploy which never returns still ends the sampler. */
export const SAMPLES_DURING_CAP = 120;

/**
 * How long the deploy child may run before it is terminated and reaped.
 *
 * MEASURED, not guessed. The two real deploys of this app both ran
 * `flyctl deploy . --depot=true --ha=false --now` end to end: 64.8s for the
 * first (image built from nothing) and 72.6s for the redeploy, on 2026-08-11.
 * Twenty minutes is about sixteen times the slower of the two, so it cannot
 * fire on a healthy deploy that is merely having a bad day - and a deploy still
 * running after twenty minutes is stuck by any reading, which is exactly the
 * ambiguous outcome the coordinator knows how to recover from.
 *
 * Capping the SAMPLER is not capping the deploy: the sampler stops at
 * `SAMPLES_DURING_CAP` and then waits, so without this the wait is unbounded
 * and a hung flyctl holds a staged secret and a live credential open forever
 * (reviewer finding, 2026-08-11).
 */
export const DEPLOY_DEADLINE_MS = 20 * 60_000;

/**
 * The deadline for every OTHER child: the two flyctl listings, the staged
 * secret import, and the probe.
 *
 * Measured 2026-08-11 from the D2 session's own transcript: read-only flyctl
 * commands against this app answered in 2.6s and 4.3s, and the probe is five
 * HTTPS round trips to one host. Two minutes is roughly thirty times the slower
 * measurement, so it cannot fire on a command that is merely slow - and a
 * `secrets import` still running after two minutes is holding a credential the
 * run cannot account for.
 */
export const LIGHT_DEADLINE_MS = 2 * 60_000;

/** The exit code a child gets when its run was not clean. Not a code any
 * program returns: every consumer here treats non-zero as failure, so an
 * unclean run cannot be mistaken for a successful one. */
export const UNCLEAN_EXIT = -1;

/**
 * HOW LONG A REPLACED MACHINE IS GIVEN TO START TICKING, and what that number
 * is a statement about.
 *
 * IT IS A ROLLOUT-READINESS POLICY, NOT A MEASUREMENT. Nothing here has proved
 * an upper bound on how long `Ticker.once` takes - it opens a store, reads
 * instances and can drive provider work, so a bound would have to be a claim
 * about the provider too. What this number says is narrower and is a CHOICE:
 * after three minutes without a healthy reading, this run prefers rolling back
 * to waiting longer. A machine that needed four minutes is rolled back and
 * looked at, which is the safe direction for a move that holds a live
 * credential open while it waits.
 *
 * `tick_recent` is the reason a wait exists at all. It is false until the first
 * pass completes (`cli.ts`, three poll intervals), so a machine fly has just
 * replaced is correctly healthy-but-not-yet-ticking, and the probe correctly
 * refuses. Treating that as a failed deploy would roll back a deployment that
 * was coming up normally.
 */
export const READINESS_DEADLINE_MS = 3 * 60_000;

/** Between attempts. Small enough that a machine which comes up in ten seconds
 * is not waited on for a minute, large enough that eighteen attempts cannot
 * become a hot loop against the deployed surface. */
export const READINESS_GAP_MS = 10_000;

/**
 * The most probe children one readiness wait may run, INDEPENDENT OF TIME.
 *
 * Two limits rather than one, because they fail differently: a clock that
 * jumped, a sleep that returned early or a probe that answered instantly would
 * each let a time-bounded loop spawn children without limit, and a count-bounded
 * loop alone would wait for eighteen slow children however long that took. Both
 * are enforced, and both are tested.
 */
export const READINESS_ATTEMPT_CAP = 18;

/** What the readiness wait may do next, from the two limits alone. Pure, so
 * both bounds are asserted directly rather than through a spawn count. */
export type ReadinessStep =
  | { action: "run"; deadlineMs: number }
  | { action: "stop"; reason: "expired" | "attempt_cap" };

/**
 * May attempt number `attempt` start, and with what deadline?
 *
 * NO CHILD STARTS AT OR AFTER EXPIRY, and a child that starts gets the SMALLER
 * of the ordinary light deadline and what is left - so the last attempt cannot
 * run two minutes past a three-minute budget. The attempt cap is checked first
 * because it does not depend on a clock.
 */
export function planReadinessAttempt(args: {
  attempt: number;
  remainingMs: number;
}): ReadinessStep {
  if (args.attempt > READINESS_ATTEMPT_CAP) {
    return { action: "stop", reason: "attempt_cap" };
  }
  if (!Number.isFinite(args.remainingMs) || args.remainingMs <= 0) {
    return { action: "stop", reason: "expired" };
  }
  return {
    action: "run",
    deadlineMs: Math.min(LIGHT_DEADLINE_MS, args.remainingMs),
  };
}

/** How long to wait before the next attempt, or null when the budget is spent.
 * A sleep is capped by the remaining budget for the same reason a child is: the
 * deadline is absolute, and a fixed gap could carry the loop past it. */
export function planReadinessGap(remainingMs: number): number | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  return Math.min(READINESS_GAP_MS, remainingMs);
}

const BACKEND_COUNT_SQL =
  "select count(*)::int as n from pg_stat_activity where usename = $1";

/**
 * Everything that touches something outside this process.
 *
 * Each one is the smallest real operation the adapter above it needs, which is
 * what lets the tests drive the adapters - the argv, the stdin, the parsing and
 * the failure handling - without a provider.
 */
export interface Primitives {
  git(args: readonly string[]): Promise<{ code: number; stdout: string }>;
  /**
   * THE ONLY WAY THIS PROGRAM STARTS A CHILD.
   *
   * There is deliberately no unbounded spawn here. Every child it runs after a
   * credential exists - the stage, the listings, the deploy, the probe - can
   * hold that credential open forever if it hangs, and "forever" has no
   * recovery path (reviewer finding, 2026-08-11). One primitive, one lifetime
   * rule: a deadline, a terminated process GROUP, and proof the group is gone.
   */
  boundedSpawn: BoundedSpawn;
  /** Read once, held here, never printed and never an argument. */
  flyToken(): string;
  resolveTarget(): Promise<Target>;
  liveBranchId(dsn: string): Promise<string | null>;
  /** The RAW driver call. The redaction boundary is in the adapter, so it is
   * the thing under test rather than a property of the primitive. */
  sql(
    dsn: string,
    statement: string,
    args?: unknown[],
  ): Promise<Record<string, unknown>[]>;
  contextRules(): readonly string[];
  /** Where `fly deploy .` would take its build context from. */
  cwd(): string;
  sleep(ms: number): Promise<void>;
  /**
   * The clock the readiness deadline is measured on. A primitive rather than a
   * call to `Date.now`, so both limits of the wait are drivable in a test
   * without one of them being real seconds.
   *
   * IT MUST NOT GO BACKWARDS. `Date.now` can: an NTP correction or an operator
   * setting the clock moves it either way, and a backward step INCREASES the
   * remaining budget, which would let a three-minute wait run for as long as
   * the attempt cap allowed (reviewer finding, 2026-08-12). The real primitive
   * is monotonic, and the wait clamps on top of it, so neither a wrong clock
   * nor a wrong primitive can extend the aggregate.
   */
  now(): number;
  /** The interpreter the probe child runs under. */
  interpreter: string;
}

/** A parse of `flyctl machines list --json`, as counts and one opaque string. */
export interface MachineReading {
  readable: boolean;
  count: number;
  /** What changes when a machine is replaced. Never printed: it is provider
   * text, and the answer this program reports is whether it moved. */
  generation: string;
  allStarted: boolean;
}

const UNREADABLE: MachineReading = {
  readable: false,
  count: -1,
  generation: "",
  allStarted: false,
};

/**
 * What identifies THIS run of a machine, from the fields fly actually carries.
 *
 * `instance_id` changes every time a machine is started from a new
 * configuration, and the image digest changes with the build. Both are read and
 * whichever are present are combined, because a reading that depended on one
 * field name would answer "not replaced" for a successful deploy the day fly
 * renames it - and the coordinator would then roll back a move that worked. A
 * row carrying neither is UNREADABLE rather than empty, which is caught before
 * the deploy runs rather than after.
 */
export function generationOf(row: unknown): string | null {
  const machine = (row ?? {}) as Record<string, unknown>;
  const imageRef = (machine.image_ref ?? {}) as Record<string, unknown>;
  const parts = [machine.instance_id, imageRef.digest].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return parts.length > 0 ? parts.join("|") : null;
}

/** The one shape the overlap arithmetic and the replacement evidence both
 * assume: a listing this program could read, holding one started machine whose
 * identity it can compare. */
export function isSingleStarted(reading: MachineReading): boolean {
  return reading.readable && reading.count === 1 && reading.allStarted;
}

export function readMachineListing(stdout: string): MachineReading {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return UNREADABLE;
  }
  if (!Array.isArray(rows)) return UNREADABLE;
  const generations = rows.map(generationOf);
  if (generations.some((g) => g === null)) return UNREADABLE;
  return {
    readable: true,
    count: rows.length,
    generation: generations.join(","),
    allStarted: rows.every(
      (r) => (r as Record<string, unknown>).state === "started",
    ),
  };
}

/**
 * The role's connection string, which differs from the owner's in its
 * credentials and in nothing else.
 *
 * Built from the SAME string the owner was proved on, so the host, the database
 * and the TLS mode cannot drift between the thing that was proved and the thing
 * that gets deployed. Both checks at the end are load bearing, and the second
 * one is not theoretical: `URL` DISCARDS credentials silently when the string
 * carries no host (`postgresql:///db` - measured), and the result of that is a
 * "role" connection string that is byte for byte the OWNER's, staged and
 * deployed as though the move had happened.
 */
export function roleDsnFrom(ownerDsn: string, password: string): string {
  const url = parseDsn(ownerDsn);
  const user = encodeURIComponent(PROVISIONER_ROLE);
  const secret = encodeURIComponent(password);
  url.username = user;
  url.password = secret;
  const built = url.toString();
  const after = parseDsn(built);
  const before = parseDsn(ownerDsn);
  if (
    after.protocol !== before.protocol ||
    after.host !== before.host ||
    after.pathname !== before.pathname ||
    after.search !== before.search
  ) {
    throw new Error(
      "the role connection string differs from the owner's in more than its " +
        "credentials",
    );
  }
  if (after.username !== user || after.password !== secret) {
    throw new Error(
      "the role connection string did not take the credentials it was given",
    );
  }
  return built;
}

/** `new URL` puts the offending string on the error it throws, and that string
 * is the connection string. So the parse has its own fixed sentence. */
function parseDsn(dsn: string): URL {
  try {
    return new URL(dsn);
  } catch {
    throw new Error("a connection string could not be parsed");
  }
}

function configOf(row: Record<string, unknown> | undefined): string[] {
  const value = row?.config;
  return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * The real seams, over injectable primitives.
 *
 * `report` is the coordinator's transcript channel and the adapters write to it
 * too - counts and booleans that only this layer can see: how many shipped
 * paths are uncommitted, how many machines fly listed, what the probe child
 * exited with.
 */
export function realSeams(
  p: Primitives,
  report: (line: string) => void,
): Seams {
  let targetOnce: Promise<Target> | null = null;
  /** ONE resolution for the whole run, rejection included: two resolutions are
   * two chances to prove one string and deploy another. */
  const target = (): Promise<Target> => (targetOnce ??= p.resolveTarget());

  let ownerOnce: Promise<string> | null = null;
  const ownerRole = async (): Promise<string> => {
    ownerOnce ??= (async () => {
      const dsn = (await target()).dsn;
      const rows = await ask(dsn, "select current_user as role");
      const role = rows[0]?.role;
      if (typeof role !== "string" || role.length === 0) {
        throw new Error("the database did not name the connected role");
      }
      return role;
    })();
    return ownerOnce;
  };

  /** THE RULING-8 BOUNDARY for everything this program asks the database. A
   * refused socket carries the address and a bad password carries the role, so
   * the transform happens where the error is born rather than where somebody
   * remembers to catch it. */
  const ask = async (
    dsn: string,
    statement: string,
    args?: unknown[],
  ): Promise<Record<string, unknown>[]> => {
    try {
      return await p.sql(dsn, statement, args);
    } catch (err) {
      throw redactConnectionDetails(err, dsn);
    }
  };

  const backends = async (): Promise<number> => {
    const dsn = (await target()).dsn;
    const rows = await ask(dsn, BACKEND_COUNT_SQL, [PROVISIONER_ROLE]);
    const n = Number(rows[0]?.n);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("the backend count did not come back as a whole number");
    }
    return n;
  };

  /**
   * The D2 helpers (`pushSecrets`, `requiredNamesPresent`) take a `Spawn`, and
   * what they get is the bounded primitive wearing that shape: same argv, same
   * stdin, same captured-and-never-emitted output, plus a deadline and a
   * terminated group. An unclean run arrives as `UNCLEAN_EXIT`, which every one
   * of those consumers already treats as failure - and the reason is reported
   * as fixed booleans, because a caller that ignores the code still must not be
   * able to read a fragment as a success.
   */
  const boundedAsSpawn =
    (label: string, deadlineMs: number): Spawn =>
    async (argv, env, stdin) => {
      const result = await p.boundedSpawn(argv, env, stdin, deadlineMs);
      if (result.timedOut) report(`${label}_timed_out: true`);
      if (result.groupSurvived) report(`${label}_group_survived: true`);
      if (!result.groupEmpty) report(`${label}_group_not_empty: true`);
      return {
        code: result.code ?? UNCLEAN_EXIT,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    };

  const flyRun = async (argv: readonly string[]) =>
    boundedAsSpawn("machine_listing", LIGHT_DEADLINE_MS)(
      [FLYCTL, ...argv],
      { FLY_API_TOKEN: p.flyToken() },
      "",
    );

  const readMachines = async (): Promise<MachineReading> => {
    let result;
    try {
      result = await flyRun(["machines", "list", "-a", APP, "--json"]);
    } catch {
      return UNREADABLE;
    }
    if (result.code !== 0) return UNREADABLE;
    return readMachineListing(result.stdout);
  };

  /** The reading taken immediately before the deploy was invoked, or null when
   * no deploy has been invoked at all. */
  let beforeDeploy: MachineReading | null = null;

  return {
    source: {
      /**
       * The commit the tree fly would ship is at.
       *
       * NULL WHEN THIS IS NOT THE BUILD CONTEXT. `fly deploy .` sends the
       * current directory, so a HEAD read from a repository the deploy would
       * not ship is an answer about the wrong tree - and the coordinator's
       * "source is a readable commit" precondition is exactly the one that
       * should refuse it.
       */
      committedSha: async () => {
        const top = await p.git(["rev-parse", "--show-toplevel"]);
        if (top.code !== 0) return null;
        if (path.resolve(top.stdout.trim()) !== path.resolve(p.cwd())) {
          return null;
        }
        const head = await p.git(["rev-parse", "HEAD"]);
        if (head.code !== 0) return null;
        const sha = head.stdout.trim();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
      },

      /**
       * Does the image carry anything that is in no commit?
       *
       * NOT the archive question. `deploy/tree-state.ts` classifies for
       * `git archive HEAD`, where an untracked file cannot be shipped and a
       * changed `.md` cannot change runtime behaviour. A fly deploy ships the
       * DIRECTORY, so both of those go the other way: an untracked file under
       * the copied path travels, and a changed document travels with it. What
       * is asked here is only whether the image would be reconstructible from
       * HEAD, so every SHIPPED path counts and every path the rules drop -
       * `control-plane/web`, the tests, node_modules - counts for nothing.
       *
       * AND THE RULES THEMSELVES ARE AN UNCOMMITTED BUILD INPUT LIKE ANY OTHER.
       * `/.dockerignore` sits outside the copied path, so the count above can
       * never see it - while its working-tree bytes decide what that count is
       * allowed to ignore. A modified one can put `control-plane/web`, the
       * tests or node_modules into the image and answer "reconstructible" about
       * the result. So it is checked separately and FIRST IN MEANING: HEAD must
       * carry it and the tree must not have touched it, or its rules are not
       * trusted at all (reviewer finding, 2026-08-11).
       */
      treeIsClean: async () => {
        const status = await p.git([
          "status",
          "--porcelain",
          "-uall",
          "--",
          IMAGE_PATHSPEC,
          CONTEXT_RULES_PATH,
        ]);
        const tree = await p.git([
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
          "--",
          IMAGE_PATHSPEC,
          CONTEXT_RULES_PATH,
        ]);
        if (status.code !== 0 || tree.code !== 0) {
          report("source_readable: false");
          return false;
        }
        const entries = parsePorcelain(status.stdout);
        const headPaths = headPathsFrom(tree.stdout);

        // A rename is judged by BOTH halves here as well: `R .dockerignore ->
        // x` leaves the rules file gone from the tree while HEAD still carries
        // it, which is a changed build input by any reading.
        const rulesTouched = entries.some(
          (e) => e.path === CONTEXT_RULES_PATH || e.from === CONTEXT_RULES_PATH,
        );
        const rulesCommitted =
          headPaths.has(CONTEXT_RULES_PATH) && !rulesTouched;
        report(`context_rules_committed: ${rulesCommitted}`);

        const verdict = classifyAgainstHead(entries, headPaths);
        const rules = p.contextRules();
        const shipped = [
          ...verdict.runtimeDirty,
          ...verdict.docOnly,
          ...verdict.notInHead,
        ].filter((file) => shipsToImage(rules, file));
        report(`shipped_paths_uncommitted: ${shipped.length}`);
        return rulesCommitted && shipped.length === 0;
      },
    },

    db: {
      facts: async () => {
        const dsn = (await target()).dsn;
        const owner = await ownerRole();
        const rows = await ask(dsn, roleFactsSql(), [
          [PROVISIONER_ROLE, owner],
        ]);
        const roleRow = rows.find((r) => r.role === PROVISIONER_ROLE);
        const ownerRow = rows.find((r) => r.role === owner);
        return {
          roleCanLogin: roleRow?.can_login === true,
          roleBackends: await backends(),
          // A missing owner row reads as no configuration at all, which is not
          // the governed pair - the direction that refuses.
          ownerBoundsExact: boundsAreExact(
            configOf(ownerRow),
            GOVERNED_SETTINGS,
          ),
        };
      },

      branchProved: async () => {
        const t = await target();
        const live = await p.liveBranchId(t.dsn);
        return live !== null && live === t.branch.id;
      },

      roleGovernedExactly: async () => {
        const dsn = (await target()).dsn;
        const rows = await ask(dsn, roleFactsSql(), [[PROVISIONER_ROLE]]);
        const row = rows.find((r) => r.role === PROVISIONER_ROLE);
        if (row === undefined) return false;
        return roleIsGovernedExactly({
          connectionLimit: Number(row.connection_limit),
          config: configOf(row),
          bounds: GOVERNED_SETTINGS,
        });
      },

      /** A live open of THIS string. The failure is not reported at all: a
       * connection that did not open is a boolean, and building a message from
       * the driver's error would be building it out of the host and the role. */
      opens: async (dsn) => {
        try {
          await p.sql(dsn, "select 1 as one");
          return true;
        } catch {
          return false;
        }
      },

      run: async (statement) => {
        const dsn = (await target()).dsn;
        await ask(dsn, statement);
      },

      /**
       * Count backends WHILE something runs, then watch them settle.
       *
       * Two halves, both bounded by construction. The first samples until the
       * action settles or `SAMPLES_DURING_CAP` readings have been taken, so a
       * deploy that never returns cannot make this run forever; the first
       * reading is taken unconditionally, after the action has been invoked and
       * before anything is awaited, so a deploy that finishes between two
       * readings still leaves one taken while it was pending. The second is the
       * fixed settlement series.
       *
       * The action's own rejection is not swallowed: the caller wraps this, and
       * a deploy that could not even be invoked is not a measurement.
       */
      sampleAcross: async <T>(action: () => Promise<T>) => {
        const samples: number[] = [];
        let settled = false;
        const running = action();
        // The failure is handled below; this copy only stops the loop.
        const finished = running.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        // A FAILED MEASUREMENT DOES NOT END THE ACTION. Returning the moment a
        // reading fails would hand control back to a recovery that stages the
        // owner DSN and runs a SECOND deploy while the first one is still
        // running - two deploys racing over one machine, caused by a database
        // hiccup (reviewer finding, 2026-08-11). So a sampling failure is
        // remembered, and the action is awaited either way; the wait is bounded
        // by the deploy's own deadline.
        let samplingFailure: Error | null = null;
        try {
          for (let i = 0; i < SAMPLES_DURING_CAP; i++) {
            samples.push(await backends());
            if (settled) break;
            await Promise.race([finished, p.sleep(BACKEND_SAMPLE_GAP_MS)]);
          }
        } catch (err) {
          // Already redacted by `ask`; anything else becomes a fixed sentence
          // rather than travelling as whatever it was.
          samplingFailure =
            err instanceof Error
              ? err
              : new Error("a backend reading failed during the deploy");
        }
        const during = samples.length;

        const value = await running;
        report(`backend_samples_during: ${during}`);
        if (samplingFailure !== null) {
          // The action is over, so control may leave now. The error is the
          // adapter's redacted one.
          report("backend_sampling_failed: true");
          throw samplingFailure;
        }

        for (let i = 0; i < BACKEND_SAMPLES; i++) {
          await p.sleep(BACKEND_SAMPLE_GAP_MS);
          samples.push(await backends());
        }
        report(`backend_sample_count: ${samples.length}`);
        return { value, samples, during };
      },

      backendSamples: async () => {
        const series: number[] = [];
        for (let i = 0; i < BACKEND_SAMPLES; i++) {
          if (i > 0) await p.sleep(BACKEND_SAMPLE_GAP_MS);
          series.push(await backends());
        }
        report(`backend_sample_count: ${series.length}`);
        return series;
      },
    },

    api: {
      resolve: async () => {
        const t = await target();
        return {
          hostIsPooler: parseDsn(t.dsn).hostname.includes("-pooler"),
          ownerDsn: t.dsn,
          roleDsnFor: (password: string) => roleDsnFrom(t.dsn, password),
        };
      },
    },

    fly: {
      /**
       * ONE NAME, over stdin, staged.
       *
       * `pushSecrets` is D2's, and the allowlist handed to it here is a single
       * name: the import mode of `secrets.ts` sets all three, including the
       * OWNER string, which is the opposite of what this program is for. A
       * value carrying a line break would end one NAME=VALUE line and begin
       * another; `pushSecrets` refuses that before a child exists, and the
       * refusal arrives here as `ok: false` with nothing spawned.
       */
      stage: async (value) => {
        const outcome = await pushSecrets({
          pairs: [{ name: DB_SECRET_NAME, value }],
          allowed: [DB_SECRET_NAME],
          flyToken: p.flyToken(),
          spawn: boundedAsSpawn("stage", LIGHT_DEADLINE_MS),
          app: APP,
        });
        return {
          ok:
            outcome.spawned &&
            outcome.exitCode === 0 &&
            outcome.problems.length === 0,
          valueEchoed: outcome.valueInChildOutput,
        };
      },

      /**
       * The deploy, once, with the machine reading that will prove it.
       *
       * THE BEFORE READING COMES FIRST AND IS A REFUSAL. Replacement can only
       * be shown as a difference, so a listing that cannot be parsed makes the
       * evidence unobtainable - and finding that out BEFORE the deploy costs a
       * rollback of a staged secret, while finding it out afterwards would roll
       * back a move that had worked.
       */
      /**
       * The topology read AND the baseline, immediately before a deploy - and
       * deliberately NOT inside it.
       *
       * It used to be the deploy's first step, which made the sampler's first
       * reading concurrent with a `machines list` rather than with the deploy:
       * a fast deploy could then finish and still be reported as observed,
       * which is a false claim about the only measurement that says the overlap
       * fits (reviewer finding, 2026-08-11). Split out, the deploy's first
       * effect is the child, and this is the mutation-boundary check that the
       * shape is still one started machine.
       */
      prepareDeploy: async () => {
        const before = await readMachines();
        report(`machine_listing_readable: ${before.readable}`);
        report(`machines_before_deploy: ${before.count}`);
        report(`machines_started_before_deploy: ${before.allStarted}`);
        if (!isSingleStarted(before)) {
          beforeDeploy = null;
          return false;
        }
        beforeDeploy = before;
        return true;
      },

      /**
       * The deploy child, and NOTHING before it.
       *
       * No await precedes the spawn, so "a reading taken while this was
       * running" means what it says. The baseline is a precondition rather
       * than a step: a deploy whose replacement could never be proved is one
       * this program does not start.
       */
      deploy: async (argv) => {
        if (beforeDeploy === null) {
          throw new Error(
            "a deploy was attempted with no machine baseline captured, so a " +
              "replacement could not be proved",
          );
        }
        try {
          const result = await p.boundedSpawn(
            [FLYCTL, ...argv],
            { FLY_API_TOKEN: p.flyToken() },
            "",
            DEPLOY_DEADLINE_MS,
          );
          report(`deploy_timed_out: ${result.timedOut}`);
          report(`deploy_group_survived: ${result.groupSurvived}`);
          report(`deploy_group_empty: ${result.groupEmpty}`);
          // A DEADLINE IS AN AMBIGUITY, NOT A FAILURE. The group was terminated
          // and proved gone, so the world has stopped changing - but what it
          // changed before that is unknown, which is the recovery's job. A
          // leader that exited while its group lived is the same answer: its
          // exit code says what IT thought, not what its children were doing.
          if (result.code === null) return { exitCode: null, threw: true };
          return { exitCode: result.code, threw: false };
        } catch {
          // A child that died, a socket that timed out and a call that never
          // returned are the same situation as a non-zero exit: the world may
          // have changed and this process does not know how. The text is
          // dropped here rather than travelling as an exception, and the flag
          // is what the coordinator treats as ambiguity.
          return { exitCode: null, threw: true };
        }
      },

      secretNamesPresent: async () => {
        const answer = await requiredNamesPresent({
          flyToken: p.flyToken(),
          spawn: boundedAsSpawn("secret_names", LIGHT_DEADLINE_MS),
          app: APP,
        });
        // NAME PRESENCE ONLY - it says nothing about which value is staged or
        // live, which is why the probe is what accepts a deployment. An
        // unreadable listing already answers `present: false` (secrets.ts, and
        // `secrets.test.ts` holds it), so there is nothing to add here.
        return answer.present;
      },

      machineReplaced: async () => {
        if (beforeDeploy === null) return false;
        const after = await readMachines();
        report(`machines_after_deploy: ${after.count}`);
        return (
          isSingleStarted(after) &&
          isSingleStarted(beforeDeploy) &&
          after.generation !== beforeDeploy.generation
        );
      },

      singleStartedMachine: async () => {
        const now = await readMachines();
        report(`machines_now: ${now.count}`);
        report(`single_started_machine: ${isSingleStarted(now)}`);
        return isSingleStarted(now);
      },
    },

    /**
     * The probe's WHOLE transcript, typed, recomputed and - if the deployment
     * is merely still coming up - waited on.
     *
     * IT USED TO BE A SUBSTRING SEARCH for `accepted: true` plus exit 0, which
     * trusted the child's own one-line verdict: a probe printing that line and
     * nothing else passed, and so did one whose statuses contradicted it.
     * `probe-transcript.ts` now requires every field exactly once, correctly
     * typed, and recomputes acceptance from the readings - so the reported
     * verdict has to agree with the fields it was supposedly drawn from.
     *
     * AND THERE ARE THREE ANSWERS, NOT TWO. A machine fly has just replaced is
     * healthy and not yet ticking, and the probe refuses until the first pass
     * completes. That is a deployment coming up, so it is waited on under one
     * ABSOLUTE deadline and a hard attempt cap; every other refusal is failure
     * on the first reading, with no retry to hide it.
     *
     * The child's bytes never reach this function: it hands them to the parser
     * and gets back typed fields and fixed labels.
     */
    probe: async () => {
      /**
       * ELAPSED AS A SUM OF FORWARD STEPS, so no clock can extend the budget.
       *
       * The real primitive is monotonic and this does not rely on it. A
       * BACKWARD step contributes nothing and the next reading is measured from
       * where the clock actually is, so a correction costs the wait no time and
       * buys it none either: the total is the forward movement, counted once.
       *
       * Remembering only the HIGHEST reading is not enough, and the difference
       * is what a test caught. A clock corrected DOWN by two minutes stays two
       * minutes low, so a high-water mark freezes until the clock climbs back
       * over it - which hands the wait those two minutes a second time. The
       * accumulator has nothing to climb back over.
       *
       * WHAT IT COSTS, stated exactly: a backward step loses the one measured
       * interval it lands in, because how much real time passed across a
       * correction is not knowable from either side of it. So a correction can
       * make the wait run at most ONE interval longer, once per correction -
       * never the SIZE of the correction, which is what the naive subtraction
       * and the high-water mark both hand over.
       *
       * A spurious FORWARD jump shortens the wait instead, which is the safe
       * direction: it ends early and rolls back.
       */
      let previous = p.now();
      let elapsed = 0;
      const remaining = (): number => {
        const reading = p.now();
        if (reading > previous) elapsed += reading - previous;
        previous = reading;
        return READINESS_DEADLINE_MS - elapsed;
      };
      report(`probe_readiness_budget_ms: ${READINESS_DEADLINE_MS}`);
      report(`probe_attempt_cap: ${READINESS_ATTEMPT_CAP}`);
      for (let attempt = 1; ; attempt++) {
        const step = planReadinessAttempt({
          attempt,
          remainingMs: remaining(),
        });
        if (step.action === "stop") {
          report(`probe_attempts: ${attempt - 1}`);
          report(`probe_wait_ended: ${step.reason}`);
          return false;
        }
        let result;
        try {
          // ONE CHILD AT A TIME, awaited to the bounded primitive's own
          // group-empty proof: a wait that started a second probe while the
          // first was unaccounted for would be the unbounded-spawn hazard the
          // rest of this file exists to remove.
          result = await p.boundedSpawn(
            [p.interpreter, PROBE_SCRIPT],
            {},
            "",
            step.deadlineMs,
          );
        } catch {
          report(`probe_attempts: ${attempt}`);
          report("probe_child_ran: false");
          return false;
        }
        const outcome = classifyProbeRun(result);
        report(`probe_child_exit: ${result.code ?? UNCLEAN_EXIT}`);
        report(`probe_verdict: ${outcome.verdict}`);
        for (const defect of outcome.defects) {
          report(`probe_defect: ${defect}`);
        }
        if (outcome.verdict !== "readiness_pending") {
          report(`probe_attempts: ${attempt}`);
          return outcome.verdict === "accepted";
        }
        const gap = planReadinessGap(remaining());
        if (gap === null) {
          report(`probe_attempts: ${attempt}`);
          report("probe_wait_ended: expired");
          return false;
        }
        await p.sleep(gap);
      }
    },

    report,
  };
}

/** The real primitives, plus the one teardown a pool-holding process needs. */
export function realPrimitives(): {
  primitives: Primitives;
  close: () => Promise<void>;
} {
  const pools = new Map<string, pg.Pool>();
  const poolFor = (dsn: string): pg.Pool => {
    const existing = pools.get(dsn);
    if (existing) return existing;
    const pool = new pg.Pool({
      connectionString: dsn,
      connectionTimeoutMillis: 30_000,
      max: 2,
    });
    pool.on("error", () => {});
    pools.set(dsn, pool);
    return pool;
  };

  let token: string | null = null;

  return {
    primitives: {
      git: async (args) => {
        const child = Bun.spawn(["git", ...args], {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(child.stdout).text();
        // git's stderr is not read back into anything this program prints.
        return { code: await child.exited, stdout };
      },
      boundedSpawn: realBoundedSpawn,
      flyToken: () => (token ??= readSecretFile(FLY_TOKEN_FILE)),
      resolveTarget: provenProductionTarget,
      liveBranchId: realLiveBranchId,
      sql: async (dsn, statement, args) =>
        (await poolFor(dsn).query(statement, args)).rows as Record<
          string,
          unknown
        >[],
      contextRules: () => realContextRules(),
      cwd: () => process.cwd(),
      sleep: (ms) => Bun.sleep(ms),
      // MONOTONIC, not wall clock. `performance.now` counts from process start
      // and cannot step backwards, which `Date.now` can. The readiness wait
      // measures a DURATION, so a clock that only ever moves forward is the
      // right one - and the wall time of day is not something this program has
      // any use for.
      now: () => Math.round(performance.now()),
      interpreter: process.execPath,
    },
    close: async () => {
      for (const pool of pools.values()) await pool.end().catch(() => {});
      pools.clear();
    },
  };
}

/** The reconnaissance mode's exit code: zero only for the shape `--execute`
 * requires. Exported so the verdict is a tested function rather than a line
 * inside `main`. */
export function machineStateExitCode(reading: MachineReading): number {
  return isSingleStarted(reading) ? 0 : 1;
}

/**
 * What the process says about an outcome.
 *
 * ONLY `moved` IS ZERO. A rollback is a successful recovery and still a failed
 * move, so a caller that only looks at the exit code - a shell, a runbook step,
 * a future automation - has to see it as a failure or it will carry on to the
 * next step with the deployment still on the owner string.
 */
export function exitCodeFor(outcome: Outcome): number {
  switch (outcome) {
    case "moved":
      return 0;
    case "refused_precondition":
      return 2;
    case "rolled_back":
      return 3;
    case "escalate":
      return 4;
  }
}

function printPlan(): void {
  for (const step of FORWARD_STEPS) console.log(`forward_step: ${step}`);
  for (const argument of DEPLOY_ARGV) console.log(`  deploy_argv: ${argument}`);
  const phases: Phase[] = [
    "clean",
    "credential_set",
    "credential_live",
    "contradictory",
  ];
  for (const phase of phases) {
    for (const step of recoveryFor(phase)) {
      console.log(`recovery_step[${phase}]: ${step}`);
    }
  }
  console.log(`backend_samples: ${BACKEND_SAMPLES}`);
  console.log(`backend_sample_gap_ms: ${BACKEND_SAMPLE_GAP_MS}`);
  console.log(`samples_during_cap: ${SAMPLES_DURING_CAP}`);
  console.log(`deploy_deadline_ms: ${DEPLOY_DEADLINE_MS}`);
  console.log(`deploy_kill_grace_ms: ${KILL_GRACE_MS}`);
  console.log(`light_command_deadline_ms: ${LIGHT_DEADLINE_MS}`);
  console.log(`probe_readiness_budget_ms: ${READINESS_DEADLINE_MS}`);
  console.log(`probe_readiness_gap_ms: ${READINESS_GAP_MS}`);
  console.log(`probe_attempt_cap: ${READINESS_ATTEMPT_CAP}`);
  console.log("probe_readiness_budget_is_a_policy_not_a_measurement: true");
  console.log("every_child_runs_in_its_own_process_group: true");
  console.log("a_timeout_terminates_the_group_and_proves_it_empty: true");
  // The claim is the GROUP, and it is stated as such: a process that starts a
  // new session is outside it, and the assumption that flyctl and the probe do
  // not is what the guarantee rests on.
  console.log("group_emptiness_assumes_no_child_starts_a_new_session: true");
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";

  if (mode === "--plan") {
    printPlan();
    return;
  }

  const { primitives, close } = realPrimitives();
  try {
    if (mode === "--source-state") {
      // The half of the preflight that contacts nothing: would the image this
      // tree builds be reconstructible from HEAD? Worth its own mode because it
      // is the check that refuses while a slice's own work is uncommitted.
      const seams = realSeams(primitives, (line) => console.log(line));
      const sha = await seams.source.committedSha();
      const clean = await seams.source.treeIsClean();
      console.log(`source_commit_readable: ${sha !== null}`);
      if (sha !== null) console.log(`source_commit: ${sha}`);
      console.log(`runtime_tree_clean: ${clean}`);
      process.exitCode = sha !== null && clean ? 0 : 1;
      return;
    }

    if (mode === "--machine-state") {
      // The one read the deploy's evidence depends on, on its own, so the field
      // names fly actually carries are established before a run needs them.
      const result = await primitives.boundedSpawn(
        [FLYCTL, "machines", "list", "-a", APP, "--json"],
        { FLY_API_TOKEN: primitives.flyToken() },
        "",
        LIGHT_DEADLINE_MS,
      );
      console.log(`flyctl_exit: ${result.code ?? UNCLEAN_EXIT}`);
      console.log(`timed_out: ${result.timedOut}`);
      console.log(`group_empty: ${result.groupEmpty}`);
      const reading =
        result.code === 0 ? readMachineListing(result.stdout) : UNREADABLE;
      console.log(`machine_listing_readable: ${reading.readable}`);
      console.log(`machines: ${reading.count}`);
      console.log(`all_started: ${reading.allStarted}`);
      console.log(`single_started_machine: ${isSingleStarted(reading)}`);
      // THE SAME PREDICATE --execute ENFORCES. A reconnaissance command that
      // exits zero on one STOPPED machine tells an operator the shape is fine
      // and then the run refuses, which is a contradiction the operator has to
      // resolve by reading code (reviewer finding, 2026-08-12).
      process.exitCode = machineStateExitCode(reading);
      return;
    }

    if (mode !== "--execute") {
      console.log(
        "refusing: name --plan, --source-state, --machine-state or --execute",
      );
      process.exitCode = 2;
      return;
    }

    // The token is proved readable before anything is written, so a missing
    // file refuses instead of stranding a staged secret.
    let tokenReadable = true;
    try {
      primitives.flyToken();
    } catch {
      tokenReadable = false;
    }
    console.log(`fly_token_readable: ${tokenReadable}`);
    if (!tokenReadable) {
      process.exitCode = 2;
      return;
    }

    const outcome = await moveProvisioner(
      realSeams(primitives, (line) => console.log(line)),
    );
    console.log(`outcome: ${outcome}`);
    process.exitCode = exitCodeFor(outcome);
  } catch {
    // Nothing derived from an unexpected failure is printed: the text could
    // come from a driver or a child. Diagnosis is the read-only modes above.
    console.log("unexpected_failure: true");
    process.exitCode = 5;
  } finally {
    await close();
  }
}

if (import.meta.main) {
  await main();
}
