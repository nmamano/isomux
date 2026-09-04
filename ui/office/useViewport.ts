import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
} from "react";
import { SCENE_W, SCENE_H, VB_X, VB_Y } from "./grid.ts";
export interface ViewportState {
  x: number;
  y: number;
  scale: number;
}

/** All numeric knobs for the viewport. Grouped so they're easy to find and tune. */
const VIEWPORT = {
  MIN_SCALE: 0.5,
  MAX_SCALE: 2.5,
  /** Epsilon above 1.0 used to decide "zoomed in". Avoids floating-point drift from wheel scrolls just above rest. */
  ZOOM_EPSILON: 1.01,
  /** Pixels of pointer movement before a mousedown becomes a pan. */
  PAN_THRESHOLD: 5,
  /** Scale factor applied per wheel-pixel delta. */
  WHEEL_ZOOM_SPEED: 0.001,
  /** Zoom multiplier for +/- button or keyboard shortcuts. */
  ZOOM_STEP: 1.25,
  /** Fraction of the container that must remain occupied by the scene at the edge. */
  PAN_MARGIN: 0.25,
  /** Container-pixel gap left around the scene when the rest view has to move it into view. */
  FIT_MARGIN: 12,
  RESET_TRANSITION: "transform 0.25s ease-out",
  RESET_CLEAR_MS: 300,
} as const;

/**
 * Painted extents of the static scene in SVG user units, read off Floor.tsx:
 * the wall end caps and the floor slab's outer corners span x -364..604, the
 * wall ridge apex sits at y -209, and the front floor slab ends at y 529
 * (515 + SLAB_H). Both SVGs render with `overflow="visible"`, so the artwork
 * bleeds outside the SCENE_W x SCENE_H box it is laid out in - 109px above it
 * in particular, which is what a short container clips first. Measured in
 * Chrome 2026-09-04; grid.ts documents the same x span.
 */
const ART_SVG = { x0: -364, y0: -209, x1: 604, y1: 529 } as const;

/**
 * The same box as fractions of the scene's layout box, so it survives the
 * static centering transform's scale (mobileScale, embed) without the hook
 * having to know about it.
 */
const ART_BOX = {
  left: (ART_SVG.x0 - VB_X) / SCENE_W,
  top: (ART_SVG.y0 - VB_Y) / SCENE_H,
  right: (ART_SVG.x1 - VB_X) / SCENE_W,
  bottom: (ART_SVG.y1 - VB_Y) / SCENE_H,
} as const;

/**
 * Which axes may drive the rest scale down. "height" keeps the authored
 * sideways bleed on every screen; "both" also guarantees the left and right
 * wall ends are on screen in a narrow window, at the cost of a smaller scene
 * there. Width is never a constraint on mobile either way - the mobile static
 * scale crops 200px of width on purpose.
 */
const FIT_AXES: "height" | "both" = "height";

const DEFAULT_STATE: ViewportState = { x: 0, y: 0, scale: 1 };

// Module-scoped so the user's zoom/pan survives OfficeView unmounts (entering
// a chat, tasks, cronjobs, mobile list). The hook's design treats viewport as
// global across rooms - module scope extends that to "global across views"
// without round-tripping through React state. Mutated in place via state.current.
const persistedState: ViewportState = { ...DEFAULT_STATE };

// The rest view the scene was last fitted to, module-scoped for the same reason
// persistedState is: a remount must be able to tell "the user has not touched
// the view" from "the user panned or zoomed". Starts equal to DEFAULT_STATE, so
// the very first mount counts as untouched and fits.
const restView: ViewportState = { ...DEFAULT_STATE };

// Pan should start from any non-interactive surface in the scene. Every clickable
// target in the scene - including native HTML5 drag sources like DeskUnit - opts
// out via `data-no-pan`, so we don't need a separate [draggable] rule here.
const PAN_BLOCKER_SELECTOR =
  "[data-no-pan], button, a, input, textarea, select";
// Touch-only blocker: excludes [data-no-pan]. The big 180×160 desk/slot
// hit-rects blanket the visible floor - treating them as pan blockers would make
// one-finger pan fail almost everywhere when zoomed in. Tap-vs-drag stays safe
// because: (a) DeskUnit preventDefaults touchstart and dispatches its own
// clicks from touchend, so browser-synthesized clicks on a desk aren't the
// trigger path; (b) EmptySlot and other data-no-pan click targets rely on
// synthesized clicks, and wrapClick + didPan gate those on idle gestures.
const TOUCH_PAN_BLOCKER_SELECTOR = "button, a, input, textarea, select";

