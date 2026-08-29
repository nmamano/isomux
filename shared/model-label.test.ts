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

  it("pretty-prints a Codex slug the table doesn't carry", () => {
    expect(modelLabelImpliesEngine("gpt-6-nova")).toBe(true);
    expect(familyDisplayLabel("gpt-6-nova")).toBe("GPT-6 Nova");
  });

  it("pretty-prints a composite provider/model id", () => {
    expect(modelLabelImpliesEngine("gate/gate-model")).toBe(false);
    expect(familyDisplayLabel("gate/gate-model")).toBe("Gate - Gate Model");
    expect(familyDisplayLabel("opencode/mimo-v2.5-free")).toBe(
      "OpenCode - MiMo V2.5 Free",
    );
  });

  it("keeps the OpenCode badge for models from recognizable providers", () => {
    for (const model of [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
      "github-copilot/gpt-4.1",
      "opencode/mimo-v2.5-free",
    ]) {
      expect(modelLabelImpliesEngine(model)).toBe(false);
    }
  });
});
