// An /api path that matches no route answers a JSON 404 in the /api error
// envelope, never the SPA shell's 200 text/html. Every other path keeps the
// SPA fallback, so client-side routes still load the app.
//
// Seam: startTestServer().http(). Zero LLM. The SPA cases need ui/dist - run
// `bun run build:ui`.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken, _testResetTokens } from "../identity/tokens.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  _testResetTokens();
});

const UNKNOWN: Array<{ method: string; path: string }> = [
  // The two paths seen after the batch 1009 restart: a removed route and a
  // path that never existed.
  { method: "POST", path: "/api/apps/proyectos/preview" },
  { method: "POST", path: "/api/apps/proyectos/nonsense" },
  { method: "GET", path: "/api/nonsense" },
  { method: "GET", path: "/api/" },
  // A real path with a method it does not serve.
  { method: "DELETE", path: "/api/tasks" },
  // One %2f decode, as the retired-path wall does.
  { method: "GET", path: "/api%2fnonsense" },
];

function send(
  srv: TestServer,
  method: string,
  path: string,
  auth: { rawSessionId?: string; headers?: Record<string, string> },
) {
  const hasBody = method !== "GET" && method !== "DELETE";
  return srv.http(path, {
    method,
    rawSessionId: auth.rawSessionId,
    headers: {
      ...(auth.headers ?? {}),
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify({}) : undefined,
  });
}

async function expectApiNotFound(res: Response, method: string, path: string) {
  expect({ method, path, status: res.status }).toEqual({
    method,
    path,
    status: 404,
  });
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as { error?: { code?: unknown } };
  expect(body.error?.code).toBe("not_found");
}

describe("routes/api-unknown: an unmatched /api path is a JSON 404", () => {
  it("an owner cookie gets the /api 404 envelope", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    for (const { method, path } of UNKNOWN) {
      const res = await send(srv, method, path, {
        rawSessionId: owner.rawSessionId,
      });
      await expectApiNotFound(res, method, path);
    }
  });

  it("an agent bearer gets the same 404", async () => {
    const srv = await startTestServer();
    server = srv;
    const raw = mintAgentToken("agent-unknown-api", "user-1");
    for (const { method, path } of UNKNOWN) {
      const res = await send(srv, method, path, {
        headers: { Authorization: `Bearer ${raw}` },
      });
      await expectApiNotFound(res, method, path);
    }
  });

  it("the 404 matches what a known /api route answers for a miss", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const known = await srv.http("/api/tasks/deadbeef", {
      rawSessionId: owner.rawSessionId,
    });
    const unknown = await srv.http("/api/nonsense", {
      rawSessionId: owner.rawSessionId,
    });
    expect(known.status).toBe(404);
    expect(Object.keys(await unknown.json())).toEqual(
      Object.keys(await known.json()),
    );
  });

  it("anonymous callers still 401 at the cookie wall", async () => {
    const srv = await startTestServer();
    server = srv;
    for (const { method, path } of UNKNOWN) {
      const res = await send(srv, method, path, {});
      expect({ method, path, status: res.status }).toEqual({
        method,
        path,
        status: 401,
      });
    }
  });
});

describe("routes/api-unknown: other paths keep the SPA fallback", () => {
  it("serves the shell for a client route and an /api look-alike", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    for (const path of ["/rooms/some-room", "/apiary", "/api"]) {
      const res = await srv.http(path, { rawSessionId: owner.rawSessionId });
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });
});