function clampScale(scale: number) {
  return Math.max(VIEWPORT.MIN_SCALE, Math.min(VIEWPORT.MAX_SCALE, scale));
}

/** An axis-aligned box in viewport-layer-local coords (pre-zoom). */
export interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * One axis of the rest view: where to translate so the painted scene reads well
 * in a container of `size` at `scale`.
 *
 * `start` is the translation that scales the authored framing about the
 * container centre - at scale 1 it is 0, i.e. exactly what the scene did before
 * this function existed. We keep it whenever nothing is clipped, so a container
 * that already shows the whole scene is left alone to the pixel. Only when an
 * edge falls outside do we move, and then by the least amount that brings the
 * scene back inside with FIT_MARGIN to spare. The last branch runs in two
 * cases. At the exact fit scale min and max are analytically equal, so float
 * rounding decides the side - harmless, because both branches return the same
 * number there. It is load-bearing once the fit scale bottoms out at MIN_SCALE
 * and the scene genuinely cannot fit: then it centres the overflow, so the
 * scene is cropped evenly rather than all on one side.
 */
function fitAxis(size: number, scale: number, lo: number, hi: number) {
  const start = ((1 - scale) * size) / 2;
  if (scale * lo + start >= 0 && scale * hi + start <= size) {
    return start;
  }
  const min = VIEWPORT.FIT_MARGIN - scale * lo;
  const max = size - VIEWPORT.FIT_MARGIN - scale * hi;
  if (min > max) {
    return (size - scale * (hi - lo)) / 2 - scale * lo;
  }
  return Math.max(min, Math.min(max, start));
}

/**
 * The view "reset view" goes to: the authored framing when the whole painted
 * scene fits, and otherwise the largest scale (never above 1) that does fit,
 * positioned by fitAxis.
 *
 * `art` is the painted scene box, not the layout box - the scene bleeds 109px
 * above its layout box, which is why centring the layout box clipped the wall
 * clock on a wide-and-short monitor.
 *
 * `fitWidth` decides whether width may drive the scale. The scene is authored
 * to bleed sideways (mobileScale deliberately crops 200px of width so desks
 * stay tappable), so height alone is the default constraint; see FIT_AXES.
 */
export function computeRestView(
  cw: number,
  ch: number,
  art: Bounds,
  fitWidth: boolean,
): ViewportState {
  const aw = art.right - art.left;
  const ah = art.bottom - art.top;
  if (!(cw > 0 && ch > 0 && aw > 0 && ah > 0)) {
    return { ...DEFAULT_STATE };
  }
  const byHeight = (ch - 2 * VIEWPORT.FIT_MARGIN) / ah;
  const byWidth = fitWidth
    ? (cw - 2 * VIEWPORT.FIT_MARGIN) / aw
    : Number.POSITIVE_INFINITY;
  const scale = clampScale(Math.min(1, byHeight, byWidth));
  return {
    scale,
    x: fitAxis(cw, scale, art.left, art.right),
    y: fitAxis(ch, scale, art.top, art.bottom),
  };
}

/** The painted scene box, derived from the measured layout box. */
export function artBounds(b: Bounds): Bounds {
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  return {
    left: b.left + ART_BOX.left * w,
    right: b.left + ART_BOX.right * w,
    top: b.top + ART_BOX.top * h,
    bottom: b.top + ART_BOX.bottom * h,
  };
}

/**
 * Explicit gesture state machine. Transitions:
 *   idle     → panning   (mouse/pen pointerdown OR single-finger touchstart
 *                         when zoomed in, both on a pannable target)
 *   panning  → idle      (pointerup | pointercancel | touchend | touchcancel)
 *   panning  → pinching  (second finger arrives; releases any captured pointer
 *                         so the remaining single touch after the pinch ends
 *                         doesn't reactivate a stale anchor)
 *   idle     → pinching  (two fingers land simultaneously)
 *   pinching → idle      (fingers drop below two | touchcancel)
 *
 * `source` distinguishes pan drivers: "pointer" pans are authoritatively owned
 * by a specific pointerId and use pointer capture; "touch" pans are driven by
 * TouchEvents (iOS Safari's pointer-event path is unreliable for sustained
 * single-finger drag - pointercancel fires even with touch-action: none, and
 * setPointerCapture on a touch pointer can drop pointermove deliveries).
 *
 * `panning.committed` distinguishes a pending tap (within the click threshold)
 * from an actual drag - uncommitted panning never mutates the viewport.
 */
