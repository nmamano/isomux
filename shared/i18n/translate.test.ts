// The lookup engine and the typed translator over it (shared/i18n/translate.ts).
// Plain bun test, no DOM. The plural cases run on a fixture catalog because the
// real one carries no plural pair yet (S1 converts only the tracer); they call
// the same pluralIn that Translator.tn delegates to.

import { describe, expect, it } from "bun:test";
import {
  interpolate,
  lookupIn,
  pluralIn,
  translatorFor,
  type Messages,
} from "./translate.ts";
import { en } from "./en.ts";
import { SUPPORTED_LANGUAGES } from "../languages.ts";

describe("interpolate", () => {
  it("fills every occurrence of a placeholder and stringifies numbers", () => {
    expect(
      interpolate("{name} and {name} owe {n}", { name: "Ada", n: 2 }),
    ).toBe("Ada and Ada owe 2");
  });

  it("leaves a placeholder with no value as written", () => {
    expect(interpolate("Hi {name}", {})).toBe("Hi {name}");
    expect(interpolate("Hi {name}")).toBe("Hi {name}");
  });
});

describe("lookupIn", () => {
  const english: Messages = { greet: "Hello {name}", only: "English only" };
  const other: Messages = { greet: "Hola {name}" };

  it("takes the catalog's text and interpolates it", () => {
    expect(lookupIn(other, english, "greet", { name: "Ada" })).toBe("Hola Ada");
  });

  it("falls back to English for a key the catalog lacks, then to the key", () => {
    expect(lookupIn(other, english, "only")).toBe("English only");
    expect(lookupIn(other, english, "nowhere")).toBe("nowhere");
  });
});

describe("pluralIn", () => {
  // A plural pair per language, as a catalog would carry it.
  const PAIRS: Record<string, Messages> = {
    en: {
      "agents.count.one": "{count} agent",
      "agents.count.other": "{count} agents",
    },
    es: {
      "agents.count.one": "{count} agente",
      "agents.count.other": "{count} agentes",
    },
    ca: {
      "agents.count.one": "{count} agent",
      "agents.count.other": "{count} agents",
    },
  };
  const pick = (language: string, count: number) =>
    pluralIn(
      PAIRS[language],
      PAIRS.en,
      new Intl.PluralRules(language),
      "agents.count",
      count,
    );

  it("picks one for 1 and other for 0, 2 and 21 in every offered language", () => {
    // The offered languages, not a hand list: a fourth language with different
    // plural rules has to be looked at here.
    expect(Object.keys(PAIRS).sort()).toEqual(
      SUPPORTED_LANGUAGES.map((l) => l.code).sort(),
    );
    for (const { code } of SUPPORTED_LANGUAGES) {
      expect(pick(code, 1)).toBe(
        PAIRS[code]["agents.count.one"]!.replace("{count}", "1"),
      );
      for (const n of [0, 2, 21]) {
        expect(pick(code, n)).toBe(
          PAIRS[code]["agents.count.other"]!.replace("{count}", String(n)),
        );
      }
    }
  });

  it("falls back to other for a category the pair does not carry", () => {
    // Spanish and Catalan rules yield "many" at a million; a pair has no such
    // entry, and the count still renders rather than the bare key.
    expect(new Intl.PluralRules("es").select(1_000_000)).toBe("many");
    expect(pick("es", 1_000_000)).toBe("1000000 agentes");
    expect(pick("ca", 1_000_000)).toBe("1000000 agents");
  });

  it("takes the one form from English when only the catalog's other exists", () => {
    const partial: Messages = { "agents.count.other": "{count} agents" };
    expect(
      pluralIn(
        partial,
        PAIRS.en,
        new Intl.PluralRules("ca"),
        "agents.count",
        1,
      ),
    ).toBe("1 agent");
  });

  it("passes the other placeholders through alongside count", () => {
    const withRoom: Messages = {
      "room.agents.one": "{count} agent in {room}",
      "room.agents.other": "{count} agents in {room}",
    };
    expect(
      pluralIn(
        withRoom,
        withRoom,
        new Intl.PluralRules("en"),
        "room.agents",
        3,
        {
          room: "Lobby",
        },
      ),
    ).toBe("3 agents in Lobby");
  });
});

describe("translatorFor", () => {
  it("answers in the asked language, with English frozen as written", () => {
    // English is frozen (ruling 6), so pinning it is safe; the other languages
    // are checked for being their own text, not for wording, which the DOM
    // test and the reviewer's read cover.
    expect(translatorFor("en").t("nav.tasks")).toBe("Tasks");
    expect(translatorFor("es").t("nav.tasks")).not.toBe(en["nav.tasks"]);
    expect(translatorFor("ca").t("nav.tasks")).not.toBe(en["nav.tasks"]);
    expect(translatorFor("ca").t("nav.tasks")).not.toBe(
      translatorFor("es").t("nav.tasks"),
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
    expect(t("nav.tasks", { name: "x" })).toBe("Tasks");
  });
});
