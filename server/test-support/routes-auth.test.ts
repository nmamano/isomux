// Auth / identity / origin policy for the HTTP surface.
//
// Started life as Phase 1.4(b) characterization of the loopback bypass; now it
// pins the END state, after the legacy-routes retirement removed the last
// loopback-trusted prefixes (/tasks, the /cronjobs reads, /backup/status).
//
// What is pinned:
//   - NO loopback trust anywhere: an anonymous same-box request is 401, on the
//     retired prefixes and on /api alike. The harness fetches loopback, so
//     these cases would pass trivially if a bypass came back.
//   - Cookie wall: /api/upload, /api/files and the SPA shell require a valid
//     session cookie (or a bearer) even from the same box -> 401.
//   - Origin/CSRF: the origin check runs for non-safe methods, BEFORE identity
//     is resolved. A mismatched Origin -> 403 "bad origin"; a MISSING Origin
//     (typical agent curl) is allowed; a safe GET skips the check entirely.
//   - 401 shape: JSON { error:"unauthenticated" } when the client wants JSON,
//     the login HTML page when it wants text/html.
//   - Bearer precedence: a valid bearer wins over a cookie; a garbage bearer is
//     ignored rather than becoming a new rejection.
//
// srv.http() force-sets a valid Origin, so the origin-policy cases fetch
// srv.baseUrl directly to control (or omit) the Origin header. Zero LLM.

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

describe("routes/auth: no loopback trust on the retired prefixes", () => {
  it("an anonymous same-box GET on each retired prefix -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    expect((await srv.http("/tasks")).status).toBe(401);
    expect((await srv.http("/cronjobs")).status).toBe(401);
    expect((await srv.http("/backup/status")).status).toBe(401);
  });

  it("an anonymous same-box POST /tasks does not mutate -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "loopback", createdBy: "agent" }),
    });
    expect(res.status).toBe(401);
    expect(srv.agentManager.getTasks().length).toBe(0);
  });
});

describe("routes/auth: cookie wall (Phase 1.4b)", () => {
  it("GET /api/files without a cookie -> 401 unauthenticated", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/api/files/ghost/x.txt");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  });

  it("POST /api/upload without a cookie -> 401 unauthenticated", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/api/upload/ghost", { method: "POST" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  });

  it("a valid cookie clears the wall (GET /api/files -> 404, not 401)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await srv.http("/api/files/ghost/x.txt", {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(404); // reached the handler; file just doesn't exist
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

  it("mutating POST with NO Origin header is allowed (agent curl) -> 201", async () => {
    const srv = await startTestServer();
    server = srv;
    const raw = mintAgentToken("agent-no-origin", "user-1");
    // No Origin header set; Bun's fetch does not synthesize one server-side.
    const res = await fetch(`${srv.baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${raw}`,
      },
      body: JSON.stringify({ title: "no-origin" }),
    });
    expect(res.status).toBe(201);
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

describe("routes/auth: 401 shape by Accept (Phase 1.4b)", () => {
  it("Accept: application/json -> JSON 401 unauthenticated", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/api/files/ghost/x.txt", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).error).toBe("unauthenticated");
  });

  it("Accept: text/html -> 401 login HTML (same unauthorized() helper)", async () => {
    const srv = await startTestServer();
    server = srv;
    // Use a cookie-walled path so the unauthorized() branch is exercised
    // independent of office-claim state (a fresh, unclaimed office serves an
    // open bootstrap page at "/" - that is an onboarding concern, not auth).
    const res = await srv.http("/api/files/ghost/x.txt", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

// Phase 2.1 (ADDITIVE) - Bearer lands ALONGSIDE the cookie path. These assert
// the NEW acceptance (a valid bearer authenticates), NOT any new rejection: a
// garbage bearer behaves exactly like no Authorization. NOTE the deliberate
// broad-acceptance window: until the guard catalog (2.2) lands, a valid AGENT
// bearer clears the cookie wall anywhere authenticate() gates - acceptable only
// because the token is a bearer secret injected into local subprocess env.
describe("routes/auth: bearer alongside cookie (Phase 2.1, additive)", () => {
  it("a valid AGENT bearer token clears the cookie wall (GET /api/files -> 404, not 401)", async () => {
    const srv = await startTestServer();
    server = srv;
    const raw = mintAgentToken("agent-bearer-1", "user-1");
    const res = await srv.http("/api/files/ghost/x.txt", {
      headers: { Authorization: `Bearer ${raw}` },
    });
    // Reached the handler (file just doesn't exist) instead of the 401 wall.
    expect(res.status).toBe(404);
  });

  it("an invalid/garbage bearer is IGNORED: a cookie-walled path still 401 (no new rejection)", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/api/files/ghost/x.txt", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  });

  it("a garbage bearer on a retired prefix is still 401, not a bypass", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer garbage",
      },
      body: JSON.stringify({ title: "loopback+badbearer", createdBy: "agent" }),
    });
    expect(res.status).toBe(401);
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
    )!;
    expect(id.scope).toBe("agent");
    expect(id.agentId).toBe("agent-prec");
  });

  it("an invalid bearer falls through to the cookie identity", () => {
    const id = resolveIdentityForRequest(
      reqWith({ Authorization: "Bearer nope" }),
      cookieLookup,
    )!;
    expect(id.scope).toBe("user");
    expect(id.userId).toBe("user-cookie");
    expect(id.role).toBe("owner");
  });

  it("no credentials -> null", () => {
    expect(resolveIdentityForRequest(reqWith({}), null)).toBeNull();
  });
});
