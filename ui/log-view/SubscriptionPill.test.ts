// The subscription pill's popover tells you when the allowance comes back, and
// "in 2 days 5 hours" is the part people actually read. Rounding rules are
// frozen here; the DOM/popover lifecycle isn't covered because the UI has no
// React render harness (same limitation noted in ContextBattery.test.ts).
import { describe, it, expect } from "bun:test";
import {
  formatTimeUntil,
  resolveTrackedWindow,
  windowLine,
} from "./SubscriptionPill.tsx";
import { translatorFor } from "../../shared/i18n/translate.ts";

// The catalog's English: the durations read exactly as they did before the
// strings moved into the catalog (ruling 6).
const EN = translatorFor("en");
const ES = translatorFor("es");
const CA = translatorFor("ca");
import { bandColor } from "./ContextBattery.tsx";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatTimeUntil", () => {
  it("drops to minutes under an hour, and never shows seconds", () => {
    expect(formatTimeUntil(EN, 0)).toBe("0 min");
    expect(formatTimeUntil(EN, 45_000)).toBe("0 min");
    expect(formatTimeUntil(EN, 12 * MIN)).toBe("12 min");
    expect(formatTimeUntil(EN, 59 * MIN)).toBe("59 min");
  });

  it("pairs hours with minutes, and days with hours", () => {
    expect(formatTimeUntil(EN, HOUR)).toBe("1 hour 0 min");
    expect(formatTimeUntil(EN, 3 * HOUR + 10 * MIN)).toBe("3 hours 10 min");
    expect(formatTimeUntil(EN, 2 * DAY + 5 * HOUR)).toBe("2 days 5 hours");
    expect(formatTimeUntil(EN, DAY + HOUR)).toBe("1 day 1 hour");
  });

  it("omits a zero tail rather than printing '3 days 0 hours'", () => {
    expect(formatTimeUntil(EN, 3 * DAY)).toBe("3 days");
    expect(formatTimeUntil(EN, DAY + 30 * MIN)).toBe("1 day");
  });

  it("clamps a past reset to zero instead of going negative", () => {
    expect(formatTimeUntil(EN, -5 * HOUR)).toBe("0 min");
  });
});

// One popover row, in three languages. The row is where the language reaches
// BOTH the words and the date: the reset instant goes through
// shared/i18n/time.ts (ruling 12), so a locale that never left the browser's
// default would order the date the English way for every reader.
describe("windowLine", () => {
  // Built from local components and read back in the local zone, so this holds
  // wherever the machine is (same trick as shared/i18n/time.test.ts).
  const resetsAtMs = new Date(2026, 0, 2, 15, 4).getTime();
  const window = {
    label: "Weekly (Opus)",
    usedPercent: 34.4,
    resetsAtMs,
  } as Parameters<typeof windowLine>[1];

  it("words the row and orders the date the way each language does", () => {
    expect(windowLine(EN, window, null)).toBe(
      "Weekly (Opus): 34% used - resets 1/2/26, 3:04 PM",
    );
    expect(windowLine(ES, window, null)).toBe(
      "Weekly (Opus): usado un 34% - se reinicia el 2/1/26, 15:04",
    );
    expect(windowLine(CA, window, null)).toBe(
      "Weekly (Opus): usat un 34% - es reinicia el 2/1/26 15:04",
    );
  });

  it("adds the countdown only when a clock is supplied, in the same language", () => {
    const nowMs = resetsAtMs - 2 * DAY - 5 * HOUR;
    expect(windowLine(EN, window, nowMs)).toBe(
      "Weekly (Opus): 34% used - resets 1/2/26, 3:04 PM (in 2 days 5 hours)",
    );
    expect(windowLine(CA, window, nowMs)).toBe(
      "Weekly (Opus): usat un 34% - es reinicia el 2/1/26 15:04 (d'aquí a 2 dies i 5 hores)",
    );
  });

  it("leaves the reset out when the backend reports none", () => {
    expect(windowLine(ES, { ...window, resetsAtMs: null }, null)).toBe(
      "Weekly (Opus): usado un 34%",
    );
  });
});

