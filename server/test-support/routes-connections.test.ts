// The connections: GET /api/me/connections (the integrations list) and the
// Test button's routes.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import type { ConnectionsListRes } from "../../shared/contract-shapes.ts";

describe("connections list", () => {
  // GET /api/me/connections: the integrations list. Names only, never a value;
  // the office items for every member (Nil, ruling 2, 2026-10-13); the caller's
  // own personal entries only; no agent or API token.

  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function call(
    srv: TestServer,
    path: string,
    init: {
      method?: string;
      body?: unknown;
      session?: string;
      bearer?: string;
    },
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
    const owner = await srv.seedOwner("Morgan");
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
    await putEnv(
      srv,
      `/api/users/${member.username}/env`,
      member.rawSessionId,
      {
        MEMBER_TOKEN: MEMBER_VALUE,
      },
    );
    await putEnv(srv, `/api/users/${other.username}/env`, other.rawSessionId, {
      OTHER_TOKEN: "other-value",
    });
    return { srv, owner, member, other };
  }

  function list(text: string): ConnectionsListRes {
    return JSON.parse(text) as ConnectionsListRes;
  }

  describe("GET /api/me/connections", () => {
    it("gives an owner and a member the office names and their own, and no value", async () => {
      const { srv, owner, member } = await seeded();
      const ownerRes = await call(srv, "/api/me/connections", {
        session: owner.rawSessionId,
      });
      expect(ownerRes.status).toBe(200);
      expect(list(ownerRes.text).variables).toEqual([
        { scope: "office", name: "OFFICE_TOKEN", note: null },
        { scope: "personal", name: "OWNER_TOKEN", note: null },
      ]);
      expect(
        list(ownerRes.text).secrets?.map((s) => [s.scope, s.test]),
      ).toEqual([["office", "github"]]);

      const memberRes = await call(srv, "/api/me/connections", {
        session: member.rawSessionId,
      });
      expect(memberRes.status).toBe(200);
      expect(list(memberRes.text).variables).toEqual([
        { scope: "office", name: "OFFICE_TOKEN", note: null },
        { scope: "personal", name: "MEMBER_TOKEN", note: null },
      ]);
      // Only an owner may test an office secret.
      expect(list(memberRes.text).secrets).toEqual([
        {
          scope: "office",
          name: "GH_TOKEN",
          hosts: ["api.github.com"],
          test: null,
          note: null,
        },
      ]);
      expect(memberRes.text).not.toContain("OTHER_TOKEN");
      for (const text of [ownerRes.text, memberRes.text])
        for (const value of [
          OFFICE_VALUE,
          OFFICE_SECRET_VALUE,
          OWNER_VALUE,
          MEMBER_VALUE,
        ])
          expect(text).not.toContain(value);
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
});

describe("connection tests", () => {
  // The Test button's routes (integrations A3): the gates match the routes that
  // edit the same connection, the answer's shape, and that the fake value never
  // reaches a response, the audit log or the console.

  const VALUE = "fake-a3-route-secret-0001";
  const PATH_TOKEN = "fake-a3-route-path-0002";

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

  // A GitHub identity endpoint and an MCP server, as one fake fetch. Both
  // answers repeat the credential, as a careless service might.
  const calls: { url: string; authorization: string | null }[] = [];
  const stubFetch = async (
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({ url, authorization: headers.get("authorization") });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "mcp-session-id": "s" },
      });
    if (headers.get("authorization") !== `Bearer ${VALUE}`)
      return json({ message: `bad: ${headers.get("authorization")}` }, 401);
    if (url === "https://api.github.com/user")
      return json({ login: "octocat" });
    if (init.method === "DELETE") return new Response(null, { status: 200 });
    const message = JSON.parse(
      typeof init.body === "string" ? init.body : "{}",
    ) as {
      id?: number;
      method: string;
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result:
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "stub-server", version: "1" },
            }
          : { tools: [{ name: "a" }, { name: "b" }] },
    });
  };

  async function start(): Promise<TestServer> {
    calls.length = 0;
    server = await startTestServer({
      startServer: { connectionTestFetch: stubFetch },
    });
    return server;
  }

  const secret = (name: string, hosts: string[], value = VALUE) => ({
    name,
    value,
    hosts,
    form: { kind: "authorization" },
  });

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

  describe("connection test routes", () => {
    it("test a member's secret and MCP server, with the account and the tool count", async () => {
      const srv = await start();
      const owner = await srv.seedOwner("Morgan");
      const session = owner.rawSessionId;
      const base = `/api/users/${owner.username}`;
      await call(srv, "POST", `${base}/secrets`, {
        session,
        body: secret("GH_TOKEN", ["api.github.com", "github.com"]),
      });
      await call(srv, "POST", `${base}/secrets`, {
        session,
        body: secret("LINEAR_TOKEN", ["mcp.example.com"]),
      });
      await call(srv, "POST", `${base}/secrets`, {
        session,
        body: secret("CUSTOM", ["api.example.com"]),
      });
      await call(srv, "POST", `${base}/mcp-servers`, {
        session,
        body: {
          name: "linear",
          url: `https://mcp.example.com/${PATH_TOKEN}/mcp`,
          secret: "LINEAR_TOKEN",
        },
      });

      const gh = await call(srv, "POST", `${base}/secrets/GH_TOKEN/test`, {
        session,
      });
      expect(gh.status).toBe(200);
      expect(gh.body).toEqual({
        result: {
          ok: true,
          kind: "secret",
          host: "api.github.com",
          account: "octocat",
        },
      });
      const mcp = await call(srv, "POST", `${base}/mcp-servers/linear/test`, {
        session,
      });
      expect(mcp.body).toEqual({
        result: {
          ok: true,
          kind: "mcp",
          host: "mcp.example.com",
          server: "stub-server",
          tools: 2,
        },
      });
      const custom = await call(srv, "POST", `${base}/secrets/CUSTOM/test`, {
        session,
      });
      expect(custom.body).toEqual({
        result: { ok: false, host: null, reason: "not_testable" },
      });
      expect(
        (await call(srv, "POST", `${base}/secrets/NOPE/test`, { session }))
          .status,
      ).toBe(404);
      expect(
        (await call(srv, "POST", `${base}/mcp-servers/nope/test`, { session }))
          .status,
      ).toBe(404);
      // The custom secret made no call; the others called their own hosts.
      expect(calls.map((entry) => new URL(entry.url).hostname)).toEqual([
        "api.github.com",
        "mcp.example.com",
        "mcp.example.com",
        "mcp.example.com",
        "mcp.example.com",
      ]);
    });

    it("gate like the routes that edit the same connection", async () => {
      const srv = await start();
      const owner = await srv.seedOwner("Morgan");
      const member = await srv.seedMember("Member");
      const ownerId = getUserByName(owner.username)!.id;
      const memberId = getUserByName(member.username)!.id;
      const ownerApi = await mintApiToken({
        userId: ownerId,
        name: "Owner API",
        expiresInDays: null,
      });
      const memberApi = await mintApiToken({
        userId: memberId,
        name: "Member API",
        expiresInDays: null,
      });
      // An owner's privileged agent tests with its owner's reach; an
      // ordinary agent never does (Nil, 2026-10-14).
      const privilegedAgent = mintAgentToken("privileged-a3", ownerId, true);
      const ordinaryAgent = mintAgentToken("ordinary-a3", ownerId, false);
      await call(srv, "POST", `/api/users/${owner.username}/secrets`, {
        session: owner.rawSessionId,
        body: secret("GH_TOKEN", ["api.github.com"]),
      });
      await call(srv, "POST", "/api/office/secrets", {
        session: owner.rawSessionId,
        body: secret("GH_TOKEN", ["api.github.com"]),
      });
      await call(srv, "POST", "/api/office/mcp-servers", {
        session: owner.rawSessionId,
        body: {
          name: "docs",
          url: "https://docs.example.com/mcp",
          secret: null,
        },
      });
      const own = `/api/users/${owner.username}/secrets/GH_TOKEN/test`;
      const officeSecret = "/api/office/secrets/GH_TOKEN/test";
      const officeMcp = "/api/office/mcp-servers/docs/test";
      const status = async (
        path: string,
        who: { session?: string; bearer?: string },
      ) => (await call(srv, "POST", path, who)).status;

      expect({
        ownCookie: await status(own, { session: owner.rawSessionId }),
        ownApi: await status(own, { bearer: ownerApi.token }),
        otherCookie: await status(own, { session: member.rawSessionId }),
        otherApi: await status(own, { bearer: memberApi.token }),
        agent: await status(own, { bearer: privilegedAgent }),
        ordinaryAgent: await status(own, { bearer: ordinaryAgent }),
        officeSecretOwner: await status(officeSecret, {
          session: owner.rawSessionId,
        }),
        officeSecretMember: await status(officeSecret, {
          session: member.rawSessionId,
        }),
        officeSecretAgent: await status(officeSecret, {
          bearer: privilegedAgent,
        }),
        officeSecretOrdinaryAgent: await status(officeSecret, {
          bearer: ordinaryAgent,
        }),
        officeMcpOwner: await status(officeMcp, {
          session: owner.rawSessionId,
        }),
        officeMcpMember: await status(officeMcp, {
          session: member.rawSessionId,
        }),
        officeMcpMemberApi: await status(officeMcp, {
          bearer: memberApi.token,
        }),
      }).toEqual({
        ownCookie: 200,
        ownApi: 200,
        otherCookie: 403,
        otherApi: 403,
        agent: 200,
        ordinaryAgent: 403,
        officeSecretOwner: 200,
        officeSecretMember: 403,
        officeSecretAgent: 200,
        officeSecretOrdinaryAgent: 403,
        officeMcpOwner: 200,
        officeMcpMember: 403,
        officeMcpMemberApi: 403,
      });
    });

    it("keep the value and the URL path out of answers, the audit log and the console", async () => {
      const srv = await start();
      const owner = await srv.seedOwner("Morgan");
      const session = owner.rawSessionId;
      const answers: Res[] = [];
      let audit: Res | null = null;
      let list: Res | null = null;
      const printed = await consoleDuring(async () => {
        await call(srv, "POST", "/api/office/secrets", {
          session,
          body: secret("GH_TOKEN", ["api.github.com"]),
        });
        // A wrong value: the stub's 401 body repeats the header it got.
        await call(srv, "POST", "/api/office/secrets", {
          session,
          body: secret("MCP_TOKEN", ["mcp.example.com"], `${VALUE}-wrong`),
        });
        await call(srv, "POST", "/api/office/mcp-servers", {
          session,
          body: {
            name: "linear",
            url: `https://mcp.example.com/${PATH_TOKEN}/mcp`,
            secret: "MCP_TOKEN",
          },
        });
        answers.push(
          await call(srv, "POST", "/api/office/secrets/GH_TOKEN/test", {
            session,
          }),
          await call(srv, "POST", "/api/office/mcp-servers/linear/test", {
            session,
          }),
        );
        list = await call(srv, "GET", "/api/me/connections", { session });
        audit = await call(srv, "GET", "/api/audit-log", { session });
      });
      expect(answers[1].body).toEqual({
        result: { ok: false, host: "mcp.example.com", reason: "refused" },
      });
      for (const text of [
        printed,
        audit!.text,
        list!.text,
        ...answers.map((answer) => answer.text),
      ]) {
        expect(text).not.toContain(VALUE);
        expect(text).not.toContain(PATH_TOKEN);
      }
      const rows = (
        audit!.body as { items: { operation: string; targets: string[] }[] }
      ).items;
      expect(rows.map((row) => row.operation)).toEqual(
        expect.arrayContaining(["officeSecrets.test", "officeMcpServers.test"]),
      );
    });
  });
});
