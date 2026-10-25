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
// The grammar itself (normalization, label matching, the derived domain) is
// owned by app-hosts.test.ts and app-domain.test.ts; this file pins only what
// the real server adds on top of it.
//
// Raw sockets, not fetch, for the byte-exact comparisons: fetch normalizes
// header order and cannot send an arbitrary Host.

import { describe, it, expect, afterEach } from "bun:test";
import { createHmac } from "crypto";
import { type TestServer } from "./harness.ts";
import { startTestServer } from "./harness.ts";
import { appRegistrationGeneration, appRegistry } from "../app-registry.ts";
import {
  HTTPS_ORIGIN,
  NAVIGATION_HEADERS,
  expectAuthRequired,
  expectBounce,
  NOT_FOUND,
  OFFICE_HOST,
  WS_UPGRADE_HEADERS,
  anAgentToken,
  anOfficeWithAnApp,
  deleteApp,
  expectPlaceholder,
  patchOfficeConfig,
  raw,
  rawFramingCompletion,
  type RawResponse,
  registerApp,
  signIn,
  startFlatOffice as bootFlatOffice,
  withAppCookie,
  wsConnect,
} from "./app-host-test-kit.ts";
import { sessionCookieName } from "../auth.ts";
import { webhookRegistry } from "../webhooks/registry.ts";
import { MALFORMED_HOSTS } from "./bad-host.ts";

let server: TestServer | null = null;

// Requests whose answer on an app host does not contain the label: everything
// that is refused rather than bounced to the office's mint URL.
const LABEL_FREE_SHAPES: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}[] = [
  { headers: { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } },
  { method: "POST", headers: { "Content-Length": "0" } },
  { method: "HEAD" },
  { path: "/ws", headers: WS_UPGRADE_HEADERS },
  { path: "/__isomux/auth" },
  { path: "/__isomux/auth?code=bogus" },
  { path: "/__isomux/other" },
];

// Every request shape a caller with no app session can send, including the
// ones bounced to the mint URL, which carries the label.
const ALL_SHAPES = [
  ...LABEL_FREE_SHAPES,
  {},
  { headers: NAVIGATION_HEADERS },
  { path: "/page?x=1", headers: NAVIGATION_HEADERS },
  { path: "/favicon.ico", headers: NAVIGATION_HEADERS },
  { headers: { ...NAVIGATION_HEADERS, ...withAppCookie("stale") } },
];
afterEach(async () => {
  await server?.stop();
  server = null;
});

