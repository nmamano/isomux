// A server-written log line is a message key and its values, worded by each
// reader (task c37a7365). These tests own the pure contract: the wire shape
// msg/msgN store, how each value kind is worded for a reader, and the
// fallback rule - anything unknown or malformed gives null, so the caller
// shows the stored English for the whole line and never mixes two languages.
//
// Expected text comes from the catalog engine (translatorFor) and the shared
// formatters, never from log-message.ts itself (testing guide, principle 15
// and its exception for catalog values). `differs` proves a Spanish
// expectation is not the English one, so a renderer that ignored the reader
// could not pass.

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  logEntryText,
  localizeLogParts,
  msg,
  msgN,
  renderLogText,
  type LogPart,
} from "./log-message.ts";
import { translatorFor } from "./translate.ts";
import { formatBytes, formatDecimal, formatNumber } from "./number.ts";
import { formatDateTime, timeSince, timeUntilFine } from "./time.ts";

const en = translatorFor("en");
const es = translatorFor("es");

function differs(spanish: string, english: string): string {
  expect(spanish).not.toBe(english);
  return spanish;
}

const PATH = "/srv/data/report.txt";
const notFound = () =>
  msg("systemEntries.pathRefusal.notFound", { path: PATH });

describe("msg and msgN store a key and its values, as plain data", () => {
  // The shape is a wire format: it is written to disk and read back by every
  // later UI, so it is asserted as data.
  it("keeps the key and params, and the count of a plural pair", () => {
    expect(notFound()).toEqual({
      key: "systemEntries.pathRefusal.notFound",
      params: { path: PATH },
    });
    expect(msgN("systemEntries.queueCarried", 3)).toEqual({
      key: "systemEntries.queueCarried",
      count: 3,
    });
    const parts = [notFound(), "\n\nraw"];
    expect(JSON.parse(JSON.stringify(parts))).toEqual(parts);
  });
});

describe("a message is worded in the reader's language", () => {
  it("renders English for the stored content and Spanish for a Spanish reader", () => {
    const english = en.t("systemEntries.pathRefusal.notFound", { path: PATH });
    expect(renderLogText(en, notFound())).toBe(english);
    expect(renderLogText(en, [notFound()])).toBe(english);
    expect(localizeLogParts(es, [notFound()])).toBe(
      differs(
        es.t("systemEntries.pathRefusal.notFound", { path: PATH }),
        english,
      ),
    );
  });

  it("joins the parts in order and leaves a plain string part as written", () => {
    // Raw text (provider output, a code block) can hold braces; it is not a
    // template, so nothing in it is filled.
    const raw = "\n\n```\nconst {path} = x;\n```";
    const parts: LogPart[] = [notFound(), raw];
    expect(renderLogText(en, parts)).toBe(
      en.t("systemEntries.pathRefusal.notFound", { path: PATH }) + raw,
    );
    expect(localizeLogParts(es, parts)).toBe(
      es.t("systemEntries.pathRefusal.notFound", { path: PATH }) + raw,
    );
    expect(renderLogText(en, "plain {path}")).toBe("plain {path}");
  });

  it("words a message inside a message in the reader's language too", () => {
    const outer = msg("systemEntries.contextCompacted", {
      summary: notFound(),
    });
    const inner = (tr: typeof en) =>
      tr.t("systemEntries.pathRefusal.notFound", { path: PATH });
    expect(renderLogText(en, outer)).toBe(
      en.t("systemEntries.contextCompacted", { summary: inner(en) }),
    );
    expect(localizeLogParts(es, [outer])).toBe(
      differs(
        es.t("systemEntries.contextCompacted", { summary: inner(es) }),
        en.t("systemEntries.contextCompacted", { summary: inner(en) }),
      ),
    );
  });

  it("picks the reader's plural form and fills {count} from the count", () => {
    for (const count of [1, 3]) {
      const m = msgN("systemEntries.queueCarried", count);
      expect(renderLogText(en, m)).toBe(
        en.tn("systemEntries.queueCarried", count),
      );
      expect(localizeLogParts(es, [m])).toBe(
        differs(
          es.tn("systemEntries.queueCarried", count),
          en.tn("systemEntries.queueCarried", count),
        ),
      );
    }
    expect(
      localizeLogParts(es, [msgN("systemEntries.queueCarried", 1)]),
    ).not.toBe(localizeLogParts(es, [msgN("systemEntries.queueCarried", 3)]));
  });
});

