// The cross-process lock the governance suites hold around each case.
//
// A key of this file's own, so a governance suite running in another process
// neither waits on these cases nor makes them flaky. The lock's behaviour does
// not depend on which key it is.

import { afterAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { LOCAL_DATABASE_URL, TARGET_IS_LOCAL } from "./pg.ts";
import { withRoleSuiteLock } from "./role-suite-lock.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;
const KEY = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);

const admin = new pg.Pool({ connectionString: LOCAL_DATABASE_URL, max: 2 });
admin.on("error", () => {});
afterAll(async () => {
  await admin.end().catch(() => {});
});

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Sessions the engine has parked waiting for the key, read from pg_locks. */
async function waiters(): Promise<number> {
  const rows = await admin.query<{ n: number }>(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' " +
      "and not granted and objid::bigint = $1 and database = " +
      "(select oid from pg_database where datname = current_database())",
    [KEY],
  );
  return rows.rows[0]?.n ?? -1;
}

suite("the role-suite lock", () => {
  test("a second holder waits in the engine until the first releases", async () => {
    const events: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withRoleSuiteLock(async () => {
      events.push("first in");
      await held;
      events.push("first out");
    }, KEY);
    await until(async () => events.includes("first in"));
    const second = withRoleSuiteLock(async () => {
      events.push("second in");
    }, KEY);
    await until(async () => (await waiters()) === 1);
    expect(events).toEqual(["first in"]);

    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first in", "first out", "second in"]);
    expect(await waiters()).toBe(0);
  }, 20_000);

  test("a case that rejects still releases it", async () => {
    const failure = new Error("the case failed");
    const seen = await withRoleSuiteLock(async () => {
      throw failure;
    }, KEY).then(
      () => null,
      (err: unknown) => err,
    );
    expect(seen).toBe(failure);
    const probe = await admin.connect();
    try {
      const taken = await probe.query<{ ok: boolean }>(
        "select pg_try_advisory_lock($1) as ok",
        [KEY],
      );
      expect(taken.rows[0]?.ok).toBe(true);
      await probe.query("select pg_advisory_unlock($1)", [KEY]);
    } finally {
      probe.release();
    }
  });
});