type Gesture =
  | { kind: "idle" }
  | {
      kind: "panning";
      source: "pointer" | "touch";
      pointerId: number; // unused when source === "touch"
      committed: boolean;
      startX: number;
      startY: number;
      initialSX: number;
      initialSY: number;
    }
  | {
      kind: "pinching";
      startDist: number;
      initial: ViewportState;
      initialMidX: number;
      initialMidY: number;
    };

/**
 * Hook that manages zoom/pan for the office scene. Attaches wheel, pointer,
 * and touch listeners to the container, and mutates the scene transform
 * directly to avoid React re-renders during gestures.
 *
 * View state is global (one viewport for all rooms). Rooms share an
 * identical isometric layout, so a zoom/pan set in one is the right one in
 * any other - preserving it across room switches matches user intent more
 * often than resetting would.
 *
 * `layoutKey` should change whenever the centered scene's static transform
 * changes (e.g. embed/isMobile/mobileScale flip) so the pan-clamp boundaries
 * re-measure. ResizeObserver only fires on container size changes and won't
 * notice transform-only updates.
 *
 * When `enabled` is false, gesture listeners are not attached (wheel, pointer,
 * touch, pinch all become no-ops) - used to disable zoom in embed mode where
 * the UI chrome and keyboard shortcuts are already hidden.
 *
 * Returns callback refs (`setContainer`, `setScene`, `setContent`) instead of
 * RefObjects - attach them via `ref={...}` on the corresponding elements.
 */
