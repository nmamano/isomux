// Where the enterprise pages send a visitor they cannot serve: to the
// enterprise sign-in page, never to Hosted's. The buyer of Isomux for
// Enterprise must not land on a page about Hosted offices.

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { Session } from "next-auth";
import * as authModule from "../../auth";
import * as languageModule from "../../lib/i18n/request.server";
import * as servicesModule from "../../lib/services.server";

let session: Session | null = null;
let settings: { email: string; google: boolean } | null = null;

// Outside a Next request `auth()` and `next/headers` throw, and the services
// need a database. A module mock outlives this file in Bun's shared test
// process, so the real exports are copied out first and put back when this
// file is done.
const realAuth = { ...authModule };
const realLanguage = { ...languageModule };
const realServices = { ...servicesModule };
await mock.module("../../auth", () => ({
  ...realAuth,
  auth: async () => session,
}));
await mock.module("../../lib/i18n/request.server", () => ({
  ...realLanguage,
  languageForRequest: async () => "en",
}));
await mock.module("../../lib/services.server", () => ({
  ...realServices,
  enterpriseAccountFor: async () => ({ view: null, now: 0 }),
  accountSettings: async () => settings,
}));
afterAll(async () => {
  await mock.module("../../auth", () => realAuth);
  await mock.module("../../lib/i18n/request.server", () => realLanguage);
  await mock.module("../../lib/services.server", () => realServices);
});

const { default: Enterprise } = await import("./page");
const { default: Agreement } = await import("./agreement/page");

/** Where the page redirected, or null when it rendered. */
async function redirectOf(
  page: () => Promise<unknown>,
): Promise<string | null> {
  try {
    await page();
    return null;
  } catch (err) {
    // next/navigation's redirect throws; its digest carries the target.
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT"))
      throw err;
    return digest.split(";")[2] ?? "";
  }
}

beforeEach(() => {
  session = null;
  settings = { email: "it@acme.example", google: false };
});

test("signed out, both pages go to the enterprise sign-in page", async () => {
  expect(await redirectOf(Enterprise)).toBe("/enterprise/signin");
  expect(await redirectOf(Agreement)).toBe("/enterprise/signin");
});

test("a session whose account is gone leaves the enterprise pages, and does not loop", async () => {
  // The enterprise sign-in page sends a signed-in session back to /enterprise
  // (its guard asks /api/session, which answers from the session alone), so
  // sending this session there would bounce between the two pages forever.
  session = {
    accountId: "account-1",
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  };
  // The enabling condition: with the account there, the set-up form renders.
  expect(await redirectOf(Enterprise)).toBeNull();
  settings = null;
  const target = await redirectOf(Enterprise);
  expect(target).not.toBeNull();
  expect(target!.startsWith("/enterprise")).toBe(false);
});

test("the three enterprise pages carry one title of their own", async () => {
  const pages = await Promise.all([
    import("./page"),
    import("./agreement/page"),
    import("./signin/page"),
  ]);
  const titles = pages.map(
    (page) => (page as { metadata?: { title?: unknown } }).metadata?.title,
  );
  expect(typeof titles[0]).toBe("string");
  expect(String(titles[0]).length).toBeGreaterThan(0);
  expect(titles).toEqual([titles[0], titles[0], titles[0]]);
});
