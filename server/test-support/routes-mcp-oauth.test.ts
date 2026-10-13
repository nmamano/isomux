// The OAuth MCP routes (integrations A2b) through the whole office stack:
// register, sign in, the callback with the member's cookie, the audit row,
// the connections list and the Test button with the access token. The
// authorization server and the MCP server are stubs behind the fetch seam.

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { mintAgentToken } from "../identity/tokens.ts";
import { resetOAuthTokens } from "../mcp-oauth-tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { LEAK, MCP_URL, stubRig } from "./mcp-oauth-stub.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  resetOAuthTokens();
});

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: { body?: unknown; session?: string; bearer?: string } = {},
): Promise<{ status: number; body: unknown; text: string }> {
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
    // HTML or no body.
  }
  return { status: response.status, body, text };
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

describe("OAuth MCP server routes", () => {
  it("sign a member in once and give the Test button the access token, with nothing leaked", async () => {
    const rig = stubRig();
    const srv = await startTestServer({
      startServer: { connectionTestFetch: rig.fetch },
    });
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Ann");
    const session = member.rawSessionId;
    const base = `/api/users/${member.username}/mcp-servers`;
    const texts: string[] = [];
    const logs = await consoleDuring(async () => {
      const created = await call(srv, "POST", base, {
        session,
        body: { name: "mail", url: MCP_URL, secret: null, oauth: {} },
      });
      expect(created.status).toBe(201);
      texts.push(created.text);

      const started = await call(srv, "POST", `${base}/mail/sign-in`, {
        session,
      });
      expect(started.status).toBe(200);
      texts.push(started.text);
      const authorizationUrl = (started.body as { authorizationUrl: string })
        .authorizationUrl;
      const redirect = new URL(authorizationUrl).searchParams.get(
        "redirect_uri",
      )!;
      expect(new URL(redirect).pathname).toBe("/api/mcp-oauth/callback");
      const { code, state } = rig.authorize(authorizationUrl);

      // Another member's browser cannot spend the code.
      const other = await call(
        srv,
        "GET",
        `/api/mcp-oauth/callback?code=${code}&state=${state}`,
        { session: owner.rawSessionId },
      );
      expect(other.text).toContain("mcpSignIn=wrong_member");
      expect(rig.tokenBodies).toEqual([]);

      const back = await call(
        srv,
        "GET",
        `/api/mcp-oauth/callback?code=${code}&state=${state}`,
        { session },
      );
      expect(back.status).toBe(200);
      expect(back.text).toContain("mcpSignIn=ok");
      texts.push(back.text);

      const list = await call(srv, "GET", "/api/me/connections", { session });
      texts.push(list.text);
      const row = (
        list.body as {
          mcpServers: { name: string; oauth?: boolean; problem: unknown }[];
        }
      ).mcpServers.find((r) => r.name === "mail");
      expect(row).toMatchObject({ oauth: true, problem: null });

      const tested = await call(srv, "POST", `${base}/mail/test`, { session });
      texts.push(tested.text);
      expect(tested.body).toMatchObject({
        result: { ok: true, server: "stub-mail", tools: 1 },
      });

      const servers = await call(srv, "GET", base, { session });
      texts.push(servers.text);
      expect(servers.body).toMatchObject({
        servers: [{ name: "mail", oauth: { signedIn: true } }],
      });

      const audit = await call(srv, "GET", "/api/audit-log", {
        session: owner.rawSessionId,
      });
      texts.push(audit.text);
      const items = (
        audit.body as { items: { operation: string; targets: string[] }[] }
      ).items;
      expect(
        items
          .filter(
            (i) =>
              i.operation.startsWith("mcp") ||
              i.operation.includes("McpServers"),
          )
          .map((i) => [i.operation, i.targets]),
      ).toEqual(
        expect.arrayContaining([
          ["mcpServers.signIn", expect.arrayContaining(["mail"])],
          ["mcpOAuth.callback", ["mail"]],
        ]),
      );
    });
    for (const text of texts) expect(text).not.toContain(LEAK);
    expect(logs).not.toContain(LEAK);
  });

  it("refuse the sign-in to an agent and another member", async () => {
    const rig = stubRig();
    const srv = await startTestServer({
      startServer: { connectionTestFetch: rig.fetch },
    });
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Ann");
    const agent = mintAgentToken(
      "privileged-a2b",
      getUserByName(owner.username)!.id,
      true,
    );
    await call(srv, "POST", "/api/office/mcp-servers", {
      session: owner.rawSessionId,
      body: { name: "mail", url: MCP_URL, secret: null, oauth: {} },
    });
    const path = "/api/office/mcp-servers/mail/sign-in";
    expect((await call(srv, "POST", path, { bearer: agent })).status).toBe(403);
    expect(
      (await call(srv, "POST", path, { session: member.rawSessionId })).status,
    ).toBe(403);
    expect(
      (await call(srv, "POST", path, { session: owner.rawSessionId })).status,
    ).toBe(200);
    expect(
      (
        await call(srv, "GET", "/api/mcp-oauth/callback?code=x&state=y", {
          bearer: agent,
        })
      ).status,
    ).toBe(403);
  });
});
