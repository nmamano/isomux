// The ingress handler on its own, with injected deps: the async boundaries
// (a body read and a prepareEnqueue that outlast a change to the hook), the
// daily dispatch cap, a failed log write after a dispatch, and the one
// reading of a signed body. See internal-docs/webhooks-design.md sections 1, 5
// and 6. The route through buildServer is in
// server/test-support/webhooks-ingress.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "crypto";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createWebhookIngress,
  type WebhookIngress,
  type WebhookIngressDeps,
} from "./ingress.ts";
import { createWebhookRegistry, type WebhookRegistry } from "./registry.ts";
import { atomicWriteFileSync } from "../persistence.ts";
import {
  APP_MESSAGE_BURST_WINDOW_MS,
  APP_MESSAGE_BURST_LIMIT,
  APP_MESSAGE_DAILY_CAP,
} from "../app-message-limits.ts";
import { WEBHOOK_DEDUP_WINDOW_MS } from "./deliveries.ts";
import type {
  WebhookDelivery,
  WebhookRecord,
  WebhookRule,
} from "../../shared/types.ts";

const AGENT = "agent-1";
const CRONJOB = "1a2b3c4d";
// Far enough apart that the minute cap never blocks a dispatch.
const SPACING_MS =
  Math.ceil(APP_MESSAGE_BURST_WINDOW_MS / APP_MESSAGE_BURST_LIMIT) + 1;

// About 500 deliveries, each with two log writes.
const CAP_TEST_TIMEOUT_MS = 30_000;

let dir: string;
let t: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webhook-ingress-"));
  t = 1_800_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Rig {
  registry: WebhookRegistry;
  ingress: WebhookIngress;
  hook: WebhookRecord;
  secret: string;
  enqueued: string[];
  // Test switches.
  reach: { value: "ok" | "unavailable" };
  refuse: { code: string | null };
  // Called inside prepareAgent; a test may hold it.
  onPrepare: { fn: () => Promise<void> };
  failWrites: { value: boolean };
  // Called inside enqueueToAgent, after the message is accepted.
  onEnqueue: { fn: () => void };
  // The cronjob target: the dispatch-time check, and each run started.
  runnable: { value: "ok" | "missing" | "forbidden" };
  started: { cronjobId: string; deliveryRowId: string; block: string }[];
  // Replaces startCronjobRun's answer when set.
  onStart: { fn: (() => { runId: string } | null) | null };
}

const PR_RULES: WebhookRule[] = [
  { event: "pull_request", args: { pr: "{{payload.pull_request.number}}" } },
];

function rig(
  target: "agent" | "cronjob" = "agent",
  rules: WebhookRule[] = PR_RULES,
): Rig {
  const registry = createWebhookRegistry({ dir, now: () => t });
  const hook = registry.create({
    fields: {
      name: "pr-review",
      scheme: "github-hmac-sha256",
      signatureHeader: null,
      eventHeader: null,
      deliveryHeader: null,
      rules,
      target:
        target === "agent"
          ? { kind: "agent", agentId: AGENT }
          : { kind: "cronjob", cronjobId: CRONJOB },
      enabled: true,
    },
    userId: "user-1",
    username: "alice",
    createdBy: "alice",
  });
  const r: Omit<Rig, "ingress"> = {
    registry,
    hook,
    secret: registry.readSecret(hook.id)!,
    enqueued: [],
    reach: { value: "ok" },
    refuse: { code: null },
    onPrepare: { fn: async () => {} },
    failWrites: { value: false },
    onEnqueue: { fn: () => {} },
    runnable: { value: "ok" },
    started: [],
    onStart: { fn: null },
  };
  const deps: WebhookIngressDeps = {
    registry,
    dir,
    now: () => t,
    writeFile: (path, data) => {
      if (r.failWrites.value) throw new Error("disk full");
      atomicWriteFileSync(path, data);
    },
    agentReachableByUser: () => r.reach.value,
    prepareAgent: () => r.onPrepare.fn(),
    enqueueToAgent: (_agentId, _sender, text) => {
      if (r.refuse.code !== null) return { ok: false, code: r.refuse.code };
      r.enqueued.push(text);
      r.onEnqueue.fn();
      return { ok: true };
    },
    cronjobRunnableByUser: () => r.runnable.value,
    startCronjobRun: (cronjobId, webhook, block) => {
      if (r.onStart.fn) return r.onStart.fn();
      r.started.push({
        cronjobId,
        deliveryRowId: webhook.deliveryRowId,
        block,
      });
      return { runId: `run-${r.started.length}` };
    },
  };
  return { ...r, ingress: createWebhookIngress(deps) };
}

