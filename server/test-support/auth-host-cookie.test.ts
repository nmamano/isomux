// The office session cookie under the `__Host-` prefix (phase-3 slice 2).
//
// Why the prefix: once registered apps answer on subdomains of the office
// host, a page on `hello.apps.<office>` can set `isomux_session` with
// `Domain=<office>` and shadow the office's own cookie. The `__Host-` prefix
// is browser-enforced to be host-only, so a sibling subdomain cannot write it.
//
// The hard constraint this file exists to police is the other direction: NOBODY
// GETS LOGGED OUT. Both names are read everywhere, the new name is only ever
// written where the deployment can carry it (HTTPS), and the legacy cookie is
// only cleared once its replacement has been observed coming back from the
// browser. So there are two arms throughout:
//
//   - plain-HTTP (the default harness boot, and every loopback install):
//     byte-identical to the behavior before this slice.
//   - HTTPS (external access on + an https publicOrigin, reached through the
//     real Access route + a cold restart, since the signal is boot-frozen):
//     writes and migrates onto `__Host-`.

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { createHash } from "crypto";
import {
  startTestServer,
  type TestServer,
  type SeededIdentity,
} from "./harness.ts";
import {
  COOKIE_NAME,
  HOST_COOKIE_NAME,
  _testResetBrowserSessionDiagnostics,
  browserSessionDiagnostic,
  buildPublicOrigin,
  formatBrowserSessionDiagnostic,
  emitBrowserSessionDiagnostic,
  listActiveSessions,
  mintInvite,
  readSessionCookies,
  validateSession,
} from "../auth.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";

const HTTPS_ORIGIN = "https://office.example";

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
  const owner = await srv0.seedOwner("Boss");
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
  const mint = await mintInvite({
    username,
    role,
    createdBy: null,
    allowExisting: false,
  });
  if (!mint.ok) throw new Error(`mint failed: ${mint.error}`);
  return mint.rawToken;
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

describe("__Host- cookie: plain-HTTP arm is unchanged", () => {
  it("login writes the legacy name with the pre-slice attribute string and no Secure", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const res = await acceptViaHttp(server, await mintFor("Yu"));
    expect(res.status).toBe(302);
    const lines = setCookieLines(res);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(
      /^isomux_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/,
    );
  });

  it("no migration anywhere: shell, safe /api GET, and the WS 101 set no cookie", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const cookie = `${COOKIE_NAME}=${owner.rawSessionId}`;

    const shell = await server.http("/", { headers: { Cookie: cookie } });
    expect(shell.status).toBe(200);
    expect(setCookieLines(shell)).toEqual([]);

    const api = await server.http("/api/sessions", {
      headers: { Cookie: cookie },
    });
    expect(api.status).toBe(200);
    expect(setCookieLines(api)).toEqual([]);

    const up = await rawUpgrade(server.port, cookie);
    expect(up.status).toBe(101);
    expect(up.setCookie).toEqual([]);
  });

  // The one place a plain-HTTP office does NOT behave exactly as before, and
  // deliberately: an office that was on HTTPS and then went back to loopback
  // leaves browsers holding a `__Host-` cookie, which is still read. Signing
  // out has to clear the cookie it might be authenticating with.
  it("logout clears BOTH names, and the __Host- clear carries Secure so the browser honors it", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Yu");
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: `${COOKIE_NAME}=${member.rawSessionId}` },
    });
    expect(res.status).toBe(302);
    expect(setCookieLines(res)).toEqual([
      "isomux_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      "__Host-isomux_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);
  });

  it("a __Host- cookie left over from an HTTPS past still authenticates, and signing out clears it", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const yu = await server.seedMember("Yu");
    // Dual-read does not care which arm the office is on today.
    expect(await whoAmI(server, `${HOST_COOKIE_NAME}=${yu.rawSessionId}`)).toBe(
      "Yu",
    );
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: `${HOST_COOKIE_NAME}=${yu.rawSessionId}` },
    });
    expect(res.status).toBe(302);
    expect(setCookieLines(res)).toContain(
      "__Host-isomux_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    );
    const gone = await server.http("/api/sessions", {
      headers: { Cookie: `${HOST_COOKIE_NAME}=${yu.rawSessionId}` },
    });
    expect(gone.status).toBe(401);
  });
});

