// Every redirect the signup route answers lands on the storefront's configured
// origin. Behind the VPS proxy the request URL carries the container's own
// origin, so each request here does too: a Location built from the request URL
// would send the customer to localhost.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Session } from "next-auth";
import * as authModule from "../../../auth";
import * as languageModule from "../../../lib/i18n/request.server";
import * as servicesModule from "../../../lib/services.server";
import type {
  SignupPageState,
  SignupResult,
} from "../../../lib/services.server";

const ORIGIN = "https://storefront.example.com";
const CONTAINER = "http://localhost:3000";
process.env.AUTH_URL = ORIGIN;

let session: Session | null = null;
let pageState: SignupPageState = { kind: "new" };
let continued: SignupResult | { ok: false; officeName: string } = {
  ok: false,
  reason: "",
};
let signedUp: SignupResult = { ok: false, reason: "" };

// Outside a Next request `auth()` and `next/headers` throw, and the services
// need a database: the session, the language and the three business answers
// are stand-ins. The origin check is the real one.
//
// A module mock outlives this file in Bun's shared test process and patches
// the bindings other files already imported, so the real exports are copied
// out first and put back when this file is done.
const realAuth = { ...authModule };
const realLanguage = { ...languageModule };
const realServices = { ...servicesModule };
await mock.module("../../../auth", () => ({
  ...realAuth,
  auth: async () => session,
}));
await mock.module("../../../lib/i18n/request.server", () => ({
  ...realLanguage,
  languageForRequest: async () => "en",
}));
await mock.module("../../../lib/services.server", () => ({
  ...realServices,
  signupPageState: async () => pageState,
  continueSignup: async () => continued,
  signUpOffice: async () => signedUp,
}));
afterAll(async () => {
  await mock.module("../../../auth", () => realAuth);
  await mock.module("../../../lib/i18n/request.server", () => realLanguage);
  await mock.module("../../../lib/services.server", () => realServices);
});

const { POST } = await import("./route");

let address = 30;

function signupPost(fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request(`${CONTAINER}/api/signup`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-forwarded-for": `192.0.2.${address++}` },
    body: form,
  });
}

function location(response: Response): URL {
  expect(response.status).toBe(303);
  const value = response.headers.get("location") ?? "";
  expect(value).not.toBe("");
  return new URL(value);
}

const signedIn: Session = {
  accountId: "account-1",
  expires: new Date(Date.now() + 3_600_000).toISOString(),
};

beforeEach(() => {
  session = signedIn;
  pageState = { kind: "new" };
});

describe("POST /api/signup redirects to the configured origin", () => {
  test("not signed in: to sign-in", async () => {
    session = null;
    const target = location(await POST(signupPost({})));
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/signin");
  });

  test("continuing an office that already exists: to that office", async () => {
    pageState = { kind: "continue", officeName: "acme" };
    continued = { ok: false, officeName: "acme" };
    const target = location(
      await POST(signupPost({ signupIntent: "continue", officeName: "acme" })),
    );
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/office/acme");
  });

  test("a refused continue: back to the form with its reason", async () => {
    pageState = { kind: "continue", officeName: "acme" };
    continued = { ok: false, reason: "continue-refused" };
    const target = location(
      await POST(signupPost({ signupIntent: "continue", officeName: "acme" })),
    );
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/signup");
    expect(target.searchParams.get("error")).toBe("continue-refused");
  });

  test("a refused signup: back to the form with its reason and the name", async () => {
    signedUp = { ok: false, reason: "signup-refused" };
    const target = location(
      await POST(
        signupPost({
          officeName: "acme",
          plan: "standard",
          customerSshKey: "ssh-ed25519 AAAA",
        }),
      ),
    );
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/signup");
    expect(target.searchParams.get("error")).toBe("signup-refused");
    expect(target.searchParams.get("name")).toBe("acme");
  });
});
