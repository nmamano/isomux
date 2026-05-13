import { useEffect, useRef } from "react";
import { useTheme } from "../store.tsx";
import { Portal } from "./Portal.tsx";
import { THEMES, type Theme } from "../themes.ts";

interface Props {
  open: boolean;
  onClose: () => void;
}

const HEADING_ID = "theme-picker-heading";

export function ThemePicker({ open, onClose }: Props) {
  const { theme: currentId, setTheme } = useTheme();
  const cardRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, onClose]);

  // Focus management: on open, remember whoever had focus, then move focus
  // into the dialog (selected row first, otherwise first row). On close,
  // restore focus to the opener so keyboard navigation isn't stranded.
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const card = cardRef.current;
    if (card) {
      const selected = card.querySelector<HTMLButtonElement>(
        'button[data-theme-row][data-selected="true"]',
      );
      const first = card.querySelector<HTMLButtonElement>(
        "button[data-theme-row]",
      );
      (selected ?? first)?.focus();
    }
    return () => {
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <Portal>
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 900,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(2px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
      >
        <div
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={HEADING_ID}
          style={{
            width: "100%",
            maxWidth: 320,
            background: "var(--bg-overlay)",
            border: "1px solid var(--border-light)",
            borderRadius: 12,
            padding: 6,
            boxShadow: "0 12px 40px var(--shadow-heavy)",
            animation: "hudIn 0.12s ease-out",
            maxHeight: "min(80vh, 480px)",
            overflowY: "auto",
          }}
        >
          <div
            id={HEADING_ID}
            style={{
              padding: "8px 12px 6px",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--text-faint)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Theme
          </div>
          <div role="radiogroup" aria-labelledby={HEADING_ID}>
            {THEMES.map((theme) => (
              <ThemeRow
                key={theme.id}
                theme={theme}
                selected={theme.id === currentId}
                onSelect={() => {
                  setTheme(theme.id);
                  onClose();
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </Portal>
  );
}

function ThemeRow({
  theme,
  selected,
  onSelect,
}: {
  theme: Theme;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      data-theme-row
      data-selected={selected || undefined}
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        padding: "9px 12px",
        border: "none",
        background: selected ? "var(--accent-bg)" : "transparent",
        color: selected ? "var(--accent)" : "var(--text-primary)",
        fontSize: 13,
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <ThemeSwatch theme={theme} />
      <span style={{ flex: 1 }}>{theme.displayName}</span>
      {selected && (
        <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>
          ✓
        </span>
      )}
    </button>
  );
}

// A tiny 4-color chip previewing the theme's base, accent, green, and red.
// Helps the boss recognize themes at a glance without having to read names.
function ThemeSwatch({ theme }: { theme: Theme }) {
  const colors = [
    theme.vars["--bg-base"],
    theme.vars["--accent"],
    theme.vars["--green"],
    theme.vars["--red"],
  ];
  return (
    <span
      style={{
        display: "inline-flex",
        width: 20,
        height: 20,
        borderRadius: 4,
        overflow: "hidden",
        border: "1px solid var(--border-light)",
        flexShrink: 0,
      }}
    >
      {colors.map((c, i) => (
        <span key={i} style={{ flex: 1, background: c, display: "block" }} />
      ))}
    </span>
  );
}
