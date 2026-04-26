import { useRef, useState, useEffect, useCallback } from "react";
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
  RESET_TRANSITION: "transform 0.25s ease-out",
  RESET_CLEAR_MS: 300,
} as const;

const DEFAULT_STATE: ViewportState = { x: 0, y: 0, scale: 1 };

// Pan should start from any non-interactive surface in the scene. Every clickable
// target in the scene — including native HTML5 drag sources like DeskUnit — opts
// out via `data-no-pan`, so we don't need a separate [draggable] rule here.
const PAN_BLOCKER_SELECTOR = "[data-no-pan], button, a, input, textarea, select";
// Touch-only blocker: excludes [data-no-pan]. The big 180×160 desk/slot
// hit-rects blanket the visible floor — treating them as pan blockers would make
// one-finger pan fail almost everywhere when zoomed in. Tap-vs-drag stays safe
// because: (a) DeskUnit preventDefaults touchstart and dispatches its own
// clicks from touchend, so browser-synthesized clicks on a desk aren't the
// trigger path; (b) EmptySlot and other data-no-pan click targets rely on
// synthesized clicks, and wrapClick + didPan gate those on idle gestures.
const TOUCH_PAN_BLOCKER_SELECTOR = "button, a, input, textarea, select";

function clampScale(scale: number) {
  return Math.max(VIEWPORT.MIN_SCALE, Math.min(VIEWPORT.MAX_SCALE, scale));
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
 * single-finger drag — pointercancel fires even with touch-action: none, and
 * setPointerCapture on a touch pointer can drop pointermove deliveries).
 *
 * `panning.committed` distinguishes a pending tap (within the click threshold)
 * from an actual drag — uncommitted panning never mutates the viewport.
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
 * Per-room view state is keyed by room ID (not index) so mid-list deletions
 * don't mis-associate saved zoom/pan with a neighbouring room.
 *
 * `layoutKey` should change whenever the centered scene's static transform
 * changes (e.g. embed/isMobile/mobileScale flip) so the pan-clamp boundaries
 * re-measure. ResizeObserver only fires on container size changes and won't
 * notice transform-only updates.
 *
 * When `enabled` is false, gesture listeners are not attached (wheel, pointer,
 * touch, pinch all become no-ops) — used to disable zoom in embed mode where
 * the UI chrome and keyboard shortcuts are already hidden.
 *
 * Returns callback refs (`setContainer`, `setScene`, `setContent`) instead of
 * RefObjects — attach them via `ref={...}` on the corresponding elements.
 */
