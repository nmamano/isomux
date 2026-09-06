// Where a completed sign-in RETURNS TO, and how a signed-in visitor gets off the
// sign-in page. Asserted against the source.
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
// WHAT MOVED ON 2026-09-05, and what did not. Both `/` and `/signin` are now
// prerendered static shells so that a shared cache can hold them (task
// 1cccebcf). A page that reads the session cookie can never be held by a shared
// cache, so the session question could not stay on the render: it moved to
// `/api/session` and to a client guard that runs after the shell paints.
//
// The PROPERTY is unchanged. A signed-in visitor who reaches `/signin` by any
// route still ends up on `/`, and every `signIn` call still names `/`. The
// prerendered page of 2026-08-11 was a loop because it had NO WAY OUT - it could
// not know a session existed, so the visitor stayed until they navigated away by
// hand. The way out is now automatic. What changed is which file owns which
// half, so every assertion below names the file that actually owns the behaviour
// and the chain from the guard to the route is asserted link by link rather than
// assumed to be connected.
//
// WHY THE ASSERTIONS READ SOURCE. There is no DOM harness for effects in this
// repository - no testing-library, no jsdom, no happy-dom - and adding provider
// topology to test one literal would be more churn than the fix. So these are
// source-boundary assertions, in the same spirit as `web-boundary.test.ts`, and
// their limit is worth stating: they prove the WIRING is present, not that a
// browser followed it. The browser half is the production transcript in
// `web/e2e/production-server.e2e.ts`, which drives `/signin` to `/` with a real
// session cookie, and the shell's own first paint is asserted for real in
// `web/app/home-view.test.tsx`.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { en } from "./web/lib/i18n/en.ts";

const WEB = path.join(import.meta.dir, "web");
const SIGNIN_PAGE = path.join(WEB, "app", "signin", "page.tsx");
const SIGNIN_FORM = path.join(WEB, "app", "signin", "signin-form.tsx");
const SIGNIN_GUARD = path.join(WEB, "app", "signin", "signed-in-redirect.tsx");
const HOME_PAGE = path.join(WEB, "app", "page.tsx");
const HOME_VIEW = path.join(WEB, "app", "home-view.tsx");
const PROBE = path.join(WEB, "lib", "use-session.ts");
const SESSION_ROUTE = path.join(WEB, "app", "api", "session", "route.ts");

const read = (file: string): string => fs.readFileSync(file, "utf8");

/**
 * The file with its comments removed.
 *
 * These tests assert what the code DOES, and a prose sentence naming `auth()` in
 * a comment that explains why the file no longer calls it would otherwise fail
 * the very assertion it describes.
 */
const code = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every `signIn("provider", ...)` call in the file, with its options text. */
function signInCalls(source: string): { provider: string; options: string }[] {
  const out: { provider: string; options: string }[] = [];
  const call = /signIn\(\s*"([a-z]+)"\s*(,\s*\{([^}]*)\})?\s*\)/g;
  for (const hit of source.matchAll(call)) {
    out.push({ provider: hit[1], options: hit[3] ?? "" });
  }
  return out;
}

