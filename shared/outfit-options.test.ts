import { describe, expect, it, spyOn } from "bun:test";
import { BEARDS, randomOutfit } from "./outfit-options.ts";

describe("randomOutfit", () => {
  it("gives no beard on the low half of the coin", () => {
    // Pick order: hat, color, hair, hairStyle, skin, beard coin, accessory.
    const values = [0, 0, 0, 0, 0, 0.49, 0];
    const spy = spyOn(Math, "random").mockImplementation(
      () => values.shift() ?? 0,
    );
    const outfit = randomOutfit();
    spy.mockRestore();
    expect(outfit.beard).toBe("none");
  });

  it("picks a beard style on the high half of the coin", () => {
    const values = [0, 0, 0, 0, 0, 0.5, 0, 0];
    const spy = spyOn(Math, "random").mockImplementation(
      () => values.shift() ?? 0,
    );
    const outfit = randomOutfit();
    spy.mockRestore();
    expect(outfit.beard).not.toBe("none");
    expect(BEARDS).toContain(outfit.beard);
  });

  it("has no beard about half the time", () => {
    let none = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (randomOutfit().beard === "none") none++;
    expect(none / n).toBeGreaterThan(0.44);
    expect(none / n).toBeLessThan(0.56);
  });
});
