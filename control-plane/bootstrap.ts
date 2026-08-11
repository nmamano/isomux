// Bring an empty database to schema-ready, and say so in booleans.
//
// The procedure is `Store.open` and nothing else: it runs SCHEMA, checks the
// catalog, creates the late indexes and seeds the audit sequence. What this
// module adds is the EVIDENCE, produced by the same command that did the work
// rather than by a query somebody runs afterwards and reports by hand.
//
// Two booleans, and each one answers a different question:
//
//   schema-ready    every table the schema names is present in the catalog.
//   zero-user-data  every one of those tables holds zero rows.
//
// The second is CONTENTS evidence and is deliberately not offered as identity
// evidence: an empty database proves nothing about WHICH database it is. That
// proof belongs to the caller - `exercises/neon.ts bootstrap` makes it from the
// Neon API and the engine's own branch id before this runs.
//
// It does NOT go through cli.ts's `openStore`, which also imports the legacy
// intent journal from `~/.isomux-control-plane/intents`: a bootstrap that
// imported an operator box's local intent files would put rows a customer
// database has no business holding into the branch it is preparing.

import { Store } from "./store.ts";

/**
 * Every table SCHEMA creates. The list is the check: a table missing from the
 * catalog is a schema that did not come up, whatever the open reported.
 *
 * These are literals from this file, never input, which is why they can be
 * interpolated into a count query without a quoting helper.
 */
export const EXPECTED_TABLES = [
  "accounts",
  "attention_reasons",
  "audit_events",
  "create_intents",
  "instance_liveness",
  "instances",
  "name_reservations",
  "operations",
  "provider_assets",
  "schema_meta",
  "sequences",
  "stripe_events",
  "subscriptions",
] as const;

/**
 * The tables a bootstrap EXPECTS to have rows, because the open writes them.
 *
 * `sequences` carries the audit seed and `schema_meta` the schema's own
 * bookkeeping. Neither is user data, and counting them as such would make
 * zero-user-data false on every correct bootstrap - which is the quietest way
 * to make a boolean stop meaning anything.
 */
const SEEDED = new Set(["sequences", "schema_meta"]);

export type BootstrapResult = {
  schemaReady: boolean;
  zeroUserData: boolean;
  missing: string[];
  counts: [string, number][];
};

export async function bootstrapDatabase(dsn: string): Promise<BootstrapResult> {
  const store = await Store.open(dsn);
  try {
    const present = new Set(
      (
        await store.sqlAll<{ tablename: string }>(
          "select tablename from pg_tables where schemaname = current_schema()",
        )
      ).map((r) => r.tablename),
    );
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    const counts: [string, number][] = [];
    for (const table of EXPECTED_TABLES) {
      if (!present.has(table)) continue;
      const row = await store.sqlGet<{ c: number }>(
        `select count(*)::int as c from ${table}`,
      );
      counts.push([table, row?.c ?? 0]);
    }
    return {
      schemaReady: missing.length === 0,
      zeroUserData: counts.every(([t, c]) => c === 0 || SEEDED.has(t)),
      missing,
      counts,
    };
  } finally {
    await store.close();
  }
}

/** The transcript half. Booleans first, then the evidence behind them. */
export function reportBootstrap(result: BootstrapResult): void {
  console.log(`schema-ready: ${result.schemaReady}`);
  console.log(`zero-user-data: ${result.zeroUserData}`);
  if (result.missing.length > 0) {
    console.log(`missing tables: ${result.missing.join(" ")}`);
  }
  for (const [table, count] of result.counts) {
    console.log(`  ${table}: ${count} rows`);
  }
}
