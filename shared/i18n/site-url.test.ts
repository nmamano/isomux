// The public site's per-language URLs. Literal expectations: a test that built
// its expectation from SITE_LANGUAGE_PATH would pass for any mapping. That
// every supported language has a path is the type's (Record<SupportedLanguageCode,
// string>).

import { describe, expect, it } from "bun:test";
import { landingUrl, hostedUrl } from "./site-url.ts";

describe("site urls", () => {
  // English stays at the root: the exact URL the office has always opened.
  it("sends each language to its own landing page", () => {
    expect(landingUrl("en")).toBe("https://isomux.com");
    expect(landingUrl("es")).toBe("https://isomux.com/es");
    expect(landingUrl("ca")).toBe("https://isomux.com/ca");
    expect(landingUrl("zh")).toBe("https://isomux.com/zh");
  });

  it("sends each language to its own hosted page", () => {
    expect(hostedUrl("en")).toBe("https://isomux.com/hosted");
    expect(hostedUrl("es")).toBe("https://isomux.com/es/hosted");
    expect(hostedUrl("ca")).toBe("https://isomux.com/ca/hosted");
    expect(hostedUrl("zh")).toBe("https://isomux.com/zh/hosted");
  });
});
