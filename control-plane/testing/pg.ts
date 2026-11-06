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
 * `CONTROL_PLANE_DB` is the variable the product reads, so it is read here
 * too: a run whose environment names another database refuses
 * (`assertScratchTarget`) before a schema is created, rather than writing to
 * it or silently using the local one. CI sets nothing and is unaffected.
 */
export const TEST_DATABASE_URL =
  process.env.CONTROL_PLANE_DB ?? LOCAL_DATABASE_URL;

/**
 * Is this run pointed at the local throwaway container?
 *
 * Some properties can only be exercised on an engine we control the shape of.
 * Every other target refuses at the first schema (`assertScratchTarget`), so
 * this is true in any run that gets that far; the suites that need it still
 * say so.
 */
export const TARGET_IS_LOCAL = TEST_DATABASE_URL === LOCAL_DATABASE_URL;

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

/**
 * Schema names this process may create, and the only shape it will quote.
 * The number after the `r` is the run id of the run that made the schema.
 */
const NAME = /^cp_test_r([0-9]+)_[a-z0-9]+_[0-9]+$/;

/** The largest run id: a run id is the second int4 key of its lease. */
const MAX_RUN_ID = 0x7fffffff;

/** The advisory lock class (first int4 key) a run's lease is taken in. */
export const SCHEMA_LEASE_CLASS = 0x63707473;

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

/** This run's id, chosen with its first lease and kept for the whole run. */
let runId: number | null = null;
/** The session that holds this run's lease, or null once it has ended. */
let lease: pg.Client | null = null;
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

export async function inCleanupPool<T>(
  items: readonly T[],
  clean: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await clean(item);
      }
    }),
  );
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

/**
 * The error to throw for a driver error.
 *
 * No cause on either arm: a driver error carries the address, and on a
 * managed engine an authentication failure carries the role (measured
 * 2026-08-11). What is left is the code, which is what a reader needs.
 */
function driverError(err: unknown): Error {
  if ((err as { code?: string }).code === "ECONNREFUSED") {
    // Ruling 8: redacted on the error path, not repaired after capture - so
    // the cause is dropped on purpose here.
    return new Error(UNREACHABLE);
  }
  return redactConnectionDetails(err, TEST_DATABASE_URL);
}

async function ask<T>(sql: string, args: unknown[] = []): Promise<T[]> {
  try {
    const result = await admin.query<T extends object ? T : never>(sql, args);
    return result.rows;
  } catch (err) {
    throw driverError(err);
  }
}

/** Try to take (or probe) the lease of one run id on this session. */
async function tryLease(client: pg.ClientBase, id: number): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    "select pg_try_advisory_lock($1::int4, $2::int4) as ok",
    [SCHEMA_LEASE_CLASS, id],
  );
  return result.rows[0]?.ok === true;
}

/**
 * Hold this run's lease, and return the run id.
 *
 * The lease is a session advisory lock on a connection of its own, held for
 * the whole run: the engine frees it when that session ends, so a run that
 * crashes or is killed frees its lease, and the next sweep drops its schemas.
 *
 * A lease session that ended under a live run (a dropped socket, a terminated
 * backend) is taken again under the SAME run id, because the run's schemas
 * carry it. If another session holds that id now, this refuses: another
 * run's sweep may drop these schemas, and handing them out anyway would
 * fail open. The next acquisition tries again.
 */
