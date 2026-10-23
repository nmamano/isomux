import { expect, it } from "bun:test";
import { familyDisplayLabel } from "../shared/types.ts";
import { modelListingLabel } from "./model-listing-label.ts";

// shared/model-label.test.ts owns which engine gets a cue on which surface.
// This owns the listing's use of it: the "listing" surface (a custom Codex
// model gets a cue in the header, none here) and the cue after the label.
it("adds the OpenCode cue after the label, and no cue for Claude or Codex in a listing", () => {
  const rows = [
    // OpenCode, even when its model looks like another engine.
    { agentType: "opencode", model: "anthropic/claude-sonnet-4-6", cue: true },
    { agentType: "codex", model: "gpt-5.6-sol", cue: false },
    { agentType: "codex", model: "custom/model", cue: false },
    { agentType: "claude", model: "sonnet", cue: false },
    { agentType: "claude", model: "anthropic/claude-sonnet-4-6", cue: false },
  ] as const;
  for (const { agentType, model, cue } of rows) {
    const base = familyDisplayLabel(model);
    const label = modelListingLabel(agentType, model);
    expect({ agentType, model, cued: label !== base }).toEqual({
      agentType,
      model,
      cued: cue,
    });
    if (cue) {
      expect(label.startsWith(base)).toBe(true);
      expect(label.endsWith("opencode")).toBe(true);
    }
  }
});