const encode = (s: string) => new TextEncoder().encode(s);
const prBody = (n: number) =>
  JSON.stringify({ action: "opened", pull_request: { number: n } });
const JSON_TYPE = "application/json";
const FORM_TYPE = "application/x-www-form-urlencoded";
const sign = (secret: string, body: Uint8Array) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function request(
  r: Rig,
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
  signature: string,
  contentType = JSON_TYPE,
): Request {
  return new Request(`http://localhost/hooks/${r.hook.id}`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": contentType,
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": signature,
    },
  });
}

async function deliver(r: Rig, n: number): Promise<Response> {
  const body = encode(prBody(n));
  return r.ingress.handle(request(r, body, sign(r.secret, body)), r.hook.id);
}

// A body that streams its first byte and then waits for release().
function heldBody(bytes: Uint8Array) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pulled!: () => void;
  const reading = new Promise<void>((resolve) => {
    pulled = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    pull() {
      pulled();
    },
  });
  return {
    stream,
    reading,
    release() {
      controller.enqueue(bytes);
      controller.close();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const rows = (r: Rig): WebhookDelivery[] =>
  r.registry.readDeliveries(r.hook.id, 500);

describe("webhook ingress: the body read is an await", () => {
  it("a hook deleted while its body streams answers 404, claims nothing and recreates nothing", async () => {
    const r = rig();
    const bytes = encode(prBody(1));
    const held = heldBody(bytes);
    const answer = r.ingress.handle(
      request(r, held.stream, sign(r.secret, bytes)),
      r.hook.id,
    );
    await held.reading;
    expect(r.registry.remove(r.hook.id)).not.toBeNull();
    r.ingress.forget(r.hook.id);
    expect(existsSync(join(dir, r.hook.id))).toBe(false);
    held.release();
    expect((await answer).status).toBe(404);
    expect(existsSync(join(dir, r.hook.id))).toBe(false);
    expect(r.enqueued).toEqual([]);
  });

  it("a hook disabled while its body streams answers 404 and counts it", async () => {
    const r = rig();
    const bytes = encode(prBody(1));
    const held = heldBody(bytes);
    const answer = r.ingress.handle(
      request(r, held.stream, sign(r.secret, bytes)),
      r.hook.id,
    );
    await held.reading;
    const { id, userId, username, createdBy, createdAt, ...fields } = r.hook;
    void [id, userId, username, createdBy, createdAt];
    r.registry.update(r.hook.id, { ...fields, enabled: false });
    held.release();
    expect((await answer).status).toBe(404);
    expect(r.ingress.counters(r.hook.id).counters.disabled?.count).toBe(1);
    expect(rows(r)).toEqual([]);
    expect(r.enqueued).toEqual([]);
  });

  it("a secret rotated while the body streams is the one checked", async () => {
    const r = rig();
    const bytes = encode(prBody(1));
    const held = heldBody(bytes);
    const answer = r.ingress.handle(
      request(r, held.stream, sign(r.secret, bytes)),
      r.hook.id,
    );
    await held.reading;
    r.registry.rotateSecret(r.hook.id);
    held.release();
    expect((await answer).status).toBe(401);
    expect(rows(r)).toEqual([]);
    expect(r.enqueued).toEqual([]);
  });

  it("the control: a body that streams with no change dispatches", async () => {
    const r = rig();
    const bytes = encode(prBody(1));
    const held = heldBody(bytes);
    const answer = r.ingress.handle(
      request(r, held.stream, sign(r.secret, bytes)),
      r.hook.id,
    );
    await held.reading;
    held.release();
    expect((await answer).status).toBe(202);
    expect(r.enqueued).toHaveLength(1);
  });
});

describe("webhook ingress: prepareEnqueue is an await", () => {
  it("room access removed during prepareEnqueue: no enqueue, target_unavailable", async () => {
    const r = rig();
    const gate = deferred();
    const entered = deferred();
    r.onPrepare.fn = async () => {
      entered.resolve();
      await gate.promise;
    };
    const answer = deliver(r, 1);
    await entered.promise;
    r.reach.value = "unavailable";
    gate.resolve();
    expect((await answer).status).toBe(503);
    expect(r.enqueued).toEqual([]);
    expect(rows(r)[0].outcome).toBe("target_unavailable");
  });

  it("a hook deleted during prepareEnqueue does not enqueue", async () => {
    const r = rig();
    const gate = deferred();
    const entered = deferred();
    r.onPrepare.fn = async () => {
      entered.resolve();
      await gate.promise;
    };
    const answer = deliver(r, 1);
    await entered.promise;
    r.registry.remove(r.hook.id);
    r.ingress.forget(r.hook.id);
    gate.resolve();
    expect((await answer).status).toBe(503);
    expect(r.enqueued).toEqual([]);
    expect(existsSync(join(dir, r.hook.id))).toBe(false);
  });

  it("the control: a held prepareEnqueue with no change dispatches", async () => {
    const r = rig();
    const gate = deferred();
    const entered = deferred();
    r.onPrepare.fn = async () => {
      entered.resolve();
      await gate.promise;
    };
    const answer = deliver(r, 1);
    await entered.promise;
    gate.resolve();
    expect((await answer).status).toBe(202);
    expect(r.enqueued).toHaveLength(1);
  });
});

describe("webhook ingress: the daily dispatch cap", () => {
  // One fill of the rolling day, then the edge. The fill spaces dispatches
  // SPACING_MS apart, so moving the clock past a fill dispatch's 24 hours frees
  // exactly that one slot, with the minute cap empty again.
  it(
    "500 accepted dispatches per rolling day; refusals and failed starts spend no slot, and a send in flight holds one",
    async () => {
      const r = rig();
      const retarget = (target: WebhookRecord["target"]) =>
        r.registry.update(r.hook.id, { ...r.hook, target });
      // A 429 from the day, not the minute: near the edge the day frees a
      // slot within one spacing, while the minute window waits much longer.
      const dayLimited = (res: Response) => {
        expect(res.status).toBe(429);
        expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(
          Math.ceil(SPACING_MS / 1000),
        );
      };
      for (let i = 0; i < APP_MESSAGE_DAILY_CAP; i++) {
        t += SPACING_MS;
        expect((await deliver(r, i)).status).toBe(202);
      }
      t += SPACING_MS;
      const cappedAt = t;
      const capped = await deliver(r, 9999);
      expect(capped.status).toBe(429);
      expect(rows(r)[0].outcome).toBe("dispatch_limited");
      // The day blocks, not the minute.
      const wait = Number(capped.headers.get("retry-after"));
      expect(wait).toBeGreaterThan(60);
      t = cappedAt + wait * 1000 - 2000;
      dayLimited(await deliver(r, 9999));

      // The advice is exact: now the oldest dispatch has left the day, and
      // one slot is free. None of these five spends it.
      t = cappedAt + wait * 1000;
      r.refuse.code = "queue_full";
      expect((await deliver(r, 8001)).status).toBe(503);
      r.refuse.code = null;
      r.onPrepare.fn = async () => {
        throw new Error("usage cap reading failed");
      };
      expect((await deliver(r, 8002)).status).toBe(503);
      r.onPrepare.fn = async () => {};
      retarget({ kind: "cronjob", cronjobId: CRONJOB });
      r.runnable.value = "missing";
      expect((await deliver(r, 8003)).status).toBe(503);
      r.runnable.value = "ok";
      r.onStart.fn = () => null;
      expect((await deliver(r, 8004)).status).toBe(503);
      r.onStart.fn = () => {
        throw new Error("disk full");
      };
      expect((await deliver(r, 8005)).status).toBe(503);
      r.onStart.fn = null;
      retarget({ kind: "agent", agentId: AGENT });
      // The limited row retries on the same row and takes the free slot.
      expect((await deliver(r, 9999)).status).toBe(202);
      expect(rows(r).find((row) => row.attempts === 3)).toMatchObject({
        outcome: "dispatched",
      });
      dayLimited(await deliver(r, 8006));

      // Two more fill dispatches leave the day: two free slots. An agent send
      // in flight holds one, a cronjob run takes the other, and nothing is
      // left, until the held send settles it.
      t += 2 * SPACING_MS;
      const gate = deferred();
      const entered = deferred();
      r.onPrepare.fn = async () => {
        entered.resolve();
        await gate.promise;
      };
      const inFlight = deliver(r, 8101);
      await entered.promise;
      r.onPrepare.fn = async () => {};
      retarget({ kind: "cronjob", cronjobId: CRONJOB });
      expect((await deliver(r, 8102)).status).toBe(202);
      dayLimited(await deliver(r, 8103));
      retarget({ kind: "agent", agentId: AGENT });
      gate.resolve();
      expect((await inFlight).status).toBe(202);
      dayLimited(await deliver(r, 8104));

      // 500 fill sends, the retried row and the held send; one run.
      expect(r.enqueued).toHaveLength(APP_MESSAGE_DAILY_CAP + 2);
      expect(r.started).toHaveLength(1);
    },
    CAP_TEST_TIMEOUT_MS,
  );
});

describe("webhook ingress: a failed log write after the dispatch", () => {
  it("answers 500, and an immediate redelivery is a duplicate with no second enqueue", async () => {
    const r = rig();
    // The enqueue is accepted; the row write after it fails.
    r.onEnqueue.fn = () => {
      r.failWrites.value = true;
    };
    const first = await deliver(r, 1);
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: "internal" });
    expect(rows(r)[0].outcome).toBe("pending");
    r.onEnqueue.fn = () => {};
    r.failWrites.value = false;
    const again = await deliver(r, 1);
    expect(again.status).toBe(200);
    expect(r.enqueued).toHaveLength(1);
    expect(rows(r)).toHaveLength(1);
    expect(rows(r)[0]).toMatchObject({ outcome: "dispatched", duplicates: 1 });
  });
});

