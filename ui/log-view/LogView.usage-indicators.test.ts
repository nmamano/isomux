import { describe, expect, it } from "bun:test";

import { showAgentUsageIndicators } from "./LogView.tsx";

describe("showAgentUsageIndicators", () => {
  it("hides OpenCode and keeps Claude and Codex", () => {
    expect(showAgentUsageIndicators("opencode")).toBe(false);
    expect(showAgentUsageIndicators("claude")).toBe(true);
    expect(showAgentUsageIndicators("codex")).toBe(true);
  });
});
