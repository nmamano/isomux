// Which test schemas a sweep may drop.
//
// Two runs can share the engine and still not see each other's processes:
// each agent session can run in its own PID namespace. So a run's schemas are
// alive while the run holds its lease, a session advisory lock that the engine
// frees when the run's session ends, and a sweep drops a schema only when it
// can take that lease itself.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import pg from "pg";
import {
  PG_TEST_HOOK_TIMEOUT_MS,
  SCHEMA_LEASE_CLASS,
  TEST_DATABASE_URL,
  releaseTestStores,
  sweepAbandonedSchemas,
  testDsn,
} from "./pg.ts";

const LEASED = /^cp_test_r([0-9]+)_[a-z0-9]+_[0-9]+$/;

const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
admin.on("error", () => {});
const made: string[] = [];

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

afterAll(async () => {
  for (const schema of made.splice(0)) {
    await admin.query(`drop schema if exists "${schema}" cascade`);
  }
  await admin.end().catch(() => {});
}, PG_TEST_HOOK_TIMEOUT_MS);

function schemaOf(dsn: string): string {
  const options = new URL(dsn).searchParams.get("options") ?? "";
  return options.replace("-c search_path=", "");
}

/** The run id a schema name carries; fails the test for any other name. */
function runIdOf(schema: string): number {
  expect(schema).toMatch(LEASED);
  return Number(LEASED.exec(schema)?.[1]);
}

async function exists(schema: string): Promise<boolean> {
  const rows = await admin.query(
    "select 1 from pg_namespace where nspname = $1",
    [schema],
  );
  return rows.rowCount === 1;
}

/** Backends that hold this run id's lease, from pg_locks. */
async function leaseHolders(runId: number): Promise<number[]> {
  const rows = await admin.query<{ pid: number }>(
    "select pid from pg_locks where locktype = 'advisory' and granted " +
      "and classid::bigint = $1 and objid::bigint = $2 and objsubid = 2 " +
      "and database = (select oid from pg_database " +
      "where datname = current_database())",
    [SCHEMA_LEASE_CLASS, runId],
  );
  return rows.rows.map((r) => r.pid);
}

