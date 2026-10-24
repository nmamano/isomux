import { describe, it, expect } from "bun:test";
import {
  MODEL_FAMILIES,
  isClaudeFamily,
  familyFromLegacyModel,
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

describe("Claude model families", () => {
  it("resolves a stored legacy model id to its family", () => {
    for (const [model, family] of [
      ["claude-haiku-4-5-20251001", "haiku"],
      ["claude-fable-5", "fable"],
    ] as const)
      expect(familyFromLegacyModel(model)).toBe(family);
  });

  it("gives every picker family effort, max and auto, and a Codex model none", () => {
    const opusLevels = effortLevelsFor("claude", "opus");
    expect(opusLevels.map((e) => e.level)).toContain("max");
    for (const { family } of MODEL_FAMILIES) {
      expect(isClaudeFamily(family)).toBe(true);
      expect(claudeFamilySupportsEffort(family)).toBe(true);
      expect(claudeFamilySupportsMaxEffort(family)).toBe(true);
      expect(claudeFamilySupportsAutoPermission(family)).toBe(true);
      expect(effortLevelsFor("claude", family)).toEqual(opusLevels);
    }
    expect(claudeFamilySupportsEffort("gpt-5.5")).toBe(false);
    expect(claudeFamilySupportsMaxEffort("gpt-5.5")).toBe(false);
    expect(claudeFamilySupportsAutoPermission("gpt-5.5")).toBe(false);
  });

  it("validateEffort keeps every level the picker offers a family", () => {
    for (const { family } of MODEL_FAMILIES)
      for (const { level } of effortLevelsFor("claude", family))
        expect(validateEffort("claude", family, level)).toBe(level);
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

  // Task f49289bd: a Claude agent with no mode, or a mode Claude does not
  // have, starts in Bypass on every family, and never falls to Ask. Only a
  // stored Auto runs as Ask on a limited family.
  it("validatePermissionMode corrects a stored auto to default on a limited family; no mode gives bypass on any family", () => {
    expect(validatePermissionMode("claude", "auto", "haiku", limited)).toBe(
      "default",
    );
    for (const raw of [undefined, "never"] as const)
      for (const family of ["sonnet", "opus"])
        expect(validatePermissionMode("claude", raw, family, limited)).toBe(
          "bypassPermissions",
        );
    expect(validatePermissionMode("claude", undefined)).toBe(
      "bypassPermissions",
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
