// Privileged agents manage integrations with their manager's reach (Nil,
// 2026-10-14): the manager's items, and the office's and every member's when
// the manager is an office owner. An ordinary agent reaches no change route,
// and no agent reaches a value: variable values, Show, the MCP sign-in, a
// host added to a saved secret (the agent holds the placeholder), or an MCP
// server's URL path (Lead, 2026-10-14). The route sets come from the table,
// so a route that moves between them turns a test red.

import { afterEach, describe, expect, it } from "bun:test";

import { API_ROUTES } from "../routes/table.ts";
import { runAuthorize } from "../routes/executor.ts";
import {
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  type Identity,
} from "../identity/index.ts";
import type { GuardDeps } from "../identity/guards.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, setUserRoleById } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const FAKE = "fake-agent-integrations-value";
const PATH_TOKEN = "path-token-AGENTSEKRIT";
const QUERY_TOKEN = "query-token-AGENTSEKRIT";
const MCP_URL = `https://mcp.example.com/${PATH_TOKEN}/mcp?key=${QUERY_TOKEN}`;

const FAMILIES = [
  "userEnv.",
  "officeEnv.",
  "secrets.",
  "officeSecrets.",
  "mcpServers.",
  "officeMcpServers.",
  "mcpOAuth.",
];

function capOf(opId: string): unknown {
  const auth = API_ROUTES.find((route) => route.opId === opId)!.auth;
  return auth.kind === "capability" ? auth.requiredCapability : null;
}

const integrationRoutes = API_ROUTES.filter(
  (route) => capOf(route.opId) === "integration:manage",
);
const valueRoutes = API_ROUTES.filter(
  (route) =>
    FAMILIES.some((family) => route.opId.startsWith(family)) &&
    capOf(route.opId) !== "integration:manage",
);

describe("the integration route sets", () => {
  it("puts exactly the change, list, names and Test routes on integration:manage", () => {
    expect(integrationRoutes.map((route) => route.opId).sort()).toEqual(
      [
        "userEnv.set",
        "userEnv.remove",
        "userEnv.names",
        "officeEnv.names",
        "officeEnv.set",
        "officeEnv.remove",
        "secrets.list",
        "secrets.create",
        "secrets.rotate",
        "secrets.update",
        "secrets.delete",
        "secrets.reissue",
        "secrets.test",
        "officeSecrets.list",
        "officeSecrets.create",
        "officeSecrets.rotate",
        "officeSecrets.update",
        "officeSecrets.delete",
        "officeSecrets.reissue",
        "officeSecrets.test",
        "mcpServers.list",
        "mcpServers.create",
        "mcpServers.update",
        "mcpServers.delete",
        "mcpServers.test",
        "officeMcpServers.list",
        "officeMcpServers.create",
        "officeMcpServers.update",
        "officeMcpServers.delete",
        "officeMcpServers.test",
      ].sort(),
    );
  });

  it("keeps every value route on user:env or secret:show", () => {
    expect(
      valueRoutes.map((route) => [route.opId, capOf(route.opId)]).sort(),
    ).toEqual(
      [
        ["userEnv.get", "user:env"],
        ["userEnv.replace", "user:env"],
        ["officeEnv.get", "user:env"],
        ["officeEnv.replace", "user:env"],
        ["secrets.reveal", "secret:show"],
        ["officeSecrets.reveal", "secret:show"],
        ["mcpServers.signIn", "user:env"],
        ["officeMcpServers.signIn", "user:env"],
        ["mcpOAuth.callback", "user:env"],
      ].sort(),
    );
  });
});

