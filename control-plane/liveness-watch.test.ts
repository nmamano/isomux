// Strikes, and the claim that stops two probers counting the same outage twice.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LIVENESS_CLAIM_MS,
  LIVENESS_INTERVAL_MS,
  type ControlResult,
  type Rung,
} from "./liveness.ts";
import { LIVENESS_REASON, watchLiveness } from "./liveness-watch.ts";
import { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

const temps: string[] = [];

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Bed {
  store: Store;
  instanceId: string;
  now: { value: number };
  /** One pass with a scripted probe outcome. The control probe passes unless
   * the pass is given one. */
  pass(rung: Rung, holder?: string, opts?: PassOptions): Promise<number>;
  reasons(): Promise<string[]>;
}

interface PassOptions {
  control?: () => Promise<ControlResult>;
  report?: (line: string) => void;
}

const CONTROL_UP = async (): Promise<ControlResult> => ({
  ok: true,
  detail: "control reachable",
});

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
    pass: async (rung, holder = "prober-a", opts = {}) =>
      await watchLiveness(store, {
        holder,
        // Never the default: it would reach the real network from a test.
        control: opts.control ?? CONTROL_UP,
        report: opts.report,
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

// A failed reading while the prober cannot reach the outside world either is
// the prober's outage, not the office's (2026-10-18: the VPS lost its network
// for six minutes and every live office was raised). Such a reading takes no
// strike and moves no attention; the next check is still put off by the normal
// interval, so an outage does not turn into a probe storm.
describe("a prober outage is not the office's failure", () => {
  const OUTAGE_DETAIL = "one.one.one.one: timed out; dns.google: timed out";

  function controlDown() {
    const calls = { n: 0 };
    const control = async (): Promise<ControlResult> => {
      calls.n++;
      return { ok: false, detail: OUTAGE_DETAIL };
    };
    return { calls, control };
  }

  test("no strike and no raise; the last real reading and the strike count stay, the next check moves on", async () => {
    const b = await bed();
    const down = controlDown();

    // First-ever reading during an outage: nothing to keep but the empty row.
    await b.pass("dns", "prober-a", { control: down.control });
    expect(down.calls.n).toBe(1);
    let row = (await b.store.getLiveness("inst-1"))!;
    expect(row.strikes).toBe(0);
    expect(row.checked_at).toBeNull();

    // One real failure, then a long outage.
    b.now.value += LIVENESS_INTERVAL_MS;
    await b.pass("tcp");
    const real = (await b.store.getLiveness("inst-1"))!;
    expect(real.strikes).toBe(1);
    expect(real.rung).toBe("tcp");

    for (let i = 0; i < 5; i++) {
      b.now.value += LIVENESS_INTERVAL_MS;
      expect(await b.pass("dns", "prober-a", { control: down.control })).toBe(
        1,
      );
      row = (await b.store.getLiveness("inst-1"))!;
      expect(row.strikes).toBe(1);
      expect(row.rung).toBe("tcp");
      expect(row.checked_at).toBe(real.checked_at);
      expect(row.next_check_at).toBe(b.now.value + LIVENESS_INTERVAL_MS);
      expect(row.claim_holder).toBeNull();
      expect(row.claim_until).toBeNull();
      expect(await b.reasons()).toEqual([]);
    }
    expect(down.calls.n).toBe(6);
  });

  test("an outage neither resets nor adds strikes: the next real failure is still the third", async () => {
    const b = await bed();
    const down = controlDown();
    for (let i = 0; i < 2; i++) {
      await b.pass("tls");
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    await b.pass("dns", "prober-a", { control: down.control });
    expect(down.calls.n).toBe(1);
    expect(await b.reasons()).toEqual([]);
    b.now.value += LIVENESS_INTERVAL_MS;
    await b.pass("tls");
    expect(await b.reasons()).toEqual(["critical"]);
  });

  test("a control probe that throws counts as an outage, not as a reachable network", async () => {
    // We cannot tell the network is fine, so the office gets no strike.
    const b = await bed();
    let calls = 0;
    const control = async (): Promise<ControlResult> => {
      calls++;
      throw new Error("control crashed");
    };
    for (let i = 0; i < 3; i++) {
      await b.pass("tcp", "prober-a", { control });
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    expect(calls).toBe(3);
    expect((await b.store.getLiveness("inst-1"))!.strikes).toBe(0);
    expect(await b.reasons()).toEqual([]);
  });

  test("an open raise stays open through an outage, and only a real ok clears it, without a control probe", async () => {
    const b = await bed();
    const down = controlDown();
    for (let i = 0; i < 3; i++) {
      await b.pass("tcp");
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    expect(await b.reasons()).toEqual(["critical"]);
    for (let i = 0; i < 2; i++) {
      await b.pass("dns", "prober-a", { control: down.control });
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    expect(down.calls.n).toBe(2);
    expect(await b.reasons()).toEqual(["critical"]);
    expect((await b.store.getInstance("inst-1"))!.attention_state).toBe(
      "needs_operator",
    );
    // An ok reading needs no control: it is never gated.
    await b.pass("ok", "prober-a", { control: down.control });
    expect(down.calls.n).toBe(2);
    expect(await b.reasons()).toEqual([]);
  });

  test("the outage is reported per office, with the control's own detail", async () => {
    const b = await bed();
    const lines: string[] = [];
    await b.pass("dns", "prober-a", {
      control: controlDown().control,
      report: (line) => lines.push(line),
    });
    expect(
      lines.filter(
        (l) => l.includes("cp1.test.isomux.app") && l.includes(OUTAGE_DETAIL),
      ),
    ).toHaveLength(1);
  });

  test("a prober that lost its claim during the outage does not release the winner's claim", async () => {
    const b = await bed();
    // While prober-a waits on the control, its claim expires and prober-b
    // takes the row. prober-a's deferral is fenced out like a reading would be.
    const control = async (): Promise<ControlResult> => {
      b.now.value += LIVENESS_CLAIM_MS + 1_000;
      const taken = await b.store.claimLiveness(
        "inst-1",
        "prober-b",
        b.now.value + LIVENESS_CLAIM_MS,
        b.now.value,
      );
      expect(taken).not.toBeNull();
      return { ok: false, detail: OUTAGE_DETAIL };
    };
    await b.pass("dns", "prober-a", { control });
    const row = (await b.store.getLiveness("inst-1"))!;
    expect(row.claim_holder).toBe("prober-b");
    expect(row.claim_until).toBe(b.now.value + LIVENESS_CLAIM_MS);
  });
});
