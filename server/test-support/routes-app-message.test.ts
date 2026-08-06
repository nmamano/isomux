// POST /api/app/message - the loop closing: a registered app messaging the agent
// that built it. See internal-docs/agent-apps-design.md section 5.
//
// What these pin that a unit test cannot:
//   - the token IS the app. A real app token, minted by a real registration and
//     read out of the environment file the supervisor wrote, reaches this route
//     and NOTHING else; an agent token reaches everything else and not this.
//   - the message arrives LABELLED as an app's, both in the receiver's queue and
//     in the prompt the model is handed - and it survives a restart, because the
//     durable queue's validator is a separate boundary from the live queue.
//   - a deleted app's token is not an identity at all (401), which is the
//     registry-existence half of token resolution.
//   - the rate limit answers 429 with a time, and the two budgets are spent at
//     different moments (driven at the handler seam, where a fake limiter can
//     record what was called).
//
// The supervisor is the harness FAKE - systemd is machine-global. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { formatAppSenderPrefix } from "../../shared/identity.ts";
import {
  APP_MESSAGE_BURST_LIMIT,
  APP_MESSAGE_MAX_CHARS,
  createAppMessageLimiter,
  type AppMessageLimiter,
} from "../app-message-limits.ts";
import { appsHandlers, type AppsDeps } from "../routes/handlers/apps.ts";
import type { RouteHandlerContext } from "../routes/executor.ts";
import type { AgentInfo, AppRecord, LogEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

// A backend that parks every turn in "thinking" - so a receiver can be held busy
// and its QUEUE inspected. An idle receiver flushes asynchronously, which makes a
// queue assertion a race rather than a test.
const parkingBackend = () =>
  new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
  });

interface Res {
  status: number;
  body: unknown;
}

async function post(
  srv: TestServer,
  path: string,
  bearer: string,
  payload?: unknown,
): Promise<Res> {
  const res = await srv.http(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const errOf = (r: Res) =>
  (
    r.body as {
      error?: { code?: string; message?: string; retryAfterSec?: number };
    } | null
  )?.error;

async function spawnAgent(srv: TestServer, name: string): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    undefined,
    // Codex: a boot-replay wake starts a FRESH session instead of tripping
    // Claude's resume preflight on the fake session id.
    "codex",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// Seed an office, an agent, and an app that agent registered. Returns the app's
// REAL token - read out of the environment file the (fake) supervisor wrote, the
// same place the running app would read it from.
async function seedApp(
  srv: TestServer,
  appName: string,
): Promise<{
  agent: AgentInfo;
  appToken: string;
  agentToken: string;
  ownerSessionId: string;
}> {
  const owner = await srv.seedOwner("Boss");
  const ownerId = getUserByName("Boss")!.id;
  const agent = await spawnAgent(srv, "AppBot");
  const agentToken = mintAgentToken(agent.id, ownerId);
  const reg = await post(srv, "/api/apps", agentToken, {
    name: appName,
    command: "bun run serve.ts",
    cwd: srv.stateRoot,
  });
  expect(reg.status).toBe(201);
  const appToken = srv.appSupervisor.tokenFiles.get(appName);
  if (!appToken) throw new Error(`no token file for ${appName}`);
  return { agent, appToken, agentToken, ownerSessionId: owner.rawSessionId };
}

function queueOf(srv: TestServer, agentId: string): AgentInfo["queue"] {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === agentId);
  if (!a) throw new Error(`agent ${agentId} not found`);
  return a.queue;
}

function stateOf(srv: TestServer, agentId: string): string {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === agentId);
  if (!a) throw new Error(`agent ${agentId} not found`);
  return a.state;
}

// Every send the agent's sessions received, flattened - the prompt text the model
// would actually see.
function promptsFor(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

// user_message entries carrying app provenance, read from the agent's PERSISTED
// log on disk (STATE_ROOT/logs/<agentId>/<session>.jsonl) - the boundary the UI
// reads back, not the live wire.
function appMessageLogEntries(srv: TestServer, agentId: string): LogEntry[] {
  const dir = join(srv.stateRoot, "logs", agentId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as LogEntry),
    )
    .filter(
      (e) =>
        e.kind === "user_message" && e.metadata?.sender_app_name !== undefined,
    );
}

// One app message over HTTP, for the tests that only care about the status.
const sendAppMessage = (srv: TestServer, appToken: string, text: string) =>
  post(srv, "/api/app/message", appToken, { text });

// --- the happy path, end to end ---------------------------------------------

