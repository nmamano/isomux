import { describe, expect, test } from "bun:test";

import { placeholderFor, scopeId } from "./placeholders.ts";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const OFFICE = { kind: "office" } as const;
const ALICE = { kind: "user", userId: "alice" } as const;
// Obvious fakes with the providers' prefixes.
const CLASSIC = "ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKE";
const FINE = `github_pat_${"F".repeat(82)}`;
const PLAIN = "fake-plain-value-123456";

describe("placeholderFor", () => {
  test("is stable for the same key, scope, name, generation and prefix", () => {
    expect(placeholderFor(KEY, ALICE, "GH_TOKEN", 1, CLASSIC)).toBe(
      placeholderFor(KEY, ALICE, "GH_TOKEN", 1, CLASSIC),
    );
  });

  test("does not change when the value changes inside the same prefix", () => {
    const other = "ghp_OTHERotherOTHERotherOTHERotherOTHE";
    expect(placeholderFor(KEY, ALICE, "GH_TOKEN", 1, CLASSIC)).toBe(
      placeholderFor(KEY, ALICE, "GH_TOKEN", 1, other),
    );
  });

  test("differs per scope, name, generation and key", () => {
    const base = placeholderFor(KEY, ALICE, "GH_TOKEN", 1, CLASSIC);
    expect(placeholderFor(KEY, OFFICE, "GH_TOKEN", 1, CLASSIC)).not.toBe(base);
    expect(
      placeholderFor(
        KEY,
        { kind: "user", userId: "bob" },
        "GH_TOKEN",
        1,
        CLASSIC,
      ),
    ).not.toBe(base);
    expect(placeholderFor(KEY, ALICE, "GITHUB_TOKEN", 1, CLASSIC)).not.toBe(
      base,
    );
    // A reissue raises the generation, so the placeholder changes.
    expect(placeholderFor(KEY, ALICE, "GH_TOKEN", 2, CLASSIC)).not.toBe(base);
    expect(placeholderFor(OTHER_KEY, ALICE, "GH_TOKEN", 1, CLASSIC)).not.toBe(
      base,
    );
  });

  test("keeps a well-known prefix with the provider's body length", () => {
    expect(placeholderFor(KEY, ALICE, "GH_TOKEN", 1, CLASSIC)).toMatch(
      /^ghp_[A-Za-z0-9]{36}$/,
    );
    expect(placeholderFor(KEY, ALICE, "GH_TOKEN", 1, FINE)).toMatch(
      /^github_pat_[A-Za-z0-9]{82}$/,
    );
    expect(
      placeholderFor(KEY, ALICE, "STRIPE_API_KEY", 1, "sk_test_FAKEfakeFAKE"),
    ).toMatch(/^sk_test_[A-Za-z0-9]{99}$/);
    expect(
      placeholderFor(KEY, ALICE, "FLY_API_TOKEN", 1, "FlyV1 fm2_FAKEfake"),
    ).toMatch(/^FlyV1 fm2_[A-Za-z0-9]{64}$/);
  });

  test("a value with no known prefix gets a plain body", () => {
    const placeholder = placeholderFor(KEY, ALICE, "API_KEY", 1, PLAIN);
    expect(placeholder).toMatch(/^[A-Za-z0-9]{40}$/);
  });

  test("a rotation to another well-known prefix changes the placeholder", () => {
    expect(placeholderFor(KEY, ALICE, "GH_TOKEN", 1, CLASSIC)).not.toBe(
      placeholderFor(KEY, ALICE, "GH_TOKEN", 1, FINE),
    );
  });

  test("never contains the value", () => {
    for (const value of [CLASSIC, FINE, PLAIN])
      expect(placeholderFor(KEY, ALICE, "X", 1, value)).not.toContain(
        value.slice(4, 16),
      );
  });
});

test("scopeId names the office and each member", () => {
  expect(scopeId(OFFICE)).toBe("office");
  expect(scopeId(ALICE)).toBe("user:alice");
});
