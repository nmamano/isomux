// Remote MCP server routes (integrations loop, A2): the lifecycle, the gates,
// the field rules, and the read paths. The URL of some hosted servers carries
// a token in its path, so only the editor's own list returns it: never an
// error, an audit row, the integrations list or a log line.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, statSync } from "fs";
import { join } from "path";

import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const PATH_TOKEN = "fake-path-token-0000-mcp";
const URL_WITH_TOKEN = `https://mcp.example.com/${PATH_TOKEN}/mcp`;

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
  text: string;
}

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: { body?: unknown; session?: string; bearer?: string } = {},
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

const errorOf = (res: Res) =>
  (res.body as { error?: Record<string, unknown> }).error ?? {};

function secret(name: string, hosts: string[]) {
  return {
    name,
    value: "fake-mcp-secret-value-0000",
    hosts,
    form: { kind: "authorization" },
  };
}

async function consoleDuring(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(
    (level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      }),
  );
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines.join("\n");
}

describe("member MCP servers", () => {
  it("adds, lists, edits and deletes, and keeps the file after the last delete", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Boss");
    const session = owner.rawSessionId;
    const ownerId = getUserByName(owner.username)!.id;
    const base = `/api/users/${owner.username}/mcp-servers`;
    await call(srv, "POST", `/api/users/${owner.username}/secrets`, {
      session,
      body: secret("LINEAR_TOKEN", ["mcp.example.com"]),
    });

    const created = await call(srv, "POST", base, {
      session,
      body: { name: "linear", url: URL_WITH_TOKEN, secret: "LINEAR_TOKEN" },
    });
    expect(created.status).toBe(201);
    const listed = await call(srv, "GET", base, { session });
    expect(
      (listed.body as { servers: Record<string, unknown>[] }).servers.map(
        ({ name, url, secret }) => ({ name, url, secret }),
      ),
    ).toEqual([
      { name: "linear", url: URL_WITH_TOKEN, secret: "LINEAR_TOKEN" },
    ]);
    const file = join(srv.stateRoot, "mcp-servers", "users", `${ownerId}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(srv.stateRoot, "mcp-servers")).mode & 0o777).toBe(
      0o700,
    );

    const edited = await call(srv, "PATCH", `${base}/linear`, {
      session,
      body: { secret: null },
    });
    expect(edited.status).toBe(200);
    expect((edited.body as { server: { secret: unknown } }).server.secret).toBe(
      null,
    );

    expect(
      (await call(srv, "DELETE", `${base}/linear`, { session })).status,
    ).toBe(204);
    expect(
      (await call(srv, "DELETE", `${base}/linear`, { session })).status,
    ).toBe(404);
    // The path is part of the member's OpenCode profile key.
    expect(existsSync(file)).toBe(true);
  });

  it("admits the owning cookie and API identity only, never an agent", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Boss");
    const other = await srv.seedMember("Other");
    const ownerId = getUserByName(owner.username)!.id;
    const otherId = getUserByName(other.username)!.id;
    const ownerApi = await mintApiToken({
      userId: ownerId,
      name: "Owner API",
      expiresInDays: null,
    });
    const otherApi = await mintApiToken({
      userId: otherId,
      name: "Other API",
      expiresInDays: null,
    });
    const plainAgent = mintAgentToken("plain-mcp-agent", ownerId, false);
    const privilegedAgent = mintAgentToken(
      "privileged-mcp-agent",
      ownerId,
      true,
    );
    const base = `/api/users/${owner.username}/mcp-servers`;
    const body = {
      name: "docs",
      url: "https://docs.example.com/mcp",
      secret: null,
    };

    expect(
      (await call(srv, "POST", base, { bearer: ownerApi.token, body })).status,
    ).toBe(201);
    expect({
      ownCookie: (await call(srv, "GET", base, { session: owner.rawSessionId }))
        .status,
      otherCookie: (
        await call(srv, "GET", base, { session: other.rawSessionId })
      ).status,
      otherApi: (await call(srv, "GET", base, { bearer: otherApi.token }))
        .status,
      plainAgent: (await call(srv, "GET", base, { bearer: plainAgent })).status,
      agentCreate: (
        await call(srv, "POST", base, {
          bearer: privilegedAgent,
          body: { ...body, name: "other" },
        })
      ).status,
      otherDelete: (
        await call(srv, "DELETE", `${base}/docs`, {
          session: other.rawSessionId,
        })
      ).status,
    }).toEqual({
      ownCookie: 200,
      otherCookie: 403,
      otherApi: 403,
      plainAgent: 403,
      agentCreate: 403,
      otherDelete: 403,
    });
  });

  it("refuses bad fields by field, binds the secret to the host, and never echoes the URL", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Boss");
    const session = owner.rawSessionId;
    const base = `/api/users/${owner.username}/mcp-servers`;
    await call(srv, "POST", `/api/users/${owner.username}/secrets`, {
      session,
      body: secret("OTHER_TOKEN", ["api.other.com"]),
    });
    const post = (body: unknown) => call(srv, "POST", base, { session, body });
    const cases: [unknown, number, string, string | undefined][] = [
      [
        { name: "Bad Name", url: URL_WITH_TOKEN, secret: null },
        400,
        "invalid_mcp_server",
        "name",
      ],
      [
        { name: "x".repeat(25), url: URL_WITH_TOKEN, secret: null },
        400,
        "invalid_mcp_server",
        "name",
      ],
      [
        {
          name: "ok",
          url: `ftp://mcp.example.com/${PATH_TOKEN}`,
          secret: null,
        },
        400,
        "invalid_mcp_server",
        "url",
      ],
      [
        {
          name: "ok",
          url: `https://user:${PATH_TOKEN}@mcp.example.com/`,
          secret: null,
        },
        400,
        "invalid_mcp_server",
        "url",
      ],
      [
        {
          name: "ok",
          url: `http://mcp.example.com/${PATH_TOKEN}`,
          secret: null,
        },
        400,
        "invalid_mcp_server",
        "url",
      ],
      [
        {
          name: "ok",
          url: `http://localhost:9/${PATH_TOKEN}`,
          secret: "OTHER_TOKEN",
        },
        400,
        "invalid_mcp_server",
        "url",
      ],
      [
        {
          name: "ok",
          url: `https://api.other.com:8443/${PATH_TOKEN}`,
          secret: "OTHER_TOKEN",
        },
        400,
        "invalid_mcp_server",
        "url",
      ],
      [
        { name: "ok", url: URL_WITH_TOKEN, secret: "MISSING" },
        422,
        "secret_not_found",
        undefined,
      ],
      [
        { name: "ok", url: URL_WITH_TOKEN, secret: "OTHER_TOKEN" },
        422,
        "secret_host_mismatch",
        undefined,
      ],
      [
        { name: "ok", url: URL_WITH_TOKEN, secret: null, extra: 1 },
        400,
        "invalid_request",
        undefined,
      ],
    ];
    for (const [body, status, code, field] of cases) {
      const res = await post(body);
      expect([res.status, errorOf(res).code, errorOf(res).field]).toEqual([
        status,
        code,
        field,
      ]);
      expect(res.text).not.toContain(PATH_TOKEN);
    }
    // http:// to this machine, with no credential, is a local server.
    expect(
      (
        await post({
          name: "local",
          url: "http://localhost:8123/mcp",
          secret: null,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post({
          name: "local",
          url: "http://127.0.0.1:8123/mcp",
          secret: null,
        })
      ).status,
    ).toBe(409);
  });
});

