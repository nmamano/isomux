import { describe, expect, it } from "bun:test";
import {
  DOOR_LABEL_MAX_LINES,
  DOOR_LABEL_MIN_SIZE,
  DOOR_LABEL_SIZE,
  DOOR_LABEL_WIDTH,
  fitDoorLabel,
} from "./door-label.ts";

// Every code point is CHAR wide at DOOR_LABEL_SIZE, the ellipsis included.
const CHAR = 6;
const codePoints = (text: string) => [...text].length;
const measure = (text: string) => codePoints(text) * CHAR;

// Code points per line at full size and at the minimum size.
const FULL = Math.floor(DOOR_LABEL_WIDTH / CHAR);
const MIN = Math.floor(
  (DOOR_LABEL_WIDTH * DOOR_LABEL_SIZE) / (CHAR * DOOR_LABEL_MIN_SIZE),
);

function drawnWidth(line: string, size: number): number {
  return (measure(line) * size) / DOOR_LABEL_SIZE;
}

// Space-separated words of `len` code points, `count` of them, each made of
// one letter so the lines can be told apart.
function words(count: number, len: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    String.fromCharCode(97 + (i % 26)).repeat(len),
  );
}

function expectFits(fit: { lines: string[]; size: number }) {
  expect(fit.size).toBeGreaterThanOrEqual(DOOR_LABEL_MIN_SIZE);
  expect(fit.size).toBeLessThanOrEqual(DOOR_LABEL_SIZE);
  expect(fit.lines.length).toBeLessThanOrEqual(DOOR_LABEL_MAX_LINES);
  for (const line of fit.lines) {
    expect(drawnWidth(line, fit.size)).toBeLessThanOrEqual(
      DOOR_LABEL_WIDTH + 1e-9,
    );
    expect(line).toBe(line.trim());
    expect(line.length).toBeGreaterThan(0);
  }
}

