import { useCallback, useEffect, useRef } from "react";

// A 1-px visible divider with a wider invisible hit target sitting on the
// chat-side edge of a side panel (terminal/editor). Drags resize the panel
// directly via DOM (no React re-render mid-drag — CodeMirror and xterm both
// re-measure on width change, so 60 dispatches/sec would be janky). The
// final width is committed to React state via onCommit on mouseup.
//
// Min/max clamp inside the component so the parent doesn't have to worry
// about it during the live drag, only when it later persists.
export function PanelResizer({
  panelRef,
  min,
  getMax,
  onCommit,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  min: number;
  // Read fresh on every mousemove so a window-resize mid-drag re-computes
  // the active maximum (window inner width minus chat column floor) instead
  // of using a value captured when the drag started.
  getMax: () => number;
  onCommit: (width: number) => void;
}) {
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!draggingRef.current || !panelRef.current) return;
      // The panel is on the right; dragging the divider left grows the panel.
      const dx = startXRef.current - e.clientX;
      const next = Math.max(
        min,
        Math.min(getMax(), startWidthRef.current + dx),
      );
      panelRef.current.style.width = `${next}px`;
    },
    [panelRef, min, getMax],
  );

  const onMouseUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMouseMove);
    // Self-reference is needed to remove the listener registered by mouseDown.
    // eslint-disable-next-line react-hooks/immutability
    window.removeEventListener("mouseup", onMouseUp);
    if (panelRef.current) {
      onCommit(panelRef.current.offsetWidth);
    }
  }, [panelRef, onCommit, onMouseMove]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !panelRef.current) return;
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = panelRef.current.offsetWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [panelRef, onMouseMove, onMouseUp],
  );

  // Safety: detach if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      }
    };
  }, [onMouseMove, onMouseUp]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="panel-resizer"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: -3,
        width: 6,
        cursor: "col-resize",
        zIndex: 5,
        // The visible 1-px line is rendered via ::after in styles.ts so we
        // can style the hover state without inline style juggling.
      }}
      aria-label="Resize side panel"
      role="separator"
    />
  );
}
