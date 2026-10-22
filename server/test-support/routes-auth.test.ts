// Auth / identity / origin policy for the HTTP surface.
//
// What is pinned:
//   - Cookie wall: /api/upload and /api/files need a session cookie or a
//     bearer even from the same box (the harness fetches loopback) -> 401.
//     The retired loopback prefixes are pinned in routes-legacy-retired.test.ts.
//   - Origin/CSRF: the origin check runs for non-safe methods, BEFORE identity
//     is resolved. A mismatched Origin -> 403 "bad origin"; a safe GET skips
//     the check. A MISSING Origin (agent curl) is allowed: auth-wall.test.ts.
//   - 401 shape: JSON { error:"unauthenticated" } when the client wants JSON,
//     the login HTML page when it wants text/html.
//   - Bearer precedence: a valid bearer wins over a cookie; a garbage bearer is
//     ignored rather than becoming a new rejection.
//
// srv.http() force-sets a valid Origin, so the origin-policy cases fetch
// srv.baseUrl directly to control the Origin header. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import type { SessionLookup } from "../auth.ts";
import { resolveIdentityForRequest } from "../auth-middleware.ts";
import { mintAgentToken, _testResetTokens } from "../identity/tokens.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

// Phase 2.1: clear the in-memory token store between cases. The harness resets
// it on boot, but the precedence unit cases below mint tokens without a boot.
afterEach(() => _testResetTokens());

describe("routes/auth: cookie wall", () => {
  it("no identity or a garbage bearer -> JSON 401; a cookie or an agent bearer reaches the guard", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const agentBearer = mintAgentToken("agent-bearer-1", "user-1");
    const walled = [
      { method: "GET", path: "/api/files/ghost/x.txt" },
      { method: "POST", path: "/api/upload/ghost" },
    ];
    for (const { method, path } of walled) {
      const anonymous: Record<string, string>[] = [
        {},
        { Accept: "application/json" },
        // An invalid bearer is ignored, never its own rejection.
        { Authorization: "Bearer not-a-real-token" },
      ];
      for (const headers of anonymous) {
        const res = await srv.http(path, { method, headers });
        expect({ path, headers, status: res.status }).toEqual({
          path,
          headers,
          status: 401,
        });
        expect(res.headers.get("content-type")).toContain("application/json");
        expect((await res.json()).error.code).toBe("unauthenticated");
      }
      // Past the wall, the guard refuses an unknown agent: 403, not 401.
      const cookie = await srv.http(path, {
        method,
        rawSessionId: owner.rawSessionId,
      });
      const bearer = await srv.http(path, {
        method,
        headers: { Authorization: `Bearer ${agentBearer}` },
      });
      // A garbage bearer beside a valid cookie is ignored: the cookie passes.
      const both = await srv.http(path, {
        method,
        rawSessionId: owner.rawSessionId,
        headers: { Authorization: "Bearer not-a-real-token" },
      });
      expect({
        path,
        cookie: cookie.status,
        bearer: bearer.status,
        both: both.status,
      }).toEqual({ path, cookie: 403, bearer: 403, both: 403 });
    }
    // Below the route table (retired prefixes, the static UI) the wall is a
    // second authenticate() call: a garbage bearer is no identity there too.
    for (const [method, path] of [
      ["POST", "/tasks"],
      ["GET", "/"],
    ] as const) {
      const res = await srv.http(path, {
        method,
        headers: { Authorization: "Bearer not-a-real-token" },
      });
      expect({ method, path, status: res.status }).toEqual({
        method,
        path,
        status: 401,
      });
    }
  });
});

// The origin check runs BEFORE identity resolution, so these cases use a bearer
// on /api/tasks: the 403 must come from the Origin, not from a missing identity.
describe("routes/auth: origin / CSRF", () => {
  it("mutating POST with a mismatched Origin -> 403 bad origin", async () => {
    const srv = await startTestServer();
    server = srv;
    const raw = mintAgentToken("agent-csrf", "user-1");
    const res = await fetch(`${srv.baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${raw}`,
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ title: "csrf" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("bad_origin");
    // The CSRF attempt did not create a task.
    expect(srv.agentManager.getTasks().length).toBe(0);
  });

  it("a safe GET with a mismatched Origin is allowed (origin check is non-safe-only)", async () => {
    const srv = await startTestServer();
    server = srv;
    const raw = mintAgentToken("agent-safe-get", "user-1");
    const res = await fetch(`${srv.baseUrl}/api/tasks`, {
      headers: {
        Authorization: `Bearer ${raw}`,
        Origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(200);
  });
});

describe("routes/auth: 401 shape by Accept", () => {
  it("Accept: text/html -> 401 login HTML (same unauthorized() helper)", async () => {
    const srv = await startTestServer();
    server = srv;
    // Use a cookie-walled path so the unauthorized() branch is exercised
    // independent of office-claim state (a fresh, unclaimed office serves an
    // open bootstrap page at "/" - that is an onboarding concern, not auth).
    //
    // A table route answers a browser navigation the same way: the chat links
    // attachments under /api/files, and a signed-out member who opens one gets
    // the login page, not a JSON envelope (task d0d38eb9).
    for (const path of ["/api/files/ghost/x.txt", "/agents", "/api/tasks"]) {
      const res = await srv.http(path, {
        headers: { Accept: "text/html" },
      });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });
});

describe("auth-middleware: resolveIdentityForRequest precedence (Phase 2.1)", () => {
  const cookieLookup: SessionLookup = {
    sessionIdHash: "hash",
    sessionPrefix: "prefix12",
    userId: "user-cookie",
    username: "Carol",
    role: "owner",
    needsRolling: false,
    absoluteExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
  const reqWith = (headers: Record<string, string>) =>
    new Request("http://localhost/x", { headers });

  it("a valid bearer wins over a valid cookie", () => {
    const raw = mintAgentToken("agent-prec", "user-agent");
    const id = resolveIdentityForRequest(
      reqWith({ Authorization: `Bearer ${raw}` }),
      cookieLookup,
      true,
    )!;
    expect(id.scope).toBe("agent");
    expect(id.agentId).toBe("agent-prec");
  });

  it("an invalid bearer falls through to the cookie identity", () => {
    const id = resolveIdentityForRequest(
      reqWith({ Authorization: "Bearer nope" }),
      cookieLookup,
      true,
    )!;
    expect(id.scope).toBe("user");
    expect(id.userId).toBe("user-cookie");
    expect(id.role).toBe("owner");
  });

  it("an off-box agent bearer is ignored and falls through to the cookie identity", () => {
    const raw = mintAgentToken("agent-prec", "user-agent");
    const req = reqWith({ Authorization: `Bearer ${raw}` });
    const id = resolveIdentityForRequest(req, cookieLookup, false)!;
    expect(id.scope).toBe("user");
    expect(id.userId).toBe("user-cookie");
    expect(resolveIdentityForRequest(req, null, false)).toBeNull();
  });
});
