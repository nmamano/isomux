// What production must look like before the provisioner is given the means to
// act on a real box.
//
//   bun control-plane/deploy/preflight.ts
//
// The moment provider credentials reach the deployed machine, its tick loop can
// reboot, power off, power on and cancel a real provider asset. Every one of
// those handlers is driven by a ROW, so the question to answer first is not
// "do we intend to touch a box" but "is there anything in production that would
// make the loop touch one the moment it can". A row nobody remembered is
// exactly what an intention does not cover.
//
// TWO SAFETY PREDICATES, and they are the only two:
//   - no provider asset already carries a provider id. The one link this slice
//     means to create happens AFTER the credentials land, deliberately; a link
//     that already exists is one nobody planned.
//   - no unfinished operation of any provider-dependent kind. The kinds come
//     from `PROVIDER_DEPENDENT_KINDS` - the same constant the deployed process
//     asks its ticker about - so a handler added later cannot leave this check
//     behind.
// The account count and the open attention reasons are OBSERVATIONS. They are
// printed because an operator wants them, and they decide nothing: a predicate
// that grew to include them would refuse for reasons unrelated to whether a box
// can be touched.
//
// THE TARGET IS PROVED, NOT SUPPLIED. `exercises/neon.ts run` deliberately
// refuses to point a command at production, so the string is built here the way
// the deploy tooling builds it, and all three proofs must hold: the project's
// one default parentless branch, its endpoint host from the API, and the
// engine's own answer about which branch replied.
//
// WHAT IT PRINTS: fixed labels, counts and booleans. Never a connection string,
// never a branch id, never a row's contents. Error objects are discarded rather
// than reported, because a driver error can carry the host it failed to reach.

import { PROVIDER_DEPENDENT_KINDS } from "../run-roster.ts";
import { Store } from "../store.ts";
import { liveBranchId } from "../exercises/neon-api.ts";
import { provenProductionTarget } from "./secrets.ts";

/** Statuses that mean an operation can still act. `succeeded` and `failed` are
 * done; everything else is a row the loop may pick up. */
export const UNFINISHED_STATUSES = ["pending", "running", "ambiguous"] as const;

/** The exact set of readings this program takes. A count missing from a
 * reading is a reading that failed, not a zero. */
export const PREFLIGHT_COUNTS = [
  "instances",
  "assets_carrying_a_provider_id",
  "unfinished_provider_operations",
  "open_attention_reasons",
  "accounts",
] as const;

export type PreflightCounts = Record<(typeof PREFLIGHT_COUNTS)[number], number>;

export interface PreflightVerdict {
  /** Every expected count present, whole and not negative. */
  readable: boolean;
  /** Both safety predicates hold, on a readable reading. */
  safe: boolean;
  /** A fixed sentence. Never a count, never a row. */
  because: string;
}

/**
 * The decision, as a function of the reading alone.
 *
 * Separate from the reading so the refusals have direct tests: a predicate that
 * can only be exercised by standing up a production-shaped database is one
 * nobody checks the edges of.
 */
export function judgePreflight(
  counts: Partial<Record<string, number>>,
): PreflightVerdict {
  const whole = (n: unknown): boolean =>
    typeof n === "number" && Number.isInteger(n) && n >= 0;
  const readable = PREFLIGHT_COUNTS.every((key) => whole(counts[key]));
  if (!readable) {
    return {
      readable: false,
      safe: false,
      because: "a count was missing or could not be read",
    };
  }
  if (counts.assets_carrying_a_provider_id !== 0) {
    return {
      readable: true,
      safe: false,
      because: "production already carries a provider-linked asset",
    };
  }
  if (counts.unfinished_provider_operations !== 0) {
    return {
      readable: true,
      safe: false,
      because: "production carries an unfinished provider-mutating operation",
    };
  }
  return {
    readable: true,
    safe: true,
    because: "no provider-linked asset and no unfinished provider operation",
  };
}

/**
 * A list of our OWN constants as SQL literals.
 *
 * Interpolation, and safe for one reason that has to stay true: every value
 * comes from a constant in this repository, and each is checked against a shape
 * before it is quoted - a value that is not a plain lower-case identifier
 * throws rather than being embedded. Nothing a caller, a request or a database
 * row supplies reaches this function.
 */
