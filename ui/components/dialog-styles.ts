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

export const dialogSaveBtn: Readonly<CSSProperties> = Object.freeze({
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "var(--bg-base)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
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
