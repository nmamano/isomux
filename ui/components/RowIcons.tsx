// Small icon buttons for a row of an ordered list: Move up, Move down and
// Remove (the webhook rules, a member's Pinned list).

import { secondaryBorder, secondaryFill } from "./dialog-styles.ts";

export function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    border: secondaryBorder,
    background: secondaryFill,
    color: disabled ? "var(--text-ghost)" : "var(--text-dim)",
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
  };
}

export function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: up ? "rotate(180deg)" : undefined }}
    >
      <path d="M2.5 4.5 L6 8 L9.5 4.5" />
    </svg>
  );
}

export function Cross() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M3 3 L9 9 M9 3 L3 9" />
    </svg>
  );
}