// The instrument itself, failing closed: raw() resolves on the first chunk
// this classifies as complete, so a premature "complete" would hand the
// byte-exact comparisons below a truncated response that can still compare
// equal to another truncated one.
describe("raw HTTP completion", () => {
  it("completes only a fully framed response", () => {
    const complete = (text: string) => rawFramingCompletion(Buffer.from(text));
    expect(
      complete("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na"),
    ).toBeNull();
    expect(complete("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nab")).toBe(
      "content-length",
    );
    const chunked =
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n";
    expect(complete(chunked)).toBeNull();
    expect(complete(`${chunked}0\r\nX-Test: yes\r\n\r\n`)).toBe(
      "chunked-terminator",
    );
    expect(complete("HTTP/1.1 200 OK\r\n\r\nbody")).toBeNull();
  });
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
  it("is inert on plain HTTP and on a tailnet office, which is on HTTPS and still has no domain", async () => {
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
    const owner = await before.seedOwner("Morgan");
    const token = await anAgentToken(before);
    expect(await registerApp(before, token, "hello")).toBe("hello");

    // The plain-HTTP office never opted in: the very hosts the arm would
    // answer are indistinguishable from any other Host, i.e. the office.
    const control = await raw(before.port, {
      host: "localhost",
      path: "/readyz",
    });
    expect(control.status).toBe(200);
    const hosts = [TAILNET_HOST, `hello.${TAILNET_HOST}`];
    const baseline: Record<string, RawResponse> = {};
    for (const host of [
      `hello.${OFFICE_HOST}`,
      OFFICE_HOST,
      `a.b.${OFFICE_HOST}`,
      ...hosts,
    ]) {
      baseline[host] = await raw(before.port, { host, path: "/readyz" });
      expect({ host, stable: baseline[host].stable }).toEqual({
        host,
        stable: control.stable,
      });
    }
    expect(control.headers["strict-transport-security"]).toBeUndefined();
    expect(control.headers["content-security-policy"]).not.toContain(
      "upgrade-insecure-requests",
    );

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

  // The regression pin, in its strongest valid form: measure every non-app
  // Host on an HTTP office with NO app-host domain, turn HTTPS + app hostnames
  // on, and require every response byte OTHER THAN the origin-dependent CSP
  // and HSTS headers to stay identical. The two excluded headers are asserted
  // separately in both states, including the app-preview wildcard.
  //
  // The malformed Hosts are outside the domain too: with the arm on, they
  // still get the office's 400 (production-errors.test.ts), not the app 404.
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
    ...MALFORMED_HOSTS,
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
    const owner = await before.seedOwner("Morgan");
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
    expectBounce(
      await raw(after.port, { host: `hello.${OFFICE_HOST}`, path: "/readyz" }),
      { label: "hello", path: "/readyz" },
      "app host after the restart",
    );

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

  // This sends Host: office.example DELIBERATELY. The harness's own
  // http()/connectWs() go to 127.0.0.1, so they would only ever prove that a
  // host OUTSIDE the domain falls through - which is not the interesting
  // claim. The office host is the one name a classification bug would eat,
  // and it is one character away from every app host. Its case, port and
  // trailing-dot spellings normalize to the same name (app-hosts.test.ts), so
  // they cannot divert unless this one does.
  it("still serves an authenticated API route and a WebSocket ON the office host", async () => {
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

    // The office's own /ws, with the office's Host (the harness sockets send
    // a loopback Host, which the arm never looks at): a real 101.
    const member = await srv.seedMember("Deputy");
    const ws = await wsConnect(srv.port, {
      host: OFFICE_HOST,
      path: "/ws",
      origin: HTTPS_ORIGIN,
      headers: { Cookie: `${sessionCookieName()}=${member.rawSessionId}` },
    });
    expect(ws.ok ? "upgraded" : ws.response.status).toBe("upgraded");
    if (ws.ok) ws.client.drop();
  });

  it("freezes the domain at boot - a later config edit does not reroute", async () => {
    const srv = await startFlatOffice();
    patchOfficeConfig({ publicOrigin: "https://later.example" });
    // The domain this process booted with still diverts...
    expectBounce(
      await raw(srv.port, { host: `hello.${OFFICE_HOST}`, path: "/readyz" }),
      { label: "hello", path: "/readyz" },
      "booted domain",
    );
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

  it("gives an anonymous caller the same answer for a live, retired, reused, unknown or reserved label", async () => {
    // A caller with no app session must not learn whether a label is live, was
    // ever issued, or was issued again (security finding F9), by any method,
    // path, protocol or stale cookie. "This label used to be somebody's app" is
    // not the internet's business.
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    const host = `${label}.${OFFICE_HOST}`;
    const answers = async (): Promise<RawResponse[]> => {
      const out: RawResponse[] = [];
      for (const shape of ALL_SHAPES)
        out.push(await raw(srv.port, { host, ...shape }));
      return out;
    };

    const live = await answers();
    await deleteApp(srv, token, "hello");
    // "hello" is retired: in the ledger forever, no live app behind it.
    const retired = await answers();
    for (const [i, shape] of ALL_SHAPES.entries()) {
      // Byte-identical, headers and order included.
      expect({ shape, stable: retired[i].stable }).toEqual({
        shape,
        stable: live[i].stable,
      });
    }

    // A label never issued answers the same, wherever the answer carries no
    // label. So does a name the registry reserves: reserved names do NOT fall
    // through to the office (reversal recorded 2026-08-06) - an office on
    // HTTPS owns the whole namespace below its host, and an exception list
    // would only cover the names we guessed.
    for (const shape of LABEL_FREE_SHAPES) {
      const i = ALL_SHAPES.indexOf(shape);
      for (const other of ["never-existed", "www", "api"]) {
        const res = await raw(srv.port, {
          host: `${other}.${OFFICE_HOST}`,
          ...shape,
        });
        expect({ other, shape, stable: res.stable }).toEqual({
          other,
          shape,
          stable: retired[i].stable,
        });
      }
    }

    // Registered again: the label is the same and the registration generation
    // is newer. The no-session answer must not depend on that either, and in
    // particular carries no Clear-Site-Data (PM ruling, 2026-10-03).
    expect(await registerApp(srv, token, "hello")).toBe(label);
    const record = appRegistry.get("hello");
    if (!record) throw new Error("hello is not registered");
    expect(appRegistrationGeneration(record)).toBeGreaterThan(record.hostGen);
    const reused = await answers();
    for (const [i, shape] of ALL_SHAPES.entries()) {
      expect({
        shape,
        hasClear: "clear-site-data" in reused[i].headers,
        stable: reused[i].stable,
      }).toEqual({ shape, hasClear: false, stable: retired[i].stable });
    }
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

  // A label that fails the hostname rules can never name an app, but it is
  // still below the office host, which owns that namespace. A wildcard
  // certificate lets a browser reach it, so it must not get the office.
  it("404s a malformed label below the domain, and leaves the office host alone", async () => {
    const srv = await startFlatOffice();
    for (const host of [
      `under_score.${OFFICE_HOST}`,
      `${"a".repeat(64)}.${OFFICE_HOST}`,
      `-lead.${OFFICE_HOST}`,
      `trail-.${OFFICE_HOST}`,
      `a.under_score.${OFFICE_HOST}`,
      // The FQDN spelling, with one trailing dot and with more.
      `under_score.${OFFICE_HOST}.`,
      `under_score.${OFFICE_HOST}..`,
      `hello.${OFFICE_HOST}:abc`,
    ]) {
      expectPlaceholder(
        await raw(srv.port, { host, path: "/readyz" }),
        NOT_FOUND,
        host,
      );
    }
    // The limits themselves still route: a 63-character label is an app host.
    const longest = "a".repeat(63);
    expectBounce(
      await raw(srv.port, {
        host: `${longest}.${OFFICE_HOST}`,
        path: "/readyz",
      }),
      { label: longest, path: "/readyz" },
      "63-character label",
    );
    // The office host, also in a malformed spelling, and a malformed name
    // outside the domain still reach the office.
    for (const host of [
      OFFICE_HOST,
      `${OFFICE_HOST}..`,
      `under_score.not${OFFICE_HOST}`,
    ]) {
      const res = await raw(srv.port, { host, path: "/readyz" });
      expect({ host, status: res.status, body: res.body.trim() }).toEqual({
        host,
        status: 200,
        body: "ok",
      });
    }
  });

  // Anyone can send a malformed Host, and the server parses it before any
  // check of who is asking. The parse must be linear in the header: a
  // backtracking pattern over a long run of dots holds the event loop for the
  // whole office. Bun takes a Host of about 16 KB. Ten requests at that size
  // took over 4 s with a quadratic parse (2026-10-23) and well under 100 ms
  // with a linear one, so the bound below is far from both.
  it("answers a malformed Host of maximum size without stalling", async () => {
    const srv = await startFlatOffice();
    const host = `${".".repeat(16_000)}a.${OFFICE_HOST}`;
    const started = performance.now();
    for (let i = 0; i < 10; i++) {
      expectPlaceholder(
        await raw(srv.port, { host, path: "/readyz" }),
        NOT_FOUND,
        "16 KB Host",
      );
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps every office route off an app host, credentials and all", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    // A VALID bearer token on an app host reaches nothing: the divert happens
    // before authentication, so credentials buy no office surface here. It is
    // sent into the handshake (no Sec-Fetch metadata, so the compatibility arm
    // applies): the answer comes from the arm, and the office's own handler
    // never ran.
    expectBounce(
      await raw(srv.port, {
        host: `${label}.${OFFICE_HOST}`,
        path: "/api/apps",
        headers: { Authorization: `Bearer ${token}` },
      }),
      { label, path: "/api/apps" },
      "/api/apps on an app host",
    );
    // A signed delivery to a live hook gets the arm's refusal, not the webhook
    // handler's verdict, and writes no delivery row.
    const made = await srv.http("/api/webhooks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "hook",
        scheme: "github-hmac-sha256",
        rules: [{ event: "*" }],
      }),
    });
    expect(made.status).toBe(201);
    const { id: hookId } = (await made.json()) as { id: string };
    const signature = createHmac("sha256", webhookRegistry.readSecret(hookId)!)
      .update(new Uint8Array(0))
      .digest("hex");
    expectAuthRequired(
      await raw(srv.port, {
        host: `${label}.${OFFICE_HOST}`,
        path: `/hooks/${hookId}`,
        method: "POST",
        headers: {
          "Content-Length": "0",
          "X-GitHub-Event": "pull_request",
          "X-Hub-Signature-256": `sha256=${signature}`,
        },
      }),
      "/hooks/:id on an app host",
    );
    expect(webhookRegistry.readDeliveries(hookId, 10)).toEqual([]);
  });

  it("matches an app host through case, a port and a trailing dot", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    // The canonicalization matrix is in app-hosts.test.ts; this is the wiring.
    for (const host of [
      `${label}.${OFFICE_HOST}`,
      `${label.toUpperCase()}.${OFFICE_HOST.toUpperCase()}.:8443`,
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
// auth wall, from the live registry, and nowhere on an app host.
describe("app hosts: the certificate gate", () => {
  const ask = (name: string) =>
    `/__isomux/tls-ask?domain=${encodeURIComponent(name)}`;

  it("answers on the office host, unauthenticated, from the live registry, and never on an app host", async () => {
    const srv = await startFlatOffice();
    const token = await anAgentToken(srv);
    const label = await registerApp(srv, token, "hello");
    const appName = `${label}.${OFFICE_HOST}`;
    // No session, no bearer: the terminator has no identity to present, which
    // is why this route sits with /readyz rather than behind the wall. It
    // proceeds only on a 2xx.
    const live = await raw(srv.port, { host: OFFICE_HOST, path: ask(appName) });
    expect({
      status: live.status,
      cacheControl: live.headers["cache-control"],
    }).toEqual({ status: 200, cacheControl: "no-store" });
    // Only a GET is the gate. Any other method falls through to the auth
    // wall, so it can never vouch for a name.
    const posted = await raw(srv.port, {
      host: OFFICE_HOST,
      method: "POST",
      path: ask(appName),
      headers: { "Content-Length": "0" },
    });
    expect(posted.status).toBe(401);

    // The gate is an office route: an app host cannot answer it, shadow it,
    // or learn anything from asking - the reserved prefix's neutral 404.
    expectPlaceholder(
      await raw(srv.port, { host: appName, path: ask(appName) }),
      NOT_FOUND,
      "the certificate gate on an app host",
    );

    await deleteApp(srv, token, "hello");
    // Measured caveat, worth knowing while reading this: the terminator cannot
    // act on this until its own cache misses, so a deleted app's hostname keeps
    // terminating TLS until then. What the office controls is that it stops
    // vouching, immediately.
    const gone = await raw(srv.port, { host: OFFICE_HOST, path: ask(appName) });
    expect(gone.status).toBe(403);
  });
});
