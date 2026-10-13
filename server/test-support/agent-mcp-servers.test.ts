// The agent manager gives each session its member's remote MCP servers
// (integrations A2), and keeps their credentials out of the session's
// environment. The integrations list shows the servers set in Claude itself
// from what the member's sessions report: name and source only.

import { afterAll, afterEach, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { STATE_ROOT } from "../config.ts";
import {
  createMcpServerSources,
  setMcpPlaceholderProvider,
} from "../mcp-servers.ts";
import { resetClaudeEngineServersForTests } from "../claude-connectors.ts";
import { getUserByName } from "../users.ts";
import { FakeBackend } from "./fake-backend.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const OFFICE_VALUE = "fake-office-agent-mcp-0000";
const MEMBER_VALUE = "fake-member-agent-mcp-0000";

let server: TestServer | null = null;
// The harness starts no secret proxy. This stands in for the secrets runtime
// (secrets B2): a placeholder per scope and name.
const restorePlaceholders = setMcpPlaceholderProvider(
  (scope, name) =>
    `placeholder-${scope.kind === "office" ? "office" : "member"}-${name}`,
);
afterAll(() => setMcpPlaceholderProvider(restorePlaceholders));
afterEach(async () => {
  await server?.stop();
  server = null;
  resetClaudeEngineServersForTests();
  rmSync(join(STATE_ROOT, "secrets"), { recursive: true, force: true });
  rmSync(join(STATE_ROOT, "mcp-servers"), { recursive: true, force: true });
});

// A spawn is lazy: the first message starts the session. The turn itself is
// never completed here.
async function sessionAfterMessage(
  srv: TestServer,
  fake: FakeBackend,
  agentId: string,
  username: string,
) {
  void srv.agentManager.sendMessage(agentId, "hello", username);
  const deadline = Date.now() + 2_000;
  while (!fake.sessionForAgent(agentId) && Date.now() < deadline)
    await Bun.sleep(5);
  return fake.sessionForAgent(agentId)!;
}

async function spawnFor(srv: TestServer, name: string, username: string) {
  const info = await srv.agentManager.spawn(
    name,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    "fake",
    "high",
    username,
    "claude",
    undefined,
    getUserByName(username)!.id,
  );
  return info!;
}

it("gives each member's sessions the office servers and their own, never in the environment", async () => {
  const fake = new FakeBackend();
  server = await startTestServer({ fakeBackend: fake });
  const srv = server;
  await srv.seedOwner("Boss");
  await srv.seedMember("Ann");
  const annId = getUserByName("Ann")!.id;
  const sources = createMcpServerSources();
  sources.secrets.create(
    { kind: "office" },
    {
      name: "OFFICE_TOKEN",
      value: OFFICE_VALUE,
      hosts: ["office.example.com"],
      form: { kind: "authorization" },
    },
  );
  sources.secrets.create(
    { kind: "user", userId: annId },
    {
      name: "ANN_TOKEN",
      value: MEMBER_VALUE,
      hosts: ["ann.example.com"],
      form: { kind: "authorization" },
    },
  );
  sources.servers.create(
    { kind: "office" },
    {
      name: "office",
      url: "https://office.example.com/mcp",
      secret: "OFFICE_TOKEN",
    },
  );
  sources.servers.create(
    { kind: "user", userId: annId },
    { name: "ann", url: "https://ann.example.com/mcp", secret: "ANN_TOKEN" },
  );

  const ann = await spawnFor(srv, "AnnAgent", "Ann");
  const boss = await spawnFor(srv, "BossAgent", "Boss");
  const annSession = await sessionAfterMessage(srv, fake, ann.id, "Ann");
  const bossSession = await sessionAfterMessage(srv, fake, boss.id, "Boss");

  expect(annSession.opts.mcpServers).toEqual([
    {
      name: "isomux-office",
      url: "https://office.example.com/mcp",
      headers: { Authorization: "Bearer placeholder-office-OFFICE_TOKEN" },
    },
    {
      name: "isomux-ann",
      url: "https://ann.example.com/mcp",
      headers: { Authorization: "Bearer placeholder-member-ANN_TOKEN" },
    },
  ]);
  expect(bossSession.opts.mcpServers?.map((s) => s.name)).toEqual([
    "isomux-office",
  ]);
  for (const session of [annSession, bossSession]) {
    // Neither the environment nor the MCP headers hold a value (B2).
    expect(JSON.stringify(session.opts.mcpServers)).not.toContain(OFFICE_VALUE);
    expect(JSON.stringify(session.opts.mcpServers)).not.toContain(MEMBER_VALUE);
    const env = JSON.stringify(session.opts.env ?? {});
    expect(env).not.toContain(OFFICE_VALUE);
    expect(env).not.toContain(MEMBER_VALUE);
  }
});

it("lists the servers set in Claude from the member's own sessions, by name and source only", async () => {
  const fake = new FakeBackend();
  server = await startTestServer({ fakeBackend: fake });
  const srv = server;
  const ann = await srv.seedMember("Ann");
  const boss = await srv.seedOwner("Boss");
  const agent = await spawnFor(srv, "AnnAgent", "Ann");
  const session = await sessionAfterMessage(srv, fake, agent.id, "Ann");
  // A report with no claude.ai connector still records the engine's own
  // servers, and only the name and source of each reach the list.
  session.push({
    kind: "system_init",
    sessionId: "s-1",
    mcpServers: [
      {
        name: "notes",
        status: "connected",
        source: "user",
        url: "https://notes.example.com/secret-path",
        headers: { Authorization: "Bearer fake-engine-header" },
      } as never,
      { name: "repo-tools", status: "pending", source: "project" },
      { name: "isomux-office", status: "connected", source: "dynamic" },
    ],
  });
  await Bun.sleep(20);

  const list = async (rawSessionId: string) => {
    const response = await srv.http("/api/me/connections", { rawSessionId });
    const text = await response.text();
    return { text, body: JSON.parse(text) as { engineMcpServers: unknown[] } };
  };
  const forAnn = await list(ann.rawSessionId);
  // An init report is not a status read: the status stays null (A3).
  expect(forAnn.body.engineMcpServers).toEqual([
    {
      engine: "claude",
      name: "notes",
      source: "user",
      folder: null,
      status: null,
    },
    {
      engine: "claude",
      name: "repo-tools",
      source: "project",
      folder: STATE_ROOT,
      status: null,
    },
  ]);
  expect(forAnn.text).not.toContain("secret-path");
  expect(forAnn.text).not.toContain("fake-engine-header");
  // Another member's sessions are not theirs.
  expect((await list(boss.rawSessionId)).body.engineMcpServers).toEqual([]);
});
