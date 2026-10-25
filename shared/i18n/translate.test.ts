// The lookup engine and the typed translator over it (shared/i18n/translate.ts).
// Plain bun test, no DOM. lookupIn runs on fixture records, as ui/i18n.tsx calls
// it; the plural cases run on the real catalogs, through pluralFormKeyFor (the
// form log-message.ts reads) and Translator.tn.

import { describe, expect, it } from "bun:test";
import {
  lookupIn,
  pluralFormKeyFor,
  translatorFor,
  type Messages,
} from "./translate.ts";
import { en } from "./en.ts";
import { es as esCatalog } from "./es.ts";
import { SUPPORTED_LANGUAGES } from "../languages.ts";

describe("lookupIn", () => {
  const english: Messages = { greet: "Hello {name}", only: "English only" };
  const other: Messages = {
    greet: "Hola {name}",
    twice: "{name} y {name} deben {n}",
  };

  it("takes the catalog's text and fills every occurrence of a placeholder", () => {
    expect(lookupIn(other, english, "greet", { name: "Ada" })).toBe("Hola Ada");
    expect(lookupIn(other, english, "twice", { name: "Ada", n: 2 })).toBe(
      "Ada y Ada deben 2",
    );
  });

  it("leaves a placeholder with no value as written", () => {
    expect(lookupIn(other, english, "greet", {})).toBe("Hola {name}");
    expect(lookupIn(other, english, "greet")).toBe("Hola {name}");
  });

  it("falls back to English for a key the catalog lacks, then to the key", () => {
    expect(lookupIn(other, english, "only")).toBe("English only");
    expect(lookupIn(other, english, "nowhere")).toBe("nowhere");
  });
});

describe("plural forms", () => {
  const KEY = "membersChat.unreadCount";

  it("uses each offered language's plural category, including Chinese other at 1", () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      expect(pluralFormKeyFor(code, KEY, 1), code).toBe(
        code === "zh" ? `${KEY}.other` : `${KEY}.one`,
      );
      for (const n of [0, 2, 21])
        expect(pluralFormKeyFor(code, KEY, n), code).toBe(`${KEY}.other`);
    }
  });

  it("falls back to other for a category the pair does not carry", () => {
    // Spanish and Catalan rules yield "many" at a million; a pair has no such
    // entry, and the count still renders rather than the bare key.
    expect(new Intl.PluralRules("es").select(1_000_000)).toBe("many");
    expect(pluralFormKeyFor("es", KEY, 1_000_000)).toBe(`${KEY}.other`);
    expect(pluralFormKeyFor("ca", KEY, 1_000_000)).toBe(`${KEY}.other`);
  });

  it("tn words the picked form in the reader's language with count and the other placeholders", () => {
    const sizes = { before: "2 MB", after: "1 MB" };
    const fill = (text: string, count: number) =>
      text
        .replace("{count}", String(count))
        .replace("{before}", sizes.before)
        .replace("{after}", sizes.after);
    const key = "settings.storage.compressedResult";
    expect(translatorFor("en").tn(key, 1, sizes)).toBe(
      fill(en[`${key}.one`], 1),
    );
    expect(translatorFor("en").tn(key, 3, sizes)).toBe(
      fill(en[`${key}.other`], 3),
    );
    expect(translatorFor("es").tn(key, 1, sizes)).toBe(
      fill(esCatalog[`${key}.one`], 1),
    );
  });
});

describe("translatorFor", () => {
  it("answers in the asked language, with English frozen as written", () => {
    // English is frozen (ruling 6), so pinning it is safe; the other languages
    // are checked for being their own text, not for wording, which the DOM
    // test and the reviewer's read cover.
    expect(translatorFor("en").t("common.tasks")).toBe("Tasks");
    expect(translatorFor("es").t("common.tasks")).not.toBe(en["common.tasks"]);
    expect(translatorFor("ca").t("common.tasks")).not.toBe(en["common.tasks"]);
    expect(translatorFor("ca").t("common.tasks")).not.toBe(
      translatorFor("es").t("common.tasks"),
    );
  });

  it("carries its language and is one object per language", () => {
    expect(translatorFor("ca").language).toBe("ca");
    expect(translatorFor("ca")).toBe(translatorFor("ca"));
    expect(translatorFor("ca")).not.toBe(translatorFor("es"));
  });

  it("rejects parameters a key does not take", () => {
    const { t } = translatorFor("en");
    // @ts-expect-error nav.tasks has no placeholder, so t() takes no params.
    expect(t("common.tasks", { name: "x" })).toBe("Tasks");
  });

  it("renders capacity retry numbers in Chinese without stuck placeholders", () => {
    const text = translatorFor("zh").t("systemEntries.providerCapacityRetry", {
      seconds: 5,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(text).toContain(" 5 ");
    expect(text).toContain("1/3");
    expect(text).not.toMatch(/\{\w+\}/);
  });
});
