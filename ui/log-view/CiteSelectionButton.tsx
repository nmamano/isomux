import { Portal } from "../components/Portal.tsx";
import { useI18n } from "../i18n.tsx";
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
 *  - `pinned` (the mobile editor) puts the pill at the container's top-right
 *    corner instead: next to the selection it would sit under the native
 *    selection menu or handles.
 *  - Activates on pointerdown, like the terminal's "Send to chat" pill: a
 *    touch blur can otherwise remove the pill before its click fires.
 *    preventDefault keeps the focus and the selection where they are.
 *
 * Never touches scroll position or layout outside its own box.
 */
export function CiteSelectionButton({
  cite,
  containerRect,
  onClick,
  pinned = false,
}: {
  cite: Pick<CiteSelection, "rect">;
  containerRect: DOMRect;
  onClick: () => void;
  pinned?: boolean;
}) {
  const { t } = useI18n();
  // Vertical placement: above the selection if room, else below.
  const aboveTop = cite.rect.top - PILL_HEIGHT - PILL_GAP;
  const placement = pinned
    ? { top: containerRect.top + PILL_GAP }
    : aboveTop >= containerRect.top
      ? { top: aboveTop }
      : { top: cite.rect.bottom + PILL_GAP };

  // Horizontal: anchor pill's right edge to the selection's right edge, then
  // clamp inside the container so the pill stays visually attached to the
  // chat column.
  let left = pinned
    ? containerRect.right - PILL_WIDTH - PILL_EDGE_PAD
    : cite.rect.right - PILL_WIDTH;
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
        onPointerDown={(e) => {
          // Primary button only: a right-click keeps its context menu.
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // detail === 0 is a keyboard click (Enter/Space), with no
          // pointerdown before it.
          if (e.detail === 0) onClick();
        }}
        title={t("logView.cite.hint")}
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
        <span>{t("logView.cite.label")}</span>
      </button>
    </Portal>
  );
}
