// The public site's per-language URLs. Literal expectations: a test that built
// its expectation from SITE_LANGUAGE_PATH would pass for any mapping.

import { describe, expect, it } from "bun:test";
import {
  SITE_ORIGIN,
  SITE_LANGUAGE_PATH,
  landingUrl,
  hostedUrl,
} from "./site-url.ts";
import { SUPPORTED_LANGUAGES } from "../languages.ts";

describe("site urls", () => {
  it("sends each language to its own landing page", () => {
    expect(landingUrl("en")).toBe("https://isomux.com");
    expect(landingUrl("es")).toBe("https://isomux.com/es");
    expect(landingUrl("ca")).toBe("https://isomux.com/ca");
  });

  it("sends each language to its own hosted page", () => {
    expect(hostedUrl("en")).toBe("https://isomux.com/hosted");
    expect(hostedUrl("es")).toBe("https://isomux.com/es/hosted");
    expect(hostedUrl("ca")).toBe("https://isomux.com/ca/hosted");
  });

  it("leaves the English URL exactly as the office has always opened it", () => {
    expect(SITE_ORIGIN).toBe("https://isomux.com");
    expect(SITE_LANGUAGE_PATH.en).toBe("");
  });

  it("covers every supported language, so a new one cannot be forgotten", () => {
    for (const option of SUPPORTED_LANGUAGES) {
      expect(typeof SITE_LANGUAGE_PATH[option.code]).toBe("string");
    }
    expect(Object.keys(SITE_LANGUAGE_PATH).sort()).toEqual(
      SUPPORTED_LANGUAGES.map((o) => o.code as string).sort(),
    );
  });
});
