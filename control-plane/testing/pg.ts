// The Postgres the control-plane suite runs against, and how one test's rows
// are kept out of the next test's way.
//
// The engine is a real local Postgres, not a fake and not an in-process
// substitute: the invariants this suite exists to hold - CAS losers, lease
// arbitration, partial-index refusals, one transaction's statements staying on
// one connection - are all engine behaviour, and a substitute would be
// asserting our own beliefs back at us.
//
// ISOLATION IS PER TEST, AND ITS UNIT IS A SCHEMA. Every acquisition gets a
// schema of its own, carried in the connection string as
// `?options=-c search_path=<schema>`, so `Store.open` keeps the shape it had
// when the argument was a file path: the connection string names the database,
// and two stores opened on the SAME string share state exactly as two stores on
// one file did.
//
// Schemas are RECYCLED rather than created per test, and that is a measured
// choice, not a preference. Creating one costs about 96ms here (17 objects,
// each with catalog writes and a commit that fsyncs); wiping a used one costs
// about 1ms, and reopening the store on it about 13ms. Across the suite's 353
// store openings that is the difference between roughly 76s and roughly 49s
// against a 31s baseline - the difference between blowing the runtime bar and
// staying inside it, with the database left as durable as it ships.

import pg from "pg";
import { LOCAL_POSTGRES_COMMAND } from "../config.ts";
import { Store, redactConnectionDetails, type Clock } from "../store.ts";
import { assertScratchTarget } from "./target.ts";

/**
 * The local Postgres the suite talks to.
 *
 * A constant rather than an environment variable, and on 5433 rather than the
 * default port: an already-installed Postgres on 5432 must never be what the
 * suite silently writes to. The credentials are throwaway and belong to a
 * container the README's one-liner starts.
 */
export const LOCAL_DATABASE_URL =
  "postgres://isomux:isomux@127.0.0.1:5433/control_plane_test";

/**
 * The database this run creates its schemas in.
 *
 * `CONTROL_PLANE_DB` is how a run is pointed at the managed engine instead -
 * the same variable the product reads, because a second name for "which
 * database" is a second thing to keep true. Nothing is trusted on the strength
 * of that variable: a remote target must PROVE it is the scratch branch
 * (`assertScratchTarget`) before a schema is created, and the proof is refused
 * by default rather than granted by default. CI sets nothing and is unaffected.
 */
export const TEST_DATABASE_URL =
  process.env.CONTROL_PLANE_DB ?? LOCAL_DATABASE_URL;

/**
 * NAMES NO DATABASE.
 *
 * This message used to interpolate the connection string, which was harmless
 * while that string was a throwaway local credential and is not harmless now
 * that the same variable can carry a managed engine's DSN: an unreachable
 * database would have printed the password into the test output and into CI
 * logs. Ruling 8 says a DSN is redacted on the error path, not repaired after
 * capture.
 */
const UNREACHABLE =
  `cannot reach the database named by CONTROL_PLANE_DB (or, with that unset, ` +
  `the local test container). The suite needs a real Postgres and does not ` +
  `skip without one. Start the local one with:\n\n  ` +
  `${LOCAL_POSTGRES_COMMAND}\n`;

/** Schema names this process may create, and the only shape it will quote. */
const NAME = /^cp_test_[0-9]+_[a-z0-9]+_[0-9]+$/;

const admin = new pg.Pool({
  connectionString: TEST_DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 5_000,
});
admin.on("error", () => {});

const nonce = Math.random().toString(36).slice(2, 8);
let counter = 0;

/** Schemas this process made and is not using right now. */
const free: string[] = [];
/** Everything acquired by the test currently running. */
const held: string[] = [];
/** Schemas that must be dropped rather than recycled. */
const disposable = new Set<string>();
const stores: Store[] = [];

let swept = false;
let fkChecked = false;

/**
 * One acquisition at a time.
 *
 * Two tests that both took the free list's head would wipe each other's rows
 * halfway through, which is precisely the interference this module exists to
 * prevent - so acquisition and its wipe are serialised on one promise chain
 * rather than merely being awaited by their callers.
 */
let gate: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = gate.then(fn, fn);
  gate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** One of OUR schema names, and nothing else, quoted. */
