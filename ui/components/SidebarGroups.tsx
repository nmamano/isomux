// The grouped sidebar of the Settings and Integrations pages (task db800fd8:
// Integrations reuses the Settings menu). A page builds its groups as data
// and renders each with SidebarGroupRows; what a row opens is the page's
// business, carried as the row's `target`.

import { cloneElement } from "react";
import { DoorIcon } from "./NavIcons.tsx";

// One sidebar entry: it moves the detail pane to `target`. The row holds the
// target as DATA rather than a closure over select(), because select() routes
// through the unsaved-changes guard and must not be captured during render.
export type SidebarRow<T> = {
  key: string;
  label: string;
  selected: boolean;
  target: T;
};

// A group of sidebar entries. The Members group carries no rows: it renders
// the live roster instead, which needs per-user avatars and status.
// `dynamic` marks a group whose rows come from live data rather than from a
// fixed list, and gives those rows the roster's shape (a glyph and a name) so
// the two kinds of row never look alike.
export type SidebarGroup<T> = {
  id: string;
  // A group without a label draws no header.
  label?: string;
  // The office / user / device marker the nav bar used to carry, drawn beside
  // the group label. A group whose rows stand for live things (Rooms,
  // Members) marks the ROWS with a glyph instead and leaves its header plain,
  // so the same door never appears once per row under one more of itself.
  icon?: React.ReactElement<React.SVGProps<SVGSVGElement>>;
  rows: SidebarRow<T>[];
  roster?: boolean;
  dynamic?: boolean;
};

// One group of sidebar rows. A dynamic group (Rooms) borrows the roster's row
// shape - glyph on the left, name beside it, no extra indent - so a row that
// stands for a live thing never reads as one of the fixed rows above it.
//
// A group with onToggle has a header that opens and closes it; `collapsed`
// hides its rows.
export function SidebarGroupRows<T>({
  group,
  first,
  onSelect,
  collapsed = false,
  onToggle,
  rowAttrs,
}: {
  group: SidebarGroup<T>;
  first: boolean;
  onSelect: (target: T) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  // Extra attributes for each row's button, such as a data-* marker.
  rowAttrs?: (row: SidebarRow<T>) => Record<string, string>;
}) {
  if (group.rows.length === 0) return null;
  const dynamic = !!group.dynamic;
  return (
    <>
      {group.label !== undefined && (
        <SidebarGroupHeader
          groupId={group.id}
          label={group.label}
          first={first}
          collapsed={collapsed}
          onToggle={onToggle}
          icon={
            group.icon && (
              <GroupIcon
                icon={group.icon}
                active={group.rows.some((row) => row.selected)}
              />
            )
          }
        />
      )}
      {!collapsed &&
        group.rows.map((row) => (
          <button
            key={row.key}
            {...rowAttrs?.(row)}
            onClick={() => onSelect(row.target)}
            aria-current={row.selected ? "true" : undefined}
            style={{
              display: dynamic ? "flex" : undefined,
              alignItems: dynamic ? "center" : undefined,
              gap: dynamic ? 10 : undefined,
              width: "100%",
              textAlign: "left",
              font: "inherit",
              // Fixed rows sit indented under their header; with no header
              // there is nothing to indent from.
              padding:
                dynamic || group.label === undefined
                  ? "8px 14px"
                  : "8px 14px 8px 22px",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
              border: "none",
              cursor: "pointer",
              background: row.selected ? "var(--bg-hover)" : "transparent",
              borderLeft: row.selected
                ? "2px solid var(--accent)"
                : "2px solid transparent",
            }}
          >
            {dynamic && <RoomGlyph />}
            {dynamic ? (
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.label}
              </span>
            ) : (
              row.label
            )}
          </button>
        ))}
    </>
  );
}

// A group's label. With onToggle it is a button that opens and closes the
// group, with a chevron that points down while the group is open.
export function SidebarGroupHeader({
  groupId,
  label,
  first,
  collapsed = false,
  onToggle,
  icon,
}: {
  groupId: string;
  label: string;
  first: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  icon?: React.ReactNode;
}) {
  const style = { ...sidebarSectionLabel, marginTop: first ? 0 : 18 };
  if (!onToggle)
    return (
      <div style={style}>
        {icon}
        {label}
      </div>
    );
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      data-sidebar-group-toggle={groupId}
      style={{
        ...style,
        width: "100%",
        textAlign: "left",
        // Not the font shorthand: it would reset the label's small size.
        fontFamily: "inherit",
        lineHeight: "inherit",
        background: "none",
        border: "none",
        cursor: "pointer",
      }}
    >
      {icon}
      {label}
      {/* An SVG, not a shape glyph: iOS Safari draws those as emoji and
          ignores their color. */}
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{
          flexShrink: 0,
          transform: collapsed ? "rotate(-90deg)" : undefined,
          transition: "transform 0.15s",
        }}
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

// A group's header marker: the nav bar's icon, which draws itself at 15px
// against an 11px label, brought down to the sidebar's 10px label. The icons
// are elements rather than components, so the size arrives through
// cloneElement; a smaller wrapper box would clip them instead. The group
// holding the open row lifts to --text-primary, the same emphasis its row
// carries.
function GroupIcon({
  icon,
  active,
}: {
  icon: React.ReactElement<React.SVGProps<SVGSVGElement>>;
  active: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "flex",
        flexShrink: 0,
        color: active ? "var(--text-primary)" : "var(--text-dim)",
      }}
    >
      {cloneElement(icon, { width: 13, height: 13 })}
    </span>
  );
}

// The Rooms rows' counterpart to the roster's ghost: the nav bar's door,
// drawn at the ghost's size so both lists line up, and dimmed to the weight a
// row marker carries rather than the label's.
function RoomGlyph() {
  return (
    <span
      aria-hidden="true"
      style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }}
    >
      {cloneElement(DoorIcon, { width: 22, height: 22 })}
    </span>
  );
}

export const sidebarSectionLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-ghost)",
  padding: "0 14px",
  marginBottom: 6,
};