// The pill shares the battery's color bands, so it must also share the battery's
// rule about WHICH number they key off: the raw float, with rounding applied to
// the label only. Rounding first would move the 50 boundary to 49.5.
describe("pill color band boundary", () => {
  it("bands 49.6% as dim even though its label rounds to 50%", () => {
    expect(bandColor(49.6)).toBe("var(--text-muted)");
    expect(Math.round(49.6)).toBe(50);
    expect(bandColor(50)).toBe("var(--orange)");
    expect(bandColor(74.6)).toBe("var(--orange)");
    expect(bandColor(75)).toBe("var(--red)");
  });
});

// Which limit the pill's number tracks: the server's "most constrained" pick
// unless the viewer pinned one. A pin is a LABEL, so it survives windows being
// reordered, and it degrades to auto when that window is no longer reported.
describe("resolveTrackedWindow", () => {
  const windows = [
    { label: "Weekly", usedPercent: 30, resetsAtMs: null },
    { label: "5-hour", usedPercent: 95, resetsAtMs: null },
    { label: "Weekly (Opus)", usedPercent: 60, resetsAtMs: null },
  ];

  it("follows the server's pick when nothing is pinned", () => {
    expect(resolveTrackedWindow(windows, 1, null)).toEqual({
      index: 1,
      pinned: false,
    });
  });

  it("follows the pin over the server's pick", () => {
    expect(
      resolveTrackedWindow(windows, 1, { label: "Weekly", index: 0 }),
    ).toEqual({ index: 0, pinned: true });
  });

  it("finds the pinned window by label when the provider reorders them", () => {
    const reordered = [windows[2], windows[0], windows[1]];
    expect(
      resolveTrackedWindow(reordered, 2, { label: "Weekly", index: 0 }),
    ).toEqual({ index: 1, pinned: true });
  });

  it("tells same-labelled rows apart by the index that was clicked", () => {
    // Labels are not unique: two Codex windows of equal duration render
    // identically, and a server-supplied model_scoped name can collide with a
    // fixed one. A label-only lookup would snap back to the first row.
    const dupes = [
      { label: "Weekly", usedPercent: 10, resetsAtMs: null },
      { label: "Weekly", usedPercent: 90, resetsAtMs: null },
    ];
    expect(
      resolveTrackedWindow(dupes, 1, { label: "Weekly", index: 1 }),
    ).toEqual({ index: 1, pinned: true });
    expect(
      resolveTrackedWindow(dupes, 1, { label: "Weekly", index: 0 }),
    ).toEqual({ index: 0, pinned: true });
  });

  it("falls back to auto when duplicate labels make the pin ambiguous", () => {
    // The stored slot no longer holds that label AND the label appears more
    // than once, so which row was meant is unknowable. Showing the most
    // constrained window is always defensible; silently tracking the wrong
    // limit while reporting "pinned" is not.
    const dupes = [
      { label: "Plan allowance", usedPercent: 10, resetsAtMs: null },
      { label: "Plan allowance", usedPercent: 90, resetsAtMs: null },
      { label: "5-hour", usedPercent: 50, resetsAtMs: null },
    ];
    expect(
      resolveTrackedWindow(dupes, 1, { label: "Plan allowance", index: 5 }),
    ).toEqual({ index: 1, pinned: false });
  });

  it("falls back to auto when the pinned window is gone (e.g. plan change)", () => {
    expect(
      resolveTrackedWindow(windows, 1, { label: "Weekly (Sonnet)", index: 3 }),
    ).toEqual({ index: 1, pinned: false });
  });

  it("clamps an out-of-range server index instead of pointing at nothing", () => {
    expect(resolveTrackedWindow(windows, 7, null)).toEqual({
      index: 0,
      pinned: false,
    });
    expect(resolveTrackedWindow(windows, -1, null)).toEqual({
      index: 0,
      pinned: false,
    });
  });
});
