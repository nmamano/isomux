import { useRef } from "react";
import {
  ROOM_VIEW_LEVELS,
  type RoomViewLevel,
} from "../../shared/room-view-level.ts";
import { useI18n } from "../i18n.tsx";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";

const LEVEL_NAME: Record<RoomViewLevel, PlainMessageKey> = {
  hidden: "settings.room.viewLevel.hidden",
  tucked: "settings.room.viewLevel.tucked",
  shown: "settings.room.viewLevel.shown",
  notify: "settings.room.viewLevel.notify",
  push: "settings.room.viewLevel.push",
};

// The tallest bar; each step down is 3 px shorter.
const BAR_MAX = { pane: 18, row: 16 } as const;

// One room's view level as a five-step bar: the steps up to the chosen one
// are filled, so the order reads at a glance. "pane" names every step under
// it; "row" fits a Settings > Rooms table cell and names only the chosen one.
export function RoomViewLevelControl({
  level,
  onChange,
  roomName,
  size,
  disabled = false,
}: {
  level: RoomViewLevel;
  onChange: (level: RoomViewLevel) => void;
  roomName: string;
  size: "pane" | "row";
  disabled?: boolean;
}): React.ReactElement {
  const { t } = useI18n();
  const groupRef = useRef<HTMLDivElement>(null);
  const rank = ROOM_VIEW_LEVELS.indexOf(level);
  const pane = size === "pane";

  function pick(next: RoomViewLevel) {
    if (disabled || next === level) return;
    onChange(next);
    // Focus follows the checked step, as in a native radio group.
    groupRef.current
      ?.querySelector<HTMLButtonElement>(
        `[role="radio"][data-view-level="${next}"]`,
      )
      ?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const last = ROOM_VIEW_LEVELS.length - 1;
    let to: number;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") to = rank + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") to = rank - 1;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = last;
    else return;
    e.preventDefault();
    pick(ROOM_VIEW_LEVELS[Math.max(0, Math.min(last, to))]);
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={t("settings.room.viewLevelFor", { room: roomName })}
      aria-disabled={disabled || undefined}
      data-view-level={level}
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        alignItems: pane ? "stretch" : "center",
        gap: pane ? 4 : 8,
        marginTop: pane ? 10 : 0,
        opacity: disabled ? 0.35 : 1,
        minWidth: 0,
        maxWidth: pane ? 480 : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: pane ? 4 : 0,
          flex: pane ? 1 : "none",
          minWidth: 0,
        }}
      >
        {ROOM_VIEW_LEVELS.map((l, i) => {
          const checked = l === level;
          const filled = i <= rank;
          return (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={t(LEVEL_NAME[l])}
              data-view-level={l}
              data-filled={filled ? "true" : "false"}
              tabIndex={checked ? 0 : -1}
              disabled={disabled}
              onClick={() => pick(l)}
              style={{
                // A step is as wide as its name and shares the rest, so a
                // long name never breaks.
                flex: pane ? "1 1 auto" : "none",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
                justifyContent: "flex-start",
                gap: 4,
                // A row step is a touch target of 18 x 24 px.
                padding: pane ? "2px 0" : "4px 3px",
                border: "none",
                background: "transparent",
                cursor: disabled ? "default" : "pointer",
              }}
            >
              {/* The bars grow step by step, so the order shows without the
                  names. They stand on one baseline. */}
              <span
                aria-hidden
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  height: BAR_MAX[size],
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: pane ? "100%" : 12,
                    height:
                      BAR_MAX[size] - (ROOM_VIEW_LEVELS.length - 1 - i) * 3,
                    borderRadius: 2,
                    background: filled ? "var(--accent)" : "var(--text-ghost)",
                    opacity: filled ? 1 : 0.3,
                    boxShadow: checked
                      ? "0 0 0 1.5px var(--text-primary)"
                      : undefined,
                  }}
                />
              </span>
              {pane && (
                <span
                  aria-hidden
                  style={{
                    fontSize: 10,
                    lineHeight: 1.2,
                    textAlign: "center",
                    whiteSpace: "nowrap",
                    color: checked ? "var(--accent-text)" : "var(--text-muted)",
                    fontWeight: checked ? 600 : 400,
                  }}
                >
                  {t(LEVEL_NAME[l])}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {!pane && (
        <span
          aria-hidden
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {t(LEVEL_NAME[level])}
        </span>
      )}
    </div>
  );
}
