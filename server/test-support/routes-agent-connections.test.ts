// GET /api/agent-connections (integrations A4): the connections an agent
// gets, with their usage notes. Agent tokens only; the token's member and the
// office, never another member; the set the spawn really gives; never a
// value, a URL path or query, or the secret behind an MCP server. And the
// notes round-trip through the routes where the connections are set.

import { afterEach, describe, expect, it } from "bun:test";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import type {
  AgentConnectionsRes,
  UserEnvRes,
} from "../../shared/contract-shapes.ts";
import { CONNECTION_NOTE_MAX_LENGTH } from "../../shared/connection-notes.ts";

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
  return { status: response.status, text: await response.text() };
}

async function expectStatus(
  srv: TestServer,
  status: number,
  path: string,
  init: { method?: string; body?: unknown; session?: string },
) {
  const result = await call(srv, path, init);
  expect({ path, status: result.status }).toEqual({ path, status });
  return result;
}

// Fake values: none may appear in an agent's answer.
const FAKE = {
  officeVar: "fake-office-var-value-1111",
  sharedOffice: "fake-shared-office-value-2222",
  sharedMine: "fake-shared-member-value-3333",
  mineVar: "fake-member-var-value-4444",
  otherVar: "fake-other-var-value-5555",
  officeSecret: "fake-office-secret-value-6666",
  mineSecret: "fake-member-secret-value-7777",
  pathToken: "fakepathtoken8888",
  queryToken: "fakequerytoken9999",
};

async function seeded() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Boss");
  const member = await srv.seedMember("Member");
  const other = await srv.seedMember("Other");
  const o = owner.rawSessionId;
  const m = member.rawSessionId;
  const mine = `/api/users/${member.username}`;
  await expectStatus(srv, 204, "/api/office/env", {
    method: "PUT",
    session: o,
    body: {
      values: { OFFICE_TOKEN: FAKE.officeVar, SHARED: FAKE.sharedOffice },
      notes: { OFFICE_TOKEN: "office variable note", SHARED: "office shared" },
    },
  });
  await expectStatus(srv, 204, `${mine}/env`, {
    method: "PUT",
    session: m,
    body: {
      values: { MINE: FAKE.mineVar, SHARED: FAKE.sharedMine },
      notes: { MINE: "my variable note", SHARED: "my shared" },
    },
  });
  await expectStatus(srv, 204, `/api/users/${other.username}/env`, {
    method: "PUT",
    session: other.rawSessionId,
    body: { values: { OTHERS: FAKE.otherVar }, notes: { OTHERS: "theirs" } },
  });
  await expectStatus(srv, 201, "/api/office/secrets", {
    method: "POST",
    session: o,
    body: {
      name: "OFFICE_GH",
      value: FAKE.officeSecret,
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
      note: "office secret note",
    },
  });
  await expectStatus(srv, 201, `${mine}/secrets`, {
    method: "POST",
    session: m,
    body: {
      name: "LINEAR",
      value: FAKE.mineSecret,
      hosts: ["mcp.linear.app"],
      form: { kind: "authorization" },
      note: "my secret note",
    },
  });
  await expectStatus(srv, 201, `${mine}/secrets`, {
    method: "POST",
    session: m,
    body: {
      name: "MOVED",
      value: FAKE.mineSecret,
      hosts: ["mcp.moved.example"],
      form: { kind: "authorization" },
    },
  });
  // Office servers: one with a token in its path and query, one the member
  // shadows.
  await expectStatus(srv, 201, "/api/office/mcp-servers", {
    method: "POST",
    session: o,
    body: {
      name: "docs",
      url: `https://mcp.docs.example/${FAKE.pathToken}/mcp?key=${FAKE.queryToken}`,
      secret: null,
      note: "office docs note",
    },
  });
  await expectStatus(srv, 201, "/api/office/mcp-servers", {
    method: "POST",
    session: o,
    body: {
      name: "linear",
      url: "https://mcp.office-linear.example/mcp",
      secret: null,
      note: "office linear note",
    },
  });
  await expectStatus(srv, 201, `${mine}/mcp-servers`, {
    method: "POST",
    session: m,
    body: {
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      secret: "LINEAR",
      note: "my linear note",
    },
  });
  // A server the spawn leaves out: its secret no longer lists its host.
  await expectStatus(srv, 201, `${mine}/mcp-servers`, {
    method: "POST",
    session: m,
    body: {
      name: "moved",
      url: "https://mcp.moved.example/mcp",
      secret: "MOVED",
    },
  });
  await expectStatus(srv, 200, `${mine}/secrets/MOVED`, {
    method: "PATCH",
    session: m,
    body: { hosts: ["elsewhere.example"] },
  });
  const memberId = getUserByName(member.username)!.id;
  const ownerId = getUserByName(owner.username)!.id;
  return { srv, owner, member, other, memberId, ownerId };
}

