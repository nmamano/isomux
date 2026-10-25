// Which form the signup page shows a signed-in account. A paid account goes
// home unless it is setting up another office, and the office page's link to
// set an expired office up again names that office (task 9ed7430a).

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "next-auth";
import * as authModule from "../../auth";
import * as languageModule from "../../lib/i18n/request.server";
import * as servicesModule from "../../lib/services.server";
import type { SignupPageState } from "../../lib/services.server";

let pageState: SignupPageState = { kind: "new" };

// Outside a Next request `auth()` and `next/headers` throw, and the services
// need a database: the session, the language and the page state are
// stand-ins. A module mock outlives this file in Bun's shared test process, so
// the real exports are copied out first and put back when this file is done.
const realAuth = { ...authModule };
const realLanguage = { ...languageModule };
const realServices = { ...servicesModule };
const session: Session = {
  accountId: "account-1",
  expires: new Date(Date.now() + 3_600_000).toISOString(),
};
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
  plans: async () => [],
  signupPageState: async () => pageState,
}));
afterAll(async () => {
  await mock.module("../../auth", () => realAuth);
  await mock.module("../../lib/i18n/request.server", () => realLanguage);
  await mock.module("../../lib/services.server", () => realServices);
});

const { default: Signup } = await import("./page");

/** The page for these query parameters: where it redirected, or its HTML. */
async function visit(
  params: Record<string, string>,
): Promise<{ redirectedTo: string | null; html: string }> {
  try {
    const page = await Signup({ searchParams: Promise.resolve(params) });
    return { redirectedTo: null, html: renderToStaticMarkup(page) };
  } catch (err) {
    // next/navigation's redirect throws; its digest carries the target.
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT"))
      throw err;
    return { redirectedTo: digest.split(";")[2] ?? "", html: "" };
  }
}

beforeEach(() => {
  pageState = { kind: "new" };
});

test("a paid account goes home, unless a link names the office to set up", async () => {
  pageState = { kind: "paid" };
  expect(await visit({})).toEqual({ redirectedTo: "/", html: "" });

  const linked = await visit({ name: "acme" });
  expect(linked.redirectedTo).toBeNull();
  // The new-office form, with the name the link carried.
  expect(linked.html).toContain('name="signupIntent" value="new"');
  expect(linked.html).toContain('value="acme"');

  expect((await visit({ another: "1" })).redirectedTo).toBeNull();
});
