// Checkout: the comped branch, the name rules, and the fact that creating a
// session writes NOTHING to our store.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "../testing/pg.ts";
import { listAccounts, listSubscriptions } from "./billing-store.ts";
import { StripeClient, formEncode, type FetchLike } from "./client.ts";
import {
  CheckoutCreationError,
  RESERVED_OFFICE_NAMES,
  checkoutParams,
  createCheckoutSession,
  validateOfficeName,
  verifyFullDiscount,
  openCheckout,
  type FullDiscount,
} from "./checkout.ts";
import { createOwnedCustomer, ownedCustomerParams } from "./test-clock.ts";

const TEST_KEY = "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE";
const LIVE_SHAPE = "rk_live_NOT_A_REAL_KEY_ONLY_A_SHAPE";
const temps: string[] = [];

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-checkout-"));
  temps.push(dir);
  return await openTestStore();
}

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

function clientReturning(body: unknown): {
  client: StripeClient;
  bodies: string[];
} {
  const bodies: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    if (typeof init?.body === "string") bodies.push(init.body);
    return { ok: true, status: 200, json: async () => body };
  };
  return {
    client: new StripeClient({ key: TEST_KEY, mode: "test", fetchImpl }),
    bodies,
  };
}

/**
 * The only way to get a FullDiscount is to verify one, so even the params tests go
 * through the real check. That is the property: no test, and no caller, can
 * fabricate the value that unlocks `if_required`.
 */
async function verifiedFullDiscount(): Promise<FullDiscount> {
  const { client } = clientReturning({
    id: "co_full",
    object: "coupon",
    percent_off: 100,
    valid: true,
    livemode: false,
  });
  const verdict = await verifyFullDiscount(client, "co_full");
  if (!verdict.ok)
    throw new Error(`fixture is not a full discount: ${verdict.reason}`);
  return verdict.discount;
}

const base = {
  accountId: "acct-1",
  email: "buyer@example.com",
  officeName: "acme",
  priceId: "price_1",
  successUrl: "https://cloud.isomux.com/welcome",
  cancelUrl: "https://isomux.com/hosted",
};

describe("the comped path", () => {
  test("every session is a Managed Payments session", () => {
    const encoded = formEncode(checkoutParams(base));
    expect(encoded).toContain("managed_payments%5Benabled%5D=true");
  });

  test("every session requires recorded terms acceptance", () => {
    const encoded = formEncode(checkoutParams(base));
    expect(encoded).toContain(
      "consent_collection%5Bterms_of_service%5D=required",
    );
  });

  test("merchant-of-record parameters stay under Stripe's control", () => {
    const encoded = formEncode(checkoutParams(base));
    // Stripe's update-checkout removal list, checked 2026-08-16. These are the
    // parameters most likely to be added by an ordinary Checkout integration.
    for (const parameter of [
      "automatic_tax",
      "tax_id_collection",
      "invoice_creation",
      "custom_text",
      "customer_update[address]",
      "customer_update[name]",
      "payment_method_types",
      "subscription_data[invoice_settings]",
      "payment_intent_data[statement_descriptor]",
      "payment_intent_data[statement_descriptor_suffix]",
    ]) {
      expect(encoded).not.toContain(encodeURIComponent(parameter));
    }
  });

  test("a VERIFIED full discount means if_required, so Checkout collects no card", async () => {
    const params = checkoutParams({
      ...base,
      discount: await verifiedFullDiscount(),
    });
    expect(params.payment_method_collection).toBe("if_required");
    expect(params["discounts[0][coupon]"]).toBe("co_full");
  });

  test("without a coupon the card is collected, stated explicitly", async () => {
    // NO TRIAL (ruling 1): the only reason a card is not collected is that a 100%
    // discount leaves nothing to charge. Relying on Stripe's default here would
    // make that silent.
    const params = checkoutParams(base);
    expect(params.payment_method_collection).toBe("always");
    expect(params["discounts[0][coupon]"]).toBeUndefined();
  });

  test("our metadata rides on the session AND the subscription", async () => {
    const params = checkoutParams({ ...base, instanceId: "inst-1" });
    const encoded = formEncode(params);
    for (const key of [
      "metadata%5Bisomux_account%5D=acct-1",
      "metadata%5Bisomux_office_name%5D=acme",
      "metadata%5Bisomux_instance%5D=inst-1",
      "subscription_data%5Bmetadata%5D%5Bisomux_account%5D=acct-1",
    ]) {
      expect(encoded).toContain(key);
    }
  });

  test("reinstatement identity and technical expiry ride on Checkout", () => {
    const params = checkoutParams({
      ...base,
      instanceId: "inst-retained",
      reinstatementAttemptId: "reinstate-sub-old",
      expiresAt: 1_800_000_000,
    });
    expect(params.expires_at).toBe(1_800_000_000);
    const encoded = formEncode(params);
    expect(encoded).toContain(
      "metadata%5Bisomux_reinstatement%5D=reinstate-sub-old",
    );
    expect(encoded).toContain(
      "subscription_data%5Bmetadata%5D%5Bisomux_reinstatement%5D=reinstate-sub-old",
    );
  });

  test("a pre-made customer replaces the email, never both", async () => {
    const withCustomer = checkoutParams({ ...base, customerId: "cus_clock" });
    expect(withCustomer.customer).toBe("cus_clock");
    expect(withCustomer.customer_email).toBeUndefined();
    const withoutCustomer = checkoutParams(base);
    expect(withoutCustomer.customer_email).toBe("buyer@example.com");
    expect(withoutCustomer.customer).toBeUndefined();
  });
});