function quote(schema: string): string {
  if (!NAME.test(schema)) {
    throw new Error(`refusing to build SQL around the name ${schema}`);
  }
  return `"${schema}"`;
}

/**
 * Quote an identifier that came from the CATALOG.
 *
 * Schema names here are ours and match a known shape; table names are whatever
 * the database reports, which is live input even in test plumbing. Doubling
 * embedded quotes is the whole rule Postgres has for a quoted identifier, and a
 * name carrying anything a quoted identifier cannot hold is refused rather than
 * escaped past.
 */
export function quoteIdentifier(name: string): string {
  if (name.length === 0 || name.includes("\0")) {
    throw new Error(`refusing to quote the identifier ${JSON.stringify(name)}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

async function ask<T>(sql: string, args: unknown[] = []): Promise<T[]> {
  try {
    const result = await admin.query<T extends object ? T : never>(sql, args);
    return result.rows;
  } catch (err) {
    // No cause on either arm: a driver error carries the address, and on a
    // managed engine an authentication failure carries the role (measured
    // 2026-08-11). What is left is the code, which is what a reader needs.
    if ((err as { code?: string }).code === "ECONNREFUSED") {
      // The driver's error carries the address it could not reach, and on a
      // managed engine an authentication failure carries the role. Ruling 8:
      // redacted on the error path, not repaired after capture - so the cause
      // is dropped on purpose here.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(UNREACHABLE);
    }
    throw redactConnectionDetails(err, TEST_DATABASE_URL);
  }
}

/**
 * Drop the schemas a CRASHED earlier run left behind.
 *
 * The pid is in the name and these are local processes owned by this user, so
 * "is that process still alive" is answerable, and a run that died leaves
 * nothing for a human to clean up. A LIVE process's schemas are never touched -
 * two suites can share the container.
 */
async function sweepAbandoned(): Promise<void> {
  if (swept) return;
  swept = true;
  const rows = await ask<{ nspname: string }>(
    "select nspname from pg_namespace where nspname like 'cp\\_test\\_%'",
  );
  for (const { nspname } of rows) {
    const pid = Number(nspname.split("_")[2]);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // alive, and its schemas are its business
    } catch {
      // gone
    }
    if (NAME.test(nspname)) await ask(`drop schema ${quote(nspname)} cascade`);
  }
}

/**
 * Empty a recycled schema.
 *
 * The table list comes from the catalog rather than from a list in this file,
 * so a table added to the schema later cannot be forgotten here and leak rows
 * into the next test. DELETE rather than TRUNCATE because TRUNCATE rewrites
 * relation files and costs about 55ms against DELETE's 1ms on this schema - and
 * the ordering argument DELETE would otherwise need is checked below rather
 * than assumed.
 */
async function wipe(schema: string): Promise<void> {
  const tables = await ask<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = $1",
    [schema],
  );
  if (tables.length === 0) return;
  if (!fkChecked) {
    fkChecked = true;
    const fks = await ask<{ conname: string }>(
      "select conname from pg_constraint where contype = 'f' " +
        "and connamespace = $1::regnamespace",
      [schema],
    );
    if (fks.length > 0) {
      throw new Error(
        `the schema now has foreign keys (${fks
          .map((f) => f.conname)
          .join(", ")}), so deleting table by table can fail on ordering. ` +
          `Switch this wipe to one TRUNCATE over the whole list.`,
      );
    }
  }
  await ask(
    tables
      .map(
        (t) => `delete from ${quote(schema)}.${quoteIdentifier(t.tablename)};`,
      )
      .join("\n"),
  );
}

/**
 * The base DSN with this schema's search_path added.
 *
 * Through the URL rather than by concatenating `?options=`: a managed engine's
 * DSN already carries `?sslmode=...`, and a second `?` produces a string that
 * is not a URL at all. Existing parameters are preserved, and the store adds
 * its own governed options on top of whatever is here.
 */
function dsnFor(schema: string): string {
  let url: URL;
  try {
    url = new URL(TEST_DATABASE_URL);
  } catch {
    // Node's own URL error carries the offending string on an `input`
    // property, which a stringified error can print. Same class as the two
    // above, found by auditing this file after the reviewer found seedRawSchema.
    throw new Error(
      "CONTROL_PLANE_DB is not a URL, so no test schema can be addressed",
    );
  }
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

/**
 * The target proof, run once per process and before the first schema exists.
 *
 * Fail closed: a rejection is remembered and re-thrown, so a second acquisition
 * cannot quietly retry its way past a refusal.
 */
let proven: Promise<void> | null = null;
function proveTarget(): Promise<void> {
  proven ??= assertScratchTarget(TEST_DATABASE_URL, LOCAL_DATABASE_URL);
  return proven;
}

async function acquire(fresh: boolean): Promise<string> {
  return serialise(async () => {
    await proveTarget();
    await sweepAbandoned();
    const recycled = fresh ? undefined : free.pop();
    const schema = recycled ?? `cp_test_${process.pid}_${nonce}_${counter++}`;
    if (recycled === undefined) {
      await ask(`create schema ${quote(schema)}`);
    } else {
      await wipe(schema);
    }
    held.push(schema);
    if (fresh) disposable.add(schema);
    return schema;
  });
}

/**
 * A connection string for one test's own schema.
 *
 * Pass it to `Store.open` as many times as the test needs a separate store on
 * the same state - which is how the races that need two stores on one database
 * are written.
 */
export async function testDsn(): Promise<string> {
  return dsnFor(await acquire(false));
}

/**
 * A connection string for a schema NOTHING has used, dropped rather than
 * recycled.
 *
 * For the tests that build a deliberately wrong schema, and for any check whose
 * subject is the schema creation itself - a recycled schema already carries
 * every index, so a mutation that removes one from `SCHEMA` would be masked by
 * the one still standing.
 */
export async function freshDsn(): Promise<string> {
  return dsnFor(await acquire(true));
}

/** Open a store on its own schema, closed for you when the test ends. */
export async function openTestStore(now?: Clock): Promise<Store> {
  return openTestStoreOn(await testDsn(), now);
}

/** Open a store on a schema you already have. Same teardown. */
export async function openTestStoreOn(
  dsn: string,
  now?: Clock,
): Promise<Store> {
  let store: Store;
  try {
    store = await Store.open(dsn, now);
  } catch (err) {
    if ((err as { code?: string }).code === "ECONNREFUSED") {
      // eslint-disable-next-line preserve-caught-error
      throw new Error(UNREACHABLE);
    }
    throw err;
  }
  stores.push(store);
  return store;
}

/** Run SQL the Store cannot: the deliberately-wrong schemas the open check
 * exists to refuse. Test-only, and never a route product code could take. */
export async function seedRawSchema(dsn: string, sql: string): Promise<void> {
  let schema: string | undefined;
  try {
    schema = new URL(dsn).searchParams
      .get("options")
      ?.replace("-c search_path=", "");
  } catch {
    // Node's URL error carries the offending string on an `input` property,
    // which a stringified error prints. Same class as the message below.
    throw new Error(
      "the connection string passed to seedRawSchema is not a URL",
    );
  }
  // A fixed sentence: this used to interpolate the whole DSN, password
  // included, which is the same defect UNREACHABLE carried. Which connection
  // string was passed is knowable from the caller; the value is not something
  // an error message may hold.
  if (!schema) {
    throw new Error(
      "the connection string carries no `options=-c search_path=`, so this " +
        "test-only helper cannot tell which schema to seed",
    );
  }
  // `set local` inside a transaction: a bare `set` would follow this connection
  // back into the pool and silently re-point the next caller's unqualified
  // names.
  await ask(
    `begin; set local search_path = ${quote(schema)}; ${sql}; commit;`.replace(
      ";;",
      ";",
    ),
  );
}

/**
 * Close every store this test opened and give its schemas back.
 *
 * A schema returns to the free list only here, after the last store on it is
 * closed: recycling one while a pool still points at it would hand a live
 * connection to the next test's rows.
 */
export async function releaseTestStores(): Promise<void> {
  for (const store of stores.splice(0)) await store.close();
  for (const schema of held.splice(0)) {
    if (disposable.delete(schema)) {
      await ask(`drop schema ${quote(schema)} cascade`);
      continue;
    }
    free.push(schema);
  }
}

// Every test file calls `releaseTestStores()` from its own afterEach, rather
// than this module registering one hook for everybody. A hook here would be
// registered by whichever file imported this module FIRST and by no other: an
// ES module body runs once per process, and `bun test` shares one process
// across the whole suite. The one-line call in each file is the version that
// is actually true.