describe("POST /api/app/message: an app messages the agent that built it", () => {
  it("delivers to that agent, labelled as an app, and survives a restart", async () => {
    let srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const { agent, appToken, ownerSessionId } = await seedApp(srv, "habits");

    // Hold the receiver BUSY through the human path, so the message queues
    // instead of flushing while the assertion runs.
    const seeded = await srv.http(`/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "kickoff" }),
      rawSessionId: ownerSessionId,
    });
    expect(seeded.status).toBeLessThan(400);
    await waitUntil(() => stateOf(srv, agent.id) === "thinking", 3000, "busy");

    const sent = await post(srv, "/api/app/message", appToken, {
      text: "nightly run finished: 3 habits logged",
    });
    expect(sent.status).toBe(200);
    expect((sent.body as { queued?: boolean }).queued).toBe(true);

    // THE LABEL, in the queue: the app's name, and no agent or user identity.
    await waitUntil(() => queueOf(srv, agent.id).length === 1, 3000, "queued");
    expect(queueOf(srv, agent.id)[0].sender).toEqual({
      kind: "app",
      appName: "habits",
    });

    // THE DURABLE BOUNDARY. The queue's on-disk validator is separate code from
    // the live queue, so an app-sender item is replayed only if that validator
    // knows the kind. Without its arm this message vanishes at boot, silently.
    srv = await srv.restart();
    server = srv;
    await waitUntil(
      () =>
        promptsFor(srv, agent.id).some((t) =>
          t.includes("nightly run finished"),
        ),
      5000,
      "replayed delivery",
    );

    // THE LABEL, in the prompt the model is handed.
    const prompt = promptsFor(srv, agent.id).find((t) =>
      t.includes("nightly run finished"),
    )!;
    expect(prompt).toContain(
      `${formatAppSenderPrefix("habits")} nightly run finished: 3 habits logged`,
    );
    // Not a boss, and not an agent.
    expect(prompt).not.toContain("[Boss]");
    expect(prompt).not.toContain("agent id:");

    // THE LABEL, in the PERSISTENT log - the surface a human scrolls back
    // through, read off disk rather than off the wire. sender_app_name is what
    // the UI maps to the app label and to "not editable"
    // (describeMessageSender), so a delivery that reached the model correctly
    // but persisted as an anonymous user_message would still read as the boss
    // asking for something.
    await waitUntil(
      () => appMessageLogEntries(srv, agent.id).length === 1,
      3000,
      "persisted user_message",
    );
    const persisted = appMessageLogEntries(srv, agent.id)[0];
    expect(persisted.metadata?.sender_app_name).toBe("habits");
    // ...and NOT the metadata of either other sender kind, which is what the
    // UI's human/agent branches key on.
    expect(persisted.metadata?.sender_agent_name).toBeUndefined();
    expect(persisted.metadata?.username).toBeUndefined();
  });

  // The counters are in memory, and the product says they reset when isomux
  // restarts. The harness restart IS an isomux restart, so it must model that -
  // otherwise the thing under test and the thing testing it disagree about the
  // advertised lifecycle.
  it("the rate limit budget resets when isomux restarts, as the prose promises", async () => {
    let srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const { appToken } = await seedApp(srv, "restart-app");

    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      const r = await sendAppMessage(srv, appToken, `m${i}`);
      expect({ i, status: r.status }).toEqual({ i, status: 200 });
    }
    expect((await sendAppMessage(srv, appToken, "over")).status).toBe(429);

    srv = await srv.restart();
    server = srv;
    // Same app, same token (both persisted), fresh budget.
    expect((await sendAppMessage(srv, appToken, "after restart")).status).toBe(
      200,
    );
  });
});

// --- who may call it --------------------------------------------------------

describe("POST /api/app/message: the token is the app, and nothing else reaches it", () => {
  it("refuses an ordinary AGENT token (403) - an agent has its own send route", async () => {
    const srv = await startTestServer();
    server = srv;
    const { agentToken } = await seedApp(srv, "agent-token-app");
    const r = await post(srv, "/api/app/message", agentToken, { text: "hi" });
    expect(r.status).toBe(403);
  });

  it("refuses a garbage token (401) and a DELETED app's token (401)", async () => {
    const srv = await startTestServer();
    server = srv;
    const { appToken, agentToken } = await seedApp(srv, "deleted-app");
    expect(
      (await post(srv, "/api/app/message", "not-a-real-token", { text: "hi" }))
        .status,
    ).toBe(401);

    // The token still hashes to a stored entry the moment before this; deleting
    // the app is what makes it stop being an identity. 401, not 403: there is no
    // such app to be.
    const del = await srv.http("/api/apps/deleted-app", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(del.status).toBe(204);
    const after = await post(srv, "/api/app/message", appToken, { text: "hi" });
    expect(after.status).toBe(401);
  });
});

// --- what it refuses --------------------------------------------------------

describe("POST /api/app/message: text validation", () => {
  it("refuses missing, empty and whitespace-only text", async () => {
    const srv = await startTestServer();
    server = srv;
    const { appToken } = await seedApp(srv, "validation-app");
    for (const payload of [{}, { text: "" }, { text: "   \n\t " }] as const) {
      const r = await post(srv, "/api/app/message", appToken, payload);
      expect({ payload, status: r.status, code: errOf(r)?.code }).toEqual({
        payload,
        status: 400,
        code: "invalid_text",
      });
    }
  });

  it("refuses text past the cap, and accepts text at it", async () => {
    const srv = await startTestServer();
    server = srv;
    const { appToken } = await seedApp(srv, "length-app");
    const tooLong = await post(srv, "/api/app/message", appToken, {
      text: "x".repeat(APP_MESSAGE_MAX_CHARS + 1),
    });
    expect(tooLong.status).toBe(400);
    expect(errOf(tooLong)?.code).toBe("text_too_long");

    const atCap = await post(srv, "/api/app/message", appToken, {
      text: "x".repeat(APP_MESSAGE_MAX_CHARS),
    });
    expect(atCap.status).toBe(200);
  });
});

describe("POST /api/app/message: the rate limit", () => {
  it("answers 429 with a retry time once the burst is spent", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const { appToken } = await seedApp(srv, "burst-app");

    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      const r = await post(srv, "/api/app/message", appToken, {
        text: `msg ${i}`,
      });
      expect({ i, status: r.status }).toEqual({ i, status: 200 });
    }
    const over = await post(srv, "/api/app/message", appToken, {
      text: "one too many",
    });
    expect(over.status).toBe(429);
    expect(errOf(over)?.code).toBe("rate_limited");
    // A number to back off by, not just prose - and prose that carries it too.
    expect(errOf(over)?.retryAfterSec).toBeGreaterThan(0);
    expect(errOf(over)?.message).toContain("retry in");
  });

  it("does not follow the NAME to the next app that takes it", async () => {
    // Deleting an app frees its name, so a budget keyed by name outlives the app
    // that spent it. Since anyone can register a freed name, an inherited budget
    // is one user's app denying another user's app for up to a day.
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const { appToken, agentToken } = await seedApp(srv, "reused-name");
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      await post(srv, "/api/app/message", appToken, { text: `msg ${i}` });
    }
    expect(
      (await post(srv, "/api/app/message", appToken, { text: "over" })).status,
    ).toBe(429);

    const del = await srv.http("/api/apps/reused-name", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(del.status).toBe(204);
    const reg = await post(srv, "/api/apps", agentToken, {
      name: "reused-name",
      command: "bun run serve.ts",
      cwd: srv.stateRoot,
    });
    expect(reg.status).toBe(201);

    // A different app under the same name, with its own token and its own
    // budget - the clock has not moved, so an inherited one would still block.
    const reborn = srv.appSupervisor.tokenFiles.get("reused-name")!;
    expect(
      (await post(srv, "/api/app/message", reborn, { text: "hi" })).status,
    ).toBe(200);
  });
});

describe("POST /api/app/message: nobody to message", () => {
  it("404s with an actionable message when the agent that registered it is gone", async () => {
    const srv = await startTestServer();
    server = srv;
    const { agent, appToken } = await seedApp(srv, "orphan-app");
    await srv.agentManager.kill(agent.id);

    const r = await post(srv, "/api/app/message", appToken, { text: "hi" });
    expect(r.status).toBe(404);
    expect(errOf(r)?.code).toBe("target_gone");
    // Actionable: it says the retry is pointless, rather than reading like a bad
    // parameter on a route that has no parameters.
    expect(errOf(r)?.message).toContain("no longer exists");
  });

  it("409s when a PERSON registered the app - there is no agent attached", async () => {
    const srv = await startTestServer();
    server = srv;
    const ownerSession = await srv.seedOwner("Boss");
    const reg = await srv.http("/api/apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "human-app",
        command: "bun run serve.ts",
        cwd: srv.stateRoot,
      }),
      rawSessionId: ownerSession.rawSessionId,
    });
    expect(reg.status).toBe(201);
    const appToken = srv.appSupervisor.tokenFiles.get("human-app")!;

    const r = await post(srv, "/api/app/message", appToken, { text: "hi" });
    expect(r.status).toBe(409);
    expect(errOf(r)?.code).toBe("no_target");
  });
});

// --- the two budgets, at the handler seam -----------------------------------
//
// WHEN each budget is spent is the load-bearing rule, and it needs a delivery
// that FAILS - which the REST surface cannot stage without killing an agent
// mid-request. Driven through appsHandlers directly, with a limiter that records.

describe("routes/apps: the burst is spent on every attempt, the day only on delivery", () => {
  const record: AppRecord = {
    name: "habits",
    hostLabel: "habits",
    hostGen: 1,
    port: 21000,
    command: "bun run serve.ts",
    cwd: "/tmp",
    dataDir: "/tmp/data/habits",
    userId: "u-alice",
    username: "alice",
    createdBy: "AppBot",
    createdByAgentId: "a-1",
    createdAt: 1,
  };

  function recordingLimiter(): {
    limiter: AppMessageLimiter;
    calls: string[];
  } {
    const inner = createAppMessageLimiter();
    const calls: string[] = [];
    return {
      calls,
      limiter: {
        takeBurst: (name) => {
          calls.push(`burst:${name}`);
          return inner.takeBurst(name);
        },
        commitDaily: (name) => {
          calls.push(`daily:${name}`);
          inner.commitDaily(name);
        },
        forget: (name) => {
          calls.push(`forget:${name}`);
          inner.forget(name);
        },
      },
    };
  }

  const deps = (over: Partial<AppsDeps>): AppsDeps => ({
    list: () => [record],
    get: () => record,
    register: () => record,
    remove: () => record,
    update: () => record,
    attributionFor: () => ({ createdBy: "AppBot", username: "alice" }),
    validateCwd: (cwd: string) => ({ ok: true as const, resolved: cwd }),
    isOfficeOwner: () => false,
    announce: () => {},
    announceRemoved: () => {},
    provisionToken: () => true,
    revokeToken: () => {},
    install: () => {},
    reinstall: () => {},
    teardown: () => {},
    start: () => {},
    stop: () => {},
    restart: () => {},
    states: () => new Map(),
    logs: () => [],
    sendAsApp: () => ({ ok: true as const, messageId: "m-1" }),
    limiter: createAppMessageLimiter(),
    ...over,
  });

  const appCtx = (body: unknown): RouteHandlerContext => ({
    identity: {
      scope: "app",
      userId: "u-alice",
      appName: "habits",
      role: "member",
      capabilities: ["app:message"],
    },
    params: {},
    body,
    rawBody: JSON.stringify(body ?? {}),
    query: new URLSearchParams(),
    req: new Request("http://localhost/"),
  });

  it("spends both when the receiver accepts", () => {
    const rec = recordingLimiter();
    const h = appsHandlers(deps({ limiter: rec.limiter }));
    const out = h["apps.sendMessage"](appCtx({ text: "hi" }));
    expect((out as { kind: string }).kind).toBe("json");
    expect(rec.calls).toEqual(["burst:habits", "daily:habits"]);
  });

  it("spends the burst but NOT the day when the receiver refuses", () => {
    const rec = recordingLimiter();
    const h = appsHandlers(
      deps({
        limiter: rec.limiter,
        sendAsApp: () => ({
          ok: false as const,
          status: 409 as const,
          code: "agent_stopped",
          message: "agent_stopped",
        }),
      }),
    );
    const out = h["apps.sendMessage"](appCtx({ text: "hi" }));
    expect(out).toMatchObject({ kind: "error", status: 409 });
    // The loop is still arrested (burst spent), but a stopped agent has not
    // eaten the app's day - it woke nobody and burned no model tokens.
    expect(rec.calls).toEqual(["burst:habits"]);
  });

  it("spends NEITHER on a request that was never valid", () => {
    const rec = recordingLimiter();
    const h = appsHandlers(deps({ limiter: rec.limiter }));
    expect(h["apps.sendMessage"](appCtx({ text: "  " }))).toMatchObject({
      kind: "error",
      status: 400,
    });
    expect(rec.calls).toEqual([]);
  });

  it("takes the burst slot BEFORE reading the registry, so a doomed loop still pays", () => {
    const rec = recordingLimiter();
    let reads = 0;
    const h = appsHandlers(
      deps({
        limiter: rec.limiter,
        get: () => {
          reads++;
          return null; // deleted between token resolution and here
        },
      }),
    );
    const out = h["apps.sendMessage"](appCtx({ text: "hi" }));
    expect(out).toMatchObject({ kind: "error", status: 404 });
    expect(rec.calls).toEqual(["burst:habits"]);
    expect(reads).toBe(1);
  });
});
