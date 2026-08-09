// Signature verification. No secret in this file is real: they are shapes.

import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { SIGNATURE_TOLERANCE_SEC, verifySignature } from "./signature.ts";

const SECRET = "whsec_NOT_A_REAL_SECRET_ONLY_A_SHAPE";
const PAYLOAD = '{"id":"evt_1","type":"customer.subscription.updated"}';

function sign(payload: string, tSec: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret)
    .update(`${tSec}.${payload}`, "utf8")
    .digest("hex");
  return `t=${tSec},v1=${v1}`;
}

const NOW_SEC = 1_770_000_000;
const NOW_MS = NOW_SEC * 1000;

describe("a genuine delivery", () => {
  test("verifies", () => {
    const verdict = verifySignature({
      payload: PAYLOAD,
      header: sign(PAYLOAD, NOW_SEC),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(verdict).toEqual({ ok: true, timestamp: NOW_SEC });
  });

  test("verifies when Stripe offers several v1 signatures and one matches", () => {
    // Secret rotation: Stripe signs with both, and either one is enough.
    const good = sign(PAYLOAD, NOW_SEC).split("v1=")[1];
    const stale = createHmac("sha256", "whsec_A_DIFFERENT_SHAPE")
      .update(`${NOW_SEC}.${PAYLOAD}`, "utf8")
      .digest("hex");
    const verdict = verifySignature({
      payload: PAYLOAD,
      header: `t=${NOW_SEC},v1=${stale},v1=${good}`,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(verdict.ok).toBe(true);
  });

  test("tolerates whitespace around the parts", () => {
    const header = sign(PAYLOAD, NOW_SEC)
      .split(",")
      .map((p) => ` ${p} `)
      .join(",");
    expect(
      verifySignature({
        payload: PAYLOAD,
        header,
        secret: SECRET,
        now: NOW_MS,
      }).ok,
    ).toBe(true);
  });
});

describe("what must be refused", () => {
  test("a payload signed over the body alone, without the timestamp", () => {
    // The mutation this guards: dropping `${t}.` from the signed material. A
    // verifier that signed the body alone would accept this header.
    const v1 = createHmac("sha256", SECRET)
      .update(PAYLOAD, "utf8")
      .digest("hex");
    const verdict = verifySignature({
      payload: PAYLOAD,
      header: `t=${NOW_SEC},v1=${v1}`,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(verdict).toMatchObject({ ok: false, failure: "no_match" });
  });

  test("a tampered payload", () => {
    const header = sign(PAYLOAD, NOW_SEC);
    const verdict = verifySignature({
      payload: PAYLOAD.replace("evt_1", "evt_2"),
      header,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(verdict).toMatchObject({ ok: false, failure: "no_match" });
  });

  test("the wrong secret", () => {
    const verdict = verifySignature({
      payload: PAYLOAD,
      header: sign(PAYLOAD, NOW_SEC, "whsec_SOMEONE_ELSES_SHAPE"),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(verdict).toMatchObject({ ok: false, failure: "no_match" });
  });

  test("a timestamp older than the window", () => {
    const old = NOW_SEC - SIGNATURE_TOLERANCE_SEC - 1;
    const verdict = verifySignature({
      payload: PAYLOAD,
      header: sign(PAYLOAD, old),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(verdict).toMatchObject({ ok: false, failure: "too_old" });
  });

  test("a timestamp in the FUTURE beyond the window", () => {
    // Rejected in both directions on purpose: a delivery dated forward would
    // otherwise carry an indefinite replay window.
    const ahead = NOW_SEC + SIGNATURE_TOLERANCE_SEC + 1;
    const verdict = verifySignature({
      payload: PAYLOAD,
      header: sign(PAYLOAD, ahead),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(verdict).toMatchObject({ ok: false, failure: "too_new" });
  });

  test("a timestamp exactly at the edge is still accepted, either way", () => {
    for (const t of [
      NOW_SEC - SIGNATURE_TOLERANCE_SEC,
      NOW_SEC + SIGNATURE_TOLERANCE_SEC,
    ]) {
      expect(
        verifySignature({
          payload: PAYLOAD,
          header: sign(PAYLOAD, t),
          secret: SECRET,
          now: NOW_MS,
        }).ok,
      ).toBe(true);
    }
  });

  test("a missing header", () => {
    for (const header of [null, undefined, ""]) {
      expect(
        verifySignature({
          payload: PAYLOAD,
          header,
          secret: SECRET,
          now: NOW_MS,
        }),
      ).toMatchObject({ ok: false, failure: "malformed" });
    }
  });

  test("a header with no v1, or no t, or a non-numeric t", () => {
    for (const header of [
      `t=${NOW_SEC}`,
      "v1=abc",
      `t=not-a-number,v1=abc`,
      "nonsense",
    ]) {
      expect(
        verifySignature({
          payload: PAYLOAD,
          header,
          secret: SECRET,
          now: NOW_MS,
        }),
      ).toMatchObject({ ok: false, failure: "malformed" });
    }
  });

  test("a candidate of the wrong length, and one that is not hex", () => {
    for (const v1 of ["deadbeef", "z".repeat(64)]) {
      expect(
        verifySignature({
          payload: PAYLOAD,
          header: `t=${NOW_SEC},v1=${v1}`,
          secret: SECRET,
          now: NOW_MS,
        }),
      ).toMatchObject({ ok: false, failure: "no_match" });
    }
  });
});

describe("what a rejection says", () => {
  test("it names the rule and never the material", () => {
    const verdict = verifySignature({
      payload: PAYLOAD,
      header: sign(PAYLOAD, NOW_SEC, "whsec_SOMEONE_ELSES_SHAPE"),
      secret: SECRET,
      now: NOW_MS,
    });
    if (verdict.ok) throw new Error("expected a rejection");
    expect(verdict.detail).not.toContain("whsec_");
    expect(verdict.detail).not.toContain(PAYLOAD);
    expect(verdict.detail).toContain("v1");
  });
});
