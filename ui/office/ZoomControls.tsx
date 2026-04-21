import { useState } from "react";

function ZoomButton({
  onClick,
  title,
  "aria-label": ariaLabel,
  children,
  marginTop = 0,
}: {
  onClick: () => void;
  title: string;
  "aria-label": string;
  children: React.ReactNode;
  marginTop?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);

  const background = pressed
    ? "var(--bg-hover)"
    : hovered
    ? "var(--accent-hover)"
    : "var(--btn-surface)";
  const borderColor = focused || hovered ? "var(--border-light)" : "var(--border-medium)";
  const color = focused || hovered ? "var(--text)" : "var(--text-dim)";

  return (
    <button
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        marginTop,
        borderRadius: 8,
        border: `1px solid ${borderColor}`,
        background,
        color,
        fontSize: 16,
        fontWeight: 600,
        cursor: "pointer",
        backdropFilter: "blur(8px)",
        lineHeight: 1,
        padding: 0,
        fontFamily: "'JetBrains Mono', monospace",
        boxShadow: focused ? "0 0 0 2px var(--accent-hover)" : hovered ? "0 8px 18px var(--shadow-heavy)" : "none",
        transform: pressed ? "translateY(1px) scale(0.98)" : "translateY(0) scale(1)",
        transition: "background 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease, transform 80ms ease",
        outline: "none",
      }}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onBlur={() => {
        setFocused(false);
        setPressed(false);
      }}
      onFocus={() => setFocused(true)}
    >
      {children}
    </button>
  );
}

export function ZoomControls({ onZoomIn, onZoomOut, onReset }: { onZoomIn: () => void; onZoomOut: () => void; onReset: () => void }) {

  return (
    <div
      data-no-pan
      style={{
        position: "absolute",
        bottom: 12,
        right: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        zIndex: 400,
      }}
    >
      <ZoomButton onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">+</ZoomButton>
      <ZoomButton onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">-</ZoomButton>
      <ZoomButton onClick={onReset} title="Reset view (0)" aria-label="Reset view" marginTop={4}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" />
          <line x1="7" y1="4" x2="7" y2="10" />
          <line x1="4" y1="7" x2="10" y2="7" />
        </svg>
      </ZoomButton>
    </div>
  );
}
