// Zoom math of the chat's image lightbox (task 9aeb2266). The page viewport
// forbids pinch zoom, so the lightbox zooms its own image: fit * scale px
// inside a scroll viewport of min(fit * scale, box) px whose center stays put.
// The component tests (attachment-download.dom.test.tsx) drive the gestures;
// these pin the numbers they rest on.

import { describe, expect, it } from "bun:test";
import {
  clickScale,
  doubleTapScale,
  fitSize,
  fullScale,
  lightboxBox,
  maxScale,
  viewportSize,
  zoomAt,
  type Offset,
  type Size,
  type ZoomView,
} from "./image-zoom.ts";

// A 1000 x 800 window: 90% of it, less the 52 px of gap and download button.
const BOX: Size = { w: 900, h: 668 };

function expectSize(actual: Size, w: number, h: number) {
  expect(actual.w).toBeCloseTo(w, 6);
  expect(actual.h).toBeCloseTo(h, 6);
}

describe("lightbox sizes", () => {
  it("the box is 90% of the window, less the button row", () => {
    expectSize(lightboxBox(1000, 800), BOX.w, BOX.h);
  });

  it("fit scales a large image down by its tighter axis and keeps its shape", () => {
    // Width binds: 1800 x 600 -> 900 x 300.
    expectSize(fitSize({ w: 1800, h: 600 }, BOX), 900, 300);
    // Height binds: 1000 x 2672 -> 250 x 668.
    expectSize(fitSize({ w: 1000, h: 2672 }, BOX), 250, 668);
  });

  it("fit never scales a small image up", () => {
    expectSize(fitSize({ w: 400, h: 300 }, BOX), 400, 300);
    expectSize(fitSize({ w: 900, h: 668 }, BOX), 900, 668);
  });

  it("full scale shows the image pixels 1:1, and is 1 when fit already does", () => {
    expect(fullScale({ w: 1800, h: 600 }, { w: 900, h: 300 })).toBeCloseTo(
      2,
      6,
    );
    expect(fullScale({ w: 400, h: 300 }, { w: 400, h: 300 })).toBe(1);
  });

  it("the zoom limit is 4x, or twice full size for a larger image", () => {
    expect(maxScale({ w: 400, h: 300 }, { w: 400, h: 300 })).toBe(4);
    expect(maxScale({ w: 1800, h: 600 }, { w: 900, h: 300 })).toBeCloseTo(4, 6);
    expect(maxScale({ w: 4500, h: 1500 }, { w: 900, h: 300 })).toBeCloseTo(
      10,
      6,
    );
  });

  it("the viewport is the image, or the box on each axis the image overflows", () => {
    const fit = { w: 900, h: 300 };
    expectSize(viewportSize(fit, 1, BOX), 900, 300);
    expectSize(viewportSize(fit, 2, BOX), 900, 600);
    expectSize(viewportSize(fit, 3, BOX), 900, 668);
  });
});

describe("zoom targets", () => {
  // fullScale 1.3: past fit, short of 2x.
  const NATURAL = { w: 1170, h: 390 };
  const FIT = { w: 900, h: 300 };

  it("a click goes to full size exactly, not past it, and back to fit when zoomed", () => {
    expect(clickScale(1, NATURAL, FIT)).toBeCloseTo(1.3, 6);
    expect(clickScale(1.3, NATURAL, FIT)).toBe(1);
    expect(clickScale(2.5, NATURAL, FIT)).toBe(1);
  });

  it("a double-tap goes to at least 2x, to full size when that is larger, and back to fit when zoomed", () => {
    expect(doubleTapScale(1, NATURAL, FIT)).toBe(2);
    expect(doubleTapScale(1, { w: 2700, h: 900 }, FIT)).toBeCloseTo(3, 6);
    expect(doubleTapScale(1, { w: 400, h: 300 }, { w: 400, h: 300 })).toBe(2);
    expect(doubleTapScale(2, NATURAL, FIT)).toBe(1);
  });
});

