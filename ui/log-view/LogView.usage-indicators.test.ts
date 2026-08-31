import { describe, expect, it } from "bun:test";

import { showAgentSubscriptionUsageIndicator } from "./LogView.tsx";

describe("agent usage indicators", () => {
  it("hides subscription usage only for OpenCode", () => {
    expect(showAgentSubscriptionUsageIndicator("opencode")).toBe(false);
    expect(showAgentSubscriptionUsageIndicator("claude")).toBe(true);
    expect(showAgentSubscriptionUsageIndicator("codex")).toBe(true);
  });
});
