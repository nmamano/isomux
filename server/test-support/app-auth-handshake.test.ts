// The app-host sign-in handshake against the REAL server (phase 3, slice 4).
//
// Three origins are in play and the whole slice exists because of the boundary
// between them: the office at `office.example` holds the session cookie, an app
// at `hello.office.example` cannot see it, and this is the round trip that gets
// the app host its own credential without the office's ever leaving the office.
//
// What this freezes:
//   - THE FULL FLOW, end to end, over real sockets: bounce -> mint -> redeem ->
//     authenticated placeholder, with the exact Location, the exact cookie
//     attributes and the two anti-leak headers asserted by equality.
//   - The callback URL carries the CODE AND NOTHING ELSE. The requested path
//     rides the server-side record (port-proxy-design.md), so a second value
//     never reaches a browser's history.
//   - Every way a code can be refused answers with ONE body: replayed, from
//     another app, minted against a session that has since signed out. An
//     anonymous caller cannot tell them apart.
//   - THE APP COOKIE IS NOT AN OFFICE CREDENTIAL and dies with the office
//     session behind it - the property that makes "sign out" mean something
//     once apps have their own origins.
//   - Only a document navigation is bounced. A POST, an XHR and a subresource
//     get a refusal instead of a 302 that would lose the method or fail as an
//     opaque CORS error.
//   - The mint endpoint is behind the office's ordinary wall: no session is the
//     normal login page, a bearer token is not a session, and an unknown label
//     is indistinguishable from a retired one.

import { describe, it, expect, afterEach } from "bun:test";
import {
  HTTPS_ORIGIN,
  NAVIGATION_HEADERS,
  NOT_FOUND,
  WS_AUTH_REQUIRED,
  WS_UNREACHABLE,
  OFFICE_HOST,
  RELAY_UNREACHABLE,
  WS_UPGRADE_HEADERS,
  anOfficeWithAnApp as bootOfficeWithAnApp,
  appHost,
  bounceLocation,
  codeFromMint,
  cookieValue,
  deleteApp,
  expectAuthRequired,
  expectBounce,
  expectPlaceholder,
  mint,
  raw,
  redeem,
  registerApp,
  signIn,
  withAppCookie,
  type RawResponse,
} from "./app-host-test-kit.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { createHash } from "crypto";
import { appRegistry } from "../app-registry.ts";
import {
  APP_COOKIE_NAME,
  APP_MINT_MAX_PER_WINDOW,
  APP_SESSION_TTL_MS,
  handleAppAuthRedeem,
  mintAppCode,
  startAppSession,
  validateAppSession,
} from "../app-auth.ts";

const SIGN_IN_FAILED_BODY =
  "sign-in link expired; open the app again from the office\n";
const MINT_LIMITED_BODY =
  "too many app sign-in attempts; wait a minute and try again\n";
const BAD_REQUEST_BODY = "bad request\n";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// The rig - booting the office, signing in, speaking raw HTTP to an app host -
// lives in app-host-test-kit.ts, shared with the relay tests (slice 5). This
// wrapper keeps the local afterEach in charge of whichever server is live.
function anOfficeWithAnApp(name = "hello") {
  return bootOfficeWithAnApp((srv) => {
    server = srv;
  }, name);
}