function sqlList(values: readonly string[]): string {
  return values
    .map((value) => {
      if (!/^[a-z_]{1,40}$/.test(value)) {
        throw new Error("refusing to build SQL from an unexpected constant");
      }
      return `'${value}'`;
    })
    .join(", ");
}

/** The five counts, read through one store. -1 for a count that came back
 * empty, which `judgePreflight` refuses. */
export async function readCounts(store: Store): Promise<PreflightCounts> {
  const count = async (sql: string): Promise<number> =>
    (await store.sqlGet<{ n: number }>(sql))?.n ?? -1;
  return {
    instances: await count("select count(*)::int as n from instances"),
    assets_carrying_a_provider_id: await count(
      "select count(*)::int as n from provider_assets " +
        "where provider_id is not null",
    ),
    unfinished_provider_operations: await count(
      "select count(*)::int as n from operations " +
        `where kind in (${sqlList(PROVIDER_DEPENDENT_KINDS)}) ` +
        `and status in (${sqlList(UNFINISHED_STATUSES)})`,
    ),
    open_attention_reasons: await count(
      "select count(*)::int as n from attention_reasons where cleared_at is null",
    ),
    accounts: await count("select count(*)::int as n from accounts"),
  };
}

/**
 * Prove the target and take the reading.
 *
 * Exported because the activation runs the SAME check in-process before it
 * deploys: a precondition that is satisfied by a transcript from ten minutes
 * ago is a memory, and this protocol only accepts observations.
 */
export async function runPreflight(report: (line: string) => void): Promise<{
  verdict: PreflightVerdict;
  targetProved: boolean;
}> {
  // `provenProductionTarget` is the deploy tooling's own proof and it is
  // reused rather than restated: it requires the project to show EXACTLY ONE
  // default parentless branch, that it is named production, that the endpoint
  // host came from the API rather than a fallback, and that the branch it
  // resolved is that same one. Checking only "this branch is default and
  // parentless" would pass a project that somehow showed two (reviewer
  // finding, 2026-08-12). It throws on every failure, which is why the caller
  // catches.
  const target = await provenProductionTarget();
  report(`production_is_the_one_default: true`);
  report(`production_host_from_api: ${target.hostFromApi}`);
  // The engine's own answer, which no connection string can supply: a string
  // can name any host, and only the session knows which branch replied.
  const live = await liveBranchId(target.dsn);
  const engineConfirmed = live !== null && live === target.branch.id;
  report(`engine_confirmed_the_branch: ${engineConfirmed}`);
  if (!engineConfirmed) {
    return {
      targetProved: false,
      verdict: {
        readable: false,
        safe: false,
        because: "the engine did not confirm which branch answered",
      },
    };
  }

  // openRuntime, not open: a preflight that could write schema is a preflight
  // that can break the thing it is checking.
  const store = await Store.openRuntime(target.dsn);
  try {
    const counts = await readCounts(store);
    for (const key of PREFLIGHT_COUNTS) report(`${key}: ${counts[key]}`);
    for (const kind of PROVIDER_DEPENDENT_KINDS) report(`  kind: ${kind}`);
    const verdict = judgePreflight(counts);
    report(`every_count_readable: ${verdict.readable}`);
    report(`safe_to_give_provider_credentials: ${verdict.safe}`);
    report(`because: ${verdict.because}`);
    return { verdict, targetProved: true };
  } finally {
    await store.close();
  }
}

if (import.meta.main) {
  // EVERY API AND DRIVER ERROR IS CAUGHT HERE, and the object is discarded: a
  // Neon or pg failure can carry the host, the database name or a fragment of
  // a credential, and this program's output contract is fixed labels.
  try {
    const { verdict, targetProved } = await runPreflight((line) =>
      console.log(line),
    );
    process.exitCode = !targetProved ? 2 : verdict.safe ? 0 : 1;
  } catch {
    console.log("preflight_threw: true");
    console.log("safe_to_give_provider_credentials: false");
    process.exitCode = 2;
  }
}