async function until(
  condition: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what} never held`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A run id nobody holds: a random one, checked against pg_locks. */
async function freeRunId(): Promise<number> {
  for (;;) {
    const id = 1 + Math.floor(Math.random() * 0x7ffffffe);
    if ((await leaseHolders(id)).length === 0) return id;
  }
}

describe("the schema sweep", () => {
  test("a run holds the lease of its schemas, and its own sweep keeps them", async () => {
    const schema = schemaOf(await testDsn());
    const runId = runIdOf(schema);
    const holders = await leaseHolders(runId);
    expect(holders).toHaveLength(1);

    const probe = await admin.connect();
    try {
      const taken = await probe.query<{ ok: boolean }>(
        "select pg_try_advisory_lock($1::int4, $2::int4) as ok",
        [SCHEMA_LEASE_CLASS, runId],
      );
      expect(taken.rows[0]?.ok).toBe(false);
    } finally {
      probe.release();
    }

    await sweepAbandonedSchemas();
    expect(await exists(schema)).toBe(true);
  });

  test("another run's schema stays while its lease is held, and goes once it is free", async () => {
    // The other run is a session of this test: its pid tells the sweep
    // nothing, as in another PID namespace.
    const runId = await freeRunId();
    const schema = `cp_test_r${runId}_other_0`;
    const holder = new pg.Client({ connectionString: TEST_DATABASE_URL });
    holder.on("error", () => {});
    await holder.connect();
    try {
      const taken = await holder.query<{ ok: boolean }>(
        "select pg_try_advisory_lock($1::int4, $2::int4) as ok",
        [SCHEMA_LEASE_CLASS, runId],
      );
      expect(taken.rows[0]?.ok).toBe(true);
      made.push(schema);
      await admin.query(`create schema "${schema}"`);

      await sweepAbandonedSchemas();
      expect(await exists(schema)).toBe(true);

      await holder.query("select pg_advisory_unlock($1::int4, $2::int4)", [
        SCHEMA_LEASE_CLASS,
        runId,
      ]);
      // Another test process's sweep can hold the free id while it drops
      // the schema, and this sweep then leaves it: sweep until it is gone.
      await until(async () => {
        await sweepAbandonedSchemas();
        return !(await exists(schema));
      }, "the free run's schema going");
      // The sweep gave the lease back after the drop.
      await until(
        async () => (await leaseHolders(runId)).length === 0,
        "the sweep giving the lease back",
      );
    } finally {
      await holder.end().catch(() => {});
    }
  }, 20_000);

  test("names it cannot read stay, and do not stop the sweep", async () => {
    // A schema from before leases, whose pid is dead: in another PID
    // namespace a dead pid and a live one look the same.
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    const legacy = `cp_test_${gone.pid}_legacy_0`;
    // A run id that is not an int4.
    const outOfRange = `cp_test_r${2 ** 31}_wide_0`;
    for (const schema of [legacy, outOfRange]) {
      made.push(schema);
      await admin.query(`create schema "${schema}"`);
    }

    await sweepAbandonedSchemas();
    expect(await exists(legacy)).toBe(true);
    expect(await exists(outOfRange)).toBe(true);
  });

  test("a run that is killed leaves its schemas to the next sweep", async () => {
    const child = Bun.spawn(
      ["bun", path.join(import.meta.dir, "pg-lease-child.ts")],
      { stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = child.stdout.getReader();
      let out = "";
      while (!out.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const schema = out.trim();
      // A child that died before printing leaves nothing to drop.
      if (schema) made.push(schema);
      const runId = runIdOf(schema);
      expect(await leaseHolders(runId)).toHaveLength(1);

      await sweepAbandonedSchemas();
      expect(await exists(schema)).toBe(true);

      child.kill("SIGKILL");
      await child.exited;
      await until(
        async () => (await leaseHolders(runId)).length === 0,
        "the killed run's session ending",
      );
      // As above, another process's sweep can hold the free id for a moment.
      await until(async () => {
        await sweepAbandonedSchemas();
        return !(await exists(schema));
      }, "the killed run's schema going");
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);
});

describe("the lease session", () => {
  test("a lost lease is taken again by the next acquisition, or the acquisition fails", async () => {
    const schema = schemaOf(await testDsn());
    await releaseTestStores();
    const runId = runIdOf(schema);
    const [backend] = await leaseHolders(runId);
    expect(backend).toBeNumber();

    const thief = new pg.Client({ connectionString: TEST_DATABASE_URL });
    thief.on("error", () => {});
    await thief.connect();
    try {
      // The lease session ends, and another session takes the run id before
      // this run acquires again: this run's schemas are no longer its own.
      // The thief waits: another test process's sweep holds a free run id
      // while it drops that run's schemas, then frees it.
      await admin.query("select pg_terminate_backend($1)", [backend]);
      await until(async () => {
        const taken = await thief.query<{ ok: boolean }>(
          "select pg_try_advisory_lock($1::int4, $2::int4) as ok",
          [SCHEMA_LEASE_CLASS, runId],
        );
        return taken.rows[0]?.ok === true;
      }, "the thief holding the lost lease");

      // The run sees the close on a later turn of its event loop; from then
      // on it refuses to hand out a schema.
      await until(async () => {
        const outcome = await testDsn().then(
          () => "resolved",
          () => "rejected",
        );
        await releaseTestStores();
        return outcome === "rejected";
      }, "an acquisition refusing without its lease");

      // Free again: an acquisition takes the same run id back. Another
      // process's sweep can take the free id first, and the acquisition
      // refuses until that sweep frees it.
      await thief.query("select pg_advisory_unlock($1::int4, $2::int4)", [
        SCHEMA_LEASE_CLASS,
        runId,
      ]);
      let again = "";
      await until(async () => {
        try {
          again = schemaOf(await testDsn());
          return true;
        } catch {
          await releaseTestStores();
          return false;
        }
      }, "an acquisition taking the lease back");
      expect(runIdOf(again)).toBe(runId);
      const holders = await leaseHolders(runId);
      expect(holders).toHaveLength(1);
      expect(holders[0]).not.toBe(backend);
    } finally {
      await thief.end().catch(() => {});
    }
  }, 20_000);
});
