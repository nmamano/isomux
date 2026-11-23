import { useState } from "react";
import { getDevice, setDevice } from "../device-settings.ts";
import { sectionHeader, hint as hintStyle } from "./access-shared.tsx";
import { OfficeInstallEntry } from "./OfficeInstallNotice.tsx";
import { useI18n } from "../i18n.tsx";
import { dialogLabel, dialogInput, dialogHint } from "./dialog-styles.ts";
import { useUnsavedChangesPrompt } from "./UnsavedChangesPrompt.tsx";
import { SettingsFormLayout, SettingsSaveFooter } from "./SettingsItemPage.tsx";

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
  onOpenNewDevice,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
  // Opens Settings > New device, from Install as app (OfficeInstallEntry).
  onOpenNewDevice?: () => void;
}) {
  const { t } = useI18n();
  const [storedLabel, setStoredLabel] = useState(() => getDevice() ?? "");
  const [label, setLabel] = useState<string>(storedLabel);
  // A save succeeded since the pane opened.
  const [saved, setSaved] = useState(false);
  const dirty = label.trim() !== storedLabel;

  const discardPrompt = useUnsavedChangesPrompt(dirty, {
    closeRef,
    onDiscard: () => setLabel(storedLabel),
  });

  function handleSave() {
    if (!dirty) return;
    const next = label.trim();
    setDevice(next || null);
    setStoredLabel(next);
    setLabel(next);
    setSaved(true);
  }

  return (
    <SettingsFormLayout
      footer={
        <SettingsSaveFooter
          error={null}
          prompt={discardPrompt}
          dirty={dirty}
          saving={false}
          saved={saved}
          onCancel={() => setLabel(storedLabel)}
          onSave={handleSave}
        />
      }
    >
      <div style={{ marginTop: 24 }}>
        <h4 style={sectionHeader}>{t("settings.sidebar.deviceLabel")}</h4>
        <p style={hintStyle}>{t("settings.device.intro")}</p>

        <label style={labelStyle}>
          {t("settings.device.label")}{" "}
          <span style={hintTextStyle}>{t("settings.device.optional")}</span>
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value.slice(0, 24))}
          maxLength={24}
          placeholder={t("settings.device.placeholder")}
          style={{ ...inputStyle, maxWidth: 320 }}
          onKeyDown={(e) => {
            // The same save as the footer's Save, so a clean form saves
            // nothing.
            if (e.key === "Enter") handleSave();
          }}
        />
        <OfficeInstallEntry onOpenNewDevice={onOpenNewDevice} />
      </div>
    </SettingsFormLayout>
  );
}

const labelStyle: React.CSSProperties = { ...dialogLabel, marginTop: 16 };
const hintTextStyle: React.CSSProperties = dialogHint;
const inputStyle: React.CSSProperties = dialogInput;
