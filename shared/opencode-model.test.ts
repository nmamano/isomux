import { describe, expect, it } from "bun:test";
import {
  openCodeDefaultModel,
  preferredFreeOpenCodeModel,
} from "./opencode-model.ts";
import { OPENCODE_DEFAULT_MODEL } from "./types.ts";

// Task eecaaedc: the server fills an agent with no model from this rule, and
// marks the pick as the office's only when it is the preferred free model.
// The order itself is pinned through the UI picker (defaultBackendModel in
// ui/backend-model-selection.test.ts).
describe("openCodeDefaultModel", () => {
  const free = { id: OPENCODE_DEFAULT_MODEL, isFree: true };
  const reported = { id: "prov/reported", isDefault: true };
  const first = { id: "prov/first" };

  it("marks only the preferred free model as the office's pick", () => {
    expect(openCodeDefaultModel([first, reported, free])).toEqual({
      model: free,
      officeFree: true,
    });
    expect(openCodeDefaultModel([first, reported])).toEqual({
      model: reported,
      officeFree: false,
    });
    expect(openCodeDefaultModel([first])).toEqual({
      model: first,
      officeFree: false,
    });
  });

  it("never picks a hidden model, and gives nothing for a list with no visible model", () => {
    const hiddenDefault = { ...reported, hidden: true };
    expect(openCodeDefaultModel([hiddenDefault, first])?.model).toBe(first);
    expect(openCodeDefaultModel([hiddenDefault])).toBeUndefined();
    expect(openCodeDefaultModel([])).toBeUndefined();
  });
});

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
    const a = { id: "opencode/a-model", isFree: true };
    const b = { id: "opencode/big-pickle", isFree: true };
    expect(preferredFreeOpenCodeModel([a, b], preferred)?.id).toBe(a.id);
    expect(preferredFreeOpenCodeModel([b, a], preferred)?.id).toBe(a.id);
  });

  it("falls back only inside the preferred model's provider", () => {
    const models = [
      { id: "opencode-go/sorts-first-free", isFree: true },
      { id: "gate/gate-model", isFree: true },
      { id: "opencode/replacement-free", isFree: true },
    ];
    expect(preferredFreeOpenCodeModel(models, preferred)?.id).toBe(
      "opencode/replacement-free",
    );
    expect(
      preferredFreeOpenCodeModel(models.slice(0, 2), preferred),
    ).toBeUndefined();
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
