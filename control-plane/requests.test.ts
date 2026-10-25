// The customer's three verbs: who may ask, when, and what stops a second one.
//
// The interesting assertions here are the refusals. A verb that opens the right
// row on the happy path and opens a second one under a double click is not a
// verb, it is a race with a nice name.

import { afterEach, describe, expect, test } from "bun:test";
import {
  confirmHandoff,
  requestInvite,
  requestRestart,
  REFUSAL_WORDS,
} from "./requests.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { Store, type OperationStatus } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";
import { suspensionOperationId } from "./stripe/dunning.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Bed {
  store: Store;
  accountId: string;
  instanceId: string;
  succeed(kind: string): Promise<void>;
  open(kind: string, status?: OperationStatus): Promise<string>;
}

async function bed(opts: { linked?: boolean } = {}): Promise<Bed> {
  const store = await openTestStore();
  const account = await accountForDevSignIn(store, "asker@example.com");
  const reserved = await reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;
  if (opts.linked !== false) {
    const asset = (await store.assetForInstance(instanceId))!;
    await store.casAsset(asset.id, asset.version, {
      provider_id: "203474835",
      asset_state: "active",
    });
  }
  let n = 0;
  const open = async (
    kind: string,
    status: OperationStatus = "pending",
  ): Promise<string> => {
    const op = await store.enqueue({
      id: `op-${kind}-${n++}`,
      instance_id: instanceId,
      kind,
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
    });
    if (status !== "pending") {
      const leased = (await store.tryLease(
        op.id,
        op.version,
        "h",
        0,
        Date.now(),
      ))!;
      await store.casOperation(
        { id: leased.id, version: leased.version, holder: "h" },
        { status },
      );
    }
    return op.id;
  };
  return {
    store,
    accountId: account.id,
    instanceId,
    open,
    succeed: async (kind) => void (await open(kind, "succeeded")),
  };
}

describe("who may ask", () => {
  test("another account's office is not found", async () => {
    const b = await bed();
    const other = await accountForDevSignIn(b.store, "other@example.com");
    for (const verb of [requestInvite, confirmHandoff, requestRestart]) {
      const out = await verb(b.store, {
        accountId: other.id,
        instanceId: b.instanceId,
      });
      expect(out).toMatchObject({ ok: false, code: "not_yours" });
    }
  });
});

describe("the access window gates minting", () => {
  test("a pristine signup is refused with the reason that fits it", async () => {
    const b = await bed({ linked: false });
    const out = await requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(out).toMatchObject({ ok: false, code: "window_not_started" });
  });

  test("a held window mints, and the row carries the dashboard stamp", async () => {
    const b = await bed();
    await b.succeed("first_contact");
    const out = await requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(out.ok).toBe(true);
    const op = (await b.store.getOperation(
      (out as { operationId: string }).operationId,
    ))!;
    expect(op.kind).toBe("mint_invite");
    // The stamp is what routes the URL to the customer instead of an operator.
    expect(JSON.parse(op.evidence).via).toBe("dashboard");
  });

  test("a proven revocation ends minting for good", async () => {
    const b = await bed();
    await b.succeed("first_contact");
    await b.succeed("revoke_access");
    const out = await requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(out).toMatchObject({ ok: false, code: "window_gone" });
  });

  test("every refusal is a whole sentence, because the office page shows it as sent", () => {
    for (const [code, words] of Object.entries(REFUSAL_WORDS)) {
      expect([code, /^(?!\p{Ll})\p{L}/u.test(words)]).toEqual([code, true]);
      expect([code, /[.!?]$/.test(words)]).toEqual([code, true]);
    }
  });

  test("a refused mint is audited as the customer's, and opens nothing", async () => {
    const b = await bed({ linked: false });
    await requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    const audits = (await b.store.auditEvents()).filter(
      (a) => a.action === "request_invite",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: `account:${b.accountId}`,
      outcome: "failed",
    });
    expect(await b.store.operationsFor(b.instanceId)).toHaveLength(0);
  });
});

