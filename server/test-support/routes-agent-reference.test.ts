import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  getAgentTokenRaw,
  mintAgentToken,
  mintRunToken,
} from "../identity/tokens.ts";
import {
  AGENT_REFERENCE_TOPICS,
  PRIVILEGED_REFERENCE_TOPICS,
  type AgentReferenceTopic,
  AGENT_REFERENCE_VERSION,
} from "../agent-reference.ts";
import { getUserByName } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import { appTokens } from "../app-tokens.ts";
import { readFileSync } from "fs";
import { join } from "path";
import {
  AGENT_REFERENCE_USAGE_LOG,
  agentReferenceUsageEvent,
} from "../agent-reference-telemetry.ts";
import {
  PRIVILEGED_AGENT_CAPABILITIES,
  type Identity,
} from "../identity/index.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function setup() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const ownerUser = getUserByName(owner.username);
  if (!ownerUser) throw new Error("owner missing");
  const room = srv.agentManager.getRooms()[0].id;
  const agent = await srv.agentManager.spawn(
    "Reader",
    srv.stateRoot,
    "default",
    0,
    undefined,
    room,
    undefined,
    undefined,
    undefined,
    owner.username,
    "claude",
    undefined,
    ownerUser.id,
  );
  if (!agent) throw new Error("spawn failed");
  const token = getAgentTokenRaw(agent.id);
  if (!token) throw new Error("token missing");
  return { srv, owner, ownerUser, agent, token };
}

