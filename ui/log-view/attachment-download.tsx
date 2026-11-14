import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useI18n } from "../i18n.tsx";
import { Portal } from "../components/Portal.tsx";
import { homeScreenDownload } from "../home-screen-download.ts";
import { useAppState } from "../store.tsx";
import { claimEscape } from "../escape-layer.ts";
import { lightboxForClick } from "./linked-image.ts";
import {
  clampScroll,
  clickScale,
  doubleTapScale,
  fitSize,
  fullScale,
  lightboxBox,
  maxScale,
  viewportSize,
  zoomAt,
  type Size,
  type ZoomView,
} from "./image-zoom.ts";

// The chat's download control for attachments (image cards, file chips and the
// lightbox). The server keeps only a sanitized file name, so the link asks the
// file route for ?download=<original name>, which answers with
// Content-Disposition: attachment under that name. The download attribute
// says the same for browsers that honor it. On the iPhone Home Screen office
// the click opens the share sheet instead (ui/home-screen-download.ts).

export interface LightboxImage {
  src: string;
  name: string;
}

// A src can carry a query of its own (an agent's image link): the name joins
// it, and the src keeps its form (a path on the office's host stays a path).
export function downloadHref(src: string, originalName: string): string {
  const hashAt = src.indexOf("#");
  const rest = hashAt < 0 ? src : src.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : src.slice(hashAt);
  const queryAt = rest.indexOf("?");
  const path = queryAt < 0 ? rest : rest.slice(0, queryAt);
  const params = new URLSearchParams(
    queryAt < 0 ? "" : rest.slice(queryAt + 1),
  );
  params.set("download", originalName);
  return `${path}?${params.toString()}${hash}`;
}

export function DownloadButton({
  src,
  name,
  isMobile,
  overlay,
  style,
}: {
  src: string;
  name: string;
  isMobile?: boolean;
  // A small button in the corner of an image card, so it does not cover
  // the image.
  overlay?: boolean;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const label = t("cards.fileView.download", { file: name });
  const size = overlay ? (isMobile ? 24 : 20) : isMobile ? 32 : 26;
  const iconSize = overlay ? (isMobile ? 14 : 12) : isMobile ? 18 : 15;
  return (
    <a
      href={downloadHref(src, name)}
      download={name}
      // Not in the chat's HTML file (chat-export.ts).
      data-chat-export="omit"
      aria-label={label}
      title={label}
      // Inside the lightbox a click would bubble to the backdrop and close it.
      onClick={(e) => {
        e.stopPropagation();
        // The plain file route: an image in the chat is likely cached, so
        // the share sheet opens while the tap still counts.
        homeScreenDownload(e, src, name);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: overlay ? 4 : 6,
        background: overlay ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.6)",
        color: "#fff",
        cursor: "pointer",
        ...(overlay && { position: "absolute", right: 4, bottom: 4 }),
        ...style,
      }}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" />
      </svg>
    </a>
  );
}

// An image in the chat, with its download button in the corner. A click on
// the image opens it full size. The button waits for the image, so a chat of
// loading images does not show buttons with no image under them. It also comes
// when the browser cannot draw the file, as the only way to get it.
export function ImageCard({
  src,
  name,
  isMobile,
  onOpen,
}: {
  src: string;
  name: string;
  isMobile?: boolean;
  onOpen: () => void;
}) {
  const [settled, setSettled] = useState(false);
  return (
    <div style={{ position: "relative", maxWidth: "100%" }}>
      <img
        src={src}
        alt={name}
        onClick={onOpen}
        onLoad={() => setSettled(true)}
        onError={() => setSettled(true)}
        style={{
          display: "block",
          maxWidth: isMobile ? "100%" : 300,
          maxHeight: 200,
          borderRadius: 4,
          cursor: "pointer",
          border: "1px solid var(--green-border)",
        }}
      />
      {settled && (
        <DownloadButton src={src} name={name} isMobile={isMobile} overlay />
      )}
    </div>
  );
}

