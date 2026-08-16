// The cancellation timeline, as arithmetic. Every instant here is seeded: this
// machine's whole point is that a month can be tested without waiting one.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addUtcMonth,
  CUSTOMER_CANCELLATION_REASON,
  decideLifecycle,
  GRACE_MS,
  isCustomerCancellation,
  lifecycleOperationId,
  LIFECYCLE_REASON,
  LIFECYCLE_REPOWERED,
  LIFECYCLE_STRAY,
  PROMISE_AT_RISK,
  PROMISE_BROKEN,
  parseServiceEndsAt,
  phaseAt,
  poweredOffAtFrom,
  promiseAtRisk,
  RETENTION_MS,
} from "./lifecycle.ts";
import { suspensionOperationId } from "./stripe/dunning.ts";
import { Store, type AssetRow, type OperationRow } from "./store.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";

const temps: string[] = [];
afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function tempStore(now: () => number): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-life-"));
  temps.push(dir);
  return await openTestStore(now);
}

const T = (iso: string): number => Date.parse(iso);

/** The RAISE a decision carries, or null when it carries only clears. */
function raiseOf(d: {
  attention: {
    kind: string;
    reason?: string;
    severity?: string;
    key?: string;
  }[];
}): { reason?: string; severity?: string; key?: string } | null {
  return d.attention.find((a) => a.kind === "raise") ?? null;
}

/** The keys a decision CLEARS. */
function clearsOf(d: {
  attention: { kind: string; key?: string }[];
}): (string | undefined)[] {
  return d.attention.filter((a) => a.kind === "clear").map((a) => a.key);
}

