import { describe, it, expect } from "bun:test";
import {
  buildSlideSrcDoc,
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
});
