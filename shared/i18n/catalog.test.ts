// Catalog completeness (internal-docs/i18n-loop.md, ruling 7), at runtime and
// over every offered language: the same key set as English, no empty value, the
// same placeholders, and plural pairs that are whole. The types already make a
// missing or extra key a compile error; this is what bun test sees, since
// `bun test` does not typecheck.

import { describe, expect, it } from "bun:test";
import { CATALOGS } from "./translate.ts";
import { en } from "./en.ts";
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from "../languages.ts";

const ENGLISH_KEYS = Object.keys(en).sort();

// Same pattern as interpolate(). A set, not a multiset: interpolate replaces
// every occurrence, so a translation may repeat a placeholder English uses
// once, and that is a valid sentence, not a defect.
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

const OTHER_LANGUAGES = SUPPORTED_LANGUAGES.map((l) => l.code).filter(
  (code) => code !== DEFAULT_LANGUAGE,
);

describe("placeholders", () => {
  it("is the set of names, so repeating one is not a difference", () => {
    expect(placeholders("{name} and {name} owe {n}")).toEqual(["n", "name"]);
    expect(placeholders("{name} and {name} owe {n}")).toEqual(
      placeholders("{n} owed by {name}"),
    );
    expect(placeholders("no placeholder")).toEqual([]);
  });
});

describe("the catalogs", () => {
  it("cover every offered language and the tracer is not empty", () => {
    expect(ENGLISH_KEYS.length).toBeGreaterThan(0);
    expect(OTHER_LANGUAGES.length).toBeGreaterThan(0);
    for (const code of SUPPORTED_LANGUAGES.map((l) => l.code))
      expect(CATALOGS[code]).toBeDefined();
  });

  for (const code of OTHER_LANGUAGES) {
    describe(code, () => {
      const catalog = CATALOGS[code];

      it("has exactly the English keys", () => {
        expect(Object.keys(catalog).sort()).toEqual(ENGLISH_KEYS);
      });

      it("has no empty value", () => {
        for (const key of ENGLISH_KEYS)
          expect(catalog[key as keyof typeof en].trim(), key).not.toBe("");
      });

      it("uses the same placeholders as English", () => {
        for (const key of ENGLISH_KEYS)
          expect(placeholders(catalog[key as keyof typeof en]), key).toEqual(
            placeholders(en[key as keyof typeof en]),
          );
      });
    });
  }

  it("keeps every plural pair whole in English", () => {
    for (const key of ENGLISH_KEYS) {
      const pair = key.endsWith(".one")
        ? key.slice(0, -".one".length) + ".other"
        : key.endsWith(".other")
          ? key.slice(0, -".other".length) + ".one"
          : null;
      if (pair !== null) expect(ENGLISH_KEYS, key).toContain(pair);
    }
  });

  it("names keys by surface and meaning, never by the English text", () => {
    for (const key of ENGLISH_KEYS) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
      expect(key.toLowerCase()).not.toBe(
        en[key as keyof typeof en].toLowerCase(),
      );
    }
  });
});
