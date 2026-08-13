// The customer's three verbs: who may ask, when, and what stops a second one.
//
// The interesting assertions here are the refusals. A verb that opens the right
// row on the happy path and opens a second one under a double click is not a
// verb, it is a race with a nice name.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  confirmHandoff,
  requestInvite,
  requestRestart,
  REFUSAL_WORDS,
} from "./requests.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { Store, type OperationStatus } from "./store.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";

const temps: string[] = [];

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Bed {
  store: Store;
  accountId: string;
  instanceId: string;
  succeed(kind: string): Promise<void>;
  open(kind: string, status?: OperationStatus): Promise<string>;
}

async function bed(opts: { linked?: boolean } = {}): Promise<Bed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-requests-"));
  temps.push(dir);
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
    // The wording matters: there is no later attempt that would work, so it
    // does not invite one.
    expect(REFUSAL_WORDS.window_gone).toContain("Contact support");
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
    ).toMatchObject({ ok: false, code: "cancellation_suspended" });
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

  /**
   * THE INDEX IS THE ARBITER, not the pre-check.
   *
   * This is the property that survives two callers passing the pre-check in the
   * same instant, so it is asserted against the database directly rather than
   * through the function that also asks nicely first.
   */
  test("the database itself refuses the second row", async () => {
    const b = await bed();
    await b.open("reboot");
    expect(b.open("reboot")).rejects.toThrow(/UNIQUE|constraint/i);
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
