import { describe, expect, it, spyOn } from "bun:test";
import {
  BEARDS,
  HAIR_STYLES,
  HATS,
  isUnusualOutfit,
  randomOutfit,
} from "./outfit-options.ts";

describe("isUnusualOutfit", () => {
  it("flags a hair bow with a beard or a bald head", () => {
    expect(
      isUnusualOutfit({ hat: "bow", beard: "full", hairStyle: "short" }),
    ).toBe(true);
    expect(
      isUnusualOutfit({ hat: "bow", beard: "none", hairStyle: "bald" }),
    ).toBe(true);
  });

  it("flags a beard with pigtails", () => {
    expect(
      isUnusualOutfit({ hat: "none", beard: "goatee", hairStyle: "pigtails" }),
    ).toBe(true);
  });

  it("allows each part on its own", () => {
    expect(
      isUnusualOutfit({ hat: "bow", beard: "none", hairStyle: "long" }),
    ).toBe(false);
    expect(
      isUnusualOutfit({ hat: "cap", beard: "full", hairStyle: "bald" }),
    ).toBe(false);
    expect(
      isUnusualOutfit({ hat: "none", beard: "none", hairStyle: "pigtails" }),
    ).toBe(false);
  });
});

describe("randomOutfit", () => {
  // Math.random value that picks arr[index].
  const at = <T>(arr: readonly T[], value: T) =>
    (arr.indexOf(value) + 0.5) / arr.length;

  it("picks again when the first pick is unusual", () => {
    // Pick order: hat, color, hair, hairStyle, skin, beard, accessory.
    const first = [at(HATS, "bow"), 0, 0, at(HAIR_STYLES, "short"), 0];
    const unusual = [...first, at(BEARDS, "full"), 0];
    const usual = [...first, at(BEARDS, "none"), 0];
    const values = [...unusual, ...usual];
    const spy = spyOn(Math, "random").mockImplementation(
      () => values.shift() ?? 0,
    );
    const outfit = randomOutfit();
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(calls).toBe(unusual.length + usual.length);
    expect(isUnusualOutfit(outfit)).toBe(false);
    expect(outfit.hat).toBe("bow");
  });

  it("never returns an unusual outfit", () => {
    for (let i = 0; i < 500; i++)
      expect(isUnusualOutfit(randomOutfit())).toBe(false);
  });
});
