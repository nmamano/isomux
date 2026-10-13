import { describe, expect, test } from "bun:test";

import {
  SCRUB_MARKER,
  scrubPatterns,
  scrubText,
  StreamScrubber,
} from "./scrub.ts";

const VALUE = "ghp_FAKEscrubFAKEscrubFAKEscrubFAKE01";
const patterns = scrubPatterns([VALUE]);

describe("scrubText", () => {
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
