// Which Neon endpoint the WEB app may connect to, and what bounds it proves.
//
//   bun control-plane/deploy/endpoint-posture.ts
//
// The provisioner is one always-on machine, so "direct endpoint, pool of a few"
// is a complete answer for it. A Vercel deployment is not one machine: the
// platform decides how many instances exist, each one holds its own pool, and
// the product of those two numbers is what a managed Postgres actually sees.
// WEB_POOL caps the per-instance factor and says nothing about the other one.
//
// So this program answers three questions, and the third is the one that
// decides:
//
//   1. Does the DIRECT endpoint apply both governed bounds? (D1 measured yes,
//      through `options`. It is re-measured here rather than inherited, because
//      the posture argument is only as good as its newest reading.)
//   2. Does the POOLED endpoint apply them? D1 measured that a pooled
//      connection is ACCEPTED and reported neither bound - but it measured that
//      with the bounds travelling as pool startup FIELDS, which is the channel
//      the store abandoned. Whether the pooled endpoint honours them in
//      `options` is a different question and has never been asked. It is asked
//      here, with the store's own open path, because a pooled endpoint that
//      proves its bounds is the only thing that bounds the aggregate.
//   3. What each endpoint's connection ceiling is, so the choice can be stated
//      as a number rather than as a preference.
//
// EVERY LINE THIS PRINTS IS A BOOLEAN, A SMALL INTEGER, OR A POSTGRES SETTING
// VALUE MATCHED AGAINST A FIXED SHAPE. No host, no role, no database name, no
// branch id, no DSN, no driver message - on any path, error paths included. A
// setting value that does not match the shape prints as `unexpected` rather
// than as itself: the engine's answer is data from a machine, and this
// transcript is not a place for it to write freely.

import {
  PRODUCTION_BRANCH,
  liveBranchId,
  targetFor,
} from "../exercises/neon-api.ts";
import { Store } from "../store.ts";

/** The branch the deployment will be pointed at. A constant, not a flag: this
 * program exists to decide one deployment's posture, and a branch taken from a
 * command line is a way to prove a bound about a database nobody is using. */
const BRANCH = PRODUCTION_BRANCH;

/** What the store asks for, and what the read-back therefore expects. */
const EXPECTED = {
  statement_timeout: "30s",
  idle_in_transaction_session_timeout: "30s",
} as const;

/** A Postgres interval setting as the engine renders it. Anything else is not
 * printed. */
const SETTING_SHAPE = /^[0-9]+(us|ms|s|min|h|d)?$/;

/**
 * The pooled host for a direct one.
 *
 * Neon's convention: the endpoint id gains a `-pooler` label and nothing else
 * moves. This is a DERIVATION rather than an API record, which is exactly why
 * nothing here may act on it until `liveBranchId` has proved that the derived
 * host answers for the branch we asked about - the same gate `targetFor` puts
 * on its own fallback.
 */
export function pooledHostFor(host: string): string | null {
  const dot = host.indexOf(".");
  if (dot <= 0) return null;
  const id = host.slice(0, dot);
  if (id.endsWith("-pooler")) return null;
  return `${id}-pooler${host.slice(dot)}`;
}

export function pooledVariantOf(dsn: string): string | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    // Node's URL error carries the offending string, and that string is the
    // whole DSN. Nothing is quoted here for the same reason neon-api.ts quotes
    // nothing.
    return null;
  }
  const pooled = pooledHostFor(url.hostname);
  if (!pooled) return null;
  url.hostname = pooled;
  return url.toString();
}

type Failure = "none" | "bounds_refused" | "connect_or_open_failed";

export interface Reading {
  opens: boolean;
  /** True only when `Store.open` RETURNED, which is the evidence: it reads both
   * bounds back from the engine and refuses otherwise. */
  boundsGoverned: boolean;
  failure: Failure;
  /** What the engine says it applied, read through a bare pool so a refusal to
   * open still produces evidence about WHY. Shape-checked before printing. */
  reported: Record<keyof typeof EXPECTED, string>;
  maxConnections: number | null;
  branchProved: boolean;
}

/** A setting value, or `unexpected`. Never the raw answer. */
function shaped(value: string | null): string {
  if (value === null) return "unreadable";
  return SETTING_SHAPE.test(value) ? value : "unexpected";
}

