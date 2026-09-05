import { describe, expect, test } from "bun:test";
import {
  FALLBACK_PALETTE,
  MODEL_STYLES,
  NEUTRAL_STYLE,
  deskModelLabel,
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
      // the MODEL_STYLES record - they are unknown models like any other.
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

describe("deskModelLabel", () => {
  test("a Codex codename drops the family prefix it already implies", () => {
    expect(deskModelLabel("gpt-5.6-sol")).toBe("5.6 SOL");
    expect(deskModelLabel("gpt-5.4-mini")).toBe("5.4 MINI");
  });

  test("a bare version keeps its prefix, because the number alone says nothing", () => {
    expect(deskModelLabel("gpt-5.5")).toBe("GPT-5.5");
    expect(deskModelLabel("gpt-5.4")).toBe("GPT-5.4");
  });

  test("Claude families keep their name and version", () => {
    expect(deskModelLabel("opus")).toBe("OPUS 5");
    expect(deskModelLabel("haiku")).toBe("HAIKU 4.5");
  });

  test("a trailing tier word is dropped, but never the whole label", () => {
    expect(deskModelLabel("opencode/muse-spark-1.2-contributor-free")).toBe(
      "MUSE SPARK 1.2",
    );
    expect(deskModelLabel("opencode/free")).toBe("FREE");
  });

  test("no model identity means no label at all", () => {
    expect(deskModelLabel(undefined)).toBeNull();
    expect(deskModelLabel("")).toBeNull();
  });
});
