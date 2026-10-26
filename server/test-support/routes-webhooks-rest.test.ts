// Webhooks on the REST surface (opIds webhooks.*), through the real route
// table, guards, preconditions and handlers. See
// internal-docs/webhooks-design.md sections 2, 4 and 7. The public delivery
// route is webhooks-ingress.test.ts; the field rules are
// server/webhooks/registry.test.ts, the rule matching match.test.ts.
//
// Webhooks follow rooms, like cronjobs (task fe0c21fd). A hook belongs to its
// target's room: the target agent's room, or the target cronjob's room. Who
// sees what, on the REST reads and the WebSocket deltas:
//
//   SEE    - the hook owner, office owners, and members of the hook's live
//            room: the hook, its rules, its delivery log and the dry run.
//   MANAGE - edit, delete and the secret stay with the hook owner and office
//            owners. Room access never widens it.
//
// Seam: startTestServer(). Zero LLM. The harness wipes STATE_ROOT on every
// boot and the registry holds no cache, so each test starts with no hooks.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { STATE_ROOT } from "../config.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { API_ROUTES } from "../routes/table.ts";
import { webhookRegistry } from "../webhooks/registry.ts";
import type { AgentInfo, Cronjob, WebhookWire } from "../../shared/types.ts";
import type { WebhookCreateRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

interface Res {
  status: number;
  body: unknown;
  text: string;
}

interface Caller {
  rawSessionId?: string;
  bearer?: string;
}

async function api(
  srv: TestServer,
  path: string,
  caller: Caller,
  init: { method?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (caller.bearer) headers["Authorization"] = `Bearer ${caller.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: caller.rawSessionId,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

const errCode = (r: Res): string | undefined =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId = srv.agentManager.getRooms()[0].id,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

function seedJob(srv: TestServer, username: string, roomId?: string): Cronjob {
  return srv.cronjobManager.addCronjob({
    name: "Review",
    schedule: { type: "none" },
    prompt: "Review the pull request.",
    cwd: srv.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username,
    userId: getUserByName(username)?.id ?? null,
    ...(roomId ? { roomId } : {}),
  });
}

const hookBody = (target: unknown, over: Record<string, unknown> = {}) => ({
  name: "pr-review",
  scheme: "github-hmac-sha256",
  rules: [
    {
      event: "pull_request",
      match: { action: "opened" },
      args: { pr: "{{payload.pull_request.number}}" },
    },
  ],
  target,
  ...over,
});

// An office with an owner and a member, Alice, who reaches room A only.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const roomA = srv.agentManager.createRoom("Alpha");
  const roomB = srv.agentManager.createRoom("Beta");
  const alice = await srv.seedMember("Alice");
  const aliceId = getUserByName("Alice")!.id;
  expect(updateUserById(aliceId, { allowedRooms: [roomA] }).ok).toBe(true);
  return { srv, owner, alice, aliceId, roomA, roomB };
}

// Alice owns the hooks and reaches rooms A and B. Carol reaches room A only,
// Dan room B only.
async function roomsOffice() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const roomA = srv.agentManager.createRoom("Alpha");
  const roomB = srv.agentManager.createRoom("Beta");
  const alice = await srv.seedMember("Alice");
  const carol = await srv.seedMember("Carol");
  const dan = await srv.seedMember("Dan");
  const idOf = (name: string) => getUserByName(name)!.id;
  expect(
    updateUserById(idOf("Alice"), { allowedRooms: [roomA, roomB] }).ok,
  ).toBe(true);
  expect(updateUserById(idOf("Carol"), { allowedRooms: [roomA] }).ok).toBe(
    true,
  );
  expect(updateUserById(idOf("Dan"), { allowedRooms: [roomB] }).ok).toBe(true);
  return {
    srv,
    owner,
    asAlice: { rawSessionId: alice.rawSessionId },
    asCarol: { rawSessionId: carol.rawSessionId },
    asDan: { rawSessionId: dan.rawSessionId },
    alice,
    carol,
    dan,
    idOf,
    roomA,
    roomB,
  };
}

async function createHook(
  srv: TestServer,
  caller: Caller,
  target: unknown,
): Promise<WebhookWire> {
  const made = await api(srv, "/api/webhooks", caller, {
    method: "POST",
    body: hookBody(target),
  });
  expect(made.status).toBe(201);
  return made.body as WebhookWire;
}

const listIds = async (srv: TestServer, caller: Caller) =>
  ((await api(srv, "/api/webhooks", caller)).body as WebhookWire[]).map(
    (h) => h.id,
  );

// Every webhook route on one hook, with the status each answered.
async function statusesOn(srv: TestServer, caller: Caller, id: string) {
  const calls = [
    ["GET", `/api/webhooks/${id}`, undefined],
    ["GET", `/api/webhooks/${id}/deliveries`, undefined],
    [
      "POST",
      `/api/webhooks/${id}/dry-run`,
      { event: "pull_request", payload: { action: "opened" } },
    ],
    ["PATCH", `/api/webhooks/${id}`, { enabled: false }],
    ["GET", `/api/webhooks/${id}/secret`, undefined],
    ["POST", `/api/webhooks/${id}/secret`, undefined],
    ["DELETE", `/api/webhooks/${id}`, undefined],
  ] as const;
  const out: Record<string, number> = {};
  for (const [method, path, body] of calls) {
    const res = await api(srv, path, caller, { method, body });
    out[`${method} ${path.replace(id, ":id")}`] = res.status;
  }
  return out;
}

const READS_ONLY = {
  "GET /api/webhooks/:id": 200,
  "GET /api/webhooks/:id/deliveries": 200,
  "POST /api/webhooks/:id/dry-run": 200,
  "PATCH /api/webhooks/:id": 403,
  "GET /api/webhooks/:id/secret": 403,
  "POST /api/webhooks/:id/secret": 403,
  "DELETE /api/webhooks/:id": 403,
};
const NOTHING = {
  "GET /api/webhooks/:id": 403,
  "GET /api/webhooks/:id/deliveries": 403,
  "POST /api/webhooks/:id/dry-run": 403,
  "PATCH /api/webhooks/:id": 403,
  "GET /api/webhooks/:id/secret": 403,
  "POST /api/webhooks/:id/secret": 403,
  "DELETE /api/webhooks/:id": 403,
};

const framesOf = (sock: TestSocket, type: string, id: string) =>
  sock.messages.filter((m) => {
    const frame = m as {
      type?: string;
      id?: string;
      webhook?: { id?: string };
    };
    return frame.type === type && (frame.id ?? frame.webhook?.id) === id;
  });

describe("webhooks REST: lifecycle", () => {
  it("an agent creates, reads, lists, updates and deletes a hook; the default target is itself", async () => {
    const { srv, aliceId, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const bearer = mintAgentToken(bot.id, aliceId);

    const made = await api(
      srv,
      "/api/webhooks",
      { bearer },
      {
        method: "POST",
        body: hookBody(undefined),
      },
    );
    expect(made.status).toBe(201);
    // The 201 alone carries the secret (the maker's secret describe below).
    const { secret: _secret, ...hook } = made.body as WebhookCreateRes;
    expect(hook.target).toEqual({ kind: "agent", agentId: bot.id });
    // Ownership is the agent's manager, from the token.
    expect(hook.userId).toBe(aliceId);
    expect(hook.createdByAgentId).toBe(bot.id);
    expect(hook.url).toEndWith(`/hooks/${hook.id}`);
    expect(hook.secretState).toBe("set");
    expect(hook.lastDelivery).toBeNull();
    expect(hook.enabled).toBe(true);

    expect(
      (await api(srv, `/api/webhooks/${hook.id}`, { bearer })).body,
    ).toEqual(hook);
    expect((await api(srv, "/api/webhooks", { bearer })).body).toEqual([hook]);

    const patched = await api(
      srv,
      `/api/webhooks/${hook.id}`,
      { bearer },
      { method: "PATCH", body: { enabled: false, name: "pr-review-2" } },
    );
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({
      ...hook,
      enabled: false,
      name: "pr-review-2",
    });

    const deliveries = await api(srv, `/api/webhooks/${hook.id}/deliveries`, {
      bearer,
    });
    expect(deliveries.body).toEqual({ deliveries: [] });

    const del = await api(
      srv,
      `/api/webhooks/${hook.id}`,
      { bearer },
      { method: "DELETE" },
    );
    expect(del.status).toBe(204);
    expect((await api(srv, "/api/webhooks", { bearer })).body).toEqual([]);
  });

  it("refuses a PATCH that names the scheme, an empty patch, a member's hook with no target, a note with an angle bracket and a rule field over 1000 characters; a corrupt registry is a 500", async () => {
    const { srv, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const caller = { rawSessionId: alice.rawSessionId };
    const target = { kind: "agent", agentId: bot.id };
    const made = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody(target),
    });
    const id = (made.body as WebhookWire).id;
    for (const body of [
      { scheme: "hmac-sha256", signatureHeader: "x-sig" },
      { scheme: "github-hmac-sha256", enabled: false },
    ]) {
      const res = await api(srv, `/api/webhooks/${id}`, caller, {
        method: "PATCH",
        body,
      });
      expect(res.status).toBe(422);
      expect(errCode(res)).toBe("scheme_immutable");
    }
    expect(
      ((await api(srv, `/api/webhooks/${id}`, caller)).body as WebhookWire)
        .enabled,
    ).toBe(true);
    const empty = await api(srv, `/api/webhooks/${id}`, caller, {
      method: "PATCH",
      body: {},
    });
    expect(empty.status).toBe(400);

    // A human session has no default target.
    const untargeted = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody(undefined, { name: "untargeted" }),
    });
    expect(untargeted.status).toBe(400);
    expect(errCode(untargeted)).toBe("invalid_target");

    const badNote = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody({ ...target, note: "<b>" }, { name: "bad-note" }),
    });
    expect([badNote.status, errCode(badNote)]).toEqual([400, "invalid_note"]);

    // The bound is registry.test.ts; the wire checks create and update.
    const over = [{ event: "push", args: { x: "a".repeat(1001) } }];
    const created = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody(target, { name: "over", rules: over }),
    });
    expect([created.status, errCode(created)]).toEqual([
      422,
      "rule_field_too_long",
    ]);
    const updated = await api(srv, `/api/webhooks/${id}`, caller, {
      method: "PATCH",
      body: { rules: over },
    });
    expect([updated.status, errCode(updated)]).toEqual([
      422,
      "rule_field_too_long",
    ]);

    // A corrupt registry fails loud on a read, not as an empty list.
    mkdirSync(join(STATE_ROOT, "webhooks"), { recursive: true });
    writeFileSync(join(STATE_ROOT, "webhooks", "webhooks.json"), "{oops");
    const res = await api(srv, "/api/webhooks", caller);
    expect(res.status).toBe(500);
    expect(errCode(res)).toBe("registry_corrupt");
  });

  it("an office owner sees every hook and may manage it, keeping its owner; an unknown id is 403 on every route", async () => {
    const { srv, owner, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const made = await api(
      srv,
      "/api/webhooks",
      { rawSessionId: alice.rawSessionId },
      { method: "POST", body: hookBody({ kind: "agent", agentId: bot.id }) },
    );
    const id = (made.body as WebhookWire).id;
    const asOwner = { rawSessionId: owner.rawSessionId };
    expect(
      ((await api(srv, "/api/webhooks", asOwner)).body as WebhookWire[]).map(
        (h) => h.id,
      ),
    ).toEqual([id]);
    // An owner's edit keeps the hook's owner.
    const patched = await api(srv, `/api/webhooks/${id}`, asOwner, {
      method: "PATCH",
      body: { enabled: false, userId: "someone", username: "Morgan" },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as WebhookWire).userId).toBe(
      (made.body as WebhookWire).userId,
    );
    expect((patched.body as WebhookWire).username).toBe("Alice");
    // An unknown id is 403 for an office owner too, on every :id route.
    const unknown = "/api/webhooks/wh_ffffffffffffffff";
    for (const [method, path, body] of [
      ["GET", unknown, undefined],
      ["PATCH", unknown, { enabled: true }],
      ["DELETE", unknown, undefined],
      ["GET", `${unknown}/deliveries`, undefined],
      ["POST", `${unknown}/dry-run`, { event: "push", payload: {} }],
      ["GET", `${unknown}/secret`, undefined],
      ["POST", `${unknown}/secret`, undefined],
    ] as const) {
      const res = await api(srv, path, asOwner, { method, body });
      expect({ method, path, status: res.status }).toEqual({
        method,
        path,
        status: 403,
      });
    }
  });
});

describe("webhooks REST: who may point a hook at what", () => {
  it("a cronjob target: an ordinary agent cannot set one and a privileged agent of the job's owner can; a job the owner did not create or an unknown one is refused; a rules-only PATCH by a caller who could not set the target is refused", async () => {
    const { srv, alice, aliceId, roomA } = await office();
    const job = seedJob(srv, "Alice");
    const morganJob = seedJob(srv, "Morgan");
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const target = { kind: "cronjob" as const, cronjobId: job.id };
    const asAlice = { rawSessionId: alice.rawSessionId };

    const plain = await api(
      srv,
      "/api/webhooks",
      { bearer: mintAgentToken(bot.id, aliceId) },
      { method: "POST", body: hookBody(target) },
    );
    expect(plain.status).toBe(403);
    // Minting again revokes the earlier token.
    const privileged = await api(
      srv,
      "/api/webhooks",
      { bearer: mintAgentToken(bot.id, aliceId, true) },
      { method: "POST", body: hookBody(target) },
    );
    expect(privileged.status).toBe(201);
    expect((privileged.body as WebhookWire).target).toEqual(target);

    for (const cronjobId of [morganJob.id, "nope1234"]) {
      const res = await api(srv, "/api/webhooks", asAlice, {
        method: "POST",
        body: hookBody({ kind: "cronjob", cronjobId }, { name: "other" }),
      });
      expect([cronjobId, res.status]).toEqual([cronjobId, 403]);
    }

    // Alice sets the cronjob target herself; her ordinary agent passes the
    // owner guard but could not set that target.
    const made = await api(srv, "/api/webhooks", asAlice, {
      method: "POST",
      body: hookBody(target, { name: "alice-job" }),
    });
    expect(made.status).toBe(201);
    const id = (made.body as WebhookWire).id;
    const bearer = mintAgentToken(bot.id, aliceId);
    const res = await api(
      srv,
      `/api/webhooks/${id}`,
      { bearer },
      { method: "PATCH", body: { rules: [{ event: "*" }] } },
    );
    expect(res.status).toBe(403);
    // The stored record is unchanged.
    const after = await api(srv, `/api/webhooks/${id}`, { bearer });
    expect((after.body as WebhookWire).rules).toEqual(
      (made.body as WebhookWire).rules,
    );
  });

  it("refuses an agent target outside the hook owner's rooms, and the same agent through a room the owner reaches", async () => {
    const { srv, alice, roomA, roomB } = await office();
    const outside = await spawnAgent(srv, "Outsider", roomB);
    const inside = await spawnAgent(srv, "Insider", roomA);
    const caller = { rawSessionId: alice.rawSessionId };
    const refused = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: outside.id }),
    });
    expect(refused.status).toBe(403);
    // A missing agent gets the same answer as a hidden one.
    const missing = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: "agent-404" }),
    });
    expect(missing.status).toBe(403);
    const made = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: inside.id }),
    });
    expect(made.status).toBe(201);
    // Retargeting through PATCH runs the same check.
    const moved = await api(
      srv,
      `/api/webhooks/${(made.body as WebhookWire).id}`,
      caller,
      {
        method: "PATCH",
        body: { target: { kind: "agent", agentId: outside.id } },
      },
    );
    expect(moved.status).toBe(403);
  });
});

describe("webhooks REST: the secret", () => {
  it("the secret routes answer the member, rotate at once, and refuse an agent that did not make the hook, a privileged agent, a cron run and an API token", async () => {
    const { srv, alice, aliceId, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const asAlice = { rawSessionId: alice.rawSessionId };
    const made = await api(srv, "/api/webhooks", asAlice, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: bot.id }),
    });
    const id = (made.body as WebhookWire).id;
    const job = seedJob(srv, "Alice");
    // One token per agent: minting again revokes the earlier token.
    const operator = await spawnAgent(srv, "Operator", roomA);
    const refused: [string, Caller][] = [
      ["agent", { bearer: mintAgentToken(bot.id, aliceId) }],
      [
        "privileged agent",
        { bearer: mintAgentToken(operator.id, aliceId, true) },
      ],
      ["cron run", { bearer: mintRunToken(job.id, "run-1", aliceId) }],
      [
        "API token",
        {
          bearer: (
            await mintApiToken({
              userId: aliceId,
              name: "Laptop",
              expiresInDays: null,
            })
          ).token,
        },
      ],
    ];
    const secretOf = async () => {
      const read = await api(srv, `/api/webhooks/${id}/secret`, asAlice);
      expect(read.status).toBe(200);
      return (read.body as { secret: string }).secret;
    };
    const before = await secretOf();
    expect(before).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const [label, caller] of refused) {
      for (const method of ["GET", "POST"]) {
        const res = await api(srv, `/api/webhooks/${id}/secret`, caller, {
          method,
        });
        expect({ label, method, status: res.status }).toEqual({
          label,
          method,
          status: 403,
        });
      }
    }
    // The refused rotates changed nothing; the member's rotate does, at once.
    expect(await secretOf()).toBe(before);
    const rotated = await api(srv, `/api/webhooks/${id}/secret`, asAlice, {
      method: "POST",
    });
    expect(rotated.status).toBe(200);
    const after = (rotated.body as { secret: string }).secret;
    expect(after).not.toBe(before);
    expect(await secretOf()).toBe(after);
  });

  it("no webhook route response and no socket frame contains the secret, except the create answer and the two secret routes", async () => {
    const { srv, alice, aliceId, roomA } = await office();
    const sock = await srv.connectWs(alice.rawSessionId);
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const bearer = mintAgentToken(bot.id, aliceId);
    const asAlice = { rawSessionId: alice.rawSessionId };
    const made = await api(srv, "/api/webhooks", asAlice, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: bot.id }),
    });
    const id = (made.body as WebhookWire).id;
    const readSecret = await api(srv, `/api/webhooks/${id}/secret`, asAlice);
    const original = (readSecret.body as { secret: string }).secret;
    expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The create response gives its caller the secret once; the create
    // frame, which every member who sees the hook gets, does not.
    await sock.waitFor("webhook_upserted");
    const framesBeforeRotate = sock.messages.map((m) => JSON.stringify(m));
    expect((made.body as WebhookCreateRes).secret).toBe(original);
    expect(framesBeforeRotate.some((f) => f.includes(original))).toBe(false);

    const rotate = await api(srv, `/api/webhooks/${id}/secret`, asAlice, {
      method: "POST",
    });
    const rotated = (rotate.body as { secret: string }).secret;
    expect(rotated).not.toBe(original);

    const calls: [string, string, Caller, unknown?][] = [
      ["GET", "/api/webhooks", asAlice],
      ["GET", `/api/webhooks/${id}`, asAlice],
      ["GET", `/api/webhooks/${id}`, { bearer }],
      ["PATCH", `/api/webhooks/${id}`, asAlice, { enabled: false }],
      ["GET", `/api/webhooks/${id}/deliveries`, asAlice],
      [
        "POST",
        `/api/webhooks/${id}/dry-run`,
        asAlice,
        { event: "pull_request", payload: { action: "opened" } },
      ],
      ["GET", `/api/webhooks/${id}/secret`, { bearer }],
      ["POST", `/api/webhooks/${id}/secret`, { bearer }],
      ["DELETE", `/api/webhooks/${id}`, asAlice],
    ];
    const texts: [string, string][] = [];
    for (const [method, path, caller, body] of calls) {
      const res = await api(srv, path, caller, { method, body });
      texts.push([`${method} ${path}`, res.text]);
    }
    // Every webhook route was exercised (the two secret routes as members
    // above and as a refused agent here).
    const exercised = new Set(
      [...calls.map(([m, p]) => `${m} ${p}`), `POST /api/webhooks`].map((r) =>
        r.replace(id, ":id"),
      ),
    );
    for (const route of API_ROUTES.filter((r) =>
      r.opId.startsWith("webhooks."),
    )) {
      expect(exercised.has(`${route.method} ${route.path}`)).toBe(true);
    }
    for (const [label, text] of texts) {
      expect({
        label,
        original: text.includes(original),
        rotated: text.includes(rotated),
      }).toEqual({ label, original: false, rotated: false });
    }
    await sock.waitFor("webhook_deleted");
    const frames = sock.messages.map((m) => JSON.stringify(m));
    expect(frames.filter((f) => f.includes('"webhook_upserted"')).length).toBe(
      3,
    );
    expect(frames.some((f) => f.includes(original))).toBe(false);
    expect(frames.some((f) => f.includes(rotated))).toBe(false);
    sock.close();
  });
});

// The agent that makes a hook signs its own deliveries (a dead-man timer, a
// deploy script), so the office gives it the secret: once in the create
// answer, and again each time it rotates (task 37b2876b). No later read
// shows it, and no other agent may rotate it.
describe("webhooks REST: the creator's secret", () => {
  const SECRET = /^[A-Za-z0-9_-]{43}$/;

  it("every creator - a member, an agent, an API token - gets the secret once in the 201; later reads and the frames do not hold it", async () => {
    const { srv, alice, aliceId, roomA } = await office();
    const sock = await srv.connectWs(alice.rawSessionId);
    const asAlice = { rawSessionId: alice.rawSessionId };
    const maker = await spawnAgent(srv, "Maker", roomA);
    const target = { kind: "agent", agentId: maker.id };
    const creators: [string, Caller][] = [
      ["member", asAlice],
      ["agent", { bearer: mintAgentToken(maker.id, aliceId) }],
      [
        "API token",
        {
          bearer: (
            await mintApiToken({
              userId: aliceId,
              name: "Laptop",
              expiresInDays: null,
            })
          ).token,
        },
      ],
    ];
    const made: [string, Caller, string, string][] = [];
    for (const [label, caller] of creators) {
      const res = await api(srv, "/api/webhooks", caller, {
        method: "POST",
        body: hookBody(target, { name: `hook-${made.length}` }),
      });
      expect({ label, status: res.status }).toEqual({ label, status: 201 });
      const { id, secret } = res.body as WebhookCreateRes;
      expect({ label, shaped: SECRET.test(secret) }).toEqual({
        label,
        shaped: true,
      });
      made.push([label, caller, id, secret]);
    }
    // Each 201 held its own hook's live secret, read where a member reads it.
    for (const [label, , id, secret] of made) {
      const read = await api(srv, `/api/webhooks/${id}/secret`, asAlice);
      expect({
        label,
        secret: (read.body as { secret: string }).secret,
      }).toEqual({ label, secret });
    }
    // The creator's own later reads do not hold it.
    for (const [label, caller, id, secret] of made) {
      for (const path of ["/api/webhooks", `/api/webhooks/${id}`]) {
        const res = await api(srv, path, caller);
        expect({
          label,
          path,
          status: res.status,
          leaks: res.text.includes(secret),
        }).toEqual({ label, path, status: 200, leaks: false });
      }
    }
    await waitUntil(
      () =>
        made.every(
          ([, , id]) => framesOf(sock, "webhook_upserted", id).length > 0,
        ),
      "a create frame per hook",
    );
    const frames = sock.messages.map((m) => JSON.stringify(m));
    for (const [label, , , secret] of made)
      expect({
        label,
        inFrame: frames.some((f) => f.includes(secret)),
      }).toEqual({ label, inFrame: false });
    sock.close();
  });

  it("the agent that made a hook rotates it and gets the new secret, but cannot read it; a non-maker agent, a privileged agent, an office owner's agent and an API token cannot rotate", async () => {
    const { srv, alice, aliceId, roomA } = await office();
    const sock = await srv.connectWs(alice.rawSessionId);
    const asAlice = { rawSessionId: alice.rawSessionId };
    const morganId = getUserByName("Morgan")!.id;
    const maker = await spawnAgent(srv, "Maker", roomA);
    const sibling = await spawnAgent(srv, "Sibling", roomA);
    const operator = await spawnAgent(srv, "Operator", roomA);
    const owners = await spawnAgent(srv, "OwnersBot", roomA);
    const asMaker = { bearer: mintAgentToken(maker.id, aliceId) };
    const created = await api(srv, "/api/webhooks", asMaker, {
      method: "POST",
      body: hookBody(undefined),
    });
    expect(created.status).toBe(201);
    const { id, secret: first } = created.body as WebhookCreateRes;
    const secretOf = async () =>
      (
        (await api(srv, `/api/webhooks/${id}/secret`, asAlice)).body as {
          secret: string;
        }
      ).secret;
    expect(await secretOf()).toBe(first);

    // The maker reads nothing later: GET /secret stays with members.
    expect((await api(srv, `/api/webhooks/${id}/secret`, asMaker)).status).toBe(
      403,
    );

    const refused: [string, Caller][] = [
      [
        "agent of the same manager",
        { bearer: mintAgentToken(sibling.id, aliceId) },
      ],
      [
        "privileged agent of the same manager",
        { bearer: mintAgentToken(operator.id, aliceId, true) },
      ],
      [
        "office owner's privileged agent",
        { bearer: mintAgentToken(owners.id, morganId, true) },
      ],
      [
        "API token",
        {
          bearer: (
            await mintApiToken({
              userId: aliceId,
              name: "Laptop",
              expiresInDays: null,
            })
          ).token,
        },
      ],
    ];
    for (const [label, caller] of refused) {
      const res = await api(srv, `/api/webhooks/${id}/secret`, caller, {
        method: "POST",
      });
      expect({ label, status: res.status }).toEqual({ label, status: 403 });
    }
    expect(await secretOf()).toBe(first);

    const rotated = await api(srv, `/api/webhooks/${id}/secret`, asMaker, {
      method: "POST",
    });
    expect(rotated.status).toBe(200);
    const second = (rotated.body as { secret: string }).secret;
    expect(SECRET.test(second)).toBe(true);
    expect(second).not.toBe(first);
    expect(await secretOf()).toBe(second);
    // Later reads by the maker and the frames do not hold the new one.
    for (const path of ["/api/webhooks", `/api/webhooks/${id}`]) {
      const res = await api(srv, path, asMaker);
      expect({ path, leaks: res.text.includes(second) }).toEqual({
        path,
        leaks: false,
      });
    }
    const frames = sock.messages.map((m) => JSON.stringify(m));
    expect(frames.some((f) => f.includes(second))).toBe(false);
    sock.close();
  });

  // An office owner's agent passes the route's owner-or-office-owner guard
  // on any hook, so only the maker arm's own owner check refuses it here.
  it("the maker agent cannot rotate a hook that another member owns now, even when its manager is an office owner", async () => {
    const { srv, roomA } = await office();
    const carol = await srv.seedMember("Carol");
    const carolId = getUserByName("Carol")!.id;
    const morganId = getUserByName("Morgan")!.id;
    const maker = await spawnAgent(srv, "Maker", roomA);
    const asMaker = { bearer: mintAgentToken(maker.id, morganId) };
    const created = await api(srv, "/api/webhooks", asMaker, {
      method: "POST",
      body: hookBody(undefined),
    });
    expect(created.status).toBe(201);
    const { id, secret } = created.body as WebhookCreateRes;
    expect(webhookRegistry.get(id)?.createdByAgentId).toBe(maker.id);
    // The enabling condition: before the hook passes, the maker may rotate.
    const own = await api(srv, `/api/webhooks/${id}/secret`, asMaker, {
      method: "POST",
    });
    expect(own.status).toBe(200);
    const live = (own.body as { secret: string }).secret;
    expect(live).not.toBe(secret);
    webhookRegistry.setOwner(id, carolId, "Carol");
    expect(webhookRegistry.get(id)?.userId).toBe(carolId);
    const res = await api(srv, `/api/webhooks/${id}/secret`, asMaker, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    const read = await api(srv, `/api/webhooks/${id}/secret`, {
      rawSessionId: carol.rawSessionId,
    });
    expect((read.body as { secret: string }).secret).toBe(live);
  });
});

describe("webhooks REST: dry run", () => {
  it("returns the matched rule, args and block, and writes no delivery row", async () => {
    const { srv, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const caller = { rawSessionId: alice.rawSessionId };
    const made = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: bot.id, note: "Review it." }),
    });
    const id = (made.body as WebhookWire).id;
    const dry = (payload: unknown, event = "pull_request") =>
      api(srv, `/api/webhooks/${id}/dry-run`, caller, {
        method: "POST",
        body: { event, payload },
      });

    const hit = await dry({ action: "opened", pull_request: { number: 7 } });
    expect(hit.status).toBe(200);
    const body = hit.body as {
      outcome: string;
      ruleIndex: number;
      args: Record<string, string>;
      block: string;
      truncated: string[];
    };
    expect(body.outcome).toBe("match");
    expect(body.ruleIndex).toBe(0);
    expect(body.args).toEqual({ pr: "7" });
    expect(body.truncated).toEqual([]);
    const lines = body.block.split("\n");
    expect(lines.at(-1)).toBe("</webhook-data>");
    expect(JSON.parse(lines.at(-2)!)).toEqual({ pr: "7" });
    expect(lines[0]).toContain("Review it.");
    // A value over the budget is cut in the block and named in the answer.
    const long = await dry({
      action: "opened",
      pull_request: { number: "7".repeat(5000) },
    });
    expect(long.body).toMatchObject({ outcome: "match", truncated: ["pr"] });

    expect(
      ((await dry({ action: "closed" })).body as { outcome: string }).outcome,
    ).toBe("no_match");
    expect(((await dry({}, "ping")).body as { outcome: string }).outcome).toBe(
      "ping",
    );
    // Rules match the raw event: a header that differs only in characters
    // the display reduction drops is another event.
    expect(
      (
        (await dry({ action: "opened" }, "pull_request!")).body as {
          outcome: string;
        }
      ).outcome,
    ).toBe("no_match");
    for (const payload of [[1, 2], "text", undefined]) {
      expect((await dry(payload)).status).toBe(400);
    }

    expect(existsSync(join(STATE_ROOT, "webhooks", id))).toBe(false);
    const deliveries = await api(srv, `/api/webhooks/${id}/deliveries`, caller);
    expect(deliveries.body).toEqual({ deliveries: [] });
  });
});

describe("webhook rooms: REST", () => {
  it("a member of the hook's room reads it but not the secret; a member without the room gets nothing", async () => {
    const { srv, asAlice, asCarol, asDan, roomA } = await roomsOffice();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const hook = await createHook(srv, asAlice, {
      kind: "agent",
      agentId: bot.id,
    });
    const secret = (
      (await api(srv, `/api/webhooks/${hook.id}/secret`, asAlice)).body as {
        secret: string;
      }
    ).secret;
    expect(secret.length).toBeGreaterThan(20);

    // Carol, in room A: the hook, its rules and its delivery log.
    expect(await listIds(srv, asCarol)).toEqual([hook.id]);
    const carolGet = await api(srv, `/api/webhooks/${hook.id}`, asCarol);
    expect(carolGet.body).toEqual(
      (await api(srv, `/api/webhooks/${hook.id}`, asAlice)).body,
    );
    expect((carolGet.body as WebhookWire).rules).toEqual(hook.rules);
    const dry = await api(srv, `/api/webhooks/${hook.id}/dry-run`, asCarol, {
      method: "POST",
      body: {
        event: "pull_request",
        payload: { action: "opened", pull_request: { number: 7 } },
      },
    });
    expect(dry.body).toMatchObject({ outcome: "match", args: { pr: "7" } });
    for (const text of [
      (await api(srv, "/api/webhooks", asCarol)).text,
      carolGet.text,
      (await api(srv, `/api/webhooks/${hook.id}/deliveries`, asCarol)).text,
      dry.text,
    ]) {
      expect(text.includes(secret)).toBe(false);
    }
    // Not the secret, and no edit, rotate or delete.
    expect(await statusesOn(srv, asCarol, hook.id)).toEqual(READS_ONLY);

    // Dan, in room B only: an empty list and 403 on every route.
    expect(await listIds(srv, asDan)).toEqual([]);
    expect(await statusesOn(srv, asDan, hook.id)).toEqual(NOTHING);

    // Their refused writes changed nothing: same secret, still enabled.
    expect(
      (
        (await api(srv, `/api/webhooks/${hook.id}/secret`, asAlice)).body as {
          secret: string;
        }
      ).secret,
    ).toBe(secret);
    expect(
      (
        (await api(srv, `/api/webhooks/${hook.id}`, asAlice))
          .body as WebhookWire
      ).enabled,
    ).toBe(true);
  });

  it("an agent reads the hooks in its manager's rooms and nothing else", async () => {
    const { srv, asAlice, idOf, roomA, roomB } = await roomsOffice();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const hook = await createHook(srv, asAlice, {
      kind: "agent",
      agentId: bot.id,
    });
    const carolBot = await spawnAgent(srv, "CarolBot", roomA);
    const danBot = await spawnAgent(srv, "DanBot", roomB);
    const asCarolBot = { bearer: mintAgentToken(carolBot.id, idOf("Carol")) };
    const asDanBot = { bearer: mintAgentToken(danBot.id, idOf("Dan")) };
    expect(await listIds(srv, asCarolBot)).toEqual([hook.id]);
    expect(
      (await api(srv, `/api/webhooks/${hook.id}/deliveries`, asCarolBot))
        .status,
    ).toBe(200);
    expect(
      (
        await api(srv, `/api/webhooks/${hook.id}`, asCarolBot, {
          method: "PATCH",
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
    expect(await listIds(srv, asDanBot)).toEqual([]);
    expect((await api(srv, `/api/webhooks/${hook.id}`, asDanBot)).status).toBe(
      403,
    );
  });
});

describe("webhook rooms: the audience moves with the target", () => {
  it("an agent target: a move, a kill and a revive move the hook between rooms, on REST and live", async () => {
    const { srv, owner, asAlice, asCarol, asDan, carol, dan, roomA, roomB } =
      await roomsOffice();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const carolWs = await srv.connectWs(carol.rawSessionId);
    const danWs = await srv.connectWs(dan.rawSessionId);
    const hook = await createHook(srv, asAlice, {
      kind: "agent",
      agentId: bot.id,
    });
    // The create reaches the room member and not the outsider.
    await waitUntil(
      () => framesOf(carolWs, "webhook_upserted", hook.id).length === 1,
      "carol hears the create",
    );
    expect(framesOf(danWs, "webhook_upserted", hook.id)).toEqual([]);

    // The agent moves to room B: Carol loses the hook, Dan gains it.
    const moved = await api(srv, `/api/agents/${bot.id}/move`, asAlice, {
      method: "POST",
      body: { targetRoomId: roomB },
    });
    expect(moved.status).toBe(200);
    await waitUntil(
      () =>
        framesOf(carolWs, "webhook_deleted", hook.id).length === 1 &&
        framesOf(danWs, "webhook_upserted", hook.id).length === 1,
      "the move re-projects both sockets",
    );
    expect(await listIds(srv, asCarol)).toEqual([]);
    expect((await api(srv, `/api/webhooks/${hook.id}`, asCarol)).status).toBe(
      403,
    );
    expect(await listIds(srv, asDan)).toEqual([hook.id]);

    // The agent is killed: the hook has no room, so it is the owner's and
    // office owners' only.
    const killed = await api(srv, `/api/agents/${bot.id}`, asAlice, {
      method: "DELETE",
    });
    expect(killed.status).toBeLessThan(300);
    await waitUntil(
      () => framesOf(danWs, "webhook_deleted", hook.id).length === 1,
      "dan hears the hook leave",
    );
    expect(await statusesOn(srv, asDan, hook.id)).toEqual(NOTHING);
    expect(await listIds(srv, asAlice)).toEqual([hook.id]);
    expect(await listIds(srv, { rawSessionId: owner.rawSessionId })).toEqual([
      hook.id,
    ]);

    // Revived into room A: Carol gets it back.
    const revived = await api(srv, `/api/agents/${bot.id}/revive`, asAlice, {
      method: "POST",
      body: { roomId: roomA, desk: 0 },
    });
    expect(revived.status).toBeLessThan(300);
    await waitUntil(
      () => framesOf(carolWs, "webhook_upserted", hook.id).length === 2,
      "carol hears the hook come back",
    );
    expect(await listIds(srv, asCarol)).toEqual([hook.id]);
    carolWs.close();
    danWs.close();
  });

  it("a cronjob target: the hook follows the job's room, and leaves with the job", async () => {
    const { srv, asAlice, asCarol, asDan, carol, dan, roomA, roomB } =
      await roomsOffice();
    const job = seedJob(srv, "Alice", roomA);
    const carolWs = await srv.connectWs(carol.rawSessionId);
    const danWs = await srv.connectWs(dan.rawSessionId);
    const hook = await createHook(srv, asAlice, {
      kind: "cronjob",
      cronjobId: job.id,
    });
    expect(await statusesOn(srv, asCarol, hook.id)).toEqual(READS_ONLY);
    expect(await listIds(srv, asDan)).toEqual([]);

    srv.cronjobManager.updateCronjob(job.id, { roomId: roomB });
    await waitUntil(
      () =>
        framesOf(carolWs, "webhook_deleted", hook.id).length === 1 &&
        framesOf(danWs, "webhook_upserted", hook.id).length === 1,
      "the job's move re-projects both sockets",
    );
    expect(await listIds(srv, asCarol)).toEqual([]);
    expect(await statusesOn(srv, asDan, hook.id)).toEqual(READS_ONLY);

    expect(srv.cronjobManager.deleteCronjob(job.id)).toBe(true);
    await waitUntil(
      () => framesOf(danWs, "webhook_deleted", hook.id).length === 1,
      "dan hears the hook leave with the job",
    );
    expect(await listIds(srv, asDan)).toEqual([]);
    expect(await listIds(srv, asAlice)).toEqual([hook.id]);
    carolWs.close();
    danWs.close();
  });

  it("losing and regaining room access withdraws and returns the hook live", async () => {
    const { srv, owner, asAlice, asCarol, carol, roomA, roomB } =
      await roomsOffice();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const hook = await createHook(srv, asAlice, {
      kind: "agent",
      agentId: bot.id,
    });
    const carolWs = await srv.connectWs(carol.rawSessionId);
    const setCarolRooms = async (allowedRooms: string[]) => {
      const res = await api(
        srv,
        "/api/users/Carol/access",
        { rawSessionId: owner.rawSessionId },
        { method: "PUT", body: { allowedRooms } },
      );
      expect(res.status).toBeLessThan(300);
    };
    await setCarolRooms([roomB]);
    await waitUntil(
      () => framesOf(carolWs, "webhook_deleted", hook.id).length === 1,
      "carol hears the hook leave",
    );
    expect(await statusesOn(srv, asCarol, hook.id)).toEqual(NOTHING);
    await setCarolRooms([roomA]);
    await waitUntil(
      () => framesOf(carolWs, "webhook_upserted", hook.id).length === 1,
      "carol hears the hook come back",
    );
    expect(await listIds(srv, asCarol)).toEqual([hook.id]);
    carolWs.close();
  });

  it("closing the hook's room leaves it to the owner and office owners", async () => {
    const { srv, owner, asAlice, asCarol, carol, idOf } = await roomsOffice();
    const roomC = srv.agentManager.createRoom("Gamma");
    expect(updateUserById(idOf("Carol"), { allowedRooms: [roomC] }).ok).toBe(
      true,
    );
    expect(updateUserById(idOf("Alice"), { allowedRooms: [roomC] }).ok).toBe(
      true,
    );
    const job = seedJob(srv, "Alice", roomC);
    const hook = await createHook(srv, asAlice, {
      kind: "cronjob",
      cronjobId: job.id,
    });
    const carolWs = await srv.connectWs(carol.rawSessionId);
    expect(await listIds(srv, asCarol)).toEqual([hook.id]);

    const closed = await api(
      srv,
      `/api/rooms/${roomC}`,
      { rawSessionId: owner.rawSessionId },
      { method: "DELETE" },
    );
    expect(closed.status).toBeLessThan(300);
    await waitUntil(
      () => framesOf(carolWs, "webhook_deleted", hook.id).length === 1,
      "carol hears the hook leave",
    );
    expect(await statusesOn(srv, asCarol, hook.id)).toEqual(NOTHING);
    expect(await listIds(srv, asAlice)).toEqual([hook.id]);
    carolWs.close();
  });
});
