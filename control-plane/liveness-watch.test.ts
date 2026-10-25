// Strikes, and the claim that stops two probers counting the same outage twice.

import { afterEach, describe, expect, test } from "bun:test";
import {
  LIVENESS_CLAIM_MS,
  LIVENESS_INTERVAL_MS,
  type ControlResult,
  type Rung,
} from "./liveness.ts";
import {
  LIVENESS_REASON,
  type ProberNetwork,
  watchLiveness,
} from "./liveness-watch.ts";
import { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Bed {
  store: Store;
  instanceId: string;
  now: { value: number };
  /** The prober's memory of its own outages, shared by every pass of this bed
   * as cli.ts shares one across the passes of a process. */
  network: ProberNetwork;
  /** One pass with a scripted probe outcome. The control probe passes unless
   * the pass is given one. */
  pass(rung: Rung, holder?: string, opts?: PassOptions): Promise<number>;
  reasons(): Promise<string[]>;
}

interface PassOptions {
  control?: () => Promise<ControlResult>;
  report?: (line: string) => void;
  /** Another prober's memory instead of the bed's. */
  network?: ProberNetwork;
}

const TLS_FAILURE = "handshake reset by peer";

/** PROBER_OUTAGE_HOLD_MS, pinned: three liveness intervals. */
const HOLD_MS = 3 * 60_000;

const CONTROL_UP = async (): Promise<ControlResult> => ({
  ok: true,
  detail: "control reachable",
});

/** The office's provider asset: by default one with a recorded address;
 * `{ ipv4: null }` one whose address is not recorded; `null` no asset row. */
async function bed(
  asset: { ipv4: string | null } | null = { ipv4: "169.58.97.2" },
): Promise<Bed> {
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
  if (asset) {
    await store.createAsset({
      id: "asset-1",
      instance_id: "inst-1",
      provider: "contabo",
      provider_id: "203474835",
      intent_id: null,
      asset_state: "active",
      ipv4: asset.ipv4,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: now.value,
    });
  }
  const network: ProberNetwork = { lastOutageAt: null };
  return {
    store,
    instanceId: "inst-1",
    now,
    network,
    pass: async (rung, holder = "prober-a", opts = {}) =>
      await watchLiveness(store, {
        holder,
        network: opts.network ?? network,
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
          if (rung === "tls") throw new Error(TLS_FAILURE);
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

// The scripted lookup still answers 169.58.97.2 and every rung would pass, as
// it would for a wildcard record that points at another healthy office. With
// no recorded address the office cannot be told apart from that one, so the
// reading fails, counts a strike, and never clears a raise.
test("a live office with no recorded IPv4 fails at wrong-box and does not clear an open raise", async () => {
  for (const asset of [{ ipv4: null }, null]) {
    const b = await bed(asset);
    for (let i = 0; i < 3; i++) {
      await b.pass("tcp");
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    expect({ asset, reasons: await b.reasons() }).toEqual({
      asset,
      reasons: ["critical"],
    });

    await b.pass("ok");
    const row = (await b.store.getLiveness("inst-1"))!;
    expect({ asset, rung: row.rung, strikes: row.strikes }).toEqual({
      asset,
      rung: "wrong-box",
      strikes: 4,
    });
    expect({ asset, reasons: await b.reasons() }).toEqual({
      asset,
      reasons: ["critical"],
    });
  }
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
    // The report line, per office and with the control's own detail, is the
    // operator's only trace of the outage.
    const lines: string[] = [];
    await b.pass("dns", "prober-a", {
      control: down.control,
      report: (line) => lines.push(line),
    });
    expect(down.calls.n).toBe(1);
    expect(
      lines.filter(
        (l) => l.includes("cp1.test.isomux.app") && l.includes(OUTAGE_DETAIL),
      ),
    ).toHaveLength(1);
    let row = (await b.store.getLiveness("inst-1"))!;
    expect(row.strikes).toBe(0);
    expect(row.checked_at).toBeNull();

    // One real failure, once the outage is old enough to stop holding strikes,
    // then a long outage.
    b.now.value += HOLD_MS;
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

// The control probe is a sample, not a verdict for the whole minute: on
// 2026-10-25 it passed in the gaps of a packet-loss fault while an office
// failed, and those readings counted until the office was raised. So a failed
// reading soon after the prober's own outage is held too. The hold is three
// intervals, not one: a held reading moves the office's next check one
// interval on, so with a single office a one-interval hold never applies.
// Pinned as a literal so the test does not move with the constant it guards.
describe("a recent prober outage holds the office's strikes", () => {
  const down = async (): Promise<ControlResult> => ({
    ok: false,
    detail: "one.one.one.one: timed out; dns.google: timed out",
  });
  const throws = async (): Promise<ControlResult> => {
    throw new Error("control crashed");
  };

  test("a failed reading with a healthy control is held until three minutes after the control last failed, whether it failed or threw", async () => {
    for (const [name, first] of [
      ["failed", down],
      ["threw", throws],
    ] as const) {
      for (const [offset, strikes] of [
        [HOLD_MS - 1, 0],
        [HOLD_MS, 1],
      ] as const) {
        const b = await bed();
        const start = b.now.value;
        await b.pass("tls", "prober-a", { control: first });
        // The enabling condition: the first reading was the prober's outage.
        expect(b.network.lastOutageAt).toBe(start);
        expect((await b.store.getLiveness("inst-1"))!.checked_at).toBeNull();

        b.now.value = start + offset;
        const lines: string[] = [];
        expect(
          await b.pass("tls", "prober-a", {
            report: (line) => lines.push(line),
          }),
        ).toBe(1);
        const row = (await b.store.getLiveness("inst-1"))!;
        expect({ name, offset, strikes: row.strikes }).toEqual({
          name,
          offset,
          strikes,
        });
        // A held reading is not a reading: the row keeps nothing from it.
        expect({ name, offset, checked: row.checked_at !== null }).toEqual({
          name,
          offset,
          checked: strikes > 0,
        });
        expect(
          lines.filter((l) => l.includes("cp1.test.isomux.app")),
        ).toHaveLength(1);
      }
    }
  });

  test("a control that flaps never lets one failing office be raised, and the raise comes on time once it stops", async () => {
    const b = await bed();
    // Every rung that consults the control is held the same way.
    const rungs: Rung[] = ["tls", "readyz", "tcp", "dns"];
    for (let i = 0; i < 12; i++) {
      // The control fails one reading in three, and passes in between.
      const control = i % 3 === 0 ? down : CONTROL_UP;
      expect(
        await b.pass(rungs[i % rungs.length], "prober-a", { control }),
      ).toBe(1);
      expect({
        i,
        strikes: (await b.store.getLiveness("inst-1"))!.strikes,
      }).toEqual({ i, strikes: 0 });
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    expect(await b.reasons()).toEqual([]);

    // The last control failure was at reading 9, three intervals ago: from
    // here every failed reading counts, and the third raises.
    const lastOutage = b.network.lastOutageAt!;
    expect(b.now.value - lastOutage).toBe(HOLD_MS);
    for (const strikes of [1, 2, 3]) {
      await b.pass("tls");
      expect((await b.store.getLiveness("inst-1"))!.strikes).toBe(strikes);
      expect(await b.reasons()).toEqual(strikes < 3 ? [] : ["critical"]);
      b.now.value += LIVENESS_INTERVAL_MS;
    }
  });

  test("the memory belongs to the prober whose control failed", async () => {
    // Another prober's network was fine, so its failed reading counts.
    const b = await bed();
    await b.pass("tls", "prober-a", { control: down });
    b.now.value += LIVENESS_INTERVAL_MS;
    const other: ProberNetwork = { lastOutageAt: null };
    await b.pass("tls", "prober-b", { network: other });
    expect((await b.store.getLiveness("inst-1"))!.strikes).toBe(1);
    expect(other.lastOutageAt).toBeNull();
  });

  test("a failed reading that counts says so, per office, with its rung and the probe's detail", async () => {
    // Before, only held readings wrote a line, so on 2026-10-25 the strikes
    // that raised three offices left no trace and the cause was inferred.
    const b = await bed();
    const lines: string[] = [];
    for (let i = 0; i < 2; i++) {
      await b.pass("tls", "prober-a", { report: (line) => lines.push(line) });
      b.now.value += LIVENESS_INTERVAL_MS;
    }
    const counted = lines.filter(
      (l) =>
        l.includes("cp1.test.isomux.app") &&
        l.includes("tls") &&
        l.includes(TLS_FAILURE),
    );
    expect(counted).toHaveLength(2);
    // The two lines differ only by what changed between them: the strike.
    expect(counted[0]).not.toBe(counted[1]);
  });
});