describe("agent reference routes", () => {
  it("returns Markdown and refuses unknown or traversal-shaped topics", async () => {
    const { srv, token } = await setup();
    const headers = { Authorization: `Bearer ${token}` };
    const found = await fetch(`${srv.baseUrl}/api/agent-reference/tasks`, {
      headers,
    });
    expect(found.status).toBe(200);
    const body = (await found.json()) as {
      version: string;
      topic: string;
      markdown: string;
    };
    expect(body.version).toBe(AGENT_REFERENCE_VERSION);
    expect(body.topic).toBe("tasks");
    expect(body.markdown).toBe(
      readFileSync(
        join(import.meta.dir, "../agent-reference/tasks.md"),
        "utf8",
      ),
    );

    expect(
      (await fetch(`${srv.baseUrl}/api/agent-reference/nope`, { headers }))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(`${srv.baseUrl}/api/agent-reference/%2e%2e%2fusers`, {
          headers,
        })
      ).status,
    ).toBe(404);
  });

  it("pins all six identity classes and privileged page visibility", async () => {
    const { srv, owner, ownerUser, token } = await setup();
    const api = await mintApiToken({
      userId: ownerUser.id,
      name: "Reference API",
      expiresInDays: null,
    });
    const privileged = mintAgentToken(
      "privileged-reference",
      ownerUser.id,
      true,
    );
    const run = mintRunToken("job-1", "run-1", ownerUser.id);
    const registered = await fetch(`${srv.baseUrl}/api/apps`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "reference-app",
        command: "bun run start",
        cwd: srv.stateRoot,
      }),
    });
    expect(registered.status).toBe(201);
    const app = appTokens.mint("reference-app", ownerUser.id);
    const calls = [
      { name: "user", init: { rawSessionId: owner.rawSessionId }, status: 200 },
      {
        name: "api",
        init: { headers: { Authorization: `Bearer ${api.token}` } },
        status: 200,
      },
      {
        name: "agent",
        init: { headers: { Authorization: `Bearer ${token}` } },
        status: 200,
      },
      {
        name: "privileged",
        init: { headers: { Authorization: `Bearer ${privileged}` } },
        status: 200,
      },
      {
        name: "cron-run",
        init: { headers: { Authorization: `Bearer ${run}` } },
        status: 403,
      },
      {
        name: "app",
        init: { headers: { Authorization: `Bearer ${app}` } },
        status: 403,
      },
    ] as const;
    for (const call of calls) {
      const list = await srv.http("/api/agent-reference", call.init);
      expect(list.status, `${call.name} list`).toBe(call.status);
      const topic = await srv.http("/api/agent-reference/tasks", call.init);
      expect(topic.status, `${call.name} topic`).toBe(call.status);
      if (call.status === 200) {
        const body = (await list.json()) as {
          version: string;
          topics: { topic: string }[];
        };
        // One content version for every caller.
        expect(body.version, `${call.name} version`).toBe(
          AGENT_REFERENCE_VERSION,
        );
        expect(
          body.topics.map((entry) => entry.topic).sort(),
          `${call.name} topics`,
        ).toEqual(
          Object.keys(AGENT_REFERENCE_TOPICS)
            .filter(
              (topic) =>
                call.name === "privileged" ||
                !PRIVILEGED_REFERENCE_TOPICS.has(topic as AgentReferenceTopic),
            )
            .sort(),
        );
      }
    }
  });

  it("records a successful reference fetch before its feature call", async () => {
    const { srv, agent, token } = await setup();
    const headers = { Authorization: `Bearer ${token}` };
    expect(
      (await fetch(`${srv.baseUrl}/api/agent-reference/tasks`, { headers }))
        .status,
    ).toBe(200);
    expect((await fetch(`${srv.baseUrl}/api/tasks`, { headers })).status).toBe(
      200,
    );
    const events = readFileSync(AGENT_REFERENCE_USAGE_LOG, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.agentId === agent.id);
    expect(events.map((event) => event.kind)).toEqual([
      "reference_fetch",
      "feature_call",
    ]);
    expect(events[0]).toMatchObject({ topic: "tasks", sessionId: null });
    expect(events[1]).toMatchObject({ category: "tasks", opId: "tasks.list" });
  });

  // The scheduled-messages topic teaches a send with deliverAt. Logging that
  // call as plain messaging would record a compliant agent as one that
  // skipped its reference.
  it("records a scheduled send under the scheduled-messages topic it follows", async () => {
    const { srv, agent, token } = await setup();
    const headers = { Authorization: `Bearer ${token}` };
    expect(
      (
        await fetch(`${srv.baseUrl}/api/agent-reference/scheduled-messages`, {
          headers,
        })
      ).status,
    ).toBe(200);
    const sent = await fetch(`${srv.baseUrl}/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "wake up",
        deliverAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(sent.status).toBe(200);
    expect(
      typeof ((await sent.json()) as { scheduledId?: unknown }).scheduledId,
    ).toBe("string");
    const events = readFileSync(AGENT_REFERENCE_USAGE_LOG, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.agentId === agent.id);
    expect(events.map((event) => event.kind)).toEqual([
      "reference_fetch",
      "feature_call",
    ]);
    expect(events[0]).toMatchObject({ topic: "scheduled-messages" });
    expect(events[1]).toMatchObject({
      category: "scheduled-messages",
      opId: "agents.sendMessage",
    });
    expect(events[1].topics).toContain("scheduled-messages");
  });

  // GET /agents is the discovery feature call, on both rosters. A rejected
  // call is not a feature call.
  it("records each successful GET /agents by an agent under discovery", async () => {
    const { srv, agent, token } = await setup();
    const headers = { Authorization: `Bearer ${token}` };
    for (const query of ["", "?killed=1", "?killed=0", "?back=2"]) {
      const res = await fetch(`${srv.baseUrl}/agents${query}`, { headers });
      expect({ query, status: res.status }).toEqual({
        query,
        status: query === "" || query === "?killed=1" ? 200 : 400,
      });
    }
    const events = readFileSync(AGENT_REFERENCE_USAGE_LOG, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const mine = events.filter((event) => event.agentId === agent.id);
    expect(mine).toHaveLength(2);
    for (const event of mine) {
      expect(event).toMatchObject({
        kind: "feature_call",
        category: "discovery",
        opId: "agents.discovery",
      });
      expect(event.topics).toContain("discovery");
    }
  });
});

describe("agent reference usage events", () => {
  const agent: Identity = {
    scope: "agent",
    agentId: "a1",
    userId: "u1",
    role: "owner",
    capabilities: PRIVILEGED_AGENT_CAPABILITIES,
  };

  it("keeps a plain send under messaging", () => {
    const event = agentReferenceUsageEvent({
      identity: agent,
      opId: "agents.sendMessage",
      sessionId: null,
      route: { method: "POST", path: "/api/agents/:id/messages" },
    });
    expect(event).toMatchObject({
      kind: "feature_call",
      category: "messaging",
    });
  });

  // An operator drives another agent's conversation with routes whose
  // contract lives in conversation-lifecycle; a fetch of either topic counts.
  it("lists every topic that pins a shared route", () => {
    const event = agentReferenceUsageEvent({
      identity: agent,
      opId: "agents.newConversation",
      sessionId: null,
      route: { method: "POST", path: "/api/agents/:id/new-conversation" },
    });
    expect(event).toMatchObject({ category: "conversation-lifecycle" });
    expect(event && "topics" in event ? [...event.topics].sort() : []).toEqual([
      "agent-management",
      "conversation-lifecycle",
    ]);
  });
});
