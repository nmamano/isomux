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

// A section heading inside a settings part (for example Appearance in
// General): one look on the member, agent and room pages.
export const settingsSectionTitle: Readonly<CSSProperties> = Object.freeze({
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-primary)",
  margin: "24px 0 0",
  paddingBottom: 5,
  borderBottom: "1px solid var(--border-subtle)",
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

// The control that leaves a page (PageNavButton): Close in a page header, a
// phone's back-to-list row. The secondary fill, sized for a 44 px header.
const PAGE_NAV_PAD_Y = 4;
const PAGE_NAV_LINE = 16;
/** PageNavButton's height (border-box): a header button beside it takes it. */
export const PAGE_NAV_HEIGHT = PAGE_NAV_LINE + 2 * PAGE_NAV_PAD_Y + 2;
export const pageNavBtn: Readonly<CSSProperties> = Object.freeze({
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: `${PAGE_NAV_PAD_Y}px 10px`,
  borderRadius: 6,
  border: secondaryBorder,
  background: secondaryFill,
  color: "var(--text-secondary)",
  fontSize: 12,
  lineHeight: `${PAGE_NAV_LINE}px`,
  whiteSpace: "nowrap",
  flexShrink: 0,
  cursor: "pointer",
});

// A small icon button on a chat composer's 20 px input line (Attach files):
// a filled 24 px box whose negative margin keeps the line's height.
export const composerToolBtn: Readonly<CSSProperties> = Object.freeze({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 24,
  height: 24,
  margin: "-2px 0",
  padding: 0,
  boxSizing: "border-box",
  borderRadius: 6,
  border: "none",
  background: secondaryFill,
  color: "var(--text-muted)",
  cursor: "pointer",
  flexShrink: 0,
});

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

// Every disabled <button> takes disabledLook from one global rule
// (disabledButtonCss, mounted with the app CSS), so a new button needs no
// style of its own. A button that sets this attribute opts out of the rule.
// Use it only on a control that shows its own disabled state instead (a
// slider group that dims, a menu row that dims its text, a spinner that
// spins), never to keep a disabled button looking enabled.
export const OWN_DISABLED_LOOK_ATTR = "data-own-disabled-look";
// Spread on such a button: `<button {...ownDisabledLook}>`.
export const ownDisabledLook = Object.freeze({ [OWN_DISABLED_LOOK_ATTR]: "" });

// The global rule: disabledLook as CSS, each property !important so it wins
// over the inline style every button sets.
export function disabledButtonCss(): string {
  const declarations = Object.entries(disabledLook)
    .map(
      ([key, value]) =>
        `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value} !important;`,
    )
    .join(" ");
  return `button:disabled:not([${OWN_DISABLED_LOOK_ATTR}]) { ${declarations} }`;
}

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