describe("addUtcMonth: a month, not thirty days", () => {
  // The clamp cases. 31 January plus 30 days is 2 March, which would make the
  // retention promise mean something different in February than in July.
  test("31 January clamps to the last day of February, non-leap", async () => {
    expect(new Date(addUtcMonth(T("2027-01-31T12:00:00Z"))).toISOString()).toBe(
      "2027-02-28T12:00:00.000Z",
    );
  });

  test("31 January clamps to 29 February in a leap year", async () => {
    expect(new Date(addUtcMonth(T("2028-01-31T12:00:00Z"))).toISOString()).toBe(
      "2028-02-29T12:00:00.000Z",
    );
  });

  test("30 January also clamps, and to the same leap-year day", async () => {
    expect(new Date(addUtcMonth(T("2028-01-30T00:00:00Z"))).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  test("31 March clamps into a 30-day month", async () => {
    expect(new Date(addUtcMonth(T("2027-03-31T00:00:00Z"))).toISOString()).toBe(
      "2027-04-30T00:00:00.000Z",
    );
  });

  test("December rolls the year over and keeps the milliseconds", async () => {
    expect(
      new Date(addUtcMonth(T("2027-12-31T23:59:59.999Z"))).toISOString(),
    ).toBe("2028-01-31T23:59:59.999Z");
  });

  test("a day that needs no clamp is not moved", async () => {
    expect(new Date(addUtcMonth(T("2027-02-28T00:00:00Z"))).toISOString()).toBe(
      "2027-03-28T00:00:00.000Z",
    );
  });

  test("it is NOT thirty days, and February is where that shows", async () => {
    const jan = T("2027-01-31T00:00:00Z");
    expect(addUtcMonth(jan) - jan).not.toBe(30 * 86_400_000);
    expect(addUtcMonth(jan)).toBe(T("2027-02-28T00:00:00Z"));
  });
});

describe("phaseAt boundaries", () => {
  const endedAt = T("2027-01-31T00:00:00Z");
  const cancelled = {
    endedAt,
    cancellationReason: CUSTOMER_CANCELLATION_REASON,
    poweredOffAt: null,
    assetGone: false,
  };

  test("grace is exactly seven days, and the boundary fires ON the instant", async () => {
    const graceEnd = endedAt + GRACE_MS;
    expect(GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(phaseAt(cancelled, graceEnd - 1).phase).toBe("grace");
    expect(phaseAt(cancelled, graceEnd).phase).toBe("power_off_due");
    expect(phaseAt(cancelled, graceEnd + 1).phase).toBe("power_off_due");
  });

  test("retention is a calendar month from the power-off, same three points", async () => {
    const poweredOffAt = T("2027-01-31T09:00:00Z");
    const facts = { ...cancelled, poweredOffAt };
    const retentionEnd = T("2027-02-28T09:00:00Z");
    expect(phaseAt(facts, poweredOffAt).retentionEnd).toBe(retentionEnd);
    expect(phaseAt(facts, retentionEnd - 1).phase).toBe("suspended");
    expect(phaseAt(facts, retentionEnd).phase).toBe("deprovision_due");
    expect(phaseAt(facts, retentionEnd + 1).phase).toBe("deprovision_due");
  });

  test("a scheduled cancellation that has not taken effect is still serving", async () => {
    // No ended_at: the customer can still change their mind, and no operation of
    // this lifecycle may be opened while they can.
    const scheduled = { ...cancelled, endedAt: null };
    expect(phaseAt(scheduled, T("2030-01-01T00:00:00Z")).phase).toBe("serving");
    expect(phaseAt(scheduled, 0).graceEnd).toBeNull();
  });

  test("a dunning cancellation is not this machine's business", async () => {
    const dunning = { ...cancelled, cancellationReason: "payment_failed" };
    expect(phaseAt(dunning, T("2030-01-01T00:00:00Z")).phase).toBe("serving");
    expect(isCustomerCancellation(dunning)).toBe(false);
    expect(isCustomerCancellation(cancelled)).toBe(true);
  });

  test("provider truth, not our deadline, is what ends it", async () => {
    const facts = {
      ...cancelled,
      poweredOffAt: T("2027-01-31T09:00:00Z"),
      assetGone: true,
    };
    expect(phaseAt(facts, T("2027-02-01T00:00:00Z")).phase).toBe("ended");
  });
});

// ---------------------------------------------------------------- fixtures

function op(over: Partial<OperationRow>): OperationRow {
  return {
    id: "op-1",
    instance_id: "inst-1",
    kind: "power_off",
    status: "succeeded",
    attempt: 0,
    next_attempt_at: 0,
    lease_until: null,
    lease_holder: null,
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    evidence: "{}",
    evidence_at: 0,
    inactivity_flagged: 0,
    absolute_flagged: 0,
    version: 1,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function asset(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset-1",
    instance_id: "inst-1",
    provider: "contabo",
    provider_id: "203474835",
    intent_id: null,
    asset_state: "active",
    ipv4: "169.58.97.2",
    service_ends_at: null,
    host_key_fingerprint: null,
    next_reconcile_at: 0,
    version: 1,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

describe("the retention anchor is THIS cancellation's power_off", () => {
  const endedAt = T("2027-06-10T00:00:00Z");
  const mine = lifecycleOperationId("power_off", "sub_1", endedAt);

  test("an old dunning suspension cannot advance the deletion clock", async () => {
    // The failure this guards: a customer suspended for non-payment in January,
    // recovered, then cancelled in June. Anchoring on "the latest succeeded
    // power_off" would read January's row and make deprovision due immediately.
    const dunning = op({
      id: suspensionOperationId("dun-evt_1"),
      evidence: JSON.stringify({
        reason: "dunning",
        poweredOffAt: T("2027-01-05T00:00:00Z"),
      }),
    });
    expect(poweredOffAtFrom([dunning], "sub_1", endedAt)).toBeNull();

    const decision = decideLifecycle({
      instance: {
        id: "inst-1",
        service_state: "suspended",
        version: 1,
      } as never,
      asset: asset(),
      operations: [dunning],
      subscription: {
        id: "sub_1",
        endedAt,
        cancellationReason: CUSTOMER_CANCELLATION_REASON,
      },
      // Well past a month after the JANUARY power-off, and one second after the
      // grace week that follows the JUNE cancellation.
      now: endedAt + GRACE_MS + 1000,
    });
    expect(decision.phase).toBe("power_off_due");
    expect(decision.open.map((o) => o.kind)).toEqual(["power_off"]);
  });

  test("after a resume, the LATER lifecycle power_off is the anchor", async () => {
    const dunning = op({
      id: suspensionOperationId("dun-evt_1"),
      evidence: JSON.stringify({
        reason: "dunning",
        poweredOffAt: T("2027-01-05T00:00:00Z"),
      }),
    });
    const resumed = op({
      id: "op-power_on-dun-evt_1",
      kind: "power_on",
      evidence: JSON.stringify({ reason: "dunning", poweredOn: true }),
    });
    const later = op({
      id: mine,
      evidence: JSON.stringify({
        reason: LIFECYCLE_REASON,
        poweredOffAt: T("2027-06-17T00:00:00Z"),
      }),
    });
    expect(poweredOffAtFrom([dunning, resumed, later], "sub_1", endedAt)).toBe(
      T("2027-06-17T00:00:00Z"),
    );
    expect(
      phaseAt(
        {
          endedAt,
          cancellationReason: CUSTOMER_CANCELLATION_REASON,
          poweredOffAt: T("2027-06-17T00:00:00Z"),
          assetGone: false,
        },
        T("2027-07-17T00:00:00Z"),
      ).phase,
    ).toBe("deprovision_due");
  });

  test("a power-off that lands after midnight moves the month with it", async () => {
    // The client used to project this from the GRACE END, which is a different
    // day whenever the power-off crosses midnight or a month boundary. The
    // machine measures from the instant it actually happened.
    const graceEnd = T("2027-01-31T23:50:00Z");
    const late = T("2027-02-01T00:10:00Z");
    expect(new Date(addUtcMonth(graceEnd)).toISOString()).toBe(
      "2027-02-28T23:50:00.000Z",
    );
    expect(new Date(addUtcMonth(late)).toISOString()).toBe(
      "2027-03-01T00:10:00.000Z",
    );
    // Twenty minutes apart as instants, and a DIFFERENT DAY on the page - which
    // is what the customer reads, and what a client-side projection from the
    // grace end would have got wrong.
    const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    expect(day(addUtcMonth(graceEnd))).toBe("2027-02-28");
    expect(day(addUtcMonth(late))).toBe("2027-03-01");
  });

  test("a power_off that has not succeeded is not an anchor", async () => {
    const running = op({
      id: mine,
      status: "running",
      evidence: JSON.stringify({
        reason: LIFECYCLE_REASON,
        poweredOffAt: T("2027-06-17T00:00:00Z"),
      }),
    });
    expect(poweredOffAtFrom([running], "sub_1", endedAt)).toBeNull();
  });
});

describe("decideLifecycle", () => {
  const endedAt = T("2027-06-10T00:00:00Z");
  const instance = {
    id: "inst-1",
    service_state: "live",
    version: 1,
  } as never;
  const sub = {
    id: "sub_1",
    endedAt,
    cancellationReason: CUSTOMER_CANCELLATION_REASON,
  };

  test("inside the grace week it opens nothing at all", async () => {
    const d = decideLifecycle({
      instance,
      asset: asset(),
      operations: [],
      subscription: sub,
      now: endedAt + GRACE_MS - 1,
    });
    expect(d.open).toEqual([]);
    expect(d.phase).toBe("grace");
  });

  test("at the retention deadline it opens BOTH, and neither waits for the other", async () => {
    const poweredOffAt = T("2027-06-17T00:00:00Z");
    const d = decideLifecycle({
      instance,
      asset: asset(),
      operations: [
        op({
          id: lifecycleOperationId("power_off", "sub_1", endedAt),
          evidence: JSON.stringify({
            reason: LIFECYCLE_REASON,
            poweredOffAt,
          }),
        }),
      ],
      subscription: sub,
      now: addUtcMonth(poweredOffAt),
    });
    expect(d.phase).toBe("deprovision_due");
    expect(d.open.map((o) => o.kind).sort()).toEqual([
      "cancel_asset",
      "remove_dns",
    ]);
    for (const spec of d.open) {
      expect(spec.evidence.reason).toBe(LIFECYCLE_REASON);
      expect(spec.id).toBe(lifecycleOperationId(spec.kind, "sub_1", endedAt));
    }
  });

  test("lifecycle rows on a non-terminal subscription raise a person", async () => {
    const d = decideLifecycle({
      instance,
      asset: asset(),
      operations: [
        op({
          id: lifecycleOperationId("power_off", "sub_1", endedAt),
          evidence: JSON.stringify({ reason: LIFECYCLE_REASON }),
        }),
      ],
      subscription: { id: "sub_1", endedAt: null, cancellationReason: null },
      now: endedAt,
    });
    expect(d.open).toEqual([]);
    expect(raiseOf(d)?.severity).toBe("critical");
    expect(raiseOf(d)?.reason).toContain("is not terminal");
  });

  test("accepted reinstatement excuses only its exact succeeded suspension", () => {
    const exact = op({
      id: lifecycleOperationId("power_off", "sub_1", endedAt),
      kind: "power_off",
      status: "succeeded",
      evidence: JSON.stringify({
        reason: LIFECYCLE_REASON,
        poweredOffAt: endedAt,
      }),
    });
    const input = {
      instance,
      asset: asset(),
      subscription: {
        ...sub,
        cancellationPolicy: "launch" as const,
      },
      reinstatement: {
        state: "accepted" as const,
        attemptId: "reinstate-sub_1",
        fenceExpiresAt: endedAt + RETENTION_MS,
        expiryProven: false,
      },
      now: endedAt + 1,
    };
    expect(
      decideLifecycle({ ...input, operations: [exact] }).attention,
    ).toEqual([{ kind: "clear", key: PROMISE_AT_RISK }]);
    const foreign = op({
      id: lifecycleOperationId("power_off", "sub_other", endedAt),
      kind: "power_off",
      status: "succeeded",
      evidence: JSON.stringify({ reason: LIFECYCLE_REASON }),
    });
    expect(
      decideLifecycle({
        ...input,
        operations: [exact, foreign],
      }).attention.some(
        (action) => action.kind === "raise" && action.key === LIFECYCLE_STRAY,
      ),
    ).toBe(true);
  });

  test("data end is recorded from provider truth, once", async () => {
    const gone = decideLifecycle({
      instance,
      asset: asset({ asset_state: "cancelled" }),
      operations: [],
      subscription: sub,
      now: endedAt + GRACE_MS,
    });
    expect(gone.finish).toBe(true);
    expect(gone.open).toEqual([]);
    expect(gone.attention).toContainEqual({
      kind: "clear",
      key: LIFECYCLE_REPOWERED,
    });

    const already = decideLifecycle({
      instance: {
        ...(instance as object),
        service_state: "deprovisioned",
      } as never,
      asset: asset({ asset_state: "absent" }),
      operations: [],
      subscription: sub,
      now: endedAt + GRACE_MS,
    });
    expect(already.finish).toBe(false);
  });
});

describe("an asset that goes BEFORE the promise expires", () => {
  const endedAt = T("2027-01-31T09:00:00Z");
  const instance = { id: "inst-1", service_state: "live", version: 1 } as never;
  const sub = {
    id: "sub_1",
    endedAt,
    cancellationReason: CUSTOMER_CANCELLATION_REASON,
  };
  const poweredOff = op({
    id: lifecycleOperationId("power_off", "sub_1", endedAt),
    evidence: JSON.stringify({
      reason: LIFECYCLE_REASON,
      poweredOffAt: T("2027-02-07T09:00:00Z"),
    }),
  });

  test("gone DURING THE GRACE WEEK is a broken promise, not a normal end", async () => {
    // The whole failure this covers: the data is gone while the customer was
    // told they had until March, and the ordinary ended arm would have recorded
    // the data end silently.
    const d = decideLifecycle({
      instance,
      asset: asset({ asset_state: "cancelled" }),
      operations: [],
      subscription: sub,
      now: endedAt + 86_400_000,
    });
    expect(d.phase).toBe("ended");
    expect(d.finish).toBe(true);
    expect(raiseOf(d)?.severity).toBe("critical");
    expect(raiseOf(d)?.reason).toContain("BEFORE the");
    expect(d.note).toContain("promise broken");
  });

  test("gone DURING THE RETENTION MONTH is a broken promise too", async () => {
    const d = decideLifecycle({
      instance,
      asset: asset({ asset_state: "absent" }),
      operations: [poweredOff],
      subscription: sub,
      now: T("2027-02-20T00:00:00Z"),
    });
    expect(raiseOf(d)?.severity).toBe("critical");
    expect(d.finish).toBe(true);
  });

  test("a term that ended early is a BROKEN promise however late we notice", async () => {
    // The failure this covers: retention deadline 7 March, provider term ended
    // 1 March, and the first reconcile that sees `cancelled` runs on 20 March.
    // Keying on the observation time alone made that a silent, ordinary data
    // end for a failure the asset row can prove.
    const d = decideLifecycle({
      instance,
      asset: asset({ asset_state: "cancelled", service_ends_at: "2027-03-01" }),
      operations: [poweredOff],
      subscription: sub,
      now: T("2027-03-20T00:00:00Z"),
    });
    expect(d.phase).toBe("ended");
    expect(raiseOf(d)?.severity).toBe("critical");
    expect(raiseOf(d)?.key).toBe(PROMISE_BROKEN);
    expect(d.note).toContain("promise broken");
  });

  test("a term that ran past the deadline is an ordinary end, however we look", async () => {
    const d = decideLifecycle({
      instance,
      asset: asset({ asset_state: "cancelled", service_ends_at: "2027-08-29" }),
      operations: [poweredOff],
      subscription: sub,
      now: T("2027-03-20T00:00:00Z"),
    });
    expect(raiseOf(d)).toBeNull();
    expect(clearsOf(d)).toEqual([LIFECYCLE_REPOWERED, PROMISE_AT_RISK]);
  });

  test("gone AT the deadline, and after it, is the ordinary end", async () => {
    const retentionEnd = addUtcMonth(T("2027-02-07T09:00:00Z"));
    for (const now of [retentionEnd, retentionEnd + 86_400_000]) {
      const d = decideLifecycle({
        instance,
        asset: asset({ asset_state: "cancelled" }),
        operations: [poweredOff],
        subscription: sub,
        now,
      });
      expect(raiseOf(d)).toBeNull();
      expect(d.finish).toBe(true);
      expect(d.note).toContain("data end recorded");
    }
  });

  test("the promise has a PROJECTED deadline before the power-off exists", async () => {
    // Otherwise the whole grace week is unwatched: there is no retentionEnd
    // yet, so a term lapsing inside it would compare against nothing.
    const timeline = phaseAt(
      {
        endedAt,
        cancellationReason: CUSTOMER_CANCELLATION_REASON,
        poweredOffAt: null,
        assetGone: false,
      },
      endedAt,
    );
    expect(timeline.retentionEnd).toBeNull();
    expect(timeline.promisedUntil).toBe(addUtcMonth(endedAt + GRACE_MS));

    const d = decideLifecycle({
      instance,
      // A term lapsing three weeks in, while the office is still in grace.
      asset: asset({ service_ends_at: "2027-02-20" }),
      operations: [],
      subscription: sub,
      now: endedAt + 1000,
    });
    expect(d.phase).toBe("grace");
    expect(raiseOf(d)?.severity).toBe("critical");
    expect(raiseOf(d)?.reason).toContain("BEFORE the retention deadline");
  });
});

describe("conditions have a stable identity", () => {
  const endedAt = T("2027-01-31T09:00:00Z");
  const instance = { id: "inst-1", service_state: "live", version: 1 } as never;
  const sub = {
    id: "sub_1",
    endedAt,
    cancellationReason: CUSTOMER_CANCELLATION_REASON,
  };

  test("the broken-promise sentence does not move with the clock", async () => {
    const at = (now: number) =>
      raiseOf(
        decideLifecycle({
          instance,
          asset: asset({ asset_state: "cancelled" }),
          operations: [],
          subscription: sub,
          now,
        }),
      )?.reason;
    // Two ticks a week apart. A sentence carrying the observation time would
    // differ here, and each difference is another critical row.
    expect(at(endedAt + 1000)).toBe(at(endedAt + 7 * 86_400_000));
  });

  test("the at-risk sentence does not move when the provider's date does", async () => {
    const reason = (ends: string) =>
      promiseAtRisk(asset({ service_ends_at: ends }), T("2027-07-17T00:00:00Z"))
        ?.reason;
    // Both are unsafe; it is ONE condition, so it must be one row.
    expect(reason("2027-07-01")).toBe(reason("2027-07-10"));
  });
});

describe("a provider term that would break the promise", () => {
  const retentionEnd = T("2027-07-17T00:00:00Z");

  test("a term ending BEFORE the retention deadline is a critical attention case", async () => {
    const risk = promiseAtRisk(
      asset({ service_ends_at: "2027-07-01" }),
      retentionEnd,
    );
    expect(risk?.severity).toBe("critical");
    expect(risk?.reason).toContain("BEFORE the retention deadline");
  });

  test("a term ending after it is not, and never shortens anything", async () => {
    expect(
      promiseAtRisk(asset({ service_ends_at: "2027-08-29" }), retentionEnd),
    ).toBeNull();
    // Exactly on the deadline is enough: the promise is kept.
    expect(
      promiseAtRisk(
        asset({ service_ends_at: "2027-07-17T00:00:00Z" }),
        retentionEnd,
      ),
    ).toBeNull();
  });

  test("a date we cannot parse is unknown, not safe", async () => {
    expect(parseServiceEndsAt("not a date")).toBeNull();
    expect(parseServiceEndsAt("2026-08-29")).toBe(T("2026-08-29T00:00:00Z"));
    expect(
      promiseAtRisk(asset({ service_ends_at: null }), retentionEnd),
    ).toBeNull();
  });
});

describe("operation ids", () => {
  test("the lifecycle's ids cannot collide with a dunning suspension's", async () => {
    const endedAt = T("2027-06-10T00:00:00Z");
    expect(lifecycleOperationId("power_off", "sub_1", endedAt)).not.toBe(
      suspensionOperationId("dun-evt_1"),
    );
  });

  test("they are stable under replay: same anchor, same id", async () => {
    const endedAt = T("2027-06-10T00:00:00Z");
    expect(lifecycleOperationId("cancel_asset", "sub_1", endedAt)).toBe(
      lifecycleOperationId("cancel_asset", "sub_1", endedAt),
    );
  });

  test("a store can hold one, which is what makes the id the arbiter", async () => {
    const store = await tempStore(() => 1_000);
    const endedAt = T("2027-06-10T00:00:00Z");
    const id = lifecycleOperationId("power_off", "sub_1", endedAt);
    await store.createInstance({
      id: "inst-1",
      run_id: null,
      name: "cp1.test.isomux.app",
      plan: "V153",
      region: "EU",
      service_state: "live",
      goal: "live",
      access_window_expires_at: null,
    });
    await store.enqueue({
      id,
      instance_id: "inst-1",
      kind: "power_off",
      inactivity_deadline_at: 2_000,
      absolute_deadline_at: 3_000,
    });
    expect(
      store.enqueue({
        id,
        instance_id: "inst-1",
        kind: "power_off",
        inactivity_deadline_at: 2_000,
        absolute_deadline_at: 3_000,
      }),
    ).rejects.toThrow();
    await store.close();
  });
});
