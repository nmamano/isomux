// The retired legacy HTTP surface: /tasks*, /cronjobs* and /backup/status.
//
// These three prefixes used to be loopback-trusted aliases of routes that now
// live on the bearer-gated /api surface. They are GONE, and this file is the
// end-state pin, replacing the two characterization suites that froze their
// behavior (routes-tasks.test.ts, routes-cronjobs.test.ts - deleted with the
// routes). The live surface is covered in routes-tasks-rest.test.ts,
// routes-cronjobs-rest.test.ts and routes-cronjobs-runs.test.ts.
//
// Three properties, per prefix:
//   1. Anonymous (the SSRF / open-proxy shape the retirement is for): 401 at the
//      cookie wall. The harness fetches 127.0.0.1, so a returning loopback
//      bypass would show up here as a 200.
//   2. Authenticated (owner cookie, and an agent bearer): JSON 404 - never a
//      200 text/html SPA shell, which would mask the caller.
//   3. No wildcard CORS: no Access-Control-Allow-Origin on any response, and no
//      OPTIONS preflight advertising the old method list.
//
// Seam: startTestServer().http(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken, _testResetTokens } from "../identity/tokens.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  _testResetTokens();
});

// Every path that used to be served by one of the retired handlers, including
// the deleted cron-run affordance POSTs (they hung off the /cronjobs prefix).
const RETIRED: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/tasks" },
  { method: "GET", path: "/tasks?status=all" },
  { method: "GET", path: "/tasks/deadbeef" },
  { method: "POST", path: "/tasks" },
  { method: "PATCH", path: "/tasks/deadbeef" },
  { method: "POST", path: "/tasks/deadbeef/claim" },
  { method: "POST", path: "/tasks/deadbeef/done" },
  { method: "DELETE", path: "/tasks/deadbeef" },
  { method: "GET", path: "/cronjobs" },
  { method: "GET", path: "/cronjobs/job1" },
  { method: "GET", path: "/cronjobs/job1/runs" },
  { method: "GET", path: "/cronjobs/job1/runs/run1" },
  { method: "POST", path: "/cronjobs/job1/runs/run1/read-file" },
  { method: "POST", path: "/cronjobs/job1/runs/run1/diff" },
  { method: "GET", path: "/backup/status" },
];

describe("routes/legacy-retired: anonymous same-box callers", () => {
  it("every retired path is 401 with no identity (no loopback trust left)", async () => {
    const srv = await startTestServer();
    server = srv;
    for (const { method, path } of RETIRED) {
      const res = await srv.http(path, {
        method,
        headers:
          method === "GET" || method === "DELETE"
            ? {}
            : { "Content-Type": "application/json" },
        body:
          method === "GET" || method === "DELETE"
            ? undefined
            : JSON.stringify({}),
      });
      expect({ path, method, status: res.status }).toEqual({
        path,
        method,
        status: 401,
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("an anonymous POST /tasks does not reach the board", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "should not exist", createdBy: "ghost" }),
    });
    expect(res.status).toBe(401);
    expect(srv.agentManager.getTasks()).toEqual([]);
  });
});

describe("routes/legacy-retired: authenticated callers get a JSON 404", () => {
  it("an owner cookie gets 404 JSON, not the SPA shell", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    for (const { method, path } of RETIRED) {
      const res = await srv.http(path, {
        method,
        rawSessionId: owner.rawSessionId,
        headers:
          method === "GET" || method === "DELETE"
            ? {}
            : { "Content-Type": "application/json" },
        body:
          method === "GET" || method === "DELETE"
            ? undefined
            : JSON.stringify({}),
      });
      expect({ path, method, status: res.status }).toEqual({
        path,
        method,
        status: 404,
      });
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });

  it("an agent bearer gets the same 404 (no privileged back door)", async () => {
    const srv = await startTestServer();
    server = srv;
    const raw = mintAgentToken("agent-retired", "user-1");
    const res = await srv.http("/tasks", {
      headers: { Authorization: `Bearer ${raw}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

// URL leaves %2f encoded, so a raw-pathname match would let these through to the
// SPA shell - a 200 text/html answer to a caller still using a retired route.
describe("routes/legacy-retired: path shapes that skirt a naive match", () => {
  const SKIRTING = [
    "/tasks%2fabc",
    "/tasks%2Fabc",
    "/cronjobs%2fjob1%2fruns",
    "/backup%2fstatus",
    "/backup/status/",
    "/tasks/",
    "/cronjobs//",
  ];

  it("an owner cookie still gets a JSON 404, never the SPA shell", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    for (const path of SKIRTING) {
      const res = await srv.http(path, { rawSessionId: owner.rawSessionId });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("anonymous callers still 401", async () => {
    const srv = await startTestServer();
    server = srv;
    for (const path of SKIRTING) {
      const res = await srv.http(path);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  // Only ONE decode pass: %252f is the literal text "%2f", not a separator, so
  // it is a plain unknown path - no handler is behind it either way.
  it("a double-encoded separator is not treated as a retired path", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await srv.http("/tasks%252fabc", {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).not.toBe(404);
  });
});

describe("routes/legacy-retired: no wildcard CORS preflight", () => {
  it("OPTIONS on the retired prefixes no longer advertises the old methods", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    for (const path of ["/tasks", "/cronjobs"]) {
      // Anonymous: the preflight used to answer 200 with `*` for anyone.
      const anon = await srv.http(path, { method: "OPTIONS" });
      expect(anon.status).toBe(401);
      expect(anon.headers.get("access-control-allow-origin")).toBeNull();
      expect(anon.headers.get("access-control-allow-methods")).toBeNull();
      // Authenticated: still no CORS grant, just the 404.
      const auth = await srv.http(path, {
        method: "OPTIONS",
        rawSessionId: owner.rawSessionId,
      });
      expect(auth.status).toBe(404);
      expect(auth.headers.get("access-control-allow-origin")).toBeNull();
      expect(auth.headers.get("access-control-allow-methods")).toBeNull();
    }
  });
});
