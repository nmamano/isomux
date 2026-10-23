// The transport: the live-key refusal, form encoding, and what a retry means.
//
// Every key in this file is a SHAPE. No real credential appears here, and no
// assertion echoes a matched value.

import { describe, expect, test } from "bun:test";
import {
  STRIPE_API_VERSION,
  StripeClient,
  StripeKeyRefused,
  formEncode,
  type FetchLike,
} from "./client.ts";

const TEST_KEY = "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE";
const LIVE_SHAPE = "rk_live_NOT_A_REAL_KEY_ONLY_A_SHAPE";
const LIVE_ACCOUNT_SHAPE = "sk_live_NOT_A_REAL_KEY_ONLY_A_SHAPE";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function recorder(
  responses: Array<{ status: number; body: unknown } | { throws: string }>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if ("throws" in next) throw new Error(next.throws);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("the live-key refusal", () => {
  test("a key that does not match the configured mode is refused before any request", async () => {
    const refused: [string, "test" | "live"][] = [
      [LIVE_SHAPE, "test"],
      ["rk_live_ANOTHER_SHAPE", "test"],
      ["", "test"],
      ["sk_", "test"],
      ["pk_test_something", "test"],
      ["hunter2", "test"],
      [TEST_KEY, "live"],
      // Live mode takes a restricted key only.
      [LIVE_ACCOUNT_SHAPE, "live"],
    ];
    for (const [key, mode] of refused) {
      const { fetchImpl, calls } = recorder([{ status: 200, body: {} }]);
      expect(() => new StripeClient({ key, mode, fetchImpl })).toThrow(
        StripeKeyRefused,
      );
      expect(calls).toHaveLength(0);
    }
  });

  test("each mode accepts its own keys", async () => {
    const accepted: [string, "test" | "live"][] = [
      [TEST_KEY, "test"],
      ["rk_test_A_SHAPE", "test"],
      [LIVE_SHAPE, "live"],
    ];
    for (const [key, mode] of accepted) {
      const { fetchImpl, calls } = recorder([{ status: 200, body: {} }]);
      const client = new StripeClient({ key, mode, fetchImpl });
      expect((await client.get("/v1/customers/cus_shape")).kind).toBe("ok");
      expect(calls).toHaveLength(1);
    }
  });

  test("the refusal message does not echo the key", async () => {
    for (const [key, mode] of [
      [LIVE_SHAPE, "test"],
      [LIVE_ACCOUNT_SHAPE, "live"],
    ] as const) {
      const { fetchImpl } = recorder([{ status: 200, body: {} }]);
      let message = "";
      try {
        new StripeClient({ key, mode, fetchImpl });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("NOT_A_REAL_KEY");
    }
  });
});

describe("form encoding", () => {
  test("nests objects and indexes arrays the way Stripe expects", async () => {
    expect(
      formEncode({
        mode: "subscription",
        subscription_data: { metadata: { isomux_account: "acct-1" } },
        expand: ["discounts", "customer"],
      }),
    ).toBe(
      "mode=subscription&subscription_data%5Bmetadata%5D%5Bisomux_account%5D=acct-1" +
        "&expand%5B0%5D=discounts&expand%5B1%5D=customer",
    );
  });

  test("drops undefined and keeps null, because they mean different things", async () => {
    // undefined lets a caller spread an optional parameter; null is how Stripe is
    // told to CLEAR a field. Collapsing them would silently clear things.
    expect(formEncode({ a: undefined, b: null, c: 0, d: false })).toBe(
      "b=&c=0&d=false",
    );
  });

  test("escapes values", async () => {
    expect(formEncode({ email: "a+b@example.com" })).toBe(
      "email=a%2Bb%40example.com",
    );
  });
});

describe("headers", () => {
  test("every request pins the API version", async () => {
    const { fetchImpl, calls } = recorder([{ status: 200, body: { id: "x" } }]);
    const client = new StripeClient({ key: TEST_KEY, mode: "test", fetchImpl });
    await client.get("/v1/customers", { limit: 1 });
    expect(calls[0].headers["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/customers?limit=1");
  });

  test("a write carries its idempotency key, and an unkeyed write is refused", async () => {
    const { fetchImpl, calls } = recorder([{ status: 200, body: { id: "x" } }]);
    const client = new StripeClient({ key: TEST_KEY, mode: "test", fetchImpl });
    await client.post("/v1/coupons", { percent_off: 100 }, "key-1");
    expect(calls[0].headers["Idempotency-Key"]).toBe("key-1");
    expect(
      client.post("/v1/coupons", { percent_off: 100 }, ""),
    ).rejects.toThrow(/idempotency key/);
  });
});

describe("classification", () => {
  test("a transport failure is ambiguous, never rejected", async () => {
    const { fetchImpl } = recorder([{ throws: "socket hang up" }]);
    const client = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl,
      attempts: 1,
      sleep: noSleep,
    });
    const res = await client.get("/v1/customers/cus_1");
    expect(res.kind).toBe("ambiguous");
  });

  test("a 5xx is ambiguous", async () => {
    const { fetchImpl } = recorder([{ status: 503, body: {} }]);
    const client = new StripeClient({ key: TEST_KEY, mode: "test", fetchImpl });
    expect((await client.get("/v1/customers/cus_1")).kind).toBe("ambiguous");
  });

  test("a 4xx is rejected and carries Stripe's code", async () => {
    const { fetchImpl } = recorder([
      {
        status: 400,
        body: {
          error: {
            type: "invalid_request_error",
            code: "resource_missing",
            message: "No such coupon",
          },
        },
      },
    ]);
    const client = new StripeClient({ key: TEST_KEY, mode: "test", fetchImpl });
    const res = await client.get("/v1/coupons/nope");
    expect(res).toMatchObject({
      kind: "rejected",
      status: 400,
      code: "resource_missing",
      retryable: false,
    });
  });
});

describe("retrying a write", () => {
  test("an ambiguous write is repeated with the SAME idempotency key", async () => {
    // The key is the whole reason this is a replay of one request rather than a
    // second request. If the key changed per attempt, a retry could double-charge.
    const { fetchImpl, calls } = recorder([
      { throws: "connection reset" },
      { status: 200, body: { id: "sub_1" } },
    ]);
    const client = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl,
      sleep: noSleep,
    });
    const res = await client.post(
      "/v1/subscriptions",
      { customer: "cus_1" },
      "k",
    );
    expect(res.kind).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.headers["Idempotency-Key"])).toEqual(["k", "k"]);
  });

  test("a rate limit is retried; a parameter error is not", async () => {
    const limited = recorder([
      { status: 429, body: { error: { type: "rate_limit_error" } } },
      { status: 200, body: { id: "ok" } },
    ]);
    const client = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl: limited.fetchImpl,
      sleep: noSleep,
    });
    expect((await client.post("/v1/prices", {}, "k")).kind).toBe("ok");
    expect(limited.calls).toHaveLength(2);

    const bad = recorder([
      { status: 400, body: { error: { type: "invalid_request_error" } } },
    ]);
    const client2 = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl: bad.fetchImpl,
      sleep: noSleep,
    });
    expect((await client2.post("/v1/prices", {}, "k")).kind).toBe("rejected");
    expect(bad.calls).toHaveLength(1);
  });

  test("attempts are bounded, and the last outcome is what comes back", async () => {
    const { fetchImpl, calls } = recorder([{ throws: "timeout" }]);
    const client = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl,
      attempts: 3,
      sleep: noSleep,
    });
    expect((await client.post("/v1/prices", {}, "k")).kind).toBe("ambiguous");
    expect(calls).toHaveLength(3);
  });
});
