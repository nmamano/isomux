import { describe, expect, it } from "bun:test";
import { preferredFreeOpenCodeModel } from "./opencode-model.ts";

describe("preferredFreeOpenCodeModel", () => {
  const preferred = "opencode/preferred-free";

  it("uses the preferred id only when it remains an available free model", () => {
    const models = [
      { id: "opencode/other-free", isFree: true },
      { id: preferred, isFree: true },
    ];
    expect(preferredFreeOpenCodeModel(models, preferred)?.id).toBe(preferred);
  });

  it("falls back to the first free discovery result when the pin is retired", () => {
    const models = [
      { id: "paid/default" },
      { id: "opencode/replacement-free", isFree: true },
      { id: "opencode/later-free", isFree: true },
    ];
    expect(preferredFreeOpenCodeModel(models, preferred)?.id).toBe(
      "opencode/replacement-free",
    );
  });

  it("refuses hidden, connect-only, and paid candidates", () => {
    expect(
      preferredFreeOpenCodeModel(
        [
          { id: preferred, isFree: true, hidden: true },
          { id: "connect/free", isFree: true, requiresConnection: true },
          { id: "paid/default" },
        ],
        preferred,
      ),
    ).toBeUndefined();
  });
});