describe("each value kind is worded for the reader", () => {
  const SIZE = 1_234_567;

  it("numbers and sizes use the reader's marks; a raw number stays as written", () => {
    const tooLarge = (limit: number | { number: number; digits?: number }) =>
      msg("systemEntries.fileTooLargeToDisplay", {
        path: PATH,
        size: { bytes: SIZE },
        limit,
      });
    const want = (
      tr: typeof en,
      limit: (lang: "en" | "es") => string,
    ): string =>
      tr.t("systemEntries.fileTooLargeToDisplay", {
        path: PATH,
        size: formatBytes(tr.language, SIZE)!,
        limit: limit(tr.language as "en" | "es"),
      });

    // {number}: the reader's grouping.
    const grouped = tooLarge({ number: SIZE });
    expect(renderLogText(en, grouped)).toBe(
      want(en, (l) => formatNumber(l, SIZE)),
    );
    expect(localizeLogParts(es, [grouped])).toBe(
      differs(
        want(es, (l) => formatNumber(l, SIZE)),
        want(en, (l) => formatNumber(l, SIZE)),
      ),
    );

    // {number, digits}: fixed fraction digits in the reader's marks.
    const decimal = tooLarge({ number: 2.5, digits: 1 });
    expect(localizeLogParts(es, [decimal])).toBe(
      differs(
        want(es, (l) => formatDecimal(l, 2.5, 1)),
        want(en, (l) => formatDecimal(l, 2.5, 1)),
      ),
    );

    // A raw number: an exit code or a port, no grouping in any language.
    const raw = tooLarge(SIZE);
    expect(localizeLogParts(es, [raw])).toBe(want(es, () => String(SIZE)));
    expect(renderLogText(en, raw)).toBe(want(en, () => String(SIZE)));
  });

  it("a date uses the reader's format", () => {
    const at = Date.UTC(2026, 9, 20, 15, 30);
    const m = msg("settings.update.lastUpdate", {
      date: { time: at, shape: "fullDate" },
    });
    expect(renderLogText(en, m)).toBe(
      en.t("settings.update.lastUpdate", {
        date: formatDateTime("en", at, "fullDate"),
      }),
    );
    expect(localizeLogParts(es, [m])).toBe(
      differs(
        es.t("settings.update.lastUpdate", {
          date: formatDateTime("es", at, "fullDate"),
        }),
        en.t("settings.update.lastUpdate", {
          date: formatDateTime("en", at, "fullDate"),
        }),
      ),
    );
  });

  describe("a duration is frozen when the server writes it", () => {
    afterEach(() => setSystemTime());

    it("reads the same span however late it is read", () => {
      const THREE_HOURS = 3 * 60 * 60 * 1000;
      const written = Date.UTC(2026, 9, 20, 12, 0);
      const span = (lang: "en" | "es") => {
        const r = timeUntilFine(lang, written + THREE_HOURS, written);
        expect(r.kind).toBe("formatted");
        return r.kind === "formatted" ? r.text : "";
      };
      const m = msg("systemEntries.usageCap.pace", {
        when: { duration: THREE_HOURS },
      });
      const wantEs = differs(
        es.t("systemEntries.usageCap.pace", { when: span("es") }),
        en.t("systemEntries.usageCap.pace", { when: span("en") }),
      );

      setSystemTime(new Date(written));
      expect(localizeLogParts(es, [m])).toBe(wantEs);
      expect(renderLogText(en, m)).toBe(
        en.t("systemEntries.usageCap.pace", { when: span("en") }),
      );
      // Two hours later, past the moment a stored deadline would have
      // shrunk to "in 1 hour": the line still says what it said.
      setSystemTime(new Date(written + 2 * 60 * 60 * 1000));
      expect(localizeLogParts(es, [m])).toBe(wantEs);
    });
  });
});

