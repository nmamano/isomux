// Shared style constants for dialog/modal components.
// Override or extend by spreading: `{ ...dialogLabel, marginTop: 16 }`.
// Frozen + `Readonly` so the shared base can't drift via accidental mutation.

import type { CSSProperties } from "react";

// Labels sit one contrast step above hint copy (dim/600 vs muted/400) so the
// hierarchy survives every theme's ladder.
export const dialogLabel: Readonly<CSSProperties> = Object.freeze({
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-dim)",
  marginBottom: 5,
});

export const dialogInput: Readonly<CSSProperties> = Object.freeze({
  width: "100%",
  padding: "9px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
});

export const dialogCancelBtn: Readonly<CSSProperties> = Object.freeze({
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
});

// The action on a card in the transcript (Show help, Show system prompt, Show
// schedule prompt). dialogCancelBtn is wrong here: a transparent fill over the
// card's own surface leaves nothing but a faint hairline, which is invisible in
// several themes. An accent tint plus an accent border and label reads as the
// one thing to click without competing with dialogSaveBtn, and every value is
// per-theme, so it holds in all six.
export const cardActionBtn: Readonly<CSSProperties> = Object.freeze({
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid var(--accent)",
  background: "var(--accent-bg)",
  color: "var(--accent-text)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
});

export const dialogSaveBtn: Readonly<CSSProperties> = Object.freeze({
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent-text)",
  color: "var(--bg-base)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
});

// A disabled button. Fading it with opacity takes its label below 4.5:1, so
// the fill goes neutral and the label takes the floor text colour. The inset
// line keeps the button's size whether or not it has a border.
export const disabledLook: Readonly<CSSProperties> = Object.freeze({
  background: "var(--btn-surface)",
  boxShadow: "inset 0 0 0 1px var(--border)",
  color: "var(--text-hint)",
  cursor: "not-allowed",
});

export const dialogChip: Readonly<CSSProperties> = Object.freeze({
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--btn-surface)",
  color: "var(--text-muted)",
  fontSize: 10,
  cursor: "pointer",
  fontFamily: "'JetBrains Mono',monospace",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
});

// Explicit size so hint copy reads the same whether it sits inside an 11px
// label or as its own block; muted (not ghost) keeps it legible while staying
// quieter than the bold labels around it.
export const dialogHint: Readonly<CSSProperties> = Object.freeze({
  fontWeight: 400,
  fontSize: 12,
  color: "var(--text-muted)",
});