describe("integration routes at the guard", () => {
  const deps: GuardDeps = {
    hasRoomAccess: () => true,
    roomIdForAgent: () => "r1",
    userIdForUsername: (username) => username,
    cronjobCreatorUserId: () => null,
    appOwnerUserId: () => null,
    webhookOwnerUserId: () => null,
    isOfficeOwnerUserId: (userId) => userId === "boss",
    agentManagerUserId: () => null,
    killedAgentManagerUserId: () => null,
  };
  const agent = (
    userId: string,
    capabilities: Identity["capabilities"],
  ): Identity => ({
    scope: "agent",
    userId,
    agentId: `${userId}-agent`,
    role: "member",
    capabilities,
  });
  const allowed = (opId: string, who: Identity, username: string) =>
    runAuthorize(
      API_ROUTES.find((route) => route.opId === opId)!.auth,
      who,
      { username, name: "X" },
      {},
      deps,
    ).ok;

  it("refuses an owner's ordinary agent on every integration route", () => {
    const plain = agent("boss", AGENT_CAPABILITIES);
    for (const route of integrationRoutes)
      for (const username of ["boss", "member"])
        expect([
          route.opId,
          username,
          allowed(route.opId, plain, username),
        ]).toEqual([route.opId, username, false]);
  });

  it("refuses every agent, an owner's or a member's, on every value route", () => {
    for (const userId of ["boss", "member"])
      for (const caps of [AGENT_CAPABILITIES, PRIVILEGED_AGENT_CAPABILITIES])
        for (const route of valueRoutes)
          expect([
            route.opId,
            userId,
            allowed(route.opId, agent(userId, caps), userId),
          ]).toEqual([route.opId, userId, false]);
  });

  it("gives a privileged agent its manager's reach", () => {
    const owners = agent("boss", PRIVILEGED_AGENT_CAPABILITIES);
    const members = agent("member", PRIVILEGED_AGENT_CAPABILITIES);
    for (const route of integrationRoutes) {
      const office = route.path.startsWith("/api/office/");
      const names = route.opId === "userEnv.names";
      // An owner's agent: everything.
      for (const username of ["boss", "member"])
        expect([
          route.opId,
          username,
          allowed(route.opId, owners, username),
        ]).toEqual([route.opId, username, true]);
      // A member's agent: its manager's items, and the office lists.
      expect([route.opId, allowed(route.opId, members, "member")]).toEqual([
        route.opId,
        office ? route.method === "GET" : !names,
      ]);
      expect([route.opId, allowed(route.opId, members, "other")]).toEqual([
        route.opId,
        office && route.method === "GET",
      ]);
    }
  });
});

interface Res {
  status: number;
  body: unknown;
  text: string;
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: { session?: string; bearer?: string; body?: unknown } = {},
): Promise<Res> {
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
  server = await startTestServer({
    startServer: {
      connectionTestFetch: async () => new Response("no", { status: 401 }),
    },
  });
  const srv = server;
  const boss = await srv.seedOwner("Boss");
  const member = await srv.seedMember("Member");
  const other = await srv.seedMember("Other");
  const bossId = getUserByName(boss.username)!.id;
  const memberId = getUserByName(member.username)!.id;
  return {
    srv,
    boss,
    member,
    other,
    bossId,
    ownerAgent: mintAgentToken("boss-privileged", bossId, true),
    ownerPlain: mintAgentToken("boss-plain", bossId, false),
    memberAgent: mintAgentToken("member-privileged", memberId, true),
  };
}

type Office = Awaited<ReturnType<typeof office>>;

const secretBody = (name: string, hosts = ["api.example.com"]) => ({
  name,
  value: FAKE,
  hosts,
  form: { kind: "authorization" },
});

// A concrete path for a table route.
function pathOf(route: (typeof API_ROUTES)[number], username: string): string {
  return route.path
    .replace(":username", username)
    .replace(":name", "SOME_NAME");
}

async function auditRows(o: Office) {
  const audit = await call(o.srv, "GET", "/api/audit-log?limit=500", {
    session: o.boss.rawSessionId,
  });
  expect(audit.status).toBe(200);
  return (
    audit.body as {
      items: {
        operation: string;
        targets: string[];
        actor: { kind: string; id: string };
      }[];
    }
  ).items;
}