describe("office MCP servers", () => {
  // Members read the list as a summary (Nil, 2026-10-13); see
  // routes-integrations-owner.test.ts. Every change stays owner-only.
  it("are owner-only to change, as the office secrets are", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Member");
    const base = "/api/office/mcp-servers";
    const body = {
      name: "docs",
      url: "https://docs.example.com/mcp",
      secret: null,
    };
    expect(
      (await call(srv, "POST", base, { session: member.rawSessionId, body }))
        .status,
    ).toBe(403);
    const memberList = await call(srv, "GET", base, {
      session: member.rawSessionId,
    });
    expect([memberList.status, memberList.body]).toEqual([
      200,
      { servers: [] },
    ]);
    expect(
      (await call(srv, "POST", base, { session: owner.rawSessionId, body }))
        .status,
    ).toBe(201);
    expect(
      statSync(join(srv.stateRoot, "mcp-servers", "office.json")).mode & 0o777,
    ).toBe(0o600);
    expect(
      (
        await call(srv, "PATCH", `${base}/docs`, {
          session: member.rawSessionId,
          body: { secret: null },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(srv, "DELETE", `${base}/docs`, {
          session: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
  });

  it("an office server takes an office secret only, not a member's", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Boss");
    const session = owner.rawSessionId;
    await call(srv, "POST", `/api/users/${owner.username}/secrets`, {
      session,
      body: secret("MINE", ["mcp.example.com"]),
    });
    const res = await call(srv, "POST", "/api/office/mcp-servers", {
      session,
      body: { name: "linear", url: URL_WITH_TOKEN, secret: "MINE" },
    });
    expect([res.status, errorOf(res).code]).toEqual([422, "secret_not_found"]);
  });
});

describe("read paths", () => {
  it("keeps the URL out of the audit log, the integrations list and the console", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Member");
    const session = owner.rawSessionId;
    let listForOwner: Res | null = null;
    let listForMember: Res | null = null;
    let audit: Res | null = null;
    const printed = await consoleDuring(async () => {
      await call(srv, "POST", "/api/office/secrets", {
        session,
        body: secret("OFFICE_LINEAR", ["mcp.example.com"]),
      });
      await call(srv, "POST", "/api/office/mcp-servers", {
        session,
        body: { name: "linear", url: URL_WITH_TOKEN, secret: "OFFICE_LINEAR" },
      });
      await call(srv, "PATCH", "/api/office/mcp-servers/linear", {
        session,
        body: { url: URL_WITH_TOKEN },
      });
      await call(srv, "POST", `/api/users/${member.username}/mcp-servers`, {
        session: member.rawSessionId,
        body: {
          name: "linear",
          url: "https://docs.example.com/mcp",
          secret: null,
        },
      });
      listForOwner = await call(srv, "GET", "/api/me/connections", { session });
      listForMember = await call(srv, "GET", "/api/me/connections", {
        session: member.rawSessionId,
      });
      audit = await call(srv, "GET", "/api/audit-log", { session });
    });
    expect(printed).not.toContain(PATH_TOKEN);
    expect(audit!.status).toBe(200);
    expect(audit!.text).not.toContain(PATH_TOKEN);
    const rows = (
      audit!.body as { items: { operation: string; targets: string[] }[] }
    ).items;
    expect(rows.map((row) => row.operation)).toEqual(
      expect.arrayContaining([
        "officeMcpServers.create",
        "officeMcpServers.update",
        "mcpServers.create",
      ]),
    );
    expect(
      rows.find((row) => row.operation === "officeMcpServers.create")!.targets,
    ).toContain("linear");

    for (const res of [listForOwner!, listForMember!]) {
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(PATH_TOKEN);
    }
    expect(
      (listForOwner!.body as { mcpServers: unknown[] }).mcpServers,
    ).toEqual([
      {
        scope: "office",
        name: "linear",
        host: "mcp.example.com",
        credential: true,
        secret: "OFFICE_LINEAR",
        problem: null,
        overridden: false,
        note: null,
        oauth: false,
      },
    ]);
    // A member sees the office server, without the secret's name, and that
    // their own server of the same name replaces it for their agents.
    expect(
      (listForMember!.body as { mcpServers: unknown[] }).mcpServers,
    ).toEqual([
      {
        scope: "office",
        name: "linear",
        host: "mcp.example.com",
        credential: true,
        secret: null,
        problem: null,
        overridden: true,
        note: null,
        oauth: false,
      },
      {
        scope: "personal",
        name: "linear",
        host: "docs.example.com",
        credential: false,
        secret: null,
        problem: null,
        overridden: false,
        note: null,
        oauth: false,
      },
    ]);
  });

  it("shows why a server is left out when its secret goes", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Boss");
    const session = owner.rawSessionId;
    const secrets = `/api/users/${owner.username}/secrets`;
    await call(srv, "POST", secrets, {
      session,
      body: secret("LINEAR_TOKEN", ["mcp.example.com"]),
    });
    await call(srv, "POST", `/api/users/${owner.username}/mcp-servers`, {
      session,
      body: { name: "linear", url: URL_WITH_TOKEN, secret: "LINEAR_TOKEN" },
    });
    const problem = async () =>
      (
        (await call(srv, "GET", "/api/me/connections", { session })).body as {
          mcpServers: { problem: unknown }[];
        }
      ).mcpServers[0].problem;
    expect(await problem()).toBe(null);
    await call(srv, "PATCH", `${secrets}/LINEAR_TOKEN`, {
      session,
      body: { hosts: ["api.other.com"] },
    });
    expect(await problem()).toBe("secret_host");
    await call(srv, "DELETE", `${secrets}/LINEAR_TOKEN`, { session });
    expect(await problem()).toBe("secret_missing");
  });
});
