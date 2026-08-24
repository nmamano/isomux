import { describe, it, expect } from "bun:test";
import {
  FAMILY_TO_MODEL,
  MODEL_FAMILIES,
  isClaudeFamily,
  familyFromLegacyModel,
  modelVersionLabel,
  familyDisplayLabel,
  claudeFamilySupportsMaxEffort,
  claudeFamilySupportsAutoPermission,
  DEFAULT_EFFORT,
} from "../shared/types.ts";
import { validateEffort } from "./agent-validators.ts";

describe("fable model family", () => {
  it("maps to the claude-fable-5 model id", () => {
    expect(FAMILY_TO_MODEL.fable).toBe("claude-fable-5");
  });

  it("is a selectable Claude family (opus is the MODEL_FAMILIES[0] default)", () => {
    expect(MODEL_FAMILIES[0].family).toBe("opus");
    expect(MODEL_FAMILIES.some((m) => m.family === "fable")).toBe(true);
  });

  it("is recognized as a Claude family", () => {
    expect(isClaudeFamily("fable")).toBe(true);
  });

  it("resolves from a legacy claude-fable-5 model id", () => {
    expect(familyFromLegacyModel("claude-fable-5")).toBe("fable");
  });

  it("renders a single-component version label", () => {
    expect(modelVersionLabel("fable")).toBe("5");
    expect(familyDisplayLabel("fable")).toBe("Fable 5");
    // opus joined the single-component family when it moved to claude-opus-5,
    // sonnet when it moved to claude-sonnet-5.
    expect(modelVersionLabel("opus")).toBe("5");
    expect(familyDisplayLabel("opus")).toBe("Opus 5");
    expect(modelVersionLabel("sonnet")).toBe("5");
    expect(familyDisplayLabel("sonnet")).toBe("Sonnet 5");
  });
});

describe("top-tier capability gates", () => {
  it("grants max effort to opus and fable only", () => {
    expect(claudeFamilySupportsMaxEffort("opus")).toBe(true);
    expect(claudeFamilySupportsMaxEffort("fable")).toBe(true);
    expect(claudeFamilySupportsMaxEffort("sonnet")).toBe(false);
    expect(claudeFamilySupportsMaxEffort("haiku")).toBe(false);
  });

  it("grants auto permission to opus and fable only", () => {
    expect(claudeFamilySupportsAutoPermission("opus")).toBe(true);
    expect(claudeFamilySupportsAutoPermission("fable")).toBe(true);
    expect(claudeFamilySupportsAutoPermission("sonnet")).toBe(false);
    expect(claudeFamilySupportsAutoPermission("haiku")).toBe(false);
  });

  it("validateEffort allows max for fable, rejects it for sonnet", () => {
    expect(validateEffort("claude", "fable", "max")).toBe("max");
    expect(validateEffort("claude", "sonnet", "max")).toBe(DEFAULT_EFFORT);
  });
});
