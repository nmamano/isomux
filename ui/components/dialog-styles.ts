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
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
});

// The action on a card in the transcript (Show help, Show system prompt, Show
// schedule prompt). An accent tint plus an accent border and label reads as the
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

// A secondary action (Cancel, Close, Dismiss). Every button has a fill: a
// transparent one with a hairline border reads as plain text (Nil, 2026-10-31).
// Every theme's surface tokens are a few percent at most, so the fill and the
// border mix the theme's own text colour in. A button with its own colour
// (danger, accent) tints its fill with that colour: tintedFill.
export const secondaryFill =
  "color-mix(in srgb, var(--text-primary) 9%, transparent)";
export const secondaryEdge =
  "color-mix(in srgb, var(--text-primary) 22%, transparent)";
export const secondaryBorder = `1px solid ${secondaryEdge}`;
export const filledSecondaryBtn: Readonly<CSSProperties> = Object.freeze({
  padding: "7px 16px",
  borderRadius: 8,
  border: secondaryBorder,
  background: secondaryFill,
  color: "var(--text-secondary)",
  fontSize: 12,
  cursor: "pointer",
});

export const dialogCancelBtn = filledSecondaryBtn;

export function tintedFill(color: string): string {
  return `color-mix(in srgb, ${color} 12%, transparent)`;
}

// A secondary action that destroys or reverts something (Delete, Reload).
export const filledDangerBtn: Readonly<CSSProperties> = Object.freeze({
  ...filledSecondaryBtn,
  border: "1px solid var(--red)",
  background: tintedFill("var(--red)"),
  color: "var(--red-text)",
});

// The colours of a control armed by a confirm step (useConfirmStep), laid
// over its own size and shape.
export const armedConfirmLook: Readonly<CSSProperties> = Object.freeze({
  border: filledDangerBtn.border,
  background: filledDangerBtn.background,
  color: filledDangerBtn.color,
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

// A disabled field (read only for this member). A fill change alone is too
// faint in the dark themes, so the field drops its fill and its border goes
// dashed: it does not read as a field to type in.
export const disabledFieldLook: Readonly<CSSProperties> = Object.freeze({
  background: "transparent",
  border: "1px dashed var(--border-medium)",
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
  fontFamily: "var(--font-ui)",
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
