import { describe, expect, it } from "bun:test";
import { familyDisplayLabel } from "../shared/types.ts";
import { modelListingLabel } from "./model-listing-label.ts";

describe("modelListingLabel", () => {
  it("identifies OpenCode when its connected model looks like another engine", () => {
    expect(modelListingLabel("opencode", "anthropic/claude-sonnet-4-6")).toBe(
      "Claude Sonnet 4 6 · opencode",
    );
  });

  it("does not repeat an engine already identified by the model label", () => {
    expect(modelListingLabel("codex", "gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(modelListingLabel("claude", "sonnet")).toBe("Sonnet 5.5");
  });

  it("leaves a Claude composite model without an engine cue", () => {
    const model = "anthropic/claude-sonnet-4-6";
    expect(modelListingLabel("claude", model)).toBe(familyDisplayLabel(model));
  });

  it("keeps the OpenCode cue for an engine-like provider id", () => {
    for (const model of ["gpt-provider/model", "claude-provider/model"]) {
      expect(modelListingLabel("opencode", model)).toBe(
        `${familyDisplayLabel(model)} · opencode`,
      );
    }
  });

  it("preserves the listing without a cue for a custom Codex model", () => {
    expect(modelListingLabel("codex", "custom/model")).toBe(
      familyDisplayLabel("custom/model"),
    );
  });
});
