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

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

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
