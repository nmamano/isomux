// One case at a time, across every process on the local engine, for a suite
// that creates a cluster-wide role under a FIXED name: deploy/vps-support.test.ts
// runs role.sql, which creates hostedsupport_read, so two processes running it
// at once would share that role. A suite's own `serial` queue cannot see
// another process.
//
// The governance suites do not take it: each case governs runtime roles and
// an owner of its own (case-owner.ts). They held it until 2026-10-19, and it
// ran their two files one case at a time: 91 s and 88 s together against 25 s
// and 59 s alone.
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
    // The connection user can carry a governed statement_timeout or
    // lock_timeout: governance cases wrote them onto it before 2026-10-19.
    // Either would cancel a wait; the waiting case's own test timeout bounds
    // it instead.
    await client.query("set statement_timeout = 0");
    await client.query("set lock_timeout = 0");
    await client.query("select pg_advisory_lock($1)", [key]);
    return await fn();
  } finally {
    // Unlock before end(): the server frees a session lock only when its
    // backend exits, which can land after end() resolves.
    await client.query("select pg_advisory_unlock_all()").catch(() => {});
    await client.end().catch(() => {});
  }
}
