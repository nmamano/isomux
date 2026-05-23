import { Portal } from "../components/Portal.tsx";
import type { CiteSelection } from "./useSelectionCite.ts";

const PILL_WIDTH = 64;
const PILL_HEIGHT = 26;
const PILL_GAP = 6;
const PILL_EDGE_PAD = 4;

/**
 * Floating "Cite" pill rendered above the user's active text selection.
 *
 * Positioning:
 *  - Anchored to the END of the selection (the LAST client rect), then
 *    clamped horizontally to the container's viewport so it never extends
 *    past the chat column.
 *  - Prefers placement above the selection; flips below if there's no room.
 *  - Mounted via a Portal into <body>, so any ancestor with transform /
 *    filter / will-change won't pin us to a smaller containing block.
 *  - Pointer events guard: `onMouseDown` calls preventDefault to avoid the
 *    native focus/blur cycle collapsing the selection before our click
 *    handler runs.
 *
 * Never touches scroll position or layout outside its own box.
 */
export function CiteSelectionButton({
  cite,
  containerRect,
  onClick,
}: {
  cite: CiteSelection;
  containerRect: DOMRect;
  onClick: () => void;
}) {
  // Vertical placement: above the selection if room, else below.
  const aboveTop = cite.rect.top - PILL_HEIGHT - PILL_GAP;
  const placement =
    aboveTop >= containerRect.top
      ? { top: aboveTop }
      : { top: cite.rect.bottom + PILL_GAP };

  // Horizontal: anchor pill's right edge to the selection's right edge, then
  // clamp inside the container so the pill stays visually attached to the
  // chat column.
  let left = cite.rect.right - PILL_WIDTH;
  if (left + PILL_WIDTH > containerRect.right - PILL_EDGE_PAD) {
    left = containerRect.right - PILL_WIDTH - PILL_EDGE_PAD;
  }
  if (left < containerRect.left + PILL_EDGE_PAD) {
    left = containerRect.left + PILL_EDGE_PAD;
  }

  return (
    <Portal>
      <button
        type="button"
        onMouseDown={(e) => {
          // Don't let the click steal focus from the document and collapse
          // the selection before onClick fires.
          e.preventDefault();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        title="Cite selected text in input"
        style={{
          position: "fixed",
          left,
          ...placement,
          width: PILL_WIDTH,
          height: PILL_HEIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          padding: "0 8px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-medium)",
          borderRadius: 6,
          color: "var(--text-secondary)",
          cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.02em",
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          zIndex: 100,
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M3 3h4v4H5v3H3V3zm7 0h4v4h-2v3h-2V3z" />
        </svg>
        <span>Cite</span>
      </button>
    </Portal>
  );
}
