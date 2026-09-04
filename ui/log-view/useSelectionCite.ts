import { useCallback, useEffect, useRef, useState } from "react";

export type CiteSelection = {
  /** Plain text of the current selection. Source of truth for the click handler. */
  text: string;
  /** Viewport-coords rect of the *end* of the selection. Used to anchor a
   *  position: fixed pill, so coords are in viewport space already. */
  rect: DOMRect;
};

/**
 * Track the user's text selection inside `containerRef` and expose it as a
 * `CiteSelection` whenever it's a non-empty, fully-contained selection.
 *
 * Design rules baked in:
 *  - rAF-throttled `selectionchange` listener - coalesces iOS bursts and
 *    avoids per-event synchronous rect reads.
 *  - Both `anchorNode` and `focusNode` must be inside the container, so a
 *    selection that starts in the log and extends out doesn't cite unrelated
 *    UI.
 *  - At selectionchange time, the chosen rect must lie within the
 *    container's visible viewport. (Once cached, the rect is NOT
 *    re-validated against scroll - see ownership note below.)
 *  - Uses `range.getClientRects()` and takes the LAST non-degenerate rect
 *    (end of selection), not `getBoundingClientRect()` - the bounding box
 *    for a multi-line selection produces a broad rect that positions the
 *    pill oddly.
 *  - Pure listener: never writes scroll, never calls focus(), never mutates
 *    layout. Scroll-finickiness in the chat is preserved.
 *
 * Ownership boundary: this hook is selection-only. The cached rect goes
 * stale on scroll, but scroll-hide is the *caller's* responsibility - the
 * chat scroll handler already lives in LogView and routes through
 * `clearCite`. The hook does listen to window `resize` (no natural caller
 * path for that) to clear cached state when geometry changes globally.
 */
export function useSelectionCite(
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): { cite: CiteSelection | null; clearCite: () => void } {
  const [cite, setCite] = useState<CiteSelection | null>(null);
  const rafRef = useRef<number | null>(null);

  const clearCite = useCallback(() => setCite(null), []);

  useEffect(() => {
    if (!enabled) {
      // Drop any stale cite state when the feature toggles off mid-session
      // (e.g. user enters edit mode). One cascading render is acceptable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCite(null);
      return;
    }

    function read() {
      rafRef.current = null;
      const container = containerRef.current;
      if (!container) {
        setCite(null);
        return;
      }
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setCite(null);
        return;
      }
      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      if (
        !anchor ||
        !focus ||
        !container.contains(anchor) ||
        !container.contains(focus)
      ) {
        setCite(null);
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
        setCite(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rects = range.getClientRects();
      if (rects.length === 0) {
        setCite(null);
        return;
      }
      // Walk back from the end to find the last non-degenerate rect. Some
      // selections produce trailing zero-size rects (e.g. when the focus is
      // at the boundary of a line break or an inline element); anchoring the
      // pill on those positions it in dead space.
      let lastRect: DOMRect | null = null;
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i];
        if (r.width > 0 || r.height > 0) {
          lastRect = r;
          break;
        }
      }
      if (!lastRect) {
        setCite(null);
        return;
      }
      // Hide if the selection has scrolled out of the container's visible
      // viewport. We clamp to the container bounds, not window bounds, so a
      // selection covered by a sticky header or scrolled-off message doesn't
      // surface an orphan pill.
      const cr = container.getBoundingClientRect();
      const visible =
        lastRect.bottom > cr.top &&
        lastRect.top < cr.bottom &&
        lastRect.right > cr.left &&
        lastRect.left < cr.right;
      if (!visible) {
        setCite(null);
        return;
      }
      setCite({ text, rect: lastRect });
    }

    function handler() {
      // Coalesce iOS selectionchange bursts into a single rAF-aligned read.
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(read);
    }

    function hideOnResize() {
      // Window resize moves the selection's viewport coords out from under
      // our cached rect. Hide rather than reposition - repositioning would
      // re-enter layout territory. Scroll-hide is the caller's job (it owns
      // the chat scroll handler); the hook handles resize because there's
      // no natural LogView resize hook to piggyback on.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // setCite(null) is a no-op when state is already null in React 18+.
      setCite(null);
    }

    document.addEventListener("selectionchange", handler);
    window.addEventListener("resize", hideOnResize);
    return () => {
      document.removeEventListener("selectionchange", handler);
      window.removeEventListener("resize", hideOnResize);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, containerRef]);

  return { cite, clearCite };
}