function connections(text: string): AgentConnectionsRes["connections"] {
  return (JSON.parse(text) as AgentConnectionsRes).connections;
}

describe("GET /api/agent-connections", () => {
  it("gives an agent its member's and the office's connections, as the spawn gives them", async () => {
    const { srv, memberId } = await seeded();
    const result = await call(srv, "/api/agent-connections", {
      bearer: mintAgentToken("agent-connections-member", memberId, false),
    });
    expect(result.status).toBe(200);
    expect(connections(result.text)).toEqual([
      {
        kind: "variable",
        scope: "office",
        name: "OFFICE_TOKEN",
        hosts: [],
        note: "office variable note",
      },
      // The member's SHARED replaces the office one.
      {
        kind: "variable",
        scope: "personal",
        name: "MINE",
        hosts: [],
        note: "my variable note",
      },
      {
        kind: "variable",
        scope: "personal",
        name: "SHARED",
        hosts: [],
        note: "my shared",
      },
      {
        kind: "secret",
        scope: "office",
        name: "OFFICE_GH",
        hosts: ["api.github.com"],
        note: "office secret note",
      },
      {
        kind: "secret",
        scope: "personal",
        name: "LINEAR",
        hosts: ["mcp.linear.app"],
        note: "my secret note",
      },
      {
        kind: "secret",
        scope: "personal",
        name: "MOVED",
        hosts: ["elsewhere.example"],
        note: null,
      },
      // The member's linear replaces the office one; moved is left out.
      {
        kind: "mcp-server",
        scope: "office",
        name: "docs",
        engineName: "isomux-docs",
        hosts: ["mcp.docs.example"],
        note: "office docs note",
      },
      {
        kind: "mcp-server",
        scope: "personal",
        name: "linear",
        engineName: "isomux-linear",
        hosts: ["mcp.linear.app"],
        note: "my linear note",
      },
    ]);
    // No value, URL path or query, and no other member's connection.
    for (const fake of Object.values(FAKE))
      expect(result.text).not.toContain(fake);
    expect(result.text).not.toContain("OTHERS");
    expect(result.text).not.toContain("theirs");
    expect(result.text).not.toContain("office shared");
    expect(result.text).not.toContain("office linear note");
  });

  it("gives an agent with no member the office's connections only", async () => {
    const { srv } = await seeded();
    const result = await call(srv, "/api/agent-connections", {
      bearer: mintAgentToken("agent-connections-nobody", null, false),
    });
    expect(result.status).toBe(200);
    const list = connections(result.text);
    expect(list.map((c) => `${c.kind}:${c.scope}:${c.name}`)).toEqual([
      "variable:office:OFFICE_TOKEN",
      "variable:office:SHARED",
      "secret:office:OFFICE_GH",
      "mcp-server:office:docs",
      "mcp-server:office:linear",
    ]);
    for (const fake of Object.values(FAKE))
      expect(result.text).not.toContain(fake);
  });

  it("refuses a member session and an API token", async () => {
    const { srv, owner, ownerId } = await seeded();
    const api = await mintApiToken({
      userId: ownerId,
      name: "Owner API",
      expiresInDays: null,
    });
    expect({
      session: (
        await call(srv, "/api/agent-connections", {
          session: owner.rawSessionId,
        })
      ).status,
      api: (await call(srv, "/api/agent-connections", { bearer: api.token }))
        .status,
    }).toEqual({ session: 403, api: 403 });
  });
});