describe("integration routes on the wire", () => {
  it("refuses an owner's ordinary agent on every integration route, and every agent on every value route", async () => {
    const o = await office();
    for (const route of integrationRoutes)
      for (const username of [o.boss.username, o.member.username]) {
        const res = await call(o.srv, route.method, pathOf(route, username), {
          bearer: o.ownerPlain,
          body: route.method === "GET" ? undefined : {},
        });
        expect([route.opId, username, res.status]).toEqual([
          route.opId,
          username,
          403,
        ]);
      }
    for (const bearer of [o.ownerAgent, o.memberAgent, o.ownerPlain])
      for (const route of valueRoutes) {
        const res = await call(
          o.srv,
          route.method,
          pathOf(route, o.member.username),
          { bearer, body: route.method === "GET" ? undefined : { values: {} } },
        );
        expect([route.opId, res.status]).toEqual([route.opId, 403]);
      }
  });

  it("lets a member's privileged agent change its manager's items only", async () => {
    const o = await office();
    const auth = { bearer: o.memberAgent };
    const own = `/api/users/${o.member.username}`;
    const other = `/api/users/${o.other.username}`;
    const steps: [string, string, unknown, number][] = [
      ["PUT", `${own}/env/AGENT_VAR`, { value: "v", note: "By agent." }, 204],
      ["GET", `${own}/secrets`, undefined, 200],
      ["POST", `${own}/secrets`, secretBody("AGENT_TOKEN"), 201],
      ["PUT", `${own}/secrets/AGENT_TOKEN/value`, { value: `${FAKE}-2` }, 200],
      ["PATCH", `${own}/secrets/AGENT_TOKEN`, { note: "Use for X." }, 200],
      ["POST", `${own}/secrets/AGENT_TOKEN/reissue`, undefined, 200],
      ["POST", `${own}/secrets/AGENT_TOKEN/test`, undefined, 200],
      ["GET", `${own}/mcp-servers`, undefined, 200],
      [
        "POST",
        `${own}/mcp-servers`,
        { name: "docs", url: MCP_URL, secret: null },
        201,
      ],
      ["PATCH", `${own}/mcp-servers/docs`, { note: "Docs." }, 200],
      ["POST", `${own}/mcp-servers/docs/test`, undefined, 200],
      ["DELETE", `${own}/mcp-servers/docs`, undefined, 204],
      ["DELETE", `${own}/secrets/AGENT_TOKEN`, undefined, 204],
      ["DELETE", `${own}/env/AGENT_VAR`, undefined, 204],
    ];
    for (const [method, path, body, status] of steps) {
      const res = await call(o.srv, method, path, { ...auth, body });
      expect([method, path, res.status]).toEqual([method, path, status]);
      expect(res.text).not.toContain(FAKE);
    }

    // Another member's items and the office changes: refused.
    for (const [method, path, body] of [
      ["GET", `${other}/secrets`],
      ["POST", `${other}/secrets`, secretBody("X_TOKEN")],
      ["PUT", `${other}/env/X`, { value: "x" }],
      ["GET", `${other}/env/names`],
      ["GET", `${other}/mcp-servers`],
      ["GET", `${own}/env/names`],
      ["PUT", "/api/office/env/X", { value: "x" }],
      ["POST", "/api/office/secrets", secretBody("X_TOKEN")],
      [
        "POST",
        "/api/office/mcp-servers",
        { name: "x", url: MCP_URL, secret: null },
      ],
    ] as [string, string, unknown?][]) {
      const res = await call(o.srv, method, path, { ...auth, body });
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  it("gives a member's privileged agent the member's summary of the office lists", async () => {
    const o = await office();
    const boss = { session: o.boss.rawSessionId };
    await call(o.srv, "POST", "/api/office/secrets", {
      ...boss,
      body: secretBody("OFFICE_TOKEN"),
    });
    await call(o.srv, "POST", "/api/office/mcp-servers", {
      ...boss,
      body: { name: "mail", url: MCP_URL, secret: null },
    });
    await call(o.srv, "PUT", "/api/office/env/OFFICE_VAR", {
      ...boss,
      body: { value: FAKE },
    });
    const auth = { bearer: o.memberAgent };
    const secrets = await call(o.srv, "GET", "/api/office/secrets", auth);
    expect(secrets.body).toEqual({
      secrets: [
        { name: "OFFICE_TOKEN", hosts: ["api.example.com"], note: null },
      ],
    });
    const servers = await call(o.srv, "GET", "/api/office/mcp-servers", auth);
    expect(servers.body).toEqual({
      servers: [{ name: "mail", host: "mcp.example.com", note: null }],
    });
    const names = await call(o.srv, "GET", "/api/office/env/names", auth);
    expect(names.body).toEqual({
      variables: [{ name: "OFFICE_VAR", note: null }],
    });
    for (const res of [secrets, servers, names]) {
      expect(res.text).not.toContain(FAKE);
      expect(res.text).not.toContain(PATH_TOKEN);
    }
  });

  it("lets an owner's privileged agent change the office's and another member's items, and audits it as the agent", async () => {
    const o = await office();
    const auth = { bearer: o.ownerAgent };
    const member = `/api/users/${o.member.username}`;
    for (const [method, path, body, status] of [
      [
        "PUT",
        "/api/office/env/OFFICE_VAR",
        { value: FAKE, note: "Office." },
        204,
      ],
      ["GET", "/api/office/env/names", undefined, 200],
      ["POST", "/api/office/secrets", secretBody("OFFICE_TOKEN"), 201],
      ["PATCH", "/api/office/secrets/OFFICE_TOKEN", { note: "N." }, 200],
      ["POST", "/api/office/secrets/OFFICE_TOKEN/test", undefined, 200],
      [
        "POST",
        "/api/office/mcp-servers",
        { name: "mail", url: MCP_URL, secret: null },
        201,
      ],
      ["POST", "/api/office/mcp-servers/mail/test", undefined, 200],
      ["PUT", `${member}/env/MEMBER_VAR`, { value: FAKE }, 204],
      ["GET", `${member}/env/names`, undefined, 200],
      ["POST", `${member}/secrets`, secretBody("MEMBER_TOKEN"), 201],
      [
        "POST",
        `${member}/mcp-servers`,
        { name: "docs", url: MCP_URL, secret: null },
        201,
      ],
      ["DELETE", "/api/office/env/OFFICE_VAR", undefined, 204],
    ] as [string, string, unknown, number][]) {
      const res = await call(o.srv, method, path, { ...auth, body });
      expect([method, path, res.status]).toEqual([method, path, status]);
      expect(res.text).not.toContain(FAKE);
    }
    // The owner's rows, not the member summary: the form, and the server's
    // secret field, with the host in place of the URL.
    const secrets = await call(o.srv, "GET", "/api/office/secrets", auth);
    expect(
      (secrets.body as { secrets: Record<string, unknown>[] }).secrets[0],
    ).toEqual(
      expect.objectContaining({
        name: "OFFICE_TOKEN",
        form: { kind: "authorization" },
      }),
    );
    const servers = await call(o.srv, "GET", "/api/office/mcp-servers", auth);
    expect(
      (servers.body as { servers: Record<string, unknown>[] }).servers[0],
    ).toEqual(
      expect.objectContaining({
        name: "mail",
        host: "mcp.example.com",
        secret: null,
      }),
    );
    // The member reads what the owner's agent saved for them.
    const own = await call(o.srv, "GET", `${member}/secrets`, {
      session: o.member.rawSessionId,
    });
    expect(
      (own.body as { secrets: { name: string }[] }).secrets.map((s) => s.name),
    ).toEqual(["MEMBER_TOKEN"]);

    const rows = await auditRows(o);
    for (const operation of [
      "officeEnv.set",
      "officeEnv.remove",
      "officeSecrets.create",
      "officeMcpServers.create",
      "userEnv.set",
      "secrets.create",
      "mcpServers.create",
    ]) {
      const row = rows.find((candidate) => candidate.operation === operation);
      expect([operation, row?.actor.kind, row?.actor.id]).toEqual([
        operation,
        "agent",
        "boss-privileged",
      ]);
    }
    expect(
      rows.find((row) => row.operation === "officeEnv.set")?.targets.sort(),
    ).toEqual(["OFFICE_VAR", "office"]);
  });

  it("drops an owner's agent to its manager's reach on the next request after a demotion", async () => {
    const o = await office();
    const auth = { bearer: o.ownerAgent };
    const put = () =>
      call(o.srv, "PUT", "/api/office/env/A", {
        ...auth,
        body: { value: "a" },
      });
    expect((await put()).status).toBe(204);
    expect(setUserRoleById(o.bossId, "member")).toBe(true);
    expect((await put()).status).toBe(403);
    const memberPath = `/api/users/${o.member.username}/env/B`;
    expect(
      (await call(o.srv, "PUT", memberPath, { ...auth, body: { value: "b" } }))
        .status,
    ).toBe(403);
  });
});

describe("an agent never adds a host to a saved secret", () => {
  it("refuses an added host, allows removing one, and leaves humans alone", async () => {
    const o = await office();
    const member = `/api/users/${o.member.username}`;
    for (const [bearer, base] of [
      [o.memberAgent, `${member}/secrets`],
      [o.ownerAgent, "/api/office/secrets"],
    ] as const) {
      const hosts = ["api.example.com", "two.example.com"];
      expect(
        (
          await call(o.srv, "POST", base, {
            bearer,
            body: secretBody("HOSTED", hosts),
          })
        ).status,
      ).toBe(201);
      const list = async () =>
        (
          (await call(o.srv, "GET", base, { bearer })).body as {
            secrets: { name: string; hosts: string[] }[];
          }
        ).secrets.find((s) => s.name === "HOSTED")!.hosts;
      for (const added of [
        [...hosts, "evil.example.net"],
        ["evil.example.net"],
      ]) {
        const res = await call(o.srv, "PATCH", `${base}/HOSTED`, {
          bearer,
          body: { hosts: added, note: "x" },
        });
        expect([
          base,
          res.status,
          (res.body as { error?: { code?: string } }).error?.code,
        ]).toEqual([base, 403, "secret_host_add_refused"]);
        expect(await list()).toEqual(hosts);
      }
      // The same hosts, a removal and a note pass.
      for (const body of [
        { hosts },
        { hosts: ["api.example.com"] },
        { note: "Only notes." },
      ])
        expect(
          (await call(o.srv, "PATCH", `${base}/HOSTED`, { bearer, body }))
            .status,
        ).toBe(200);
      expect(await list()).toEqual(["api.example.com"]);
    }
    // A human adds a host.
    const res = await call(o.srv, "PATCH", `${member}/secrets/HOSTED`, {
      session: o.member.rawSessionId,
      body: { hosts: ["api.example.com", "three.example.com"] },
    });
    expect(res.status).toBe(200);
  });
});

describe("an agent never receives an MCP server's URL path", () => {
  it("answers every list, create and update with the host to an agent, and the URL to a human", async () => {
    const o = await office();
    const member = `/api/users/${o.member.username}/mcp-servers`;
    const responses: Res[] = [];
    for (const [bearer, base] of [
      [o.memberAgent, member],
      [o.ownerAgent, "/api/office/mcp-servers"],
    ] as const) {
      responses.push(
        await call(o.srv, "POST", base, {
          bearer,
          body: { name: "docs", url: MCP_URL, secret: null },
        }),
        await call(o.srv, "PATCH", `${base}/docs`, {
          bearer,
          body: { note: "Note only." },
        }),
        await call(o.srv, "GET", base, { bearer }),
      );
    }
    expect(responses.map((res) => res.status)).toEqual([
      201, 200, 200, 201, 200, 200,
    ]);
    for (const res of responses) {
      expect(res.text).not.toContain(PATH_TOKEN);
      expect(res.text).not.toContain(QUERY_TOKEN);
      expect(res.text).not.toContain('"url"');
      expect(res.text).toContain('"host":"mcp.example.com"');
    }
    for (const [session, base] of [
      [o.member.rawSessionId, member],
      [o.boss.rawSessionId, "/api/office/mcp-servers"],
    ] as const) {
      const human = await call(o.srv, "GET", base, { session });
      expect(
        (human.body as { servers: { url: string }[] }).servers[0].url,
      ).toBe(MCP_URL);
    }
  });
});

describe("office variables one at a time", () => {
  it("sets, keeps or clears the note, removes, and refuses a bad name or body and a member", async () => {
    const o = await office();
    const auth = { session: o.boss.rawSessionId };
    const put = (name: string, body: unknown) =>
      call(o.srv, "PUT", `/api/office/env/${name}`, { ...auth, body });
    const read = async () =>
      (await call(o.srv, "GET", "/api/office/env", auth)).body as {
        values: Record<string, string>;
        notes: Record<string, string>;
      };
    expect((await put("KEEP", { value: "k", note: "Kept." })).status).toBe(204);
    expect((await put("A", { value: "1", note: "First." })).status).toBe(204);
    expect((await put("A", { value: "2" })).status).toBe(204);
    expect(await read()).toEqual(
      expect.objectContaining({
        values: { A: "2", KEEP: "k" },
        notes: { A: "First.", KEEP: "Kept." },
      }),
    );
    expect((await put("A", { value: "2", note: null })).status).toBe(204);
    expect((await read()).notes).toEqual({ KEEP: "Kept." });
    const before = await read();
    for (const [name, body] of [
      ["1BAD", { value: "x" }],
      ["__proto__", { value: "x" }],
      ["GOOD", { value: "x", other: 1 }],
      ["GOOD", { note: "x" }],
    ] as [string, unknown][])
      expect([name, (await put(name, body)).status]).toEqual([name, 400]);
    expect(await read()).toEqual(before);
    expect(
      (await call(o.srv, "DELETE", "/api/office/env/NO_SUCH", auth)).status,
    ).toBe(404);
    expect(
      (await call(o.srv, "DELETE", "/api/office/env/A", auth)).status,
    ).toBe(204);
    expect((await read()).values).toEqual({ KEEP: "k" });
    for (const [method, body] of [
      ["PUT", { value: "x" }],
      ["DELETE", undefined],
    ] as const)
      expect(
        (
          await call(o.srv, method, "/api/office/env/KEEP", {
            session: o.member.rawSessionId,
            body,
          })
        ).status,
      ).toBe(403);
    expect((await read()).values).toEqual({ KEEP: "k" });
  });
});
