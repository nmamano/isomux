// The payment lifecycle as arithmetic (task 6eb1e7d6; Nil, 2026-11-10: "treat
// like cancellation"). A box powered off when Stripe's retries ran out is kept
// 14 days, the customer is told the date first, and then the provider is asked
// to delete it. Every instant is seeded.
//
// The deletion date is the LATEST of three instants (the agreed design, D2):
//   - 14 days after the proven power-off, counted from the effective date for a
//     box suspended before the terms changed;
//   - the date the suspension mail named (its opener evidence, `deletesAt`);
//   - 14 days after the mail actually went out (the handler's `sentAt`).
// So the server may be kept longer than the mail says, never shorter.

import { describe, expect, test } from "bun:test";
import {
  CUSTOMER_CANCELLATION_REASON,
  decidePaymentLifecycle,
  isLifecycleRow,
  LIFECYCLE_ASSET_GONE,
  PAYMENT_DELETION_EFFECTIVE_AT,
  PAYMENT_DELETION_HELD,
  PAYMENT_LIFECYCLE_REASON,
  paymentDeletionAt,
  paymentOperationId,
  PROMISE_AT_RISK,
  PROMISE_BROKEN,
  RETENTION_MS,
  type PaymentLifecycleInputs,
} from "./lifecycle.ts";
import { resumeOperationId } from "./resume.ts";
import type { AssetRow, InstanceRow, OperationRow } from "./store.ts";
import { suspensionOperationId } from "./stripe/dunning.ts";

const T = (iso: string): number => Date.parse(iso);
const DAY = 24 * 60 * 60 * 1000;
const EP = "dun-evt_9";
/** A power-off well after the effective date: the plain 14-day case. */
const P = T("2027-03-01T10:00:00Z");

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

/** The dunning power_off as its handler leaves it: the opener stamp plus the
 * instant it proved the box off. */
function powerOff(
  episode: string,
  poweredOffAt: number | null,
  status: OperationRow["status"] = "succeeded",
): OperationRow {
  return op({
    id: suspensionOperationId(episode),
    kind: "power_off",
    status,
    evidence: JSON.stringify({
      reason: "dunning",
      subscription: "sub_1",
      episode,
      ...(poweredOffAt === null ? {} : { poweredOff: true, poweredOffAt }),
    }),
  });
}

function powerOn(episode: string, poweredOnAt: number): OperationRow {
  return op({
    id: resumeOperationId(episode),
    kind: "power_on",
    evidence: JSON.stringify({
      reason: "dunning",
      subscription: "sub_1",
      episode,
      poweredOn: true,
      poweredOnAt,
    }),
  });
}

/** The suspension mail's row. `sentAt` is what the handler records when the
 * send succeeded; the opener's `deletesAt` is carried through. */