export function useViewport(currentRoomId: string, roomIds: readonly string[], layoutKey: string, enabled: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  /** The scene-content element inside the zoom/pan layer — measured for pan-clamp bounds. */
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

  const roomStates = useRef<Map<string, ViewportState>>(new Map());
  const state = useRef<ViewportState>({ ...DEFAULT_STATE });
  const gesture = useRef<Gesture>({ kind: "idle" });
  /** Scene content bounds in viewport-layer-local coords (pre-zoom). Null until measured. */
  const sceneBounds = useRef<{ left: number; right: number; top: number; bottom: number } | null>(null);
  /** True if the most recent pointer gesture became a pan — used to suppress click-to-focus */
  const didPan = useRef(false);
  const currentRoomIdRef = useRef(currentRoomId);
  currentRoomIdRef.current = currentRoomId;
  const roomIdsRef = useRef(roomIds);
  roomIdsRef.current = roomIds;
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
   *  when gestures must be abandoned mid-flight — on room change (anchors reference
   *  the outgoing room) or when listeners detach (enabled toggle / unmount). */
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
    // Only touch scene.style.transition if one is currently set — otherwise
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
   * ensure state.current matches the last rendered transform — i.e. call
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
    if (crect.width === 0 || crect.height === 0 || rect.width === 0 || rect.height === 0) {
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

  function save() {
    const id = currentRoomIdRef.current;
    if (!id) {
      return;
    }
    roomStates.current.set(id, { ...state.current });
  }

  // The callbacks below are `useCallback(..., [])` because every value they
  // reach — state, gesture, refs, and the in-body helpers (applyTransform,
  // zoomAt, save, measureSceneBounds, clampPan) — is stored in a ref or
  // reads through one. No render-scoped variable is closed over. If you add
  // a line here that captures component state or props, switch to refs or
  // add the dep; otherwise the callback will silently use stale values.
  // sceneBounds are layer-local (measureSceneBounds inverts the live transform),
  // so they're invariant under state changes — no need to re-measure after
  // resetting. At DEFAULT_STATE, clampPan is a no-op by construction.
  const resetView = useCallback((animate = true) => {
    state.current = { ...DEFAULT_STATE };
    save();
    applyTransform(animate);
  }, []);

  const zoomIn = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, state.current.scale * VIEWPORT.ZOOM_STEP);
    save();
  }, []);

  const zoomOut = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, state.current.scale / VIEWPORT.ZOOM_STEP);
    save();
  }, []);

  /** True when the user has zoomed in past the rest scale — used to route one-finger drags
   *  to pan instead of swipe on touch (iOS-gallery pattern). */
  const isZoomedIn = useCallback(() => state.current.scale > VIEWPORT.ZOOM_EPSILON, []);

  /** Wrap a click handler so it's suppressed when the click was actually a drag-pan. */
  const wrapClick = useCallback(<A extends unknown[]>(cb: (...args: A) => void) => {
    return (...args: A) => {
      if (!didPan.current) {
        cb(...args);
      }
    };
  }, []);

  // Restore per-room state on room change.
  useEffect(() => {
    // Any in-flight gesture references the outgoing room's anchor — abandon it.
    abortAllGestures();

    const saved = roomStates.current.get(currentRoomId);
    state.current = saved ? { ...saved } : { ...DEFAULT_STATE };
    // Write the new room's transform to the DOM BEFORE measuring. measureSceneBounds
    // inverts the scene's live transform using state.current — if the DOM still
    // reflects the outgoing room's transform at this point, the computed bounds
    // are shifted and scaled by (old - new), leaving clampPan using wrong edges
    // for every subsequent pan/zoom in the new room.
    applyTransform();
    measureSceneBounds();
    clampPan();
    // Re-apply only if clampPan mutated state; a no-op apply writes the same
    // transform string so it's cheap either way.
    applyTransform();
  }, [currentRoomId]);

  // Prune saved state for rooms that no longer exist. Split from the
  // restore effect so deleting a non-current room doesn't abort an in-flight
  // gesture or re-apply the current room's transform.
  // Room IDs are persistent identities — once assigned, they don't mutate in
  // place. Pruning is only ever needed on deletion, which drops the length,
  // so length alone is a sufficient change detector.
  useEffect(() => {
    const valid = new Set(roomIdsRef.current);
    for (const key of Array.from(roomStates.current.keys())) {
      if (!valid.has(key)) {
        roomStates.current.delete(key);
      }
    }
  }, [roomIds.length]);

  // Re-measure scene bounds when the centered scene's static transform
  // changes (embed/isMobile/mobileScale). ResizeObserver only catches
  // container size changes, not transform-only updates to inner content.
  useEffect(() => {
    measureSceneBounds();
    clampPan();
    applyTransform();
  }, [layoutKey]);

  // This effect's deps are `[container, enabled]`. The DOM handlers registered
  // below close over in-body helpers (applyTransform, zoomAt, clampPan, save,
  // measureSceneBounds). Those helpers are recreated on every render, but the
  // handlers captured here reference the version from the render when the
  // effect last ran — which is fine ONLY because every helper reaches state
  // through refs and closes over no render-scoped values. If you add a line
  // to any helper that captures props or useState values, either add the dep
  // here (and accept listener churn) or route the new value through a ref.
  useEffect(() => {
    if (!container || !enabled) {
      return;
    }
    const resetGesture = (shouldSave = false) => {
      if (shouldSave && gesture.current.kind !== "idle") {
        save();
      }
      gesture.current = { kind: "idle" };
    };
    const startPan = (source: "pointer" | "touch", clientX: number, clientY: number, pointerId = -1) => {
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
      if (gesture.current.kind === "panning" && gesture.current.source === "pointer") {
        // Release the primary pointer's capture so lifting back to a single
        // touch after the pinch doesn't reactivate the old pan anchor.
        // Touch-driven pans don't use pointer capture — nothing to release.
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
      const unit = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? rect.height : 1;
      const delta = -e.deltaY * unit * VIEWPORT.WHEEL_ZOOM_SPEED;
      zoomAt(cx, cy, state.current.scale * (1 + delta));
      save();
    }

    function handlePointerDown(e: PointerEvent) {
      // Touch-driven pan is handled in handleTouchStart (TouchEvents are more
      // reliable than pointer events on iOS for sustained single-finger pan).
      // Reset didPan only for non-touch pointers here — touch resets happen in
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
      if (g.kind !== "panning" || g.source !== "pointer" || g.pointerId !== e.pointerId) {
        return;
      }
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      e.preventDefault();
      if (!g.committed) {
        if (Math.abs(dx) < VIEWPORT.PAN_THRESHOLD && Math.abs(dy) < VIEWPORT.PAN_THRESHOLD) {
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
      if (g.kind !== "panning" || g.source !== "pointer" || g.pointerId !== e.pointerId) {
        return;
      }
      releasePan(e.pointerId);
      if (g.committed) {
        save();
      }
      // Safe to clear here: pointer capture retargets the synthesized click to
      // the container, not to any wrapClick'd descendant, so no stale-didPan
      // window exists for mouse pans. Reset anyway to make the invariant
      // (didPan is true only between commit and end-of-gesture) explicit.
      didPan.current = false;
      resetGesture();
    }

    function handlePointerCancel(e: PointerEvent) {
      const g = gesture.current;
      if (g.kind !== "panning" || g.source !== "pointer" || g.pointerId !== e.pointerId) {
        return;
      }
      handlePointerUp(e);
    }

    function handleNativeDragStart(e: DragEvent) {
      if (gesture.current.kind === "panning" && gesture.current.source === "pointer") {
        e.preventDefault();
      }
    }

    function handleSelectStart(e: Event) {
      if (gesture.current.kind === "panning" && gesture.current.source === "pointer") {
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
      // synthesized pointerdown — reset didPan on a fresh tap so a post-pan
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
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
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
      if (g.kind === "panning" && g.source === "touch" && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - g.startX;
        const dy = t.clientY - g.startY;
        if (!g.committed) {
          if (Math.abs(dx) < VIEWPORT.PAN_THRESHOLD && Math.abs(dy) < VIEWPORT.PAN_THRESHOLD) {
            return;
          }
          g.committed = true;
          didPan.current = true;
        }
        // Only preventDefault once the pan has committed. On iOS, a
        // preventDefault on any touchmove suppresses the browser-synthesized
        // click — we want that suppression for a real drag, but not for a
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
          resetGesture(true);
        } else {
          // A finger lifted from a 3+ finger pinch, leaving two on-screen.
          // Re-anchor so startDist/initialMid match the remaining pair —
          // otherwise the next touchmove snaps scale/position using stale
          // anchors from the prior finger configuration.
          enterPinch(e.touches[0], e.touches[1]);
        }
        return;
      }
      if (g.kind === "panning" && g.source === "touch" && e.touches.length === 0) {
        // didPan is intentionally NOT cleared here — it must survive past the
        // iOS-synthesized click window so wrapClick can suppress the tap that
        // follows a drag-pan. The next fresh single-finger tap clears it in
        // handleTouchStart. Do not "unify" this with handlePointerUp's reset.
        resetGesture(g.committed);
      }
    }

    function handleTouchCancel() {
      const g = gesture.current;
      // iOS palm rejection / system gesture can cancel mid-pan. Reset any
      // touch-driven gesture state unconditionally so the next fresh touch
      // starts clean.
      if (g.kind === "panning" && g.source === "touch") {
        resetGesture(g.committed);
      } else if (g.kind === "pinching") {
        resetGesture(true);
      }
    }

    const ro = new ResizeObserver(() => {
      // The centered scene's layer-local position depends on container size.
      measureSceneBounds();
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
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchCancel, { passive: true });

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
      // pointer capture, which can synthesize a pointercancel — we don't want
      // that dispatching into the handler we're about to remove.
      abortAllGestures();
    };
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
