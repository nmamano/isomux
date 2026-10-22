import { useState } from "react";
import {
  getDevice,
  getRoomTurn,
  setDevice,
  setRoomTurn,
  ROOM_TURNS,
  type RoomTurn,
} from "../device-settings.ts";
import { sectionHeader, hint as hintStyle } from "./access-shared.tsx";
import { OfficeInstallEntry } from "./OfficeInstallNotice.tsx";
import { useI18n } from "../i18n.tsx";
import {
  dialogLabel,
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
  dialogHint,
  disabledLook,
} from "./dialog-styles.ts";
import {
  UnsavedChangesPrompt,
  useUnsavedChangesPrompt,
} from "./UnsavedChangesPrompt.tsx";

// Device-scoped settings (one record per browser, stored in localStorage):
// the device label and the room switch animation, plus Install as app.
// User-level preferences (notifications, env, language) live on the server
// and are edited under You, so they follow the person rather than the
// browser.
//
// The label is dirty-capable, so this pane registers into the settings page's
// closeRef. Without that a sidebar click would drop a typed-but-unsaved label
// with no discard prompt.
export function DevicePane({
  closeRef,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { t } = useI18n();
  const saved = getDevice() ?? "";
  const [label, setLabel] = useState<string>(saved);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = label.trim() !== saved;

  const discardPrompt = useUnsavedChangesPrompt(dirty, closeRef, () => {
    setLabel(saved);
    setJustSaved(false);
  });

  function handleSave() {
    setDevice(label.trim() || null);
    setJustSaved(true);
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("settings.sidebar.deviceLabel")}</h4>
      <p style={hintStyle}>{t("settings.device.intro")}</p>

      <label style={labelStyle}>
        {t("settings.device.label")}{" "}
        <span style={hintTextStyle}>{t("settings.device.optional")}</span>
      </label>
      <input
        value={label}
        onChange={(e) => {
          setLabel(e.target.value.slice(0, 24));
          setJustSaved(false);
        }}
        maxLength={24}
        placeholder={t("settings.device.placeholder")}
        style={{ ...inputStyle, maxWidth: 320 }}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
        }}
      />

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button
          onClick={() => {
            setLabel(saved);
            setJustSaved(false);
          }}
          disabled={!dirty}
          style={{ ...cancelBtnStyle, ...(dirty ? null : disabledLook) }}
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={handleSave}
          disabled={!dirty}
          style={{ ...saveBtnStyle, ...(dirty ? null : disabledLook) }}
        >
          {justSaved && !dirty ? t("common.saved") : t("common.save")}
        </button>
      </div>
      <RoomTurnSetting />
      <OfficeInstallEntry />
      {discardPrompt.open && (
        <UnsavedChangesPrompt
          onDiscard={discardPrompt.discard}
          onCancel={discardPrompt.cancel}
        />
      )}
    </div>
  );
}

// Applies on change, outside the label's save and discard flow.
function RoomTurnSetting() {
  const { t } = useI18n();
  const [choice, setChoice] = useState<RoomTurn>(getRoomTurn);
  const name = (v: RoomTurn) =>
    v === "off"
      ? t("settings.roomTurn.off")
      : t("settings.roomTurn.ms", { ms: v.slice("turn-".length) });
  return (
    <>
      <h4 style={{ ...sectionHeader, marginTop: 32 }}>
        <label htmlFor="room-turn-select">{t("settings.roomTurn.title")}</label>
      </h4>
      <p style={hintStyle}>{t("settings.roomTurn.hint")}</p>
      <select
        id="room-turn-select"
        value={choice}
        onChange={(e) => {
          const v = ROOM_TURNS.find((c) => c === e.target.value) ?? "off";
          setRoomTurn(v);
          setChoice(v);
        }}
        style={{ ...inputStyle, maxWidth: 320 }}
      >
        {ROOM_TURNS.map((v) => (
          <option key={v} value={v}>
            {name(v)}
          </option>
        ))}
      </select>
    </>
  );
}

const labelStyle: React.CSSProperties = { ...dialogLabel, marginTop: 16 };
const hintTextStyle: React.CSSProperties = dialogHint;
const inputStyle: React.CSSProperties = dialogInput;
const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;
