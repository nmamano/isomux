// The public webhook route, POST /hooks/:id, through buildServer's real fetch
// with a real HMAC. See internal-docs/webhooks-design.md sections 1, 5 and 6.
//
// Seam: startTestServer() with the webhookNow clock, so the window and limit
// tests move time without waiting. Zero LLM. The hook belongs to a member,
// Alice, whose room access is the switch for a target that goes away and
// comes back.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac, randomUUID } from "crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { connect } from "net";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { STATE_ROOT } from "../config.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { formatWebhookSenderPrefix } from "../../shared/identity.ts";
import { WEBHOOK_DELIVERY_LOG_MAX } from "../webhooks/registry.ts";
import { WEBHOOK_DEDUP_WINDOW_MS } from "../webhooks/deliveries.ts";
import {
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOK_INGRESS_BURST,
} from "../webhooks/ingress.ts";
import { APP_MESSAGE_BURST_LIMIT } from "../app-message-limits.ts";
import {
  anOfficeWithAnApp,
  appHost,
  OFFICE_HOST,
  raw,
} from "./app-host-test-kit.ts";
import { webhookRegistry } from "../webhooks/registry.ts";
import type {
  AgentInfo,
  LogEntry,
  WebhookDelivery,
  WebhookWire,
} from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// The ingress clock. Each office starts it at the real time; tests move it.
let clock = Date.now();
// One ingress token refills in 200 ms (300 per minute).
const TOKEN_MS = 200;

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

// Holds every turn open, so a delivery queues instead of flushing.
const parkingBackend = () =>
  new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
  });

const NAME = "pr-review";
const RULES = [
  {
    event: "pull_request",
    match: { action: "opened" },
    args: { pr: "{{payload.pull_request.number}}" },
  },
];

const prOpened = (n: number) =>
  JSON.stringify({ action: "opened", pull_request: { number: n } });
const prClosed = (n: number) =>
  JSON.stringify({ action: "closed", pull_request: { number: n } });

const sign = (secret: string, body: Uint8Array) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

interface Office {
  srv: TestServer;
  bossSession: string;
  aliceSession: string;
  aliceId: string;
  agent: AgentInfo;
  hook: WebhookWire;
  secret: string;
}

// Alice, a member who reaches room A, owns a GitHub hook that messages an
// agent in room A.
async function office(
  opts: {
    fakeBackend?: FakeBackend;
    rules?: unknown[];
    target?: (agent: AgentInfo) => unknown;
  } = {},
): Promise<Office> {
  clock = Date.now();
  const srv = await startTestServer({
    ...(opts.fakeBackend ? { fakeBackend: opts.fakeBackend } : {}),
    startServer: { webhookNow: () => clock },
  });
  server = srv;
  const boss = await srv.seedOwner("Boss");
  const roomA = srv.agentManager.createRoom("Alpha");
  const alice = await srv.seedMember("Alice");
  const aliceId = getUserByName("Alice")!.id;
  expect(updateUserById(aliceId, { allowedRooms: [roomA] }).ok).toBe(true);
  const agent = await srv.agentManager.spawn(
    "Reviewer",
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomA,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!agent) throw new Error("spawn returned null");
  const made = await srv.http("/api/webhooks", {
    method: "POST",
    rawSessionId: alice.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: NAME,
      scheme: "github-hmac-sha256",
      rules: opts.rules ?? RULES,
      target: opts.target
        ? opts.target(agent)
        : { kind: "agent", agentId: agent.id },
    }),
  });
  expect(made.status).toBe(201);
  const hook = (await made.json()) as WebhookWire;
  const secretRes = await srv.http(`/api/webhooks/${hook.id}/secret`, {
    rawSessionId: alice.rawSessionId,
  });
  const { secret } = (await secretRes.json()) as { secret: string };
  return {
    srv,
    bossSession: boss.rawSessionId,
    aliceSession: alice.rawSessionId,
    aliceId,
    agent,
    hook,
    secret,
  };
}

interface Delivered {
  status: number;
  body: unknown;
  headers: Headers;
}

interface DeliverOpts {
  body?: string | Uint8Array<ArrayBuffer>;
  // null leaves the header out.
  event?: string | null;
  delivery?: string;
  signature?: string | null;
  contentType?: string;
  method?: string;
  headers?: Record<string, string>;
  hookId?: string;
}

