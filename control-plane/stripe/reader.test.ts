// The production reader: what it asks Stripe for, how it classifies the answer,
// and the mode refusal on the fetched object. Every key here is a SHAPE.

import { describe, expect, test } from "bun:test";
import { StripeClient, type FetchLike } from "./client.ts";
import type { StripeMode } from "./mode.ts";
import { LiveStripeReader, StripeModeObjectRefused } from "./reader.ts";

const KEYS: Record<StripeMode, string> = {
  test: "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE",
  live: "rk_live_NOT_A_REAL_KEY_ONLY_A_SHAPE",
};

function readerAnswering(
  mode: StripeMode,
  answer: { status: number; body: unknown } | { throws: string },
): { reader: LiveStripeReader; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    if ("throws" in answer) throw new Error(answer.throws);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    };
  };
  const client = new StripeClient({ key: KEYS[mode], mode, fetchImpl });
  return { reader: new LiveStripeReader(client, mode), urls };
}

const SUBSCRIPTION = {
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  livemode: false,
};

describe("reading a subscription", () => {
  test("expands the coupon behind each discount, where the percentage lives", async () => {
    const { reader, urls } = readerAnswering("test", {
      status: 200,
      body: SUBSCRIPTION,
    });
    expect(await reader.getSubscription("sub_1")).toMatchObject({
      kind: "ok",
      object: { id: "sub_1", status: "active" },
    });
    const url = new URL(urls[0]);
    expect(url.pathname).toBe("/v1/subscriptions/sub_1");
    expect(url.searchParams.getAll("expand[0]")).toEqual([
      "discounts.source.coupon",
    ]);
  });
});

describe("classifying the answer", () => {
  test("a 404 is absent; any other failure is unavailable", async () => {
    const cases: [
      { status: number; body: unknown } | { throws: string },
      "absent" | "unavailable",
    ][] = [
      [
        { status: 404, body: { error: { code: "resource_missing" } } },
        "absent",
      ],
      [
        { status: 400, body: { error: { type: "invalid_request_error" } } },
        "unavailable",
      ],
      [{ status: 503, body: {} }, "unavailable"],
      [{ throws: "connection reset" }, "unavailable"],
    ];
    for (const [answer, kind] of cases) {
      const { reader } = readerAnswering("test", answer);
      expect({ answer, read: (await reader.getInvoice("in_1")).kind }).toEqual({
        answer,
        read: kind,
      });
    }
  });
});

describe("the fetched-object mode gate", () => {
  test("each mode accepts its own objects and refuses the other mode's", async () => {
    for (const mode of ["test", "live"] as const) {
      for (const livemode of [false, true]) {
        const { reader } = readerAnswering(mode, {
          status: 200,
          body: { id: "cs_1", livemode },
        });
        const read = reader.getCheckoutSession("cs_1");
        if (livemode === (mode === "live")) {
          expect((await read).kind).toBe("ok");
        } else {
          expect(read).rejects.toThrow(StripeModeObjectRefused);
        }
      }
    }
  });
});
