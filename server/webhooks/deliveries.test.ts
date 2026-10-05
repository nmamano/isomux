// The delivery store on its own: the claim states, the window, the trim, the
// boot conversion and the write-failure rules. See
// internal-docs/webhooks-design.md sections 5 and 6. The HTTP behavior is in
// server/test-support/webhooks-ingress.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  WEBHOOK_DEDUP_WINDOW_MS,
  WEBHOOK_RESTART_DETAIL,
  createWebhookDeliveryStore,
  type ClaimResult,
  type SettlePatch,
} from "./deliveries.ts";
import { WEBHOOK_DELIVERY_LOG_MAX } from "./registry.ts";
import { atomicWriteFileSync } from "../persistence.ts";
import type { WebhookDelivery } from "../../shared/types.ts";

const HOOK = "wh_0123456789abcdef";
let dir: string;
let t: number;
const now = () => t;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webhook-deliveries-"));
  t = 1_800_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const input = (hash: string) => ({
  bodyHash: `sha256:${hash}`,
  bodySize: 10,
  event: "pull_request",
  deliveryId: "d-1",
});

const onDisk = (): WebhookDelivery[] =>
  JSON.parse(readFileSync(join(dir, HOOK, "deliveries.json"), "utf-8"));

const final = (
  outcome: SettlePatch["outcome"],
  status: number,
): SettlePatch => ({
  outcome,
  status,
  ruleIndex: null,
  args: null,
  target: null,
  detail: null,
});

function claimed(result: ClaimResult) {
  if (result.kind === "duplicate") throw new Error("expected a claim");
  return result;
}

