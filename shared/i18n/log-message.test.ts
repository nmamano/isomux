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
  hasLiveTimeParam,
  logEntrySegments,
  logEntryText,
  localizeLogParts,
  msg,
  msgN,
  renderLogText,
  logTextFields,
  type LogPart,
  type LogSegment,
} from "./log-message.ts";
import { CATALOGS, pluralFormKeyFor, translatorFor } from "./translate.ts";
import type { SupportedLanguageCode } from "../languages.ts";
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

// A relative moment is the one value worded against the READER's clock (task
// 9845e1da): a usage-limit notice read after the reset must not still say
// "in 3 hours". A duration or elapsed time, above, is frozen at write.
describe("a relative moment is worded when it is read", () => {
  afterEach(() => setSystemTime());

  const RESET = Date.UTC(2026, 9, 20, 12, 0);
  const HOUR = 60 * 60 * 1000;
  const notice = () =>
    msg("systemEntries.usageLimit.stopped", {
      at: { time: RESET, shape: "weekdayDateTime" },
      relative: { relative: RESET },
    });
  const want = (tr: typeof en, relative: string) =>
    tr.t("systemEntries.usageLimit.stopped", {
      at: formatDateTime(tr.language, RESET, "weekdayDateTime"),
      relative,
    });
  const until = (lang: "en" | "es", now: number) => {
    const r = timeUntilFine(lang, RESET, now);
    expect(r.kind).toBe("formatted");
    return r.kind === "formatted" ? r.text : "";
  };
  const since = (lang: "en" | "es", now: number) => {
    const r = timeSince(lang, RESET, now);
    expect(r.kind).toBe("formatted");
    return r.kind === "formatted" ? r.text : "";
  };

  it("before the moment, the time left; after it, the time since", () => {
    const before = RESET - 3 * HOUR;
    setSystemTime(new Date(before));
    expect(localizeLogParts(es, [notice()])).toBe(
      differs(want(es, until("es", before)), want(en, until("en", before))),
    );
    expect(renderLogText(en, notice())).toBe(want(en, until("en", before)));

    // The same stored line, read two hours after the reset.
    const after = RESET + 2 * HOUR;
    setSystemTime(new Date(after));
    expect(localizeLogParts(es, [notice()])).toBe(
      differs(want(es, since("es", after)), want(en, since("en", after))),
    );
    expect(renderLogText(en, notice())).toBe(want(en, since("en", after)));
  });

  it("under a minute either side is the reader's word for just now", () => {
    for (const offset of [-20_000, 20_000]) {
      setSystemTime(new Date(RESET + offset));
      expect({ offset, text: localizeLogParts(es, [notice()]) }).toEqual({
        offset,
        text: differs(
          want(es, es.t("common.justNow")),
          want(en, en.t("common.justNow")),
        ),
      });
    }
  });

  it("a malformed moment gives no line to a reader, and an empty value in the stored English", () => {
    for (const relative of [NaN, Infinity, -Infinity, "5", null]) {
      const bad = [
        {
          key: "systemEntries.usageLimit.stopped",
          params: {
            at: { time: RESET, shape: "weekdayDateTime" },
            relative: { relative },
          },
        },
      ];
      expect({ relative, text: localizeLogParts(es, bad) }).toEqual({
        relative,
        text: null,
      });
      expect(renderLogText(en, bad as LogPart[])).toBe(want(en, ""));
    }
  });
});

