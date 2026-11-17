// The styles of the spawn dialog's template picker: the cards, the desktop
// popover and the phone sheet. Moved out of EditAgentDialog.tsx to keep it
// under the line limit.

import type React from "react";
import type { AgentTemplate } from "../agent-templates.ts";

export function templateCardStyle(
  selected: boolean,
  group?: AgentTemplate["group"],
): React.CSSProperties {
  const groupColor = group ? TEMPLATE_GROUP_COLORS[group] : null;
  return {
    minHeight: group ? 78 : 46,
    padding: "8px 9px",
    borderRadius: 7,
    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
    background: selected
      ? "var(--accent-muted, rgba(88,166,255,0.15))"
      : groupColor
        ? `color-mix(in srgb, ${groupColor} 8%, var(--bg-input))`
        : "var(--bg-input)",
    color: "var(--text-primary)",
    textAlign: "left",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 7,
    boxShadow: groupColor ? `inset 3px 0 0 ${groupColor}` : undefined,
  };
}

const TEMPLATE_GROUP_COLORS: Record<AgentTemplate["group"], string> = {
  // Keep chip tints independent from theme variables and selection colors.
  build: "#4A90D9",
  work: "#50b86c",
  life: "#e85d75",
  places: "#d4a843",
};

// Desktop: the list drops under the row and scrolls on its own.
export const templatePopoverStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  right: 0,
  zIndex: 20,
  maxHeight: "min(440px, 60vh)",
  overflowY: "auto",
  overscrollBehavior: "contain",
  padding: 10,
  borderRadius: 10,
  border: "1px solid var(--border-light)",
  background: "var(--bg-overlay-solid)",
  boxShadow: "0 12px 32px var(--shadow-heavy)",
};

// Mobile: the list is a sheet from the bottom of the screen.
export const templateSheetBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 20,
  background: "rgba(0,0,0,0.45)",
};

export const templateSheetStyle: React.CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 21,
  maxHeight: "80dvh",
  overflowY: "auto",
  overscrollBehavior: "contain",
  padding: "14px 14px max(14px, env(safe-area-inset-bottom))",
  borderRadius: "14px 14px 0 0",
  borderTop: "1px solid var(--border-light)",
  background: "var(--bg-overlay-solid)",
  boxShadow: "0 -12px 32px var(--shadow-heavy)",
};

export const templateAvatarStyle: React.CSSProperties = {
  width: 34,
  height: 46,
  flex: "0 0 34px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

export const templateCardTextStyle: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

export const templateCardTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 650,
  lineHeight: 1.2,
};

export const templateCardDescriptionStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
  lineHeight: 1.3,
};