// The lightbox for image links and images in chat text (linked-image.ts):
// one per page, from a capture-phase click listener on the document.
// Capture phase: a view on the way up that stops clicks from bubbling must
// not let the link open as a page.
export function LinkedImageLightbox() {
  const { isMobile } = useAppState();
  const [image, setImage] = useState<LightboxImage | null>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const next = lightboxForClick(e);
      if (!next) return;
      e.preventDefault();
      setImage(next);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  const close = useCallback(() => setImage(null), []);
  return image ? (
    <ImageLightbox image={image} isMobile={isMobile} onClose={close} />
  ) : null;
}

// Full-size view of a chat image. It renders in a portal on document.body:
// inside a side panel's stacking context, the office top bar painted over it.
// The page forbids pinch zoom (ui/index.html; the office view pinches on its
// own), so the lightbox zooms its own image (the math is in image-zoom.ts): a
// click shows a large image at full size, a double-tap or a pinch zooms on
// touch, a drag or a finger pans, and ctrl+wheel (a trackpad pinch) zooms. A
// click on the backdrop, the close button or Escape closes it, and so does a
// click or a single tap on an image that has no zoom to show.
export function ImageLightbox({
  image,
  isMobile,
  onClose,
}: {
  image: LightboxImage;
  isMobile?: boolean;
  onClose: () => void;
}) {
  // Escape closes the lightbox and not the page under it (escape-layer.ts).
  // One claim while open: a new onClose does not move it in the stack.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => claimEscape(() => closeRef.current()), []);

  return (
    <Portal>
      <LightboxContent image={image} isMobile={isMobile} onClose={onClose} />
    </Portal>
  );
}

// Two taps closer than this in time and space are a double-tap; a single tap
// at fit closes the lightbox once the window has passed.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 25;
// A touch that moves farther is a pan, not a tap; a mouse press that moves
// farther is a drag, not a click.
const TAP_MOVE_PX = 10;
const DRAG_PX = 4;
// A click this soon after a touch is the browser's copy of a tap.
const TOUCH_CLICK_MS = 500;

