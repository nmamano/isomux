import { describe, expect, it } from "bun:test";

import {
  showAgentContextUsageIndicator,
  showAgentSubscriptionUsageIndicator,
} from "./LogView.tsx";

describe("agent usage indicators", () => {
  it("shows context usage for every backend", () => {
    expect(showAgentContextUsageIndicator("opencode")).toBe(true);
    expect(showAgentContextUsageIndicator("claude")).toBe(true);
    expect(showAgentContextUsageIndicator("codex")).toBe(true);
  });

  it("hides subscription usage only for OpenCode", () => {
    expect(showAgentSubscriptionUsageIndicator("opencode")).toBe(false);
    expect(showAgentSubscriptionUsageIndicator("claude")).toBe(true);
    expect(showAgentSubscriptionUsageIndicator("codex")).toBe(true);
  });
});
