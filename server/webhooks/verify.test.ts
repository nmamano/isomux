// Webhook signature checks: GitHub's documented vector, the generic encodings,
// and malformed headers that must fail without throwing.
//
// Pure T0: no server, no disk.

import { describe, it, expect } from "bun:test";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "./verify.ts";

const encoder = new TextEncoder();

// GitHub docs, "Validating webhook deliveries", checked locally on 2026-10-05.
const GITHUB_SECRET = "It's a Secret to Everybody";
const GITHUB_BODY = encoder.encode("Hello, World!");
const GITHUB_SIGNATURE =
  "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

function digest(secret: string, body: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

describe("verifyWebhookSignature: github-hmac-sha256", () => {
  it("accepts GitHub's documented vector", () => {
    expect(
      verifyWebhookSignature(
        "github-hmac-sha256",
        GITHUB_SECRET,
        GITHUB_BODY,
        GITHUB_SIGNATURE,
      ),
    ).toBe(true);
  });

  it("refuses the vector with one body byte flipped", () => {
    const body = GITHUB_BODY.slice();
    body[0] ^= 1;
    expect(
      verifyWebhookSignature(
        "github-hmac-sha256",
        GITHUB_SECRET,
        body,
        GITHUB_SIGNATURE,
      ),
    ).toBe(false);
  });

  it("refuses the vector with one signature digit changed", () => {
    const last = GITHUB_SIGNATURE.at(-1) === "0" ? "1" : "0";
    expect(
      verifyWebhookSignature(
        "github-hmac-sha256",
        GITHUB_SECRET,
        GITHUB_BODY,
        GITHUB_SIGNATURE.slice(0, -1) + last,
      ),
    ).toBe(false);
  });

  it("refuses the vector under another secret", () => {
    expect(
      verifyWebhookSignature(
        "github-hmac-sha256",
        "another secret",
        GITHUB_BODY,
        GITHUB_SIGNATURE,
      ),
    ).toBe(false);
  });

  const hex = GITHUB_SIGNATURE.slice("sha256=".length);
  const malformed: [string, string | null][] = [
    ["missing header", null],
    ["empty header", ""],
    ["no prefix", hex],
    ["another algorithm prefix", `sha1=${hex}`],
    ["non-hex digits", `sha256=${"z".repeat(64)}`],
    ["short digest", `sha256=${hex.slice(0, 62)}`],
    ["long digest", `sha256=${hex}00`],
    ["odd length", `sha256=${hex.slice(0, 63)}`],
    ["base64 digest", `sha256=${Buffer.from(hex, "hex").toString("base64")}`],
    ["whitespace inside", `sha256= ${hex}`],
  ];
  for (const [label, header] of malformed) {
    it(`refuses a malformed header without throwing: ${label}`, () => {
      expect(
        verifyWebhookSignature(
          "github-hmac-sha256",
          GITHUB_SECRET,
          GITHUB_BODY,
          header,
        ),
      ).toBe(false);
    });
  }
});

describe("verifyWebhookSignature: hmac-sha256", () => {
  const secret = "generic-secret";
  const body = encoder.encode('{"hello":"world"}');
  const mac = digest(secret, body);
  const base64url = mac
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const accepted: [string, string][] = [
    ["lowercase hex", mac.toString("hex")],
    ["uppercase hex", mac.toString("hex").toUpperCase()],
    ["prefixed hex", `sha256=${mac.toString("hex")}`],
    ["base64", mac.toString("base64")],
    ["prefixed base64", `sha256=${mac.toString("base64")}`],
    ["base64url without padding", base64url],
    ["surrounding whitespace", ` ${mac.toString("hex")} `],
  ];
  for (const [label, header] of accepted) {
    it(`accepts ${label}`, () => {
      expect(verifyWebhookSignature("hmac-sha256", secret, body, header)).toBe(
        true,
      );
    });
  }

  const other = digest("wrong", body);
  const malformed: [string, string | null][] = [
    ["missing header", null],
    ["empty header", ""],
    ["a valid shape under another secret", other.toString("hex")],
    ["base64 of the wrong length", Buffer.alloc(31).toString("base64")],
    ["hex of the wrong length", mac.toString("hex").slice(0, 60)],
    ["characters outside both alphabets", `${"!".repeat(43)}=`],
    [
      "base64 with an inner space",
      `${mac.toString("base64").slice(0, 20)} ${mac.toString("base64").slice(21)}`,
    ],
    ["double prefix", `sha256=sha256=${mac.toString("hex")}`],
  ];
  for (const [label, header] of malformed) {
    it(`refuses without throwing: ${label}`, () => {
      expect(verifyWebhookSignature("hmac-sha256", secret, body, header)).toBe(
        false,
      );
    });
  }
});