/** Every client-side navigation target in the file. */
function navigationTargets(source: string): string[] {
  return [...source.matchAll(/router\.(?:replace|push)\(\s*"([^"]*)"/g)].map(
    (hit) => hit[1],
  );
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

describe("the sign-in page is a prerendered shell", () => {
  test("it asks nothing about the session while it renders", () => {
    // Either call would make the page uncacheable again, which is the whole
    // thing this shell exists to avoid.
    const page = code(SIGNIN_PAGE);
    expect(page).not.toMatch(/\bauth\(/);
    expect(page).not.toMatch(/\bredirect\(/);
    expect(page).not.toMatch(/force-dynamic/);
  });

  test('IT DECLARES dynamic = "error", so a dynamic API fails the build', () => {
    // Not "force-static": that would make a re-added `cookies()` return empty
    // and quietly serve a stale shell instead of failing.
    expect(code(SIGNIN_PAGE)).toMatch(/export const dynamic = "error"/);
  });

  test("it mounts the guard beside the form", () => {
    const page = code(SIGNIN_PAGE);
    expect(page).toMatch(
      /import \{ SignedInRedirect \} from ".\/signed-in-redirect"/,
    );
    expect(page).toContain("<SignedInRedirect />");
    expect(page).toContain("<SignInForm />");
  });

  test("the page itself is not a client component", () => {
    // The shell stays a server component: only the two children it mounts ship
    // to the browser.
    expect(read(SIGNIN_PAGE).trimStart().startsWith('"use client"')).toBe(
      false,
    );
    expect(read(SIGNIN_FORM).trimStart().startsWith('"use client"')).toBe(true);
  });
});

describe("the guard reaches the session route, link by link", () => {
  test("the guard is a client component", () => {
    expect(read(SIGNIN_GUARD).trimStart().startsWith('"use client"')).toBe(
      true,
    );
  });

  test("the guard asks the shared probe", () => {
    const guard = code(SIGNIN_GUARD);
    expect(guard).toMatch(
      /import \{ useSessionProbe \} from "\.\.\/\.\.\/lib\/use-session"/,
    );
    expect(guard).toMatch(/useSessionProbe\(/);
    expect(guard).toMatch(/probe\.state === "signed-in"/);
  });

  test("THE PROBE FETCHES /api/session AND NEVER LETS IT BE CACHED", () => {
    // The browser's own cache is as wrong a place to keep one visitor's session
    // answer as a CDN is.
    const probe = code(PROBE);
    expect(probe).toContain('"/api/session"');
    expect(probe).toMatch(/cache:\s*"no-store"/);
  });

  test("a probe that could not reach the route is not a signed-out answer", () => {
    // Collapsing the two would strand a signed-in visitor in front of the
    // sign-in form for the life of the document - the 2026-08-11 shape.
    const probe = code(PROBE);
    expect(probe).toContain('state: "unavailable"');
    expect(probe).toMatch(/addEventListener\("visibilitychange"/);
  });

  test("the route is dynamic and answers no-store", () => {
    const route = code(SESSION_ROUTE);
    expect(route).toMatch(/export const dynamic = "force-dynamic"/);
    expect(route).toMatch(/"Cache-Control":\s*"no-store"/);
  });

  test("THE ROUTE TESTS THE ACCOUNT ID, not merely a session", () => {
    // A session that never bound to an account is not signed in for anything
    // this app does. The test moved off the page; it did not relax.
    const route = code(SESSION_ROUTE);
    expect(route).toMatch(/session\?\.accountId/);
    expect(route).toMatch(
      /if \(!accountId\) return answer\(\{ signedIn: false \}\)/,
    );
  });

  test("the signed-out answer costs no store work", () => {
    const route = code(SESSION_ROUTE);
    expect(route.indexOf("signedIn: false")).toBeGreaterThan(0);
    expect(route.indexOf("signedIn: false")).toBeLessThan(
      route.indexOf("await officesForAccount("),
    );
  });
});

describe("a signed-in visitor is moved to / and nowhere else", () => {
  test("the guard replaces rather than pushes", () => {
    // Back must not restore the page the visitor was just moved off.
    const guard = code(SIGNIN_GUARD);
    expect(guard).toMatch(/router\.replace\(/);
    expect(guard).not.toMatch(/router\.push\(/);
  });

  test("every navigation target in the guard is /", () => {
    expect(navigationTargets(code(SIGNIN_GUARD))).toEqual(["/"]);
  });

  test("the unauthenticated render is unchanged: Google always, dev gated", () => {
    const form = read(SIGNIN_FORM);
    // The button's WORDS moved to the catalog in S11. What this test protects is
    // that the button is always rendered and that its English did not change, so
    // it now asserts both halves rather than one literal.
    expect(form).toContain('t("signIn.google")');
    expect(en["signIn.google"]).toBe("Continue with Google");
    // The dev form stays behind the public flag, so a production build shows
    // Google alone.
    expect(form).toMatch(/devAuth &&/);
    expect(form).toMatch(/NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH === "1"/);
  });
});

describe("the landing page is a prerendered shell too", () => {
  test("the page asks nothing about the session while it renders", () => {
    const page = code(HOME_PAGE);
    expect(page).not.toMatch(/\bauth\(/);
    expect(page).not.toMatch(/force-dynamic/);
    expect(page).toMatch(/export const dynamic = "error"/);
  });

  test("its view is a client component that asks for the office list", () => {
    expect(read(HOME_VIEW).trimStart().startsWith('"use client"')).toBe(true);
    expect(code(HOME_VIEW)).toMatch(
      /useSessionProbe\(\{\s*offices:\s*true\s*\}\)/,
    );
  });

  test("SIGN-OUT NAMES ITS DESTINATION with the option this version declares", () => {
    // A server action cannot live in a client component, so the sign-out click
    // calls Auth.js from the browser. `redirectTo` is next-auth's declared
    // option here; `callbackUrl` is the deprecated spelling.
    const view = code(HOME_VIEW);
    expect(view).toMatch(/signOut\(\{\s*redirectTo:\s*"\/"\s*\}\)/);
    expect(view).not.toMatch(/signOut\([^)]*callbackUrl/);
  });
});

describe("NO REDIRECT LOOP", () => {
  test("nothing on the landing side sends an authenticated visitor to /signin", () => {
    // If `/` sent a signed-in visitor to `/signin` for any state, the guard
    // would bounce them between the two forever. The marketing shell's `Link`
    // to /signin is not that: a link is the visitor's choice, not a redirect.
    for (const file of [HOME_PAGE, HOME_VIEW]) {
      const source = code(file);
      expect(source).not.toMatch(/redirect\(\s*["'`]\/signin/);
      expect(navigationTargets(source)).toEqual([]);
    }
  });

  test("the sign-in page sends a visitor to / and nowhere else", () => {
    // Read from the guard, which is where the behaviour now lives.
    expect(navigationTargets(code(SIGNIN_GUARD))).toEqual(["/"]);
  });
});
