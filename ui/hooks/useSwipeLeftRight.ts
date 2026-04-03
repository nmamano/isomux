import { useRef, useEffect } from "react";

const TRIGGER_THRESHOLD = 100;
const MAX_VERTICAL = 80;

export function useSwipeLeftRight(
  onSwipeLeft: () => void,
  onSwipeRight: () => void,
  enabled: boolean,
) {
  const ref = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const onSwipeLeftRef = useRef(onSwipeLeft);
  const onSwipeRightRef = useRef(onSwipeRight);
  onSwipeLeftRef.current = onSwipeLeft;
  onSwipeRightRef.current = onSwipeRight;

  useEffect(() => {
    if (!enabled || !ref.current) return;
    const el = ref.current;

    function onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      let node = e.target as HTMLElement | null;
      while (node && node !== el) {
        const tag = node.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable) {
          startRef.current = null;
          return;
        }
        if (node.scrollWidth > node.clientWidth) {
          startRef.current = null;
          return;
        }
        node = node.parentElement;
      }
      startRef.current = { x: t.clientX, y: t.clientY };
    }

    function onTouchMove(e: TouchEvent) {
      if (!startRef.current) return;
      const t = e.touches[0];
      const dy = Math.abs(t.clientY - startRef.current.y);
      if (dy > MAX_VERTICAL) {
        startRef.current = null;
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (!startRef.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startRef.current.x;
      const dy = Math.abs(t.clientY - startRef.current.y);
      startRef.current = null;

      if (dy > MAX_VERTICAL) return;
      if (dx <= -TRIGGER_THRESHOLD) {
        onSwipeLeftRef.current();
      } else if (dx >= TRIGGER_THRESHOLD) {
        onSwipeRightRef.current();
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [enabled]);

  return ref;
}
