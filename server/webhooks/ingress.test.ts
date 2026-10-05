// The ingress handler on its own, with injected deps: the async boundaries
// (a body read and a prepareEnqueue that outlast a change to the hook), the
// daily dispatch cap and a failed log write after a dispatch. See
// internal-docs/webhooks-design.md sections 1, 5 and 6. The route through
// buildServer is in server/test-support/webhooks-ingress.test.ts.

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
import type { WebhookDelivery, WebhookRecord } from "../../shared/types.ts";

const AGENT = "agent-1";
// Far enough apart that the minute cap never blocks a dispatch.
const SPACING_MS =
  Math.ceil(APP_MESSAGE_BURST_WINDOW_MS / APP_MESSAGE_BURST_LIMIT) + 1;

// About 500 deliveries, each with one log write.
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
}

function rig(): Rig {
  const registry = createWebhookRegistry({ dir, now: () => t });
  const hook = registry.create({
    fields: {
      name: "pr-review",
      scheme: "github-hmac-sha256",
      signatureHeader: null,
      eventHeader: null,
      deliveryHeader: null,
      rules: [
        {
          event: "pull_request",
          args: { pr: "{{payload.pull_request.number}}" },
        },
      ],
      target: { kind: "agent", agentId: AGENT },
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
  };
  return { ...r, ingress: createWebhookIngress(deps) };
}

const encode = (s: string) => new TextEncoder().encode(s);
const prBody = (n: number) =>
  JSON.stringify({ action: "opened", pull_request: { number: n } });
const sign = (secret: string, body: Uint8Array) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function request(
  r: Rig,
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
  signature: string,
): Request {
  return new Request(`http://localhost/hooks/${r.hook.id}`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
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
  // `count` accepted dispatches, spaced past the minute cap.
  async function spend(r: Rig, count: number, from = 0): Promise<void> {
    for (let i = 0; i < count; i++) {
      t += SPACING_MS;
      expect((await deliver(r, from + i)).status).toBe(202);
    }
  }

  it(
    "500 accepted dispatches per rolling day; the cap lifts as the day rolls",
    async () => {
      const r = rig();
      await spend(r, APP_MESSAGE_DAILY_CAP);
      t += SPACING_MS;
      const capped = await deliver(r, 9999);
      expect(capped.status).toBe(429);
      const wait = Number(capped.headers.get("retry-after"));
      expect(wait).toBeGreaterThan(60);
      expect(rows(r)[0].outcome).toBe("dispatch_limited");
      // The oldest accepted dispatch leaves the rolling day when the advice
      // says, which is still inside the row's dedup window: the row retries.
      t += wait * 1000 - 2000;
      expect((await deliver(r, 9999)).status).toBe(429);
      t += 2000;
      expect((await deliver(r, 9999)).status).toBe(202);
      expect(rows(r)[0]).toMatchObject({ outcome: "dispatched", attempts: 3 });
      expect(r.enqueued).toHaveLength(APP_MESSAGE_DAILY_CAP + 1);
    },
    CAP_TEST_TIMEOUT_MS,
  );

  it(
    "refused sends spend no daily slot",
    async () => {
      const r = rig();
      r.refuse.code = "queue_full";
      await (async () => {
        for (let i = 0; i < APP_MESSAGE_DAILY_CAP; i++) {
          t += SPACING_MS;
          expect((await deliver(r, i)).status).toBe(503);
        }
      })();
      r.refuse.code = null;
      t += SPACING_MS;
      expect((await deliver(r, 0)).status).toBe(202);
    },
    CAP_TEST_TIMEOUT_MS,
  );

  it(
    "a send in flight holds the last daily slot; its refusal releases it",
    async () => {
      const r = rig();
      await spend(r, APP_MESSAGE_DAILY_CAP - 1);
      const gate = deferred();
      const entered = deferred();
      r.onPrepare.fn = async () => {
        entered.resolve();
        await gate.promise;
      };
      t += SPACING_MS;
      const inFlight = deliver(r, 5000);
      await entered.promise;
      r.onPrepare.fn = async () => {};
      // The last slot is held: another delivery is limited, not dispatched.
      t += SPACING_MS;
      expect((await deliver(r, 5001)).status).toBe(429);
      // The held send is refused, so the slot comes back.
      r.refuse.code = "agent_stopped";
      gate.resolve();
      expect((await inFlight).status).toBe(503);
      r.refuse.code = null;
      t += SPACING_MS;
      expect((await deliver(r, 5001)).status).toBe(202);
      // Now the day is spent.
      t += SPACING_MS;
      expect((await deliver(r, 5002)).status).toBe(429);
      expect(r.enqueued).toHaveLength(APP_MESSAGE_DAILY_CAP);
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
