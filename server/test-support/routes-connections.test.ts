// GET /api/me/connections: the integrations list. Names only, never a value;
// the office items for every member (Nil, ruling 2, 2026-10-13); the caller's
// own personal entries only; no agent or API token.

import { afterEach, describe, expect, it } from "bun:test";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import type { ConnectionsListRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function call(
  srv: TestServer,
  path: string,
  init: { method?: string; body?: unknown; session?: string; bearer?: string },
) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.session,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function putEnv(
  srv: TestServer,
  path: string,
  session: string,
  values: Record<string, string>,
) {
  const result = await call(srv, path, {
    method: "PUT",
    session,
    body: { values },
  });
  expect(result.status).toBe(204);
}

const OFFICE_VALUE = "office-value-must-not-leak";
const OWNER_VALUE = "owner-value-must-not-leak";
const MEMBER_VALUE = "member-value-must-not-leak";
const OFFICE_SECRET_VALUE = "office-secret-value-must-not-leak";

async function seeded() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Boss");
  const member = await srv.seedMember("Member");
  const other = await srv.seedMember("Other");
  await putEnv(srv, "/api/office/env", owner.rawSessionId, {
    OFFICE_TOKEN: OFFICE_VALUE,
  });
  expect(
    (
      await call(srv, "/api/office/secrets", {
        method: "POST",
        session: owner.rawSessionId,
        body: {
          name: "GH_TOKEN",
          value: OFFICE_SECRET_VALUE,
          hosts: ["api.github.com"],
          form: { kind: "authorization" },
        },
      })
    ).status,
  ).toBe(201);
  await putEnv(srv, `/api/users/${owner.username}/env`, owner.rawSessionId, {
    OWNER_TOKEN: OWNER_VALUE,
  });
  await putEnv(srv, `/api/users/${member.username}/env`, member.rawSessionId, {
    MEMBER_TOKEN: MEMBER_VALUE,
  });
  await putEnv(srv, `/api/users/${other.username}/env`, other.rawSessionId, {
    OTHER_TOKEN: "other-value",
  });
  return { srv, owner, member, other };
}

function list(text: string): ConnectionsListRes {
  return JSON.parse(text) as ConnectionsListRes;
}

describe("GET /api/me/connections", () => {
  it("gives an owner office and own variable names and no value", async () => {
    const { srv, owner } = await seeded();
    const result = await call(srv, "/api/me/connections", {
      session: owner.rawSessionId,
    });
    expect(result.status).toBe(200);
    expect(list(result.text).variables).toEqual([
      { scope: "office", name: "OFFICE_TOKEN", note: null },
      { scope: "personal", name: "OWNER_TOKEN", note: null },
    ]);
    expect(list(result.text).secrets?.map((s) => [s.scope, s.test])).toEqual([
      ["office", "github"],
    ]);
    for (const value of [OFFICE_VALUE, OFFICE_SECRET_VALUE, OWNER_VALUE])
      expect(result.text).not.toContain(value);
  });

  it("gives a member the office names and their own, never a value", async () => {
    const { srv, member } = await seeded();
    const result = await call(srv, "/api/me/connections", {
      session: member.rawSessionId,
    });
    expect(result.status).toBe(200);
    expect(list(result.text).variables).toEqual([
      { scope: "office", name: "OFFICE_TOKEN", note: null },
      { scope: "personal", name: "MEMBER_TOKEN", note: null },
    ]);
    // Only an owner may test an office secret.
    expect(list(result.text).secrets).toEqual([
      {
        scope: "office",
        name: "GH_TOKEN",
        hosts: ["api.github.com"],
        test: null,
        note: null,
      },
    ]);
    expect(result.text).not.toContain("OTHER_TOKEN");
    for (const value of [OFFICE_VALUE, OFFICE_SECRET_VALUE, MEMBER_VALUE])
      expect(result.text).not.toContain(value);
  });

  it("refuses agent and API tokens", async () => {
    const { srv, owner } = await seeded();
    const ownerId = getUserByName(owner.username)!.id;
    const api = await mintApiToken({
      userId: ownerId,
      name: "Owner API",
      expiresInDays: null,
    });
    const statuses = {
      api: (await call(srv, "/api/me/connections", { bearer: api.token }))
        .status,
      agent: (
        await call(srv, "/api/me/connections", {
          bearer: mintAgentToken("connections-agent", ownerId, false),
        })
      ).status,
      privileged: (
        await call(srv, "/api/me/connections", {
          bearer: mintAgentToken("connections-privileged", ownerId, true),
        })
      ).status,
    };
    expect(statuses).toEqual({ api: 403, agent: 403, privileged: 403 });
  });
});