function LightboxContent({
  image,
  isMobile,
  onClose,
}: {
  image: LightboxImage;
  isMobile?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // One source for the box: the window, in px (CSS vh on iOS is the large
  // viewport, not innerHeight).
  const [box, setBox] = useState(() =>
    lightboxBox(window.innerWidth, window.innerHeight),
  );
  // Unknown until the image loads: until then there is no zoom.
  const [natural, setNatural] = useState<Size | null>(null);
  const [scale, setScale] = useState(1);
  // A mouse drag that moved: the cursor grabs.
  const [dragging, setDragging] = useState(false);
  // The scroll of the next zoom, set once the viewport has its new size.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  // A click closes on the backdrop only when the press started there: a drag
  // from the image that ends on the backdrop clicks the backdrop too.
  const pressOnBackdrop = useRef(false);
  const fit = natural ? fitSize(natural, box) : null;
  const live = useRef({ box, natural, fit, scale, onClose });
  useLayoutEffect(() => {
    live.current = { box, natural, fit, scale, onClose };
  });

  // Only when the size changes: every such render comes from a zoom or a
  // resize, which set the scroll first. A pending scroll whose zoom did not
  // render must not move the image on a later render from above.
  useLayoutEffect(() => {
    const p = pendingScroll.current;
    const el = viewportRef.current;
    if (!p || !el) return;
    el.scrollLeft = p.left;
    el.scrollTop = p.top;
    pendingScroll.current = null;
  }, [scale, box]);

  // A cached image can be complete before onLoad is bound.
  const readNatural = useCallback(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0)
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);
  useLayoutEffect(readNatural, [readNatural]);

  useEffect(() => {
    function onResize() {
      setBox(lightboxBox(window.innerWidth, window.innerHeight));
      setScale(1);
      pendingScroll.current = { left: 0, top: 0 };
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The gestures, as native listeners: React's touchmove and wheel listeners
  // are passive and cannot keep a pinch from the browser.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const viewport = el;

    function current(): ZoomView {
      return {
        scale: live.current.scale,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      };
    }
    // An offset from the viewport's center, which stays put while it zooms.
    function offset(clientX: number, clientY: number) {
      const r = viewport.getBoundingClientRect();
      return {
        x: clientX - (r.left + r.width / 2),
        y: clientY - (r.top + r.height / 2),
      };
    }
    function apply(v: ZoomView) {
      live.current.scale = v.scale;
      pendingScroll.current = { left: v.scrollLeft, top: v.scrollTop };
      // Also now: a scale that does not change renders nothing.
      viewport.scrollLeft = v.scrollLeft;
      viewport.scrollTop = v.scrollTop;
      setScale(v.scale);
    }
    function zoomTo(next: number, clientX: number, clientY: number) {
      const { natural, fit, box } = live.current;
      if (!natural || !fit) return;
      const max = maxScale(natural, fit);
      apply(zoomAt(current(), next, offset(clientX, clientY), fit, box, max));
    }

    let tapStart: { x: number; y: number; moved: boolean } | null = null;
    let lastTap: { x: number; y: number; at: number } | null = null;
    let multiTouch = false;
    let pinch: {
      view: ZoomView;
      dist: number;
      mid: { x: number; y: number };
      focal: { x: number; y: number };
    } | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTouchEnd = -Infinity;
    let drag: {
      x: number;
      y: number;
      left: number;
      top: number;
      moved: boolean;
    } | null = null;
    let dragged = false;

    function fingers(e: TouchEvent) {
      const [a, b] = [e.touches[0], e.touches[1]];
      return {
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      };
    }

    function onTouchStart(e: TouchEvent) {
      // A new touch decides for itself: the close of an earlier single tap
      // waits for its end.
      clearTimeout(closeTimer);
      if (e.touches.length >= 2) {
        multiTouch = true;
        tapStart = null;
        lastTap = null;
        const { dist, mid } = fingers(e);
        pinch = { view: current(), dist, mid, focal: offset(mid.x, mid.y) };
      } else if (e.touches.length === 1) {
        multiTouch = false;
        const p = e.touches[0];
        tapStart = { x: p.clientX, y: p.clientY, moved: false };
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (pinch && e.touches.length >= 2) {
        e.preventDefault();
        const { natural, fit, box } = live.current;
        if (!natural || !fit || pinch.dist === 0) return;
        const { dist, mid } = fingers(e);
        const zoomed = zoomAt(
          pinch.view,
          (pinch.view.scale * dist) / pinch.dist,
          pinch.focal,
          fit,
          box,
          maxScale(natural, fit),
        );
        // The image also follows the fingers' midpoint.
        apply(
          clampScroll(
            {
              ...zoomed,
              scrollLeft: zoomed.scrollLeft - (mid.x - pinch.mid.x),
              scrollTop: zoomed.scrollTop - (mid.y - pinch.mid.y),
            },
            fit,
            box,
          ),
        );
        return;
      }
      if (tapStart && e.touches.length === 1) {
        const p = e.touches[0];
        if (
          Math.hypot(p.clientX - tapStart.x, p.clientY - tapStart.y) >
          TAP_MOVE_PX
        )
          tapStart.moved = true;
      }
    }

    function onTouchEnd(e: TouchEvent) {
      lastTouchEnd = Date.now();
      if (e.touches.length >= 2) return;
      pinch = null;
      if (e.touches.length > 0) return;
      if (multiTouch) {
        multiTouch = false;
        e.preventDefault();
        return;
      }
      const start = tapStart;
      tapStart = null;
      if (!start || start.moved) return;
      // One action per tap: no click from the browser after it.
      e.preventDefault();
      const p = e.changedTouches[0];
      const at = Date.now();
      if (
        lastTap &&
        at - lastTap.at < DOUBLE_TAP_MS &&
        Math.hypot(p.clientX - lastTap.x, p.clientY - lastTap.y) < DOUBLE_TAP_PX
      ) {
        clearTimeout(closeTimer);
        lastTap = null;
        const { natural, fit, scale } = live.current;
        if (natural && fit)
          zoomTo(doubleTapScale(scale, natural, fit), p.clientX, p.clientY);
        return;
      }
      lastTap = { x: p.clientX, y: p.clientY, at };
      if (live.current.scale > 1) return;
      closeTimer = setTimeout(() => live.current.onClose(), DOUBLE_TAP_MS);
    }

    // The system took the touch (iOS): it is no tap and no pinch.
    function onTouchCancel() {
      tapStart = null;
      pinch = null;
      multiTouch = false;
    }

    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0 || Date.now() - lastTouchEnd < TOUCH_CLICK_MS) return;
      drag = {
        x: e.clientX,
        y: e.clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
        moved: false,
      };
      dragged = false;
    }
    function onMouseMove(e: MouseEvent) {
      if (!drag || !(e.buttons & 1)) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > DRAG_PX) {
        drag.moved = true;
        setDragging(true);
      }
      if (!drag.moved) return;
      viewport.scrollLeft = drag.left - dx;
      viewport.scrollTop = drag.top - dy;
    }
    function onMouseUp() {
      if (!drag) return;
      dragged = drag.moved;
      drag = null;
      setDragging(false);
    }
    function onClick(e: MouseEvent) {
      if (Date.now() - lastTouchEnd < TOUCH_CLICK_MS) return;
      if (dragged) {
        dragged = false;
        return;
      }
      const { natural, fit, scale } = live.current;
      if (!natural || !fit || fullScale(natural, fit) <= 1) {
        live.current.onClose();
        return;
      }
      zoomTo(clickScale(scale, natural, fit), e.clientX, e.clientY);
    }
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(
        live.current.scale * Math.exp(-e.deltaY / 200),
        e.clientX,
        e.clientY,
      );
    }
    // iOS Safari in a tab ignores user-scalable=no and zooms the page.
    function onGesture(e: Event) {
      e.preventDefault();
    }

    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: false });
    viewport.addEventListener("touchend", onTouchEnd, { passive: false });
    viewport.addEventListener("touchcancel", onTouchCancel);
    viewport.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    viewport.addEventListener("click", onClick);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("gesturestart", onGesture);
    viewport.addEventListener("gesturechange", onGesture);
    return () => {
      clearTimeout(closeTimer);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("touchend", onTouchEnd);
      viewport.removeEventListener("touchcancel", onTouchCancel);
      viewport.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      viewport.removeEventListener("click", onClick);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("gesturestart", onGesture);
      viewport.removeEventListener("gesturechange", onGesture);
    };
  }, []);

  const markPress = (e: {
    target: EventTarget;
    currentTarget: EventTarget;
  }) => {
    pressOnBackdrop.current = e.target === e.currentTarget;
  };
  const vp = fit ? viewportSize(fit, scale, box) : null;
  const zooms = !!natural && !!fit && fullScale(natural, fit) > 1;

  return (
    <div
      onPointerDown={markPress}
      onMouseDown={markPress}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressOnBackdrop.current) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        cursor: "zoom-out",
      }}
    >
      <button
        type="button"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 0px) + 12px)",
          right: "calc(env(safe-area-inset-right, 0px) + 12px)",
          width: 40,
          height: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          border: "none",
          borderRadius: 20,
          background: "rgba(255,255,255,0.15)",
          color: "#fff",
          cursor: "pointer",
        }}
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </svg>
      </button>
      <div
        ref={viewportRef}
        style={{
          flexShrink: 0,
          ...(vp && { width: vp.w, height: vp.h }),
          overflow: scale > 1 ? "auto" : "hidden",
          // One finger scrolls natively; a pinch or a double-tap is ours.
          touchAction: "pan-x pan-y",
          overscrollBehavior: "contain",
          borderRadius: 8,
        }}
      >
        <img
          ref={imgRef}
          src={image.src}
          alt={t("cards.fileView.fullSize")}
          draggable={false}
          onLoad={readNatural}
          style={{
            display: "block",
            userSelect: "none",
            cursor: dragging
              ? "grabbing"
              : zooms
                ? scale > 1
                  ? "zoom-out"
                  : "zoom-in"
                : "zoom-out",
            ...(fit
              ? {
                  width: fit.w * scale,
                  height: fit.h * scale,
                  maxWidth: "none",
                }
              : { maxWidth: box.w, maxHeight: box.h }),
          }}
        />
      </div>
      <DownloadButton
        src={image.src}
        name={image.name}
        isMobile={isMobile}
        style={{
          width: 40,
          height: 40,
          background: "rgba(255,255,255,0.15)",
        }}
      />
    </div>
  );
}