function notice(
  episode: string,
  over: {
    status?: OperationRow["status"];
    deletesAt: number;
    sentAt?: number;
  },
): OperationRow {
  return op({
    id: paymentOperationId("payment_notice", episode),
    kind: "payment_notice",
    status: over.status ?? "succeeded",
    evidence: JSON.stringify({
      reason: PAYMENT_LIFECYCLE_REASON,
      subscription: "sub_1",
      episode,
      deletesAt: over.deletesAt,
      ...(over.sentAt === undefined ? {} : { sentAt: over.sentAt }),
    }),
  });
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

function instance(serviceState: string = "suspended"): InstanceRow {
  return {
    id: "inst-1",
    run_id: null,
    name: "cp2.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: serviceState,
    goal: "live",
    version: 1,
  } as unknown as InstanceRow;
}

const UNPAID = {
  id: "sub_1",
  status: "unpaid",
  endedAt: null,
  cancellationReason: null,
};

function decide(
  over: Partial<Omit<PaymentLifecycleInputs, "now">> & { now: number },
) {
  return decidePaymentLifecycle({
    instance: instance(),
    asset: asset(),
    operations: [powerOff(EP, P)],
    subscription: UNPAID,
    ...over,
  });
}

const kinds = (d: { open: { kind: string }[] }): string[] =>
  d.open.map((o) => o.kind).sort();
const raisedKeys = (d: { attention: { kind: string; key: string }[] }) =>
  d.attention.filter((a) => a.kind === "raise").map((a) => a.key);
const clearedKeys = (d: { attention: { kind: string; key: string }[] }) =>
  d.attention.filter((a) => a.kind === "clear").map((a) => a.key);

/** Fails the test if the decision opens any deletion step. */
function expectNoDeletion(d: { open: { kind: string }[] }): void {
  expect(
    kinds(d).filter((k) => k === "cancel_asset" || k === "remove_dns"),
  ).toEqual([]);
}

/** Fails the test unless the decision opens exactly the two deletion steps,
 * with this episode's ids and the payment stamp. */
function expectDeletion(d: {
  open: { kind: string; id: string; evidence: Record<string, unknown> }[];
}): void {
  const steps = d.open.filter(
    (o) => o.kind === "cancel_asset" || o.kind === "remove_dns",
  );
  expect(steps.map((o) => o.kind).sort()).toEqual([
    "cancel_asset",
    "remove_dns",
  ]);
  for (const step of steps) {
    expect(step.id).toBe(paymentOperationId(step.kind as never, EP));
    expect(step.evidence.reason).toBe(PAYMENT_LIFECYCLE_REASON);
    // Not a cancellation row: decideLifecycle's stray arm and requestResume's
    // cancellation refusal must not read it as one.
    expect(
      isLifecycleRow(op({ evidence: JSON.stringify(step.evidence) })),
    ).toBe(false);
  }
}

describe("paymentDeletionAt: 14 days, never counted from before the terms changed", () => {
  test("a box powered off after the effective date gets exactly 14 days", () => {
    expect(paymentDeletionAt(P)).toBe(P + RETENTION_MS);
    expect(paymentDeletionAt(PAYMENT_DELETION_EFFECTIVE_AT + 1)).toBe(
      PAYMENT_DELETION_EFFECTIVE_AT + 1 + RETENTION_MS,
    );
  });

  test("a box powered off at or before the effective date counts from it", () => {
    const floor = PAYMENT_DELETION_EFFECTIVE_AT + RETENTION_MS;
    expect(paymentDeletionAt(PAYMENT_DELETION_EFFECTIVE_AT)).toBe(floor);
    expect(paymentDeletionAt(PAYMENT_DELETION_EFFECTIVE_AT - 1)).toBe(floor);
    // The live case (task 6eb1e7d6): Stripe's last retry about 22 Nov 2026.
    expect(paymentDeletionAt(T("2026-11-22T06:00:00Z"))).toBe(floor);
    // A box suspended long before the change, too.
    expect(paymentDeletionAt(T("2026-08-01T00:00:00Z"))).toBe(floor);
  });
});

describe("decidePaymentLifecycle: the mail first", () => {
  test("the first pass after a proven power-off opens the mail, naming the date, and deletes nothing", () => {
    const d = decide({ now: P + 60_000 });
    expect(kinds(d)).toEqual(["payment_notice"]);
    const mail = d.open[0]!;
    expect(mail.id).toBe(paymentOperationId("payment_notice", EP));
    expect(mail.evidence.reason).toBe(PAYMENT_LIFECYCLE_REASON);
    expect(mail.evidence.episode).toBe(EP);
    expect(mail.evidence.deletesAt).toBe(P + RETENTION_MS);
    expect(d.phase).toBe("suspended");
    expect(d.finish).toBe(false);
  });

  test("a box suspended before the terms changed is told the floor date", () => {
    const early = T("2026-11-22T06:00:00Z");
    const d = decide({
      operations: [powerOff(EP, early)],
      now: early + 60_000,
    });
    expect(kinds(d)).toEqual(["payment_notice"]);
    expect(d.open[0]!.evidence.deletesAt).toBe(
      PAYMENT_DELETION_EFFECTIVE_AT + RETENTION_MS,
    );
  });

  test("no proven power-off, no clock: nothing is opened, however late", () => {
    for (const operations of [
      [powerOff(EP, P, "running")],
      [powerOff(EP, P, "ambiguous")],
      [powerOff(EP, P, "failed")],
      // Succeeded, but the handler recorded no instant.
      [powerOff(EP, null)],
    ]) {
      const d = decide({ operations, now: P + 400 * DAY });
      expect(kinds(d)).toEqual([]);
    }
  });
});

describe("decidePaymentLifecycle: deletion only at the date, and only after the mail", () => {
  const sentAt = P + 60_000;
  const named = P + RETENTION_MS;
  // The latest of the three: sentAt + 14 days is a minute after `named`.
  const due = sentAt + RETENTION_MS;

  test("nothing before the date; both steps AT it (the boundary fires on the instant)", () => {
    const operations = [
      powerOff(EP, P),
      notice(EP, { deletesAt: named, sentAt }),
    ];
    expectNoDeletion(decide({ operations, now: named }));
    expectNoDeletion(decide({ operations, now: due - 1 }));
    const at = decide({ operations, now: due });
    expectDeletion(at);
    expect(at.phase).toBe("deprovision_due");
    expect(at.finish).toBe(false);
    expectDeletion(decide({ operations, now: due + 1 }));
  });

  test("a box suspended on 22 Nov 2026 is kept to the floor date, not 14 days from the power-off", () => {
    const early = T("2026-11-22T06:00:00Z");
    const floor = PAYMENT_DELETION_EFFECTIVE_AT + RETENTION_MS;
    const operations = [
      powerOff(EP, early),
      notice(EP, { deletesAt: floor, sentAt: early + 60_000 }),
    ];
    // 14 days after the power-off and after the mail have both passed.
    expectNoDeletion(decide({ operations, now: early + RETENTION_MS + DAY }));
    expectNoDeletion(decide({ operations, now: floor - 1 }));
    expectDeletion(decide({ operations, now: floor }));
  });

  test("the date the mail named wins when it is later than the computed one", () => {
    // As if the effective date moved in a later release: the customer read
    // `later`, so nothing happens before it.
    const later = P + 30 * DAY;
    const operations = [
      powerOff(EP, P),
      notice(EP, { deletesAt: later, sentAt }),
    ];
    expectNoDeletion(decide({ operations, now: due + DAY }));
    expectNoDeletion(decide({ operations, now: later - 1 }));
    expectDeletion(decide({ operations, now: later }));
  });

  test("a mail that went out late still gives the customer 14 days", () => {
    const late = P + 13 * DAY;
    const operations = [
      powerOff(EP, P),
      notice(EP, { deletesAt: named, sentAt: late }),
    ];
    expectNoDeletion(decide({ operations, now: named + DAY }));
    expectNoDeletion(decide({ operations, now: late + RETENTION_MS - 1 }));
    expectDeletion(decide({ operations, now: late + RETENTION_MS }));
  });

  test("a mail that has not succeeded holds the deletion, and says so", () => {
    for (const status of [
      "pending",
      "running",
      "ambiguous",
      "failed",
    ] as const) {
      const d = decide({
        operations: [powerOff(EP, P), notice(EP, { status, deletesAt: named })],
        now: P + 60 * DAY,
      });
      expectNoDeletion(d);
    }
    const failed = decide({
      operations: [
        powerOff(EP, P),
        notice(EP, { status: "failed", deletesAt: named }),
      ],
      now: P + 60 * DAY,
    });
    expect(raisedKeys(failed)).toContain(PAYMENT_DELETION_HELD);
    // No mail row at all past the date: still no deletion.
    expectNoDeletion(decide({ now: P + 60 * DAY }));
    // A mail the handler skipped (the customer had paid) carries no send
    // instant: it is not a mail that went out.
    expectNoDeletion(
      decide({
        operations: [powerOff(EP, P), notice(EP, { deletesAt: named })],
        now: P + 60 * DAY,
      }),
    );
  });

  test("the held row clears once the mail succeeded", () => {
    const d = decide({
      operations: [powerOff(EP, P), notice(EP, { deletesAt: named, sentAt })],
      now: due,
    });
    expect(raisedKeys(d)).not.toContain(PAYMENT_DELETION_HELD);
    expect(clearedKeys(d)).toContain(PAYMENT_DELETION_HELD);
  });
});

describe("decidePaymentLifecycle: what it never deletes", () => {
  const sentAt = P + 60_000;
  const told = [
    powerOff(EP, P),
    notice(EP, { deletesAt: P + RETENTION_MS, sentAt }),
  ];
  const late = P + 60 * DAY;

  test("a box that was resumed for this episode", () => {
    const d = decide({
      instance: instance("live"),
      operations: [...told, powerOn(EP, P + 3 * DAY)],
      subscription: { ...UNPAID, status: "active" },
      now: late,
    });
    expect(kinds(d)).toEqual([]);
    expect(raisedKeys(d)).not.toContain(PAYMENT_DELETION_HELD);
  });

  test("a resumed episode stays resumed while the next one is still open", () => {
    // Paid and powered on; a later invoice is past_due, with no new power-off
    // yet. The resumed episode is still the latest dunning suspension, and it
    // owes nothing: even a provider asset gone now is not this machine's end.
    const d = decide({
      instance: instance("live"),
      asset: asset({ asset_state: "absent" }),
      operations: [...told, powerOn(EP, P + 3 * DAY)],
      subscription: { ...UNPAID, status: "past_due" },
      now: late,
    });
    expect(kinds(d)).toEqual([]);
    expect(d.finish).toBe(false);
    expect(raisedKeys(d)).not.toContain(PROMISE_BROKEN);
  });

  test("a subscription that is paid again, before the power-on lands", () => {
    for (const status of ["active", "trialing"]) {
      const d = decide({
        operations: told,
        subscription: { ...UNPAID, status },
        now: late,
      });
      expectNoDeletion(d);
    }
  });

  test("a customer cancellation: that is the cancellation machine's", () => {
    const d = decide({
      operations: told,
      subscription: {
        id: "sub_1",
        status: "canceled",
        endedAt: P + DAY,
        cancellationReason: CUSTOMER_CANCELLATION_REASON,
      },
      now: late,
    });
    expect(kinds(d)).toEqual([]);
  });

  test("an older episode that was resumed does not start the clock for the newer one", () => {
    const A = "dun-evt_1";
    const aOff = P - 90 * DAY;
    const operations = [
      powerOff(A, aOff),
      notice(A, { deletesAt: aOff + RETENTION_MS, sentAt: aOff + 60_000 }),
      powerOn(A, aOff + 5 * DAY),
      powerOff(EP, P),
    ];
    // Long past A's date, one day into EP's suspension.
    const d = decide({ operations, now: P + DAY });
    expectNoDeletion(d);
    expect(kinds(d)).toEqual(["payment_notice"]);
    expect(d.open[0]!.id).toBe(paymentOperationId("payment_notice", EP));
    expect(d.open[0]!.evidence.deletesAt).toBe(P + RETENTION_MS);
  });
});

describe("decidePaymentLifecycle: a subscription Stripe ended unpaid is still this machine's", () => {
  test("canceled with reason payment_failed deletes at the date", () => {
    const sentAt = P + 60_000;
    const d = decide({
      operations: [
        powerOff(EP, P),
        notice(EP, { deletesAt: P + RETENTION_MS, sentAt }),
      ],
      subscription: {
        id: "sub_1",
        status: "canceled",
        endedAt: P + 2 * DAY,
        cancellationReason: "payment_failed",
      },
      now: sentAt + RETENTION_MS,
    });
    expectDeletion(d);
  });
});

describe("decidePaymentLifecycle: the end", () => {
  const sentAt = P + 60_000;
  const due = sentAt + RETENTION_MS;
  const deleting = [
    powerOff(EP, P),
    notice(EP, { deletesAt: P + RETENTION_MS, sentAt }),
    op({
      id: paymentOperationId("cancel_asset", EP),
      kind: "cancel_asset",
      evidence: JSON.stringify({
        reason: PAYMENT_LIFECYCLE_REASON,
        episode: EP,
      }),
    }),
  ];

  test("provider truth ends it: the data end, DNS removed, no broken promise", () => {
    const d = decide({
      operations: deleting,
      asset: asset({ asset_state: "cancelled" }),
      now: due + 20 * DAY,
    });
    expect(d.phase).toBe("ended");
    expect(d.finish).toBe(true);
    expect(d.open.map((o) => o.id)).toContain(
      paymentOperationId("remove_dns", EP),
    );
    expect(kinds(d)).not.toContain("cancel_asset");
    expect(clearedKeys(d)).toContain(LIFECYCLE_ASSET_GONE);
    expect(raisedKeys(d)).not.toContain(PROMISE_BROKEN);
  });

  test("an office already recorded as deprovisioned is not finished twice", () => {
    const d = decide({
      instance: instance("deprovisioned"),
      operations: deleting,
      asset: asset({ asset_state: "cancelled" }),
      now: due + 20 * DAY,
    });
    expect(d.finish).toBe(false);
  });

  test("an asset gone before the date the customer was told is a broken promise", () => {
    const d = decide({
      operations: [
        powerOff(EP, P),
        notice(EP, { deletesAt: P + RETENTION_MS, sentAt }),
      ],
      asset: asset({ asset_state: "absent" }),
      now: P + 3 * DAY,
    });
    expect(d.finish).toBe(true);
    expect(raisedKeys(d)).toContain(PROMISE_BROKEN);
  });

  test("a provider term that ends before the date is a promise at risk", () => {
    const d = decide({
      operations: [
        powerOff(EP, P),
        notice(EP, { deletesAt: P + RETENTION_MS, sentAt }),
      ],
      asset: asset({ service_ends_at: "2027-03-05" }),
      now: P + DAY,
    });
    expect(raisedKeys(d)).toContain(PROMISE_AT_RISK);
    expectNoDeletion(d);
  });
});