// Which stored lines a view must re-word as the clock moves.
describe("hasLiveTimeParam", () => {
  const live = { relative: Date.UTC(2026, 9, 20, 12, 0) };

  it("finds a relative moment at any depth", () => {
    const top = {
      key: "systemEntries.usageLimit.stopped",
      params: { at: { time: 0, shape: "weekdayDateTime" }, relative: live },
    };
    const cases: [string, unknown][] = [
      ["a top-level param", [top]],
      ["after a plain string part", ["note: ", top]],
      [
        "inside a nested message",
        [{ key: "systemEntries.contextCompacted", params: { summary: top } }],
      ],
      [
        "inside a part list",
        [
          {
            key: "systemEntries.contextCompacted",
            params: { summary: { parts: ["a", top] } },
          },
        ],
      ],
      [
        "inside a lowered message",
        [
          {
            key: "systemEntries.contextCompacted",
            params: { summary: { lower: top } },
          },
        ],
      ],
    ];
    for (const [name, parts] of cases)
      expect({ name, live: hasLiveTimeParam(parts) }).toEqual({
        name,
        live: true,
      });
  });

  it("a line with only frozen or fixed values is not live", () => {
    const cases: [string, unknown][] = [
      ["a plain message", [notFound()]],
      [
        "a duration and an elapsed time",
        [
          msg("systemEntries.usageCap.pace", { when: { duration: 60_000 } }),
          msg("settings.storage.measured", { when: { elapsed: 60_000 } }),
        ],
      ],
      [
        "a date",
        [
          {
            key: "systemEntries.pathRefusal.notFound",
            params: { path: { time: 0, shape: "date" } },
          },
        ],
      ],
      ["plain text", ["just text"]],
      ["no message", undefined],
      ["not a list", "text"],
    ];
    for (const [name, parts] of cases)
      expect({ name, live: hasLiveTimeParam(parts) }).toEqual({
        name,
        live: false,
      });
  });

  it("returns on a cycle", () => {
    const cyclic: { key: string; params: Record<string, unknown> } = {
      key: "systemEntries.contextCompacted",
      params: {},
    };
    cyclic.params.summary = cyclic;
    expect(hasLiveTimeParam([cyclic])).toBe(false);
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

// A system line keeps its values apart from its words (task aaf43a3f), so the
// chat shows a name or a path unlike the sentence around it and never shows
// raw backticks. Agents keep reading the stored content, backticks and all:
// joining the segments with each code span back in backticks gives exactly
// the text logEntryText gives.
describe("logEntrySegments: the line a reader sees, values kept apart", () => {
  const zh = translatorFor("zh");
  // The agreed design's prose placeholders: a sentence or a product name,
  // not a value.
  const PROSE = new Set([
    "error",
    "message",
    "reason",
    "summary",
    "provider",
    "engine",
  ]);

  const rewrap = (segments: LogSegment[]) =>
    segments
      .map((s) => (s.kind === "code" ? "`" + s.text + "`" : s.text))
      .join("");
  // The non-text spans, for comparing what a reader sees as values.
  const marked = (segments: LogSegment[]) =>
    segments
      .filter((s) => s.kind !== "text")
      .map((s) => ({ kind: s.kind, text: s.text }));
  const entryOf = (message: LogPart[]) => ({
    ...logTextFields(message),
    message: logTextFields(message).message,
  });
  // The quote pairs a box replaces (task 4e2aed38): the box already shows
  // where a value ends. ' is not one: it is also an apostrophe.
  const QUOTE_PAIRS = [
    ['"', '"'],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
  ] as const;
  // `line` with each quote pair around exactly one boxed span taken out.
  const dropBoxQuotes = (line: string, segments: LogSegment[]) => {
    let out = line;
    for (const s of segments) {
      if (s.kind === "text") continue;
      const shown = s.kind === "code" ? "`" + s.text + "`" : s.text;
      for (const [open, close] of QUOTE_PAIRS)
        out = out.replaceAll(open + shown + close, shown);
    }
    return out;
  };
  const quoted = (line: string, inner: string) =>
    QUOTE_PAIRS.some(([open, close]) => line.includes(open + inner + close));
  const segmentsOf = (
    tr: typeof en,
    entry: { content: string; message?: unknown },
  ) => {
    const segments = logEntrySegments(tr, entry);
    // Every reader gets the stored text, less the quotes around a lone box,
    // and no raw backtick sits in a value or code span.
    expect(rewrap(segments)).toBe(
      dropBoxQuotes(logEntryText(tr, entry), segments),
    );
    for (const s of segments)
      if (s.kind !== "text") expect(s.text).not.toContain("`");
    return segments;
  };

  it("a backtick span in the catalog is one code segment, backticks dropped", () => {
    const segments = segmentsOf(en, entryOf([notFound()]));
    expect(marked(segments)).toEqual([{ kind: "code", text: PATH }]);
    expect(segments.map((s) => s.text).join("")).not.toContain("`");
  });

  it("a name or a path outside backticks is a value segment", () => {
    const ready = segmentsOf(
      en,
      entryOf([
        msg("systemEntries.agentReady", {
          name: "Ada",
          cwd: "/home/ada/proj",
          mode: "bypassPermissions",
        }),
      ]),
    );
    expect(marked(ready)).toEqual([
      { kind: "value", text: "Ada" },
      { kind: "value", text: "/home/ada/proj" },
      { kind: "value", text: "bypassPermissions" },
    ]);
    const manager = segmentsOf(
      en,
      entryOf([
        msg("systemEntries.managerChanged", { actor: "Nil", member: "Ada" }),
      ]),
    );
    expect(marked(manager)).toEqual([
      { kind: "value", text: "Nil" },
      { kind: "value", text: "Ada" },
    ]);
  });

  it("a prose placeholder stays text, but a backtick pair inside it is code", () => {
    const plain = segmentsOf(
      en,
      entryOf([msg("systemEntries.streamError", { error: "socket hang up" })]),
    );
    expect(marked(plain)).toEqual([]);
    const withCode = segmentsOf(
      en,
      entryOf([
        msg("systemEntries.streamError", {
          error: "run `git init` first",
        }),
      ]),
    );
    expect(marked(withCode)).toEqual([{ kind: "code", text: "git init" }]);
  });

  it("a value param that carries backtick pairs gives one code segment per pair", () => {
    // memberFolderUnreachable's writer wraps each command in backticks
    // (server/member-folder-hint.ts).
    const segments = segmentsOf(
      en,
      entryOf([
        msg("systemEntries.memberFolderUnreachable", {
          user: "ada",
          path: "/home/ada/proj",
          commands:
            "`chmod o+x /home/ada` `setfacl -m u:ada:rx /home/ada/proj`",
        }),
      ]),
    );
    expect(marked(segments)).toEqual([
      { kind: "value", text: "ada" },
      { kind: "value", text: "/home/ada/proj" },
      { kind: "code", text: "chmod o+x /home/ada" },
      { kind: "code", text: "setfacl -m u:ada:rx /home/ada/proj" },
    ]);
  });

  it("numbers, sizes and other worded kinds stay text", () => {
    const exited = segmentsOf(
      en,
      entryOf([
        msg("systemEntries.askRun.exited", { code: 2, command: "make" }),
      ]),
    );
    expect(marked(exited)).toEqual([{ kind: "value", text: "make" }]);
    const big = segmentsOf(
      en,
      entryOf([
        msg("systemEntries.fileTooLargeToDisplay", {
          path: PATH,
          size: { bytes: 12_345_678 },
          limit: { number: 5 },
        }),
      ]),
    );
    expect(marked(big)).toEqual([{ kind: "code", text: PATH }]);
  });

  it("a nested message keeps its own words as text and its values apart", () => {
    const segments = segmentsOf(
      en,
      entryOf([
        msg("systemEntries.settingsNotice.change", {
          setting: msg("common.field.model"),
          from: "opus",
          to: "sonnet",
        }),
        "\n",
        msg("systemEntries.alreadyUsing", {
          label: msg("systemEntries.managerChanged", {
            actor: "Nil",
            member: "Ada",
          }),
        }),
      ]),
    );
    expect(marked(segments)).toEqual([
      { kind: "value", text: "opus" },
      { kind: "value", text: "sonnet" },
      { kind: "value", text: "Nil" },
      { kind: "value", text: "Ada" },
    ]);
    // The field label is words, not a value.
    expect(
      segments.some(
        (s) => s.kind === "text" && s.text.includes(en.t("common.field.model")),
      ),
    ).toBe(true);
  });

  it("a part list keeps its strings as words, a backtick pair in them as code", () => {
    const segments = segmentsOf(
      en,
      entryOf([
        msg("systemEntries.alreadyUsing", {
          label: {
            parts: [
              "plain words and `npm test`, then ",
              msg("systemEntries.managerChanged", {
                actor: "Nil",
                member: "Ada",
              }),
            ],
          },
        }),
      ]),
    );
    expect(marked(segments)).toEqual([
      { kind: "code", text: "npm test" },
      { kind: "value", text: "Nil" },
      { kind: "value", text: "Ada" },
    ]);
  });

  it("a translated catalog keeps the same values apart, in the reader's words", () => {
    const ready = entryOf([
      msg("systemEntries.agentReady", {
        name: "Ada",
        cwd: "/home/ada/proj",
        mode: "plan",
      }),
    ]);
    const english = segmentsOf(en, ready);
    for (const tr of [es, zh]) {
      const segments = segmentsOf(tr, ready);
      differs(rewrap(segments), rewrap(english));
      expect(
        [...marked(segments)].sort((a, b) => a.text.localeCompare(b.text)),
      ).toEqual(
        [...marked(english)].sort((a, b) => a.text.localeCompare(b.text)),
      );
      expect(marked(segmentsOf(tr, entryOf([notFound()])))).toEqual([
        { kind: "code", text: PATH },
      ]);
    }
  });

  it("with no message, backtick pairs on one line in the content are code", () => {
    const pair = segmentsOf(en, { content: "Cannot open `a b` now." });
    expect(marked(pair)).toEqual([{ kind: "code", text: "a b" }]);
    const lone = segmentsOf(en, { content: "One ` alone, and `` empty." });
    expect(marked(lone)).toEqual([]);
    const across = segmentsOf(en, { content: "x `a\nb` y" });
    expect(marked(across)).toEqual([]);
    // A message no reader can word falls back to the content, split the same.
    const broken = segmentsOf(en, {
      content: "File `x.txt` gone",
      message: [{ key: "systemEntries.noSuchKey" }],
    });
    expect(marked(broken)).toEqual([{ kind: "code", text: "x.txt" }]);
    const badParam = segmentsOf(en, {
      content: "Stored `y`",
      message: [
        {
          key: "systemEntries.pathRefusal.notFound",
          params: { path: PATH, extra: { nope: 1 } },
        },
      ],
    });
    expect(marked(badParam)).toEqual([{ kind: "code", text: "y" }]);
  });

  it("a lone boxed value or code span loses its quotes; the stored line keeps them", () => {
    const ready = entryOf([
      msg("systemEntries.agentReady", {
        name: "Ada",
        cwd: "/home/ada/proj",
        mode: "plan",
      }),
    ]);
    for (const tr of [en, es, translatorFor("ca"), zh]) {
      // The catalog puts the name in a quote pair, and the stored line
      // (what agents and search read) keeps it.
      const stored = logEntryText(tr, ready);
      expect(quoted(stored, "Ada")).toBe(true);
      const segments = segmentsOf(tr, ready);
      const at = segments.findIndex(
        (s) => s.kind === "value" && s.text === "Ada",
      );
      expect(at).toBeGreaterThan(0);
      const before = segments[at - 1].text;
      const after = segments[at + 1].text;
      for (const [open, close] of QUOTE_PAIRS)
        expect(before.endsWith(open) && after.startsWith(close)).toBe(false);
      expect(quoted(rewrap(segments), "Ada")).toBe(false);
    }
    // A code span alone in quotes, in the content and in a stored part; a
    // text segment left empty is dropped.
    for (const [open, close] of QUOTE_PAIRS) {
      const line = `Run ${open}\`ls -la\`${close} now.`;
      for (const entry of [
        { content: line },
        { content: "stored", message: [line] },
      ]) {
        const segments = segmentsOf(en, entry);
        expect(marked(segments)).toEqual([{ kind: "code", text: "ls -la" }]);
        expect(rewrap(segments)).toBe("Run `ls -la` now.");
      }
      const whole = segmentsOf(en, { content: `${open}\`ls\`${close}` });
      expect(whole).toEqual([{ kind: "code", text: "ls" }]);
    }
  });

  it("quotes stay around prose, around several spans, and when the marks do not match", () => {
    const refusal = "Model overloaded";
    for (const tr of [en, zh]) {
      const entry = entryOf([
        msg("systemEntries.providerRefused", {
          provider: "openrouter",
          message: refusal,
        }),
      ]);
      const stored = logEntryText(tr, entry);
      expect(quoted(stored, refusal)).toBe(true);
      expect(rewrap(segmentsOf(tr, entry))).toBe(stored);
    }
    for (const content of [
      'Run "`ls`\u300d now.',
      'Run \u300c`ls`" now.',
      "Run \u201d`ls`\u201c now.",
      'Run "`a` `b`" now.',
      'Run "`a` and" now.',
    ]) {
      const segments = segmentsOf(en, { content });
      expect(segments.some((s) => s.kind === "code")).toBe(true);
      expect(rewrap(segments)).toBe(content);
    }
  });

  // Every system line in every language, with a string value per
  // placeholder: the text is the plain template fill (independent of the
  // walk under test), a value outside backticks is a value segment unless its
  // name is prose, and a value inside backticks sits in a code segment.
  it("every systemEntries line keeps its text and splits its values", () => {
    const PAIR = /`[^`\n]+`/g;
    const PH = /\{(\w+)\}/g;
    const LONE = /(["\u201c\u300c])(\{(\w+)\}|`[^`\n]+`)(["\u201d\u300d])/g;
    const dropped = new Set<string>();
    const english = CATALOGS.en as Record<string, string>;
    const value = (name: string) => `v-${name}`;
    let checked = 0;
    for (const language of Object.keys(CATALOGS) as SupportedLanguageCode[]) {
      const tr = translatorFor(language);
      const catalog = CATALOGS[language] as Record<string, string>;
      const cases: {
        message: Record<string, unknown>;
        template: string;
        count?: number;
      }[] = [];
      for (const key of Object.keys(english)) {
        if (!key.startsWith("systemEntries.")) continue;
        const pluralBase = key.endsWith(".one") ? key.slice(0, -4) : null;
        if (pluralBase && Object.hasOwn(english, `${pluralBase}.other`)) {
          for (const count of [1, 5]) {
            const formKey = pluralFormKeyFor(language, pluralBase, count);
            const template = catalog[formKey] ?? english[formKey];
            const names = [
              ...new Set(
                [...english[`${pluralBase}.other`].matchAll(PH)].map(
                  (m) => m[1],
                ),
              ),
            ].filter((n) => n !== "count");
            cases.push({
              message: {
                key: pluralBase,
                count,
                ...(names.length
                  ? {
                      params: Object.fromEntries(
                        names.map((n) => [n, value(n)]),
                      ),
                    }
                  : {}),
              },
              template: template.replaceAll("{count}", String(count)),
              count,
            });
          }
          continue;
        }
        if (
          /\.(other|few|many|two|zero)$/.test(key) &&
          Object.hasOwn(english, key.replace(/\.\w+$/, ".one"))
        )
          continue;
        const template = catalog[key] ?? english[key];
        const names = [
          ...new Set([...english[key].matchAll(PH)].map((m) => m[1])),
        ];
        cases.push({
          message: {
            key,
            ...(names.length
              ? { params: Object.fromEntries(names.map((n) => [n, value(n)])) }
              : {}),
          },
          template,
        });
      }
      for (const { message, template } of cases) {
        const filled = template.replace(PH, (whole, n: string) =>
          n === "count" ? whole : value(n),
        );
        const entry = { content: "stored", message: [message] };
        expect(localizeLogParts(tr, [message])).toBe(filled);
        const segments = logEntrySegments(tr, entry);
        // A box replaces the quote pair around a lone value or code span:
        // the pair goes, a prose placeholder keeps it.
        const boxed = template
          .replace(LONE, (whole, open: string, inner: string, name, close) =>
            QUOTE_PAIRS.some(([o, c]) => o === open && c === close) &&
            (name === undefined || !PROSE.has(name))
              ? inner
              : whole,
          )
          .replace(PH, (whole, n: string) =>
            n === "count" ? whole : value(n),
          );
        if (boxed !== filled) dropped.add(language);
        expect(rewrap(segments)).toBe(boxed);
        const codeText = segments
          .filter((s) => s.kind === "code")
          .map((s) => s.text)
          .join("\u0000");
        const values = segments
          .filter((s) => s.kind === "value")
          .map((s) => s.text);
        const insidePairs = new Set(
          [...template.matchAll(PAIR)].flatMap((m) =>
            [...m[0].matchAll(PH)].map((p) => p[1]),
          ),
        );
        const outside = [...template.replace(PAIR, "").matchAll(PH)]
          .map((m) => m[1])
          .filter((n) => n !== "count");
        for (const n of insidePairs) expect(codeText).toContain(value(n));
        const wantValues = outside.filter((n) => !PROSE.has(n)).map(value);
        expect([...values].sort()).toEqual([...wantValues].sort());
        checked++;
      }
    }
    // Every language and the many system lines were walked.
    expect(checked).toBeGreaterThan(4 * 250);
    // Each language has a line whose box dropped its quotes.
    expect([...dropped].sort()).toEqual(Object.keys(CATALOGS).sort());
  });
});
