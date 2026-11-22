import { dialogInput, disabledFieldLook } from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";
import type { MemberRoom } from "./ApiTokensPane.tsx";

// The rooms of a limited token: all rooms, or only the
// picked ones. `picked` is ids; the checkboxes list `rooms` in their order.
export function RoomPicker({
  scope,
  onScope,
  picked,
  onPicked,
  rooms,
  testId,
  disabled = false,
}: {
  scope: "all" | "some";
  onScope: (scope: "all" | "some") => void;
  picked: readonly string[];
  onPicked: (picked: string[]) => void;
  rooms: readonly MemberRoom[];
  testId: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <label style={{ display: "block", fontSize: 12, marginTop: 8 }}>
        {t("settings.apiTokens.rooms")}
        <select
          data-testid={testId}
          value={scope}
          onChange={(event) => onScope(event.target.value as "all" | "some")}
          disabled={disabled}
          style={{
            ...dialogInput,
            display: "block",
            width: "100%",
            marginTop: 5,
            ...(disabled ? disabledFieldLook : {}),
          }}
        >
          <option value="all">{t("settings.apiTokens.rooms.all")}</option>
          <option value="some">{t("settings.apiTokens.rooms.some")}</option>
        </select>
      </label>
      {scope === "some" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 10,
            fontSize: 12,
            ...(disabled ? { color: "var(--text-hint)" } : {}),
          }}
        >
          {rooms.map((room) => (
            <label
              key={room.id}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="checkbox"
                data-room={room.id}
                disabled={disabled}
                checked={picked.includes(room.id)}
                onChange={(event) =>
                  onPicked(
                    event.target.checked
                      ? [...picked, room.id]
                      : picked.filter((id) => id !== room.id),
                  )
                }
              />
              {room.name}
            </label>
          ))}
        </div>
      )}
    </>
  );
}
