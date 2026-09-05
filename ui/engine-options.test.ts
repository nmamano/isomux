import { describe, expect, it } from "bun:test";
import { alternateEngineOptions, ENGINE_OPTIONS } from "./engine-options.ts";
import { translatorFor } from "../shared/i18n/translate.ts";

const english = translatorFor("en");

describe("spawn engines", () => {
  it("keeps one non-empty description for every supported engine", () => {
    expect(ENGINE_OPTIONS.map((option) => option.agentType).sort()).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
    for (const option of ENGINE_OPTIONS) {
      expect(english.t(option.blurbKey).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("alternate engine choices", () => {
  it("offers every configured engine except the current one", () => {
    for (const current of ENGINE_OPTIONS) {
      const alternates = alternateEngineOptions(current.agentType);
      expect(alternates.map((option) => option.agentType)).toEqual(
        ENGINE_OPTIONS.filter(
          (option) => option.agentType !== current.agentType,
        ).map((option) => option.agentType),
      );
      expect(
        alternates.some((option) => option.agentType === current.agentType),
      ).toBe(false);
      expect(alternates).toHaveLength(ENGINE_OPTIONS.length - 1);
    }
  });
});