describe("__Host- cookie: HTTPS arm writes and reads the prefixed name", () => {
  it("login writes __Host- with Secure, Path=/, and no Domain", async () => {
    const { srv } = await startHttps();
    server = srv;
    const res = await acceptViaHttp(server, await mintFor("Yu"));
    expect(res.status).toBe(302);
    const lines = setCookieLines(res);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(
      /^__Host-isomux_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
    );
    // The prefix is only honored without a Domain attribute; a Domain here
    // would make browsers drop the cookie and nobody could sign in.
    expect(lines[0]).not.toContain("Domain");
  });

  it("dual-read: legacy-only, host-only, and both (either header order) all authenticate", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const raw = yu.rawSessionId;
    const legacy = `${COOKIE_NAME}=${raw}`;
    const host = `${HOST_COOKIE_NAME}=${raw}`;
    for (const cookie of [
      legacy,
      host,
      `${host}; ${legacy}`,
      `${legacy}; ${host}`,
    ]) {
      expect(await whoAmI(server, cookie)).toBe("Yu");
      const up = await rawUpgrade(server.port, cookie);
      expect(up.status).toBe(101);
    }
  });

  it("a present __Host- cookie blocks legacy fallback: invalid or EMPTY value -> 401, HTTP and WS", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const legacy = `${COOKIE_NAME}=${yu.rawSessionId}`;
    // Present-but-invalid, and present-but-empty. Both are the request
    // CLAIMING the authoritative name; a legacy cookie must not rescue it.
    for (const bad of [
      `${HOST_COOKIE_NAME}=not-a-session`,
      `${HOST_COOKIE_NAME}=`,
    ]) {
      const res = await server.http("/api/sessions", {
        headers: { Cookie: `${bad}; ${legacy}` },
      });
      expect(res.status).toBe(401);
      const up = await rawUpgrade(server.port, `${bad}; ${legacy}`);
      expect(up.status).toBe(401);
    }
  });

  it("shadowing: an injected legacy cookie for another user cannot displace the __Host- session", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const mallory = await server.seedMember("Mallory");
    const host = `${HOST_COOKIE_NAME}=${yu.rawSessionId}`;
    // Mallory's session is entirely valid - it is the NAME that decides.
    const injected = `${COOKIE_NAME}=${mallory.rawSessionId}`;
    expect(await whoAmI(server, `${host}; ${injected}`)).toBe("Yu");
    expect(await whoAmI(server, `${injected}; ${host}`)).toBe("Yu");
    const sock = await server.connectWs(yu.rawSessionId, {
      cookieHeader: `${injected}; ${host}`,
    });
    const ctx = (await sock.waitFor("session_context")) as {
      context: { username: string };
    };
    expect(ctx.context.username).toBe("Yu");
    sock.close();
  });
});