describe("usage notes where connections are set", () => {
  it("round-trips a variable's note, keeps it on a PUT without notes and drops it with its variable", async () => {
    const { srv, member } = await seeded();
    const path = `/api/users/${member.username}/env`;
    const session = member.rawSessionId;
    const read = async () =>
      JSON.parse((await expectStatus(srv, 200, path, { session })).text)
        .notes as UserEnvRes["notes"];
    expect(await read()).toEqual({
      MINE: "my variable note",
      SHARED: "my shared",
    });
    // An API caller that sends values only keeps the notes.
    await expectStatus(srv, 204, path, {
      method: "PUT",
      session,
      body: { values: { MINE: "v", SHARED: "v" } },
    });
    expect(await read()).toEqual({
      MINE: "my variable note",
      SHARED: "my shared",
    });
    // A removed variable takes its note; a re-added one has none.
    await expectStatus(srv, 204, path, {
      method: "PUT",
      session,
      body: { values: { MINE: "v" } },
    });
    expect(await read()).toEqual({ MINE: "my variable note" });
    await expectStatus(srv, 204, path, {
      method: "PUT",
      session,
      body: { values: { MINE: "v", SHARED: "v" } },
    });
    expect(await read()).toEqual({ MINE: "my variable note" });
    // An edit, and an empty note clears.
    await expectStatus(srv, 204, path, {
      method: "PUT",
      session,
      body: {
        values: { MINE: "v", SHARED: "v" },
        notes: { MINE: "  line one\nline two  ", SHARED: "  " },
      },
    });
    expect(await read()).toEqual({ MINE: "line one\nline two" });
  });

  it("refuses an over-long note or a control character with a 400 and keeps the saved one", async () => {
    const { srv, owner, member } = await seeded();
    const mine = `/api/users/${member.username}`;
    const session = member.rawSessionId;
    const long = "x".repeat(CONNECTION_NOTE_MAX_LENGTH + 1);
    await expectStatus(srv, 400, `${mine}/env`, {
      method: "PUT",
      session,
      body: { values: { MINE: "v" }, notes: { MINE: long } },
    });
    await expectStatus(srv, 400, "/api/office/env", {
      method: "PUT",
      session: owner.rawSessionId,
      body: {
        values: { OFFICE_TOKEN: "v" },
        notes: { OFFICE_TOKEN: "a\u0007" },
      },
    });
    await expectStatus(srv, 400, `${mine}/secrets/LINEAR`, {
      method: "PATCH",
      session,
      body: { note: long },
    });
    await expectStatus(srv, 400, `${mine}/mcp-servers/linear`, {
      method: "PATCH",
      session,
      body: { note: "a\u0000b" },
    });
    // At the cap is fine.
    await expectStatus(srv, 200, `${mine}/secrets/LINEAR`, {
      method: "PATCH",
      session,
      body: { note: "y".repeat(CONNECTION_NOTE_MAX_LENGTH) },
    });
    const env = JSON.parse(
      (await expectStatus(srv, 200, `${mine}/env`, { session })).text,
    ) as UserEnvRes;
    expect(env.notes?.MINE).toBe("my variable note");
    expect(env.values.MINE).toBe(FAKE.mineVar);
  });

  it("edits, keeps and clears a secret's and an MCP server's note", async () => {
    const { srv, member } = await seeded();
    const mine = `/api/users/${member.username}`;
    const session = member.rawSessionId;
    const secretNote = async () =>
      (
        JSON.parse(
          (await expectStatus(srv, 200, `${mine}/secrets`, { session })).text,
        ).secrets as { name: string; note: string | null }[]
      ).find((s) => s.name === "LINEAR")?.note;
    const serverNote = async () =>
      (
        JSON.parse(
          (await expectStatus(srv, 200, `${mine}/mcp-servers`, { session }))
            .text,
        ).servers as { name: string; note: string | null }[]
      ).find((s) => s.name === "linear")?.note;

    expect(await secretNote()).toBe("my secret note");
    expect(await serverNote()).toBe("my linear note");
    // A PATCH without a note keeps it.
    await expectStatus(srv, 200, `${mine}/secrets/LINEAR`, {
      method: "PATCH",
      session,
      body: { hosts: ["mcp.linear.app", "api.linear.app"] },
    });
    await expectStatus(srv, 200, `${mine}/mcp-servers/linear`, {
      method: "PATCH",
      session,
      body: { url: "https://mcp.linear.app/v2" },
    });
    expect(await secretNote()).toBe("my secret note");
    expect(await serverNote()).toBe("my linear note");
    // An edit.
    await expectStatus(srv, 200, `${mine}/mcp-servers/linear`, {
      method: "PATCH",
      session,
      body: { note: "issues in the ops team only" },
    });
    expect(await serverNote()).toBe("issues in the ops team only");
    // null clears.
    await expectStatus(srv, 200, `${mine}/secrets/LINEAR`, {
      method: "PATCH",
      session,
      body: { note: null },
    });
    await expectStatus(srv, 200, `${mine}/mcp-servers/linear`, {
      method: "PATCH",
      session,
      body: { note: null },
    });
    expect(await secretNote()).toBeNull();
    expect(await serverNote()).toBeNull();
  });
});
