// Zoom math for the chat's image lightbox (ImageLightbox in
// attachment-download.tsx). The page viewport forbids pinch zoom (the office
// view pinches on its own), so the lightbox zooms its own image: the image is
// fit * scale px large inside a scroll viewport of min(fit * scale, box) px,
// centered on the screen.

export interface Size {
  w: number;
  h: number;
}

// A zoom state: the scale over the fit size and the viewport's scroll.
export interface ZoomView {
  scale: number;
  scrollLeft: number;
  scrollTop: number;
}

// A point as an offset from the viewport's center, in px.
export interface Offset {
  x: number;
  y: number;
}

// The largest size the lightbox gives the viewport: 90% of the window, less
// the gap and the download button under the image.
export function lightboxBox(innerWidth: number, innerHeight: number): Size {
  return {
    w: Math.max(1, innerWidth * 0.9),
    h: Math.max(1, innerHeight * 0.9 - 52),
  };
}

// The size of the image at scale 1: scaled down to fit the box, never up.
export function fitSize(natural: Size, box: Size): Size {
  const k = Math.min(1, box.w / natural.w, box.h / natural.h);
  return { w: natural.w * k, h: natural.h * k };
}

// The scale that shows the image's pixels 1:1 (at most 1 when the image
// already shows at full size).
export function fullScale(natural: Size, fit: Size): number {
  return natural.w / fit.w;
}

export function maxScale(natural: Size, fit: Size): number {
  return Math.max(4, 2 * fullScale(natural, fit));
}

// The viewport's size at a scale: the image, or the box when it is larger.
export function viewportSize(fit: Size, scale: number, box: Size): Size {
  return {
    w: Math.min(fit.w * scale, box.w),
    h: Math.min(fit.h * scale, box.h),
  };
}

// Where a mouse click goes: back to fit when zoomed, else full size.
export function clickScale(scale: number, natural: Size, fit: Size): number {
  return scale > 1 ? 1 : fullScale(natural, fit);
}

// Where a double-tap goes: back to fit when zoomed, else full size and at
// least 2x.
export function doubleTapScale(
  scale: number,
  natural: Size,
  fit: Size,
): number {
  return scale > 1 ? 1 : Math.max(2, fullScale(natural, fit));
}

// The view at nextScale (clamped to [1, max]) that keeps the image point under
// focal where it was, with the scroll clamped to its range.
export function zoomAt(
  view: ZoomView,
  nextScale: number,
  focal: Offset,
  fit: Size,
  box: Size,
  max: number,
): ZoomView {
  const scale = Math.min(Math.max(nextScale, 1), max);
  const from = viewportSize(fit, view.scale, box);
  const to = viewportSize(fit, scale, box);
  // Per axis: the image point (in fit px) under the focal point, then the
  // scroll that puts it there at the new scale.
  function axis(scroll: number, offset: number, was: number, now: number) {
    return (
      ((scroll + offset + was / 2) / view.scale) * scale - offset - now / 2
    );
  }
  return clampScroll(
    {
      scale,
      scrollLeft: axis(view.scrollLeft, focal.x, from.w, to.w),
      scrollTop: axis(view.scrollTop, focal.y, from.h, to.h),
    },
    fit,
    box,
  );
}

// The view with its scroll kept inside the image.
export function clampScroll(view: ZoomView, fit: Size, box: Size): ZoomView {
  const vp = viewportSize(fit, view.scale, box);
  const clamp = (v: number, end: number) => Math.min(Math.max(v, 0), end);
  return {
    scale: view.scale,
    scrollLeft: clamp(view.scrollLeft, fit.w * view.scale - vp.w),
    scrollTop: clamp(view.scrollTop, fit.h * view.scale - vp.h),
  };
}
