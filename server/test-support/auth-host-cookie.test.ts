// The office session cookie names (task c9f250af, on top of the `__Host-`
// work of phase-3 slice 2).
//
// Each office writes its own names, isomux_session_<office id> and, on HTTPS,
// __Host-isomux_session_<office id>. Browsers scope cookies by host, not by
// port, so with one shared name two offices on one host read and cleared each
// other's cookie. The `__Host-` prefix is browser-enforced to be host-only, so
// a page on a sibling subdomain (`hello.apps.<office>`) cannot shadow it.
//
// The hard constraint this file exists to police: NOBODY GETS SIGNED OUT by a
// move between the office's own two names. The new name is only ever written
// where the deployment can carry it, and the old one is only cleared once its
// replacement has been observed coming back from the browser - and only when
// it carries this office's session.
//
// The shared names every office wrote before task c9f250af were read for one
// release as a fallback; since task aefe1ea8 the office ignores them like any
// other foreign cookie: it never reads, migrates or clears them.

import { mintMemberLink } from "./member-link.ts";
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { createHash } from "crypto";
import {
  startTestServer,
  type TestServer,
  type SeededIdentity,
} from "./harness.ts";
import { builtShellExists } from "./built-ui.ts";
import {
  SHARED_COOKIE_NAME,
  SHARED_HOST_COOKIE_NAME,
  _testResetBrowserSessionDiagnostics,
  browserSessionDiagnostic,
  buildPublicOrigin,
  formatBrowserSessionDiagnostic,
  emitBrowserSessionDiagnostic,
  officeSessionCookieNames,
  readSessionCookies,
  sessionCookieMigrationHeaders,
  validateSession,
  _testSetSessionExpiry,
  type BrowserSessionDiagnostic,
} from "../auth.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";

const HTTPS_ORIGIN = "https://office.example";

function withoutClient(line: string): string {
  return line.replace(/ client=\S+$/, "");
}

let server: TestServer | null = null;
beforeEach(() => {
  _testResetBrowserSessionDiagnostics();
});
afterEach(async () => {
  await server?.stop();
  server = null;
  _testResetBrowserSessionDiagnostics();
});

// Boot an HTTPS-shaped office: enable external access with an https origin
// through the real Access route, then cold-restart so the boot capture picks it
// up (buildPublicOrigin forces the localhost fallback while the process is
// loopback-bound). Same mechanism public-origin-copy.test.ts uses. Returns the
// seeded owner too, because it is the office's ONLY owner - which is what makes
// the sign-out lockout case reachable.
async function startHttps(): Promise<{
  srv: TestServer;
  owner: SeededIdentity;
}> {
  const srv0 = await startTestServer();
  const owner = await srv0.seedOwner("Morgan");
  const r = await srv0.http("/api/office/access", {
    method: "PUT",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalAccess: true, publicOrigin: HTTPS_ORIGIN }),
  });
  if (r.status !== 200) throw new Error(`access PUT failed: ${r.status}`);
  const srv = await srv0.restart();
  if (!buildPublicOrigin().isHttps) {
    throw new Error("expected an https public origin after restart");
  }
  return { srv, owner };
}

async function mintFor(username: string, role: "owner" | "member" = "member") {
  return (await mintMemberLink(username, role)).rawToken;
}

