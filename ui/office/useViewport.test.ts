import { test, expect } from "bun:test";
import { computeRestView, artBounds, type Bounds } from "./useViewport.ts";

// The scene's layout box is 950x700 and it is centred in the container, so its
// layer-local box follows from the container size alone. These helpers rebuild
// the geometry the hook measures out of the DOM, at static scale 1.
function layoutBox(cw: number, ch: number, scale = 1): Bounds {
  const w = 950 * scale;
  const h = 700 * scale;
  return {
    left: (cw - w) / 2,
    right: (cw + w) / 2,
    top: (ch - h) / 2,
    bottom: (ch + h) / 2,
  };
}

const FIT_MARGIN = 12;

test("artBounds matches the painted extents measured in the browser", () => {
  // 1920x1080 desktop: container 1920x941, art at 476..1444 x 11.5..749.5
  // relative to the container (measured in Chrome, 2026-09-04).
  const art = artBounds(layoutBox(1920, 941));
  expect(art.left).toBeCloseTo(476, 1);
  expect(art.right).toBeCloseTo(1444, 1);
  expect(art.top).toBeCloseTo(11.5, 1);
  expect(art.bottom).toBeCloseTo(749.5, 1);
});

test("artBounds scales with the static transform", () => {
  const art = artBounds(layoutBox(390, 600, 0.52));
  expect(art.right - art.left).toBeCloseTo(968 * 0.52, 3);
  expect(art.bottom - art.top).toBeCloseTo(738 * 0.52, 3);
});

test("a container that already shows the whole scene is left untouched", () => {
  // 1920x1080 is the ratio the scene was authored against - the rest view must
  // be identical to the old reset, or the fix would move a good scene.
  const v = computeRestView(1920, 941, artBounds(layoutBox(1920, 941)), false);
  expect(v).toEqual({ x: 0, y: 0, scale: 1 });
});

test("3440x900 is fixed by moving the scene, not by shrinking it", () => {
  const cw = 3440;
  const ch = 761;
  const art = artBounds(layoutBox(cw, ch));
  const v = computeRestView(cw, ch, art, false);
  // 738 of art in 761 of container: it only has to give up the 1 pixel that
  // does not fit inside the margin, so the scene stays its authored size.
  expect(v.scale).toBeCloseTo((ch - 2 * FIT_MARGIN) / 738, 6);
  expect(v.scale).toBeGreaterThan(0.998);
  // Art top sits at (761-700)/2 - 109 = -78.5, so it has to come down.
  expect(art.top).toBeCloseTo(-78.5, 3);
  expect(v.scale * art.top + v.y).toBeCloseTo(FIT_MARGIN, 3);
  const mid = (v.scale * art.left + v.x + (v.scale * art.right + v.x)) / 2;
  expect(mid).toBeCloseTo(cw / 2, 3);
});

test("2560x800 scales down until the whole painted scene fits", () => {
  const cw = 2560;
  const ch = 661;
  const art = artBounds(layoutBox(cw, ch));
  const v = computeRestView(cw, ch, art, false);
  expect(v.scale).toBeCloseTo((ch - 2 * FIT_MARGIN) / 738, 6);
  expect(v.scale).toBeLessThan(1);
  // Every painted edge lands inside the container, top edge on the margin.
  expect(v.scale * art.top + v.y).toBeCloseTo(FIT_MARGIN, 3);
  expect(v.scale * art.bottom + v.y).toBeCloseTo(ch - FIT_MARGIN, 3);
  expect(v.scale * art.left + v.x).toBeGreaterThan(0);
  expect(v.scale * art.right + v.x).toBeLessThan(cw);
});

test("the scene stays horizontally centred when it is scaled down", () => {
  const cw = 2560;
  const ch = 661;
  const art = artBounds(layoutBox(cw, ch));
  const v = computeRestView(cw, ch, art, false);
  const mid = (v.scale * art.left + v.x + (v.scale * art.right + v.x)) / 2;
  expect(mid).toBeCloseTo(cw / 2, 3);
});

test("a short-but-sufficient container moves the scene instead of shrinking it", () => {
  // 738 of art in 780 of container: it fits, but centring the layout box puts
  // the wall ridge 69px above the top edge.
  const art = artBounds(layoutBox(1600, 780));
  const v = computeRestView(1600, 780, art, false);
  expect(v.scale).toBe(1);
  expect(art.top).toBeCloseTo(-69, 3);
  expect(art.top + v.y).toBeCloseTo(FIT_MARGIN, 3);
});

test("the scene never grows above the authored scale", () => {
  const v = computeRestView(
    5000,
    3000,
    artBounds(layoutBox(5000, 3000)),
    false,
  );
  expect(v).toEqual({ x: 0, y: 0, scale: 1 });
});

test("width alone never shrinks the scene when only height is fitted", () => {
  // 900px wide is narrower than the 968px of art, but the authored scene is
  // meant to bleed sideways.
  const v = computeRestView(900, 1200, artBounds(layoutBox(900, 1200)), false);
  expect(v.scale).toBe(1);
  // Overflow is cropped evenly, which at scale 1 is what it already did.
  expect(v.x).toBe(0);
});

test("fitWidth makes a narrow container shrink the scene instead", () => {
  const art = artBounds(layoutBox(900, 1200));
  const v = computeRestView(900, 1200, art, true);
  expect(v.scale).toBeCloseTo((900 - 2 * FIT_MARGIN) / 968, 6);
  expect(v.scale * art.left + v.x).toBeCloseTo(FIT_MARGIN, 3);
  expect(v.scale * art.right + v.x).toBeCloseTo(900 - FIT_MARGIN, 3);
});

test("the fit scale bottoms out at MIN_SCALE and crops evenly", () => {
  const cw = 1200;
  const ch = 200;
  const art = artBounds(layoutBox(cw, ch));
  const v = computeRestView(cw, ch, art, false);
  expect(v.scale).toBe(0.5);
  const top = v.scale * art.top + v.y;
  const bottom = v.scale * art.bottom + v.y;
  expect(top).toBeLessThan(0);
  expect(-top).toBeCloseTo(bottom - ch, 3);
});

test("a container with no size falls back to the authored view", () => {
  expect(computeRestView(0, 0, artBounds(layoutBox(100, 100)), false)).toEqual({
    x: 0,
    y: 0,
    scale: 1,
  });
});