describe("zoomAt", () => {
  const FIT: Size = { w: 900, h: 300 };
  const MAX = 4;

  // Computed here, not with the module's viewportSize: the expected values
  // must not come from the code under test.
  const viewport = (scale: number): Size => ({
    w: Math.min(FIT.w * scale, BOX.w),
    h: Math.min(FIT.h * scale, BOX.h),
  });

  // The point of the fit-size image (0..FIT) that shows at `focal`.
  function imagePointAt(view: ZoomView, focal: Offset) {
    const vp = viewport(view.scale);
    return {
      x: (view.scrollLeft + vp.w / 2 + focal.x) / view.scale,
      y: (view.scrollTop + vp.h / 2 + focal.y) / view.scale,
    };
  }

  function expectInRange(view: ZoomView) {
    const vp = viewport(view.scale);
    expect(view.scrollLeft).toBeGreaterThanOrEqual(0);
    expect(view.scrollTop).toBeGreaterThanOrEqual(0);
    expect(view.scrollLeft).toBeLessThanOrEqual(FIT.w * view.scale - vp.w);
    expect(view.scrollTop).toBeLessThanOrEqual(FIT.h * view.scale - vp.h);
  }

  const AT_FIT: ZoomView = { scale: 1, scrollLeft: 0, scrollTop: 0 };

  it("zooming in about the center keeps the center's point under it", () => {
    const next = zoomAt(AT_FIT, 2, { x: 0, y: 0 }, FIT, BOX, MAX);
    expect(next.scale).toBe(2);
    // The image's center (450, 150) stays at the viewport's center.
    expect(next.scrollLeft).toBeCloseTo(450, 6);
    expect(next.scrollTop).toBeCloseTo(0, 6); // 600 tall in a 600 viewport
    const p = imagePointAt(next, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(450, 6);
    expect(p.y).toBeCloseTo(150, 6);
  });

  it("the point under an off-center focal point stays under it, in and out", () => {
    const from: ZoomView = { scale: 2, scrollLeft: 400, scrollTop: 0 };
    const focal = { x: 120, y: -80 };
    const before = imagePointAt(from, focal);
    const zoomedIn = zoomAt(from, 3, focal, FIT, BOX, MAX);
    expect(zoomedIn.scale).toBe(3);
    expectInRange(zoomedIn);
    const afterIn = imagePointAt(zoomedIn, focal);
    expect(afterIn.x).toBeCloseTo(before.x, 6);
    expect(afterIn.y).toBeCloseTo(before.y, 6);

    const zoomedOut = zoomAt(zoomedIn, 2.5, focal, FIT, BOX, MAX);
    expectInRange(zoomedOut);
    const afterOut = imagePointAt(zoomedOut, focal);
    expect(afterOut.x).toBeCloseTo(before.x, 6);
    expect(afterOut.y).toBeCloseTo(before.y, 6);
  });

  it("the scroll stops at the image's edges instead of showing past them", () => {
    // At 3x, scrolled to the far right and bottom; zoom out about the
    // viewport's center: the kept point would need a scroll past the end.
    const vp3 = viewport(3);
    const farEnd: ZoomView = {
      scale: 3,
      scrollLeft: FIT.w * 3 - vp3.w,
      scrollTop: FIT.h * 3 - vp3.h,
    };
    const out = zoomAt(farEnd, 2, { x: 0, y: 0 }, FIT, BOX, MAX);
    expect(out.scale).toBe(2);
    expect(out.scrollLeft).toBeCloseTo(FIT.w * 2 - viewport(2).w, 6);
    expect(out.scrollTop).toBeCloseTo(FIT.h * 2 - viewport(2).h, 6);

    // At 3x at the top left; zoom out about the bottom right corner: the kept
    // point would need a negative scroll.
    const start: ZoomView = { scale: 3, scrollLeft: 0, scrollTop: 0 };
    const corner = { x: vp3.w / 2, y: vp3.h / 2 };
    const out2 = zoomAt(start, 2, corner, FIT, BOX, MAX);
    expect(out2.scrollLeft).toBeCloseTo(0, 6);
    expect(out2.scrollTop).toBeCloseTo(0, 6);
  });

  it("the scale stays in [1, max]; at 1 the whole image shows", () => {
    const zoomed: ZoomView = { scale: 3, scrollLeft: 900, scrollTop: 100 };
    const tooFar = zoomAt(zoomed, 50, { x: 10, y: 10 }, FIT, BOX, MAX);
    expect(tooFar.scale).toBe(MAX);
    expectInRange(tooFar);

    const below = zoomAt(zoomed, 0.2, { x: 10, y: 10 }, FIT, BOX, MAX);
    expect(below.scale).toBe(1);
    expect(below.scrollLeft).toBeCloseTo(0, 6);
    expect(below.scrollTop).toBeCloseTo(0, 6);
  });
});