export function useViewport(layoutKey: string, enabled: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  /** The scene-content element inside the zoom/pan layer - measured for pan-clamp bounds. */
  const contentRef = useRef<HTMLDivElement | null>(null);
  // State mirror of containerRef so the listener-attachment effect re-runs when
  // the container node is (re)attached. Scene/content are only read from
  // handlers, so refs alone suffice for those.
  const [container, setContainerState] = useState<HTMLDivElement | null>(null);

  const setContainer = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainerState(node);
  }, []);
  const setScene = useCallback((node: HTMLDivElement | null) => {
    sceneRef.current = node;
  }, []);
  const setContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
  }, []);

  const state = useRef<ViewportState>(persistedState);
  const gesture = useRef<Gesture>({ kind: "idle" });
  /** Scene content bounds in viewport-layer-local coords (pre-zoom). Null until measured. */
  const sceneBounds = useRef<Bounds | null>(null);
  /** True if the most recent pointer gesture became a pan - used to suppress click-to-focus */
  const didPan = useRef(false);
  const resetClearTimer = useRef<number | null>(null);
  const restoreUserSelect = useRef<string | null>(null);

  function clearResetTransition() {
    const scene = sceneRef.current;
    if (scene && scene.style.transition) {
      scene.style.transition = "";
    }
    if (resetClearTimer.current !== null) {
      clearTimeout(resetClearTimer.current);
      resetClearTimer.current = null;
    }
  }

  /** Abandon any in-flight gesture: release pointer capture, restore cursor and
   *  body userSelect, clear didPan, and return the state machine to idle. Called
   *  when listeners detach (enabled toggle / unmount). */
  function abortAllGestures() {
    const g = gesture.current;
    if (g.kind === "panning" && g.source === "pointer") {
      const c = containerRef.current;
      if (c) {
        if (c.hasPointerCapture(g.pointerId)) {
          c.releasePointerCapture(g.pointerId);
        }
        c.style.cursor = "";
      }
    }
    if (restoreUserSelect.current !== null) {
      document.body.style.userSelect = restoreUserSelect.current;
      restoreUserSelect.current = null;
    }
    didPan.current = false;
    gesture.current = { kind: "idle" };
  }

  function applyTransform(animate = false) {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    const { x, y, scale } = state.current;
    // Only touch scene.style.transition if one is currently set - otherwise
    // every pointermove would write a no-op. Reading the live style is the
    // source of truth; the reset timer is its companion (set together, cleared
    // together).
    clearResetTransition();
    if (animate) {
      scene.style.transition = VIEWPORT.RESET_TRANSITION;
      resetClearTimer.current = window.setTimeout(() => {
        scene.style.transition = "";
        resetClearTimer.current = null;
      }, VIEWPORT.RESET_CLEAR_MS);
    }
    scene.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  /**
   * Measure the scene content's bounding box in viewport-layer-local coords
   * (pre-zoom), by inverting the currently-rendered transform. Caller must
   * ensure state.current matches the last rendered transform - i.e. call
   * after applyTransform, not between a state mutation and its apply.
   */
  function measureSceneBounds() {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) {
      sceneBounds.current = null;
      return;
    }
    const crect = container.getBoundingClientRect();
    const rect = content.getBoundingClientRect();
    if (
      crect.width === 0 ||
      crect.height === 0 ||
      rect.width === 0 ||
      rect.height === 0
    ) {
      // Hidden containers/content report zero rects; keep bounds unset so clampPan
      // becomes a no-op until a visible re-measure arrives.
      sceneBounds.current = null;
      return;
    }
    const { x, y, scale } = state.current;
    sceneBounds.current = {
      left: (rect.left - crect.left - x) / scale,
      right: (rect.right - crect.left - x) / scale,
      top: (rect.top - crect.top - y) / scale,
      bottom: (rect.bottom - crect.top - y) / scale,
    };
  }

  function clampPan() {
    const container = containerRef.current;
    const b = sceneBounds.current;
    if (!container || !b) {
      return;
    }
    const { scale } = state.current;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    // Keep PAN_MARGIN of the container spanned by the scene at each edge.
    const maxX = (1 - VIEWPORT.PAN_MARGIN) * cw - scale * b.left;
    const minX = VIEWPORT.PAN_MARGIN * cw - scale * b.right;
    const maxY = (1 - VIEWPORT.PAN_MARGIN) * ch - scale * b.top;
    const minY = VIEWPORT.PAN_MARGIN * ch - scale * b.bottom;
    state.current.x = Math.max(minX, Math.min(maxX, state.current.x));
    state.current.y = Math.max(minY, Math.min(maxY, state.current.y));
  }

  /**
   * True while the view is still the one the last fit produced - i.e. the user
   * has neither panned nor zoomed since. Only then may a resize or a layout
   * change re-fit under them.
   */
  function isAtRest() {
    const s = state.current;
    return (
      Math.abs(s.scale - restView.scale) < 1e-3 &&
      Math.abs(s.x - restView.x) < 0.5 &&
      Math.abs(s.y - restView.y) < 0.5
    );
  }

  /**
   * Move the view to the fitted rest position and record it as the new rest.
   * A no-op while the bounds are unmeasured (hidden container): there is no
   * fit to compute, and snapping to the unfitted default would undo a good
   * one. The next visible measure re-fits.
   */
  function applyRest(animate: boolean) {
    const container = containerRef.current;
    const b = sceneBounds.current;
    if (!container || !b) {
      return;
    }
    const target = computeRestView(
      container.clientWidth,
      container.clientHeight,
      artBounds(b),
      FIT_AXES === "both",
    );
    restView.x = target.x;
    restView.y = target.y;
    restView.scale = target.scale;
    // Mutate in place so the module-scoped persistedState stays the single
    // source of truth across mounts. Reassigning state.current to a fresh
    // object would orphan persistedState at its last value.
    state.current.x = target.x;
    state.current.y = target.y;
    state.current.scale = target.scale;
    applyTransform(animate);
  }

  function zoomAt(cx: number, cy: number, newScale: number) {
    const s = state.current;
    const clamped = clampScale(newScale);
    const ratio = clamped / s.scale;
    s.x = cx - ratio * (cx - s.x);
    s.y = cy - ratio * (cy - s.y);
    s.scale = clamped;
    clampPan();
    applyTransform();
  }

  // The callbacks below are `useCallback(..., [])` because every value they
  // reach - state, gesture, refs, and the in-body helpers (applyTransform,
  // zoomAt, measureSceneBounds, clampPan) - is stored in a ref or
  // reads through one. No render-scoped variable is closed over. If you add
  // a line here that captures component state or props, switch to refs or
  // add the dep; otherwise the callback will silently use stale values.
  // sceneBounds are layer-local (measureSceneBounds inverts the live transform),
  // so they're invariant under state changes - no need to re-measure after
  // resetting. The rest view is inside the pan clamp by construction, so
  // applyRest does not need a clampPan after it.
  const resetView = useCallback((animate = true) => {
    applyRest(animate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomIn = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    zoomAt(
      rect.width / 2,
      rect.height / 2,
      state.current.scale * VIEWPORT.ZOOM_STEP,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomOut = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    zoomAt(
      rect.width / 2,
      rect.height / 2,
      state.current.scale / VIEWPORT.ZOOM_STEP,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** True when the user has zoomed in past the rest scale - used to route one-finger drags
   *  to pan instead of swipe on touch (iOS-gallery pattern). The rest scale is
   *  the fitted one, which is below 1 on a container too short for the scene,
   *  so the comparison has to be relative or a short screen would never hand
   *  one-finger drags to pan. */
  const isZoomedIn = useCallback(
    () => state.current.scale > restView.scale * VIEWPORT.ZOOM_EPSILON,
    [],
  );

  /** Wrap a click handler so it's suppressed when the click was actually a drag-pan. */
  const wrapClick = useCallback(
    <A extends unknown[]>(cb: (...args: A) => void) => {
      return (...args: A) => {
        if (!didPan.current) {
          cb(...args);
        }
      };
    },
    [],
  );

  // Re-measure scene bounds when the centered scene's static transform
  // changes (embed/isMobile/mobileScale). ResizeObserver only catches
  // container size changes, not transform-only updates to inner content.
  // useLayoutEffect (not useEffect) so a remount with persisted non-default
  // state paints once at the saved transform - avoids the default→saved
  // flash when going back to office view from chat/tasks/list.
  useLayoutEffect(() => {
    measureSceneBounds();
    if (enabled && isAtRest()) {
      // Untouched view: re-fit, so the first paint and any later layout change
      // frame the whole scene. Embed keeps its authored framing (enabled is
      // false there) and a view the user has moved is left where they put it.
      applyRest(false);
      return;
    }
    clampPan();
    applyTransform();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, enabled]);

  // This effect's deps are `[container, enabled]`. The DOM handlers registered
  // below close over in-body helpers (applyTransform, zoomAt, clampPan, save,
  // measureSceneBounds). Those helpers are recreated on every render, but the
  // handlers captured here reference the version from the render when the
  // effect last ran - which is fine ONLY because every helper reaches state
  // through refs and closes over no render-scoped values. If you add a line
  // to any helper that captures props or useState values, either add the dep
  // here (and accept listener churn) or route the new value through a ref.
  useEffect(() => {
    if (!container || !enabled) {
      return;
    }
    const resetGesture = () => {
      gesture.current = { kind: "idle" };
    };
    const startPan = (
      source: "pointer" | "touch",
      clientX: number,
      clientY: number,
      pointerId = -1,
    ) => {
      gesture.current = {
        kind: "panning",
        source,
        pointerId,
        committed: false,
        startX: clientX,
        startY: clientY,
        initialSX: state.current.x,
        initialSY: state.current.y,
      };
    };

    function isPanBlocker(target: HTMLElement) {
      return !!target.closest(PAN_BLOCKER_SELECTOR);
    }

    function isTouchPanBlocker(target: HTMLElement) {
      return !!target.closest(TOUCH_PAN_BLOCKER_SELECTOR);
    }

    function releasePan(pointerId: number) {
      if (container!.hasPointerCapture(pointerId)) {
        container!.releasePointerCapture(pointerId);
      }
      container!.style.cursor = "";
      if (restoreUserSelect.current !== null) {
        document.body.style.userSelect = restoreUserSelect.current;
        restoreUserSelect.current = null;
      }
    }

    function enterPinch(t1: Touch, t2: Touch) {
      if (
        gesture.current.kind === "panning" &&
        gesture.current.source === "pointer"
      ) {
        // Release the primary pointer's capture so lifting back to a single
        // touch after the pinch doesn't reactivate the old pan anchor.
        // Touch-driven pans don't use pointer capture - nothing to release.
        releasePan(gesture.current.pointerId);
      }
      const rect = container!.getBoundingClientRect();
      gesture.current = {
        kind: "pinching",
        startDist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
        initial: { ...state.current },
        initialMidX: (t1.clientX + t2.clientX) / 2 - rect.left,
        initialMidY: (t1.clientY + t2.clientY) / 2 - rect.top,
      };
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = container!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Normalize deltaY to pixels so Firefox line-mode and page-mode wheels zoom at the same rate as pixel-mode.
      const lineHeight = 16;
      const unit =
        e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? rect.height : 1;
      const delta = -e.deltaY * unit * VIEWPORT.WHEEL_ZOOM_SPEED;
      zoomAt(cx, cy, state.current.scale * (1 + delta));
    }

    function handlePointerDown(e: PointerEvent) {
      // Touch-driven pan is handled in handleTouchStart (TouchEvents are more
      // reliable than pointer events on iOS for sustained single-finger pan).
      // Reset didPan only for non-touch pointers here - touch resets happen in
      // handleTouchStart on a fresh single-finger tap.
      if (e.pointerType === "touch") {
        return;
      }
      didPan.current = false;
      if (e.button !== 0) {
        return;
      }
      if (gesture.current.kind === "pinching") {
        return;
      }
      if (isPanBlocker(e.target as HTMLElement)) {
        return;
      }
      e.preventDefault();
      startPan("pointer", e.clientX, e.clientY, e.pointerId);
      container!.setPointerCapture(e.pointerId);
      if (restoreUserSelect.current === null) {
        restoreUserSelect.current = document.body.style.userSelect;
        document.body.style.userSelect = "none";
      }
    }

    function handlePointerMove(e: PointerEvent) {
      const g = gesture.current;
      if (
        g.kind !== "panning" ||
        g.source !== "pointer" ||
        g.pointerId !== e.pointerId
      ) {
        return;
      }
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      e.preventDefault();
      if (!g.committed) {
        if (
          Math.abs(dx) < VIEWPORT.PAN_THRESHOLD &&
          Math.abs(dy) < VIEWPORT.PAN_THRESHOLD
        ) {
          return;
        }
        g.committed = true;
        didPan.current = true;
        container!.style.cursor = "grabbing";
      }
      state.current.x = g.initialSX + dx;
      state.current.y = g.initialSY + dy;
      clampPan();
      applyTransform();
    }

    function handlePointerUp(e: PointerEvent) {
      const g = gesture.current;
      if (
        g.kind !== "panning" ||
        g.source !== "pointer" ||
        g.pointerId !== e.pointerId
      ) {
        return;
      }
      releasePan(e.pointerId);
      // Safe to clear here: pointer capture retargets the synthesized click to
      // the container, not to any wrapClick'd descendant, so no stale-didPan
      // window exists for mouse pans. Reset anyway to make the invariant
      // (didPan is true only between commit and end-of-gesture) explicit.
      didPan.current = false;
      resetGesture();
    }

    function handlePointerCancel(e: PointerEvent) {
      const g = gesture.current;
      if (
        g.kind !== "panning" ||
        g.source !== "pointer" ||
        g.pointerId !== e.pointerId
      ) {
        return;
      }
      handlePointerUp(e);
    }

    function handleNativeDragStart(e: DragEvent) {
      if (
        gesture.current.kind === "panning" &&
        gesture.current.source === "pointer"
      ) {
        e.preventDefault();
      }
    }

    function handleSelectStart(e: Event) {
      if (
        gesture.current.kind === "panning" &&
        gesture.current.source === "pointer"
      ) {
        e.preventDefault();
      }
    }

    function handleTouchStart(e: TouchEvent) {
      if (e.touches.length >= 2) {
        enterPinch(e.touches[0], e.touches[1]);
        return;
      }
      if (e.touches.length !== 1 || gesture.current.kind !== "idle") {
        return;
      }
      // DeskUnit's touch handler preventDefaults, which suppresses the
      // synthesized pointerdown - reset didPan on a fresh tap so a post-pan
      // tap on a desk isn't swallowed by the pan's lingering flag.
      didPan.current = false;
      // One-finger touches at rest scale belong to the swipe-to-change-room
      // hook (iOS-gallery pattern). Once zoomed in, the user needs one-finger
      // pan to look around, so we take the gesture back.
      if (state.current.scale <= VIEWPORT.ZOOM_EPSILON) {
        return;
      }
      const t = e.touches[0];
      const tgt = t.target as HTMLElement | null;
      if (tgt && isTouchPanBlocker(tgt)) {
        return;
      }
      startPan("touch", t.clientX, t.clientY);
    }

    function handleTouchMove(e: TouchEvent) {
      const g = gesture.current;
      if (g.kind === "pinching" && e.touches.length >= 2) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(
          t2.clientX - t1.clientX,
          t2.clientY - t1.clientY,
        );
        const rect = container!.getBoundingClientRect();
        const newMidX = (t1.clientX + t2.clientX) / 2 - rect.left;
        const newMidY = (t1.clientY + t2.clientY) / 2 - rect.top;

        const newScale = g.initial.scale * (dist / g.startDist);
        const clamped = clampScale(newScale);
        const scaleRatio = clamped / g.initial.scale;

        // Zoom anchored at the current midpoint, pinning the scene point that
        // sat under the midpoint when the pinch began:
        //   new.x = newMid - r * (initialMid - initial.x)
        state.current.x = newMidX - scaleRatio * (g.initialMidX - g.initial.x);
        state.current.y = newMidY - scaleRatio * (g.initialMidY - g.initial.y);
        state.current.scale = clamped;
        clampPan();
        applyTransform();
        return;
      }
      if (
        g.kind === "panning" &&
        g.source === "touch" &&
        e.touches.length === 1
      ) {
        const t = e.touches[0];
        const dx = t.clientX - g.startX;
        const dy = t.clientY - g.startY;
        if (!g.committed) {
          if (
            Math.abs(dx) < VIEWPORT.PAN_THRESHOLD &&
            Math.abs(dy) < VIEWPORT.PAN_THRESHOLD
          ) {
            return;
          }
          g.committed = true;
          didPan.current = true;
        }
        // Only preventDefault once the pan has committed. On iOS, a
        // preventDefault on any touchmove suppresses the browser-synthesized
        // click - we want that suppression for a real drag, but not for a
        // tap whose finger trembled a few pixels inside PAN_THRESHOLD (e.g.
        // tapping an EmptySlot to spawn while zoomed in).
        if (e.cancelable) {
          e.preventDefault();
        }
        state.current.x = g.initialSX + dx;
        state.current.y = g.initialSY + dy;
        clampPan();
        applyTransform();
      }
    }

    function handleTouchEnd(e: TouchEvent) {
      const g = gesture.current;
      if (g.kind === "pinching") {
        if (e.touches.length < 2) {
          resetGesture();
        } else {
          // A finger lifted from a 3+ finger pinch, leaving two on-screen.
          // Re-anchor so startDist/initialMid match the remaining pair -
          // otherwise the next touchmove snaps scale/position using stale
          // anchors from the prior finger configuration.
          enterPinch(e.touches[0], e.touches[1]);
        }
        return;
      }
      if (
        g.kind === "panning" &&
        g.source === "touch" &&
        e.touches.length === 0
      ) {
        // didPan is intentionally NOT cleared here - it must survive past the
        // iOS-synthesized click window so wrapClick can suppress the tap that
        // follows a drag-pan. The next fresh single-finger tap clears it in
        // handleTouchStart. Do not "unify" this with handlePointerUp's reset.
        resetGesture();
      }
    }

    function handleTouchCancel() {
      const g = gesture.current;
      // iOS palm rejection / system gesture can cancel mid-pan. Reset any
      // touch-driven gesture state unconditionally so the next fresh touch
      // starts clean. Pointer-driven pans live in handlePointerCancel.
      if (
        g.kind === "pinching" ||
        (g.kind === "panning" && g.source === "touch")
      ) {
        resetGesture();
      }
    }

    const ro = new ResizeObserver(() => {
      // The centered scene's layer-local position depends on container size.
      measureSceneBounds();
      if (isAtRest()) {
        // The fitted view is defined by the container, so it has to follow the
        // container. A view the user panned or zoomed only gets re-clamped.
        applyRest(false);
        return;
      }
      clampPan();
      applyTransform();
    });
    ro.observe(container);

    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerup", handlePointerUp);
    container.addEventListener("pointercancel", handlePointerCancel);
    container.addEventListener("dragstart", handleNativeDragStart);
    container.addEventListener("selectstart", handleSelectStart);
    container.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchCancel, {
      passive: true,
    });

    return () => {
      ro.disconnect();
      clearResetTransition();
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerup", handlePointerUp);
      container.removeEventListener("pointercancel", handlePointerCancel);
      container.removeEventListener("dragstart", handleNativeDragStart);
      container.removeEventListener("selectstart", handleSelectStart);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchCancel);
      // Must come AFTER removeEventListener calls: abortAllGestures releases
      // pointer capture, which can synthesize a pointercancel - we don't want
      // that dispatching into the handler we're about to remove.
      abortAllGestures();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, enabled]);

  return {
    setContainer,
    setScene,
    setContent,
    resetView,
    zoomIn,
    zoomOut,
    isZoomedIn,
    wrapClick,
  };
}
