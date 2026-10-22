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
//   - Every way a code can be refused answers with ONE response: replayed, from
//     another app, minted against a session that has since signed out. An
//     anonymous caller cannot tell them apart.
//   - THE APP COOKIE IS NOT AN OFFICE CREDENTIAL and dies with the office
//     session behind it - the property that makes "sign out" mean something
//     once apps have their own origins.
//   - Only a document navigation, or a GET with no Fetch Metadata, is bounced.
//     A POST, an XHR and a HEAD get a refusal instead of a 302 that would lose
//     the method or fail as an opaque CORS error. The predicate case by case is
//     in app-auth.test.ts.
//   - The mint endpoint is behind the office's ordinary wall: no session is the
//     normal login page, a bearer token is not a session, and an unknown label
//     is indistinguishable from a retired one.

import { describe, it, expect, afterEach } from "bun:test";
import {
  HTTPS_ORIGIN,
  NAVIGATION_HEADERS,
  NOT_FOUND,
  OFFICE_HOST,
  RELAY_UNREACHABLE,
  anOfficeWithAnApp as bootOfficeWithAnApp,
  appHost,
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
import { SHARED_COOKIE_NAME, officeSessionCookieNames } from "../auth.ts";
import { createHash } from "crypto";
import { runInNewContext } from "node:vm";
import {
  _testSetAppRegistrationGeneration,
  appRegistrationGeneration,
  appRegistry,
} from "../app-registry.ts";
import {
  APP_COOKIE_NAME,
  APP_MINT_MAX_PER_WINDOW,
  APP_SESSION_TTL_MS,
  appSessionExpiresAt,
  APP_SESSION_REQUIRED_MESSAGE,
  handleAppAuthRedeem,
  mintAppCode,
  redeemAppCode,
  startAppSession,
  validateAppSession,
} from "../app-auth.ts";
import {
  BAD_REQUEST_BODY,
  MINT_LIMITED_BODY,
  SIGN_IN_FAILED_BODY,
} from "../app-host-responses.ts";
import type { AppWidgetStatus } from "../../shared/contract-shapes.ts";

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

function sessionHashOf(rawSessionId: string): string {
  return createHash("sha256").update(rawSessionId).digest("hex");
}

// The one clear line every dead or empty app cookie gets. Spelled out: the
// attributes are the `__Host-` prefix's requirements, which a browser enforces
// on a deletion too.
const CLEAR_LINE = `${APP_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;

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
    //    value written into a browser's history. Its host is the registry's
    //    label under the boot-frozen domain, never the request's own Host.
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
    expect(after.setCookies).toEqual([CLEAR_LINE]);
  });

  it("rechecks room visibility at redeem and on every later request", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const app = appRegistry.get("hello")!;
    const creatorId = app.createdByAgentId!;
    const minted = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    expect(minted.status).toBe(302);
    const code = codeFromMint(minted);
    const secondCode = codeFromMint(
      await mint(srv, `?app=${label}&r=%2F`, { rawSessionId }),
    );
    const value = cookieValue(await redeem(srv, label, secondCode));

    const otherRoom = srv.agentManager.createRoom("Other");
    expect(srv.agentManager.moveAgent(creatorId, otherRoom)).toBe(true);

    const refusedRedeem = await redeem(srv, label, code);
    expect(refusedRedeem.status).toBe(400);
    expect(refusedRedeem.body).toBe(SIGN_IN_FAILED_BODY);

    const after = await raw(srv.port, {
      host: appHost(label),
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
    });
    expectBounce(after, { label, path: "/" }, "after creator move");
    const refusedMint = await mint(srv, `?app=${label}&r=%2F`, {
      rawSessionId,
    });
    expect(refusedMint.status).toBe(404);
  });

  it("refuses every bad code with one response: spent, bogus, absent, oversized, repeated, from another app, or from a signed-out session", async () => {
    const { srv, label, rawSessionId, token } = await anOfficeWithAnApp();
    const other = await registerApp(srv, token, "other");
    const fresh = async () =>
      codeFromMint(await mint(srv, `?app=${label}&r=%2F`, { rawSessionId }));
    const spentCode = await fresh();
    const otherAppCode = await fresh();
    const signedOutCode = await fresh();
    const spent = await redeem(srv, label, spentCode);
    expect(spent.status).toBe(302);

    const cases: [string, RawResponse][] = [
      ["replayed", await redeem(srv, label, spentCode)],
      ["bogus", await redeem(srv, label, "Zm9vYmFyYmF6")],
      [
        "absent",
        await raw(srv.port, {
          host: appHost(label),
          path: "/__isomux/auth",
          headers: NAVIGATION_HEADERS,
        }),
      ],
      ["oversized", await redeem(srv, label, "a".repeat(200))],
      [
        "duplicated",
        await raw(srv.port, {
          host: appHost(label),
          path: `/__isomux/auth?code=${otherAppCode}&code=x`,
          headers: NAVIGATION_HEADERS,
        }),
      ],
      // A live code of this app, presented at a sibling app's host.
      ["another app's host", await redeem(srv, other, otherAppCode)],
    ];
    const out = await srv.http("/auth/logout", {
      method: "POST",
      rawSessionId,
      redirect: "manual",
    });
    expect(out.status).toBe(302);
    cases.push([
      "minted before sign-out",
      await redeem(srv, label, signedOutCode),
    ]);

    const [, replayed] = cases[0];
    expect({ status: replayed.status, body: replayed.body }).toEqual({
      status: 400,
      body: SIGN_IN_FAILED_BODY,
    });
    // Byte-identical, headers included, not merely equal in status and body.
    for (const [where, res] of cases) {
      expect({ where, stable: res.stable }).toEqual({
        where,
        stable: replayed.stable,
      });
    }
  });

  it("stops being reachable when the app is deleted, and its re-registration trusts none of its credentials", async () => {
    const { srv, label, rawSessionId, token } = await anOfficeWithAnApp();
    const value = await signIn(srv, label, rawSessionId);
    const fresh = async () =>
      codeFromMint(await mint(srv, `?app=${label}&r=%2F`, { rawSessionId }));
    const codeForDeleted = await fresh();
    const codeForSuccessor = await fresh();

    await deleteApp(srv, token, "hello");
    const host = appHost(label);
    // The label is retired: it answers as a live label answers a caller with no
    // app session, so a live cookie and an unspent code are equally worthless.
    const withCookie = await raw(srv.port, {
      host,
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
    });
    expectBounce(withCookie, { label, path: "/" }, "cookie on a deleted app");
    expect(withCookie.setCookies).toEqual([CLEAR_LINE]);
    const onDeleted = await redeem(srv, label, codeForDeleted);
    expect({ status: onDeleted.status, body: onDeleted.body }).toEqual({
      status: 400,
      body: SIGN_IN_FAILED_BODY,
    });

    // Re-registering keeps the wanted label, while server-held registration
    // identity makes the predecessor's credentials worthless: its cookie, and a
    // code minted just before the delete.
    const successor = await registerApp(srv, token, "hello");
    expect(successor).toBe(label);
    const record = appRegistry.get("hello")!;
    expect(appRegistrationGeneration(record)).toBeGreaterThan(record.hostGen);
    expectBounce(
      await raw(srv.port, {
        host: appHost(successor),
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
      }),
      { label: successor, path: "/" },
      "predecessor cookie on the successor",
    );
    const onSuccessor = await redeem(srv, successor, codeForSuccessor);
    expect({ status: onSuccessor.status, body: onSuccessor.body }).toEqual({
      status: 400,
      body: SIGN_IN_FAILED_BODY,
    });

    // The successor's own sign-in works: the new registration generation rides
    // the code and the session.
    const successorCookie = await signIn(srv, successor, rawSessionId);
    expectPlaceholder(
      await raw(srv.port, {
        host: appHost(successor),
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(successorCookie) },
      }),
      RELAY_UNREACHABLE,
      "successor cookie on the successor",
    );
  });
});

describe("app-host handshake: the registration binding", () => {
  // Delete and re-register drop every code and session of the old registration
  // (the next test), so no production state reaches these checks today. They
  // are the second line: each one is proven alone here, with a live office
  // session behind it so a refusal cannot come from the revalidation instead.
  it("binds codes and app sessions to the live host and registration generations, each check alone", async () => {
    const { label, rawSessionId } = await anOfficeWithAnApp();
    const app = appRegistry.get("hello")!;
    const gen = appRegistrationGeneration(app);
    const officeSessionHash = sessionHashOf(rawSessionId);
    const host = appHost(label);
    const fresh = () => {
      const minted = mintAppCode({
        label,
        hostGen: app.hostGen,
        registrationGen: gen,
        appHost: host,
        officeSessionHash,
        returnPath: "/",
      });
      if ("error" in minted) throw new Error(minted.error);
      return minted.code;
    };
    const at = (code: string, target: typeof app) =>
      handleAppAuthRedeem(
        new Request(`https://${host}/__isomux/auth?code=${code}`),
        { host, app: target, canAccess: () => true, client: "203.0.113.10" },
      ).status;

    // A redeem against another registration generation, at the code table.
    const redeemAt = (code: string, registrationGen: number) =>
      redeemAppCode(code, {
        host,
        label,
        client: "203.0.113.11",
        registrationGen,
      });
    expect(redeemAt(fresh(), gen + 1)).toBeNull();
    expect(redeemAt(fresh(), gen)?.label).toBe(label);

    // A redeem against another host generation, at the handler.
    const otherHostGen = { ...app, hostGen: app.hostGen + 1 };
    _testSetAppRegistrationGeneration(otherHostGen, gen);
    expect(at(fresh(), otherHostGen)).toBe(400);
    expect(at(fresh(), app)).toBe(302);

    // An app session checked against each generation alone.
    const started = startAppSession({
      label,
      hostGen: app.hostGen,
      registrationGen: gen,
      officeSessionHash,
      absoluteExpiresAt: Date.now() + 60_000,
    });
    if (started === null) throw new Error("no app session");
    const check = (ctx: { hostGen: number; registrationGen: number }) =>
      validateAppSession(started.token, { label, ...ctx })?.officeSessionHash ??
      null;
    expect(check({ hostGen: app.hostGen, registrationGen: gen })).toBe(
      officeSessionHash,
    );
    expect(
      check({ hostGen: app.hostGen + 1, registrationGen: gen }),
    ).toBeNull();
    expect(
      check({ hostGen: app.hostGen, registrationGen: gen + 1 }),
    ).toBeNull();
  });

  it("readiness binds every registration field and the live office session", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    await signIn(srv, label, rawSessionId);
    const app = appRegistry.get("hello")!;
    const hash = sessionHashOf(rawSessionId);
    const generation = appRegistrationGeneration(app);
    const expiresAt = appSessionExpiresAt(app, hash);
    expect(expiresAt).toBeGreaterThan(Date.now());
    // The widget route answers with the caller's own readiness.
    const widget = await srv.http(
      `/api/apps/hello/widget?registration=${generation}`,
      { rawSessionId },
    );
    expect(widget.status).toBe(200);
    const status = (await widget.json()) as AppWidgetStatus;
    expect(status.sessionExpiresAt).toBe(expiresAt);

    const replacement = { ...app };
    _testSetAppRegistrationGeneration(replacement, generation + 1);
    expect(appSessionExpiresAt(replacement, hash)).toBeNull();
    const otherHostGeneration = { ...app, hostGen: app.hostGen + 1 };
    _testSetAppRegistrationGeneration(otherHostGeneration, generation);
    expect(appSessionExpiresAt(otherHostGeneration, hash)).toBeNull();
    const otherLabel = { ...app, hostLabel: "other-app" };
    _testSetAppRegistrationGeneration(otherLabel, generation);
    expect(appSessionExpiresAt(otherLabel, hash)).toBeNull();
    expect(appSessionExpiresAt(app, null)).toBeNull();
    const otherMember = await srv.seedMember("Other");
    expect(
      appSessionExpiresAt(app, sessionHashOf(otherMember.rawSessionId)),
    ).toBeNull();
    // Past the app session's own deadline.
    expect(
      appSessionExpiresAt(app, hash, Date.now() + APP_SESSION_TTL_MS + 1),
    ).toBeNull();
    const out = await srv.http("/auth/logout", {
      method: "POST",
      rawSessionId,
      redirect: "manual",
    });
    expect(out.status).toBe(302);
    expect(appSessionExpiresAt(app, hash)).toBeNull();
  });

  it("binds wrapper return to the registration and forwards only the query", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const app = appRegistry.list().find((a) => a.hostLabel === label)!;
    const registration = appRegistrationGeneration(app);
    const params = new URLSearchParams({
      app: label,
      mode: "wrapper",
      registration: String(registration),
      r: "/other-path?tab=one%20two&x=3",
    });
    const minted = await mint(srv, `?${params}`, { rawSessionId });
    const redeemed = await redeem(srv, label, codeFromMint(minted));
    expect(redeemed.headers.location).toBe(
      `${HTTPS_ORIGIN}/${app.name}?tab=one%20two&x=3`,
    );
    expect(redeemed.setCookies).toHaveLength(1);
    // The path never reaches the office Location, so an encoded authority or
    // another app's name cannot steer the wrapper return.
    for (const safePath of ["/%2f%2fevil.example/", "/another-app"]) {
      params.set("r", safePath);
      const encodedMint = await mint(srv, `?${params}`, { rawSessionId });
      const encodedRedeem = await redeem(srv, label, codeFromMint(encodedMint));
      expect(encodedRedeem.headers.location).toBe(
        `${HTTPS_ORIGIN}/${app.name}`,
      );
    }
    params.set("r", "/");
    params.set("registration", String(registration + 1));
    expect((await mint(srv, `?${params}`, { rawSessionId })).status).toBe(404);
  });
});

