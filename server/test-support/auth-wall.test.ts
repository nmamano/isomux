// Auth core - the transport-level gate (tasks 5676b6cb / 530680ae).
//
// auth-invites/auth-sessions drive the auth module directly; this file drives
// the same invariants through the REAL server, because several of them only
// exist at the request boundary. Seam: startTestServer(). Zero LLM.
//
// What this freezes:
//   - The WS UPGRADE MATRIX, which is stricter than the HTTP one and is the
//     part manual smoke tests kept re-deriving: no cookie -> 401, bad Origin ->
//     403, and - the asymmetry worth writing down - a MISSING Origin is also
//     403 on /ws even though a mutating HTTP POST deliberately allows it (agent
//     curl sends no Origin; a browser always does).
//   - An EXPIRED cookie is refused exactly like a missing one, on HTTP and on
//     the WS upgrade, and a REVOKED session stops being able to reconnect.
//   - PWA pre-auth whitelist: /manifest.json and /icons/* are served without a
//     cookie (iOS fetches them out-of-band on "Add to Home Screen"), while the
//     app shell and its bundles behind the same static serve stay walled. Both
//     halves are asserted when the UI is built; the wall half always runs. A
//     whitelist test that only checks the open side passes just as well if the
//     whole wall came down.
//   - The two-step invite flow over HTTP: GET /i/<token> renders WITHOUT
//     consuming, POST /auth/accept consumes and sets the session cookie, and a
//     replayed accept is 410 rather than a second session.
//   - A rename does not disturb in-flight sessions (identity is the stable
//     userId), and a case-only collision is still refused.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { builtPwaAssetsExist } from "./built-ui.ts";
import {
  COOKIE_NAME,
  buildPublicOrigin,
  mintInvite,
  validateSession,
  revokeSessionByPrefix,
  _testSetSessionExpiry,
} from "../auth.ts";
import { getUserByName } from "../users.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// A raw request that bypasses harness.http()'s automatic Origin + cookie, so
// each header can be varied independently. Redirects are never followed: the
// 302 from /auth/accept is itself under test.
function raw(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    origin?: string | null;
    rawSessionId?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Connection: "close",
    ...(init.headers ?? {}),
  };
  if (init.origin !== null && init.origin !== undefined) {
    headers.Origin = init.origin;
  }
  if (init.rawSessionId) {
    headers.Cookie = `${COOKIE_NAME}=${init.rawSessionId}`;
  }
  return fetch(`${srv.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    redirect: "manual",
  });
}

// A plain GET on /ws exercises the upgrade handler's auth gate without the
// WebSocket handshake headers. The handler checks the cookie, then the Origin,
// and only then calls server.upgrade() - so a 400 ("upgrade failed") is the
// unambiguous signal that BOTH auth checks passed and only the handshake is
// missing, while 401/403 name which gate refused.
const wsProbe = (
  srv: TestServer,
  init: Parameters<typeof raw>[2] = {},
): Promise<Response> => raw(srv, "/ws", init);

describe("auth/wall: WS upgrade gate", () => {
  it("401 without a cookie, 403 on a bad Origin, 403 on a MISSING Origin, 400 once both pass", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const good = buildPublicOrigin().origin;

    expect((await wsProbe(server, { origin: good })).status).toBe(401);
    expect(
      (await wsProbe(server, { rawSessionId: "not-a-real-session" })).status,
    ).toBe(401);

    expect(
      (
        await wsProbe(server, {
          rawSessionId: owner.rawSessionId,
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);

    // Missing Origin: rejected on /ws. See the HTTP contrast below.
    expect(
      (
        await wsProbe(server, {
          rawSessionId: owner.rawSessionId,
          origin: null,
        })
      ).status,
    ).toBe(403);

    // Cookie + matching Origin: past both gates, refused only for lacking the
    // handshake headers.
    expect(
      (
        await wsProbe(server, {
          rawSessionId: owner.rawSessionId,
          origin: good,
        })
      ).status,
    ).toBe(400);

    // ...and a genuine handshake with the same credentials connects.
    const sock = await server.connectWs(owner.rawSessionId);
    expect(sock.raw.readyState).toBe(WebSocket.OPEN);
    sock.close();
  });

  it("the missing-Origin rule is stricter on /ws than on a mutating HTTP POST", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");

    // Same credentials, same absent Origin, two different answers - this
    // asymmetry is deliberate (agent curl posts without an Origin; a browser
    // opening a WebSocket always sends one).
    const ws = await wsProbe(server, {
      rawSessionId: owner.rawSessionId,
      origin: null,
    });
    const http = await raw(server, "/api/rooms", {
      method: "POST",
      origin: null,
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Originless Room" }),
    });
    expect(ws.status).toBe(403);
    expect(http.status).toBeLessThan(400);
  });

  it("an expired cookie and a revoked session are both refused at the upgrade", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const alice = await server.seedMember("Alice");
    const good = buildPublicOrigin().origin;

    // Baseline: Alice can upgrade.
    expect(
      (
        await wsProbe(server, {
          rawSessionId: alice.rawSessionId,
          origin: good,
        })
      ).status,
    ).toBe(400);

    _testSetSessionExpiry(alice.rawSessionId, { expiresAt: Date.now() - 1 });
    expect(
      (
        await wsProbe(server, {
          rawSessionId: alice.rawSessionId,
          origin: good,
        })
      ).status,
    ).toBe(401);

    // Revocation of a still-unexpired session: same answer.
    const lOwner = validateSession(owner.rawSessionId)!;
    expect(await revokeSessionByPrefix(lOwner.sessionPrefix)).toBe("ok");
    expect(
      (
        await wsProbe(server, {
          rawSessionId: owner.rawSessionId,
          origin: good,
        })
      ).status,
    ).toBe(401);
  });
});

describe("auth/wall: HTTP cookie gate", () => {
  it("an expired cookie 401s exactly like no cookie at all", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");

    const anonymous = await raw(server, "/api/files");
    expect(anonymous.status).toBe(401);

    // Valid cookie clears the wall (404 is the handler's own answer for a
    // missing path param - the point is that it is not 401).
    const authed = await raw(server, "/api/files", {
      rawSessionId: owner.rawSessionId,
    });
    expect(authed.status).not.toBe(401);

    _testSetSessionExpiry(owner.rawSessionId, {
      absoluteExpiresAt: Date.now() - 1,
    });
    const expired = await raw(server, "/api/files", {
      rawSessionId: owner.rawSessionId,
    });
    expect(expired.status).toBe(401);
    expect(await expired.text()).toBe(await anonymous.text());
  });
});

describe("auth/wall: PWA assets are the ONLY pre-auth statics", () => {
  it.skipIf(!builtPwaAssetsExist)(
    "/manifest.json and /icons/* serve anonymously (needs ui/dist - run `bun run build:ui`)",
    async () => {
      server = await startTestServer();
      await server.seedOwner("Boss");

      const manifest = await raw(server, "/manifest.json");
      expect(manifest.status).toBe(200);
      // Really the manifest, not a login page dressed as one.
      expect(await manifest.json()).toHaveProperty("name");

      const icon = await raw(server, "/icons/icon-192.png");
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/png");
    },
  );

  it("keeps the app shell, bundles, and other routes behind the auth wall", async () => {
    server = await startTestServer();
    // An owner must exist, or the office is pre-claim and `/` legitimately
    // serves the claim form to anyone who can reach the (loopback-bound) port.
    await server.seedOwner("Boss");

    // Everything outside the whitelist still 401s anonymously.
    for (const path of ["/", "/index.html", "/app.js", "/api/files"]) {
      const res = await raw(server, path);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }

    // A traversal attempt out of /icons/ is normalized by URL parsing and
    // cannot reach the walled shell.
    const escape = await raw(server, "/icons/../index.html");
    expect(escape.status).toBe(401);
  });
});

describe("auth/wall: the two-step invite flow over HTTP", () => {
  it("GET /i/<token> renders without consuming; POST /auth/accept consumes once and sets the cookie", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const m = await mintInvite({
      username: "Newbie",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });
    if (!m.ok) throw new Error("mint failed");

    // Two GETs: a link unfurler or a browser prefetch must not burn the token.
    expect((await raw(server, `/i/${m.rawToken}`)).status).toBe(200);
    const peek = await raw(server, `/i/${m.rawToken}`);
    expect(peek.status).toBe(200);
    const peekHtml = await peek.text();
    expect(peekHtml).toContain('action="/auth/accept"');
    expect(peekHtml).toContain(m.rawToken);
    // A bound-username invite must NOT ask for a display name - only a
    // bootstrap (null-username) invite does.
    expect(peekHtml).not.toContain('name="name"');
    expect(getUserByName("Newbie")).toBeUndefined();

    const accept = await raw(server, "/auth/accept", {
      method: "POST",
      origin: buildPublicOrigin().origin,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: m.rawToken }).toString(),
    });
    expect(accept.status).toBe(302);
    expect(accept.headers.get("location")).toBe("/");
    const setCookie = accept.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(getUserByName("Newbie")?.role).toBe("member");

    // The issued cookie actually works.
    const issued = setCookie.split(";")[0].split("=").slice(1).join("=");
    const authed = await raw(server, "/api/files", { rawSessionId: issued });
    expect(authed.status).not.toBe(401);

    // Replay: 410 Gone, no second session.
    const replay = await raw(server, "/auth/accept", {
      method: "POST",
      origin: buildPublicOrigin().origin,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: m.rawToken }).toString(),
    });
    expect(replay.status).toBe(410);
  });

  it("an expired invite is 410 on both the peek and the accept; a bad Origin never reaches the token", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const m = await mintInvite({
      username: "Ghost",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
      ttlMsOverride: -1000,
    });
    if (!m.ok) throw new Error("mint failed");

    const peek = await raw(server, `/i/${m.rawToken}`);
    expect(peek.status).toBe(410);
    expect(await peek.text()).toContain("expired");

    const accept = await raw(server, "/auth/accept", {
      method: "POST",
      origin: buildPublicOrigin().origin,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: m.rawToken }).toString(),
    });
    expect(accept.status).toBe(410);
    expect(getUserByName("Ghost")).toBeUndefined();

    // Cross-origin accept of a LIVE token is refused before the token is ever
    // looked at, so a hostile page can't redeem an invite it managed to read.
    const live = await mintInvite({
      username: "Newbie",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });
    if (!live.ok) throw new Error("mint failed");
    const crossOrigin = await raw(server, "/auth/accept", {
      method: "POST",
      origin: "https://evil.example",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: live.rawToken }).toString(),
    });
    expect(crossOrigin.status).toBe(403);
    expect(getUserByName("Newbie")).toBeUndefined();
  });
});

describe("auth/wall: a rename does not disturb live sessions", () => {
  it("the renamed user's cookie keeps working and reports the NEW name", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const alice = await server.seedMember("Alice");

    expect(validateSession(alice.rawSessionId)?.username).toBe("Alice");

    const renamed = await raw(server, "/api/users/Alice", {
      method: "PATCH",
      origin: buildPublicOrigin().origin,
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alicia" }),
    });
    expect(renamed.status).toBe(200);

    // Same cookie, no reconnect: still valid, and the display name resolved
    // from the record has followed the rename.
    const lookup = validateSession(alice.rawSessionId);
    expect(lookup).not.toBeNull();
    expect(lookup?.username).toBe("Alicia");
    expect(
      (await raw(server, "/api/files", { rawSessionId: alice.rawSessionId }))
        .status,
    ).not.toBe(401);
  });

  it("a rename that collides only by CASE is refused", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    await server.seedMember("Alice");

    const collide = await raw(server, "/api/users/Alice", {
      method: "PATCH",
      origin: buildPublicOrigin().origin,
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bOsS" }),
    });
    expect(collide.status).toBe(409);
    expect(getUserByName("Alice")?.name).toBe("Alice");
  });
});
