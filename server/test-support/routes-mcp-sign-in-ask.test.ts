// The MCP sign-in routes take the id of the ask the sign-in starts from
// (task e3d1bc63, part 6): {askId} in the body, an ask id's shape or a 400.
// The id is used for the way back only; with none the way back is
// /integrations as before. Which landing gets the id is in
// server/mcp-oauth.ask-return.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { resetOAuthTokens } from "../mcp-oauth-tokens.ts";
import { MCP_URL, stubRig } from "./mcp-oauth-stub.ts";

const ASK = "0a1b2c3d4e5f";

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
  session: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await srv.http(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    rawSessionId: session,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The callback's HTML.
  }
  return { status: response.status, body: parsed, text };
}

describe("the ask's id on an MCP sign-in", () => {
  it("refuses an id of another shape, starts with one or none, and goes back to the ask", async () => {
    const rig = stubRig();
    const srv = await startTestServer({
      startServer: { connectionTestFetch: rig.fetch },
    });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const session = owner.rawSessionId;
    for (const base of [
      "/api/office/mcp-servers",
      `/api/users/${owner.username}/mcp-servers`,
    ])
      expect(
        (
          await call(srv, "POST", base, session, {
            name: "mail",
            url: MCP_URL,
            secret: null,
            oauth: {},
          })
        ).status,
      ).toBe(201);

    const signIns = [
      "/api/office/mcp-servers/mail/sign-in",
      `/api/users/${owner.username}/mcp-servers/mail/sign-in`,
    ];
    for (const path of signIns)
      for (const askId of [
        "ABCDEF12",
        `${ASK}'"><b`,
        "0a1b2c3",
        `../${ASK}`,
        "",
        7,
        null,
      ]) {
        const refused = await call(srv, "POST", path, session, { askId });
        expect([path, askId, refused.status]).toEqual([path, askId, 400]);
      }

    // No body and an empty one start as before, and go back to Integrations.
    for (const body of [undefined, {}]) {
      const started = await call(srv, "POST", signIns[1], session, body);
      expect(started.status).toBe(200);
      const { code, state } = rig.authorize(
        (started.body as { authorizationUrl: string }).authorizationUrl,
      );
      const back = await call(
        srv,
        "GET",
        `/api/mcp-oauth/callback?code=${code}&state=${state}`,
        session,
      );
      expect(back.text).toContain('url=/integrations?mcpSignIn=ok"');
    }

    for (const path of signIns) {
      const started = await call(srv, "POST", path, session, { askId: ASK });
      expect(started.status).toBe(200);
      const { code, state } = rig.authorize(
        (started.body as { authorizationUrl: string }).authorizationUrl,
      );
      const back = await call(
        srv,
        "GET",
        `/api/mcp-oauth/callback?code=${code}&state=${state}`,
        session,
      );
      expect(back.status).toBe(200);
      expect(back.text).toContain(`url=/inbox/asks/${ASK}?mcpSignIn=ok"`);
      expect(back.text).not.toContain("/integrations");
    }
  });
});