describe("one active operation, whatever the caller does", () => {
  test("a terminal customer cancellation refuses restart before enqueue", async () => {
    const b = await bed();
    await b.store.tx(async () => {
      const account = await ensureAccount(b.store, {
        id: b.accountId,
        email: "asker@example.com",
      });
      await insertSubscription(b.store, {
        id: "sub-cancelled",
        account_id: account.id,
        instance_id: b.instanceId,
        stripe_customer_id: "cus-cancelled",
        status: "canceled",
        current_period_end: 1,
        cancel_at_period_end: 1,
        ended_at: 1,
        canceled_at: 0,
        cancellation_reason: "cancellation_requested",
        cancellation_policy: "launch",
        discount_percent_off: null,
        discount_coupon_id: null,
        discount_ends_at: null,
        ever_full_discount: 0,
        latest_invoice_id: null,
        payment_failures: 0,
        exhaustion_observed_at: null,
        coupon_grace_until: null,
        episode_id: null,
        last_event_id: null,
        last_event_created: null,
      });
    });
    expect(
      await requestRestart(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({
      ok: false,
      code: "cancellation_suspended",
      reason: REFUSAL_WORDS.cancellation_suspended,
    });
    expect(
      (await b.store.operationsFor(b.instanceId)).some(
        (op) => op.kind === "reboot",
      ),
    ).toBe(false);
  });

  test("a grandfathered cancellation can restart during its serving grace", async () => {
    const b = await bed();
    await b.store.tx(async () => {
      await insertSubscription(b.store, {
        id: "sub-legacy",
        account_id: b.accountId,
        instance_id: b.instanceId,
        stripe_customer_id: "cus-legacy",
        status: "canceled",
        current_period_end: b.store.now(),
        cancel_at_period_end: 1,
        ended_at: b.store.now(),
        canceled_at: 0,
        cancellation_reason: "cancellation_requested",
        cancellation_policy: "legacy",
        discount_percent_off: null,
        discount_coupon_id: null,
        discount_ends_at: null,
        ever_full_discount: 0,
        latest_invoice_id: null,
        payment_failures: 0,
        exhaustion_observed_at: null,
        coupon_grace_until: null,
        episode_id: null,
        last_event_id: null,
        last_event_created: null,
      });
    });
    expect(
      await requestRestart(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: true });
  });
  test("a second mint is refused while one is live", async () => {
    const b = await bed();
    await b.succeed("first_contact");
    const first = await requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(first.ok).toBe(true);
    expect(
      await requestInvite(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "mint_in_progress" });
    expect(
      (await b.store.operationsFor(b.instanceId)).filter(
        (o) => o.kind === "mint_invite",
      ),
    ).toHaveLength(1);
  });

  test("a resend is allowed once the previous one is terminal", async () => {
    const b = await bed();
    await b.succeed("first_contact");
    await b.succeed("mint_invite");
    const again = await requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(again.ok).toBe(true);
  });

  test("a second restart is refused while one is live", async () => {
    const b = await bed();
    expect(
      (
        await requestRestart(b.store, {
          accountId: b.accountId,
          instanceId: b.instanceId,
        })
      ).ok,
    ).toBe(true);
    expect(
      await requestRestart(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "restart_in_progress" });
  });

  test("a restart with no box is refused before anything is opened", async () => {
    const b = await bed({ linked: false });
    expect(
      await requestRestart(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "no_box" });
    expect(await b.store.operationsFor(b.instanceId)).toHaveLength(0);
  });
});

// A box we powered off comes back only through power_on (resume after payment,
// or reinstatement). A restart is a provider power action too, and must not be a
// way around paying.
describe("a suspended office is not restarted", () => {
  const EPISODE = "dun-evt_restart";

  async function subscribe(
    b: Bed,
    over: Partial<{
      status: string;
      ended_at: number | null;
      cancellation_reason: string | null;
      cancellation_policy: "launch" | "legacy";
    }>,
  ): Promise<void> {
    await b.store.tx(async () => {
      await insertSubscription(b.store, {
        id: "sub-1",
        account_id: b.accountId,
        instance_id: b.instanceId,
        stripe_customer_id: "cus-1",
        status: over.status ?? "active",
        current_period_end: null,
        cancel_at_period_end: 0,
        ended_at: over.ended_at ?? null,
        canceled_at: null,
        cancellation_reason: over.cancellation_reason ?? null,
        ...(over.cancellation_policy
          ? { cancellation_policy: over.cancellation_policy }
          : {}),
        discount_percent_off: null,
        discount_coupon_id: null,
        discount_ends_at: null,
        ever_full_discount: 0,
        latest_invoice_id: null,
        payment_failures: 3,
        exhaustion_observed_at: null,
        coupon_grace_until: null,
        episode_id: null,
        last_event_id: null,
        last_event_created: null,
      });
    });
  }

  /** The rows a finished power_off leaves: its own succeeded row, stamped by
   * its opener, and the service state the ticker writes on success. */
  async function poweredOff(b: Bed, evidence: Record<string, unknown>) {
    await b.store.enqueue({
      id: suspensionOperationId(EPISODE),
      instance_id: b.instanceId,
      kind: "power_off",
      status: "succeeded",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { ...evidence, poweredOffAt: b.store.now() - 60_000 },
    });
    await setServiceState(b, "suspended");
  }

  async function setServiceState(b: Bed, state: "suspended" | "live") {
    const instance = (await b.store.getInstance(b.instanceId))!;
    expect(
      await b.store.casInstance(instance.id, instance.version, {
        service_state: state,
      }),
    ).not.toBeNull();
  }

  const dunning = {
    reason: "dunning",
    subscription: "sub-1",
    episode: EPISODE,
  };

  async function restart(b: Bed) {
    return await requestRestart(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
  }

  async function nothingOpened(b: Bed) {
    expect(
      (await b.store.operationsFor(b.instanceId)).some(
        (op) => op.kind === "reboot",
      ),
    ).toBe(false);
    expect(
      (await b.store.auditEvents()).some((a) => a.action === "request_restart"),
    ).toBe(false);
  }

  for (const billing of [
    { status: "past_due" },
    { status: "unpaid" },
    {
      status: "canceled",
      ended_at: 1,
      cancellation_reason: "payment_failed",
    },
  ]) {
    test(`a dunning suspension (${billing.status}${billing.cancellation_reason ? `, ${billing.cancellation_reason}` : ""}) refuses restart before enqueue`, async () => {
      const b = await bed();
      await subscribe(b, billing);
      await poweredOff(b, dunning);
      expect(await restart(b)).toMatchObject({
        ok: false,
        code: "payment_suspended",
        reason: REFUSAL_WORDS.payment_suspended,
      });
      await nothingOpened(b);
    });
  }

  test("a customer who cancels during a dunning suspension still cannot restart in the grace", async () => {
    // Without the suspension this subscription is in its serving grace and may
    // restart (the grandfathered test above). The refusal must therefore come
    // from the suspension, and say so: payment, not cancellation.
    const b = await bed();
    await subscribe(b, {
      status: "canceled",
      ended_at: b.store.now(),
      cancellation_reason: "cancellation_requested",
      cancellation_policy: "legacy",
    });
    await poweredOff(b, dunning);
    expect(await restart(b)).toMatchObject({
      ok: false,
      code: "payment_suspended",
    });
    await nothingOpened(b);
  });

  test("past the grace, the cancellation's refusal wins over the suspension's", async () => {
    const b = await bed();
    await subscribe(b, {
      status: "canceled",
      ended_at: 1,
      cancellation_reason: "cancellation_requested",
      cancellation_policy: "launch",
    });
    await poweredOff(b, dunning);
    expect(await restart(b)).toMatchObject({
      ok: false,
      code: "cancellation_suspended",
    });
    await nothingOpened(b);
  });

  test("a suspension whose power_off carries no dunning stamp is refused too", async () => {
    // Fails closed: whatever opened it, a suspended box does not come back
    // through a restart.
    const b = await bed();
    await subscribe(b, { status: "past_due" });
    await poweredOff(b, {});
    expect(await restart(b)).toMatchObject({
      ok: false,
      code: "payment_suspended",
    });
    await nothingOpened(b);
  });

  test("an office resumed after payment can restart again", async () => {
    const b = await bed();
    await subscribe(b, { status: "active" });
    await poweredOff(b, dunning);
    await b.store.enqueue({
      id: `op-power_on-${EPISODE}`,
      instance_id: b.instanceId,
      kind: "power_on",
      status: "succeeded",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { ...dunning, poweredOnAt: b.store.now() },
    });
    await setServiceState(b, "live");
    expect(await restart(b)).toMatchObject({ ok: true });
  });
});

describe("confirming the handoff", () => {
  test("an office that is not serving yet cannot be handed off", async () => {
    // The same rule the operator path keeps: we do not give up the only access
    // we have to a box we never proved was live.
    const b = await bed();
    await b.succeed("first_contact");
    expect(
      await confirmHandoff(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "not_live" });
  });

  test("confirming opens the revocation and stamps it as theirs", async () => {
    const b = await bed();
    await b.succeed("first_contact");
    await b.succeed("verify_https");
    const out = await confirmHandoff(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(out.ok).toBe(true);
    const op = (await b.store.getOperation(
      (out as { operationId: string }).operationId,
    ))!;
    expect(op.kind).toBe("revoke_access");
    expect(JSON.parse(op.evidence).via).toBe("dashboard");
    expect(
      (await b.store.auditEvents()).some((a) => a.action === "confirm_handoff"),
    ).toBe(true);
  });

  test("clicking twice is not an error and opens nothing new", async () => {
    const b = await bed();
    await b.succeed("first_contact");
    await b.succeed("verify_https");
    const first = await confirmHandoff(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    const second = await confirmHandoff(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(second).toMatchObject({ ok: true, alreadyOpen: true });
    expect((second as { operationId: string }).operationId).toBe(
      (first as { operationId: string }).operationId,
    );
    expect(
      (await b.store.operationsFor(b.instanceId)).filter(
        (o) => o.kind === "revoke_access",
      ),
    ).toHaveLength(1);
  });

  test("an already-proven revocation says so rather than trying again", async () => {
    const b = await bed();
    await b.succeed("first_contact");
    await b.succeed("verify_https");
    await b.succeed("revoke_access");
    expect(
      await confirmHandoff(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "already_revoked" });
  });
});