describe("verifying a coupon before trusting it", () => {
  // A coupon ID IS NOT PROOF. The design lets Checkout skip collecting a card only
  // when nothing is owed, and a 50%-off or expired coupon has the same shape as a
  // full one. Everything below is a refusal that used to be a silent yes.
  function couponClient(body: unknown, status = 200) {
    const fetchImpl: FetchLike = async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    return new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl,
      attempts: 1,
      sleep: async () => {},
    });
  }

  test("a valid 100%-off test coupon verifies", async () => {
    const verdict = await verifyFullDiscount(
      couponClient({
        id: "co_full",
        percent_off: 100,
        valid: true,
        livemode: false,
      }),
      "co_full",
    );
    expect(verdict.ok).toBe(true);
  });

  test("a partial discount is refused, and says what it saw", async () => {
    const verdict = await verifyFullDiscount(
      couponClient({
        id: "co_half",
        percent_off: 50,
        valid: true,
        livemode: false,
      }),
      "co_half",
    );
    expect(verdict).toMatchObject({ ok: false, retryable: false });
    if (!verdict.ok) expect(verdict.reason).toContain("50% off");
  });

  test("an amount-off coupon is refused", async () => {
    const verdict = await verifyFullDiscount(
      couponClient({
        id: "co_five",
        percent_off: null,
        amount_off: 500,
        valid: true,
        livemode: false,
      }),
      "co_five",
    );
    expect(verdict).toMatchObject({ ok: false, retryable: false });
    if (!verdict.ok) expect(verdict.reason).toContain("amount-off");
  });

  test("an expired or fully redeemed coupon is refused", async () => {
    const verdict = await verifyFullDiscount(
      couponClient({
        id: "co_old",
        percent_off: 100,
        valid: false,
        livemode: false,
      }),
      "co_old",
    );
    expect(verdict).toMatchObject({ ok: false, retryable: false });
    if (!verdict.ok) expect(verdict.reason).toContain("not valid");
  });

  test("a LIVE-mode coupon is refused outright", async () => {
    const verdict = await verifyFullDiscount(
      couponClient({
        id: "co_live",
        percent_off: 100,
        valid: true,
        livemode: true,
      }),
      "co_live",
    );
    expect(verdict).toMatchObject({ ok: false, retryable: false });
    if (!verdict.ok)
      expect(verdict.reason).toContain("does not match configured test mode");
  });

  test("a synthetic live coupon verifies for an explicit live client", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "co_live_shape",
        percent_off: 100,
        valid: true,
        livemode: true,
      }),
    });
    const client = new StripeClient({
      key: LIVE_SHAPE,
      mode: "live",
      fetchImpl,
    });
    expect((await verifyFullDiscount(client, "co_live_shape")).ok).toBe(true);
  });

  test("a malformed coupon is refused rather than read optimistically", async () => {
    for (const body of [
      {},
      { id: "co_x", valid: true, livemode: false },
      { id: "co_y", percent_off: "100", valid: true, livemode: false },
    ]) {
      const verdict = await verifyFullDiscount(couponClient(body), "co_x");
      expect(verdict.ok).toBe(false);
    }
  });

  test("a missing coupon is refused and not retried", async () => {
    const verdict = await verifyFullDiscount(
      couponClient({ error: { type: "invalid_request_error" } }, 404),
      "co_nope",
    );
    expect(verdict).toMatchObject({
      ok: false,
      retryable: false,
      reason: "no such coupon",
    });
  });

  test("an unavailable read is RETRYABLE, and no session may be built on it", async () => {
    const verdict = await verifyFullDiscount(
      couponClient({ error: { type: "api_error" } }, 503),
      "co_full",
    );
    expect(verdict).toMatchObject({ ok: false, retryable: true });
  });
});