async function holdLease(): Promise<number> {
  if (lease !== null && runId !== null) return runId;
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  client.on("error", () => {});
  client.on("end", () => {
    if (lease === client) lease = null;
  });
  try {
    await client.connect();
    // The connection user can carry governed timeouts (role-suite-lock.ts).
    // The lease session waits on nothing and stays idle for the whole run,
    // and an idle_session_timeout would end it and free the lease.
    await client.query(
      "set statement_timeout = 0; set lock_timeout = 0; " +
        "set idle_session_timeout = 0",
    );
  } catch (err) {
    await client.end().catch(() => {});
    throw driverError(err);
  }
  let taken: number | null = null;
  try {
    if (runId !== null) {
      if (await tryLease(client, runId)) taken = runId;
    } else {
      for (let attempt = 0; attempt < 10 && taken === null; attempt++) {
        const id = 1 + Math.floor(Math.random() * MAX_RUN_ID);
        if (await tryLease(client, id)) taken = id;
      }
    }
  } catch (err) {
    await client.end().catch(() => {});
    throw driverError(err);
  }
  if (taken === null) {
    await client.end().catch(() => {});
    throw new Error(
      runId === null
        ? "no free run id for this test run's schema lease after 10 tries"
        : `this test run lost the lease on its schemas (run id ${runId}) ` +
            `and another session holds it, so another run's sweep may drop ` +
            `them: refusing to hand out a schema`,
    );
  }
  const retaken = runId !== null;
  runId = taken;
  lease = client;
  if (retaken && free.length > 0) {
    // Without the lease, another run's sweep may have dropped some of them.
    // If the check fails, recycle none: a new schema is always safe.
    try {
      const alive = new Set(
        (
          await ask<{ nspname: string }>(
            "select nspname from pg_namespace where nspname = any($1)",
            [free],
          )
        ).map((r) => r.nspname),
      );
      free.splice(0, free.length, ...free.filter((s) => alive.has(s)));
    } catch {
      free.length = 0;
    }
  }
  return taken;
}

async function sweepAbandoned(): Promise<void> {
  if (swept) return;
  swept = true;
  await sweepAbandonedSchemas();
}

/**
 * Drop the schemas of runs that ended without dropping them (a crash, a kill).
 *
 * A run is alive while it holds its lease (`holdLease`). A pid cannot tell:
 * two runs on one engine can sit in different PID namespaces, where a live
 * pid of the other looks dead. So the sweep drops a run's schemas only while
 * it holds that run's lease itself, and a live run's schemas are never
 * touched - two suites can share the container.
 *
 * Names from before leases (`cp_test_<pid>_...`) stay: their liveness cannot
 * be read, and the local container is throwaway.
 */