// POST /auth/accept the way a browser does, so we can read the real Set-Cookie.
function acceptViaHttp(srv: TestServer, rawToken: string): Promise<Response> {
  return srv.http("/auth/accept", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(rawToken)}`,
  });
}

function setCookieLines(res: Response): string[] {
  return res.headers.getSetCookie();
}

function cookies(header?: string) {
  return readSessionCookies(
    new Request("https://office.example/api/sessions", {
      headers: header ? { Cookie: header } : undefined,
    }),
  );
}

// A WebSocket upgrade driven over a raw socket, because the point of the
// assertion is the RESPONSE HEADERS on the 101 - which no WebSocket client API
// exposes. Returns the response head (status line + headers), or throws on a
// non-101 so a failed handshake can't masquerade as "no cookie set".
async function rawUpgrade(
  port: number,
  cookieHeader: string,
): Promise<{ status: number; head: string; setCookie: string[] }> {
  const request =
    `GET /ws HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
    `Origin: ${buildPublicOrigin().origin}\r\n` +
    `Cookie: ${cookieHeader}\r\n\r\n`;
  const head = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("upgrade timed out")),
      5000,
    );
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) {
          sock.write(request);
        },
        data(sock, chunk) {
          buf += new TextDecoder().decode(chunk);
          const end = buf.indexOf("\r\n\r\n");
          if (end === -1) return;
          clearTimeout(timer);
          sock.end();
          resolve(buf.slice(0, end));
        },
        error(_sock, err) {
          clearTimeout(timer);
          reject(err);
        },
      },
    }).catch(reject);
  });
  const lines = head.split("\r\n");
  const status = parseInt(lines[0].split(" ")[1] ?? "0", 10);
  const setCookie = lines
    .slice(1)
    .filter((l) => l.toLowerCase().startsWith("set-cookie:"))
    .map((l) => l.slice(l.indexOf(":") + 1).trim());
  return { status, head, setCookie };
}

// The caller's own username as the server resolved it. Members see only their
// own sessions, so this is an identity read: it says WHICH cookie authenticated.
async function whoAmI(srv: TestServer, cookieHeader: string): Promise<string> {
  const res = await srv.http("/api/sessions", {
    headers: { Cookie: cookieHeader },
  });
  if (res.status !== 200) throw new Error(`/api/sessions -> ${res.status}`);
  const body = (await res.json()) as { sessions: { username: string }[] };
  const names = [...new Set(body.sessions.map((s) => s.username))];
  if (names.length !== 1) {
    throw new Error(`ambiguous identity: ${names.join(", ")}`);
  }
  return names[0];
}

// This office's two names, read at call time: the id lives in the state root,
// which every startTestServer() wipes.
const own = () => officeSessionCookieNames();
const SHARED = SHARED_COOKIE_NAME;
const SHARED_HOST = SHARED_HOST_COOKIE_NAME;