describe("app-host handshake: the whole round trip", () => {
  it("bounces, mints, redeems, and lands authenticated", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const host = appHost(label);

    // 1. A navigation with no app cookie is sent to the office, carrying the
    //    app's label and the path that was asked for.
    const bounce = await raw(srv.port, {
      host,
      path: "/dashboard?tab=1",
      headers: NAVIGATION_HEADERS,
    });
    expectBounce(bounce, { label, path: "/dashboard?tab=1" }, "first hop");
    // Nothing to clear: no cookie was presented.
    expect(bounce.setCookies).toEqual([]);

    // 2. The office mints. The callback carries the code AND NOTHING ELSE - the
    //    path stays server-side, which is the design doc's rule and one less
    //    value written into a browser's history.
    const location = new URL(bounce.headers["location"]);
    const minted = await mint(srv, `?${location.searchParams}`, {
      rawSessionId,
    });
    expect(minted.status).toBe(302);
    const callback = new URL(minted.headers.get("location")!);
    expect(callback.origin).toBe(`https://${host}`);
    expect(callback.pathname).toBe("/__isomux/auth");
    expect([...callback.searchParams.keys()]).toEqual(["code"]);
    expect(callback.searchParams.get("code")!.length).toBeGreaterThan(20);
    expect(minted.headers.get("referrer-policy")).toBe("no-referrer");
    expect(minted.headers.get("cache-control")).toBe("no-store");

    // 3. The app host redeems it, sets its own cookie, and sends the browser to
    //    the path from step 1.
    const code = callback.searchParams.get("code")!;
    const redeemed = await redeem(srv, label, code);
    expect({
      status: redeemed.status,
      location: redeemed.headers["location"],
      referrerPolicy: redeemed.headers["referrer-policy"],
      cacheControl: redeemed.headers["cache-control"],
    }).toEqual({
      status: 302,
      location: "/dashboard?tab=1",
      referrerPolicy: "no-referrer",
      cacheControl: "no-store",
    });
    const value = cookieValue(redeemed);
    expect(redeemed.setCookies).toEqual([
      `${APP_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; ` +
        `Max-Age=${APP_SESSION_TTL_MS / 1000}; Secure`,
    ]);

    // 4. With the cookie, the request is past the gate and into the relay -
    //    which, with no process bound to this app's port, finds nobody home.
    expectPlaceholder(
      await raw(srv.port, {
        host,
        path: "/dashboard?tab=1",
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
      }),
      RELAY_UNREACHABLE,
      "authenticated",
    );

    // 5. The code is spent. Replaying it fails, and fails the way everything
    //    else fails.
    const replay = await redeem(srv, label, code);
    expect(replay.status).toBe(400);
    expect(replay.body).toBe(SIGN_IN_FAILED_BODY);
    expect(replay.headers["cache-control"]).toBe("no-store");
    expect(replay.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("keeps the app cookie out of the office and off other apps", async () => {
    const { srv, label, rawSessionId, token } = await anOfficeWithAnApp();
    const other = await registerApp(srv, token, "other");
    const value = await signIn(srv, label, rawSessionId);

    // The office host does not accept it: an app credential authenticates one
    // app, never the office that vouched for it.
    const office = await raw(srv.port, {
      host: OFFICE_HOST,
      path: "/agents",
      headers: withAppCookie(value),
    });
    expect(office.status).toBe(401);

    // Nor does another app's host. A browser would not send it there at all
    // (host-only), so this is the server-side half of the binding rather than a
    // demonstration of browser scoping - it holds even for a hand-made request.
    expectBounce(
      await raw(srv.port, {
        host: appHost(other),
        path: "/",
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
      }),
      { label: other, path: "/" },
      "app cookie on a sibling app",
    );
  });

  it("dies when the office session signs out", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const value = await signIn(srv, label, rawSessionId);
    const host = appHost(label);
    // Working before.
    expectPlaceholder(
      await raw(srv.port, {
        host,
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
      }),
      RELAY_UNREACHABLE,
      "before sign-out",
    );

    const out = await srv.http("/auth/logout", {
      method: "POST",
      rawSessionId,
      redirect: "manual",
    });
    expect(out.status).toBe(302);

    // The app session is revalidated against the office session on every
    // request, so the app closes immediately - and the dead cookie is cleared
    // rather than left in the browser.
    const after = await raw(srv.port, {
      host,
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
    });
    expectBounce(after, { label, path: "/" }, "after sign-out");
    expect(after.setCookies).toEqual([
      `${APP_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
  });

  it("refuses a code minted against a session that has since signed out", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const minted = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    expect(minted.status).toBe(302);
    const code = codeFromMint(minted);
    await srv.http("/auth/logout", {
      method: "POST",
      rawSessionId,
      redirect: "manual",
    });
    const res = await redeem(srv, label, code);
    expect(res.status).toBe(400);
    expect(res.body).toBe(SIGN_IN_FAILED_BODY);
  });

  it("refuses a code presented at a different app's host", async () => {
    const { srv, label, rawSessionId, token } = await anOfficeWithAnApp();
    const other = await registerApp(srv, token, "other");
    const minted = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    const res = await redeem(srv, other, codeFromMint(minted));
    expect(res.status).toBe(400);
    expect(res.body).toBe(SIGN_IN_FAILED_BODY);
  });

  it("refuses a bogus code the same way it refuses a spent one", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const minted = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    const spent = await redeem(srv, label, codeFromMint(minted));
    expect(spent.status).toBe(302);
    const replayed = await redeem(srv, label, codeFromMint(minted));
    const bogus = await redeem(srv, label, "Zm9vYmFyYmF6");
    const empty = await raw(srv.port, {
      host: appHost(label),
      path: "/__isomux/auth",
      headers: NAVIGATION_HEADERS,
    });
    const oversized = await redeem(srv, label, "a".repeat(200));
    const duplicated = await raw(srv.port, {
      host: appHost(label),
      path: `/__isomux/auth?code=${codeFromMint(minted)}&code=x`,
      headers: NAVIGATION_HEADERS,
    });
    for (const [where, res] of [
      ["replayed", replayed],
      ["bogus", bogus],
      ["absent", empty],
      ["oversized", oversized],
      ["duplicated", duplicated],
    ] as const) {
      expect({ where, status: res.status, body: res.body }).toEqual({
        where,
        status: 400,
        body: SIGN_IN_FAILED_BODY,
      });
    }
    // Byte-identical, not merely equal in the fields above.
    expect(bogus.stable).toBe(replayed.stable);
  });

  it("stops being reachable at all when the app is deleted or renewed", async () => {
    const { srv, label, rawSessionId, token } = await anOfficeWithAnApp();
    const value = await signIn(srv, label, rawSessionId);
    const minted = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    const code = codeFromMint(minted);

    await deleteApp(srv, token, "hello");
    const host = appHost(label);
    // The label is retired: the arm refuses before the handshake is consulted,
    // so a live cookie and an unspent code are equally worthless.
    expectPlaceholder(
      await raw(srv.port, {
        host,
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
      }),
      NOT_FOUND,
      "cookie on a deleted app",
    );
    expectPlaceholder(await redeem(srv, label, code), NOT_FOUND, "code on it");

    // Re-registering keeps the wanted label, while server-held registration
    // identity makes the predecessor's credentials worthless.
    const successor = await registerApp(srv, token, "hello");
    expect(successor).toBe(label);
    expectBounce(
      await raw(srv.port, {
        host: appHost(successor),
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
      }),
      { label: successor, path: "/" },
      "predecessor cookie on the successor",
    );
  });
});

describe("app-host handshake: the generation binding", () => {
  // The host generation remains the compatibility identity for a public label.
  // Reuse is separated by registration generation; the mismatched host tests
  // below keep the older structural gate covered too.
  it("refuses a code whose generation is not the one live now", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const app = appRegistry.get("hello")!;
    const sessionHash = createHash("sha256").update(rawSessionId).digest("hex");
    const minted = mintAppCode({
      label,
      hostGen: app.hostGen,
      appHost: appHost(label),
      officeSessionHash: sessionHash,
      returnPath: "/",
    });
    if ("error" in minted) throw new Error(minted.error);
    const req = new Request(
      `https://${appHost(label)}/__isomux/auth?code=${minted.code}`,
      { method: "GET" },
    );
    const res = handleAppAuthRedeem(req, {
      host: appHost(label),
      app: { ...app, hostGen: app.hostGen + 1 },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(SIGN_IN_FAILED_BODY);
    expect(srv.port).toBeGreaterThan(0);
  });

  it("refuses an app session whose generation is not the one live now", async () => {
    const { label, rawSessionId } = await anOfficeWithAnApp();
    const app = appRegistry.get("hello")!;
    const sessionHash = createHash("sha256").update(rawSessionId).digest("hex");
    const started = startAppSession({
      label,
      hostGen: app.hostGen,
      officeSessionHash: sessionHash,
      absoluteExpiresAt: Date.now() + 60_000,
    });
    expect(started).not.toBeNull();
    // The positive case, which needs a REAL office session behind it: this is
    // the one place the whole validate path returns true.
    expect(
      validateAppSession(started!.token, {
        label,
        hostGen: app.hostGen,
      }),
    ).toBe(true);
    expect(
      validateAppSession(started!.token, {
        label,
        hostGen: app.hostGen + 1,
      }),
    ).toBe(false);
    expect(
      validateAppSession(started!.token, { label: "other", hostGen: 1 }),
    ).toBe(false);
  });

  it("refuses a code minted just before delete when the same hostname is reused", async () => {
    const { srv, label, rawSessionId, token } = await anOfficeWithAnApp();
    const before = await mint(srv, `?app=${label}&r=%2Fbefore`, {
      rawSessionId,
    });
    const code = codeFromMint(before);
    await deleteApp(srv, token, "hello");
    expect(await registerApp(srv, token, "hello")).toBe(label);
    const refused = await redeem(srv, label, code);
    expect(refused.status).toBe(400);
    expect(refused.body).toBe(SIGN_IN_FAILED_BODY);
  });

  it("emits cleanup only before auth for a reused reachable origin", async () => {
    // This test asserts response headers only. The stale-code and stale-cookie
    // tests above prove safety without reading this header, so disabling or
    // ignoring browser cleanup does not weaken the registration boundary.
    const { srv, label, rawSessionId, token } = await anOfficeWithAnApp();
    const first = await raw(srv.port, {
      host: appHost(label),
      headers: NAVIGATION_HEADERS,
    });
    expect(first.headers["clear-site-data"]).toBeUndefined();
    await deleteApp(srv, token, "hello");
    expect(await registerApp(srv, token, "hello")).toBe(label);

    const navigation = await raw(srv.port, {
      host: appHost(label),
      headers: NAVIGATION_HEADERS,
    });
    expect(navigation.status).toBe(302);
    expect(navigation.headers["clear-site-data"]).toBe(
      '"cache", "cookies", "storage"',
    );
    const background = await raw(srv.port, {
      host: appHost(label),
      method: "POST",
    });
    expect(background.status).toBe(401);
    expect(background.headers["clear-site-data"]).toBe(
      '"cache", "cookies", "storage"',
    );

    const minted = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    const redeemed = await redeem(srv, label, codeFromMint(minted));
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers["clear-site-data"]).toBeUndefined();
  });
});

describe("app-host handshake: only navigations and metadata-less clients are bounced", () => {
  it("refuses everything that cannot complete a handshake", async () => {
    const { srv, label } = await anOfficeWithAnApp();
    const host = appHost(label);
    const cases: [string, RawResponse][] = [
      [
        "POST navigation",
        await raw(srv.port, {
          host,
          method: "POST",
          path: "/submit",
          headers: NAVIGATION_HEADERS,
        }),
      ],
      [
        "xhr",
        await raw(srv.port, {
          host,
          path: "/api/data",
          headers: {
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
          },
        }),
      ],
      [
        "subresource",
        await raw(srv.port, {
          host,
          path: "/app.js",
          headers: {
            "Sec-Fetch-Mode": "no-cors",
            "Sec-Fetch-Dest": "script",
          },
        }),
      ],
      [
        "iframe",
        await raw(srv.port, {
          host,
          path: "/embed",
          headers: {
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "iframe",
          },
        }),
      ],
    ];
    // A refusal, never a redirect: that is the whole point of the branch.
    for (const [where, res] of cases) expectAuthRequired(res, where);
  });

  it("bounces a GET with no Sec-Fetch metadata, but not a partial one", async () => {
    // The compatibility arm (manager ruling): a client that sends no Fetch
    // Metadata at all is bounced, because refusing it would mean it could never
    // sign in, and the worst it enables is the cross-site mint already accepted
    // for GET /auth/app. A client that sends SOME Sec-Fetch header speaks the
    // protocol, so for it the exact pair is mandatory.
    const { srv, label } = await anOfficeWithAnApp();
    expectBounce(
      await raw(srv.port, { host: appHost(label), path: "/" }),
      { label, path: "/" },
      "no Sec-Fetch metadata",
    );
    const partials: Record<string, string>[] = [
      { "Sec-Fetch-Mode": "navigate" },
      { "Sec-Fetch-Dest": "document" },
      { "Sec-Fetch-Site": "none" },
      { "Sec-Fetch-User": "?1" },
      { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "document" },
    ];
    for (const headers of partials) {
      expectAuthRequired(
        await raw(srv.port, { host: appHost(label), path: "/", headers }),
        JSON.stringify(headers),
      );
    }
  });

  it("refuses HEAD rather than stranding it at the callback", async () => {
    // HEAD could start the flow, but /__isomux/auth is GET-only, so a client
    // that preserved the method across the 302 would hit a 404 halfway through.
    // Refused at the first hop instead, with and without the navigation pair.
    const { srv, label } = await anOfficeWithAnApp();
    for (const headers of [NAVIGATION_HEADERS, {}]) {
      const res = await raw(srv.port, {
        host: appHost(label),
        method: "HEAD",
        path: "/",
        headers,
      });
      // Status and the absence of a Location, not the body: a HEAD response
      // carries none, which is why HEAD is asserted here rather than through
      // the shared body-comparing helper.
      expect({
        headers,
        status: res.status,
        body: res.body,
        hasLocation: "location" in res.headers,
      }).toEqual({ headers, status: 401, body: "", hasLocation: false });
    }
  });

  it("clears an app cookie that arrives present but empty", async () => {
    // Present-with-no-value never authenticates, but it IS something sitting in
    // the browser, so it is cleared rather than treated as absent - on the
    // bounce and on the refusal alike.
    const { srv, label } = await anOfficeWithAnApp();
    const empty = { Cookie: `${APP_COOKIE_NAME}=` };
    const navigated = await raw(srv.port, {
      host: appHost(label),
      path: "/",
      headers: { ...NAVIGATION_HEADERS, ...empty },
    });
    expectBounce(navigated, { label, path: "/" }, "empty cookie, navigation");
    const refused = await raw(srv.port, {
      host: appHost(label),
      path: "/x.js",
      headers: {
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "script",
        ...empty,
      },
    });
    expectAuthRequired(refused, "empty cookie, subresource");
    const clearLine = `${APP_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
    expect(navigated.setCookies).toEqual([clearLine]);
    expect(refused.setCookies).toEqual([clearLine]);
  });

  it("answers a WebSocket upgrade by session, and never with a redirect", async () => {
    // An upgrade cannot follow a redirect, so it is never bounced - that part is
    // unchanged by slice 6b. What changed is that the two cases are no longer
    // the same answer: without a session the arm refuses 401, and WITH one it
    // goes on to dial the app, which in this office is not listening. Both are
    // still refusals, and neither is the office's own /ws handler.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const host = appHost(label);
    const anonymous = await raw(srv.port, {
      host,
      path: "/ws",
      headers: WS_UPGRADE_HEADERS,
    });
    const value = await signIn(srv, label, rawSessionId);
    const authenticated = await raw(srv.port, {
      host,
      path: "/ws",
      headers: { ...WS_UPGRADE_HEADERS, ...withAppCookie(value) },
    });
    expectPlaceholder(anonymous, WS_AUTH_REQUIRED, "anonymous upgrade");
    expectPlaceholder(authenticated, WS_UNREACHABLE, "authenticated upgrade");
    // Neither is a redirect, which is the property that survives the slice.
    expect(anonymous.headers.location).toBeUndefined();
    expect(authenticated.headers.location).toBeUndefined();
  });

  it("keeps the reserved prefix unreachable except for the handshake GET", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const host = appHost(label);
    const value = await signIn(srv, label, rawSessionId);
    // Even an authenticated caller gets nothing from the reserved prefix, and a
    // non-GET on the handshake's own path is not the handshake.
    for (const [method, path] of [
      ["POST", "/__isomux/auth"],
      ["GET", "/__isomux/authx"],
      ["GET", "/__isomux/"],
      ["GET", "/__isomux"],
    ] as const) {
      expectPlaceholder(
        await raw(srv.port, {
          host,
          method,
          path,
          headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
        }),
        NOT_FOUND,
        `${method} ${path}`,
      );
    }
  });
});

describe("app-host handshake: the office mint endpoint", () => {
  it("shows an unauthenticated visitor the office login page", async () => {
    const { srv, label } = await anOfficeWithAnApp();
    const page = await mint(srv, `?app=${label}&r=%2F`, {
      headers: { Accept: "text/html" },
    });
    expect(page.status).toBe(401);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("invite link");
    // And a fetch gets the JSON 401 rather than a page.
    const json = await mint(srv, `?app=${label}&r=%2F`, {
      headers: { Accept: "application/json" },
    });
    expect(json.status).toBe(401);
    expect(await json.json()).toEqual({ error: "unauthenticated" });
  });

  it("gives a bearer identity nothing: a token is not a session", async () => {
    const { srv, label, token } = await anOfficeWithAnApp();
    const res = await mint(srv, `?app=${label}&r=%2F`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("answers unknown, retired and malformed labels identically", async () => {
    const { srv, rawSessionId, token } = await anOfficeWithAnApp();
    await registerApp(srv, token, "gone");
    await deleteApp(srv, token, "gone");
    const bodies: string[] = [];
    for (const app of [
      "never-existed",
      "gone",
      "not a label",
      "a".repeat(200),
      "",
    ]) {
      const res = await mint(srv, `?app=${encodeURIComponent(app)}&r=%2F`, {
        rawSessionId,
      });
      expect({ app, status: res.status }).toEqual({ app, status: 404 });
      bodies.push(await res.text());
    }
    expect(new Set(bodies)).toEqual(new Set([NOT_FOUND.body]));
  });

  it("refuses a return path that is not a path", async () => {
    // Raw query strings, not encodeURIComponent: what matters is the value
    // AFTER one round of decoding, which is what URLSearchParams hands the
    // validator. `%23` and `%0d%0a` in the query decode to a raw `#` and a raw
    // CRLF - the only way either can reach a server - and both are refused.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const refused = [
      ["protocol-relative", "%2F%2Fevil.example"],
      ["absolute url", "https%3A%2F%2Fevil.example"],
      ["header injection", "%2F%0d%0aX-Injected%3A%201"],
      ["raw fragment", "%2Fa%23frag"],
      ["backslash", "%2F%5Cevil.example"],
      ["not a path", "not-a-path"],
      ["empty", ""],
      ["over-long", `%2F${"a".repeat(3000)}`],
    ] as const;
    for (const [where, r] of refused) {
      const res = await mint(srv, `?app=${label}&r=${r}`, { rawSessionId });
      expect({ where, status: res.status, body: await res.text() }).toEqual({
        where,
        status: 400,
        body: BAD_REQUEST_BODY,
      });
    }
  });

  it("keeps a percent-encoded path intact instead of over-refusing", async () => {
    // `%2523` decodes to the four characters `%23`, which is a legal path
    // segment and not a fragment. The `#` rule is about the decoded value, so
    // an app whose paths carry escapes still works.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    for (const [r, expected] of [
      ["%2Fa%2523frag", "/a%23frag"],
      ["%2Fa%2Fb%3Fx%3D1%26y%3D2", "/a/b?x=1&y=2"],
      ["%2Fcaf%25C3%25A9", "/caf%C3%A9"],
    ] as const) {
      const minted = await mint(srv, `?app=${label}&r=${r}`, { rawSessionId });
      expect({ r, status: minted.status }).toEqual({ r, status: 302 });
      const res = await redeem(srv, label, codeFromMint(minted));
      expect({ r, location: res.headers["location"] }).toEqual({
        r,
        location: expected,
      });
    }
  });

  it("refuses a repeated parameter instead of picking one", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    for (const query of [
      `?app=${label}&app=other&r=%2F`,
      `?app=${label}&r=%2Fa&r=%2Fb`,
    ]) {
      const res = await mint(srv, query, { rawSessionId });
      expect({ query, status: res.status, body: await res.text() }).toEqual({
        query,
        status: 400,
        body: BAD_REQUEST_BODY,
      });
    }
  });

  it("defaults a missing return path to the app's root", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const minted = await mint(srv, `?app=${label}`, { rawSessionId });
    expect(minted.status).toBe(302);
    const res = await redeem(srv, label, codeFromMint(minted));
    expect(res.headers["location"]).toBe("/");
  });

  it("is not a route for any method but GET", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
      expect(res.status).toBe(302); // control: the GET works
      const other = await srv.http(`/auth/app?app=${label}&r=%2F`, {
        method,
        rawSessionId,
        redirect: "manual",
      });
      expect({
        method,
        status: other.status,
        body: await other.text(),
      }).toEqual({ method, status: 404, body: NOT_FOUND.body });
    }
  });

  it("rate-limits minting per office session", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    for (let i = 0; i < APP_MINT_MAX_PER_WINDOW; i++) {
      const ok = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
      expect(ok.status).toBe(302);
    }
    const limited = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe(MINT_LIMITED_BODY);
    // Another user's budget is their own.
    const other = await srv.seedMember("Other");
    const theirs = await mint(srv, `?app=${label}&r=%2F`, {
      rawSessionId: other.rawSessionId,
    });
    expect(theirs.status).toBe(302);
  });

  it("carries the __Host- office-cookie migration like any other page load", async () => {
    // Slice 2's two-step migration must ride THIS response too. It is the door
    // into the app origins, and the whole reason `__Host-` had to land before
    // slice 5 is that an app page on a sibling subdomain can shadow a legacy
    // office cookie. Reaching an app while still holding only the shadowable
    // name would be exactly the case the prerequisite exists for.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    // Step 1, UPGRADE: the request authenticated through the legacy name and
    // carries no `__Host-` cookie, so the same session id is re-issued under
    // the new name - and the handshake response is otherwise untouched.
    const upgrade = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    expect(upgrade.status).toBe(302);
    expect(upgrade.headers.get("location")).toStartWith(
      `https://${appHost(label)}/__isomux/auth?code=`,
    );
    const issued = upgrade.headers.getSetCookie();
    expect(issued.length).toBe(1);
    expect(issued[0]).toStartWith(`__Host-isomux_session=${rawSessionId};`);
    expect(issued[0]).toContain("Secure");
    // Step 2, RETIRE: the browser came back with both, so the legacy name is
    // cleared - and nothing about the handshake changes.
    const retire = await srv.http(`/auth/app?app=${label}&r=%2F`, {
      redirect: "manual",
      headers: {
        Cookie: `__Host-isomux_session=${rawSessionId}; isomux_session=${rawSessionId}`,
      },
    });
    expect(retire.status).toBe(302);
    expect(retire.headers.get("location")).toStartWith(
      `https://${appHost(label)}/__isomux/auth?code=`,
    );
    expect(retire.headers.getSetCookie()).toEqual([
      "isomux_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);
    // And once only the new name arrives, there is nothing left to migrate.
    const settled = await srv.http(`/auth/app?app=${label}&r=%2F`, {
      redirect: "manual",
      headers: { Cookie: `__Host-isomux_session=${rawSessionId}` },
    });
    expect(settled.status).toBe(302);
    expect(settled.headers.getSetCookie()).toEqual([]);
  });

  it("is inert on an office with no app hostnames", async () => {
    // A plain-HTTP loopback office - every dev box - has no app-host domain, so
    // there is no origin to send anyone to and the endpoint is not a route.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await srv.http("/auth/app?app=hello&r=%2F", {
      rawSessionId: owner.rawSessionId,
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND.body);
  });

  it("builds the callback from the registry, not from the request", async () => {
    // The label in the redirect is the registry's own, so a request cannot
    // point the handshake at a host of its choosing. Reached through the office
    // origin's own bounce URL to prove both halves agree.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const minted = await mint(
      srv,
      new URL(bounceLocation(label, "/x")).search,
      { rawSessionId },
    );
    expect(minted.headers.get("location")).toStartWith(
      `https://${appHost(label)}/__isomux/auth?code=`,
    );
    expect(HTTPS_ORIGIN).toBe(`https://${OFFICE_HOST}`);
  });
});
