// Where a completed sign-in RETURNS TO, asserted against the source.
//
// This exists because of a defect that every automated transcript passed
// through without noticing. On 2026-08-11 the first real Google sign-in on
// production bound its account, raised no error, logged no warning, and left
// the user looking at a page offering to sign them in - three times. Nothing
// was broken in the deployment: `signIn("google")` carried no `callbackUrl`, so
// Auth.js returned the visitor to the page the flow began on, `/signin`, which
// was a client component rendered from the prerender cache and could not know a
// session existed. The dev provider beside it had always passed `"/"`.
//
// WHY THE ASSERTIONS READ SOURCE. There is no DOM or component harness in this
// repository - no testing-library, no jsdom, no happy-dom - and adding provider
// topology to test one literal would be more churn than the fix. So these are
// source-boundary assertions, in the same spirit as `web-boundary.test.ts`, and
// their limit is worth stating: they prove the WIRING is present, not that a
// browser followed it. The browser half is Nil's click-through, recorded in the
// slice report.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const WEB = path.join(import.meta.dir, "web");
const SIGNIN_PAGE = path.join(WEB, "app", "signin", "page.tsx");
const SIGNIN_FORM = path.join(WEB, "app", "signin", "signin-form.tsx");
const HOME_PAGE = path.join(WEB, "app", "page.tsx");

const read = (file: string): string => fs.readFileSync(file, "utf8");

/** Every `signIn("provider", ...)` call in the file, with its options text. */
function signInCalls(source: string): { provider: string; options: string }[] {
  const out: { provider: string; options: string }[] = [];
  const call = /signIn\(\s*"([a-z]+)"\s*(,\s*\{([^}]*)\})?\s*\)/g;
  for (const hit of source.matchAll(call)) {
    out.push({ provider: hit[1], options: hit[3] ?? "" });
  }
  return out;
}

describe("both providers name where a sign-in returns to", () => {
  test('EVERY signIn CALL PASSES callbackUrl "/"', () => {
    // The regression itself: Google had no callbackUrl and dev did.
    const calls = signInCalls(read(SIGNIN_FORM));
    expect(calls.map((c) => c.provider).sort()).toEqual(["dev", "google"]);
    for (const { provider, options } of calls) {
      expect({
        provider,
        hasCallback: /callbackUrl:\s*"\/"/.test(options),
      }).toEqual({ provider, hasCallback: true });
    }
  });

  test("no signIn call is left to the default return target", () => {
    // `signIn(p)` with no options returns to the CURRENT page, which for this
    // form is always /signin - the loop.
    for (const { provider, options } of signInCalls(read(SIGNIN_FORM))) {
      expect({ provider, empty: options.trim().length === 0 }).toEqual({
        provider,
        empty: false,
      });
    }
  });
});

describe("the sign-in page can see a session, and acts on it", () => {
  const page = read(SIGNIN_PAGE);

  test('IT IS A SERVER COMPONENT: no "use client" at the top', () => {
    // A client component cannot ask `auth()`, which is how the old page came to
    // offer sign-in to somebody already signed in.
    expect(page.trimStart().startsWith('"use client"')).toBe(false);
    expect(read(SIGNIN_FORM).trimStart().startsWith('"use client"')).toBe(true);
  });

  test("it asks auth() and redirects an authenticated visitor to /", () => {
    expect(page).toContain("await auth()");
    expect(page).toMatch(/redirect\(\s*"\/"\s*\)/);
    // Guarded on the ACCOUNT ID: a session with no account is not signed in for
    // anything this app does.
    expect(page).toMatch(/session\?\.accountId/);
  });

  test("it is dynamic, because session awareness cannot be prerendered", () => {
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
  });

  test("the unauthenticated render is unchanged: Google always, dev gated", () => {
    const form = read(SIGNIN_FORM);
    expect(form).toContain("Continue with Google");
    // The dev form stays behind the public flag, so a production build shows
    // Google alone.
    expect(form).toMatch(/devAuth &&/);
    expect(form).toMatch(/NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH === "1"/);
  });
});

describe("NO REDIRECT LOOP", () => {
  test("the home page does not send an authenticated visitor back to /signin", () => {
    // If `/` redirected to `/signin` for any signed-in state, the new guard
    // would bounce the visitor between the two forever.
    const home = read(HOME_PAGE);
    expect(home).not.toMatch(/redirect\(\s*["'`]\/signin/);
  });

  test("the sign-in page redirects to / and nowhere else", () => {
    const targets = [
      ...read(SIGNIN_PAGE).matchAll(/redirect\(\s*"([^"]*)"/g),
    ].map((m) => m[1]);
    expect(targets).toEqual(["/"]);
  });
});
