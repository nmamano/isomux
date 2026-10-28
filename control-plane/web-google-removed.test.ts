// The web half of refusing a removed Google account (task f41fae71): the
// account page's removal and the Auth.js signIn callback key the mark with the
// same server secret, and the refusal sends the browser to the sign-in page
// with its marker instead of making an empty account. signup.ts's half is in
// account-email.test.ts.
//
// The callback is called directly (web/lib/google-signin.server.ts is what
// auth.ts hands Auth.js): a real Google callback would need Google's token
// endpoint. The facade's store is a real Postgres schema, put in its slot.

import { afterEach, describe, expect, test } from "bun:test";
import { changeAccountEmail } from "./signup.ts";
import type { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import {
  GOOGLE_REMOVED_MARKER,
  GOOGLE_REMOVED_SIGNIN_URL,
} from "./web/lib/google-removed-marker.ts";
import { googleSignIn } from "./web/lib/google-signin.server.ts";
import {
  identityForSignIn,
  removeGoogleSignInFor,
} from "./web/lib/services.server.ts";

const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");
const SECRET = "fixture-secret-google-removed-0123456789";
const GMAIL = "Customer.Name@Gmail.com";
const SUBJECT = "google-sub-customer";
const realSecret = process.env.AUTH_SECRET;

afterEach(async () => {
  delete (globalThis as { [STORE_SLOT]?: unknown })[STORE_SLOT];
  if (realSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = realSecret;
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

async function facadeStore(): Promise<Store> {
  const store = await openTestStore();
  (globalThis as { [STORE_SLOT]?: { opening?: Promise<Store> } })[STORE_SLOT] =
    { opening: Promise.resolve(store) };
  return store;
}

async function accountCount(store: Store): Promise<number> {
  const row = await store.sqlGet<{ n: string }>(
    "select count(*) as n from accounts",
  );
  return Number(row?.n);
}

/** The signIn callback for a Google sign-in, as Auth.js calls it. */
async function googleCallback(
  subject: string,
  email: string,
  emailVerified = true,
): Promise<{ result: boolean | string; accountId: string | undefined }> {
  const user: Parameters<typeof googleSignIn>[0]["user"] = { email };
  const result = await googleSignIn({
    account: { provider: "google", type: "oidc", providerAccountId: subject },
    user,
    profile: { sub: subject, email, email_verified: emailVerified },
  });
  return { result, accountId: user.id };
}

describe("a Google sign-in for a removed Google account", () => {
  test("goes back to the sign-in page with the marker, and makes no account", async () => {
    process.env.AUTH_SECRET = SECRET;
    const store = await facadeStore();
    const first = await googleCallback(SUBJECT, GMAIL);
    expect(first.result).toBe(true);
    const accountId = first.accountId!;
    expect(accountId).toBeString();
    await changeAccountEmail(store, {
      accountId,
      newEmail: "work@example.com",
    });
    // The account page's removal: the facade picks the key.
    expect(await removeGoogleSignInFor(accountId)).toBe(true);

    const accounts = await accountCount(store);
    const again = await googleCallback(SUBJECT, GMAIL);
    expect(again).toEqual({
      result: GOOGLE_REMOVED_SIGNIN_URL,
      accountId: undefined,
    });
    expect(
      new URL(GOOGLE_REMOVED_SIGNIN_URL, "http://localhost").searchParams.get(
        "error",
      ),
    ).toBe(GOOGLE_REMOVED_MARKER);
    expect(
      await identityForSignIn({
        provider: "google",
        subject: SUBJECT,
        email: GMAIL,
        emailVerified: true,
      }),
    ).toEqual({
      ok: false,
      reason: expect.any(String),
      code: "google-removed",
    });
    expect(await accountCount(store)).toBe(accounts);
  });

  test("every other refusal stays a plain refusal", async () => {
    process.env.AUTH_SECRET = SECRET;
    await facadeStore();
    // An address Google has not verified neither binds nor makes an account.
    expect(
      await googleCallback("google-sub-unverified", "x@example.com", false),
    ).toEqual({ result: false, accountId: undefined });
  });
});

describe("the server secret", () => {
  test("only the Google sign-in needs it", async () => {
    delete process.env.AUTH_SECRET;
    await facadeStore();
    expect(
      await identityForSignIn({
        provider: "email-link",
        email: "someone@example.com",
      }),
    ).toEqual({ ok: true, accountId: expect.any(String) });
    // The enabling condition: without it, the Google sign-in does not run.
    const googleRefused = await identityForSignIn({
      provider: "google",
      subject: SUBJECT,
      email: GMAIL,
      emailVerified: true,
    }).then(
      () => false,
      () => true,
    );
    expect(googleRefused).toBe(true);
    process.env.AUTH_SECRET = SECRET;
    expect(
      await identityForSignIn({
        provider: "google",
        subject: SUBJECT,
        email: GMAIL,
        emailVerified: true,
      }),
    ).toEqual({ ok: true, accountId: expect.any(String) });
  });
});
