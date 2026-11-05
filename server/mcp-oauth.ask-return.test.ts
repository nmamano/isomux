// The way back from an MCP sign-in started in an ask card (task e3d1bc63,
// part 6): the flow keeps the ask's id, and the callback sends the browser to
// /inbox/asks/<askId>?mcpSignIn=<code> once the flow is known and the member
// is the one who started it. Every other landing is /integrations as before.
// The route's shape check of the id is in
// server/test-support/routes-mcp-sign-in-ask.test.ts.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createMcpServerSources } from "./mcp-servers.ts";
import { createMcpOAuth } from "./mcp-oauth.ts";
import { resetOAuthTokens } from "./mcp-oauth-tokens.ts";
import { mcpServersHandlers } from "./routes/handlers/mcp-servers.ts";
import type { RouteHandlerContext } from "./routes/executor.ts";
import { MCP_URL, stubRig } from "./test-support/mcp-oauth-stub.ts";

const REDIRECT = "https://office.example.test/api/mcp-oauth/callback";
const member = { kind: "user", userId: "u1" } as const;
const office = { kind: "office" } as const;
const ASK = "0a1b2c3d";

let root: string;
let clock: number;
let spies: ReturnType<typeof spyOn>[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-oauth-ask-"));
  clock = Date.now();
  resetOAuthTokens();
  spies = (["log", "warn", "error"] as const).map((level) =>
    spyOn(console, level).mockImplementation(() => {}),
  );
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const rig = stubRig();
  const sources = createMcpServerSources(root);
  const oauth = createMcpOAuth({
    servers: sources.servers,
    secrets: sources.secrets,
    fetch: rig.fetch,
    redirectUri: () => REDIRECT,
    now: () => clock,
  });
  for (const scope of [member, office])
    expect(
      oauth.create(scope, {
        name: "mail",
        url: MCP_URL,
        secret: null,
        oauth: {},
      }).ok,
    ).toBe(true);
  return { rig, sources, oauth };
}
type Context = ReturnType<typeof setup>;

// A flow started for the member's server by `userId`, with the ask's id when
// one is given; its state and code as the browser brings them back.
async function start(
  context: Context,
  userId: string,
  askId?: string,
  scope: typeof member | typeof office = member,
) {
  const started = await context.oauth.startSignIn(scope, "mail", userId, askId);
  if (!started.ok) throw new Error(started.reason);
  return context.rig.authorize(started.authorizationUrl);
}

// The page the callback answers `userId`'s browser with.
async function landing(
  context: Context,
  userId: string,
  query: Record<string, string>,
  owners: string[] = [],
): Promise<string> {
  const handlers = mcpServersHandlers({
    store: context.sources.servers,
    oauth: context.oauth,
    auditSignIn: () => {},
    isOfficeOwnerUserId: (id) => owners.includes(id),
    userIdForUsername: () => null,
    usernameForUserId: (id) => ({ u1: "alice", u2: "morgan" })[id] ?? null,
  });
  const result = await handlers["mcpOAuth.callback"]({
    identity: { scope: "user", userId },
    params: {},
    body: undefined,
    rawBody: "",
    query: new URLSearchParams(query),
    req: new Request("https://office.example.test/api/mcp-oauth/callback"),
  } as unknown as RouteHandlerContext);
  if (result.kind !== "bytes") throw new Error(result.kind);
  return new TextDecoder().decode(result.body);
}

// The address the landing page sends the browser to: the meta refresh and
// the link must agree.
function target(page: string): string {
  const refresh = /content="0;url=([^"]*)"/.exec(page)?.[1];
  const link = /<a href="([^"]*)"/.exec(page)?.[1];
  expect(refresh).toBeDefined();
  expect(link).toBe(refresh!);
  return refresh!;
}

describe("the way back to the ask", () => {
  it("sends a sign-in started from an ask back to that ask, ok or failed", async () => {
    const context = setup();
    const ok = await start(context, "u1", ASK);
    expect(target(await landing(context, "u1", ok))).toBe(
      `/inbox/asks/${ASK}?mcpSignIn=ok`,
    );
    // The member cancelled at the authorization server: no code.
    const denied = await start(context, "u1", ASK);
    expect(target(await landing(context, "u1", { state: denied.state }))).toBe(
      `/inbox/asks/${ASK}?mcpSignIn=denied`,
    );
  });

  it("keeps the ask's id with its flow: a later start without one goes back to Integrations", async () => {
    const context = setup();
    await start(context, "u1", ASK);
    // The newer start for the same server replaces the flow.
    const plain = await start(context, "u1");
    expect(target(await landing(context, "u1", plain))).toBe(
      "/integrations?mcpSignIn=ok",
    );
  });

  it("never takes an ask's id from the callback's address", async () => {
    const context = setup();
    const plain = await start(context, "u1");
    expect(target(await landing(context, "u1", { ...plain, askId: ASK }))).toBe(
      "/integrations?mcpSignIn=ok",
    );
    expect(
      target(
        await landing(context, "u1", {
          code: plain.code,
          state: "unknown",
          askId: ASK,
        }),
      ),
    ).toBe("/integrations?mcpSignIn=state_unknown");
  });

  it("gives the ask's id to the member who started the flow only", async () => {
    const context = setup();
    const flow = await start(context, "u1", ASK);
    // Another member's browser: refused, and not told which ask.
    const other = await landing(context, "u2", flow);
    expect(target(other)).toBe("/integrations?mcpSignIn=wrong_member");
    expect(other).not.toContain(ASK);
    // The flow is still the starter's, and still goes back to the ask.
    expect(target(await landing(context, "u1", flow))).toBe(
      `/inbox/asks/${ASK}?mcpSignIn=ok`,
    );
  });

  it("sends an office flow back to Integrations once its starter is no longer an owner", async () => {
    const context = setup();
    const flow = await start(context, "u1", ASK, office);
    const page = await landing(context, "u1", flow);
    expect(target(page)).toBe("/integrations?mcpSignIn=wrong_member");
    expect(page).not.toContain(ASK);
  });

  it("names the ask on an expired flow to its starter, never to another member", async () => {
    const context = setup();
    const first = await start(context, "u1", ASK);
    clock += 11 * 60_000;
    const other = await landing(context, "u2", first);
    expect(target(other).startsWith("/integrations?mcpSignIn=")).toBe(true);
    expect(other).not.toContain(ASK);

    const second = await start(context, "u1", ASK);
    clock += 11 * 60_000;
    expect(target(await landing(context, "u1", second))).toBe(
      `/inbox/asks/${ASK}?mcpSignIn=state_expired`,
    );
  });
});
