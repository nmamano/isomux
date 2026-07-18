// Pins the shared pure-JS SHA-256 behind versionOf (shared/blob-version.ts):
// FIPS 180-4 known-answer vectors (empty / one-block / multi-block) plus a
// parity sweep against node:crypto, so the browser-safe implementation can
// never drift from the platform one. memory-store re-exports THIS versionOf,
// so these vectors also pin the memory-file version format.

import { describe, it, expect } from "bun:test";
import { createHash } from "crypto";
import { versionOf } from "./blob-version.ts";

function nodeVersionOf(content: string): string {
  return createHash("sha256")
    .update(content, "utf8")
    .digest("hex")
    .slice(0, 12);
}

describe("shared/blob-version versionOf", () => {
  it("matches the FIPS 180-4 known-answer vectors (first 12 hex)", () => {
    // sha256("") = e3b0c44298fc1c14...
    expect(versionOf("")).toBe("e3b0c44298fc");
    // sha256("abc") = ba7816bf8f01cfea...
    expect(versionOf("abc")).toBe("ba7816bf8f01");
    // Two-block message (448 bits): sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
    // = 248d6a61d20638b8...
    expect(
      versionOf("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d206");
  });

  it("agrees with node:crypto across lengths spanning the padding boundaries and multi-byte utf8", () => {
    const samples = [
      "",
      "a",
      "x".repeat(55), // last length fitting one block with padding
      "x".repeat(56), // first length forcing a second block
      "x".repeat(63),
      "x".repeat(64),
      "x".repeat(65),
      "x".repeat(1000),
      "prompt with newlines\nand\ttabs\n",
      "unicode: héllo wörld — ünïcode ✓ 你好 🦊",
    ];
    for (const s of samples) {
      expect(versionOf(s)).toBe(nodeVersionOf(s));
    }
  });
});
