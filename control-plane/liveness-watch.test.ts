// Strikes, and the claim that stops two probers counting the same outage twice.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LIVENESS_CLAIM_MS,
  LIVENESS_INTERVAL_MS,
  type Rung,
} from "./liveness.ts";
import { LIVENESS_REASON, watchLiveness } from "./liveness-watch.ts";
import { Store } from "./store.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";

const temps: string[] = [];

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Bed {
  store: Store;
  instanceId: string;
  now: { value: number };
  /** One pass with a scripted probe outcome. */
  pass(rung: Rung, holder?: string): Promise<number>;
  reasons(): Promise<string[]>;
}

async function bed(): Promise<Bed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-liveness-"));
  temps.push(dir);
  const now = { value: 1_000_000 };
  const store = await openTestStore(() => now.value);
  await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "live",
    access_window_expires_at: now.value + 1_000_000,
  });
  await store.createAsset({
    id: "asset-1",
    instance_id: "inst-1",
    provider: "contabo",
    provider_id: "203474835",
    intent_id: null,
    asset_state: "active",
    ipv4: "169.58.97.2",
    service_ends_at: null,
    host_key_fingerprint: null,
    next_reconcile_at: now.value,
  });
  return {
    store,
    instanceId: "inst-1",
    now,
    pass: async (rung, holder = "prober-a") =>
      await watchLiveness(store, {
        holder,
        // The ladder itself is tested in liveness.test.ts; here the probe is
        // scripted so the COUNTING is what is under test.
        lookup: async () =>
          rung === "dns" ? Promise.reject(new Error("nx")) : "169.58.97.2",
        connect: async () => {
          if (rung === "tcp") throw new Error("refused");
        },
        fetchImpl: async () => {
          if (rung === "tls") throw new Error("tls");
          return new Response("", { status: rung === "ok" ? 200 : 503 });
        },
      }),
    reasons: async () =>
      (await store.openReasons("inst-1"))
        .filter((r) => r.reason === LIVENESS_REASON)
        .map((r) => r.severity),
  };
}

describe("strikes are consecutive", () => {
  test("failures accumulate and an ok resets them", async () => {
    const b = await bed();
    for (const expected of [1, 2]) {
      await b.pass("tcp");
      expect((await b.store.getLiveness("inst-1"))!.strikes).toBe(expected);
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    await b.pass("ok");
    expect((await b.store.getLiveness("inst-1"))!.strikes).toBe(0);
    expect((await b.store.getLiveness("inst-1"))!.rung).toBe("ok");
  });

  test("a probe is not repeated before it is due", async () => {
    const b = await bed();
    expect(await b.pass("tcp")).toBe(1);
    // No clock movement: the claim's due test is in the UPDATE, so a second
    // pass in the same instant does nothing at all.
    expect(await b.pass("tcp")).toBe(0);
    expect((await b.store.getLiveness("inst-1"))!.strikes).toBe(1);
  });

  test("a crashed prober's claim is not adoptable until it expires", async () => {
    // The claim is what a second prober runs into, and it has to HOLD for its
    // full five minutes rather than merely existing: a prober that dies at the
    // remote seam leaves the row claimed, and adopting it early is how the same
    // office gets probed twice and one outage becomes two strikes.
    // The DURATION is pinned as a literal, not as the symbol the code uses.
    // Deriving the boundaries below from LIVENESS_CLAIM_MS alone made this test
    // pass for free when the constant was shortened to a second - the test moved
    // with the value it was supposed to be guarding. A mutation run is what
    // showed it.
    expect(LIVENESS_CLAIM_MS).toBe(5 * 60_000);

    const b = await bed();
    const now = b.now.value;
    await b.store.ensureLiveness("inst-1", now);
    const claimed = await b.store.claimLiveness(
      "inst-1",
      "prober-that-dies",
      now + LIVENESS_CLAIM_MS,
      now,
    );
    expect(claimed).not.toBeNull();

    // One second before the claim expires: still refused, however due the row.
    b.now.value = now + LIVENESS_CLAIM_MS - 1_000;
    expect(
      await b.store.claimLiveness(
        "inst-1",
        "prober-b",
        b.now.value + 1_000,
        b.now.value,
      ),
    ).toBeNull();
    expect(await b.pass("tcp", "prober-b")).toBe(0);

    // One second after: adoptable, so a dead holder cannot stall the ladder.
    b.now.value = now + LIVENESS_CLAIM_MS + 1_000;
    expect(
      await b.store.claimLiveness(
        "inst-1",
        "prober-b",
        b.now.value + 1_000,
        b.now.value,
      ),
    ).not.toBeNull();
  });

  test("a second prober cannot double-count one outage", async () => {
    const b = await bed();
    await b.pass("tcp", "prober-a");
    b.now.value += LIVENESS_INTERVAL_MS;
    // Two provisioners, same due row, same instant. The claim is taken by the
    // statement that tests due-ness, so exactly one of them probes.
    const [first, second] = await Promise.all([
      b.pass("tcp", "prober-a"),
      b.pass("tcp", "prober-b"),
    ]);
    expect(first + second).toBe(1);
    expect((await b.store.getLiveness("inst-1"))!.strikes).toBe(2);
  });
});

describe("three strikes gets a person", () => {
  test("raised on the third, and not before", async () => {
    const b = await bed();
    for (let i = 0; i < 2; i++) {
      await b.pass("tls");
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    expect(await b.reasons()).toEqual([]);
    await b.pass("tls");
    expect(await b.reasons()).toEqual(["critical"]);
    expect((await b.store.getInstance("inst-1"))!.attention_state).toBe(
      "needs_operator",
    );
  });

  test("raised once, not once per failed check", async () => {
    const b = await bed();
    for (let i = 0; i < 5; i++) {
      await b.pass("tcp");
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    expect(await b.reasons()).toEqual(["critical"]);
  });

  test("cleared only by a probe that actually succeeds", async () => {
    const b = await bed();
    for (let i = 0; i < 3; i++) {
      await b.pass("tcp");
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    expect(await b.reasons()).toEqual(["critical"]);
    // A DIFFERENT failure is not a recovery. An office failing dns, then tls,
    // then tcp would otherwise look like it keeps getting better.
    await b.pass("tls");
    b.now.value += LIVENESS_INTERVAL_MS;
    expect(await b.reasons()).toEqual(["critical"]);
    await b.pass("ok");
    expect(await b.reasons()).toEqual([]);
    expect((await b.store.getInstance("inst-1"))!.attention_state).toBe(
      "clear",
    );
  });
});

test("only live offices are probed", async () => {
  const b = await bed();
  const inst = (await b.store.getInstance("inst-1"))!;
  await b.store.casInstance(inst.id, inst.version, {
    service_state: "provisioning",
  });
  // An office still being built has verify_https walking the same ladder with
  // its own deadlines; probing it here would raise attention for a box that is
  // progressing normally.
  expect(await b.pass("tcp")).toBe(0);
  expect(await b.store.getLiveness("inst-1")).toBeNull();
});
