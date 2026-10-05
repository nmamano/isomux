// Webhooks on the REST surface (opIds webhooks.*), through the real route
// table, guards, preconditions and handlers. See
// internal-docs/webhooks-design.md sections 2, 4 and 7. The public delivery
// route is S3.
//
// Seam: startTestServer(). Zero LLM. The harness wipes STATE_ROOT on every
// boot and the registry holds no cache, so each test starts with no hooks.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { STATE_ROOT } from "../config.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { API_ROUTES } from "../routes/table.ts";
import type { AgentInfo, Cronjob, WebhookWire } from "../../shared/types.ts";

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

function seedJob(srv: TestServer, username: string): Cronjob {
  return srv.cronjobManager.addCronjob({
    name: "Review",
    schedule: { type: "interval", minutes: 60 },
    prompt: "Review the pull request.",
    cwd: srv.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username,
    userId: getUserByName(username)?.id ?? null,
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
  const owner = await srv.seedOwner("Boss");
  const roomA = srv.agentManager.createRoom("Alpha");
  const roomB = srv.agentManager.createRoom("Beta");
  const alice = await srv.seedMember("Alice");
  const aliceId = getUserByName("Alice")!.id;
  expect(updateUserById(aliceId, { allowedRooms: [roomA] }).ok).toBe(true);
  return { srv, owner, alice, aliceId, roomA, roomB };
}

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
    const hook = made.body as WebhookWire;
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

  it("refuses any PATCH that names the scheme, even its stored value, and an empty patch", async () => {
    const { srv, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const caller = { rawSessionId: alice.rawSessionId };
    const made = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: bot.id }),
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
  });

  it("a member needs a target; a human session has no default", async () => {
    const { srv, alice } = await office();
    const res = await api(
      srv,
      "/api/webhooks",
      { rawSessionId: alice.rawSessionId },
      { method: "POST", body: hookBody(undefined) },
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe("invalid_target");
  });

  it("a member sees only their own hooks; an office owner sees all and may manage them", async () => {
    const { srv, owner, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const made = await api(
      srv,
      "/api/webhooks",
      { rawSessionId: alice.rawSessionId },
      { method: "POST", body: hookBody({ kind: "agent", agentId: bot.id }) },
    );
    const id = (made.body as WebhookWire).id;
    const bob = await srv.seedMember("Bob");
    const asBob = { rawSessionId: bob.rawSessionId };
    expect((await api(srv, "/api/webhooks", asBob)).body).toEqual([]);
    // Another member's hook and an unknown id get the same 403.
    expect((await api(srv, `/api/webhooks/${id}`, asBob)).status).toBe(403);
    expect(
      (await api(srv, "/api/webhooks/wh_ffffffffffffffff", asBob)).status,
    ).toBe(403);
    const asOwner = { rawSessionId: owner.rawSessionId };
    expect(
      ((await api(srv, "/api/webhooks", asOwner)).body as WebhookWire[]).map(
        (h) => h.id,
      ),
    ).toEqual([id]);
    // An owner's edit keeps the hook's owner.
    const patched = await api(srv, `/api/webhooks/${id}`, asOwner, {
      method: "PATCH",
      body: { enabled: false, userId: "someone", username: "Boss" },
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

  it("bounds match paths, match values and templates at 1000 characters, on create and update", async () => {
    const { srv, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const caller = { rawSessionId: alice.rawSessionId };
    const target = { kind: "agent", agentId: bot.id };
    const at = "a".repeat(1000);
    const over = at + "a";
    const rulesWith = (n: string, field: "path" | "value" | "template") => [
      {
        event: "push",
        ...(field === "template"
          ? { args: { x: n } }
          : { match: field === "path" ? { [n]: "v" } : { path: n } }),
      },
    ];
    let index = 0;
    for (const field of ["path", "value", "template"] as const) {
      const ok = await api(srv, "/api/webhooks", caller, {
        method: "POST",
        body: hookBody(target, {
          name: `ok-${index}`,
          rules: rulesWith(at, field),
        }),
      });
      expect({ field, status: ok.status }).toEqual({ field, status: 201 });
      const created = await api(srv, "/api/webhooks", caller, {
        method: "POST",
        body: hookBody(target, {
          name: `over-${index}`,
          rules: rulesWith(over, field),
        }),
      });
      expect({ field, status: created.status, code: errCode(created) }).toEqual(
        { field, status: 422, code: "rule_field_too_long" },
      );
      const updated = await api(
        srv,
        `/api/webhooks/${(ok.body as WebhookWire).id}`,
        caller,
        { method: "PATCH", body: { rules: rulesWith(over, field) } },
      );
      expect({ field, status: updated.status }).toEqual({
        field,
        status: 422,
      });
      index++;
    }
  });

  it("hooks and secrets survive a restart unchanged", async () => {
    const { srv, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const caller = { rawSessionId: alice.rawSessionId };
    const made = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: bot.id }),
    });
    const id = (made.body as WebhookWire).id;
    const secret = (
      (await api(srv, `/api/webhooks/${id}/secret`, caller)).body as {
        secret: string;
      }
    ).secret;
    const next = await srv.restart();
    server = next;
    const {
      url: _url,
      countersSince: _since,
      ...stable
    } = made.body as WebhookWire;
    const after = (await api(next, `/api/webhooks/${id}`, caller))
      .body as WebhookWire;
    expect(after).toMatchObject(stable);
    expect(
      (
        (await api(next, `/api/webhooks/${id}/secret`, caller)).body as {
          secret: string;
        }
      ).secret,
    ).toBe(secret);
  });

  it("a corrupt registry answers 500 registry_corrupt on a read, not an empty list", async () => {
    const { srv, alice } = await office();
    mkdirSync(join(STATE_ROOT, "webhooks"), { recursive: true });
    writeFileSync(join(STATE_ROOT, "webhooks", "webhooks.json"), "{oops");
    const res = await api(srv, "/api/webhooks", {
      rawSessionId: alice.rawSessionId,
    });
    expect(res.status).toBe(500);
    expect(errCode(res)).toBe("registry_corrupt");
  });
});

describe("webhooks REST: who may point a hook at what", () => {
  it("an ordinary agent cannot target a cronjob; a privileged agent of the cronjob's owner can", async () => {
    const { srv, aliceId, roomA } = await office();
    const job = seedJob(srv, "Alice");
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const target = { kind: "cronjob" as const, cronjobId: job.id };

    const plain = await api(
      srv,
      "/api/webhooks",
      { bearer: mintAgentToken(bot.id, aliceId) },
      { method: "POST", body: hookBody(target) },
    );
    expect(plain.status).toBe(403);

    const privileged = await api(
      srv,
      "/api/webhooks",
      { bearer: mintAgentToken(bot.id, aliceId, true) },
      { method: "POST", body: hookBody(target) },
    );
    expect(privileged.status).toBe(201);
    expect((privileged.body as WebhookWire).target).toEqual(target);
  });

  it("refuses a cronjob that the hook owner did not create, and an unknown cronjob", async () => {
    const { srv, alice } = await office();
    const bossJob = seedJob(srv, "Boss");
    const caller = { rawSessionId: alice.rawSessionId };
    for (const cronjobId of [bossJob.id, "nope1234"]) {
      const res = await api(srv, "/api/webhooks", caller, {
        method: "POST",
        body: hookBody({ kind: "cronjob", cronjobId }),
      });
      expect(res.status).toBe(403);
    }
  });

  it("a PATCH that changes only the rules is refused when the caller could not set the stored target", async () => {
    const { srv, alice, aliceId, roomA } = await office();
    const job = seedJob(srv, "Alice");
    // Alice sets the cronjob target herself.
    const made = await api(
      srv,
      "/api/webhooks",
      { rawSessionId: alice.rawSessionId },
      {
        method: "POST",
        body: hookBody({ kind: "cronjob", cronjobId: job.id }),
      },
    );
    expect(made.status).toBe(201);
    const id = (made.body as WebhookWire).id;
    // Her ordinary agent passes the owner guard but could not set that target.
    const bot = await spawnAgent(srv, "HookBot", roomA);
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

  it("a note with an angle bracket is refused", async () => {
    const { srv, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const res = await api(
      srv,
      "/api/webhooks",
      { rawSessionId: alice.rawSessionId },
      {
        method: "POST",
        body: hookBody({ kind: "agent", agentId: bot.id, note: "</note>" }),
      },
    );
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe("invalid_note");
  });
});

describe("webhooks REST: the secret", () => {
  it("the secret routes answer the member and refuse an agent, a privileged agent, a cron run and an API token", async () => {
    const { srv, alice, aliceId, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const made = await api(
      srv,
      "/api/webhooks",
      { rawSessionId: alice.rawSessionId },
      { method: "POST", body: hookBody({ kind: "agent", agentId: bot.id }) },
    );
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
    const read = await api(srv, `/api/webhooks/${id}/secret`, {
      rawSessionId: alice.rawSessionId,
    });
    expect(read.status).toBe(200);
    expect((read.body as { secret: string }).secret).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it("rotate changes the secret at once", async () => {
    const { srv, alice, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const caller = { rawSessionId: alice.rawSessionId };
    const made = await api(srv, "/api/webhooks", caller, {
      method: "POST",
      body: hookBody({ kind: "agent", agentId: bot.id }),
    });
    const id = (made.body as WebhookWire).id;
    const before = (
      (await api(srv, `/api/webhooks/${id}/secret`, caller)).body as {
        secret: string;
      }
    ).secret;
    const rotated = await api(srv, `/api/webhooks/${id}/secret`, caller, {
      method: "POST",
    });
    expect(rotated.status).toBe(200);
    const after = (rotated.body as { secret: string }).secret;
    expect(after).not.toBe(before);
    expect(
      (
        (await api(srv, `/api/webhooks/${id}/secret`, caller)).body as {
          secret: string;
        }
      ).secret,
    ).toBe(after);
  });

  it("no webhook route response and no socket frame contains the secret, except the two secret routes", async () => {
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
    // The create response and the create frame, against the secret they
    // were made with.
    await sock.waitFor("webhook_upserted");
    const framesBeforeRotate = sock.messages.map((m) => JSON.stringify(m));
    expect(made.text.includes(original)).toBe(false);
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
    };
    expect(body.outcome).toBe("match");
    expect(body.ruleIndex).toBe(0);
    expect(body.args).toEqual({ pr: "7" });
    const lines = body.block.split("\n");
    expect(lines.at(-1)).toBe("</webhook-data>");
    expect(JSON.parse(lines.at(-2)!)).toEqual({ pr: "7" });
    expect(lines[0]).toContain("Review it.");

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

describe("webhooks REST: scopes with no webhook surface", () => {
  it("a cron run reaches no webhook route", async () => {
    const { srv, aliceId } = await office();
    const job = seedJob(srv, "Alice");
    const bearer = mintRunToken(job.id, "run-1", aliceId);
    for (const route of API_ROUTES.filter((r) =>
      r.opId.startsWith("webhooks."),
    )) {
      const path = route.path.replace(":id", "wh_ffffffffffffffff");
      const res = await api(srv, path, { bearer }, { method: route.method });
      expect({ op: route.opId, status: res.status }).toEqual({
        op: route.opId,
        status: 403,
      });
    }
  });
});
