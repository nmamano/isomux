import { Fragment } from "react";
import {
  ROOM_VIEW_LEVELS,
  type RoomViewLevel,
} from "../../shared/room-view-level.ts";
import { useI18n } from "../i18n.tsx";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { StepSlider } from "./StepSlider.tsx";

export const LEVEL_NAME: Record<RoomViewLevel, PlainMessageKey> = {
  hidden: "settings.room.viewLevel.hidden",
  tucked: "settings.room.viewLevel.tucked",
  shown: "settings.room.viewLevel.shown",
  notify: "settings.room.viewLevel.notify",
  push: "settings.room.viewLevel.push",
};

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
  return (
    <StepSlider
      steps={ROOM_VIEW_LEVELS}
      value={level}
      onChange={onChange}
      stepLabel={(l) => t(LEVEL_NAME[l])}
      ariaLabel={t("settings.room.viewLevelFor", { room: roomName })}
      attr="data-view-level"
      disabled={disabled}
    />
  );
}

export const LEVEL_MEANING: Record<RoomViewLevel, PlainMessageKey> = {
  hidden: "settings.room.viewLevelInfo.hidden",
  tucked: "settings.room.viewLevelInfo.tucked",
  shown: "settings.room.viewLevelInfo.shown",
  notify: "settings.room.viewLevelInfo.notify",
  push: "settings.room.viewLevelInfo.push",
};

// What each level means, under the names the control's steps show. `push`,
// when given, renders under the Push meaning (the this-device control).
export function RoomViewLevelLegend({
  style,
  push,
}: {
  style?: React.CSSProperties;
  push?: React.ReactNode;
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
        <Fragment key={l}>
          <li data-view-level={l} style={{ display: "contents" }}>
            <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>
              {t(LEVEL_NAME[l])}
            </strong>
            <span>{t(LEVEL_MEANING[l])}</span>
          </li>
          {l === "push" && push && (
            <li data-room-push-device style={{ gridColumn: 2 }}>
              {push}
            </li>
          )}
        </Fragment>
      ))}
    </ul>
  );
}
