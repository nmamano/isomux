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

  it("falls back to the id-smallest free model when the pin is retired", () => {
    const models = [
      { id: "paid/default" },
      { id: "opencode/replacement-free", isFree: true },
      { id: "opencode/later-free", isFree: true },
    ];
    expect(preferredFreeOpenCodeModel(models, preferred)?.id).toBe(
      "opencode/later-free",
    );
  });

  it("ignores the caller's list order, so display-label sorting cannot steer selection", () => {
    const a = { id: "gate/gate-model", isFree: true };
    const b = { id: "opencode/big-pickle", isFree: true };
    expect(preferredFreeOpenCodeModel([a, b], preferred)?.id).toBe(
      "gate/gate-model",
    );
    expect(preferredFreeOpenCodeModel([b, a], preferred)?.id).toBe(
      "gate/gate-model",
    );
  });

  it("refuses hidden and paid candidates", () => {
    expect(
      preferredFreeOpenCodeModel(
        [{ id: preferred, isFree: true, hidden: true }, { id: "paid/default" }],
        preferred,
      ),
    ).toBeUndefined();
  });
});
