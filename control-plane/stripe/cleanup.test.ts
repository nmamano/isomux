// Cleanup may delete only what this slice created.
//
// The account is shared, so the failure this file exists to prevent is not a bug in
// our own state: it is deleting somebody else's test-mode work. Ownership is
// therefore proven, never assumed, and anything unprovable is kept.

import { describe, expect, test } from "bun:test";
import { StripeClient, type FetchLike } from "./client.ts";
import {
  deleteOwned,
  listAll,
  ownsClock,
  ownsTaggedObject,
  selectOwned,
} from "./cleanup.ts";
import { ownedCustomerParams } from "./test-clock.ts";

const TEST_KEY = "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE";

describe("ownership of a metadata-bearing object", () => {
  // Coupons, customers, prices, products. The tag is the ONLY proof.
  test("our exact tag is proof", async () => {
    expect(
      ownsTaggedObject({ id: "co_1", metadata: { isomux_test: "slice3" } }),
    ).toBe(true);
  });

  test("a cp3 NAME is not proof, and someone else's tag beats it", async () => {
    // The fail-open path this replaces: one predicate accepted `tag OR name` for
    // every type, so a coupon carrying slice5's tag was deleted because we happened
    // to have named something similarly.
    expect(
      ownsTaggedObject({
        id: "co_2",
        name: "cp3 comped one month",
        metadata: { isomux_test: "slice5" },
      }),
    ).toBe(false);
    expect(ownsTaggedObject({ id: "co_3", name: "cp3 anything" })).toBe(false);
  });

  test("a missing, wrong-shaped or near-miss tag is not ours", async () => {
    expect(ownsTaggedObject({ id: "co_4" })).toBe(false);
    expect(
      ownsTaggedObject({ id: "co_5", metadata: "isomux_test=slice3" }),
    ).toBe(false);
    expect(
      ownsTaggedObject({ id: "co_6", metadata: { isomux_test: "slice3 " } }),
    ).toBe(false);
    expect(
      ownsTaggedObject({ id: "co_7", metadata: { isomux_test: "SLICE3" } }),
    ).toBe(false);
  });

  test("a customer we create carries the tag, so cleanup can find it", async () => {
    const params = ownedCustomerParams({
      email: "a@example.com",
      label: "acme",
    });
    expect(ownsTaggedObject(params as never)).toBe(true);
    expect(params.name).toBe("cp3-acme");
  });
});

describe("ownership of a test clock", () => {
  // A clock has no metadata field at all, so its name is the only signal - and this
  // is the ONLY type where a name counts.
  test("a cp3 name is proof", async () => {
    expect(ownsClock({ name: "cp3-comped" })).toBe(true);
  });

  test("someone else's clock, and an unnamed one, are kept", async () => {
    expect(ownsClock({ name: "someone-elses-clock" })).toBe(false);
    expect(ownsClock({ name: null })).toBe(false);
  });

  test("the match is the NAMESPACE we mint into, not the bare prefix", async () => {
    // We only ever create `cp3-<label>`. Anything else that merely begins with the
    // three characters belongs to somebody else, and on a shared account that
    // difference is whose clock gets deleted.
    expect(ownsClock({ name: "cp3-dunning" })).toBe(true);
    for (const name of ["cp3", "cp30", "cp3other", "cp3rd-party", "CP3-x"]) {
      expect({ name, owned: ownsClock({ name }) }).toEqual({
        name,
        owned: false,
      });
    }
  });
});

describe("selecting what to delete", () => {
  test("keeps everything unproven, and says why", async () => {
    const objects = [
      { id: "clock_ours", name: "cp3-dunning" },
      { id: "clock_theirs", name: "someone-elses" },
      { id: "clock_anonymous" },
      { id: "co_tagged", metadata: { isomux_test: "slice3" } },
    ];
    const picked = selectOwned(objects, (o) =>
      "metadata" in o
        ? ownsTaggedObject(o)
        : ownsClock(o as { name: string | null }),
    );
    expect(picked.owned.map((o) => o.id)).toEqual(["clock_ours", "co_tagged"]);
    expect(picked.skipped).toEqual([
      { id: "clock_theirs", why: "not ours" },
      {
        id: "clock_anonymous",
        why: "no name and no metadata, so ownership cannot be established",
      },
    ]);
  });

  test("an empty account selects nothing rather than everything", async () => {
    expect(selectOwned([], ownsTaggedObject).owned).toEqual([]);
  });

  test("a foreign tag is skipped with a reason that says so", async () => {
    const picked = selectOwned(
      [{ id: "co_theirs", metadata: { isomux_test: "slice5" } }],
      ownsTaggedObject,
    );
    expect(picked.owned).toEqual([]);
    expect(picked.skipped[0].why).toContain("someone else's ownership tag");
  });
});

