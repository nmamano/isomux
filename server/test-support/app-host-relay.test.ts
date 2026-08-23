// The relay end to end, through the REAL office (phase 3, slice 5).
//
// app-proxy.test.ts drives the relay directly and owns the matrix. What only
// this file can prove is that the whole chain holds together: a real office
// with a real registry classifies the Host, the slice-4 gate lets an
// authenticated caller through, and the app's own bytes come back - while every
// refusal upstream of the relay still happens without a socket being opened.
//
// The scratch app binds the port the REGISTRY allocated for it, because that is
// where production would look for it and there is deliberately no seam to point
// the relay somewhere else. The port was bind-probed free moments earlier by
// the registration this test just performed, and the listener is closed in the
// same test.

import { describe, it, expect, afterEach } from "bun:test";
import {
  NAVIGATION_HEADERS,
  NOT_FOUND,
  OFFICE_HOST,
  anOfficeWithAnApp,
  appHost,
  deleteApp,
  expectBounce,
  expectPlaceholder,
  raw,
  signIn,
  withAppCookie,
} from "./app-host-test-kit.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { APP_COOKIE_NAME } from "../app-auth.ts";
import { APP_STOPPED_BODY } from "../app-host-responses.ts";

let server: TestServer | null = null;
let app: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  void app?.stop(true);
  app = null;
  await server?.stop();
  server = null;
});

interface Seen {
  method: string;
  path: string;
  cookie: string | null;
  host: string | null;
}

// The app itself: a real HTTP server on the port the registry allocated.
function startApp(name: string, seen: Seen[]): ReturnType<typeof Bun.serve> {
  const record = appRegistry.get(name);
  if (!record) throw new Error(`no registered app ${name}`);
  return Bun.serve({
    port: record.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        cookie: req.headers.get("cookie"),
        host: req.headers.get("host"),
      });
      if (url.pathname === "/echo") {
        return new Response(await req.text(), {
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response("<h1>the app</h1>", {
        headers: {
          "Content-Type": "text/html",
          "Set-Cookie": "app_pref=blue; Path=/",
        },
      });
    },
  });
}

function office(name = "hello") {
  return anOfficeWithAnApp((srv) => {
    server = srv;
  }, name);
}

describe("app-host relay: end to end", () => {
  it("serves the app's own bytes to an authenticated caller", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const res = await raw(srv.port, {
      host: appHost(label),
      path: "/page",
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("<h1>the app</h1>");
    expect(res.headers["content-type"]).toBe("text/html");
    // Office hardening does not rewrite an agent-built app's response.
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBeUndefined();
    // The app's own cookie reaches the browser untouched...
    expect(res.setCookies).toEqual(["app_pref=blue; Path=/"]);
    // ...and the credential that admits to the app never reaches the app.
    expect(seen).toEqual([
      { method: "GET", path: "/page", cookie: null, host: appHost(label) },
    ]);
    expect(JSON.stringify(seen)).not.toContain(APP_COOKIE_NAME);
    expect(JSON.stringify(seen)).not.toContain(cookie);
  });

  it("carries a request body to the app and its answer back", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const res = await fetch(`http://127.0.0.1:${srv.port}/echo`, {
      method: "POST",
      // Bun sends the Host we set here while connecting to the office's own
      // socket, which is exactly what a terminator does.
      headers: {
        Host: appHost(label),
        Cookie: `${APP_COOKIE_NAME}=${cookie}`,
        "Content-Type": "text/plain",
      },
      body: "hello from the browser",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from the browser");
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /echo"]);
  });

  it("keeps the app's own cookies out of the office's namespace", async () => {
    // The app sets `app_pref` and the browser scopes it to the app host. The
    // office's session cookie is host-only on ITS host, so the two can never
    // meet - which is what the whole handshake exists to arrange.
    const { srv, label, rawSessionId } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    const res = await raw(srv.port, {
      host: appHost(label),
      headers: {
        ...NAVIGATION_HEADERS,
        Cookie: [
          `${APP_COOKIE_NAME}=${cookie}`,
          "__Host-isomux_session=STOLEN",
          "isomux_session=ALSO-STOLEN",
          "app_pref=blue",
        ].join("; "),
      },
    });
    expect(res.status).toBe(200);
    expect(seen[0].cookie).toBe("app_pref=blue");
  });
});

describe("app-host relay: nothing reaches a socket it should not", () => {
  it("refuses a stopped app without touching its port", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    // Something IS listening on that port - which is the point. A stopped app's
    // port is just a free port, and whatever is on it is not the app.
    srv.appSupervisor.setRuntime("hello", {
      state: "stopped",
      restartCount: 0,
    });

    const res = await raw(srv.port, {
      host: appHost(label),
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
    });
    expect({ status: res.status, body: res.body }).toEqual({
      status: 503,
      body: APP_STOPPED_BODY,
    });
    expect(seen).toEqual([]);
  });

  it("does not relay an unauthenticated request", async () => {
    const { srv, label } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const res = await raw(srv.port, {
      host: appHost(label),
      path: "/page",
      headers: NAVIGATION_HEADERS,
    });
    expectBounce(res, { label, path: "/page" }, "unauthenticated");
    expect(seen).toEqual([]);
  });

  it("does not relay the reserved prefix, even authenticated", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    for (const path of [
      "/__isomux",
      "/__isomux/anything",
      "/__isomux/auth/x",
    ]) {
      const res = await raw(srv.port, {
        host: appHost(label),
        path,
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
      });
      expectPlaceholder(res, NOT_FOUND, path);
    }
    // The handshake's own path answers the handshake (slice 4) rather than the
    // 404 - the point here is only that it is never the app's.
    const handshake = await raw(srv.port, {
      host: appHost(label),
      path: "/__isomux/auth",
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
    });
    expect(handshake.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("stops relaying the moment the app is deleted", async () => {
    const { srv, label, rawSessionId, token } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    expect(
      (
        await raw(srv.port, {
          host: appHost(label),
          headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
        })
      ).status,
    ).toBe(200);

    await deleteApp(srv, token, "hello");
    // The label is retired: the arm refuses it before the gate or the relay is
    // consulted, and the process still listening on that port is irrelevant.
    const after = await raw(srv.port, {
      host: appHost(label),
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
    });
    expectPlaceholder(after, NOT_FOUND, "after delete");
    expect(seen.length).toBe(1);
  });

  it("leaves the office's own host alone with an app running", async () => {
    // The regression that matters most, one more time with the relay live: the
    // office host is the app-host DOMAIN, and it still reaches the office.
    const { srv } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const res = await raw(srv.port, { host: OFFICE_HOST, path: "/readyz" });
    expect(res.status).toBe(200);
    expect(res.raw).toContain("ok");
    expect(res.headers["content-security-policy"]).toContain(
      `frame-src 'self' blob: data: https://*.${OFFICE_HOST}`,
    );
    expect(res.headers["content-security-policy"]).toContain(
      "upgrade-insecure-requests",
    );
    expect(seen).toEqual([]);
  });
});

describe("app-host relay: inert without app hostnames", () => {
  it("never relays on an office with no app-host domain", async () => {
    // A plain-HTTP office - every dev box. The app is registered and running,
    // and its hostname still means nothing.
    const srv = await startTestServer();
    server = srv;
    const res = await raw(srv.port, {
      host: `hello.${OFFICE_HOST}`,
      path: "/readyz",
    });
    // Falls through to the office exactly as any unknown Host does.
    expect(res.status).toBe(200);
  });
});