describe("office names", () => {
  test("a plain label is accepted", async () => {
    for (const name of ["acme", "a", "acme-corp", "acme2", "a1-b2-c3"]) {
      expect(validateOfficeName(name)).toEqual({ ok: true });
    }
  });

  test("anything that is not one DNS label is refused", async () => {
    for (const name of [
      "",
      "-acme",
      "acme-",
      "ACME",
      "acme corp",
      "acme.corp",
      "acme_corp",
      "a".repeat(64),
      "xn--acme",
    ]) {
      expect(validateOfficeName(name).ok).toBe(false);
    }
  });

  test("hostnames we serve centrally are refused", async () => {
    for (const name of ["www", "api", "admin", "cloud", "apps", "mail"]) {
      expect(RESERVED_OFFICE_NAMES.has(name)).toBe(true);
      expect(validateOfficeName(name).ok).toBe(false);
    }
  });

  test("a refused name stops the session before any request is made", async () => {
    const { client, bodies } = clientReturning({ id: "cs_1", livemode: false });
    expect(
      createCheckoutSession(client, { ...base, officeName: "www" }, "k"),
    ).rejects.toThrow(/serve centrally/);
    expect(bodies).toEqual([]);
  });
});

describe("what comes back", () => {
  test("Stripe's own answer about collecting a card is reported, not assumed", async () => {
    // The verify-at-implementation item is what Stripe DOES, so the caller records
    // the value Stripe returned rather than the one we asked for.
    const { client } = clientReturning({
      id: "cs_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_x",
      payment_method_collection: "if_required",
      livemode: false,
      expires_at: 1_800_000_000,
    });
    const session = await createCheckoutSession(
      client,
      { ...base, discount: await verifiedFullDiscount() },
      "k",
    );
    expect(session).toMatchObject({
      id: "cs_1",
      paymentMethodCollection: "if_required",
      livemode: false,
    });
  });

  test("a session that reports live mode is refused before any URL is handed out", async () => {
    const { client } = clientReturning({
      id: "cs_1",
      url: "https://checkout.stripe.com/c/pay/live",
      livemode: true,
    });
    expect(createCheckoutSession(client, base, "k")).rejects.toThrow(
      /does not match configured test mode/,
    );
  });

  test("an explicit live client accepts a synthetic live session", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "cs_live_shape",
        url: "https://checkout.stripe.com/c/pay/live-shape",
        livemode: true,
        expires_at: 1_800_000_000,
      }),
    });
    const client = new StripeClient({
      key: LIVE_SHAPE,
      mode: "live",
      fetchImpl,
    });
    expect(
      await createCheckoutSession(client, base, "live-shape-key"),
    ).toMatchObject({
      id: "cs_live_shape",
      livemode: true,
    });
  });

  test("session creation preserves ambiguous versus definite failure", async () => {
    const ambiguous = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      attempts: 1,
      fetchImpl: async () => {
        throw new Error("injected network loss");
      },
    });
    expect(
      createCheckoutSession(ambiguous, base, "ambiguous-key"),
    ).rejects.toMatchObject({
      ambiguous: true,
    } satisfies Partial<CheckoutCreationError>);
    const rejected = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      attempts: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "bad price" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(
      createCheckoutSession(rejected, base, "rejected-key"),
    ).rejects.toMatchObject({
      ambiguous: false,
    } satisfies Partial<CheckoutCreationError>);
  });
});

