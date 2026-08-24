// App-host dispatch against the REAL server (phase 3, slice 3).
//
// The URL shape is FLAT: an app called `hello` on an office at
// `office.example` answers at `hello.office.example`. So the office and its
// apps share one namespace, separated by a single rule - the exact canonical
// office host is never diverted - and the whole slice stands or falls on that
// rule holding. The domain is DERIVED from publicOrigin: an HTTPS office at a
// real name has app hostnames, a plain-HTTP or loopback one has none.
//
// Two halves, and the first one matters more:
//
//   1. REGRESSION. The Host check is now the first thing every request meets,
//      so every existing route is downstream of it. These tests pin that the
//      office host, a bare IP, localhost and a suffix lookalike all reach the
//      office exactly as before on an office WITH app hostnames live - and
//      that turning them on changes nothing for any of them.
//   2. THE ARM. A diverted host never reaches an office handler and answers
//      only the two fail-closed placeholders. Unknown and retired labels are
//      pinned byte-for-byte identical, because "this label used to be
//      somebody's app" is not the internet's business.
//
// Raw sockets, not fetch, for the byte-exact comparisons and the WebSocket
// upgrade: fetch normalizes header order and cannot be made to hold a socket
// open through a 101.

import { describe, it, expect, afterEach } from "bun:test";
import { type TestServer } from "./harness.ts";
import { startTestServer } from "./harness.ts";
import { builtShellExists } from "./built-ui.ts";
import {
  HTTPS_ORIGIN,
  NAVIGATION_HEADERS,
  expectBounce,
  NOT_FOUND,
  WS_AUTH_REQUIRED,
  OFFICE_HOST,
  WS_UPGRADE_HEADERS,
  anAgentToken,
  anOfficeWithAnApp,
  deleteApp,
  expectPlaceholder,
  patchOfficeConfig,
  raw,
  type RawResponse,
  registerApp,
  signIn,
  startFlatOffice as bootFlatOffice,
  withAppCookie,
} from "./app-host-test-kit.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// The rig lives in app-host-test-kit.ts, shared with the handshake tests
// (slice 4) so both files boot the same office and compare against the same
// placeholder bytes. This wrapper keeps the local afterEach in charge of
// whichever server is live.
function startFlatOffice(): Promise<TestServer> {
  return bootFlatOffice((srv) => {
    server = srv;
  });
}

// Changing publicOrigin from HTTP to HTTPS intentionally changes the two
// headers that describe that origin: HSTS appears, and CSP gains
// upgrade-insecure-requests plus (when the origin supports app hostnames) the
// app-preview frame source. The dispatch invariant remains byte-exact after
// those two headers are removed: Host classification must change nothing else.
function withoutOriginSecurityHeaders(stable: string): string {
  return stable
    .split("\r\n")
    .filter(
      (line) =>
        !/^(content-security-policy|strict-transport-security):/i.test(line),
    )
    .join("\r\n");
}

function changedHeaders(
  before: RawResponse,
  after: RawResponse,
): Record<string, { before: string | undefined; after: string | undefined }> {
  const changed: Record<
    string,
    { before: string | undefined; after: string | undefined }
  > = {};
  const names = new Set([
    ...Object.keys(before.headers),
    ...Object.keys(after.headers),
  ]);
  for (const name of names) {
    // `date` differs whenever the two responses straddle a second boundary,
    // so it can never signal a config-driven change.
    if (name === "date") continue;
    if (before.headers[name] === after.headers[name]) continue;
    changed[name] = {
      before: before.headers[name],
      after: after.headers[name],
    };
  }
  return changed;
}

function cspDirectiveDelta(
  before: string,
  after: string,
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before.split("; "));
  const afterSet = new Set(after.split("; "));
  return {
    added: [...afterSet].filter((value) => !beforeSet.has(value)).sort(),
    removed: [...beforeSet].filter((value) => !afterSet.has(value)).sort(),
  };
}

