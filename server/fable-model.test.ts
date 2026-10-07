import { describe, it, expect } from "bun:test";
import {
  FAMILY_TO_MODEL,
  MODEL_FAMILIES,
  isClaudeFamily,
  familyFromLegacyModel,
  modelVersionLabel,
  familyDisplayLabel,
  claudeFamilySupportsEffort,
  claudeFamilySupportsMaxEffort,
  claudeFamilySupportsAutoPermission,
  effortLevelsFor,
} from "../shared/types.ts";
import { validateEffort } from "./agent-validators.ts";

describe("fable model family", () => {
  it("maps to the claude-fable-5-1 model id", () => {
    expect(FAMILY_TO_MODEL.fable).toBe("claude-fable-5-1");
  });

  it("is a selectable Claude family (opus is the MODEL_FAMILIES[0] default)", () => {
    expect(MODEL_FAMILIES[0].family).toBe("opus");
    expect(MODEL_FAMILIES.some((m) => m.family === "fable")).toBe(true);
  });

  it("is recognized as a Claude family", () => {
    expect(isClaudeFamily("fable")).toBe(true);
  });

  it("maps sonnet to claude-sonnet-5-5", () => {
    expect(FAMILY_TO_MODEL.sonnet).toBe("claude-sonnet-5-5");
  });

  it("maps haiku to claude-haiku-5-5", () => {
    expect(FAMILY_TO_MODEL.haiku).toBe("claude-haiku-5-5");
  });

  it("resolves a stored Haiku 4.5 id to the haiku family", () => {
    expect(familyFromLegacyModel("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("resolves from a legacy claude-fable-5 model id", () => {
    expect(familyFromLegacyModel("claude-fable-5")).toBe("fable");
  });

  it("renders the Fable version label", () => {
    expect(modelVersionLabel("fable")).toBe("5.1");
    expect(familyDisplayLabel("fable")).toBe("Fable 5.1");
    expect(modelVersionLabel("opus")).toBe("5.5");
    expect(familyDisplayLabel("opus")).toBe("Opus 5.5");
    expect(modelVersionLabel("sonnet")).toBe("5.5");
    expect(familyDisplayLabel("sonnet")).toBe("Sonnet 5.5");
    expect(modelVersionLabel("haiku")).toBe("5.5");
    expect(familyDisplayLabel("haiku")).toBe("Haiku 5.5");
  });
});

describe("top-tier capability gates", () => {
  const families = ["opus", "fable", "sonnet", "haiku"];

  it("grants max effort to every Claude family", () => {
    for (const family of families)
      expect(claudeFamilySupportsMaxEffort(family)).toBe(true);
    expect(claudeFamilySupportsMaxEffort("gpt-5.5")).toBe(false);
  });

  it("grants auto permission to every Claude family", () => {
    for (const family of families)
      expect(claudeFamilySupportsAutoPermission(family)).toBe(true);
    expect(claudeFamilySupportsAutoPermission("gpt-5.5")).toBe(false);
  });

  it("grants every Claude family the same effort levels", () => {
    for (const family of families) {
      expect(claudeFamilySupportsEffort(family)).toBe(true);
      expect(effortLevelsFor("claude", family)).toEqual(
        effortLevelsFor("claude", "opus"),
      );
    }
    expect(effortLevelsFor("claude", "haiku").length).toBeGreaterThan(0);
    expect(claudeFamilySupportsEffort("gpt-5.5")).toBe(false);
  });

  it("validateEffort keeps a stored haiku effort", () => {
    expect(validateEffort("claude", "haiku", "low")).toBe("low");
    expect(validateEffort("claude", "haiku", "xhigh")).toBe("xhigh");
  });

  it("validateEffort allows max for fable, sonnet and haiku", () => {
    expect(validateEffort("claude", "fable", "max")).toBe("max");
    expect(validateEffort("claude", "sonnet", "max")).toBe("max");
    expect(validateEffort("claude", "haiku", "max")).toBe("max");
  });
});