describe("browser session lockout diagnostics", () => {
  it("reports a request with no cookie while active server rows remain", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    expect(listActiveSessions()).toHaveLength(1);
    expect(browserSessionDiagnostic(cookies(), null, "http")).toEqual({
      outcome: "cookie_absent",
      gate: "http",
    });
    expect(listActiveSessions()).toHaveLength(1);
  });

  it("reports legacy selection when the __Host cookie is missing", async () => {
    server = await startTestServer();
    const member = await server.seedMember("Yu");
    const parsed = cookies(`${COOKIE_NAME}=${member.rawSessionId}`);
    const lookup = validateSession(parsed.selected || null);
    expect(lookup).not.toBeNull();
    expect(browserSessionDiagnostic(parsed, lookup, "http")).toEqual({
      outcome: "legacy_selected",
      gate: "http",
    });
  });

  it("reports a rejected __Host cookie overriding a valid legacy cookie", async () => {
    server = await startTestServer();
    const member = await server.seedMember("Yu");
    const parsed = cookies(
      `${HOST_COOKIE_NAME}=not-a-session; ${COOKIE_NAME}=${member.rawSessionId}`,
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
      legacyAlsoPresent: true,
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
    expect(line).toContain(
      `cookie rejected as invalid or stale selected=__Host legacy_overridden=yes marker=${expectedMarker} gate=http path=/api/sessions client=Chrome/Windows`,
    );
    expect(line).not.toContain("not-a-session");
    expect(line).not.toContain(member.rawSessionId);
  });

  it("reports the matched session prefix after invite-based recovery", async () => {
    const { srv } = await startHttps();
    server = srv;
    const accepted = await acceptViaHttp(server, await mintFor("Yu"));
    expect(accepted.status).toBe(302);
    const issued = setCookieLines(accepted)[0]?.split(";", 1)[0] ?? "";
    const parsed = cookies(issued);
    const lookup = validateSession(parsed.selected || null);
    expect(lookup).not.toBeNull();
    expect(browserSessionDiagnostic(parsed, lookup, "http")).toBeNull();
    expect(browserSessionDiagnostic(parsed, lookup, "ws")).toEqual({
      outcome: "session_matched",
      gate: "ws",
      selected: "host",
      sessionPrefix: lookup!.sessionPrefix,
    });
  });

  it("redacts a live invite credential from a real HEAD diagnostic", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
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
    const owner = await server.seedOwner("Boss");
    const ownerLookup = validateSession(owner.rawSessionId);
    expect(ownerLookup).not.toBeNull();
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      _testResetBrowserSessionDiagnostics();
      const rejected = await server.http("/api/sessions");
      expect(rejected.status).toBe(401);
      expect(
        lines.some((line) =>
          line.includes(
            "browser session cookie absent gate=http path=/api/sessions",
          ),
        ),
      ).toBe(true);

      _testResetBrowserSessionDiagnostics();
      lines.length = 0;
      const upgraded = await rawUpgrade(
        server.port,
        `${COOKIE_NAME}=${owner.rawSessionId}`,
      );
      expect(upgraded.status).toBe(101);
      expect(
        lines.some((line) =>
          line.includes(
            `browser session matched ${ownerLookup!.sessionPrefix}… selected=legacy gate=ws path=/ws`,
          ),
        ),
      ).toBe(true);
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
      expect(
        lines.filter((line) =>
          line.includes("diagnostics capped for this window"),
        ),
      ).toHaveLength(1);
      expect(
        lines.filter(
          (line) =>
            line.includes("path=/cap-test-") ||
            line.includes("diagnostics capped for this window"),
        ),
      ).toHaveLength(257);
    } finally {
      console.log = original;
    }
  });
});