describe("webhook delivery store", () => {
  it("a new body gets a pending row on disk; a copy adds a duplicate, not a row", () => {
    const store = createWebhookDeliveryStore({ dir, now });
    const first = claimed(store.claim(HOOK, input("a")));
    expect(first.kind).toBe("new");
    expect(onDisk()).toEqual([first.row]);
    expect(first.row).toMatchObject({ outcome: "pending", attempts: 1 });

    // In flight: a copy does no work.
    t += 1000;
    const copy = store.claim(HOOK, input("a"));
    expect(copy.kind).toBe("duplicate");
    expect(store.settle(first.log, first.row.id, final("no_match", 200))).toBe(
      true,
    );
    // Final: a copy does no work either.
    expect(store.claim(HOOK, input("a")).kind).toBe("duplicate");
    const rows = onDisk();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "no_match",
      duplicates: 2,
      lastSeenAt: t,
    });
  });

  it("two claims started in the same tick make one row", async () => {
    // The claim is one synchronous step, so even a microtask between the
    // lookup and the append (which the HTTP test cannot interleave) would let
    // both callers miss and append.
    const store = createWebhookDeliveryStore({ dir, now });
    const results = await Promise.all(
      [1, 2].map(() =>
        Promise.resolve().then(() => store.claim(HOOK, input("a"))),
      ),
    );
    expect(results.map((r) => r.kind).sort()).toEqual(["duplicate", "new"]);
    expect(onDisk()).toHaveLength(1);
  });

  it("a retryable row goes back to pending with one more attempt", () => {
    const store = createWebhookDeliveryStore({ dir, now });
    const first = claimed(store.claim(HOOK, input("a")));
    store.settle(first.log, first.row.id, final("target_unavailable", 503));
    const retry = claimed(store.claim(HOOK, input("a")));
    expect(retry.kind).toBe("retry");
    expect(retry.row).toMatchObject({ outcome: "pending", attempts: 2 });
    expect(retry.kind === "retry" && retry.previous.outcome).toBe(
      "target_unavailable",
    );
    expect(onDisk()).toHaveLength(1);
  });

  it("a body whose row is older than the window gets a new row", () => {
    const store = createWebhookDeliveryStore({ dir, now });
    const first = claimed(store.claim(HOOK, input("a")));
    store.settle(first.log, first.row.id, final("no_match", 200));
    t += WEBHOOK_DEDUP_WINDOW_MS - 1;
    expect(store.claim(HOOK, input("a")).kind).toBe("duplicate");
    t += 1;
    const again = claimed(store.claim(HOOK, input("a")));
    expect(again.kind).toBe("new");
    // The new row is now the window's row for that body.
    expect(store.claim(HOOK, input("a")).kind).toBe("duplicate");
    const rows = onDisk();
    expect(rows).toHaveLength(2);
    expect(rows[1].duplicates).toBe(1);
  });

  it("trims to the row limit, and a trimmed body is new again", () => {
    // Design section 6 and ruling 8.
    expect(WEBHOOK_DELIVERY_LOG_MAX).toBe(500);
    // A full log is seeded in one write: filling it through the store costs
    // a whole-file write per claim and per settle, seconds in total.
    const seed = createWebhookDeliveryStore({ dir, now });
    const first = claimed(seed.claim(HOOK, input("b0")));
    seed.settle(first.log, first.row.id, final("no_match", 200));
    const [template] = onDisk();
    const full = Array.from({ length: WEBHOOK_DELIVERY_LOG_MAX }, (_, i) => ({
      ...template,
      id: `d_${i}`,
      bodyHash: `sha256:b${i}`,
    }));
    writeFileSync(join(dir, HOOK, "deliveries.json"), JSON.stringify(full));

    const store = createWebhookDeliveryStore({ dir, now });
    const last = claimed(
      store.claim(HOOK, input(`b${WEBHOOK_DELIVERY_LOG_MAX}`)),
    );
    store.settle(last.log, last.row.id, final("no_match", 200));
    const rows = onDisk();
    expect(rows).toHaveLength(WEBHOOK_DELIVERY_LOG_MAX);
    expect(rows[0].bodyHash).toBe("sha256:b1");
    expect(store.claim(HOOK, input("b0")).kind).toBe("new");
    expect(store.claim(HOOK, input("b2")).kind).toBe("duplicate");
  });

  it("at load, a pending row becomes retryable and the window survives", () => {
    const first = createWebhookDeliveryStore({ dir, now });
    const kept = claimed(first.claim(HOOK, input("kept")));
    first.settle(kept.log, kept.row.id, final("no_match", 200));
    first.claim(HOOK, input("crashed"));

    const second = createWebhookDeliveryStore({ dir, now });
    second.recover([HOOK]);
    const rows = onDisk();
    expect(rows[1]).toMatchObject({
      outcome: "target_unavailable",
      detail: WEBHOOK_RESTART_DETAIL,
    });
    expect(second.claim(HOOK, input("kept")).kind).toBe("duplicate");
    expect(second.claim(HOOK, input("crashed")).kind).toBe("retry");
  });

  it("a failed claim write changes nothing and throws", () => {
    let fail = false;
    const store = createWebhookDeliveryStore({
      dir,
      now,
      writeFile: (path, data) => {
        if (fail) throw new Error("disk full");
        atomicWriteFileSync(path, data);
      },
    });
    const first = claimed(store.claim(HOOK, input("a")));
    store.settle(first.log, first.row.id, final("no_match", 200));
    fail = true;
    expect(() => store.claim(HOOK, input("b"))).toThrow();
    expect(() => store.claim(HOOK, input("a"))).toThrow();
    fail = false;
    expect(store.claim(HOOK, input("b")).kind).toBe("new");
    const rows = onDisk();
    expect(rows).toHaveLength(2);
    expect(rows[0].duplicates).toBe(0);
  });

  it("a failed settle write keeps the outcome in memory and reports false", () => {
    let fail = false;
    const store = createWebhookDeliveryStore({
      dir,
      now,
      writeFile: (path, data) => {
        if (fail) throw new Error("disk full");
        atomicWriteFileSync(path, data);
      },
    });
    const first = claimed(store.claim(HOOK, input("a")));
    fail = true;
    expect(
      store.settle(first.log, first.row.id, final("dispatched", 202)),
    ).toBe(false);
    expect(onDisk()[0].outcome).toBe("pending");
    fail = false;
    // Memory holds the final outcome, so a copy does not dispatch again.
    expect(store.claim(HOOK, input("a")).kind).toBe("duplicate");
    expect(onDisk()[0]).toMatchObject({ outcome: "dispatched", duplicates: 1 });
  });

  it("a settle after forget does not recreate the hook's directory", () => {
    const store = createWebhookDeliveryStore({ dir, now });
    const first = claimed(store.claim(HOOK, input("a")));
    rmSync(join(dir, HOOK), { recursive: true, force: true });
    store.forget(HOOK);
    expect(store.settle(first.log, first.row.id, final("no_match", 200))).toBe(
      true,
    );
    expect(() => readFileSync(join(dir, HOOK, "deliveries.json"))).toThrow();
  });

  it("a claim after forget throws and writes nothing", () => {
    const store = createWebhookDeliveryStore({ dir, now });
    store.claim(HOOK, input("a"));
    rmSync(join(dir, HOOK), { recursive: true, force: true });
    store.forget(HOOK);
    expect(() => store.claim(HOOK, input("b"))).toThrow();
    expect(() => readFileSync(join(dir, HOOK, "deliveries.json"))).toThrow();
  });

  it("a valid JSON list with one malformed row fails loud and is never overwritten", () => {
    const store = createWebhookDeliveryStore({ dir, now });
    const good = claimed(store.claim(HOOK, input("a"))).row;
    const variants: unknown[] = [
      { ...good, bodyHash: undefined },
      { ...good, receivedAt: "yesterday" },
      { ...good, outcome: "exploded" },
      { ...good, attempts: -1 },
      { ...good, args: { pr: 7 } },
      { ...good, target: { kind: "agent" } },
      { ...good, detail: 5 },
    ];
    for (const bad of variants) {
      const text = JSON.stringify([good, bad]);
      writeFileSync(join(dir, HOOK, "deliveries.json"), text);
      const fresh = createWebhookDeliveryStore({ dir, now });
      expect(() => fresh.claim(HOOK, input("c"))).toThrow();
      expect(readFileSync(join(dir, HOOK, "deliveries.json"), "utf-8")).toBe(
        text,
      );
    }
  });

  it("a corrupt log fails loud and is never overwritten", () => {
    mkdirSync(join(dir, HOOK), { recursive: true });
    writeFileSync(join(dir, HOOK, "deliveries.json"), "{not json");
    const store = createWebhookDeliveryStore({ dir, now });
    store.recover([HOOK]);
    expect(() => store.claim(HOOK, input("a"))).toThrow();
    expect(readFileSync(join(dir, HOOK, "deliveries.json"), "utf-8")).toBe(
      "{not json",
    );
  });
});
