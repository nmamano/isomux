// The Stripe customer's email on the wire, and how each answer is classified.
//
// The classification decides whether an email change may go ahead: a customer
// Stripe deleted must not block it for ever, and any answer that does not say
// the write landed must stop it.

import { describe, expect, test } from "bun:test";
import { StripeClient, type FetchLike } from "./client.ts";
import { updateCustomerEmail } from "./customer-email.ts";

const TEST_KEY = "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function client(answer: () => { status: number; body: unknown }): {
  stripe: StripeClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const next = answer();
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  const stripe = new StripeClient({
    key: TEST_KEY,
    mode: "test",
    fetchImpl,
    attempts: 2,
    sleep: async () => {},
  });
  return { stripe, calls };
}

describe("updating a customer's email", () => {
  test("one keyed POST to the customer, carrying the address", async () => {
    const { stripe, calls } = client(() => ({
      status: 200,
      body: { id: "cus_1", email: "work@example.com" },
    }));
    expect(
      await updateCustomerEmail(stripe, "cus_1", "work@example.com", "key-1"),
    ).toBe("updated");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/v1/customers/cus_1");
    expect(new URLSearchParams(call.body).get("email")).toBe(
      "work@example.com",
    );
    expect(call.headers["Idempotency-Key"]).toBe("key-1");
  });

  test("a customer Stripe no longer has is missing", async () => {
    const { stripe } = client(() => ({
      status: 404,
      body: {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "No such customer",
        },
      },
    }));
    expect(
      await updateCustomerEmail(stripe, "cus_gone", "a@example.com", "k"),
    ).toBe("missing");
  });

  test("any other refusal, and an answer that does not say, is failed", async () => {
    const answers = [
      {
        status: 400,
        body: {
          error: { type: "invalid_request_error", message: "Invalid email" },
        },
      },
      // A 404 that is not about the customer is not "deleted".
      { status: 404, body: { error: { type: "invalid_request_error" } } },
      { status: 500, body: {} },
      { status: 429, body: { error: { type: "rate_limit_error" } } },
    ];
    for (const answer of answers) {
      const { stripe } = client(() => answer);
      expect(
        await updateCustomerEmail(stripe, "cus_1", "a@example.com", "k"),
      ).toBe("failed");
    }
  });
});
