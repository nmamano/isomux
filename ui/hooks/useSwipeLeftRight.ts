import { useRef, useEffect, useState, useCallback, RefCallback } from "react";

const TRIGGER_THRESHOLD = 100;
const MAX_VERTICAL = 80;

function isActuallyHorizontallyScrollable(node: HTMLElement) {
  const style = window.getComputedStyle(node);
  const overflowX = style.overflowX;
  const allowsScroll = overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay";
  return allowsScroll && node.scrollWidth > node.clientWidth;
}

export function useSwipeLeftRight(
  onSwipeLeft: () => void,
  onSwipeRight: () => void,
  enabled: boolean,
  /** Per-gesture predicate. If provided and returns false at touch-start, the swipe is not tracked
   *  (used to cede one-finger drags to the viewport pan when the scene is zoomed in). */
  shouldStart?: () => boolean,
): RefCallback<HTMLDivElement> {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const multiTouchRef = useRef(false);
  const onSwipeLeftRef = useRef(onSwipeLeft);
  const onSwipeRightRef = useRef(onSwipeRight);
  const shouldStartRef = useRef(shouldStart);
  onSwipeLeftRef.current = onSwipeLeft;
  onSwipeRightRef.current = onSwipeRight;
  shouldStartRef.current = shouldStart;

  const ref = useCallback<RefCallback<HTMLDivElement>>((nextNode) => {
    setNode((prev) => (prev === nextNode ? prev : nextNode));
  }, []);

  useEffect(() => {
    if (!enabled || !node) return;
    const el = node;

    function onTouchStart(e: TouchEvent) {
      multiTouchRef.current = e.touches.length > 1;
      if (multiTouchRef.current) {
        startRef.current = null;
        return;
      }
      if (shouldStartRef.current && !shouldStartRef.current()) {
        startRef.current = null;
        return;
      }
      const t = e.touches[0];
      let node = e.target as HTMLElement | null;
      while (node && node !== el) {
        const tag = node.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable) {
          startRef.current = null;
          return;
        }
        if (isActuallyHorizontallyScrollable(node)) {
          startRef.current = null;
          return;
        }
        node = node.parentElement;
      }
      startRef.current = { x: t.clientX, y: t.clientY };
    }

    function onTouchMove(e: TouchEvent) {
      // Cancel swipe if a second finger appears (pinch-to-zoom)
      if (e.touches.length > 1) {
        multiTouchRef.current = true;
        startRef.current = null;
        return;
      }
      if (!startRef.current) return;
      const t = e.touches[0];
      const dy = Math.abs(t.clientY - startRef.current.y);
      if (dy > MAX_VERTICAL) {
        startRef.current = null;
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (multiTouchRef.current) {
        if (e.touches.length === 0) {
          multiTouchRef.current = false;
        }
        return;
      }
      if (!startRef.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startRef.current.x;
      const dy = Math.abs(t.clientY - startRef.current.y);
      startRef.current = null;

      if (dy > MAX_VERTICAL) return;
      const sel = window.getSelection();
      if (sel && sel.type === "Range") return;
      if (dx <= -TRIGGER_THRESHOLD) {
        onSwipeLeftRef.current();
      } else if (dx >= TRIGGER_THRESHOLD) {
        onSwipeRightRef.current();
      }
    }

    // iOS can cancel a touch sequence without a matching touchend (e.g. system
    // gesture, notification, palm rejection). Reset unconditionally — even a
    // partial cancel (one finger of a pinch) must clear the multi-touch guard
    // so the remaining finger isn't silently dropped for the rest of its life.
    function onTouchCancel() {
      multiTouchRef.current = false;
      startRef.current = null;
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [enabled, node]);

  return ref;
}