describe("app hosts: the office is untouched", () => {
  it("is entirely inert with no app-host domain resolved", async () => {
    const srv = await startTestServer();
    server = srv;
    // The very requests the arm would answer, on an office that never opted
    // in: indistinguishable from any other unknown Host, i.e. whatever the
    // office does today.
    const control = await raw(srv.port, { host: "localhost", path: "/readyz" });
    for (const host of [
      `hello.${OFFICE_HOST}`,
      OFFICE_HOST,
      `a.b.${OFFICE_HOST}`,
    ]) {
      const res = await raw(srv.port, { host, path: "/readyz" });
      expect({ host, stable: res.stable }).toEqual({
        host,
        stable: control.stable,
      });
    }
    expect(control.raw).toContain("ok");
  });

  it("is inert on a tailnet office, which is on HTTPS and still has no domain", async () => {
    // The 2026-08-08 regression, reproduced against the real server: an office
    // behind Tailscale Serve has an HTTPS publicOrigin, so it derived a domain
    // and every app link pointed at a name MagicDNS cannot resolve. HTTPS is
    // no longer enough on its own - a `.ts.net` office still has no app-host
    // dispatch arm. Its HTTPS security headers are expected to differ from the
    // plain-HTTP baseline, but every other response byte stays identical.
    const TAILNET_HOST = "auntie.tail1234.ts.net";
    const before = await startTestServer();
    server = before;

    // A REAL app, registered and persisted before the transition, so the
    // assertion after the restart is about an app the office actually has.
    const owner = await before.seedOwner("Boss");
    const token = await anAgentToken(before);
    expect(await registerApp(before, token, "hello")).toBe("hello");

    const hosts = [TAILNET_HOST, `hello.${TAILNET_HOST}`];
    const baseline: Record<string, RawResponse> = {};
    for (const host of hosts) {
      baseline[host] = await raw(before.port, { host, path: "/readyz" });
      expect(
        baseline[host].headers["strict-transport-security"],
      ).toBeUndefined();
      expect(baseline[host].headers["content-security-policy"]).not.toContain(
        "upgrade-insecure-requests",
      );
    }
    expect(baseline[TAILNET_HOST].raw).toContain("ok");

    // Become that office, through the route that is the whole of what turns
    // app hostnames on, and cold-restart the same install.
    const r = await before.http("/api/office/access", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalAccess: true,
        publicOrigin: `https://${TAILNET_HOST}`,
      }),
    });
    expect(r.status).toBe(200);
    const after = await before.restart();
    server = after;

    // Nothing diverts: the app's own would-be hostname reaches the office.
    // HTTPS-only response policy changes, while dispatch output does not.
    for (const host of hosts) {
      const res = await raw(after.port, { host, path: "/readyz" });
      expect({
        host,
        stable: withoutOriginSecurityHeaders(res.stable),
      }).toEqual({
        host,
        stable: withoutOriginSecurityHeaders(baseline[host].stable),
      });
      const delta = changedHeaders(baseline[host], res);
      expect(Object.keys(delta).sort()).toEqual([
        "content-security-policy",
        "strict-transport-security",
      ]);
      expect(delta["strict-transport-security"]).toEqual({
        before: undefined,
        after: "max-age=31536000",
      });
      expect(
        cspDirectiveDelta(
          delta["content-security-policy"].before!,
          delta["content-security-policy"].after!,
        ),
      ).toEqual({ added: ["upgrade-insecure-requests"], removed: [] });
    }

    // And the app is handed no address. ABSENT, not null and not empty: an
    // agent tells "this office has app hostnames and mine is X" from "this
    // office has none" by whether the key is there at all.
    // Read it the way the Apps tab does - a signed-in human on the office
    // host - because that is the surface that broke.
    const list = await after.http("/api/apps", {
      rawSessionId: owner.rawSessionId,
    });
    expect(list.status).toBe(200);
    const apps = (await list.json()) as Record<string, unknown>[];
    expect(apps.map((a) => a.name)).toEqual(["hello"]);
    expect("url" in apps[0]).toBe(false);
  });

  it("still serves the office on its own host, which is also the app domain", async () => {
    // The rule the whole flat shape rests on: the app-host domain IS the
    // office host, and the office host still reaches the office.
    const srv = await startFlatOffice();
    const res = await raw(srv.port, { host: OFFICE_HOST, path: "/readyz" });
    expect(res.status).toBe(200);
    expect(res.raw).toContain("ok");
  });

  it("serves the office host through case, a port and a trailing dot", async () => {
    // Canonicalization must not accidentally divert the office.
    const srv = await startFlatOffice();
    for (const host of [
      OFFICE_HOST,
      OFFICE_HOST.toUpperCase(),
      `${OFFICE_HOST}:443`,
      `${OFFICE_HOST}.`,
      `${OFFICE_HOST}.:8443`,
    ]) {
      const res = await raw(srv.port, { host, path: "/readyz" });
      expect({ host, status: res.status }).toEqual({ host, status: 200 });
    }
  });

  // The regression pin, in its strongest valid form: measure every non-app
  // Host on an HTTP office with NO app-host domain, turn HTTPS + app hostnames
  // on, and require every response byte OTHER THAN the origin-dependent CSP
  // and HSTS headers to stay identical. The two excluded headers are asserted
  // separately in both states, including the app-preview wildcard.
  //
  // Syntactically malformed Hosts ("has space.test") are deliberately NOT in
  // this list. They never reach an office response on any build, including the
  // baseline: `new URL(req.url)` throws an uncaught TypeError on them, and
  // that line is the first statement of the handler before this slice and the
  // statement right after the new hook now - the hook returns null and the
  // same line runs on the same bytes. bun:test attributes the server's
  // uncaught throw to whichever test is running, so including one here would
  // fail this test for a defect that predates it. The normalizer's treatment
  // of those forms is pinned in app-hosts.test.ts instead; the crash itself is
  // reported separately.
  const NON_APP_HOSTS = [
    "localhost",
    "127.0.0.1",
    "[::1]:4000",
    "auntie",
    "auntie.tail1234.ts.net",
    // Suffix lookalikes: the string is in there, the domain is not.
    `not${OFFICE_HOST}`,
    `evil${OFFICE_HOST}`,
    `${OFFICE_HOST}.evil.test`,
    // Well-formed but not a hostname the normalizer will route on.
    "-lead.test",
    "under_score.test",
  ];

  it("answers every non-app Host identically before and after the arm turns on", async () => {
    const before = await startTestServer();
    server = before;
    const baseline: Record<string, RawResponse> = {};
    for (const host of NON_APP_HOSTS) {
      baseline[host] = await raw(before.port, { host, path: "/readyz" });
      expect(
        baseline[host].headers["strict-transport-security"],
      ).toBeUndefined();
      expect(baseline[host].headers["content-security-policy"]).not.toContain(
        "upgrade-insecure-requests",
      );
      expect(baseline[host].headers["content-security-policy"]).not.toContain(
        `https://*.${OFFICE_HOST}`,
      );
    }
    // Sanity: these really did reach the office on the arm-less boot.
    expect(baseline["localhost"].raw).toContain("ok");

    // Turn the office into an HTTPS deployment through the real Access route,
    // which is the whole of what turns app hostnames on, and cold-restart the
    // SAME install.
    const owner = await before.seedOwner("Boss");
    const r = await before.http("/api/office/access", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalAccess: true,
        publicOrigin: HTTPS_ORIGIN,
      }),
    });
    expect(r.status).toBe(200);
    const after = await before.restart();
    server = after;
    // The feature is on: an app host under the domain now diverts.
    expect(
      (await raw(after.port, { host: `hello.${OFFICE_HOST}`, path: "/readyz" }))
        .status,
    ).toBe(404);

    for (const host of NON_APP_HOSTS) {
      const res = await raw(after.port, { host, path: "/readyz" });
      expect({
        host,
        stable: withoutOriginSecurityHeaders(res.stable),
      }).toEqual({
        host,
        stable: withoutOriginSecurityHeaders(baseline[host].stable),
      });
      const delta = changedHeaders(baseline[host], res);
      expect(Object.keys(delta).sort()).toEqual([
        "content-security-policy",
        "strict-transport-security",
      ]);
      expect(delta["strict-transport-security"]).toEqual({
        before: undefined,
        after: "max-age=31536000",
      });
      expect(
        cspDirectiveDelta(
          delta["content-security-policy"].before!,
          delta["content-security-policy"].after!,
        ),
      ).toEqual({
        added: [
          `frame-src 'self' blob: data: https://*.${OFFICE_HOST}`,
          "upgrade-insecure-requests",
        ],
        removed: ["frame-src 'self' blob: data:"],
      });
    }
  });

  // These three send Host: office.example DELIBERATELY. The harness's own
  // http()/connectWs() go to 127.0.0.1, so they would only ever prove that a
  // host OUTSIDE the domain falls through - which is not the interesting
  // claim. The office host is the one name a classification bug would eat,
  // and it is one character away from every app host.
  it("still serves an authenticated API route ON the office host", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const res = await raw(srv.port, {
      host: OFFICE_HOST,
      path: "/api/apps",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    // The real payload, not just a 200: an empty app list is `[]`.
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it.skipIf(!builtShellExists)(
    "still serves the SPA shell ON the office host (needs ui/dist - run `bun run build:ui`)",
    async () => {
      const srv = await startFlatOffice();
      const member = await srv.seedMember("Deputy");
      const res = await raw(srv.port, {
        host: OFFICE_HOST,
        path: "/",
        headers: { Cookie: `isomux_session=${member.rawSessionId}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain('<div id="root"></div>');
    },
  );

  it("still upgrades a WebSocket ON the office host", async () => {
    const srv = await startFlatOffice();
    const member = await srv.seedMember("Deputy");
    const res = await raw(srv.port, {
      host: OFFICE_HOST,
      path: "/ws",
      headers: {
        ...WS_UPGRADE_HEADERS,
        Origin: HTTPS_ORIGIN,
        Cookie: `isomux_session=${member.rawSessionId}`,
      },
    });
    // A real 101, not the 401/403 an unauthenticated or misrouted upgrade
    // gets, and emphatically not the app arm's 503.
    expect(res.status).toBe(101);
    expect(res.headers["upgrade"]?.toLowerCase()).toBe("websocket");
  });

  // Harness sanity on the loopback host, which is a different code path from
  // the raw upgrade above (Bun's own client, cookie set by the harness).
  it("still accepts a harness WebSocket on the loopback host", async () => {
    const srv = await startFlatOffice();
    const member = await srv.seedMember("Deputy");
    const sock = await srv.connectWs(member.rawSessionId);
    await sock.waitFor("full_state");
    sock.close();
  });

  it("freezes the domain at boot - a later config edit does not reroute", async () => {
    const srv = await startFlatOffice();
    patchOfficeConfig({ publicOrigin: "https://later.example" });
    // The domain this process booted with still diverts...
    expect(
      (await raw(srv.port, { host: `hello.${OFFICE_HOST}`, path: "/readyz" }))
        .status,
    ).toBe(404);
    // ...and the one written underneath it does not exist for this process.
    expect(
      (await raw(srv.port, { host: "hello.later.example", path: "/readyz" }))
        .status,
    ).toBe(200);
  });
});

describe("app hosts: the arm", () => {
  it("serves distinct app favicons only after app authorization", async () => {
    const {
      srv,
      token,
      label: hello,
      rawSessionId,
    } = await anOfficeWithAnApp((active) => {
      server = active;
    });
    const habits = await registerApp(srv, token, "habits");

    const anonymous = await raw(srv.port, {
      host: `${hello}.${OFFICE_HOST}`,
      path: "/favicon.ico",
    });
    expect(anonymous.status).toBe(302);
    const helloCookie = await signIn(srv, hello, rawSessionId);
    const habitsCookie = await signIn(srv, habits, rawSessionId);

    const first = await raw(srv.port, {
      host: `${hello}.${OFFICE_HOST}`,
      path: "/favicon.ico",
      headers: withAppCookie(helloCookie),
    });
    const second = await raw(srv.port, {
      host: `${habits}.${OFFICE_HOST}`,
      path: "/favicon.ico",
      headers: withAppCookie(habitsCookie),
    });
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("image/svg+xml");
    expect(first.body).toContain("&gt;_");
    expect(second.status).toBe(200);
    expect(second.body).not.toBe(first.body);
  });

  it("sends an anonymous caller on a live label into the handshake", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    expect(label).toBe("hello");

    // Slice 4 moved the not-ready placeholder BEHIND the sign-in handshake:
    // reaching it now needs an app session (app-auth-handshake.test.ts drives
    // the whole flow). What this file still pins is that the request was
    // diverted - the answer comes from the arm, not from any office handler.
    const res = await raw(srv.port, {
      host: `${label}.${OFFICE_HOST}`,
      headers: NAVIGATION_HEADERS,
    });
    expectBounce(res, { label, path: "/" }, "live label");
  });

  it("gives an unknown and a RETIRED label the same answer, byte for byte", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    await registerApp(srv, token, "hello");
    await deleteApp(srv, token, "hello");
    // "hello" is retired: in the ledger forever, no live app behind it.
    const retired = await raw(srv.port, { host: `hello.${OFFICE_HOST}` });
    const unknown = await raw(srv.port, {
      host: `never-existed.${OFFICE_HOST}`,
    });
    expectPlaceholder(retired, NOT_FOUND, "retired label");
    expectPlaceholder(unknown, NOT_FOUND, "unknown label");
    // And byte-identical to each other, headers and order included.
    expect(retired.stable).toBe(unknown.stable);
  });

  it("serves a re-registered app on its stable label", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    await registerApp(srv, token, "hello");
    await deleteApp(srv, token, "hello");
    const label = await registerApp(srv, token, "hello");
    expect(label).toBe("hello");

    expect(
      (
        await raw(srv.port, {
          host: `${label}.${OFFICE_HOST}`,
          headers: NAVIGATION_HEADERS,
        })
      ).status,
    ).toBe(302);
  });

  it("404s anything more than one label below the domain", async () => {
    const srv = await startFlatOffice();
    for (const host of [
      `a.b.${OFFICE_HOST}`,
      `a.b.c.${OFFICE_HOST}`,
      `hello.hello.${OFFICE_HOST}`,
    ]) {
      expectPlaceholder(
        await raw(srv.port, { host, path: "/readyz" }),
        NOT_FOUND,
        host,
      );
    }
  });

  it("404s a RESERVED label like any other unknown one", async () => {
    // Reversal recorded 2026-08-06: reserved names do not fall through to the
    // office. An office on HTTPS owns the whole namespace below its host.
    const srv = await startFlatOffice();
    const control = await raw(srv.port, { host: `nope.${OFFICE_HOST}` });
    for (const label of ["www", "api", "mail", "admin"]) {
      const res = await raw(srv.port, { host: `${label}.${OFFICE_HOST}` });
      expectPlaceholder(res, NOT_FOUND, label);
      expect({ label, stable: res.stable }).toEqual({
        label,
        stable: control.stable,
      });
    }
  });

  it("reserves /__isomux on a live app host", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    const host = `${label}.${OFFICE_HOST}`;
    // Reserved: everything under the prefix except the handshake's own GET is
    // the neutral 404, and NOT the not-ready placeholder - the reservation sits
    // ahead of it. `/__isomux/auth` with a bogus code belongs to the handshake
    // and answers its own way, so it is asserted in the slice-4 file.
    for (const path of ["/__isomux", "/__isomux/", "/__isomux/other"]) {
      expectPlaceholder(await raw(srv.port, { host, path }), NOT_FOUND, path);
    }
    // A path that merely starts with the same characters is NOT reserved: it is
    // an ordinary app path, so an anonymous caller is sent to sign in.
    expectBounce(
      await raw(srv.port, {
        host,
        path: "/__isomuxer",
        headers: NAVIGATION_HEADERS,
      }),
      { label, path: "/__isomuxer" },
      "/__isomuxer",
    );
  });

  it("looks the label up BEFORE it looks at the path or the upgrade", async () => {
    const srv = await startFlatOffice();
    const host = `never-existed.${OFFICE_HOST}`;
    const plain = await raw(srv.port, { host });
    const reserved = await raw(srv.port, { host, path: "/__isomux/auth" });
    const upgrade = await raw(srv.port, {
      host,
      path: "/ws",
      headers: WS_UPGRADE_HEADERS,
    });
    // If the reservation or the upgrade branch ran first, one of these would
    // differ - and an unknown host would be leaking which paths are special.
    expect(reserved.stable).toBe(plain.stable);
    expect(upgrade.stable).toBe(plain.stable);
    expect(plain.status).toBe(404);
  });

  it("refuses a WebSocket upgrade instead of handing it to the office", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    const res = await raw(srv.port, {
      host: `${label}.${OFFICE_HOST}`,
      path: "/ws",
      headers: WS_UPGRADE_HEADERS,
    });
    // Not 101, and not the office /ws handler's own "unauthenticated" body: an
    // upgrade on an app host is answered by the app-host arm and nothing else.
    // Since slice 6b the answer to an anonymous one is the app surface's own
    // 401 - which is also the proof the office's WS handler never ran, because
    // that one refuses with a different status line and a different body.
    expectPlaceholder(res, WS_AUTH_REQUIRED, "ws upgrade on a live label");
  });

  it("keeps every office route off an app host, credentials and all", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    const host = `${label}.${OFFICE_HOST}`;
    // A VALID bearer token on an app host reaches nothing: the divert happens
    // before authentication, so credentials buy no office surface here.
    const api = await raw(srv.port, {
      host,
      path: "/api/apps",
      headers: { Authorization: `Bearer ${token}` },
    });
    // Both are sent into the handshake (no Sec-Fetch metadata, so the
    // compatibility arm applies) - and that is still the whole point: the
    // answer comes from the arm, and the office's own handler never ran.
    expectBounce(api, { label, path: "/api/apps" }, "/api/apps on an app host");
    expectBounce(
      await raw(srv.port, { host, path: "/readyz" }),
      { label, path: "/readyz" },
      "/readyz on an app host",
    );
  });

  it("matches an app host through case, a port and a trailing dot", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    for (const host of [
      `${label}.${OFFICE_HOST}`,
      `${label.toUpperCase()}.${OFFICE_HOST.toUpperCase()}`,
      `${label}.${OFFICE_HOST}:8443`,
      `${label}.${OFFICE_HOST}.`,
      `${label}.${OFFICE_HOST}.:8443`,
    ]) {
      // Every spelling reaches the same app AND mints the same canonical
      // handshake URL: the normalized label, never the one as typed.
      expectBounce(
        await raw(srv.port, { host, headers: NAVIGATION_HEADERS }),
        { label, path: "/" },
        host,
      );
    }
  });
});

// The certificate gate (slice 7) against the real server. Its policy is pinned
// in tls-ask.test.ts and its accounting in app-registry.test.ts; what is only
// provable here is WHERE it answers - on the office's own host, ahead of the
// auth wall, and nowhere on an app host.
describe("app hosts: the certificate gate", () => {
  const ask = (name: string) =>
    `/__isomux/tls-ask?domain=${encodeURIComponent(name)}`;

  it("answers on the office host, unauthenticated, for a live label", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    // No session, no bearer: the terminator has no identity to present, which
    // is why this route sits with /readyz rather than behind the wall.
    const res = await raw(srv.port, {
      host: OFFICE_HOST,
      path: ask(`${label}.${OFFICE_HOST}`),
    });
    expect({ status: res.status, body: res.body }).toEqual({
      status: 200,
      body: "ok\n",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("refuses the office's own children that are not apps, and allows the office itself", async () => {
    const srv = await startFlatOffice();
    for (const [name, status] of [
      [`nobody.${OFFICE_HOST}`, 403],
      [`a.b.${OFFICE_HOST}`, 403],
      ["elsewhere.example.com", 403],
      [OFFICE_HOST, 200],
    ] as const) {
      const res = await raw(srv.port, { host: OFFICE_HOST, path: ask(name) });
      expect({ name, status: res.status }).toEqual({ name, status });
    }
  });

  it("refuses a live label once its app is gone", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    await deleteApp(srv, token, "hello");
    // Measured caveat, worth knowing while reading this: the terminator cannot
    // act on this until its own cache misses, so a deleted app's hostname keeps
    // terminating TLS until then. What the office controls is that it stops
    // vouching, immediately.
    const res = await raw(srv.port, {
      host: OFFICE_HOST,
      path: ask(`${label}.${OFFICE_HOST}`),
    });
    expect({ status: res.status, body: res.body }).toEqual({
      status: 403,
      body: "denied\n",
    });
  });

  it("is unreachable on an app host, which sees only the neutral 404", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    // The reserved prefix already covers this, and that is the point: the gate
    // is an office route, and an app host cannot answer it, shadow it, or learn
    // anything from asking.
    expectPlaceholder(
      await raw(srv.port, {
        host: `${label}.${OFFICE_HOST}`,
        path: ask(`${label}.${OFFICE_HOST}`),
      }),
      NOT_FOUND,
      "the certificate gate on an app host",
    );
  });

  it("answers only GET", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    const res = await raw(srv.port, {
      host: OFFICE_HOST,
      method: "POST",
      path: ask(`${label}.${OFFICE_HOST}`),
    });
    // Falls through to the office's ordinary handling of an unknown route,
    // which for an unauthenticated caller is the auth wall - NOT a 2xx.
    expect(res.status).not.toBe(200);
  });
});
