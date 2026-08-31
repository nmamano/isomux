import { describe, expect, it } from "bun:test";
import { resolveWelcomeOpenCodeModel } from "./welcome-opencode-model.ts";

describe("welcome OpenCode model resolution", () => {
  const preferred = "opencode/preferred-free";

  it("selects a free replacement when the preferred id is gone", async () => {
    expect(
      await resolveWelcomeOpenCodeModel(
        async () => [
          { id: "paid/default", label: "Paid", supportedEfforts: [] },
          {
            id: "opencode/replacement-free",
            label: "Free",
            isFree: true,
            supportedEfforts: [],
          },
        ],
        preferred,
        100,
      ),
    ).toEqual({ kind: "selected", model: "opencode/replacement-free" });
  });

  it("distinguishes a successful discovery with no free model", async () => {
    expect(
      await resolveWelcomeOpenCodeModel(
        async () => [
          { id: "paid/default", label: "Paid", supportedEfforts: [] },
        ],
        preferred,
        100,
      ),
    ).toEqual({ kind: "no_free_model" });
  });

  it("bounds discovery and reports failure", async () => {
    const result = await resolveWelcomeOpenCodeModel(
      () => new Promise(() => undefined),
      preferred,
      5,
    );
    expect(result.kind).toBe("discovery_failed");
    if (result.kind === "discovery_failed") {
      expect(String(result.error)).toContain("timed out");
    }
  });
});
