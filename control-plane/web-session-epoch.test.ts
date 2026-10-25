// A session ends when its account's session epoch moves on (task 4fe8a83c).
//
// An email change that applied, or a Google sign-in removed, moves the epoch
// (account-email.test.ts owns that). This file owns what Auth.js then does with
// a cookie: a session issued at an older epoch is no session and its cookie is
// cleared, a browser cannot revive one through the public session update, and
// only the server's keepSession re-issues the cookie of the browser that made
// the change.
//
// Each run is a child process (web/auth.session-epoch.fixture.ts), because
// auth.ts settles its providers at import and the fixture replaces
// next/headers. The store is a real Postgres schema.

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ensureAccount } from "./stripe/billing-store.ts";
import { Store } from "./store.ts";
import {
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";
import { createSignInTokens } from "./web/lib/signin-link.server.ts";

const SECRET = "fixture-secret-epoch-0123456789abcdef0123";
const RESEND_KEY = "re_fixture_key_5e0c19";
const ORIGIN = "http://localhost:3998";
const WEB_DIR = path.join(import.meta.dir, "web");
const EMAIL = "moved@example.com";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

type CookieFate = "reissued" | "cleared" | "untouched";
interface Read {
  accountId: string | null;
  cookie: CookieFate;
}
interface Kept {
  threw: boolean;
  cookie: CookieFate;
  after: string | null;
}
interface Run {
  current: Read;
  stale: Read;
  unmarkedMoved: Read;
  unmarkedFresh: Read;
  gone: Read;
  noAccount: Read;
  clientUpdateCurrent: Read;
  clientUpdateStale: Read;
  clientUpdateStaleNoData: Read;
  keepStale: Kept;
  keepGone: Kept;
  signedIn: string | null;
}

async function run(env: Record<string, string>): Promise<unknown> {
  const child = Bun.spawn(
    ["bun", path.join(WEB_DIR, "auth.session-epoch.fixture.ts")],
    {
      cwd: WEB_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "production",
        AUTH_SECRET: SECRET,
        AUTH_URL: ORIGIN,
        AUTH_RESEND_KEY: RESEND_KEY,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  if (code !== 0 || !line.startsWith("{")) {
    throw new Error(`fixture exited ${code}:\n${stdout}\n${stderr}`);
  }
  return JSON.parse(line);
}

const SESSION = (accountId: string): Read => ({
  accountId,
  cookie: "reissued",
});
const ENDED: Read = { accountId: null, cookie: "cleared" };

describe("a session issued before its account's epoch moved", () => {
  test("is no session and loses its cookie; only the server's keepSession re-issues one", async () => {
    const dsn = await testDsn();
    await (await Store.open(dsn)).close();
    const store = await openTestStoreOn(dsn);
    const moved = await store.tx(() =>
      ensureAccount(store, { id: "acct-moved", email: EMAIL }),
    );
    const fresh = await store.tx(() =>
      ensureAccount(store, { id: "acct-fresh", email: "fresh@example.com" }),
    );
    // Two changes ago, as two applied email changes leave it.
    await store.sqlRun("update accounts set session_epoch = 2 where id = $1", [
      moved.id,
    ]);

    const result = (await run({
      CONTROL_PLANE_DB: dsn,
      FIXTURE_ACCOUNT: moved.id,
      FIXTURE_FRESH: fresh.id,
      FIXTURE_SIGNIN_TOKEN: createSignInTokens({ secret: SECRET }).create(
        EMAIL,
      ),
    })) as Run;

    expect(result).toEqual({
      // The enabling condition: a cookie at the current epoch is a session,
      // re-issued as every read re-issues it.
      current: SESSION(moved.id),
      stale: ENDED,
      // A cookie from before this change has no epoch and counts as the
      // first: it outlives no change, and the deploy itself ends nothing.
      unmarkedMoved: ENDED,
      unmarkedFresh: SESSION(fresh.id),
      gone: ENDED,
      noAccount: ENDED,
      // Any browser can post an update with any data. With a current cookie
      // the update is an ordinary read (so CSRF passed and the path was
      // reached), and with a stale one it revives nothing.
      clientUpdateCurrent: SESSION(moved.id),
      clientUpdateStale: ENDED,
      clientUpdateStaleNoData: ENDED,
      // The route that made the change keeps its own browser signed in.
      keepStale: { threw: false, cookie: "reissued", after: moved.id },
      // But not into an account that no longer exists.
      keepGone: {
        threw: expect.any(Boolean),
        cookie: expect.stringMatching(/^(cleared|untouched)$/),
        after: null,
      },
      // A sign-in after the changes starts at the current epoch.
      signedIn: moved.id,
    });
  }, 60_000);

  test("without the store a session cannot be checked, and is no session", async () => {
    // Fail closed: the cost is a sign-in again after a database outage.
    const result = await run({
      FIXTURE_MODE: "no-store",
      FIXTURE_ACCOUNT: "acct-moved",
    });
    expect(result).toEqual({ current: ENDED });
  }, 60_000);
});
