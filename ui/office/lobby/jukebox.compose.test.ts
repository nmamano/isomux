// Each composer must return a bounded, sorted take, whatever seed it draws:
// the scheduler loops over these events as they are. A loopEnd of 0 never lets
// its loop finish, and an unsorted or late event plays out of place.
import { describe, expect, test } from "bun:test";
import { composeStyle, STYLES } from "./jukebox.ts";

describe("lobby jukebox composers", () => {
  for (const style of STYLES) {
    test(`${style}: bounded, sorted, sane for several seeds`, () => {
      for (const seed of [1, 7, 42, 9227]) {
        const piece = composeStyle(style, seed);
        expect(piece.tempo).toBeGreaterThanOrEqual(40);
        expect(piece.tempo).toBeLessThanOrEqual(200);
        expect(piece.loopEnd).toBeGreaterThan(0);
        expect(piece.events.length).toBeGreaterThan(0);
        const first = piece.events[0];
        expect(first.at).toBeGreaterThanOrEqual(0);
        let prevAt = -1;
        for (const ev of piece.events) {
          expect(ev.at).toBeGreaterThanOrEqual(prevAt);
          prevAt = ev.at;
          expect(ev.at).toBeLessThan(piece.loopEnd);
          expect(Number.isFinite(ev.amp)).toBe(true);
          expect(ev.amp).toBeGreaterThan(0);
          if (ev.kind === "tone") {
            expect(Number.isFinite(ev.midi)).toBe(true);
            expect(ev.midi).toBeGreaterThan(12);
            expect(ev.midi).toBeLessThan(120);
          }
        }
      }
    });
  }
});