describe("app-host handshake: only navigations and metadata-less clients are bounced", () => {
  it("bounces a navigation or a GET with no Sec-Fetch metadata, and refuses the rest without a redirect", async () => {
    const { srv, label } = await anOfficeWithAnApp();
    const host = appHost(label);
    // The compatibility arm (manager ruling): a client that sends no Fetch
    // Metadata at all is bounced, because refusing it would mean it could never
    // sign in. The navigation pair itself is the round trip's first hop.
    expectBounce(
      await raw(srv.port, { host, path: "/" }),
      { label, path: "/" },
      "no Sec-Fetch metadata",
    );
    // A refusal, never a redirect: that is the whole point of the branch.
    const refusals: [
      string,
      { method?: string; headers: Record<string, string> },
    ][] = [
      ["POST navigation", { method: "POST", headers: NAVIGATION_HEADERS }],
      [
        "xhr",
        { headers: { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } },
      ],
      // A client that speaks Fetch Metadata owes the exact pair.
      ["partial metadata", { headers: { "Sec-Fetch-Site": "none" } }],
    ];
    for (const [where, shape] of refusals) {
      expectAuthRequired(
        await raw(srv.port, { host, path: "/submit", ...shape }),
        where,
      );
    }
    // HEAD could start the flow, but /__isomux/auth is GET-only, so a client
    // that preserved the method across the 302 would hit a 404 halfway through.
    // Asserted without the body-comparing helper: a HEAD response carries none.
    const head = await raw(srv.port, {
      host,
      method: "HEAD",
      path: "/",
      headers: NAVIGATION_HEADERS,
    });
    expect({
      status: head.status,
      body: head.body,
      hasLocation: "location" in head.headers,
    }).toEqual({ status: 401, body: "", hasLocation: false });
  });

  it("sets framing on app-host refusals and reserved paths", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    for (const path of ["/", "/__isomux/unknown", "/__isomux/auth"]) {
      const response = await raw(srv.port, {
        host: appHost(label),
        path,
        headers: { "Sec-Fetch-Dest": "empty" },
      });
      expect(response.headers["content-security-policy"]).toBe(
        `frame-ancestors 'self' ${HTTPS_ORIGIN}`,
      );
      expect(response.headers["x-frame-options"]).toBeUndefined();
    }
    const cookie = await signIn(srv, label, rawSessionId);
    const unavailable = await raw(srv.port, {
      host: appHost(label),
      headers: withAppCookie(cookie),
    });
    expect(unavailable.status).toBe(502);
    expect(unavailable.headers["content-security-policy"]).toBe(
      `frame-ancestors 'self' ${HTTPS_ORIGIN}`,
    );
  });

  it("signals a framed missing session without exposing label existence", async () => {
    const { srv, label } = await anOfficeWithAnApp();
    const headers = { "Sec-Fetch-Dest": "iframe" };
    const known = await raw(srv.port, { host: appHost(label), headers });
    const unknown = await raw(srv.port, { host: appHost("unknown"), headers });
    expect(known.stable).toBe(unknown.stable);
    expect(known.status).toBe(401);
    expect(known.headers.location).toBeUndefined();
    expect(known.headers["content-type"]).toContain("text/html");
    const script = known.body.match(/<script>(.*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const messages: unknown[][] = [];
    runInNewContext(script!, {
      parent: { postMessage: (...args: unknown[]) => messages.push(args) },
    });
    expect(messages).toEqual([[APP_SESSION_REQUIRED_MESSAGE, HTTPS_ORIGIN]]);
    const hash = createHash("sha256").update(script!).digest("base64");
    expect(known.headers["content-security-policy"]).toBe(
      `default-src 'none'; script-src 'sha256-${hash}'; frame-ancestors 'self' ${HTTPS_ORIGIN}`,
    );
    const rejected = await raw(srv.port, {
      host: appHost(label),
      headers: { ...headers, Cookie: `${APP_COOKIE_NAME}=dead` },
    });
    expect(rejected.body).toBe(known.body);
    expect(rejected.setCookies).toEqual([CLEAR_LINE]);
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
    expect(navigated.setCookies).toEqual([CLEAR_LINE]);
    expect(refused.setCookies).toEqual([CLEAR_LINE]);
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
    // The same page any other walled office path shows a signed-out browser.
    const login = await srv.http("/agents", {
      headers: { Accept: "text/html" },
    });
    expect(login.status).toBe(401);
    expect(await page.text()).toBe(await login.text());
    // And a fetch gets the JSON 401 rather than a page.
    const json = await mint(srv, `?app=${label}&r=%2F`, {
      headers: { Accept: "application/json" },
    });
    expect(json.status).toBe(401);
    expect((await json.json()).error.code).toBe("unauthenticated");
  });

  it("gives a bearer identity nothing: a token is not a session", async () => {
    const { srv, label, token } = await anOfficeWithAnApp();
    const res = await mint(srv, `?app=${label}&r=%2F`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  // Only GET mints. Another method must not fall through to the office shell,
  // which would answer 200 text/html.
  it("is not a route for any method but GET", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    // The enabling condition: this session mints on GET.
    expect(
      (await mint(srv, `?app=${label}&r=%2F`, { rawSessionId })).status,
    ).toBe(302);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await srv.http(`/auth/app?app=${label}&r=%2F`, {
        method,
        rawSessionId,
        redirect: "manual",
      });
      expect({
        method,
        status: res.status,
        contentType: res.headers.get("content-type"),
        body: await res.text(),
      }).toEqual({
        method,
        status: 404,
        contentType: NOT_FOUND.contentType,
        body: NOT_FOUND.body,
      });
    }
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

  it("refuses a return path that is not a path, after exactly one decoding", async () => {
    // Raw query strings, not encodeURIComponent: what matters is the value
    // AFTER one round of decoding, which is what URLSearchParams hands the
    // validator. `%23` and `%0d%0a` in the query decode to a raw `#` and a raw
    // CRLF - the only way either can reach a server - and both are refused.
    // Every other class is pinned on the validator in app-auth.test.ts.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const refused = [
      ["protocol-relative", "%2F%2Fevil.example"],
      ["header injection", "%2F%0d%0aX-Injected%3A%201"],
      ["raw fragment", "%2Fa%23frag"],
      // Present but empty is not absent.
      ["empty", ""],
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

  it("keeps a percent-encoded path intact, and defaults a missing one to the app's root", async () => {
    // `%2523` decodes to the four characters `%23`, which is a legal path
    // segment and not a fragment. The `#` rule is about the decoded value, so
    // an app whose paths carry escapes still works.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    for (const [query, expected] of [
      [`?app=${label}&r=%2Fa%2523frag`, "/a%23frag"],
      [`?app=${label}&r=%2Fa%2Fb%3Fx%3D1%26y%3D2`, "/a/b?x=1&y=2"],
      [`?app=${label}&r=%2Fcaf%25C3%25A9`, "/caf%C3%A9"],
      [`?app=${label}`, "/"],
    ] as const) {
      const minted = await mint(srv, query, { rawSessionId });
      expect({ query, status: minted.status }).toEqual({ query, status: 302 });
      const res = await redeem(srv, label, codeFromMint(minted));
      expect({ query, location: res.headers["location"] }).toEqual({
        query,
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

  it("rate-limits minting per office session", async () => {
    // Per session and per window: app-auth.test.ts. This is the wire answer.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    for (let i = 0; i < APP_MINT_MAX_PER_WINDOW; i++) {
      const ok = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
      expect(ok.status).toBe(302);
    }
    const limited = await mint(srv, `?app=${label}&r=%2F`, { rawSessionId });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe(MINT_LIMITED_BODY);
  });

  it("carries the __Host- office-cookie migration like any other page load", async () => {
    // The two-step migration must ride THIS response too. It is the door into
    // the app origins, and the whole reason `__Host-` had to land before slice
    // 5 is that an app page on a sibling subdomain can shadow a plain office
    // cookie. Reaching an app while still holding only the shadowable name
    // would be exactly the case the prerequisite exists for.
    const { srv, label, rawSessionId } = await anOfficeWithAnApp();
    const { host } = officeSessionCookieNames();
    const shared = `${SHARED_COOKIE_NAME}=${rawSessionId}`;
    // Step 1, UPGRADE: the request authenticated through a shared name and
    // carries none of this office's names, so the same session id is
    // re-issued under the office's `__Host-` name - and the handshake response
    // is otherwise untouched.
    const upgrade = await mint(srv, `?app=${label}&r=%2F`, {
      headers: { Cookie: shared },
    });
    expect(upgrade.status).toBe(302);
    expect(upgrade.headers.get("location")).toStartWith(
      `https://${appHost(label)}/__isomux/auth?code=`,
    );
    const issued = upgrade.headers.getSetCookie();
    expect(issued.length).toBe(1);
    expect(issued[0]).toStartWith(`${host}=${rawSessionId};`);
    expect(issued[0]).toContain("Secure");
    // Step 2, RETIRE: the browser came back with both, so the shared name is
    // cleared - and nothing about the handshake changes.
    const retire = await srv.http(`/auth/app?app=${label}&r=%2F`, {
      redirect: "manual",
      headers: { Cookie: `${host}=${rawSessionId}; ${shared}` },
    });
    expect(retire.status).toBe(302);
    expect(retire.headers.get("location")).toStartWith(
      `https://${appHost(label)}/__isomux/auth?code=`,
    );
    expect(retire.headers.getSetCookie()).toEqual([
      `${SHARED_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
  });

  it("is inert on an office with no app hostnames", async () => {
    // A plain-HTTP loopback office - every dev box - has no app-host domain, so
    // there is no origin to send anyone to and the endpoint is not a route.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const res = await srv.http("/auth/app?app=hello&r=%2F", {
      rawSessionId: owner.rawSessionId,
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND.body);
  });
});