export async function sweepAbandonedSchemas(): Promise<void> {
  const rows = await ask<{ nspname: string }>(
    "select nspname from pg_namespace where nspname like 'cp\\_test\\_r%'",
  );
  const byRun = new Map<number, string[]>();
  for (const { nspname } of rows) {
    const match = NAME.exec(nspname);
    if (!match) continue;
    const id = Number(match[1]);
    if (!(id >= 1 && id <= MAX_RUN_ID) || id === runId) continue;
    byRun.set(id, [...(byRun.get(id) ?? []), nspname]);
  }
  if (byRun.size === 0) return;
  // One session for every probe: a session lock taken through the pool stays
  // on whichever client ran it, and its unlock could run on another.
  let client: pg.PoolClient;
  try {
    client = await admin.connect();
  } catch (err) {
    throw driverError(err);
  }
  // Ending the session frees every lock it still holds.
  let end = false;
  try {
    for (const [id, schemas] of byRun) {
      if (!(await tryLease(client, id))) continue; // alive
      try {
        for (const schema of schemas) {
          await client.query(`drop schema if exists ${quote(schema)} cascade`);
        }
      } finally {
        await client
          .query("select pg_advisory_unlock($1::int4, $2::int4)", [
            SCHEMA_LEASE_CLASS,
            id,
          ])
          .catch(() => {
            end = true;
          });
      }
    }
  } catch (err) {
    end = true;
    throw driverError(err);
  } finally {
    client.release(end);
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
  // Tags this test's sessions in pg_stat_activity, for `inFlightReport`.
  url.searchParams.set("application_name", schema);
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
    const id = await holdLease();
    await sweepAbandoned();
    const recycled = fresh ? undefined : free.pop();
    const schema = recycled ?? `cp_test_r${id}_${nonce}_${counter++}`;
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

// 2026-08-12: Under full-suite load on this box, governance-apply's PostgreSQL
// afterAll reached Bun's 5 s default hook timeout at 5000.07 ms. That incident
// chose a 30 s budget for the hook.
// 2026-08-23: Under parallel CI, store-schema-check's afterAll reached the same
// default at 5007.86 ms while awaiting cluster-global role cleanup. This change
// generalises the existing 30 s decision to every PostgreSQL hook. Bun names an
// afterEach timeout for its test but reports afterAll as (unnamed), although
// both messages say beforeEach/afterEach. A hook can await several store closes,
// schema drops, or role drops in sequence, so their total time binds before one
// connection acquisition reaches connectionTimeoutMillis. Keep that acquisition
// timeout at 5 s so a stuck connection fails fast.
export const PG_TEST_HOOK_TIMEOUT_MS = 30_000;

// A hook that drops databases. DROP DATABASE waits for an immediate
// checkpoint, and that checkpoint fsyncs everything the run has written so
// far, so the wait depends on the other files running at the same time, not
// on this hook. It ran past 30 s on 2026-10-08 (task e7851de6); measured
// 2026-10-19 under full-suite load, the first drops waited 21-24 s against
// 3.3 s for all of them with the engine idle.
export const PG_DROP_DATABASE_HOOK_TIMEOUT_MS = 4 * PG_TEST_HOOK_TIMEOUT_MS;

interface InFlight {
  pid: number;
  state: string | null;
  wait: string | null;
  seconds: number | null;
  query: string | null;
  blockers: {
    pid: number;
    app: string | null;
    state: string | null;
    query: string | null;
  }[];
}

/**
 * What the engine says about this test's sessions that are not idle, or null
 * when there are none.
 *
 * For a test that timed out: the statement still running, what it waits on,
 * and the sessions that block it, which may belong to another test file. Never
 * throws: a report that cannot be read must not fail the teardown.
 */
async function inFlightReport(): Promise<string | null> {
  if (held.length === 0) return null;
  let rows: InFlight[];
  try {
    const client = await admin.connect();
    // A failed query leaves the transaction aborted: that client is destroyed,
    // never given back to the shared admin pool.
    let failed = false;
    try {
      await client.query("begin");
      await client.query("set local statement_timeout = '2s'");
      rows = (
        await client.query<InFlight>(
          "select a.pid, a.state, " +
            "a.wait_event_type || '/' || a.wait_event as wait, " +
            "round(extract(epoch from now() - a.query_start)::numeric, 1)::float8 as seconds, " +
            "left(a.query, 300) as query, " +
            "(select coalesce(json_agg(json_build_object('pid', b.pid, " +
            "'app', b.application_name, 'state', b.state, " +
            "'query', left(b.query, 300))), '[]') " +
            "from pg_stat_activity b " +
            "where b.pid = any(pg_blocking_pids(a.pid))) as blockers " +
            "from pg_stat_activity a " +
            "where a.application_name = any($1) and a.state <> 'idle' " +
            "and a.pid <> pg_backend_pid() order by a.pid",
          [held],
        )
      ).rows;
      await client.query("commit");
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      client.release(failed);
    }
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const lines = ["sessions of this test that were not idle at its teardown:"];
  for (const row of rows) {
    const wait = row.wait ? `, waiting on ${row.wait}` : "";
    lines.push(
      `  pid ${row.pid} (${row.state}${wait}, ${row.seconds} s): ${row.query}`,
    );
    for (const b of row.blockers) {
      lines.push(
        `    blocked by pid ${b.pid} (${b.app || "no application_name"}, ` +
          `${b.state}): ${b.query}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Close every store this test opened and give its schemas back.
 *
 * A schema returns to the free list only here, after the last store on it is
 * closed: recycling one while a pool still points at it would hand a live
 * connection to the next test's rows.
 */
export async function releaseTestStores(): Promise<void> {
  // Before the close: close() waits for a busy session, and a statement stuck
  // at a timeout is still visible only now.
  const report = await inFlightReport();
  if (report) console.error(report);
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