describe("checkout writes nothing", () => {
  test("creating a session leaves the store untouched", async () => {
    // Webhooks are the only writer of subscription state. A session is a Stripe
    // object and a redirect; if this test ever fails, something has started
    // trusting one of those.
    const store = await tempStore();
    const { client } = clientReturning({
      id: "cs_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_x",
      payment_method_collection: "always",
      livemode: false,
      expires_at: 1_800_000_000,
    });
    await createCheckoutSession(client, base, "k");
    expect(await listSubscriptions(store)).toEqual([]);
    expect(await listAccounts(store)).toEqual([]);
    expect(await store.auditEvents()).toEqual([]);
  });
});

describe("creating the customer we own", () => {
  // Every other Stripe object in this flow is checked for mode and shape; the
  // customer was the arm that was not, and `String(body.id)` on a malformed response
  // produces the customer id "undefined".
  function customerClient(body: unknown, status = 200) {
    const requests: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      requests.push(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    };
    return {
      client: new StripeClient({
        key: TEST_KEY,
        mode: "test",
        fetchImpl,
        attempts: 1,
        sleep: async () => {},
      }),
      requests,
    };
  }

  test("a test-mode customer with an id is accepted, and carries the tag", async () => {
    const { client, requests } = customerClient({
      id: "cus_1",
      livemode: false,
    });
    const out = await createOwnedCustomer(
      client,
      { email: "a@example.com", label: "acme" },
      "k",
    );
    expect(out).toEqual({ ok: true, id: "cus_1" });
    expect(requests[0]).toContain("/v1/customers");
    expect(
      ownedCustomerParams({ email: "a@example.com", label: "acme" }),
    ).toMatchObject({ metadata: { isomux_test: "slice3" }, name: "cp3-acme" });
  });

  test("a LIVE-mode customer is refused and not retried", async () => {
    const { client } = customerClient({ id: "cus_live", livemode: true });
    const out = await createOwnedCustomer(
      client,
      { email: "a@e.com", label: "x" },
      "k",
    );
    expect(out).toMatchObject({ ok: false, retryable: false });
    if (!out.ok)
      expect(out.reason).toContain("does not match configured test mode");
  });

  test("an explicit live client accepts a synthetic live customer", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "cus_live_shape", livemode: true }),
    });
    const client = new StripeClient({
      key: LIVE_SHAPE,
      mode: "live",
      fetchImpl,
    });
    expect(
      await createOwnedCustomer(
        client,
        { email: "shape@example.invalid", label: "shape" },
        "live-customer-shape",
      ),
    ).toEqual({ ok: true, id: "cus_live_shape" });
  });

  test("a missing or non-boolean livemode is refused", async () => {
    for (const body of [{ id: "cus_1" }, { id: "cus_1", livemode: "false" }]) {
      const { client } = customerClient(body);
      const out = await createOwnedCustomer(
        client,
        { email: "a@e.com", label: "x" },
        "k",
      );
      expect(out).toMatchObject({ ok: false, retryable: false });
    }
  });

  test("a missing or non-string id is refused rather than stringified", async () => {
    for (const body of [
      { livemode: false },
      { id: 42, livemode: false },
      { id: "", livemode: false },
    ]) {
      const { client } = customerClient(body);
      const out = await createOwnedCustomer(
        client,
        { email: "a@e.com", label: "x" },
        "k",
      );
      expect(out).toMatchObject({
        ok: false,
        retryable: false,
        reason: "the customer Stripe returned has no id",
      });
    }
  });

  test("an unestablished creation is RETRYABLE, never assumed", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connection reset");
    };
    const client = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl,
      attempts: 1,
      sleep: async () => {},
    });
    const out = await createOwnedCustomer(
      client,
      { email: "a@e.com", label: "x" },
      "k",
    );
    expect(out).toMatchObject({ ok: false, retryable: true });
  });
});

