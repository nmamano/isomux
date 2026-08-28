import { describe, expect, it } from "bun:test";
import { alternateEngineOptions, ENGINE_OPTIONS } from "./engine-options.ts";

describe("spawn engine copy", () => {
  it("describes every spawn engine", () => {
    expect(
      Object.fromEntries(
        ENGINE_OPTIONS.map((option) => [option.agentType, option.blurb]),
      ),
    ).toEqual({
      claude: "Works with your Claude Code login.",
      codex: "Works with your ChatGPT login.",
      opencode: "Works with models configured through OpenCode.",
    });
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
