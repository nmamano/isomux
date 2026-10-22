// The email sign-in token: what a link carries, and what redeeming it proves.
//
// A redeemed token is the whole authority of an email sign-in, so each property
// here is one way an account could be reached without control of the inbox: a
// payload whose address was swapped, a link spent twice, a link past its time,
// and a used-link record that forgets under pressure.

import { describe, expect, test } from "bun:test";
import {
  createEmailChangeTokens,
  createSignInTokens,
  normalizeEmail,
  SIGNIN_LINK_TTL_MS,
} from "./signin-link.server";
import { addressInSignInToken } from "./signin-link-payload";

const SECRET = "test-secret-not-a-credential-0123456789";
const T0 = 1_800_000_000_000;

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("redeeming a token", () => {
  test("a fresh token redeems once, to the address it was made for", () => {
    const tokens = createSignInTokens({ secret: SECRET });
    const token = tokens.create("user@proton.me", T0);
    expect(tokens.redeem(token, T0 + 1000)).toEqual({
      ok: true,
      email: "user@proton.me",
    });
    expect(tokens.redeem(token, T0 + 2000)).toEqual({
      ok: false,
      reason: "used",
    });
  });

  test("a token is valid for the TTL and not after it", () => {
    const tokens = createSignInTokens({ secret: SECRET });
    const late = tokens.create("a@example.com", T0);
    const inTime = tokens.create("a@example.com", T0);
    expect(tokens.redeem(late, T0 + SIGNIN_LINK_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(tokens.redeem(inTime, T0 + SIGNIN_LINK_TTL_MS - 1).ok).toBe(true);
  });

  test("an address swapped into a signed payload is refused", () => {
    const tokens = createSignInTokens({ secret: SECRET });
    const token = tokens.create("attacker@example.com", T0);
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { e: string };
    expect(claims.e).toBe("attacker@example.com");
    const forged = `${base64url(JSON.stringify({ ...claims, e: "victim@example.com" }))}.${signature}`;
    expect(tokens.redeem(forged, T0)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    // The original still works: the refusal above was the signature, not a
    // token that had stopped working for another reason.
    expect(tokens.redeem(token, T0)).toEqual({
      ok: true,
      email: "attacker@example.com",
    });
  });

  test("a token made under another secret is refused", () => {
    const other = createSignInTokens({ secret: `${SECRET}-other` });
    const tokens = createSignInTokens({ secret: SECRET });
    expect(tokens.redeem(other.create("a@example.com", T0), T0)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  test("text that is not a token is malformed, not a crash", () => {
    const tokens = createSignInTokens({ secret: SECRET });
    for (const junk of ["", "abc", ".", "a.b.c"]) {
      expect(tokens.redeem(junk, T0)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
    // Whether these fail on shape or on signature depends on which is checked
    // first; either is a refusal.
    for (const junk of ["%%%.%%%", `${base64url("{")}.x`]) {
      expect(tokens.redeem(junk, T0).ok).toBe(false);
    }
  });

  test("a full used-link record never lets a used link redeem again", () => {
    // maxUsed is the bound on the used-link record. Two links fill it with
    // entries that are still live; a third must not push one of them out.
    const tokens = createSignInTokens({ secret: SECRET, maxUsed: 2 });
    const first = tokens.create("a@example.com", T0);
    const second = tokens.create("b@example.com", T0);
    const third = tokens.create("c@example.com", T0);
    expect(tokens.redeem(first, T0).ok).toBe(true);
    expect(tokens.redeem(second, T0).ok).toBe(true);
    // Fail closed: the third may be refused, but if it is accepted it must not
    // have evicted a live record.
    tokens.redeem(third, T0);
    expect(tokens.redeem(first, T0)).toEqual({ ok: false, reason: "used" });
    expect(tokens.redeem(second, T0)).toEqual({ ok: false, reason: "used" });
    // Records past the TTL make room again: the record is bounded, not full
    // for ever.
    const later = T0 + SIGNIN_LINK_TTL_MS + 1;
    const fresh = tokens.create("d@example.com", later);
    expect(tokens.redeem(fresh, later)).toEqual({
      ok: true,
      email: "d@example.com",
    });
  });
});

describe("email change links", () => {
  // A change link moves an account to an address, so it is a stronger
  // credential than a sign-in link: one must never stand in for the other.
  const CLAIMS = { a: "acct-1", e: "work@example.com" };

  test("checking does not spend a link; redeeming spends it once", () => {
    const tokens = createEmailChangeTokens({ secret: SECRET });
    const token = tokens.create(CLAIMS, T0);
    const first = tokens.check(token, T0 + 1000);
    const second = tokens.check(token, T0 + 2000);
    expect(first.ok && first.claims).toEqual(CLAIMS);
    expect(second.ok && second.claims).toEqual(CLAIMS);
    const redeemed = tokens.redeem(token, T0 + 3000);
    expect(redeemed.ok && redeemed.claims).toEqual(CLAIMS);
    expect(tokens.redeem(token, T0 + 4000)).toEqual({
      ok: false,
      reason: "used",
    });
    expect(tokens.check(token, T0 + 4000)).toEqual({
      ok: false,
      reason: "used",
    });
  });

  test("two links for the same change carry different nonces", () => {
    // The Stripe idempotency key is per link: a nonce shared by two links
    // would replay the first change's answer for the second.
    const tokens = createEmailChangeTokens({ secret: SECRET });
    const one = tokens.check(tokens.create(CLAIMS, T0), T0);
    const two = tokens.check(tokens.create(CLAIMS, T0), T0);
    if (!one.ok || !two.ok) throw new Error("fresh links must verify");
    expect(one.nonce.length).toBeGreaterThan(0);
    expect(one.nonce).not.toBe(two.nonce);
    expect(one.expiresAt).toBe(T0 + SIGNIN_LINK_TTL_MS);
  });

  test("a link past its TTL is refused by check and by redeem", () => {
    const tokens = createEmailChangeTokens({ secret: SECRET });
    const token = tokens.create(CLAIMS, T0);
    const late = T0 + SIGNIN_LINK_TTL_MS + 1;
    expect(tokens.check(token, late)).toEqual({ ok: false, reason: "expired" });
    expect(tokens.redeem(token, late)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("an account swapped into a signed payload is refused", () => {
    const tokens = createEmailChangeTokens({ secret: SECRET });
    const token = tokens.create(CLAIMS, T0);
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims.a).toBe("acct-1");
    const forged = `${base64url(JSON.stringify({ ...claims, a: "acct-victim" }))}.${signature}`;
    expect(tokens.check(forged, T0)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(tokens.check(token, T0).ok).toBe(true);
  });

  test("under one secret, a sign-in link is not a change link and a change link is not a sign-in link", () => {
    const change = createEmailChangeTokens({ secret: SECRET });
    const signIn = createSignInTokens({ secret: SECRET });
    expect(change.check(signIn.create("work@example.com", T0), T0)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(signIn.redeem(change.create(CLAIMS, T0), T0)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    // Each still verifies in its own context.
    expect(change.check(change.create(CLAIMS, T0), T0).ok).toBe(true);
    expect(signIn.redeem(signIn.create("work@example.com", T0), T0).ok).toBe(
      true,
    );
  });
});

describe("the address the link page shows", () => {
  test("reads the address out of a token, and nothing out of junk", () => {
    const tokens = createSignInTokens({ secret: SECRET });
    expect(addressInSignInToken(tokens.create("user@proton.me", T0))).toBe(
      "user@proton.me",
    );
    for (const junk of ["", "abc", "a.b", `${base64url("[1]")}.x`]) {
      expect(addressInSignInToken(junk)).toBeNull();
    }
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases a plausible address", () => {
    expect(normalizeEmail("  User@Proton.ME \n")).toBe("user@proton.me");
  });

  test("refuses what is not one address", () => {
    const local = "a".repeat(64);
    const longest = `${local}@${"b".repeat(254 - local.length - 1)}`;
    expect(longest.length).toBe(254);
    expect(normalizeEmail(longest)).toBe(longest);
    for (const bad of [
      undefined,
      null,
      42,
      ["a@example.com"],
      "",
      "   ",
      "plain",
      "@example.com",
      "a@",
      "a@b@example.com",
      "a b@example.com",
      "a@exa mple.com",
      `${longest}b`,
    ]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});
