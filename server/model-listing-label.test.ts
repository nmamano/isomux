import { describe, expect, it } from "bun:test";
import { modelListingLabel } from "./model-listing-label.ts";

describe("modelListingLabel", () => {
  it("identifies OpenCode when its connected model looks like another engine", () => {
    expect(modelListingLabel("opencode", "anthropic/claude-sonnet-4-6")).toBe(
      "Claude Sonnet 4 6 · opencode",
    );
  });

  it("does not repeat an engine already identified by the model label", () => {
    expect(modelListingLabel("codex", "gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(modelListingLabel("claude", "sonnet")).toBe("Sonnet 5");
  });
});
