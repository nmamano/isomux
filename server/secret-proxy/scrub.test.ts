import { describe, expect, test } from "bun:test";

import {
  checkSecretValue,
  SECRET_MIN_VALUE_LENGTH,
} from "../../shared/secret-hosts.ts";
import {
  SCRUB_MARKER,
  scrubPatterns,
  scrubText,
  StreamScrubber,
} from "./scrub.ts";

const VALUE = "ghp_FAKEscrubFAKEscrubFAKEscrubFAKE01";
const patterns = scrubPatterns([VALUE]);

describe("scrubText", () => {
  test("scrubs the shortest value the store takes, and the store refuses a value it would skip", () => {
    const shortest = "f".repeat(SECRET_MIN_VALUE_LENGTH);
    expect(checkSecretValue(shortest)).toBeNull();
    expect(scrubText(`a ${shortest} b`, scrubPatterns([shortest]))).toBe(
      `a ${SCRUB_MARKER} b`,
    );
    const skipped = shortest.slice(1);
    expect(scrubText(`a ${skipped} b`, scrubPatterns([skipped]))).toBe(
      `a ${skipped} b`,
    );
    expect(checkSecretValue(skipped)?.reason).toBe("too_short");
  });

  test("removes the raw and URL-encoded forms", () => {
    const special = "fake+value/with=chars&more";
    const p = scrubPatterns([special]);
    expect(scrubText(`a ${special} b`, p)).toBe(`a ${SCRUB_MARKER} b`);
    expect(scrubText(`q=${encodeURIComponent(special)}`, p)).toBe(
      `q=${SCRUB_MARKER}`,
    );
  });

  test("removes the value from base64 at every alignment, Basic included", () => {
    for (const prefix of ["", "u:", "us:", "use:", "x-access-token:"]) {
      const encoded = Buffer.from(`${prefix}${VALUE}`).toString("base64");
      const out = scrubText(`Basic ${encoded}`, patterns);
      expect(out).toContain(SCRUB_MARKER);
      expect(
        Buffer.from(out.slice(6), "base64").toString("latin1"),
      ).not.toContain(VALUE.slice(4, 30));
    }
  });

  test("leaves text without a value as it is", () => {
    expect(scrubText("nothing to see", patterns)).toBe("nothing to see");
    expect(scrubText("anything", [])).toBe("anything");
  });
});

describe("StreamScrubber", () => {
  test("finds a value split at every byte position", () => {
    const text = `before ${VALUE} after`;
    for (let cut = 1; cut < text.length; cut++) {
      const scrubber = new StreamScrubber(patterns);
      const out = Buffer.concat([
        scrubber.push(Buffer.from(text.slice(0, cut))),
        scrubber.push(Buffer.from(text.slice(cut))),
        scrubber.end(),
      ]).toString();
      expect(out).toBe(`before ${SCRUB_MARKER} after`);
    }
  });

  test("passes binary bytes through unchanged", () => {
    const bytes = Buffer.from([0, 255, 128, 10, 13, 200]);
    const scrubber = new StreamScrubber(patterns);
    const out = Buffer.concat([scrubber.push(bytes), scrubber.end()]);
    expect(out.equals(bytes)).toBe(true);
  });
});
