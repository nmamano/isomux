// The stored office shape's parse (task ea29a8e2): a value read back from
// localStorage is trusted only when it is a sane OfficeShape, else the
// placeholders draw the default. Strict, like parseChatSidebarShape: junk
// anywhere gives null, never a partly kept shape. The one exception: a shape
// stored before task 73b5c130 has no counts and no dot, and reads as 0 and
// false. The drawing and the writer are in ui/App.office-shape.dom.test.tsx
// and ui/App.office-shape-counts.dom.test.tsx.

import { describe, expect, it } from "bun:test";
import {
  OFFICE_SHAPE_DEFAULT,
  OFFICE_SHAPE_MAX_PX,
  OFFICE_SHAPE_MAX_TABS,
  parseOfficeShape,
  type OfficeShape,
} from "./office-shape.ts";
import { DESK_COUNT } from "../shared/desks.ts";

const good: OfficeShape = {
  tabs: [120, 90.5, 0],
  online: 130,
  tucked: 0,
  desks: [
    { desk: 0, w: 80, h: 22 },
    { desk: DESK_COUNT - 1, w: 60.25, h: 30 },
  ],
  counts: 57,
  dot: true,
};

// The good shape with one field replaced.
const withField = (key: keyof OfficeShape, value: unknown) => ({
  ...good,
  [key]: value,
});
const withDesk = (desk: Record<string, unknown>) => ({
  ...good,
  desks: [good.desks[0], desk],
});

describe("parseOfficeShape", () => {
  it("keeps a sane shape as it is, the default and the edge values included", () => {
    expect(parseOfficeShape(good)).toEqual(good);
    expect(parseOfficeShape(OFFICE_SHAPE_DEFAULT)).toEqual(
      OFFICE_SHAPE_DEFAULT,
    );
    const edges: OfficeShape = {
      tabs: Array.from({ length: OFFICE_SHAPE_MAX_TABS }, () => 0),
      online: OFFICE_SHAPE_MAX_PX,
      tucked: OFFICE_SHAPE_MAX_PX,
      desks: Array.from({ length: DESK_COUNT }, (_, desk) => ({
        desk,
        w: OFFICE_SHAPE_MAX_PX,
        h: 0,
      })),
      counts: OFFICE_SHAPE_MAX_PX,
      dot: false,
    };
    expect(parseOfficeShape(edges)).toEqual(edges);
    // No tabs and no desks is a shape (an office with no room tab).
    const empty = {
      tabs: [],
      online: 0,
      tucked: 0,
      desks: [],
      counts: 0,
      dot: false,
    };
    expect(parseOfficeShape(empty)).toEqual(empty);
  });

  it("reads a shape stored before task 73b5c130 (no counts, no dot) as no counts row and no dot", () => {
    const { counts: _c, dot: _d, ...old } = good;
    expect(parseOfficeShape(old)).toEqual({ ...good, counts: 0, dot: false });
    // Each one alone is read the same way; the other keeps its value.
    const { counts: _c2, ...noCounts } = good;
    expect(parseOfficeShape(noCounts)).toEqual({ ...good, counts: 0 });
    const { dot: _d2, ...noDot } = good;
    expect(parseOfficeShape(noDot)).toEqual({ ...good, dot: false });
    expect(OFFICE_SHAPE_DEFAULT.counts).toBe(0);
    expect(OFFICE_SHAPE_DEFAULT.dot).toBe(false);
  });

  it("drops fields it does not know", () => {
    expect(parseOfficeShape({ ...good, extra: "x" })).toEqual(good);
  });

  it("gives null for a value that is not a shape object", () => {
    for (const raw of [null, undefined, 0, "shape", [], [good], true]) {
      expect(parseOfficeShape(raw), String(raw)).toBeNull();
    }
  });

  it("gives null for a missing or broken field", () => {
    const missing = (key: keyof OfficeShape) => {
      const copy: Record<string, unknown> = { ...good };
      delete copy[key];
      return copy;
    };
    const cases: [string, unknown][] = [
      ["no tabs", missing("tabs")],
      ["no online", missing("online")],
      ["no tucked", missing("tucked")],
      ["no desks", missing("desks")],
      ["tabs not an array", withField("tabs", { 0: 100 })],
      ["a tab not a number", withField("tabs", [100, "90"])],
      ["a negative tab", withField("tabs", [100, -1])],
      ["a tab over the cap", withField("tabs", [OFFICE_SHAPE_MAX_PX + 1])],
      ["a NaN tab", withField("tabs", [Number.NaN])],
      ["an infinite tab", withField("tabs", [Number.POSITIVE_INFINITY])],
      [
        "too many tabs",
        withField(
          "tabs",
          Array.from({ length: OFFICE_SHAPE_MAX_TABS + 1 }, () => 1),
        ),
      ],
      ["online not a number", withField("online", "130")],
      ["a negative online", withField("online", -5)],
      ["online over the cap", withField("online", OFFICE_SHAPE_MAX_PX + 1)],
      ["tucked null", withField("tucked", null)],
      ["a negative tucked", withField("tucked", -1)],
      ["tucked over the cap", withField("tucked", OFFICE_SHAPE_MAX_PX + 1)],
      ["desks not an array", withField("desks", { desk: 0, w: 1, h: 1 })],
      ["a desk entry not an object", withField("desks", [3])],
      ["a desk with no slot", withDesk({ w: 1, h: 1 })],
      ["a desk slot as a string", withDesk({ desk: "3", w: 1, h: 1 })],
      ["a fractional desk slot", withDesk({ desk: 1.5, w: 1, h: 1 })],
      ["a negative desk slot", withDesk({ desk: -1, w: 1, h: 1 })],
      ["a desk slot past the room", withDesk({ desk: DESK_COUNT, w: 1, h: 1 })],
      ["a desk with no width", withDesk({ desk: 2, h: 1 })],
      ["a desk with no height", withDesk({ desk: 2, w: 1 })],
      ["a negative tag width", withDesk({ desk: 2, w: -1, h: 1 })],
      [
        "a tag height over the cap",
        withDesk({ desk: 2, w: 1, h: OFFICE_SHAPE_MAX_PX + 1 }),
      ],
      ["a NaN tag width", withDesk({ desk: 2, w: Number.NaN, h: 1 })],
      ["the same desk twice", withDesk({ desk: 0, w: 5, h: 5 })],
      ["counts as a string", withField("counts", "57")],
      ["counts null", withField("counts", null)],
      ["a negative counts", withField("counts", -1)],
      ["counts over the cap", withField("counts", OFFICE_SHAPE_MAX_PX + 1)],
      ["a NaN counts", withField("counts", Number.NaN)],
      ["dot as a string", withField("dot", "true")],
      ["dot as a number", withField("dot", 1)],
      ["dot null", withField("dot", null)],
    ];
    for (const [name, raw] of cases) {
      expect(parseOfficeShape(raw), name).toBeNull();
    }
  });

  it("reads a value as it comes back from localStorage (a JSON round trip)", () => {
    expect(parseOfficeShape(JSON.parse(JSON.stringify(good)))).toEqual(good);
    // JSON writes NaN and Infinity as null: still not a width.
    expect(
      parseOfficeShape(
        JSON.parse(JSON.stringify(withField("online", Number.NaN))),
      ),
    ).toBeNull();
  });
});
