// Catalog completeness (internal-docs/i18n-loop.md, ruling 7), at runtime and
// over every offered language: the same key set as English, no empty value, the
// same placeholders, the same rich-text tags (ruling 16), and plural pairs
// that are whole. The types already make a
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

// The tag pairs of ruling 16, as rich() in ui/i18n.tsx reads them: a multiset,
// because a translation that drops one of English's three <code> spans has
// lost a command. Sorted so order is not a difference.
function tags(text: string): string[] {
  return [...text.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();
}

// Every open tag closes before the next one opens, and never inside another
// pair: the rich() parser is one level deep by design.
function tagsAreBalancedAndFlat(text: string): boolean {
  let open: string | null = null;
  for (const m of text.matchAll(/<(\/?)(\w+)>/g)) {
    if (m[1] === "") {
      if (open !== null) return false;
      open = m[2];
    } else {
      if (open !== m[2]) return false;
      open = null;
    }
  }
  return open === null;
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

describe("tags", () => {
  it("is the multiset of open tags, so dropping one is a difference", () => {
    expect(tags("Run <code>a</code> then <code>b</code>")).toEqual([
      "code",
      "code",
    ]);
    expect(tags("Run <code>a</code>")).not.toEqual(
      tags("Run <code>a</code> then <code>b</code>"),
    );
    expect(tags("<strong>x</strong> and <code>y</code>")).toEqual(
      tags("<code>y</code> before <strong>x</strong>"),
    );
    expect(tags("no tag")).toEqual([]);
  });

  it("tells a balanced flat pair from a nested, unclosed or crossed one", () => {
    expect(tagsAreBalancedAndFlat("<a>x</a> <b>y</b>")).toBe(true);
    expect(tagsAreBalancedAndFlat("plain")).toBe(true);
    expect(tagsAreBalancedAndFlat("<a><b>x</b></a>")).toBe(false);
    expect(tagsAreBalancedAndFlat("<a>x")).toBe(false);
    expect(tagsAreBalancedAndFlat("x</a>")).toBe(false);
    expect(tagsAreBalancedAndFlat("<a>x</b>")).toBe(false);
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

      it("uses the same rich-text tags as English, each pair closed and flat", () => {
        for (const key of ENGLISH_KEYS) {
          const text = catalog[key as keyof typeof en];
          expect(tags(text), key).toEqual(tags(en[key as keyof typeof en]));
          expect(tagsAreBalancedAndFlat(text), key).toBe(true);
        }
      });
    });
  }

  it("keeps every English tag pair closed and flat, and at least one exists", () => {
    let tagged = 0;
    for (const key of ENGLISH_KEYS) {
      const text = en[key as keyof typeof en];
      expect(tagsAreBalancedAndFlat(text), key).toBe(true);
      if (tags(text).length > 0) tagged++;
    }
    expect(tagged).toBeGreaterThan(0);
  });

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