// One delivery, signed with the hook's secret unless told otherwise. No
// Origin, no cookie, no bearer token: the signature is the only credential.
async function deliver(o: Office, opts: DeliverOpts = {}): Promise<Delivered> {
  const body = opts.body ?? prOpened(1);
  const bytes: Uint8Array<ArrayBuffer> =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? "application/json",
    Connection: "close",
    "X-GitHub-Delivery": opts.delivery ?? randomUUID(),
  };
  if (opts.event !== null)
    headers["X-GitHub-Event"] = opts.event ?? "pull_request";
  const signature =
    opts.signature === undefined ? sign(o.secret, bytes) : opts.signature;
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  Object.assign(headers, opts.headers);
  const method = opts.method ?? "POST";
  const res = await fetch(
    `${o.srv.baseUrl}/hooks/${opts.hookId ?? o.hook.id}`,
    {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: bytes }),
    },
  );
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// Newest first, the whole log.
async function rows(o: Office): Promise<WebhookDelivery[]> {
  const res = await o.srv.http(
    `/api/webhooks/${o.hook.id}/deliveries?limit=${WEBHOOK_DELIVERY_LOG_MAX}`,
    { rawSessionId: o.aliceSession },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { deliveries: WebhookDelivery[] }).deliveries;
}

async function wire(o: Office): Promise<WebhookWire> {
  const res = await o.srv.http(`/api/webhooks/${o.hook.id}`, {
    rawSessionId: o.aliceSession,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as WebhookWire;
}

// The webhook messages in the agent's persisted log, the surface the UI reads.
function webhookMessages(o: Office): LogEntry[] {
  const dir = join(o.srv.stateRoot, "logs", o.agent.id);
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
        e.kind === "user_message" &&
        e.metadata?.sender_webhook_name !== undefined,
    );
}

// Exactly `n` webhook messages reach the agent, and no more arrive after.
async function expectMessages(o: Office, n: number): Promise<void> {
  if (n > 0) {
    await waitUntil(
      () => webhookMessages(o).length >= n,
      5000,
      `${n} webhook messages`,
    );
  }
  await sleep(150);
  expect(webhookMessages(o)).toHaveLength(n);
}

// No two rows share a body hash while both are inside the window.
function expectWindowInvariant(log: WebhookDelivery[]): void {
  const inWindow = log.filter(
    (row) => clock - row.receivedAt < WEBHOOK_DEDUP_WINDOW_MS,
  );
  const hashes = inWindow.map((row) => row.bodyHash);
  expect(new Set(hashes).size).toBe(hashes.length);
}

function setReach(o: Office, rooms: string[]): void {
  expect(updateUserById(o.aliceId, { allowedRooms: rooms }).ok).toBe(true);
}

describe("POST /hooks/:id: the stages before the signature write no row", () => {
  it("answers each pre-verify stage with its status and raises only a counter", async () => {
    const o = await office();

    // 1: unknown, and an id that cannot exist.
    expect((await deliver(o, { hookId: "wh_0000000000000000" })).status).toBe(
      404,
    );
    expect((await deliver(o, { hookId: "nope" })).status).toBe(404);

    // 2: method.
    const get = await deliver(o, { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    // 6: bad and missing signature.
    expect(
      (await deliver(o, { signature: `sha256=${"0".repeat(64)}` })).status,
    ).toBe(401);
    expect((await deliver(o, { signature: null })).status).toBe(401);
    // A valid signature over other bytes.
    expect(
      (await deliver(o, { signature: sign(o.secret, new Uint8Array([1])) }))
        .status,
    ).toBe(401);

    // 5: too large, declared.
    const big = new Uint8Array(WEBHOOK_BODY_MAX_BYTES + 1);
    expect((await deliver(o, { body: big })).status).toBe(413);

    // 1: disabled counts as not found.
    const off = await o.srv.http(`/api/webhooks/${o.hook.id}`, {
      method: "PATCH",
      rawSessionId: o.aliceSession,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect((await deliver(o)).status).toBe(404);
    await o.srv.http(`/api/webhooks/${o.hook.id}`, {
      method: "PATCH",
      rawSessionId: o.aliceSession,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    // 3: the secret is missing (as after a restore).
    const secretsFile = join(STATE_ROOT, "webhooks", "secrets.json");
    const secrets = JSON.parse(readFileSync(secretsFile, "utf-8"));
    const kept = secrets[o.hook.id];
    delete secrets[o.hook.id];
    writeFileSync(secretsFile, JSON.stringify(secrets));
    expect((await deliver(o)).status).toBe(503);
    secrets[o.hook.id] = kept;
    writeFileSync(secretsFile, JSON.stringify(secrets));

    expect(await rows(o)).toEqual([]);
    const { counters } = await wire(o);
    expect(counters.method?.count).toBe(1);
    expect(counters.bad_signature?.count).toBe(3);
    expect(counters.body_too_large?.count).toBe(1);
    expect(counters.disabled?.count).toBe(1);
    expect(counters.secret_missing?.count).toBe(1);
    expect(counters.rate_limited).toBeUndefined();
    // The body never names the hook's target or rule.
    expect(get.body).toEqual({ error: expect.any(String) });
  });

  // 100 requests in series: about 1.7 s alone, but it passed 5 s in a
  // full-suite run on a loaded box (2026-10-06).
  it("100 bad signatures leave the log empty and the counter at 100", async () => {
    const o = await office();
    for (let i = 0; i < 100; i++) {
      clock += TOKEN_MS;
      const res = await deliver(o, { body: prOpened(i), signature: null });
      expect(res.status).toBe(401);
    }
    expect(await rows(o)).toEqual([]);
    const { counters } = await wire(o);
    expect(counters.bad_signature?.count).toBe(100);
    expect(counters.bad_signature?.lastAt).toBe(clock);
  }, 30_000);

  it("the ingress limit answers 429 with Retry-After, keyed on the hook and not the client", async () => {
    const o = await office();
    // Each request names a different client; the bucket is the hook's.
    for (let i = 0; i < WEBHOOK_INGRESS_BURST; i++) {
      const res = await deliver(o, {
        signature: null,
        headers: { "X-Forwarded-For": `203.0.113.${i}` },
      });
      expect(res.status).toBe(401);
    }
    const limited = await deliver(o, {
      headers: { "X-Forwarded-For": "198.51.100.1" },
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );
    // Unknown ids answer 404 before the limiter, never 429.
    for (let i = 0; i < 5; i++) {
      expect((await deliver(o, { hookId: "wh_0000000000000000" })).status).toBe(
        404,
      );
    }
    clock += TOKEN_MS;
    expect((await deliver(o)).status).toBe(202);
    const { counters } = await wire(o);
    expect(counters.rate_limited?.count).toBe(1);
    expect((await rows(o)).length).toBe(1);
  });

  it("a body over the cap gets 413 also without Content-Length", async () => {
    const o = await office();
    const chunk = new Uint8Array(1024 * 1024);
    const chunks = Array.from(
      { length: WEBHOOK_BODY_MAX_BYTES / chunk.byteLength + 1 },
      () => chunk,
    );
    const over = await chunkedPost(o, chunks, `sha256=${"0".repeat(64)}`);
    expect(over).toBe(413);
    // The control: the same chunked framing under the cap is read whole and
    // verified.
    const body = new TextEncoder().encode(prOpened(5));
    const under = await chunkedPost(
      o,
      [body.subarray(0, 10), body.subarray(10)],
      sign(o.secret, body),
    );
    expect(under).toBe(202);
    const { counters } = await wire(o);
    expect(counters.body_too_large?.count).toBe(1);
    expect((await rows(o)).length).toBe(1);
  });
});

// A raw HTTP/1.1 POST with Transfer-Encoding: chunked and no Content-Length.
// Resolves with the status the server answered.
function chunkedPost(
  o: Office,
  chunks: Uint8Array[],
  signature: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = "";
    const socket = connect(o.srv.port, "127.0.0.1", () => {
      socket.write(
        [
          `POST /hooks/${o.hook.id} HTTP/1.1`,
          `Host: 127.0.0.1:${o.srv.port}`,
          "Content-Type: application/json",
          "Transfer-Encoding: chunked",
          "X-GitHub-Event: pull_request",
          `X-Hub-Signature-256: ${signature}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
      for (const chunk of chunks) {
        if (socket.destroyed) break;
        socket.write(`${chunk.byteLength.toString(16)}\r\n`);
        socket.write(chunk);
        socket.write("\r\n");
      }
      if (!socket.destroyed) socket.write("0\r\n\r\n");
    });
    const finish = () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0);
      if (status === 0) reject(new Error(`no status in: ${out.slice(0, 200)}`));
      else resolve(status);
    };
    socket.on("data", (d) => {
      out += d.toString("latin1");
    });
    socket.on("end", finish);
    // The server may close while the client is still writing.
    socket.on("error", () => (out ? finish() : undefined));
    socket.on("close", () => (out ? finish() : undefined));
  });
}

describe("POST /hooks/:id: verified deliveries", () => {
  it("delivers a [Webhook] message with the data block to the agent, labelled and durable", async () => {
    const o = await office({ fakeBackend: parkingBackend() });
    // Hold the agent busy, so the delivery queues.
    const kickoff = await o.srv.http(`/api/agents/${o.agent.id}/messages`, {
      method: "POST",
      rawSessionId: o.aliceSession,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "kickoff" }),
    });
    expect(kickoff.status).toBeLessThan(400);
    await waitUntil(
      () =>
        o.srv.agentManager.getAllAgents().find((a) => a.id === o.agent.id)
          ?.state === "thinking",
      3000,
      "busy",
    );

    const res = await deliver(o, {
      body: prOpened(7),
      delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    const queue = () =>
      o.srv.agentManager.getAllAgents().find((a) => a.id === o.agent.id)!.queue;
    await waitUntil(() => queue().length === 1, 3000, "queued");
    expect(queue()[0].sender).toEqual({
      kind: "webhook",
      webhookId: o.hook.id,
      webhookName: NAME,
    });
    const [row] = await rows(o);
    expect(row).toMatchObject({
      outcome: "dispatched",
      status: 202,
      ruleIndex: 0,
      args: { pr: "7" },
      target: { kind: "agent", agentId: o.agent.id },
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      attempts: 1,
      duplicates: 0,
    });
    expect((await wire(o)).lastDelivery).toEqual({
      outcome: "dispatched",
      receivedAt: row.receivedAt,
    });

    // The queue validator replays the webhook sender after a restart.
    const srv = await o.srv.restart();
    server = srv;
    const prompts = () =>
      srv.fakeBackend.sessions
        .filter((s) => s.opts.agentId === o.agent.id)
        .flatMap((s) => s.sent.map((m) => m.text));
    await waitUntil(
      () => prompts().some((t) => t.includes("<webhook-data>")),
      5000,
      "replayed delivery",
    );
    const prompt = prompts().find((t) => t.includes("<webhook-data>"))!;
    const start = prompt.indexOf(`${formatWebhookSenderPrefix(NAME)} `);
    expect(start).toBeGreaterThanOrEqual(0);
    const text = prompt.slice(start);
    const lines = text.split("\n");
    const open = lines.indexOf("<webhook-data>");
    expect(open).toBeGreaterThan(0);
    expect(JSON.parse(lines[open + 1])).toEqual({ pr: "7" });
    expect(lines[open + 2]).toBe("</webhook-data>");
    expect(lines.slice(0, open).join("\n")).toContain(
      "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    );
    const o2 = { ...o, srv };
    await waitUntil(
      () => webhookMessages(o2).length === 1,
      3000,
      "persisted user_message",
    );
    const persisted = webhookMessages(o2)[0];
    expect(persisted.metadata?.sender_webhook_id).toBe(o.hook.id);
    expect(persisted.metadata?.sender_webhook_name).toBe(NAME);
    expect(persisted.metadata?.username).toBeUndefined();
  });

  it("parses the form content type", async () => {
    const o = await office();
    const form = `payload=${encodeURIComponent(prOpened(9))}`;
    const res = await deliver(o, {
      body: form,
      contentType: "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(202);
    expect((await rows(o))[0]).toMatchObject({
      outcome: "dispatched",
      args: { pr: "9" },
    });
    await expectMessages(o, 1);
  });

  it("logs a ping row and never fires a * rule; copies of ping, no_match and bad_payload bodies add no rows", async () => {
    const o = await office({ rules: [{ event: "*" }] });
    const ping = await deliver(o, { body: '{"zen":"hi"}', event: "ping" });
    expect(ping.status).toBe(200);
    const bad = await deliver(o, { body: "[1,2]" });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "bad_payload" });
    const notJson = await deliver(o, { body: "{}", contentType: "text/plain" });
    expect(notJson.status).toBe(400);
    expect((await rows(o)).map((r) => r.outcome)).toEqual([
      "bad_payload",
      "bad_payload",
      "ping",
    ]);

    // A rule set that matches nothing, for a no_match row.
    await o.srv.http(`/api/webhooks/${o.hook.id}`, {
      method: "PATCH",
      rawSessionId: o.aliceSession,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: RULES }),
    });
    expect((await deliver(o, { body: prClosed(1) })).status).toBe(200);
    const before = await rows(o);
    expect(before.map((r) => r.outcome)).toEqual([
      "no_match",
      "bad_payload",
      "bad_payload",
      "ping",
    ]);

    for (const copy of [
      { body: '{"zen":"hi"}', event: "ping" },
      { body: "[1,2]" },
      { body: "{}", contentType: "text/plain" },
      { body: prClosed(1) },
    ]) {
      expect((await deliver(o, copy)).status).toBe(200);
      expect((await deliver(o, copy)).status).toBe(200);
    }
    const after = await rows(o);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.duplicates)).toEqual([2, 2, 2, 2]);
    await expectMessages(o, 0);
  });

  it("the same body twice answers 200 and raises duplicates, with no second row", async () => {
    const o = await office();
    expect((await deliver(o, { body: prOpened(1) })).status).toBe(202);
    clock += 1000;
    const again = await deliver(o, { body: prOpened(1) });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });
    const log = await rows(o);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      outcome: "dispatched",
      duplicates: 1,
      lastSeenAt: clock,
    });
    await expectMessages(o, 1);
  });

  it("concurrent copies of one body make one row and one dispatch", async () => {
    const o = await office();
    const copies = 10;
    const results = await Promise.all(
      Array.from({ length: copies }, () => deliver(o, { body: prOpened(3) })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(copies - 1);
    const log = await rows(o);
    expect(log).toHaveLength(1);
    expect(log[0].duplicates).toBe(copies - 1);
    await expectMessages(o, 1);
  });

  it("a known body sent again as ping, as another event and with a new delivery id adds no row", async () => {
    const o = await office();
    expect((await deliver(o, { body: prOpened(4) })).status).toBe(202);
    for (const replay of [
      { event: "ping" },
      { event: "issues" },
      { delivery: randomUUID() },
      { event: null },
    ]) {
      const res = await deliver(o, { body: prOpened(4), ...replay });
      expect(res.status).toBe(200);
    }
    const log = await rows(o);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      event: "pull_request",
      outcome: "dispatched",
      duplicates: 4,
    });
    await expectMessages(o, 1);
  });

  it("a target_unavailable body sent again after the target is back dispatches once on the same row", async () => {
    const o = await office();
    const roomA = o.agent.roomId;
    setReach(o, []);
    const first = await deliver(o, { body: prOpened(2) });
    expect(first.status).toBe(503);
    expect(first.body).toEqual({ error: "target_unavailable" });
    const [down] = await rows(o);
    expect(down).toMatchObject({ outcome: "target_unavailable", attempts: 1 });
    expect(down.detail).toEqual(expect.any(String));

    setReach(o, [roomA]);
    // A retry reads the event from the row, so this header changes nothing.
    const retry = await deliver(o, { body: prOpened(2), event: "issues" });
    expect(retry.status).toBe(202);
    const third = await deliver(o, { body: prOpened(2) });
    expect(third.status).toBe(200);
    const log = await rows(o);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      id: down.id,
      outcome: "dispatched",
      attempts: 2,
      duplicates: 1,
      detail: null,
    });
    await expectMessages(o, 1);
  });

  it("a retry whose body no longer parses keeps its retryable row and can still dispatch later", async () => {
    const o = await office();
    const roomA = o.agent.roomId;
    setReach(o, []);
    const body = `payload=${encodeURIComponent(prOpened(6))}`;
    const form = "application/x-www-form-urlencoded";
    expect((await deliver(o, { body, contentType: form })).status).toBe(503);
    setReach(o, [roomA]);
    // The same bytes under the wrong (unsigned) type do not parse.
    const wrongType = await deliver(o, { body });
    expect(wrongType.status).toBe(400);
    expect((await rows(o))[0]).toMatchObject({
      outcome: "target_unavailable",
      attempts: 2,
    });
    expect((await deliver(o, { body, contentType: form })).status).toBe(202);
    expect((await rows(o))[0]).toMatchObject({
      outcome: "dispatched",
      attempts: 3,
    });
    await expectMessages(o, 1);
  });

  // Alice's cronjob, as the hook's target. The precondition lets her set it
  // because she made the cronjob.
  async function cronjobTarget(o: Office, session = o.aliceSession) {
    const job = o.srv.cronjobManager.addCronjob({
      name: "triage",
      schedule: { type: "none" },
      prompt: "Triage the pull request.",
      cwd: o.srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "Alice",
      userId: o.aliceId,
    });
    const res = await o.srv.http(`/api/webhooks/${o.hook.id}`, {
      method: "PATCH",
      rawSessionId: session,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { kind: "cronjob", cronjobId: job.id },
      }),
    });
    expect(res.status).toBe(200);
    return job;
  }

  // The run ids of the cronjob's runs.
  const runIds = (o: Office, jobId: string) =>
    o.srv.cronjobManager.getRunsForCronjob(jobId).map((run) => run.id);

  it("a cronjob target starts a webhook run, and the run and the row name each other", async () => {
    const o = await office({ fakeBackend: parkingBackend() });
    const job = await cronjobTarget(o);
    const res = await deliver(o, { body: prOpened(42) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });

    const [row] = await rows(o);
    expect(row.outcome).toBe("dispatched");
    expect(row.target?.kind).toBe("cronjob");
    const runId =
      row.target?.kind === "cronjob" ? (row.target.runId ?? "") : "";
    const run = o.srv.cronjobManager.findRun(job.id, runId);
    expect(run).toMatchObject({
      trigger: "webhook",
      webhook: {
        webhookId: o.hook.id,
        webhookName: NAME,
        deliveryRowId: row.id,
      },
    });
    // The prompt, a blank line, and the block with the rendered args.
    const [prompt, blank, ...block] = run!.promptSnapshot.split("\n");
    expect(prompt).toBe(job.prompt);
    expect(blank).toBe("");
    expect(block.at(-1)).toBe("</webhook-data>");
    expect(JSON.parse(block.at(-2)!)).toEqual({ pr: "42" });
    await waitUntil(
      () =>
        o.srv.fakeBackend.sessions.some((s) =>
          s.sent.some((m) => m.text === run!.promptSnapshot),
        ),
      3000,
      "run prompt sent",
    );
    // No agent got a message.
    await expectMessages(o, 0);
  });

  it("a deleted cronjob gives target_unavailable and starts no run", async () => {
    const o = await office({ fakeBackend: parkingBackend() });
    const job = await cronjobTarget(o);
    expect(o.srv.cronjobManager.deleteCronjob(job.id)).toBe(true);
    const res = await deliver(o);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "target_unavailable" });
    const [row] = await rows(o);
    expect(row).toMatchObject({
      outcome: "target_unavailable",
      target: { kind: "cronjob", cronjobId: job.id },
    });
    expect(row.detail).toBeTruthy();
    expect(o.srv.cronjobManager.getRunsForCronjob(job.id)).toEqual([]);
  });

  it("a hook owner who no longer owns the cronjob starts no run; the row retries once they do", async () => {
    const o = await office({ fakeBackend: parkingBackend() });
    const job = await cronjobTarget(o);
    // The live record: the cronjob passes to another member.
    job.userId = "someone-else";
    const res = await deliver(o, { body: prOpened(5) });
    expect(res.status).toBe(503);
    expect((await rows(o))[0]).toMatchObject({
      outcome: "target_unavailable",
      target: { kind: "cronjob", cronjobId: job.id },
    });
    expect(runIds(o, job.id)).toEqual([]);
    job.userId = o.aliceId;
    expect((await deliver(o, { body: prOpened(5) })).status).toBe(202);
    const [row] = await rows(o);
    expect(row).toMatchObject({ outcome: "dispatched", attempts: 2 });
    expect(runIds(o, job.id)).toEqual([
      row.target?.kind === "cronjob" ? (row.target.runId ?? "") : "",
    ]);
  });

  it("an office owner's hook runs a member's cronjob", async () => {
    const o = await office({ fakeBackend: parkingBackend() });
    const job = await cronjobTarget(o);
    // Boss did not make the cronjob; Boss's own hook targets it.
    const made = await o.srv.http("/api/webhooks", {
      method: "POST",
      rawSessionId: o.bossSession,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "boss-hook",
        scheme: "github-hmac-sha256",
        rules: RULES,
        target: { kind: "cronjob", cronjobId: job.id },
      }),
    });
    expect(made.status).toBe(201);
    const bossHook = (await made.json()) as WebhookWire;
    expect(bossHook.userId).not.toBe(job.userId);
    const secretRes = await o.srv.http(`/api/webhooks/${bossHook.id}/secret`, {
      rawSessionId: o.bossSession,
    });
    const { secret } = (await secretRes.json()) as { secret: string };
    const res = await deliver({ ...o, hook: bossHook, secret });
    expect(res.status).toBe(202);
    expect(runIds(o, job.id)).toHaveLength(1);
  });

  it("the dispatch limit answers 429 dispatch_limited, and the row retries after the minute", async () => {
    const o = await office();
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      expect((await deliver(o, { body: prOpened(100 + i) })).status).toBe(202);
    }
    const limited = await deliver(o, { body: prOpened(999) });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "dispatch_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );
    expect((await rows(o))[0]).toMatchObject({
      outcome: "dispatch_limited",
      ruleIndex: 0,
    });
    clock += 61_000;
    expect((await deliver(o, { body: prOpened(999) })).status).toBe(202);
    const log = await rows(o);
    expect(log).toHaveLength(APP_MESSAGE_BURST_LIMIT + 1);
    expect(log[0]).toMatchObject({ outcome: "dispatched", attempts: 2 });
    await expectMessages(o, APP_MESSAGE_BURST_LIMIT + 1);
  });
});

describe("POST /hooks/:id: the dedup window", () => {
  it("a restart keeps the index, and a crash's pending row becomes retryable", async () => {
    const o = await office();
    expect((await deliver(o, { body: prOpened(1) })).status).toBe(202);
    expect((await deliver(o, { body: prOpened(2) })).status).toBe(202);
    // A crash between the claim and the outcome: the second row on disk is
    // still pending.
    const file = join(STATE_ROOT, "webhooks", o.hook.id, "deliveries.json");
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as WebhookDelivery[];
    onDisk[1] = { ...onDisk[1], outcome: "pending" };
    writeFileSync(file, JSON.stringify(onDisk));

    const srv = await o.srv.restart();
    server = srv;
    const o2 = { ...o, srv };
    const [crashed, kept] = await rows(o2);
    expect(kept).toMatchObject({ outcome: "dispatched" });
    expect(crashed).toMatchObject({ outcome: "target_unavailable" });
    expect(crashed.detail).toEqual(expect.any(String));

    expect((await deliver(o2, { body: prOpened(1) })).status).toBe(200);
    expect((await deliver(o2, { body: prOpened(2) })).status).toBe(202);
    const log = await rows(o2);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ outcome: "dispatched", attempts: 2 });
    expect(log[1]).toMatchObject({ outcome: "dispatched", duplicates: 1 });
  });

  it("the same body after 25 hours gets a new row and dispatches", async () => {
    const o = await office();
    expect((await deliver(o, { body: prOpened(1) })).status).toBe(202);
    clock += 23 * 60 * 60 * 1000;
    expect((await deliver(o, { body: prOpened(1) })).status).toBe(200);
    expectWindowInvariant(await rows(o));
    clock += 2 * 60 * 60 * 1000;
    expect((await deliver(o, { body: prOpened(1) })).status).toBe(202);
    const log = await rows(o);
    expect(log).toHaveLength(2);
    expect(log.map((r) => r.bodyHash)).toEqual([
      log[1].bodyHash,
      log[1].bodyHash,
    ]);
    expectWindowInvariant(log);
    await expectMessages(o, 2);
  });

  it("with 501 bodies sent in turn, the first body sent again gets a new row", async () => {
    const o = await office();
    const n = WEBHOOK_DELIVERY_LOG_MAX + 1;
    for (let i = 0; i < n; i++) {
      clock += TOKEN_MS;
      expect((await deliver(o, { body: prClosed(i) })).status).toBe(200);
    }
    clock += TOKEN_MS;
    expect((await deliver(o, { body: prClosed(0) })).status).toBe(200);
    // Still in the window: a copy of the second body adds no row.
    clock += TOKEN_MS;
    expect((await deliver(o, { body: prClosed(n - 1) })).status).toBe(200);
    const log = await rows(o);
    expect(log).toHaveLength(WEBHOOK_DELIVERY_LOG_MAX);
    expect(log[0].duplicates).toBe(0);
    expect(log[1].duplicates).toBe(1);
    expect(log.filter((r) => r.bodyHash === log[0].bodyHash)).toHaveLength(1);
    expectWindowInvariant(log);
    // About 500 sequential requests, each with one log write.
  }, 60_000);
});

// A chunked POST whose first chunk goes now and whose rest goes on finish().
function heldChunkedPost(o: Office, body: Uint8Array, signature: string) {
  let out = "";
  let resolveStatus!: (status: number) => void;
  const status = new Promise<number>((r) => {
    resolveStatus = r;
  });
  const done = () =>
    resolveStatus(Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0));
  const socket = connect(o.srv.port, "127.0.0.1", () => {
    socket.write(
      [
        `POST /hooks/${o.hook.id} HTTP/1.1`,
        `Host: 127.0.0.1:${o.srv.port}`,
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "X-GitHub-Event: pull_request",
        `X-Hub-Signature-256: ${signature}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    const head = body.subarray(0, 5);
    socket.write(`${head.byteLength.toString(16)}\r\n`);
    socket.write(head);
    socket.write("\r\n");
  });
  socket.on("data", (d) => {
    out += d.toString("latin1");
  });
  socket.on("end", done);
  socket.on("close", done);
  return {
    finish(): Promise<number> {
      const rest = body.subarray(5);
      socket.write(`${rest.byteLength.toString(16)}\r\n`);
      socket.write(rest);
      socket.write("\r\n0\r\n\r\n");
      return status;
    },
  };
}

describe("POST /hooks/:id: changes during the awaits", () => {
  it("a hook deleted while its body streams answers 404 and is not recreated", async () => {
    const o = await office();
    // The server runs in this process: once stage 1 has looked the hook up,
    // the request is waiting for the rest of its body.
    const get = spyOn(webhookRegistry, "get");
    const lookups = () => get.mock.calls.filter(([id]) => id === o.hook.id);
    try {
      const body = new TextEncoder().encode(prOpened(1));
      const post = heldChunkedPost(o, body, sign(o.secret, body));
      await waitUntil(() => lookups().length >= 1, 3000, "stage 1 ran");
      const del = await o.srv.http(`/api/webhooks/${o.hook.id}`, {
        method: "DELETE",
        rawSessionId: o.aliceSession,
      });
      expect(del.status).toBe(204);
      expect(existsSync(join(STATE_ROOT, "webhooks", o.hook.id))).toBe(false);
      expect(await post.finish()).toBe(404);
    } finally {
      get.mockRestore();
    }
    expect(existsSync(join(STATE_ROOT, "webhooks", o.hook.id))).toBe(false);
    await expectMessages(o, 0);
  });

  it("room access removed during prepareEnqueue: 503 and no message; with no change: 202", async () => {
    const o = await office();
    const manager = o.srv.agentManager;
    const original = manager.prepareEnqueue;
    let gate = Promise.resolve();
    let release = () => {};
    let entered = () => {};
    const hold = () => {
      gate = new Promise<void>((r) => {
        release = r;
      });
      return new Promise<void>((r) => {
        entered = r;
      });
    };
    manager.prepareEnqueue = async (id: string) => {
      await original(id);
      entered();
      await gate;
    };
    try {
      // The control: held, released with no change, dispatched.
      let started = hold();
      const control = deliver(o, { body: prOpened(90) });
      await started;
      release();
      expect((await control).status).toBe(202);

      started = hold();
      const revoked = deliver(o, { body: prOpened(91) });
      await started;
      setReach(o, []);
      expect(getUserByName("Alice")!.allowedRooms).toEqual([]);
      release();
      const res = await revoked;
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "target_unavailable" });
    } finally {
      release();
      manager.prepareEnqueue = original;
    }
    expect((await rows(o))[0].outcome).toBe("target_unavailable");
    await expectMessages(o, 1);
  });
});

describe("POST /hooks/:id: the boundary", () => {
  it("does not depend on forwarding headers", async () => {
    const o = await office();
    const res = await deliver(o, {
      headers: {
        "X-Forwarded-For": "203.0.113.9",
        "X-Forwarded-Host": "evil.example",
        "X-Forwarded-Proto": "http",
        Forwarded: "for=203.0.113.9;host=evil.example;proto=http",
        Origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(202);
    expect((await rows(o))[0].outcome).toBe("dispatched");
  });

  it("an app hostname never reaches the handler", async () => {
    let tracked: TestServer | null = null;
    const { srv, label, token } = await anOfficeWithAnApp((s) => {
      tracked = s;
      server = s;
    });
    expect(tracked).not.toBeNull();
    // An agent's hook with its default target: the agent itself.
    const made = await srv.http("/api/webhooks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: NAME,
        scheme: "github-hmac-sha256",
        rules: [{ event: "*" }],
      }),
    });
    expect(made.status).toBe(201);
    const hook = (await made.json()) as WebhookWire;
    const secret = webhookRegistry.readSecret(hook.id)!;
    const headers = {
      "Content-Length": "0",
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": sign(secret, new Uint8Array(0)),
    };
    const onApp = await raw(srv.port, {
      host: appHost(label),
      path: `/hooks/${hook.id}`,
      method: "POST",
      headers,
    });
    expect(onApp.status).not.toBe(400);
    expect(onApp.body).not.toContain("bad_payload");
    expect(webhookRegistry.readDeliveries(hook.id, 10)).toEqual([]);
    // The control: the office host reaches the handler, which verifies the
    // empty body and logs it as a bad payload.
    const onOffice = await raw(srv.port, {
      host: OFFICE_HOST,
      path: `/hooks/${hook.id}`,
      method: "POST",
      headers,
    });
    expect(onOffice.status).toBe(400);
    expect(JSON.parse(onOffice.body)).toEqual({ error: "bad_payload" });
    expect(
      webhookRegistry.readDeliveries(hook.id, 10).map((r) => r.outcome),
    ).toEqual(["bad_payload"]);
  });

  it("a deleted hook answers 404 and its log is not recreated", async () => {
    const o = await office();
    expect((await deliver(o)).status).toBe(202);
    const del = await o.srv.http(`/api/webhooks/${o.hook.id}`, {
      method: "DELETE",
      rawSessionId: o.aliceSession,
    });
    expect(del.status).toBe(204);
    expect((await deliver(o, { body: prOpened(8) })).status).toBe(404);
    expect(existsSync(join(STATE_ROOT, "webhooks", o.hook.id))).toBe(false);
  });
});
