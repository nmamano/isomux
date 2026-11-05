// GET /api/me/opencode (task a1e5ea01): the Model providers tab's OpenCode
// state through the real route table and server.
//
// Pins: the caller's own key source, never a value; the office-wide free limit
// from the manager's record; a caller with no session gets no answer.
//
// Seam: startTestServer(). Zero LLM.

import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";

const OFFICE_KEY = "sk-office-opencode-FAKE-a1e5";
const MEMBER_KEY = "sk-member-opencode-FAKE-a1e5";

// A box whose service env names OPENCODE_API_KEY would make every source
// "server"; this file is about the office and member variables.
const inherited = process.env.OPENCODE_API_KEY;
beforeAll(() => {
  delete process.env.OPENCODE_API_KEY;
});
afterAll(() => {
  if (inherited !== undefined) process.env.OPENCODE_API_KEY = inherited;
});

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

type Auth = { session?: string; bearer?: string };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: Auth & { body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await srv.http(path, {
    method,
    headers,
    rawSessionId: init.session,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 204 has no body.
  }
  return { status: response.status, body, text };
}

async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Mia");
  return { srv, owner, member };
}

it("names the caller's own key source: the office key, then the member's own over it", async () => {
  const o = await office();
  const status = (auth: Auth) => call(o.srv, "GET", "/api/me/opencode", auth);
  const owner = { session: o.owner.rawSessionId };
  const member = { session: o.member.rawSessionId };

  // The enabling state: no key anywhere yet.
  for (const auth of [owner, member]) {
    const r = await status(auth);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ freeLimitAt: null, keySource: null });
  }

  const set = await call(o.srv, "PUT", "/api/office/env/OPENCODE_API_KEY", {
    ...owner,
    body: { value: OFFICE_KEY },
  });
  expect(set.status).toBe(204);
  for (const auth of [owner, member])
    expect((await status(auth)).body).toEqual({
      freeLimitAt: null,
      keySource: "office_variable",
    });

  const own = await call(
    o.srv,
    "PUT",
    `/api/users/${o.member.username}/env/OPENCODE_API_KEY`,
    { ...member, body: { value: MEMBER_KEY } },
  );
  expect(own.status).toBe(204);
  const mine = await status(member);
  expect(mine.body).toEqual({
    freeLimitAt: null,
    keySource: "member_variable",
  });
  expect(mine.text).not.toContain(MEMBER_KEY);
  expect(mine.text).not.toContain(OFFICE_KEY);
  // The owner's agents still use the office key.
  expect((await status(owner)).body).toEqual({
    freeLimitAt: null,
    keySource: "office_variable",
  });
});

it("shows the office-wide free limit to every member", async () => {
  const o = await office();
  const before = Date.now();
  o.srv.agentManager.openCodeFreeLimit.record();
  for (const session of [o.owner.rawSessionId, o.member.rawSessionId]) {
    const r = await call(o.srv, "GET", "/api/me/opencode", { session });
    expect(r.status).toBe(200);
    const at = (r.body as { freeLimitAt: number | null }).freeLimitAt;
    expect(typeof at).toBe("number");
    expect(at!).toBeGreaterThanOrEqual(before);
    expect(at!).toBeLessThanOrEqual(Date.now());
  }
});

it("answers 401 without a session", async () => {
  const o = await office();
  const r = await call(o.srv, "GET", "/api/me/opencode");
  expect(r.status).toBe(401);
  expect(r.body).not.toHaveProperty("keySource");
});
