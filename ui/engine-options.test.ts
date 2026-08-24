import { describe, expect, it } from "bun:test";
import { ENGINE_OPTIONS } from "./engine-options.ts";

describe("spawn engine copy", () => {
  it("describes both supported logins with parallel copy", () => {
    expect(
      Object.fromEntries(
        ENGINE_OPTIONS.map((option) => [option.agentType, option.blurb]),
      ),
    ).toEqual({
      claude: "Works with your Claude Code login.",
      codex: "Works with your ChatGPT login.",
    });
  });
});
