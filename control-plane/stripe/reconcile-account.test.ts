// Which account a newly cached subscription belongs to (task 18266744).
//
// Checkout puts the buyer's account id and email in the session metadata. The
// email is a copy of a field the customer can change before the first Stripe
// event arrives, and another customer can then take the old address over. The
// id is what the server itself decided, so it is the one that binds the row:
// a Stripe customer bound by the stale email lands on whoever reads the old
// inbox.

import { afterEach, describe, expect, test } from "bun:test";
import {
  accountForEmailSignIn,
  changeAccountEmail,
  reserveOffice,
  stripeCustomersForAccount,
} from "../signup.ts";
import type { Store } from "../store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "../testing/pg.ts";
import { ensureAccount, getSubscription } from "./billing-store.ts";
import { META_ACCOUNT, META_EMAIL, META_INSTANCE } from "./metadata.ts";
import { applyEvent } from "./reconcile.ts";
import type { SubscriptionSnapshot } from "./shapes.ts";

const NOW = 1_777_000_000_000;
const OLD = "old-victim@example.test";
const NEW = "new-victim@example.test";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

function paid(
  id: string,
  metadata: Record<string, string>,
): SubscriptionSnapshot {
  return {
    id,
    customerId: `cus-${id}`,
    status: "active",
    currentPeriodEnd: NOW + 2_592_000_000,
    cancelAtPeriodEnd: false,
    endedAt: null,
    canceledAt: null,
    cancellationReason: null,
    discount: null,
    latestInvoiceId: null,
    metadata,
    livemode: false,
  };
}

function created(eventId: string, subscription: SubscriptionSnapshot) {
  return {
    eventId,
    eventType: "customer.subscription.created",
    eventCreated: NOW,
    subscription,
    now: NOW,
  };
}

async function claimed(store: Store, eventId: string): Promise<boolean> {
  return (
    (await store.sqlGet("select id from stripe_events where id = $1", [
      eventId,
    ])) !== null
  );
}

/** The victim's account and office, and the metadata Checkout froze for it
 * while the account still had the old address. */
async function victimWithCheckout(store: Store) {
  const victim = await accountForEmailSignIn(store, OLD);
  const made = await reserveOffice(
    store,
    { accountId: victim.id, officeName: "victimoffice", plan: "office" },
    { now: () => NOW },
  );
  if (!made.ok) throw new Error(made.reason);
  const metadata = {
    [META_ACCOUNT]: victim.id,
    [META_EMAIL]: victim.email,
    [META_INSTANCE]: made.reservation.instance_id,
  };
  const moved = await changeAccountEmail(store, {
    accountId: victim.id,
    newEmail: NEW,
  });
  expect(moved).toMatchObject({ ok: true, changed: true });
  return { victim, metadata };
}

describe("a new subscription binds to the account id Checkout recorded", () => {
  test("not to the account that took the buyer's old address", async () => {
    const store = await openTestStore(() => NOW);
    const { victim, metadata } = await victimWithCheckout(store);
    const other = await accountForEmailSignIn(store, OLD);
    expect(other.id).not.toBe(victim.id);

    const sub = paid("sub-victim", metadata);
    await store.tx(() => applyEvent(store, created("evt-victim", sub)));

    expect((await getSubscription(store, sub.id))?.account_id).toBe(victim.id);
    expect(await stripeCustomersForAccount(store, victim.id)).toEqual([
      sub.customerId,
    ]);
    expect(await stripeCustomersForAccount(store, other.id)).toEqual([]);
    expect(await claimed(store, "evt-victim")).toBe(true);
  });

  test("when nobody holds the old address any more", async () => {
    const store = await openTestStore(() => NOW);
    const { victim, metadata } = await victimWithCheckout(store);

    const sub = paid("sub-alone", metadata);
    await store.tx(() => applyEvent(store, created("evt-alone", sub)));

    expect((await getSubscription(store, sub.id))?.account_id).toBe(victim.id);
    expect(await claimed(store, "evt-alone")).toBe(true);
  });

  test("an existing account named without an email still owns the row", async () => {
    const store = await openTestStore(() => NOW);
    const buyer = await accountForEmailSignIn(store, "buyer@example.test");

    const sub = paid("sub-no-email", { [META_ACCOUNT]: buyer.id });
    await store.tx(() => applyEvent(store, created("evt-no-email", sub)));

    expect((await getSubscription(store, sub.id))?.account_id).toBe(buyer.id);
  });

  test("an unknown id whose email another account holds is refused, not rebound", async () => {
    const store = await openTestStore(() => NOW);
    await store.tx(() =>
      ensureAccount(store, { id: "acct-holder", email: OLD }),
    );

    const sub = paid("sub-orphan", {
      [META_ACCOUNT]: "acct-missing",
      [META_EMAIL]: OLD,
    });
    const failure = await store
      .tx(() => applyEvent(store, created("evt-orphan", sub)))
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(failure).toBeInstanceOf(Error);
    // The error reaches the webhook log line: it names the subscription and
    // both ids, and carries no address.
    const message = (failure as Error).message;
    expect(message).toContain(sub.id);
    expect(message).toContain("acct-missing");
    expect(message).toContain("acct-holder");
    expect(message).not.toContain(OLD);
    expect(await getSubscription(store, sub.id)).toBeNull();
    expect(await claimed(store, "evt-orphan")).toBe(false);
  });
});
