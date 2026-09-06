// The Intl number helper of ruling 12, on the three offered languages and at
// every branch formatBytes takes.
//
// The expectations are literal strings, for the same reason the DOM tests use
// them (ruling 14): an expectation computed from Intl.NumberFormat would pass
// whatever the helper did with it, including dividing by 1000. What this file
// pins is the unit each size lands in, the one decimal above the byte branch,
// and the fact that Spanish and Catalan get their own marks rather than
// English ones.

import { describe, expect, it } from "bun:test";
import {
  formatBytes,
  formatDecimal,
  formatMoneyUSD,
  formatNumber,
} from "./number.ts";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

describe("formatNumber", () => {
  it("groups the way each language groups", () => {
    expect(formatNumber("en", 12345)).toBe("12,345");
    expect(formatNumber("es", 12345)).toBe("12.345");
    expect(formatNumber("ca", 12345)).toBe("12.345");
    expect(formatNumber("en", 1234567)).toBe("1,234,567");
    expect(formatNumber("es", 1234567)).toBe("1.234.567");
  });

  // Spanish groups only from five digits, which is why a four-digit sample
  // proves nothing about es and the five-digit ones above carry that language.
  it("leaves a four-digit number ungrouped in Spanish and groups it elsewhere", () => {
    expect(formatNumber("en", 1023)).toBe("1,023");
    expect(formatNumber("es", 1023)).toBe("1023");
    expect(formatNumber("ca", 1023)).toBe("1.023");
  });

  it("marks the decimal the way each language marks it", () => {
    expect(formatNumber("en", 1234.5)).toBe("1,234.5");
    expect(formatNumber("es", 1234.5)).toBe("1234,5");
    expect(formatNumber("ca", 1234.5)).toBe("1.234,5");
  });

  it("leaves a small whole number alone", () => {
    expect(formatNumber("en", 0)).toBe("0");
    expect(formatNumber("ca", 999)).toBe("999");
  });
});

describe("formatBytes", () => {
  // The unit symbol is a symbol in every language (ruling 11); only the number
  // in front of it changes.
  it("keeps the binary unit symbols and localizes only the number", () => {
    expect(formatBytes("en", 1536)).toBe("1.5 KB");
    expect(formatBytes("es", 1536)).toBe("1,5 KB");
    expect(formatBytes("ca", 1536)).toBe("1,5 KB");
  });

  it("divides by 1024 at every step, not by 1000", () => {
    expect(formatBytes("en", 0)).toBe("0 B");
    expect(formatBytes("en", KB - 1)).toBe("1,023 B");
    expect(formatBytes("en", KB)).toBe("1.0 KB");
    // Grouping reaches the decimal branches too, which is why the top of a
    // band reads "1,024.0 KB" where toFixed(1) used to read "1024.0 KB".
    expect(formatBytes("en", MB - 1)).toBe("1,024.0 KB");
    expect(formatBytes("en", MB)).toBe("1.0 MB");
    expect(formatBytes("en", 5.5 * MB)).toBe("5.5 MB");
    expect(formatBytes("en", GB - 1)).toBe("1,024.0 MB");
    expect(formatBytes("en", GB)).toBe("1.0 GB");
    expect(formatBytes("en", 1.44 * GB)).toBe("1.4 GB");
  });

  // Exactly one decimal above the byte branch, so a round size still reads as
  // a measurement rather than as a count.
  it("shows one decimal above bytes and none below", () => {
    expect(formatBytes("en", 512)).toBe("512 B");
    expect(formatBytes("en", 2 * KB)).toBe("2.0 KB");
    expect(formatBytes("es", 2 * GB)).toBe("2,0 GB");
  });

  it("has no size to show for a size that is not one", () => {
    expect(formatBytes("en", -1)).toBeNull();
    expect(formatBytes("en", Number.NaN)).toBeNull();
    expect(formatBytes("en", Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("formatDecimal", () => {
  // The compact token counts of the usage table: one place for the millions
  // form, none for the thousands form.
  it("holds the places open and marks the decimal per language", () => {
    expect(formatDecimal("en", 999500 / 1_000_000, 1)).toBe("1.0");
    expect(formatDecimal("es", 999500 / 1_000_000, 1)).toBe("1,0");
    expect(formatDecimal("ca", 2_500_000 / 1_000_000, 1)).toBe("2,5");
    expect(formatDecimal("en", 12345 / 1000, 0)).toBe("12");
    expect(formatDecimal("es", 12345 / 1000, 0)).toBe("12");
  });

  // Grouping reaches this form too, so a seven-figure count reads "1,235k" in
  // English where toFixed(0) read "1235k". Same accepted change as the size
  // bands (internal-docs/i18n-loop.md, S6).
  it("groups a four-digit compact form", () => {
    expect(formatDecimal("en", 1_234_567 / 1000, 0)).toBe("1,235");
    expect(formatDecimal("es", 1_234_567 / 1000, 0)).toBe("1235");
    expect(formatDecimal("ca", 1_234_567 / 1000, 0)).toBe("1.235");
  });
});

describe("formatMoneyUSD", () => {
  // Spanish and Catalan put the symbol after the number, separated by a
  // NO-BREAK space (U+00A0). It is written as an escape here because a plain
  // space would look identical in this file and fail for no visible reason.
  const NB = "\u00a0";

  // The symbol, its side of the number and the space between them are the
  // language's, which is why it is not a literal the way KB is.
  it("puts the dollar where each language puts it", () => {
    expect(formatMoneyUSD("en", 12.34, 2)).toBe("$12.34");
    expect(formatMoneyUSD("es", 12.34, 2)).toBe(`12,34${NB}US$`);
    expect(formatMoneyUSD("ca", 12.34, 2)).toBe(`12,34${NB}USD`);
  });

  it("keeps the English of a whole-dollar amount and a small one", () => {
    expect(formatMoneyUSD("en", 100, 0)).toBe("$100");
    expect(formatMoneyUSD("en", 0.5, 2)).toBe("$0.50");
    expect(formatMoneyUSD("es", 0.5, 2)).toBe(`0,50${NB}US$`);
  });

  it("groups a four-figure amount", () => {
    expect(formatMoneyUSD("en", 1234, 0)).toBe("$1,234");
    expect(formatMoneyUSD("ca", 1234, 0)).toBe(`1.234${NB}USD`);
  });
});
