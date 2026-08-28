import { describe, expect, it } from "bun:test";
import { ENGINE_OPTIONS } from "./engine-options.ts";

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