describe("the order a checkout is opened in", () => {
  /** Answer each request in turn, and record which endpoints were reached. */
  function scriptedClient(answers: { status?: number; body: unknown }[]) {
    const paths: string[] = [];
    let i = 0;
    const fetchImpl: FetchLike = async (url) => {
      paths.push(new URL(url).pathname);
      const answer = answers[Math.min(i, answers.length - 1)];
      i++;
      const status = answer.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => answer.body,
      };
    };
    return {
      client: new StripeClient({
        key: TEST_KEY,
        mode: "test",
        fetchImpl,
        attempts: 1,
        sleep: async () => {},
      }),
      paths,
    };
  }

  const opening = {
    accountId: "acct-1",
    email: "buyer@example.com",
    officeName: "acme",
    priceId: "price_1",
    label: "acme",
    successUrl: "https://cloud.isomux.com/welcome",
    cancelUrl: "https://isomux.com/hosted",
    idempotencyKeys: { customer: "kc", session: "ks" },
  };

  test("coupon, then customer, then session", async () => {
    const { client, paths } = scriptedClient([
      {
        body: { id: "co_full", percent_off: 100, valid: true, livemode: false },
      },
      { body: { id: "cus_1", livemode: false } },
      {
        body: {
          id: "cs_1",
          url: "https://checkout.stripe.com/c/pay/x",
          payment_method_collection: "if_required",
          livemode: false,
          expires_at: 1_800_000_000,
        },
      },
    ]);
    const out = await openCheckout(client, { ...opening, couponId: "co_full" });
    expect(out.ok).toBe(true);
    expect(paths).toEqual([
      "/v1/coupons/co_full",
      "/v1/customers",
      "/v1/checkout/sessions",
    ]);
  });

  test("a REFUSED CUSTOMER creates no session", async () => {
    const { client, paths } = scriptedClient([
      { body: { id: "cus_live", livemode: true } },
    ]);
    const out = await openCheckout(client, opening);
    expect(out).toMatchObject({ ok: false, retryable: false });
    expect(paths).toEqual(["/v1/customers"]);
  });

  test("a REFUSED COUPON creates no customer and no session", async () => {
    // The read-only check comes first for exactly this reason: a refusal here has
    // created nothing at all.
    const { client, paths } = scriptedClient([
      {
        body: { id: "co_half", percent_off: 50, valid: true, livemode: false },
      },
    ]);
    const out = await openCheckout(client, { ...opening, couponId: "co_half" });
    expect(out).toMatchObject({ ok: false, retryable: false });
    expect(paths).toEqual(["/v1/coupons/co_half"]);
  });

  test("a bad office name reaches Stripe not at all", async () => {
    const { client, paths } = scriptedClient([{ body: {} }]);
    const out = await openCheckout(client, { ...opening, officeName: "www" });
    expect(out).toMatchObject({ ok: false, retryable: false });
    expect(paths).toEqual([]);
  });

  test("a caller's own customer is used as-is, with no customer created", async () => {
    const { client, paths } = scriptedClient([
      {
        body: {
          id: "cs_1",
          payment_method_collection: "always",
          livemode: false,
          expires_at: 1_800_000_000,
        },
      },
    ]);
    const out = await openCheckout(client, {
      ...opening,
      customerId: "cus_clock",
    });
    expect(out.ok).toBe(true);
    expect(paths).toEqual(["/v1/checkout/sessions"]);
  });
});
