// One role-governance case at a time, across every process on the local engine.
//
// The governance suites give each case its own runtime role names, but the
// OWNER is not theirs to rename: it is the connection's own user, shared by
// every process, and governing writes the bounds onto it cluster-wide. Measured
// 2026-10-03 with two processes running these suites at once: one case's
// `reset all` on the owner made the other's re-apply refuse, and concurrent
// `alter role ... set` on the owner failed with SQLSTATE XX000 (tuple
// concurrently updated). A suite's own `serial` queue cannot see another
// process, so each case also holds this lock.
//
// A SESSION ADVISORY LOCK, on the fixed admin database. Advisory locks are per
// database, so every process takes it on the same one; it is held by a
// connection of its own for exactly one case; and the engine releases it when
// that session ends, so a process that dies mid-case does not wedge the next.

import pg from "pg";
import { LOCAL_DATABASE_URL } from "./pg.ts";

/** Every process must contend on the same key. */
export const ROLE_SUITE_LOCK_KEY = 0x69736f6d;

export async function withRoleSuiteLock<T>(
  fn: () => Promise<T>,
  key: number = ROLE_SUITE_LOCK_KEY,
): Promise<T> {
  const client = new pg.Client({ connectionString: LOCAL_DATABASE_URL });
  client.on("error", () => {});
  await client.connect();
  try {
    // The owner carries a governed statement_timeout, and a case may set a
    // lock_timeout on it while another process connects. Either would cancel
    // a wait; the waiting case's own test timeout bounds it instead.
    await client.query("set statement_timeout = 0");
    await client.query("set lock_timeout = 0");
    await client.query("select pg_advisory_lock($1)", [key]);
    return await fn();
  } finally {
    await client.end().catch(() => {});
  }
}
