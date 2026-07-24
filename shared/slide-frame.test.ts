import { describe, it, expect } from "bun:test";
import {
  buildSlideSrcDoc,
  buildSlideMeasureSrcDoc,
  slideDisplayHeight,
  SLIDE_CSP,
  SLIDE_W,
  SLIDE_H,
} from "./slide-frame.ts";

describe("slide iframe framing", () => {
  it("embeds a restrictive CSP that denies all outbound loads", () => {
    // default-src 'none' is the boundary; only inline styles are allowed.
    expect(SLIDE_CSP).toContain("default-src 'none'");
    expect(SLIDE_CSP).toContain("style-src 'unsafe-inline'");
    for (const dir of [
      "img-src 'none'",
      "font-src 'none'",
      "connect-src 'none'",
      "script-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(SLIDE_CSP).toContain(dir);
    }
    // No wildcard / remote source ever slips in.
    expect(SLIDE_CSP).not.toContain("*");
    expect(SLIDE_CSP).not.toContain("http");
  });

  it("wraps a fragment in an offline 1280x720 document carrying the CSP", () => {
    const doc = buildSlideSrcDoc("<div>hi</div>");
    expect(doc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">`,
    );
    expect(doc).toContain(`width:${SLIDE_W}px`);
    expect(doc).toContain(`height:${SLIDE_H}px`);
    expect(doc).toContain("<body><div>hi</div></body>");
  });

  it("renders an overfull slide at the given height (no clip)", () => {
    const doc = buildSlideSrcDoc("<div>tall</div>", 1400);
    expect(doc).toContain(`height:1400px`);
    expect(doc).not.toContain(`height:${SLIDE_H}px`);
    // overflow stays hidden — nothing ever scrolls inside the frame.
    expect(doc).toContain("overflow:hidden");
  });

  it("measurement doc carries the same CSP but no fixed height / hidden overflow", () => {
    const doc = buildSlideMeasureSrcDoc("<div>hi</div>");
    // Same security boundary as the display frame.
    expect(doc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">`,
    );
    expect(doc).toContain(`width:${SLIDE_W}px`);
    // Content must be free to flow to its natural height so scrollHeight is
    // meaningful — so NO height clamp and NO overflow:hidden here.
    expect(doc).not.toContain("height:");
    expect(doc).not.toContain("overflow:hidden");
    expect(doc).toContain("<body><div>hi</div></body>");
  });

  describe("slideDisplayHeight (never-clip sizing)", () => {
    it("keeps the 720 canvas while unmeasured", () => {
      expect(slideDisplayHeight(null)).toBe(SLIDE_H);
    });
    it("keeps the 720 canvas for content that fits", () => {
      expect(slideDisplayHeight(400)).toBe(SLIDE_H);
      expect(slideDisplayHeight(SLIDE_H)).toBe(SLIDE_H);
    });
    it("grows to natural height (+2px anti-clip margin) when overfull", () => {
      expect(slideDisplayHeight(900)).toBe(902);
      expect(slideDisplayHeight(1000.4)).toBe(1003); // ceil then +2
    });
    it("never returns less than a full card", () => {
      expect(slideDisplayHeight(0)).toBe(SLIDE_H);
      expect(slideDisplayHeight(-50)).toBe(SLIDE_H);
    });
  });
});