describe("__Host- cookie: the two-step migration", () => {
  it("step 1 on the shell: a legacy-only session gets the same id under the new name, legacy untouched", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const res = await server.http("/", {
      headers: { Cookie: `${COOKIE_NAME}=${yu.rawSessionId}` },
    });
    expect(res.status).toBe(200);
    const lines = setCookieLines(res);
    expect(lines.length).toBe(1);
    // Same session id: a migration re-issues, it never mints.
    expect(lines[0]).toContain(`${HOST_COOKIE_NAME}=${yu.rawSessionId}`);
    expect(lines[0]).toContain("Secure");
    // Nothing is cleared yet - the browser has not shown us it accepted this.
    expect(lines[0]).not.toContain("Max-Age=0");
    // Anchored to the session's ABSOLUTE cap (1 year), the same moment the
    // original cookie was anchored to - not the 30-day rolling expiry, which
    // would quietly shorten the session, and not a fresh year, which would
    // quietly extend it.
    const maxAge = parseInt(/Max-Age=(\d+)/.exec(lines[0])?.[1] ?? "0", 10);
    const day = 24 * 60 * 60;
    expect(maxAge).toBeGreaterThan(364 * day);
    expect(maxAge).toBeLessThanOrEqual(365 * day);
  });

  it("step 2: once the __Host- cookie comes back, the legacy name is cleared - and only then", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const both = `${HOST_COOKIE_NAME}=${yu.rawSessionId}; ${COOKIE_NAME}=${yu.rawSessionId}`;
    const res = await server.http("/", { headers: { Cookie: both } });
    const lines = setCookieLines(res);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(
      "isomux_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    );
    // A session already fully on the new name is left entirely alone.
    const done = await server.http("/", {
      headers: { Cookie: `${HOST_COOKIE_NAME}=${yu.rawSessionId}` },
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
    const upgrade = await rawUpgrade(server.port, `${COOKIE_NAME}=${raw}`);
    expect(upgrade.status).toBe(101);
    expect(upgrade.setCookie.length).toBe(1);
    expect(upgrade.setCookie[0]).toMatch(
      new RegExp(
        `^__Host-isomux_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`,
      ),
    );

    const retire = await rawUpgrade(
      server.port,
      `${HOST_COOKIE_NAME}=${raw}; ${COOKIE_NAME}=${raw}`,
    );
    expect(retire.status).toBe(101);
    expect(retire.setCookie).toEqual([
      "isomux_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);

    const settled = await rawUpgrade(server.port, `${HOST_COOKIE_NAME}=${raw}`);
    expect(settled.status).toBe(101);
    expect(settled.setCookie).toEqual([]);
  });

  it("rides a safe /api GET, never an unsafe method, never a bearer caller", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const legacy = `${COOKIE_NAME}=${yu.rawSessionId}`;

    const get = await server.http("/api/sessions", {
      headers: { Cookie: legacy },
    });
    expect(get.status).toBe(200);
    expect(setCookieLines(get).length).toBe(1);
    expect(setCookieLines(get)[0]).toContain(HOST_COOKIE_NAME);

    // An unsafe method could be revoking the very session we would re-issue
    // (DELETE /api/sessions/current), so migration never rides one.
    const del = await server.http("/api/sessions/current", {
      method: "DELETE",
      headers: { Cookie: legacy },
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
        Cookie: `${COOKIE_NAME}=${other.rawSessionId}`,
      },
    });
    expect(bearer.status).toBe(200);
    expect(setCookieLines(bearer)).toEqual([]);
  });
});

describe("__Host- cookie: sign-out", () => {
  it("clears both names as independent Set-Cookie lines", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: `${HOST_COOKIE_NAME}=${yu.rawSessionId}; ${COOKIE_NAME}=${yu.rawSessionId}`,
      },
    });
    expect(res.status).toBe(302);
    // Two retrievable lines, not one comma-folded string.
    expect(setCookieLines(res)).toEqual([
      "isomux_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "__Host-isomux_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);
  });

  it("revokes only the SELECTED session server-side, even though it clears both client names", async () => {
    const { srv } = await startHttps();
    server = srv;
    const yu = await server.seedMember("Yu");
    const ann = await server.seedMember("Ann");
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: {
        // Two different LIVE sessions. Name precedence picks Yu's.
        Cookie: `${HOST_COOKIE_NAME}=${yu.rawSessionId}; ${COOKIE_NAME}=${ann.rawSessionId}`,
      },
    });
    expect(res.status).toBe(302);
    // Yu's session is gone...
    const gone = await server.http("/api/sessions", {
      headers: { Cookie: `${HOST_COOKIE_NAME}=${yu.rawSessionId}` },
    });
    expect(gone.status).toBe(401);
    // ...and Ann's, which the same response merely stopped SENDING, is alive.
    expect(
      await whoAmI(server, `${HOST_COOKIE_NAME}=${ann.rawSessionId}`),
    ).toBe("Ann");
  });

  it("a lockout-blocked sign-out clears nothing", async () => {
    const { srv, owner } = await startHttps();
    server = srv;
    // This is the office's ONLY owner: signing it out would leave the office
    // unreachable, so the route refuses - and must not touch the cookies of a
    // session it did not revoke.
    const res = await server.http("/auth/logout", {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: `${HOST_COOKIE_NAME}=${owner.rawSessionId}` },
    });
    expect(res.status).toBe(409);
    expect(setCookieLines(res)).toEqual([]);
  });
});