describe("webhook ingress: the cronjob target", () => {
  it("starts one run linked to the delivery row, and the row names the run", async () => {
    const r = rig("cronjob");
    const res = await deliver(r, 1);
    expect(res.status).toBe(202);
    const [row] = rows(r);
    expect(row).toMatchObject({
      outcome: "dispatched",
      target: { kind: "cronjob", cronjobId: CRONJOB, runId: "run-1" },
    });
    expect(r.started).toHaveLength(1);
    expect(r.started[0]).toMatchObject({
      cronjobId: CRONJOB,
      deliveryRowId: row.id,
    });
    // The JSON line is the one before the closing tag.
    const lines = r.started[0].block.split("\n");
    expect(lines.at(-1)).toBe("</webhook-data>");
    expect(JSON.parse(lines.at(-2)!)).toEqual({ pr: "1" });
    expect(r.enqueued).toEqual([]);
  });

  it("a cronjob that is missing at dispatch starts no run, and the row retries", async () => {
    const r = rig("cronjob");
    r.runnable.value = "missing";
    expect((await deliver(r, 1)).status).toBe(503);
    expect(r.started).toEqual([]);
    expect(rows(r)[0]).toMatchObject({
      outcome: "target_unavailable",
      target: { kind: "cronjob", cronjobId: CRONJOB },
    });
    expect(rows(r)[0].detail).toBeTruthy();
    // The target comes back: the same body retries on the same row.
    r.runnable.value = "ok";
    expect((await deliver(r, 1)).status).toBe(202);
    expect(rows(r)).toHaveLength(1);
    expect(rows(r)[0]).toMatchObject({ outcome: "dispatched", attempts: 2 });
    expect(r.started).toHaveLength(1);
  });

  it("a cronjob gone at the start, or a start that throws, leaves a retryable row", async () => {
    const r = rig("cronjob");
    r.onStart.fn = () => null;
    expect((await deliver(r, 1)).status).toBe(503);
    expect(rows(r)[0].outcome).toBe("target_unavailable");
    r.onStart.fn = () => {
      throw new Error("disk full");
    };
    t += SPACING_MS;
    expect((await deliver(r, 2)).status).toBe(503);
    expect(rows(r)[0].outcome).toBe("target_unavailable");
  });
});