describe("slice 2 value kinds", () => {
  afterEach(() => setSystemTime());

  // "Measured 5 minutes ago" is frozen like a duration: the line says what
  // it said when the server wrote it.
  it("an elapsed time is frozen when the server writes it", () => {
    const FIVE_MINUTES = 5 * 60 * 1000;
    const written = Date.UTC(2026, 9, 20, 12, 0);
    const ago = (lang: "en" | "es") => {
      const r = timeSince(lang, written - FIVE_MINUTES, written);
      expect(r.kind).toBe("formatted");
      return r.kind === "formatted" ? r.text : "";
    };
    const m = msg("settings.storage.measured", {
      when: { elapsed: FIVE_MINUTES },
    });
    const wantEs = differs(
      es.t("settings.storage.measured", { when: ago("es") }),
      en.t("settings.storage.measured", { when: ago("en") }),
    );
    setSystemTime(new Date(written));
    expect(localizeLogParts(es, [m])).toBe(wantEs);
    expect(renderLogText(en, m)).toBe(
      en.t("settings.storage.measured", { when: ago("en") }),
    );
    setSystemTime(new Date(written + 2 * 60 * 60 * 1000));
    expect(localizeLogParts(es, [m])).toBe(wantEs);
  });

  it("an elapsed time under a minute is the reader's word for just now", () => {
    const m = msg("settings.storage.measured", { when: { elapsed: 10_000 } });
    expect(localizeLogParts(es, [m])).toBe(
      differs(
        es.t("settings.storage.measured", { when: es.t("common.justNow") }),
        en.t("settings.storage.measured", { when: en.t("common.justNow") }),
      ),
    );
    expect(renderLogText(en, m)).toBe(
      en.t("settings.storage.measured", { when: en.t("common.justNow") }),
    );
  });

  it("a lowered label is worded, then lowercased in the reader's language", () => {
    const m = msg("storageReport.locationNotSetUp", {
      label: { lower: msg("common.field.workingDirectory") },
    });
    const want = (tr: typeof en) =>
      tr.t("storageReport.locationNotSetUp", {
        label: tr
          .t("common.field.workingDirectory")
          .toLocaleLowerCase(tr.language),
      });
    // The enabling condition: the label has capitals to lose.
    expect(en.t("common.field.workingDirectory")).not.toBe(
      en.t("common.field.workingDirectory").toLowerCase(),
    );
    expect(renderLogText(en, m)).toBe(want(en));
    expect(localizeLogParts(es, [m])).toBe(differs(want(es), want(en)));
  });

  it("a part list is one value: strings as written, messages worded", () => {
    const m = msg("storageReport.locations", {
      paths: {
        parts: [
          { key: "common.field.model" },
          msg("storageReport.locationsJoin"),
          "`/srv/{state}`",
        ],
      },
    });
    const want = (tr: typeof en) =>
      tr.t("storageReport.locations", {
        paths: `${tr.t("common.field.model")}${tr.t("storageReport.locationsJoin")}\`/srv/{state}\``,
      });
    expect(renderLogText(en, m)).toBe(want(en));
    expect(localizeLogParts(es, [m])).toBe(differs(want(es), want(en)));
  });
});