describe("fitDoorLabel", () => {
  it("keeps a label that fits on one line whole, at full size", () => {
    expect(fitDoorLabel("Lobby", measure)).toEqual({
      lines: ["Lobby"],
      size: DOOR_LABEL_SIZE,
    });
    // Exactly as wide as a line: still one line.
    const [a, b] = words(2, 1);
    const exact = `${a.repeat(FULL - 2)} ${b}`;
    expect(measure(exact)).toBe(DOOR_LABEL_WIDTH);
    expect(fitDoorLabel(exact, measure)).toEqual({
      lines: [exact],
      size: DOOR_LABEL_SIZE,
    });
  });

  it("collapses whitespace runs and trims the edges", () => {
    expect(fitDoorLabel("  Lobby \t  Room\n ", measure)).toEqual({
      lines: ["Lobby Room"],
      size: DOOR_LABEL_SIZE,
    });
  });

  it("draws nothing for an empty or blank label", () => {
    expect(fitDoorLabel("", measure)).toEqual({
      lines: [],
      size: DOOR_LABEL_SIZE,
    });
    expect(fitDoorLabel(" \t ", measure)).toEqual({
      lines: [],
      size: DOOR_LABEL_SIZE,
    });
  });

  it("wraps words greedily at full size when every word fits", () => {
    // Two 4-point words and a space fill 9 of FULL; a third does not fit.
    // The tests below that pair 4-point words rely on this too.
    const [a, b, c, d] = words(4, 4);
    expect(FULL).toBeGreaterThanOrEqual(9);
    expect(FULL).toBeLessThan(14);
    expect(fitDoorLabel(`${a} ${b} ${c} ${d}`, measure)).toEqual({
      lines: [`${a} ${b}`, `${c} ${d}`],
      size: DOOR_LABEL_SIZE,
    });
  });

  it("shrinks only as far as the widest word needs", () => {
    // One word just wider than a line at full size, narrow enough at the
    // minimum: the size is the largest at which it fits.
    const long = "w".repeat(FULL + 1);
    expect(drawnWidth(long, DOOR_LABEL_MIN_SIZE)).toBeLessThanOrEqual(
      DOOR_LABEL_WIDTH,
    );
    const fit = fitDoorLabel(`${long} ab`, measure);
    expect(fit.size).toBeCloseTo(
      (DOOR_LABEL_SIZE * DOOR_LABEL_WIDTH) / measure(long),
      9,
    );
    expect(fit.lines).toEqual([long, "ab"]);
    expectFits(fit);
    // Real widths are fractional: at this one, width * size / 12 rounds to
    // just over the line, and the word that set the size must still fit.
    const odd = 83.86;
    expect(
      (odd * ((DOOR_LABEL_SIZE * DOOR_LABEL_WIDTH) / odd)) / DOOR_LABEL_SIZE,
    ).toBeGreaterThan(DOOR_LABEL_WIDTH);
    const oddFit = fitDoorLabel("@ ab", (text) =>
      [...text].reduce((sum, cp) => sum + (cp === "@" ? odd : CHAR), 0),
    );
    expect(oddFit.lines).toEqual(["@", "ab"]);
  });

  it("breaks a word too wide at the minimum size into pieces that fill each line", () => {
    const long = "x".repeat(MIN + 6);
    expect(drawnWidth(long, DOOR_LABEL_MIN_SIZE)).toBeGreaterThan(
      DOOR_LABEL_WIDTH,
    );
    const fit = fitDoorLabel(`${long} end`, measure);
    expect(fit.size).toBe(DOOR_LABEL_MIN_SIZE);
    // The last piece is a word like any other: the next word joins its line.
    expect(fit.lines).toEqual(["x".repeat(MIN), `${"x".repeat(6)} end`]);
    expectFits(fit);
  });

  it("past the line limit, ends the last line in an ellipsis that fills it", () => {
    // Pairs of 4-point words make one line each at full size; five more
    // words run past the limit.
    const all = words(2 * (DOOR_LABEL_MAX_LINES - 1) + 5, 4);
    const fit = fitDoorLabel(all.join(" "), measure);
    expect(fit.size).toBe(DOOR_LABEL_SIZE);
    expect(fit.lines).toHaveLength(DOOR_LABEL_MAX_LINES);
    expect(fit.lines.slice(0, -1)).toEqual(
      Array.from(
        { length: DOOR_LABEL_MAX_LINES - 1 },
        (_, i) => `${all[2 * i]} ${all[2 * i + 1]}`,
      ),
    );
    // The last line is the rest of the text, cut to fit with the ellipsis.
    const rest = all.slice(2 * (DOOR_LABEL_MAX_LINES - 1)).join(" ");
    expect(fit.lines.at(-1)).toBe(
      `${[...rest]
        .slice(0, FULL - 1)
        .join("")
        .trimEnd()}…`,
    );
    expectFits(fit);
  });

  it("trims a space left at the cut before the ellipsis", () => {
    // The rest starts "eeee fffff gggg": a cut after FULL - 1 points ends on
    // the space after the f word.
    const pairs = words(2 * (DOOR_LABEL_MAX_LINES - 1), 4);
    const fWord = "f".repeat(FULL - 7);
    const fit = fitDoorLabel(
      `${pairs.join(" ")} eeee ${fWord} gggg hhhh iiii`,
      measure,
    );
    expect(fit.lines).toHaveLength(DOOR_LABEL_MAX_LINES);
    expect(fit.lines.at(-1)).toBe(`eeee ${fWord}…`);
    expectFits(fit);
  });

  it("breaks and cuts a long word by code points, never inside a surrogate pair", () => {
    // Mixed with plain words, an emoji counts as one point in the wrap too.
    expect(fitDoorLabel("😀😀😀😀 ab cdefgh ijkl", measure)).toEqual({
      lines: ["😀😀😀😀 ab", "cdefgh ijkl"],
      size: DOOR_LABEL_SIZE,
    });
    const fit = fitDoorLabel("😀".repeat(100), measure);
    expect(fit.size).toBe(DOOR_LABEL_MIN_SIZE);
    const full = Array.from({ length: DOOR_LABEL_MAX_LINES - 1 }, () =>
      "😀".repeat(MIN),
    );
    expect(fit.lines).toEqual([...full, `${"😀".repeat(MIN - 1)}…`]);
    const lone =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const line of fit.lines) expect(lone.test(line)).toBe(false);
    expectFits(fit);
  });

  it("fits real room names within the limits", () => {
    for (const label of [
      "Customer Support Escalations",
      "A very long room name that goes on and on and on forever",
      "Isomux",
      "Supercalifragilisticexpialidocious Room",
    ]) {
      const fit = fitDoorLabel(label, measure);
      expectFits(fit);
      expect(fit.lines.length).toBeGreaterThan(0);
      // Without an ellipsis the lines hold the whole label.
      if (!fit.lines.at(-1)!.endsWith("…")) {
        expect(fit.lines.join("").replaceAll(" ", "")).toBe(
          label.replaceAll(" ", ""),
        );
      }
    }
  });

  // Room names have no length cap and each measure is a DOM write plus a
  // layout in WallDoor, so the work must stop at what can be drawn.
  function stats(label: string) {
    let calls = 0;
    let longest = 0;
    const fit = fitDoorLabel(label, (text) => {
      calls++;
      longest = Math.max(longest, codePoints(text));
      return measure(text);
    });
    expect(fit.lines).toHaveLength(DOOR_LABEL_MAX_LINES);
    expect(fit.lines.at(-1)!.endsWith("…")).toBe(true);
    return { calls, longest, fit };
  }

  it("does the same measuring work however far the label runs past what is drawn", () => {
    for (const unit of ["z", "ab "]) {
      const short = stats(unit.repeat(5_000));
      const long = stats(unit.repeat(50_000));
      expect(long.calls).toBeGreaterThan(0);
      expect(long).toEqual(short);
    }
  });

  it("ends a label cut for cost in an ellipsis even when what is left fits", () => {
    // Narrow glyphs: thousands fit on one line, but only a bounded part of
    // the label is fitted, so the line must still say the name goes on.
    const fit = fitDoorLabel(
      "i".repeat(5_000),
      (text) => codePoints(text) * 0.01,
    );
    expect(fit.lines).toHaveLength(1);
    expect(fit.lines[0].endsWith("…")).toBe(true);
    expect(fit.lines[0].slice(0, -1)).toMatch(/^i+$/);
  });

  it("does not shrink the label for a word that could never be drawn", () => {
    const far = stats(`${"ab ".repeat(5_000)}${"q".repeat(4 * FULL)}`);
    expect(far.fit.size).toBe(DOOR_LABEL_SIZE);
  });
});