describe("webhook ingress: one reading of the signed bytes", () => {
  // The signature covers the body, not the Content-Type. A signed JSON body
  // whose string holds '&payload=<object>&' must not read as that object when
  // the same bytes come back with the form type. The genuine form body is in
  // server/test-support/webhooks-ingress.test.ts ("parses the form content
  // type").
  const GATED: WebhookRule[] = [
    {
      event: "pull_request",
      match: { "sender.login": "maintainer" },
      args: { by: "{{payload.sender.login}}" },
    },
    { event: "pull_request", args: { pr: "{{payload.pull_request.number}}" } },
  ];
  const embedded = JSON.stringify({
    pull_request: { number: 666 },
    sender: { login: "maintainer" },
  });
  const smuggling = encode(
    JSON.stringify({
      action: "opened",
      pull_request: {
        number: 1,
        title: `zz&payload=${encodeURIComponent(embedded)}&`,
      },
      sender: { login: "mallory" },
    }),
  );
  // No '&': as form, the body is one field whose value is the encoded text
  // after the first '=', and the body's own closing '"}' completes the object.
  const oneField = encode(
    JSON.stringify({
      action: "opened",
      pull_request: { number: 1 },
      sender: { login: "mallory" },
      note: `=${encodeURIComponent(`${embedded.slice(0, -1)},"x":"`)}`,
    }),
  );
  const send = (r: Rig, body: Uint8Array<ArrayBuffer>, contentType: string) =>
    r.ingress.handle(
      request(r, body, sign(r.secret, body), contentType),
      r.hook.id,
    );

  for (const [name, body] of [
    ["an embedded payload field", smuggling],
    ["one field that is not payload", oneField],
  ] as const) {
    it(`the JSON body sent again as form after the dedup window is bad_payload: ${name}`, async () => {
      const r = rig("agent", GATED);
      expect((await send(r, body, JSON_TYPE)).status).toBe(202);
      expect(rows(r)[0]).toMatchObject({
        outcome: "dispatched",
        ruleIndex: 1,
        args: { pr: "1" },
      });
      t += WEBHOOK_DEDUP_WINDOW_MS + 1;
      const replay = await send(r, body, FORM_TYPE);
      expect(replay.status).toBe(400);
      expect(await replay.json()).toEqual({ error: "bad_payload" });
      expect(rows(r).map((row) => row.outcome)).toEqual([
        "bad_payload",
        "dispatched",
      ]);
      expect(r.enqueued).toHaveLength(1);
    });
  }

  it("a form retry of a target_unavailable JSON row is refused and keeps the row retryable", async () => {
    const r = rig("agent", GATED);
    r.reach.value = "unavailable";
    expect((await send(r, smuggling, JSON_TYPE)).status).toBe(503);
    r.reach.value = "ok";
    t += 60_000;
    const retry = await send(r, smuggling, FORM_TYPE);
    expect(retry.status).toBe(400);
    expect(rows(r)).toHaveLength(1);
    expect(rows(r)[0]).toMatchObject({
      outcome: "target_unavailable",
      attempts: 2,
    });
    expect(r.enqueued).toEqual([]);
    // The row is still a retry, and its JSON reading is the signer's.
    expect((await send(r, smuggling, JSON_TYPE)).status).toBe(202);
    expect(rows(r)[0]).toMatchObject({
      outcome: "dispatched",
      ruleIndex: 1,
      args: { pr: "1" },
    });
  });

  it("a form body with a field besides payload is bad_payload", async () => {
    const r = rig();
    const json = encodeURIComponent(prBody(1));
    for (const form of [`payload=${json}&x=1`, `x=1&payload=${json}`]) {
      const res = await send(r, encode(form), FORM_TYPE);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_payload" });
    }
    expect(rows(r).map((row) => row.outcome)).toEqual([
      "bad_payload",
      "bad_payload",
    ]);
    // The control: the payload field alone dispatches.
    expect((await send(r, encode(`payload=${json}`), FORM_TYPE)).status).toBe(
      202,
    );
    expect(r.enqueued).toHaveLength(1);
  });
});