describe("anything unknown or malformed falls back to the stored English", () => {
  // Every case is one defect applied to a valid base. The base is checked
  // first, so each null below is that defect's, not a broken fixture's.
  const valid = (): LogPart[] => [notFound()];
  const withParams = (params: unknown): unknown => [
    { key: "systemEntries.pathRefusal.notFound", params },
  ];
  const tooLarge = (over: Record<string, unknown>): unknown => [
    {
      key: "systemEntries.fileTooLargeToDisplay",
      params: { path: PATH, size: { bytes: 1024 }, limit: 10, ...over },
    },
  ];

  it("accepts the valid bases", () => {
    expect(localizeLogParts(es, valid())).not.toBeNull();
    expect(localizeLogParts(es, tooLarge({}))).not.toBeNull();
    expect(
      localizeLogParts(es, [msgN("systemEntries.queueCarried", 2)]),
    ).not.toBeNull();
  });

  // Literal, not msg(): the table is built while tests are collected.
  const NOT_FOUND = {
    key: "systemEntries.pathRefusal.notFound",
    params: { path: PATH },
  };
  const cases: [string, unknown][] = [
    // The container and its parts.
    ["parts that are not a list", NOT_FOUND],
    ["parts that are a string", "text"],
    ["parts that are null", null],
    ["parts that are missing", undefined],
    ["a number part", [42]],
    ["a null part", [null]],
    ["a boolean part", [true]],
    ["a list part", [["nested"]]],
    // The key: own properties of the English catalog only.
    ["an unknown key", [{ key: "systemEntries.noSuchLine" }]],
    ["an inherited key: constructor", [{ key: "constructor" }]],
    ["an inherited key: toString", [{ key: "toString" }]],
    ["an inherited key: __proto__", [{ key: "__proto__" }]],
    ["an inherited key: hasOwnProperty", [{ key: "hasOwnProperty" }]],
    ["a key that is not a string", [{ key: 5 }]],
    ["a part with no key", [{ params: { path: PATH } }]],
    // Placeholders.
    ["no params for a key that has a placeholder", withParams(undefined)],
    ["params that are not an object", withParams("x")],
    ["a placeholder with no value", tooLarge({ limit: undefined })],
    // Value shapes.
    ["a boolean value", withParams({ path: true })],
    ["a null value", withParams({ path: null })],
    ["a list value", withParams({ path: [1] })],
    ["an empty object value", withParams({ path: {} })],
    ["a number value that is a string", tooLarge({ limit: { number: "1" } })],
    ["a number value that is NaN", tooLarge({ limit: { number: NaN } })],
    [
      "a number value that is infinite",
      tooLarge({ limit: { number: Infinity } }),
    ],
    ["negative digits", tooLarge({ limit: { number: 1, digits: -1 } })],
    ["fractional digits", tooLarge({ limit: { number: 1, digits: 1.5 } })],
    [
      "digits that are a string",
      tooLarge({ limit: { number: 1, digits: "1" } }),
    ],
    ["a size that is NaN", tooLarge({ size: { bytes: NaN } })],
    ["a negative size", tooLarge({ size: { bytes: -1 } })],
    ["a date that is NaN", withParams({ path: { time: NaN, shape: "date" } })],
    [
      "a date with an unknown shape",
      withParams({ path: { time: 1, shape: "nope" } }),
    ],
    [
      "a date with an inherited shape",
      withParams({ path: { time: 1, shape: "constructor" } }),
    ],
    ["a date with no shape", withParams({ path: { time: 1 } })],
    ["a zero duration", withParams({ path: { duration: 0 } })],
    ["a negative duration", withParams({ path: { duration: -60_000 } })],
    ["a NaN duration", withParams({ path: { duration: NaN } })],
    ["a duration under a minute", withParams({ path: { duration: 10_000 } })],
    // Slice 2 kinds.
    ["a NaN elapsed time", withParams({ path: { elapsed: NaN } })],
    ["a negative elapsed time", withParams({ path: { elapsed: -1 } })],
    [
      "an elapsed time that is a string",
      withParams({ path: { elapsed: "5" } }),
    ],
    [
      "a lowered value that is not a message",
      withParams({ path: { lower: "Model" } }),
    ],
    [
      "a lowered message with an unknown key",
      withParams({ path: { lower: { key: "systemEntries.noSuchLine" } } }),
    ],
    ["a part list that is not a list", withParams({ path: { parts: "a, b" } })],
    [
      "a part list with a number part",
      withParams({ path: { parts: ["a", 5] } }),
    ],
    [
      "a part list with an unknown key",
      withParams({
        path: { parts: ["a", { key: "systemEntries.noSuchLine" }] },
      }),
    ],
    // A message inside a message is held to the same rules.
    [
      "an unknown key inside a message",
      [
        {
          key: "systemEntries.contextCompacted",
          params: { summary: { key: "systemEntries.noSuchLine" } },
        },
      ],
    ],
    [
      "a missing placeholder inside a message",
      [
        {
          key: "systemEntries.contextCompacted",
          params: { summary: { key: "systemEntries.pathRefusal.notFound" } },
        },
      ],
    ],
    // Plural pairs.
    [
      "a count on a key that is not a plural pair",
      [{ ...NOT_FOUND, count: 1 }],
    ],
    ["a plural base with no count", [{ key: "systemEntries.queueCarried" }]],
    [
      "a count on one form of a pair",
      [{ key: "systemEntries.queueCarried.one", count: 1 }],
    ],
    [
      "a count that is NaN",
      [{ key: "systemEntries.queueCarried", count: NaN }],
    ],
    [
      "a count that is infinite",
      [{ key: "systemEntries.queueCarried", count: Infinity }],
    ],
    [
      "a count that is a string",
      [{ key: "systemEntries.queueCarried", count: "3" }],
    ],
    // One bad part spoils the line: no mixed languages.
    ["a valid part next to a bad one", [NOT_FOUND, { key: "nope" }]],
  ];

  for (const [name, parts] of cases) {
    it(`gives null for ${name}`, () => {
      expect(localizeLogParts(es, parts)).toBeNull();
    });
  }

  it("bounds nesting, and survives a cycle", () => {
    const nest = (depth: number): unknown => {
      let m: unknown = notFound();
      for (let i = 0; i < depth; i++)
        m = { key: "systemEntries.contextCompacted", params: { summary: m } };
      return m;
    };
    expect(localizeLogParts(es, [nest(2)])).not.toBeNull();
    expect(localizeLogParts(es, [nest(50)])).toBeNull();
    // A part list does not reset the bound.
    const throughParts = {
      key: "systemEntries.contextCompacted",
      params: { summary: { parts: [nest(50)] } },
    };
    expect(localizeLogParts(es, [throughParts])).toBeNull();

    const cyclic: { key: string; params: Record<string, unknown> } = {
      key: "systemEntries.contextCompacted",
      params: {},
    };
    cyclic.params.summary = cyclic;
    expect(localizeLogParts(es, [cyclic])).toBeNull();
  });
});

describe("logEntryText: the line a reader sees", () => {
  const content = en.t("systemEntries.pathRefusal.notFound", { path: PATH });

  it("words the message for the reader when it is valid", () => {
    expect(logEntryText(es, { content, message: [notFound()] })).toBe(
      differs(
        es.t("systemEntries.pathRefusal.notFound", { path: PATH }),
        content,
      ),
    );
  });

  it("shows the stored content when there is no message, or a bad one", () => {
    expect(logEntryText(es, { content })).toBe(content);
    expect(logEntryText(es, { content, message: "not parts" })).toBe(content);
    expect(
      logEntryText(es, { content, message: [notFound(), { key: "nope" }] }),
    ).toBe(content);
  });
});
