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
  claudePermissionModeFor,
  DEFAULT_EFFORT,
  effortLevelsFor,
} from "../shared/types.ts";
import {
  resolveAgentEngineSettings,
  validateEffort,
  validatePermissionMode,
} from "./agent-validators.ts";

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

describe("capability gates for families limited on Bedrock and Vertex", () => {
  const limited = ["sonnet", "haiku"];

  it("withdraws effort, max and auto from a limited family only", () => {
    for (const family of limited) {
      expect(claudeFamilySupportsEffort(family, limited)).toBe(false);
      expect(claudeFamilySupportsMaxEffort(family, limited)).toBe(false);
      expect(claudeFamilySupportsAutoPermission(family, limited)).toBe(false);
      expect(effortLevelsFor("claude", family, limited)).toEqual([]);
    }
    for (const family of ["opus", "fable"]) {
      expect(claudeFamilySupportsAutoPermission(family, limited)).toBe(true);
      expect(effortLevelsFor("claude", family, limited)).toEqual(
        effortLevelsFor("claude", family),
      );
    }
  });

  it("leaves Codex effort levels alone", () => {
    expect(effortLevelsFor("codex", "haiku", limited)).toEqual(
      effortLevelsFor("codex", "haiku"),
    );
  });

  it("runs a stored auto as default on a limited family", () => {
    expect(claudePermissionModeFor("haiku", "auto", limited)).toBe("default");
    expect(claudePermissionModeFor("sonnet", "auto", limited)).toBe("default");
    expect(claudePermissionModeFor("haiku", "auto")).toBe("auto");
    expect(claudePermissionModeFor("opus", "auto", limited)).toBe("auto");
    expect(claudePermissionModeFor("haiku", "acceptEdits", limited)).toBe(
      "acceptEdits",
    );
  });

  it("validateEffort keeps a stored level and drops max, as for any family without max", () => {
    expect(validateEffort("claude", "haiku", "low", limited)).toBe("low");
    expect(validateEffort("claude", "haiku", "max", limited)).toBe(
      DEFAULT_EFFORT,
    );
    expect(validateEffort("claude", "opus", "max", limited)).toBe("max");
  });

  it("validatePermissionMode corrects auto to default on a limited family", () => {
    expect(validatePermissionMode("claude", "auto", "haiku", limited)).toBe(
      "default",
    );
    expect(validatePermissionMode("claude", undefined, "sonnet", limited)).toBe(
      "default",
    );
    expect(
      validatePermissionMode("claude", "bypassPermissions", "haiku", limited),
    ).toBe("bypassPermissions");
    expect(validatePermissionMode("claude", "auto", "opus", limited)).toBe(
      "auto",
    );
    expect(validatePermissionMode("claude", "auto", "haiku")).toBe("auto");
    expect(validatePermissionMode("claude", "auto")).toBe("auto");
  });

  it("resolveAgentEngineSettings applies the limits for the target family", () => {
    expect(
      resolveAgentEngineSettings(
        "claude",
        { modelFamily: "haiku", effort: "max", permissionMode: "auto" },
        limited,
      ),
    ).toMatchObject({ effort: DEFAULT_EFFORT, permissionMode: "default" });
    expect(
      resolveAgentEngineSettings(
        "claude",
        { modelFamily: "opus", effort: "max", permissionMode: "auto" },
        limited,
      ),
    ).toMatchObject({ effort: "max", permissionMode: "auto" });
  });
});