function clearOf(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

describe("office cookie names: plain-HTTP office", () => {
  it("login writes the office's plain name, with the pre-slice attribute string and no Secure", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    expect(own().plain).toMatch(/^isomux_session_[0-9a-f]{12}$/);
    const res = await acceptViaHttp(server, await mintFor("Yu"));
    expect(res.status).toBe(302);
    const lines = setCookieLines(res);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^${own().plain}=[^;]+; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+$`,
      ),
    );
  });

  // An office that was on HTTPS and then went back to loopback leaves browsers
  // holding its `__Host-` cookie, which is still read. But the write name comes
  // first: a stale `__Host-` cookie of this office (a session revoked while the
  // office was on HTTPS) cannot be cleared reliably from plain HTTP, so if it
  // won by presence it would hide every new sign-in.
  it("a __Host- cookie left over from an HTTPS past still authenticates, but the plain write name wins over a stale one, in either order", async () => {
    server = await startTestServer();
    expect(buildPublicOrigin().isHttps).toBe(false);
    await server.seedOwner("Morgan");
    const stale = `${own().host}=revoked-session`;
    const accepted = await acceptViaHttp(server, await mintFor("Yu"));
    const issued = setCookieLines(accepted)[0]?.split(";", 1)[0] ?? "";
    expect(issued.startsWith(`${own().plain}=`)).toBe(true);
    const leftover = `${own().host}=${issued.slice(own().plain.length + 1)}`;
    expect(await whoAmI(server, leftover)).toBe("Yu");
    expect(cookies(leftover).selectedName).toBe("host");
    for (const cookie of [`${stale}; ${issued}`, `${issued}; ${stale}`]) {
      expect(await whoAmI(server, cookie)).toBe("Yu");
      expect((await rawUpgrade(server.port, cookie)).status).toBe(101);
      expect(cookies(cookie).selectedName).toBe("plain");
    }
  });
});

describe("office cookie names: HTTPS office", () => {
  it("login writes the office's __Host- name with Secure, Path=/, and no Domain", async () => {
    const { srv } = await startHttps();
    server = srv;
    const res = await acceptViaHttp(server, await mintFor("Yu"));
    expect(res.status).toBe(302);
    const lines = setCookieLines(res);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^${own().host}=[^;]+; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`,
      ),
    );
    // The prefix is only honored without a Domain attribute; a Domain here
    // would make browsers drop the cookie and nobody could sign in.
    expect(lines[0]).not.toContain("Domain");
  });

  it("a present __Host- cookie blocks every fallback: invalid or EMPTY value -> 401, HTTP and WS", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    // Present-but-invalid, and present-but-empty. Both are the request
    // CLAIMING the authoritative name; no other cookie may rescue it.
    for (const bad of [`${own().host}=not-a-session`, `${own().host}=`]) {
      for (const rescue of [
        `${own().plain}=${yu.rawSessionId}`,
        `${SHARED_HOST}=${yu.rawSessionId}`,
        `${SHARED}=${yu.rawSessionId}`,
      ]) {
        const res = await server.http("/api/sessions", {
          headers: { Cookie: `${bad}; ${rescue}` },
        });
        expect(res.status).toBe(401);
        const up = await rawUpgrade(server.port, `${rescue}; ${bad}`);
        expect(up.status).toBe(401);
      }
    }
  });

  it("shadowing: an injected plain or shared cookie for another user cannot displace the __Host- session", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const mallory = await server.seedMember("Mallory");
    const host = `${own().host}=${yu.rawSessionId}`;
    // Mallory's session is entirely valid - it is the NAME that decides.
    for (const name of [own().plain, SHARED_HOST, SHARED]) {
      const injected = `${name}=${mallory.rawSessionId}`;
      expect(await whoAmI(server, `${host}; ${injected}`)).toBe("Yu");
      expect(await whoAmI(server, `${injected}; ${host}`)).toBe("Yu");
    }
    const sock = await server.connectWs(yu.rawSessionId, {
      cookieHeader: `${own().plain}=${mallory.rawSessionId}; ${host}`,
    });
    const ctx = (await sock.waitFor("session_context")) as {
      context: { username: string };
    };
    expect(ctx.context.username).toBe("Yu");
    sock.close();
  });
});

