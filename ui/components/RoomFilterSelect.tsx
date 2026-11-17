import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { ROOM_FILTER_ALL, ROOM_FILTER_NONE } from "../room-filter.ts";

// The room filter on the Apps and Automations pages: all rooms, no room, or one
// room.
export function RoomFilterSelect({
  value,
  rooms,
  onChange,
  disabled,
}: {
  value: string;
  rooms: readonly { id: string; name: string }[];
  onChange: (value: string) => void;
  // Shown dimmed, as while the list it filters loads.
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <select
      data-room-filter=""
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      disabled={disabled}
      title={t("roomFilter.title")}
      style={{
        padding: "4px 6px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--bg-input)",
        color: "var(--text-primary)",
        fontSize: 11,
        outline: "none",
        maxWidth: 160,
        opacity: disabled ? 0.5 : undefined,
      }}
    >
      <option value={ROOM_FILTER_ALL}>{t("roomFilter.all")}</option>
      <option value={ROOM_FILTER_NONE}>{t("roomFilter.none")}</option>
      {rooms.map((room) => (
        <option key={room.id} {...noTranslate()} value={room.id}>
          {room.name}
        </option>
      ))}
    </select>
  );
}
