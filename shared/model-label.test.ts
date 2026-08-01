// modelLabelImpliesEngine decides whether the LogView header still needs the
// engine badge next to the model name (task 176a5085). The rule it encodes:
// a label that already names the engine shouldn't be followed by "· codex".
import { describe, it, expect } from "bun:test";
import {
  CODEX_MODELS,
  MODEL_FAMILIES,
  familyDisplayLabel,
  modelLabelImpliesEngine,
} from "./types.ts";

describe("modelLabelImpliesEngine", () => {
  it("covers every known Codex model, so none renders the redundant badge", () => {
    for (const m of CODEX_MODELS) {
      expect(modelLabelImpliesEngine(m.value)).toBe(true);
    }
  });

  it("covers every Claude family", () => {
    for (const m of MODEL_FAMILIES) {
      expect(modelLabelImpliesEngine(m.family)).toBe(true);
    }
  });

  it("keeps the badge for a Codex slug the table doesn't carry", () => {
    // The Codex model list is fetched live, so an agent can sit on a slug that
    // CODEX_MODELS predates. familyDisplayLabel falls back to the raw slug,
    // which names no engine - the badge is the only signal left.
    expect(modelLabelImpliesEngine("gpt-6-nova")).toBe(false);
    expect(familyDisplayLabel("gpt-6-nova")).toBe("gpt-6-nova");
  });

  it("agrees with familyDisplayLabel: implied exactly when the label is not the raw slug", () => {
    // The predicate must not drift from the label function it guards.
    for (const family of [
      ...CODEX_MODELS.map((m) => m.value),
      ...MODEL_FAMILIES.map((m) => m.family),
      "gpt-6-nova",
      "some-future-slug",
    ]) {
      expect(modelLabelImpliesEngine(family)).toBe(
        familyDisplayLabel(family) !== family,
      );
    }
  });
});
