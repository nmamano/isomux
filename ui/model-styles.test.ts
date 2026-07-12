import { describe, expect, test } from "bun:test";
import {
  FALLBACK_PALETTE,
  MODEL_STYLES,
  NEUTRAL_STYLE,
  styleForModel,
} from "./model-styles.ts";

describe("styleForModel", () => {
  test("known models return their exact seeded entry", () => {
    expect(styleForModel("opus")).toBe(MODEL_STYLES["opus"]);
    expect(styleForModel("opus").border).toBe("rgba(100,160,255,0.85)");
    expect(styleForModel("sonnet").bg).toBe("rgba(218,165,32,0.32)");
    expect(styleForModel("gpt-5.6-sol").border).toBe("rgba(80,220,150,0.95)");
  });

  test("desk props encode tier: books for frontier, crayons for small, bare mid", () => {
    expect(styleForModel("opus").deskProp).toBe("book");
    expect(styleForModel("fable").deskProp).toBe("book");
    expect(styleForModel("gpt-5.6-sol").deskProp).toBe("book");
    expect(styleForModel("haiku").deskProp).toBe("crayons");
    expect(styleForModel("gpt-5.4-mini").deskProp).toBe("crayons");
    expect(styleForModel("gpt-5.6-luna").deskProp).toBe("crayons");
    expect(styleForModel("sonnet").deskProp).toBeUndefined();
    expect(styleForModel("gpt-5.5").deskProp).toBeUndefined();
    expect(styleForModel("gpt-5.6-terra").deskProp).toBeUndefined();
  });

  test("missing/empty input returns the neutral style, never a hash", () => {
    expect(styleForModel(undefined)).toBe(NEUTRAL_STYLE);
    expect(styleForModel("")).toBe(NEUTRAL_STYLE);
    expect(styleForModel(undefined).deskProp).toBeUndefined();
  });

  test("unknown models are deterministic and drawn from the palette", () => {
    const unknowns = [
      "gpt-6",
      "gpt-6-mini",
      "claude-nova-1",
      "o9-preview",
      "some-future-model-20270101",
      "x",
      "é你好-unicode-model", // non-ASCII char codes
      // Object.prototype member names must NOT leak inherited values out of
      // the MODEL_STYLES record — they are unknown models like any other.
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ];
    for (const name of unknowns) {
      const a = styleForModel(name);
      const b = styleForModel(name);
      expect(a).toBe(b); // stable across calls
      expect(FALLBACK_PALETTE.includes(a)).toBe(true); // in-palette (index in range, never negative)
      expect(a.deskProp).toBeUndefined(); // unknowns never get desk props
    }
  });

  test("palette entries are distinct so hashing yields variety", () => {
    const borders = new Set(FALLBACK_PALETTE.map((p) => p.border));
    expect(borders.size).toBe(FALLBACK_PALETTE.length);
  });
});