/**
 * Ask the engine what it applied, WITHOUT the store.
 *
 * The store refuses to hand back a handle when a bound is missing, so its
 * failure proves that something is wrong and not which of the two it was. This
 * bare read is the diagnostic half, and it is deliberately separate: it never
 * decides anything, it only explains a refusal the store already made.
 */
async function readSettings(dsn: string): Promise<{
  reported: Record<keyof typeof EXPECTED, string>;
  maxConnections: number | null;
}> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({
    connectionString: dsn,
    connectionTimeoutMillis: 30_000,
  });
  pool.on("error", () => {});
  const reported: Record<string, string> = {};
  let maxConnections: number | null = null;
  try {
    for (const name of Object.keys(EXPECTED)) {
      try {
        const answer = await pool.query<{ v: string | null }>(
          `select current_setting('${name}', true) as v`,
        );
        reported[name] = shaped(answer.rows[0]?.v ?? null);
      } catch {
        // Swallowed on purpose: a driver error carries the host and the role.
        reported[name] = "unreadable";
      }
    }
    try {
      const answer = await pool.query<{ v: string }>(
        "select current_setting('max_connections') as v",
      );
      const parsed = Number(answer.rows[0]?.v);
      maxConnections = Number.isFinite(parsed) ? parsed : null;
    } catch {
      maxConnections = null;
    }
  } finally {
    await pool.end().catch(() => {});
  }
  return { reported, maxConnections };
}

/**
 * Open the store the way the deployed app opens it, and classify a refusal.
 *
 * The classification is by SHAPE of our own sentence, not by the driver's:
 * `assertBoundsInEffect` throws a message this build writes, and everything
 * else is one class - because the difference between a DNS failure and a
 * certificate failure is exactly the sort of detail that carries a hostname.
 */
export async function measure(dsn: string, branchId: string): Promise<Reading> {
  const settings = await readSettings(dsn);
  const branchProved = (await liveBranchId(dsn)) === branchId;

  let opens = false;
  let failure: Failure = "none";
  try {
    const store = await Store.open(dsn);
    opens = true;
    await store.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    failure = message.includes("did not apply")
      ? "bounds_refused"
      : "connect_or_open_failed";
  }
  return {
    opens,
    boundsGoverned: opens,
    failure,
    reported: settings.reported,
    maxConnections: settings.maxConnections,
    branchProved,
  };
}

function report(label: string, reading: Reading): void {
  console.log(`${label}_opens: ${reading.opens}`);
  console.log(`${label}_bounds_governed: ${reading.boundsGoverned}`);
  console.log(`${label}_failure: ${reading.failure}`);
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const seen = reading.reported[name as keyof typeof EXPECTED];
    console.log(`  ${label}_${name}: ${seen} (asked for ${expected})`);
  }
  console.log(`${label}_branch_proved: ${reading.branchProved}`);
  console.log(
    `${label}_max_connections: ${reading.maxConnections ?? "unreadable"}`,
  );
}

async function main(): Promise<void> {
  console.log(`branch: ${BRANCH}`);
  const target = await targetFor(BRANCH);
  console.log(`direct_host_from_api: ${target.hostFromApi}`);

  const direct = await measure(target.dsn, target.branch.id);
  report("direct", direct);

  const pooledDsn = pooledVariantOf(target.dsn);
  console.log(`pooled_host_derived: ${pooledDsn !== null}`);
  if (pooledDsn === null) {
    console.log("pooled_eligible: false");
    process.exitCode = 1;
    return;
  }
  const pooled = await measure(pooledDsn, target.branch.id);
  report("pooled", pooled);

  // A pooled endpoint is eligible ONLY if it proved both bounds AND proved it
  // answers for the branch we asked about. Either one alone is a coincidence
  // somebody could deploy on.
  const pooledEligible = pooled.boundsGoverned && pooled.branchProved;
  console.log(`pooled_eligible: ${pooledEligible}`);
  console.log(
    `direct_eligible: ${direct.boundsGoverned && direct.branchProved}`,
  );
  process.exitCode = direct.boundsGoverned || pooledEligible ? 0 : 1;
}

if (import.meta.main) {
  await main();
}