describe("listing every page", () => {
  function pagedClient(pages: { data: unknown[]; has_more: boolean }[]): {
    client: StripeClient;
    urls: string[];
  } {
    const urls: string[] = [];
    let i = 0;
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      const page = pages[Math.min(i, pages.length - 1)];
      i++;
      return { ok: true, status: 200, json: async () => page };
    };
    return {
      client: new StripeClient({ key: TEST_KEY, mode: "test", fetchImpl }),
      urls,
    };
  }

  test("walks the cursor until Stripe says there is no more", async () => {
    const { client, urls } = pagedClient([
      { data: [{ id: "a" }, { id: "b" }], has_more: true },
      { data: [{ id: "c" }], has_more: false },
    ]);
    return listAll(client, "/v1/coupons").then((out) => {
      expect(out.complete).toBe(true);
      expect(out.objects.map((o) => o.id)).toEqual(["a", "b", "c"]);
      expect(urls[1]).toContain("starting_after=b");
    });
  });

  test("an incomplete walk is REPORTED, not treated as the whole account", async () => {
    // Treating one page as everything is how a cleanup leaves objects behind and
    // then claims success.
    const { client } = pagedClient([{ data: [{ id: "a" }], has_more: true }]);
    return listAll(client, "/v1/coupons", {}, 2).then((out) => {
      expect(out.complete).toBe(false);
      expect(out.reason).toContain("2 pages");
    });
  });

  test("a failed read is incomplete rather than empty-and-fine", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const client = new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl,
      attempts: 1,
      sleep: async () => {},
    });
    return listAll(client, "/v1/coupons").then((out) => {
      expect(out.complete).toBe(false);
      expect(out.objects).toEqual([]);
    });
  });
});

describe("checking what a delete actually did", () => {
  function client(
    outcome: { status: number; body?: unknown } | { throws: true },
  ) {
    const fetchImpl: FetchLike = async () => {
      if ("throws" in outcome) throw new Error("connection reset");
      return {
        ok: outcome.status >= 200 && outcome.status < 300,
        status: outcome.status,
        json: async () => outcome.body ?? {},
      };
    };
    return new StripeClient({
      key: TEST_KEY,
      mode: "test",
      fetchImpl,
      attempts: 1,
      sleep: async () => {},
    });
  }

  test("a 200 is deleted", async () => {
    expect(
      await deleteOwned(client({ status: 200 }), "/v1/coupons/co_1"),
    ).toEqual({
      deleted: true,
    });
  });

  test("a 404 counts as deleted: it is already gone", async () => {
    // A customer removed along with its test clock answers 404, and that is the
    // outcome we wanted.
    expect(
      await deleteOwned(client({ status: 404 }), "/v1/customers/cus_1"),
    ).toEqual({ deleted: true });
  });

  test("a refusal is NOT deleted, and says why", async () => {
    const out = await deleteOwned(
      client({
        status: 400,
        body: { error: { type: "invalid_request_error" } },
      }),
      "/v1/coupons/co_1",
    );
    expect(out.deleted).toBe(false);
    expect(out.reason).toBeTruthy();
  });

  test("an AMBIGUOUS delete is not claimed as deleted", async () => {
    // "We asked" is not "it is gone", and this is the case where neither answer is
    // known - so the cleanup has to report itself incomplete.
    const out = await deleteOwned(client({ throws: true }), "/v1/coupons/co_1");
    expect(out.deleted).toBe(false);
    expect(out.reason).toContain("transport failure");
  });
});
