// Email sign-in end to end: the link a request mails is the only thing that
// signs in, it signs in once, and it reaches the account the address already
// has - a Google-made one included.
//
// Each configuration runs in a child process (web/auth.email-link.fixture.ts),
// because auth.ts settles its providers at import. The store is a real
// Postgres schema; Resend is the only stand-in.

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { bindGoogleSubject } from "./signup.ts";
import { accountByEmail } from "./stripe/billing-store.ts";
import { Store } from "./store.ts";
import {
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";
import { createSignInTokens } from "./web/lib/signin-link.server.ts";

const SECRET = "fixture-secret-0123456789abcdef0123456789";
const RESEND_KEY = "re_fixture_key_8d2e61";
const ORIGIN = "http://localhost:3999";
const WEB_DIR = path.join(import.meta.dir, "web");

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Outcome {
  status: number;
  accountId: string | null;
}
interface Run {
  providers: string[];
  linkStatus: number;
  resendCalls: { url: string; authorized: boolean }[];
  mailedLink: string | null;
  viaMailedLink: Outcome | null;
  replay: Outcome | null;
  addressOnly: Outcome;
  parentToken: Outcome;
}

/** A schema the web tier's runtime store will open: bootstrapped once, as a
 * deployment is. */
async function bootstrappedDsn(): Promise<string> {
  const dsn = await testDsn();
  await (await Store.open(dsn)).close();
  return dsn;
}

async function run(env: Record<string, string>): Promise<Run> {
  const child = Bun.spawn(
    ["bun", path.join(WEB_DIR, "auth.email-link.fixture.ts")],
    {
      cwd: WEB_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "production",
        AUTH_SECRET: SECRET,
        AUTH_URL: ORIGIN,
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
  return JSON.parse(line) as Run;
}

describe("email sign-in, configured", () => {
  test("the mailed link signs in once, into the Google-made account with that address", async () => {
    const dsn = await bootstrappedDsn();
    const store = await openTestStoreOn(dsn);
    // Google keeps the case the customer typed; the link request is lowercased.
    const google = await bindGoogleSubject(store, {
      subject: "sub-user",
      email: "User@Proton.Me",
      emailVerified: true,
    });
    const minted = createSignInTokens({ secret: SECRET }).create(
      "newcomer@example.com",
    );

    const result = await run({
      CONTROL_PLANE_DB: dsn,
      AUTH_RESEND_KEY: RESEND_KEY,
      FIXTURE_EMAIL: "user@proton.me",
      FIXTURE_TOKEN: minted,
    });

    expect(result.providers).toContain("email-link");
    expect(result.linkStatus).toBe(200);
    expect(result.resendCalls).toEqual([
      { url: "https://api.resend.com/emails", authorized: true },
    ]);
    expect(new URL(result.mailedLink ?? "about:blank").origin).toBe(ORIGIN);
    // The link from the mail signs in, as the account the address already had.
    expect(result.viaMailedLink?.accountId).toBe(google.id);
    // Once.
    expect(result.replay?.accountId).toBeNull();
    // An address with no token is not a credential, as it is for the dev
    // provider.
    expect(result.addressOnly.accountId).toBeNull();
    // A token for an address with no account makes one, with that address.
    const made = await accountByEmail(store, "newcomer@example.com");
    expect(made).not.toBeNull();
    expect(result.parentToken.accountId).toBe(made!.id);
    expect(made!.id).not.toBe(google.id);
  }, 60_000);
});

describe("email sign-in, not configured", () => {
  test("without the mail key there is no provider, no link and no sign-in", async () => {
    const dsn = await bootstrappedDsn();
    const minted = createSignInTokens({ secret: SECRET }).create(
      "someone@example.com",
    );
    const result = await run({
      CONTROL_PLANE_DB: dsn,
      FIXTURE_EMAIL: "someone@example.com",
      FIXTURE_TOKEN: minted,
    });
    expect(result.providers).not.toContain("email-link");
    expect(result.linkStatus).toBe(503);
    expect(result.resendCalls).toEqual([]);
    // A valid token is worth nothing while the provider is absent.
    expect(result.parentToken.accountId).toBeNull();
    const store = await openTestStoreOn(dsn);
    expect(await accountByEmail(store, "someone@example.com")).toBeNull();
  }, 60_000);
});