describe("the shared names from before task c9f250af are not read", () => {
  it("any of the office's own names decides, so an invalid own cookie fails closed next to a valid shared one", async () => {
    server = await startTestServer();
    const yu = await server.seedMember("Yu");
    for (const bad of [`${own().plain}=stale`, `${own().host}=stale`]) {
      for (const shared of [SHARED, SHARED_HOST]) {
        const cookie = `${bad}; ${shared}=${yu.rawSessionId}`;
        const res = await server.http("/api/sessions", {
          headers: { Cookie: cookie },
        });
        expect(res.status).toBe(401);
        expect((await rawUpgrade(server.port, cookie)).status).toBe(401);
      }
    }
  });

  it("another office's own names are not read at all", async () => {
    server = await startTestServer();
    const yu = await server.seedMember("Yu");
    for (const name of [
      "isomux_session_0123456789ab",
      "__Host-isomux_session_0123456789ab",
    ]) {
      const cookie = `${name}=${yu.rawSessionId}`;
      expect(cookies(cookie).selectedName).toBeNull();
      const res = await server.http("/api/sessions", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(401);
    }
  });

  // A valid session of THIS office under a shared name: the browser signed in
  // before task c9f250af and did not open the office during the fallback
  // release. It must sign in again.
  const onlyShared = (raw: string) => [
    `${SHARED}=${raw}`,
    `${SHARED_HOST}=${raw}`,
    `${SHARED_HOST}=${raw}; ${SHARED}=${raw}`,
    `${SHARED}=${raw}; ${SHARED_HOST}=${raw}`,
  ];

  it("plain HTTP: a request with only shared names is not signed in, HTTP and WS", async () => {
    server = await startTestServer();
    expect(buildPublicOrigin().isHttps).toBe(false);
    const yu = await server.seedMember("Yu");
    for (const cookie of onlyShared(yu.rawSessionId)) {
      const res = await server.http("/api/sessions", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(401);
      expect((await rawUpgrade(server.port, cookie)).status).toBe(401);
      expect(cookies(cookie).selectedName).toBeNull();
    }
  });

  it("HTTPS: a request with only shared names is not signed in, HTTP and WS", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    for (const cookie of onlyShared(yu.rawSessionId)) {
      const res = await server.http("/api/sessions", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(401);
      expect((await rawUpgrade(server.port, cookie)).status).toBe(401);
      expect(cookies(cookie).selectedName).toBeNull();
    }
  });

  // A parser that matched the shared names into the office's own slots (a
  // prefix match, or isSessionCookieName) would let whichever came first win.
  it("plain HTTP: a valid shared cookie for another user never displaces the office's own name, in either order", async () => {
    server = await startTestServer();
    expect(buildPublicOrigin().isHttps).toBe(false);
    const yu = await server.seedMember("Yu");
    const mallory = await server.seedMember("Mallory");
    const plain = `${own().plain}=${yu.rawSessionId}`;
    for (const name of [SHARED, SHARED_HOST]) {
      const injected = `${name}=${mallory.rawSessionId}`;
      for (const cookie of [`${injected}; ${plain}`, `${plain}; ${injected}`]) {
        expect(await whoAmI(server, cookie)).toBe("Yu");
        expect(cookies(cookie).selectedName).toBe("plain");
      }
    }
  });

  // readSessionCookies only parses. Before this task, a plain-HTTP request
  // with both shared names validated the shared `__Host-` value, and a
  // validation of an expired session drops its row.
  it("parsing never touches the session store: an expired session under a shared name keeps its row", async () => {
    server = await startTestServer();
    expect(buildPublicOrigin().isHttps).toBe(false);
    const yu = await server.seedMember("Yu");
    expect(
      _testSetSessionExpiry(yu.rawSessionId, { expiresAt: Date.now() - 1 }),
    ).toBe(true);
    const parsed = cookies(
      `${SHARED_HOST}=${yu.rawSessionId}; ${SHARED}=another-session`,
    );
    // True only while the row is still in the store.
    expect(
      _testSetSessionExpiry(yu.rawSessionId, {
        expiresAt: Date.now() + 60_000,
      }),
    ).toBe(true);
    expect(parsed.selectedName).toBeNull();
  });
});

describe("browser session lockout diagnostics", () => {
  it("a shared name alone reads as an absent cookie, never counts as overridden, and the office's own names stay silent", async () => {
    server = await startTestServer();
    const member = await server.seedMember("Yu");
    const raw = member.rawSessionId;
    for (const name of [SHARED, SHARED_HOST]) {
      const parsed = cookies(`${name}=${raw}`);
      const lookup = validateSession(parsed.selected || null);
      expect(browserSessionDiagnostic(parsed, lookup, "http")).toEqual({
        outcome: "cookie_absent",
        gate: "http",
      });
    }
    // A rejected own cookie next to shared names overrides nothing the
    // office reads.
    const rejected = cookies(
      `${own().plain}=not-a-session; ${SHARED}=${raw}; ${SHARED_HOST}=${raw}`,
    );
    expect(
      browserSessionDiagnostic(
        rejected,
        validateSession(rejected.selected || null),
        "http",
      ),
    ).toMatchObject({
      outcome: "cookie_rejected",
      selected: "plain",
      othersPresent: false,
    });
    for (const name of [own().plain, own().host]) {
      const parsed = cookies(`${name}=${raw}; ${SHARED}=${raw}`);
      const lookup = validateSession(parsed.selected || null);
      expect(lookup).not.toBeNull();
      expect(browserSessionDiagnostic(parsed, lookup, "http")).toBeNull();
    }
  });

  it("reports a rejected __Host cookie overriding a valid plain cookie", async () => {
    const { srv } = await startHttps();
    server = srv;
    const member = await server.seedMember("Yu");
    const parsed = cookies(
      `${own().host}=not-a-session; ${own().plain}=${member.rawSessionId}`,
    );
    const lookup = validateSession(parsed.selected || null);
    expect(lookup).toBeNull();
    const diagnostic = browserSessionDiagnostic(parsed, lookup, "http");
    // The marker is the first 6 hex chars of SHA-256 of the selected cookie:
    // non-reversible, and never the cookie value (approved by Nil 2026-08-16).
    const expectedMarker = createHash("sha256")
      .update("not-a-session")
      .digest("hex")
      .slice(0, 6);
    expect(diagnostic).toEqual({
      outcome: "cookie_rejected",
      gate: "http",
      selected: "host",
      othersPresent: true,
      marker: expectedMarker,
    });
    const line = formatBrowserSessionDiagnostic(
      diagnostic!,
      new Request("https://office.example/api/sessions", {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
        },
      }),
    );
    // The fields an operator greps for, each as its own key=value token.
    const fields = line.split(" ");
    for (const field of [
      "selected=__Host",
      "others_overridden=yes",
      `marker=${expectedMarker}`,
      "gate=http",
      "path=/api/sessions",
      "client=Chrome/Windows",
    ]) {
      expect(fields).toContain(field);
    }
    expect(line).not.toContain("not-a-session");
    expect(line).not.toContain(member.rawSessionId);
  });

  it("redacts a live invite credential from a real HEAD diagnostic", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const token = "LIVE-INVITE-CREDENTIAL";
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      _testResetBrowserSessionDiagnostics();
      const response = await server.http(`/i/${token}`, { method: "HEAD" });
      expect(response.status).toBe(401);
      const line = lines.find((entry) => entry.includes("path=/i/")) ?? "";
      expect(line).toContain("path=/i/<redacted>");
      expect(line).not.toContain(token);
    } finally {
      console.log = original;
    }
  });

  it("wires diagnostics through the real HTTP and WebSocket gates", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const ownerLookup = validateSession(owner.rawSessionId);
    expect(ownerLookup).not.toBeNull();
    // The line each gate should log, built by the formatter (pinned above)
    // and compared without the client family, which names the test runtime.
    const expected = (diagnostic: BrowserSessionDiagnostic, path: string) =>
      withoutClient(
        formatBrowserSessionDiagnostic(
          diagnostic,
          new Request(`https://office.example${path}`),
        ),
      );
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      _testResetBrowserSessionDiagnostics();
      const rejected = await server.http("/api/sessions");
      expect(rejected.status).toBe(401);
      expect(lines.map(withoutClient)).toContain(
        expected({ outcome: "cookie_absent", gate: "http" }, "/api/sessions"),
      );

      _testResetBrowserSessionDiagnostics();
      lines.length = 0;
      const upgraded = await rawUpgrade(
        server.port,
        `${own().plain}=${owner.rawSessionId}`,
      );
      expect(upgraded.status).toBe(101);
      expect(lines.map(withoutClient)).toContain(
        expected(
          {
            outcome: "session_matched",
            gate: "ws",
            selected: "plain",
            sessionPrefix: ownerLookup!.sessionPrefix,
          },
          "/ws",
        ),
      );
    } finally {
      console.log = original;
    }
  });

  it("dedupes repeated keys, admits distinct keys, and resets after the window", () => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      const diagnostic = { outcome: "cookie_absent", gate: "http" } as const;
      const same = new Request("https://office.example/diagnostic-test-one");
      emitBrowserSessionDiagnostic(diagnostic, same, 1);
      emitBrowserSessionDiagnostic(diagnostic, same, 2);
      emitBrowserSessionDiagnostic(
        diagnostic,
        new Request("https://office.example/diagnostic-test-two"),
        3,
      );
      const relevant = () =>
        lines.filter((line) => line.includes("path=/diagnostic-test-"));
      expect(relevant()).toHaveLength(2);
      emitBrowserSessionDiagnostic(diagnostic, same, 60_001);
      expect(relevant()).toHaveLength(3);
    } finally {
      console.log = original;
    }
  });

  it("emits one notice when the diagnostic key window reaches its cap", () => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      const diagnostic = { outcome: "cookie_absent", gate: "http" } as const;
      for (let i = 0; i < 258; i++) {
        emitBrowserSessionDiagnostic(
          diagnostic,
          new Request(`https://office.example/cap-test-${i}`),
          1,
        );
      }
      // 256 distinct keys are admitted, then exactly one notice, then silence.
      const admitted = lines.filter((line) => line.includes("path=/cap-test-"));
      expect(admitted).toHaveLength(256);
      expect(lines).toHaveLength(257);
      expect(lines[256]).not.toContain("path=/cap-test-");
    } finally {
      console.log = original;
    }
  });
});

