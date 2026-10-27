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
const BAR_MAX = 18;

// One room's view level as a five-step bar: the steps up to the chosen one
// are filled, so the order reads at a glance, and every step shows its name.
// The room settings pane and the Settings > Rooms table draw the same one.
export function RoomViewLevelControl({
  level,
  onChange,
  roomName,
  disabled = false,
}: {
  level: RoomViewLevel;
  onChange: (level: RoomViewLevel) => void;
  roomName: string;
  disabled?: boolean;
}): React.ReactElement {
  const { t } = useI18n();
  const groupRef = useRef<HTMLDivElement>(null);
  const rank = ROOM_VIEW_LEVELS.indexOf(level);

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
        gap: 4,
        flex: 1,
        opacity: disabled ? 0.35 : 1,
        minWidth: 0,
        maxWidth: 480,
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
              flex: "1 1 auto",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              justifyContent: "flex-start",
              gap: 4,
              padding: "2px 0",
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
                height: BAR_MAX,
              }}
            >
              <span
                style={{
                  display: "block",
                  width: "100%",
                  height: BAR_MAX - (ROOM_VIEW_LEVELS.length - 1 - i) * 3,
                  borderRadius: 2,
                  background: filled ? "var(--accent)" : "var(--text-ghost)",
                  opacity: filled ? 1 : 0.3,
                  boxShadow: checked
                    ? "0 0 0 1.5px var(--text-primary)"
                    : undefined,
                }}
              />
            </span>
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
          </button>
        );
      })}
    </div>
  );
}

const LEVEL_MEANING: Record<RoomViewLevel, PlainMessageKey> = {
  hidden: "settings.room.viewLevelInfo.hidden",
  tucked: "settings.room.viewLevelInfo.tucked",
  shown: "settings.room.viewLevelInfo.shown",
  notify: "settings.room.viewLevelInfo.notify",
  push: "settings.room.viewLevelInfo.push",
};

// What each level means, under the names the control's steps show.
export function RoomViewLevelLegend({
  style,
}: {
  style?: React.CSSProperties;
}): React.ReactElement {
  const { t } = useI18n();
  return (
    <ul
      data-room-view-legend
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        // Names in one column, meanings in the next.
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        gap: "3px 10px",
        fontSize: 11,
        lineHeight: 1.45,
        color: "var(--text-muted)",
        ...style,
      }}
    >
      {ROOM_VIEW_LEVELS.map((l) => (
        <li key={l} data-view-level={l} style={{ display: "contents" }}>
          <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>
            {t(LEVEL_NAME[l])}
          </strong>
          <span>{t(LEVEL_MEANING[l])}</span>
        </li>
      ))}
    </ul>
  );
}
