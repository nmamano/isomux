// The relay end to end, through the REAL office (phase 3, slice 5).
//
// app-proxy.test.ts drives the relay directly and owns the matrix (bodies,
// cookie strip, refusals of a stopped app without a connection). What only
// this file can prove is that the whole chain holds together: a real office
// with a real registry and supervisor classifies the Host, the slice-4 gate
// lets an authenticated caller through, and the app's own bytes come back -
// while the reserved prefix never reaches the app's socket.
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
  expectPlaceholder,
  raw,
  signIn,
  withAppCookie,
} from "./app-host-test-kit.ts";
import { type TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { OFFICE_MARKER_HEADER } from "../browser-office-gate.ts";

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
    fetch(req) {
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        cookie: req.headers.get("cookie"),
        host: req.headers.get("host"),
      });
      return new Response("<h1>the app</h1>", {
        headers: {
          "Content-Type": "text/html",
          "Set-Cookie": "app_pref=blue; Path=/",
        },
      });
    },
  });
}

function office() {
  return anOfficeWithAnApp((srv) => {
    server = srv;
  });
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
    // The office owns framing while preserving the app's bytes and other headers.
    expect(res.headers["content-security-policy"]).toBe(
      `frame-ancestors 'self' https://${OFFICE_HOST}`,
    );
    expect(res.headers["x-content-type-options"]).toBeUndefined();
    // An app is not the office: browser control must not refuse it.
    expect(res.headers[OFFICE_MARKER_HEADER]).toBeUndefined();
    // The app's own cookie reaches the browser untouched...
    expect(res.setCookies).toEqual(["app_pref=blue; Path=/"]);
    // ...and the credential that admits to the app never reaches the app.
    expect(seen).toEqual([
      { method: "GET", path: "/page", cookie: null, host: appHost(label) },
    ]);
  });
});

describe("app-host relay: nothing reaches a socket it should not", () => {
  it("does not relay the reserved prefix, even authenticated, and relays a path that merely starts like it", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: Seen[] = [];
    app = startApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    const authed = { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) };
    for (const [method, path] of [
      ["GET", "/__isomux"],
      ["GET", "/__isomux/"],
      ["GET", "/__isomux/anything"],
      ["GET", "/__isomux/auth/x"],
      ["GET", "/__isomux/authx"],
      // Only the GET is the handshake.
      ["POST", "/__isomux/auth"],
    ] as const) {
      const res = await raw(srv.port, {
        host: appHost(label),
        method,
        path,
        headers: authed,
      });
      expectPlaceholder(res, NOT_FOUND, `${method} ${path}`);
    }
    // The handshake's own GET answers the handshake (slice 4) rather than the
    // 404 - the point here is only that it is never the app's.
    const handshake = await raw(srv.port, {
      host: appHost(label),
      path: "/__isomux/auth",
      headers: authed,
    });
    expect(handshake.status).toBe(400);
    expect(seen).toEqual([]);

    // A path that merely starts with the same characters is NOT reserved: it
    // is an ordinary app path, and the app answers it.
    const ordinary = await raw(srv.port, {
      host: appHost(label),
      path: "/__isomuxer",
      headers: authed,
    });
    expect({ status: ordinary.status, body: ordinary.body }).toEqual({
      status: 200,
      body: "<h1>the app</h1>",
    });
    expect(seen.map((s) => s.path)).toEqual(["/__isomuxer"]);
  });
});
