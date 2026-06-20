// Phase 1.4(b) — Auth / loopback / origin policy characterization.
//
// Freezes TODAY's auth posture for the HTTP surface — the exact thing Phase 2
// (token identity) and the Phase 3 loopback-bypass-removal milestone flip. We
// pin the BEFORE so the flip is a visible, intentional diff, not a silent one.
//
// What is frozen (all current behavior, NOT the desired end-state):
//   - Loopback trust: paths in isAgentApiPath (/tasks, /cronjobs, /agents/,
//     /backup/status) are reachable from 127.0.0.1 with NO cookie. The harness
//     fetches loopback, so these succeed unauthenticated.
//   - Cookie wall: everything else (/api/upload, /api/files, the SPA shell) is
//     NOT loopback-trusted and requires a valid session cookie even on the same
//     box -> 401.
//   - Origin/CSRF: the origin check runs for non-safe methods regardless of the
//     loopback bypass. A mismatched Origin -> 403 "bad origin"; a MISSING Origin
//     (typical agent curl) is allowed; a safe GET skips the check entirely.
//   - 401 shape: JSON { error:"unauthenticated" } when the client wants JSON,
//     the login HTML page when it wants text/html.
//   - Attribution is BODY-TRUST: POST /tasks createdBy comes from the body, not
//     from the cookie identity.
//
// srv.http() force-sets a valid Origin, so the origin-policy cases fetch
// srv.baseUrl directly to control (or omit) the Origin header. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import type { TaskItem } from "../../shared/types.ts";
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

describe("routes/auth: loopback trust (no cookie) (Phase 1.4b)", () => {
  it("isAgentApiPath GET routes are reachable with no cookie", async () => {
    const srv = await startTestServer();
    server = srv;
    expect((await srv.http("/tasks")).status).toBe(200);
    expect((await srv.http("/cronjobs")).status).toBe(200);
    expect((await srv.http("/backup/status")).status).toBe(200);
  });

  it("a loopback POST /tasks mutates with no cookie -> 201", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "loopback", createdBy: "agent" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("routes/auth: cookie wall for non-loopback paths (Phase 1.4b)", () => {
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

describe("routes/auth: origin / CSRF (Phase 1.4b)", () => {
  it("mutating POST with a mismatched Origin -> 403 bad origin (before loopback bypass)", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await fetch(`${srv.baseUrl}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ title: "csrf", createdBy: "attacker" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("bad origin");
    // The CSRF attempt did not create a task.
    expect(srv.agentManager.getTasks().length).toBe(0);
  });

  it("mutating POST with NO Origin header is allowed (agent curl) -> 201", async () => {
    const srv = await startTestServer();
    server = srv;
    // No Origin header set; Bun's fetch does not synthesize one server-side.
    const res = await fetch(`${srv.baseUrl}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "no-origin", createdBy: "agent" }),
    });
    expect(res.status).toBe(201);
  });

  it("a safe GET with a mismatched Origin is allowed (origin check is non-safe-only)", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await fetch(`${srv.baseUrl}/tasks`, {
      headers: { Origin: "https://evil.example" },
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
    // open bootstrap page at "/" — that is an onboarding concern, not auth).
    const res = await srv.http("/api/files/ghost/x.txt", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("routes/auth: body-trust attribution (Phase 1.4b)", () => {
  it("POST /tasks createdBy comes from the body, not the cookie identity", async () => {
    const srv = await startTestServer();
    server = srv;
    const alice = await srv.seedOwner("Alice");
    const res = await srv.http("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      rawSessionId: alice.rawSessionId,
      body: JSON.stringify({ title: "on behalf", createdBy: "Bob" }),
    });
    expect(res.status).toBe(201);
    // The cookie session is Alice, but createdBy is taken verbatim from the body.
    expect(((await res.json()) as TaskItem).createdBy).toBe("Bob");
  });
});

// Phase 2.1 (ADDITIVE) — Bearer lands ALONGSIDE the cookie path. These assert
// the NEW acceptance (a valid bearer authenticates), NOT any new rejection: a
// garbage bearer behaves exactly like no Authorization. NOTE the deliberate
// broad-acceptance window: until the guard catalog (2.2) lands, a valid AGENT
// bearer clears the cookie wall anywhere authenticate() gates — acceptable only
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

  it("a garbage bearer does not disturb loopback trust (POST /tasks still 201)", async () => {
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
    expect(res.status).toBe(201);
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