describe("migration onto the office's write name", () => {
  it.skipIf(!builtShellExists)(
    "step 1 on the shell: a session under the office's other name gets the same id under the write name, nothing cleared (needs ui/dist - run `bun run build:ui`)",
    async () => {
      server = await startTestServer();
      expect(buildPublicOrigin().isHttps).toBe(false);
      await server.seedOwner("Morgan");
      const yu = await server.seedMember("Yu");
      // A plain-HTTP office that was on HTTPS before: the browser still
      // holds the office's `__Host-` name.
      const res = await server.http("/", {
        headers: { Cookie: `${own().host}=${yu.rawSessionId}` },
      });
      expect(res.status).toBe(200);
      const lines = setCookieLines(res);
      expect(lines.length).toBe(1);
      // Same session id: a migration re-issues, it never mints.
      expect(lines[0]).toStartWith(`${own().plain}=${yu.rawSessionId};`);
      expect(lines[0]).not.toContain("Secure");
      // Nothing is cleared yet - the browser has not shown us it accepted
      // this.
      expect(lines[0]).not.toContain("Max-Age=0");
      // Anchored to the session's ABSOLUTE cap (1 year), the same moment the
      // original cookie was anchored to - not the 30-day rolling expiry,
      // which would quietly shorten the session, and not a fresh year, which
      // would quietly extend it.
      const maxAge = parseInt(/Max-Age=(\d+)/.exec(lines[0])?.[1] ?? "0", 10);
      const day = 24 * 60 * 60;
      expect(maxAge).toBeGreaterThan(364 * day);
      expect(maxAge).toBeLessThanOrEqual(365 * day);
      // A shared name is not read, so nothing moves onto the office's name.
      for (const name of [SHARED, SHARED_HOST]) {
        const shared = await server.http("/", {
          headers: { Cookie: `${name}=${yu.rawSessionId}` },
        });
        expect(setCookieLines(shared)).toEqual([]);
      }
    },
  );

  it("HTTPS: the office's plain name upgrades to its __Host- name; a shared name is signed out and gets no cookie", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const get = await server.http("/api/sessions", {
      headers: { Cookie: `${own().plain}=${yu.rawSessionId}` },
    });
    expect(get.status).toBe(200);
    const lines = setCookieLines(get);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^${own().host}=${yu.rawSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`,
      ),
    );
    for (const name of [SHARED, SHARED_HOST]) {
      const shared = await server.http("/api/sessions", {
        headers: { Cookie: `${name}=${yu.rawSessionId}` },
      });
      expect(shared.status).toBe(401);
      expect(setCookieLines(shared)).toEqual([]);
    }
  });

  it("step 2: once the write name comes back, the office's other name with the SAME value is cleared, and a shared name never", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const raw = yu.rawSessionId;
    const host = `${own().host}=${raw}`;
    // A browser in the middle of the fallback release's two-step can still
    // hold shared names equal to its session. The office no longer reads
    // them, so it does not clear them either.
    const all = await server.http("/api/sessions", {
      headers: {
        Cookie: `${host}; ${own().plain}=${raw}; ${SHARED_HOST}=${raw}; ${SHARED}=${raw}`,
      },
    });
    expect(all.status).toBe(200);
    expect(setCookieLines(all)).toEqual([clearOf(own().plain, true)]);
    const sharedOnly = await server.http("/api/sessions", {
      headers: { Cookie: `${host}; ${SHARED_HOST}=${raw}; ${SHARED}=${raw}` },
    });
    expect(sharedOnly.status).toBe(200);
    expect(setCookieLines(sharedOnly)).toEqual([]);
    // A cookie with another value stays.
    const foreign = await server.http("/api/sessions", {
      headers: { Cookie: `${host}; ${own().plain}=another-session` },
    });
    expect(foreign.status).toBe(200);
    expect(setCookieLines(foreign)).toEqual([]);
    // A session already fully on the write name is left entirely alone.
    const done = await server.http("/api/sessions", {
      headers: { Cookie: host },
    });
    expect(setCookieLines(done)).toEqual([]);
  });

  it("rides the WS 101 - the seam an already-open tab reaches without reloading", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const raw = yu.rawSessionId;

    // Asserted on the RAW 101 response head: name, value, attributes, and that
    // it is one independent Set-Cookie field line. A WebSocket client cannot
    // show us this - its API exposes no response headers - so the handshake is
    // driven over a plain socket.
    const upgrade = await rawUpgrade(server.port, `${own().plain}=${raw}`);
    expect(upgrade.status).toBe(101);
    expect(upgrade.setCookie.length).toBe(1);
    expect(upgrade.setCookie[0]).toMatch(
      new RegExp(
        `^${own().host}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`,
      ),
    );

    const retire = await rawUpgrade(
      server.port,
      `${own().host}=${raw}; ${own().plain}=${raw}; ${SHARED}=${raw}`,
    );
    expect(retire.status).toBe(101);
    expect(retire.setCookie).toEqual([clearOf(own().plain, true)]);

    const foreign = await rawUpgrade(
      server.port,
      `${own().host}=${raw}; ${own().plain}=another-session`,
    );
    expect(foreign.status).toBe(101);
    expect(foreign.setCookie).toEqual([]);

    const settled = await rawUpgrade(server.port, `${own().host}=${raw}`);
    expect(settled.status).toBe(101);
    expect(settled.setCookie).toEqual([]);
  });

  it("rides a safe /api GET, never an unsafe method, never a bearer caller", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const plain = `${own().plain}=${yu.rawSessionId}`;

    const get = await server.http("/api/sessions", {
      headers: { Cookie: plain },
    });
    expect(get.status).toBe(200);
    expect(setCookieLines(get).length).toBe(1);
    expect(setCookieLines(get)[0]).toStartWith(`${own().host}=`);

    // An unsafe method could be revoking the very session we would re-issue
    // (DELETE /api/sessions/current), so migration never rides one.
    const del = await server.http("/api/sessions/current", {
      method: "DELETE",
      headers: { Cookie: plain },
    });
    expect(del.status).toBe(204);
    expect(setCookieLines(del)).toEqual([]);

    // A bearer caller with an unrelated cookie in its jar is authenticated by
    // the TOKEN; the cookie is incidental and must not be migrated or cleared.
    const other = await server.seedMember("Ann");
    const agent = await server.agentManager.spawn(
      "Worker",
      server.stateRoot,
      "default",
      undefined,
      undefined,
      server.agentManager.getRooms()[0].id,
      undefined,
      undefined,
      undefined,
      undefined,
      "claude",
    );
    if (!agent) throw new Error("spawn returned null");
    // Deliberately a route that DOES carry the migration seam (safe /api GET),
    // so the assertion is about the bearer, not about an unwrapped path.
    const bearer = await server.http("/api/tasks", {
      headers: {
        Authorization: `Bearer ${getAgentTokenRaw(agent.id)}`,
        Cookie: `${own().plain}=${other.rawSessionId}`,
      },
    });
    expect(bearer.status).toBe(200);
    expect(setCookieLines(bearer)).toEqual([]);
  });

  it("migrates nothing for a selected cookie that is not the session the caller authenticated", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const ann = await server.seedMember("Ann");
    const annLookup = validateSession(ann.rawSessionId)!;
    expect(annLookup).not.toBeNull();
    for (const cookie of [
      `${own().plain}=${yu.rawSessionId}`,
      `${own().host}=${yu.rawSessionId}; ${own().plain}=${yu.rawSessionId}`,
    ]) {
      expect(sessionCookieMigrationHeaders(cookies(cookie), annLookup)).toEqual(
        [],
      );
    }
  });
});

describe("sign-out", () => {
  it("clears the office's two names, and never a shared name", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const raw = yu.rawSessionId;
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: `${own().host}=${raw}; ${SHARED_HOST}=${raw}; ${SHARED}=another-session`,
      },
    });
    expect(res.status).toBe(302);
    // Independent retrievable lines, not one comma-folded string.
    expect(setCookieLines(res)).toEqual([
      clearOf(own().plain, true),
      clearOf(own().host, true),
    ]);
  });

  // Plain HTTP: both of the office's names are cleared on every deployment
  // (an HTTPS past leaves a `__Host-` cookie that is still read), and the
  // `__Host-` clear carries Secure so a browser honors it.
  it("a sign-out through a shared name revokes nothing and clears only the office's names", async () => {
    server = await startTestServer();
    expect(buildPublicOrigin().isHttps).toBe(false);
    await server.seedOwner("Morgan");
    const yu = await server.seedMember("Yu");
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: `${SHARED}=${yu.rawSessionId}` },
    });
    expect(res.status).toBe(302);
    expect(await whoAmI(server, `${own().plain}=${yu.rawSessionId}`)).toBe(
      "Yu",
    );
    expect(setCookieLines(res)).toEqual([
      clearOf(own().plain, false),
      clearOf(own().host, true),
    ]);
  });

  it("revokes only the SELECTED session server-side, and a lockout-blocked sign-out revokes and clears nothing", async () => {
    const { srv, owner } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const ann = await server.seedMember("Ann");
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: {
        // Two different LIVE sessions. Name precedence picks Yu's.
        Cookie: `${own().host}=${yu.rawSessionId}; ${own().plain}=${ann.rawSessionId}`,
      },
    });
    expect(res.status).toBe(302);
    const gone = await server.http("/api/sessions", {
      headers: { Cookie: `${own().host}=${yu.rawSessionId}` },
    });
    expect(gone.status).toBe(401);
    // Ann's, which the same response merely stopped SENDING, is alive.
    expect(await whoAmI(server, `${own().host}=${ann.rawSessionId}`)).toBe(
      "Ann",
    );

    // The office's ONLY owner: signing it out would leave the office
    // unreachable, so the route refuses - and must not touch the cookies of a
    // session it did not revoke.
    const ownerCookie = `${own().host}=${owner.rawSessionId}`;
    const blocked = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: ownerCookie },
    });
    expect(blocked.status).toBe(409);
    expect(setCookieLines(blocked)).toEqual([]);
    const still = await server.http("/api/sessions", {
      headers: { Cookie: ownerCookie },
    });
    expect(still.status).toBe(200);
  });
});
