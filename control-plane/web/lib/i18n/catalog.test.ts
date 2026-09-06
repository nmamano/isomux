// The catalog invariants (internal-docs/i18n-loop.md, ruling 7): English is the
// source of truth, every other language is complete over it, no value is empty,
// and a translation carries exactly the placeholders and rich tags its English
// does. The types already make a MISSING key a compile error; this is what
// catches a key that is present and wrong.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { en } from "./en";
import { es } from "./es";
import { ca } from "./ca";
import { CATALOGS, translatorFor } from "./translate";
import { SUPPORTED_LANGUAGES } from "./languages";

const OTHERS = { es, ca } as const;
const KEYS = Object.keys(en) as (keyof typeof en)[];

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/** Every opening tag, sorted. A closing tag is skipped, so a pair counts once,
 * and a repeated tag counts twice - a multiset, not a set. */
function tags(text: string): string[] {
  return [...text.matchAll(/<(\/?)(\w+)>/g)]
    .filter((m) => m[1] === "")
    .map((m) => m[2])
    .sort();
}

test("the catalog is not empty and every language is registered", () => {
  expect(KEYS.length).toBeGreaterThan(100);
  expect(Object.keys(CATALOGS).sort()).toEqual(
    SUPPORTED_LANGUAGES.map((l) => l.code).sort(),
  );
});

describe.each(Object.entries(OTHERS))("%s", (name, catalog) => {
  test("has exactly the English keys", () => {
    expect(Object.keys(catalog).sort()).toEqual([...KEYS].sort());
  });

  test("has no empty value", () => {
    for (const key of KEYS) {
      expect([key, catalog[key].trim().length > 0]).toEqual([key, true]);
    }
  });

  test("carries the same placeholders as English", () => {
    for (const key of KEYS) {
      expect([key, placeholders(catalog[key])]).toEqual([
        key,
        placeholders(en[key]),
      ]);
    }
  });

  test("carries the same rich tags as English", () => {
    for (const key of KEYS) {
      expect([key, tags(catalog[key])]).toEqual([key, tags(en[key])]);
    }
  });

  test("closes every rich tag it opens", () => {
    for (const key of KEYS) {
      const value = catalog[key];
      for (const tag of new Set(tags(value))) {
        const opens = value.split(`<${tag}>`).length - 1;
        const closes = value.split(`</${tag}>`).length - 1;
        expect([key, tag, opens]).toEqual([key, tag, closes]);
      }
    }
  });
});

test("key segments are camelCase (ruling 15)", () => {
  for (const key of KEYS) {
    for (const segment of key.split(".")) {
      expect([key, /^[a-z][A-Za-z0-9]*$/.test(segment)]).toEqual([key, true]);
    }
  }
});

test("no angle bracket that is not a rich tag pair (ruling 19)", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const catalog = CATALOGS[language.code];
    for (const key of KEYS) {
      const stripped = catalog[key].replaceAll(/<\/?\w+>/g, "");
      expect([language.code, key, stripped.includes("<")]).toEqual([
        language.code,
        key,
        false,
      ]);
      expect([language.code, key, stripped.includes(">")]).toEqual([
        language.code,
        key,
        false,
      ]);
    }
  }
});

test("a plural pair has both forms in every language", () => {
  const bases = new Set(
    KEYS.filter((k) => k.endsWith(".one")).map((k) => k.slice(0, -4)),
  );
  expect(bases.size).toBeGreaterThan(0);
  for (const language of SUPPORTED_LANGUAGES) {
    const catalog = CATALOGS[language.code] as Record<string, string>;
    for (const base of bases) {
      expect([language.code, base, typeof catalog[`${base}.other`]]).toEqual([
        language.code,
        base,
        "string",
      ]);
    }
  }
});

test("tn picks the form and fills {count}", () => {
  const en_ = translatorFor("en");
  expect(en_.tn("office.duration.hours", 1)).toBe("1 hour");
  expect(en_.tn("office.duration.hours", 2)).toBe("2 hours");
  expect(en_.tn("office.duration.seconds", 0)).toBe("0 seconds");
  expect(translatorFor("ca").tn("office.duration.minutes", 1)).toBe("1 minut");
  expect(translatorFor("es").tn("office.duration.minutes", 3)).toBe(
    "3 minutos",
  );
});

test("an unknown key falls back to English, then to the key itself", () => {
  const spanish = translatorFor("es");
  // A key the type system would refuse: the engine still has to be safe.
  expect((spanish.t as (k: string) => string)("no.such.key")).toBe(
    "no.such.key",
  );
});

/**
 * The namespaces a RUNTIME ID reaches, through `keyForId` in office-view.
 *
 * They must stay placeholder-free: the caller has an id and nothing to fill a
 * placeholder with, and the id-to-key path is typed over PlainMessageKey, so a
 * parameterized key added under one of these namespaces would be a compile error
 * at the call site rather than here. This states the rule where it is readable.
 */
test("a key an id can reach takes no placeholder", () => {
  const reachable = ["steps.", "liveness.", "attention.", "stepState."];
  for (const key of KEYS) {
    if (!reachable.some((prefix) => key.startsWith(prefix))) continue;
    for (const language of SUPPORTED_LANGUAGES) {
      expect([language.code, key, CATALOGS[language.code][key]]).not.toContain(
        "{",
      );
      expect([language.code, key, placeholders(CATALOGS[language.code][key])]).toEqual(
        [language.code, key, []],
      );
    }
  }
});

/**
 * NO ORPHANS: every key has a caller in the app's own source.
 *
 * This is the check that would have caught two `errors.checkoutSession*` keys
 * shipping with the English literals they were meant to replace still in place.
 * Product source only - a key used by nothing but a test is still an orphan.
 *
 * Two kinds of key are not spelled at a call site and are exempted by rule
 * rather than by name:
 *   - the id-derived namespaces, because `keyForId` builds the key from an
 *     operation kind, a liveness rung or an attention class, and no file under
 *     web/ may spell an operation kind at all (web-boundary.test.ts);
 *   - the leaves of a plural pair, because `tn()` is called with the base.
 */
test("every key has a caller in the app's source", () => {
  const root = path.join(import.meta.dir, "..", "..");
  const CATALOGS = new Set(["en.ts", "es.ts", "ca.ts"]);
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "e2e"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !CATALOGS.has(entry.name)
      )
        sources.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(root);
  const app = sources.join("\n");
  expect(sources.length).toBeGreaterThan(10);

  const DERIVED = ["steps.", "liveness.", "attention."];
  const orphans = KEYS.filter((key) => {
    if (DERIVED.some((prefix) => key.startsWith(prefix))) return false;
    const base = key.replace(/\.(one|other)$/, "");
    return !app.includes(`"${key}"`) && !app.includes(`"${base}"`);
  });
  expect(orphans).toEqual([]);
});
