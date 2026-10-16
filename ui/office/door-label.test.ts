import { describe, expect, it } from "bun:test";
import {
  DOOR_LABEL_END,
  DOOR_LABEL_MAX_WIDTH,
  DOOR_LABEL_MIN_SIZE,
  DOOR_LABEL_SIZE,
  fitDoorLabel,
} from "./door-label.ts";

// Every unit is CHAR wide at DOOR_LABEL_SIZE.
const CHAR = 7;
const prefix = (n: number) => n * CHAR;

function drawnWidth(fit: { text: string; size: number }): number {
  return fit.text.length * CHAR * (fit.size / DOOR_LABEL_SIZE);
}

describe("fitDoorLabel", () => {
  it("centres a label that fits between the door and the wall end", () => {
    const label = "x".repeat(Math.floor((2 * DOOR_LABEL_END) / CHAR));
    expect(fitDoorLabel(label, prefix, CHAR)).toEqual({
      text: label,
      size: DOOR_LABEL_SIZE,
      atWallEnd: false,
    });
  });

  it("moves a wider label to the wall end at full size while it fits", () => {
    const label = "x".repeat(Math.floor((2 * DOOR_LABEL_END) / CHAR) + 1);
    const fit = fitDoorLabel(label, prefix, CHAR);
    expect(fit).toEqual({
      text: label,
      size: DOOR_LABEL_SIZE,
      atWallEnd: true,
    });
  });

  it("shrinks a label to the maximum width before it cuts one", () => {
    const label = "x".repeat(Math.ceil(DOOR_LABEL_MAX_WIDTH / CHAR) + 2);
    const fit = fitDoorLabel(label, prefix, CHAR);
    expect(fit.text).toBe(label);
    expect(fit.size).toBeLessThan(DOOR_LABEL_SIZE);
    expect(fit.size).toBeGreaterThanOrEqual(DOOR_LABEL_MIN_SIZE);
    expect(drawnWidth(fit)).toBeCloseTo(DOOR_LABEL_MAX_WIDTH, 6);
  });

  it("cuts a label too long for the minimum size, ellipsis included", () => {
    const label = "x".repeat(80);
    const fit = fitDoorLabel(label, prefix, CHAR);
    expect(fit.size).toBe(DOOR_LABEL_MIN_SIZE);
    expect(fit.atWallEnd).toBe(true);
    expect(fit.text.endsWith("…")).toBe(true);
    expect(label.startsWith(fit.text.slice(0, -1))).toBe(true);
    expect(drawnWidth(fit)).toBeLessThanOrEqual(DOOR_LABEL_MAX_WIDTH);
    // One more character would not fit.
    expect(drawnWidth({ ...fit, text: `x${fit.text}` })).toBeGreaterThan(
      DOOR_LABEL_MAX_WIDTH,
    );
  });

  it("does not split a surrogate pair at the cut", () => {
    const label = "😀".repeat(40);
    const fit = fitDoorLabel(label, prefix, CHAR);
    const kept = fit.text.slice(0, -1);
    expect(kept.length % 2).toBe(0);
    expect(label.startsWith(kept)).toBe(true);
  });
});
