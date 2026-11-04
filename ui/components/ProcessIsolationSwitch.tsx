// The owner's switch for one PID namespace per agent (task 8db21c8b), with
// the line that says why it cannot work on this host.
import { useI18n } from "../i18n.tsx";
import type { OfficeSettingsRes } from "../../shared/contract-shapes.ts";
import { OfficeSettingSwitch } from "./OfficeSettingSwitch.tsx";

export function ProcessIsolationSwitch({
  settings,
  version,
  onSaved,
  onConflict,
}: {
  // From the pane's settings read; null until it loads.
  settings: Pick<
    OfficeSettingsRes,
    "processIsolation" | "processIsolationStatus"
  > | null;
  version: string | null;
  // The settings read after this switch's own write.
  onSaved: (next: OfficeSettingsRes) => void;
  onConflict: () => void;
}) {
  const { t } = useI18n();
  const status = settings?.processIsolationStatus;
  const unavailable =
    status === "needs_linux"
      ? t("settings.office.processIsolationNeedsLinux")
      : status === "no_bwrap"
        ? t("settings.office.processIsolationNoBwrap")
        : status === "denied"
          ? t("settings.office.processIsolationDenied")
          : status === "apparmor"
            ? t("settings.office.processIsolationAppArmor")
            : null;
  return (
    <OfficeSettingSwitch
      field="processIsolation"
      // An older server sends neither field: show nothing.
      checked={settings ? settings.processIsolation : null}
      version={version}
      label={t("settings.office.processIsolation")}
      hint={t("settings.office.processIsolationHint")}
      note={unavailable}
      onSaved={onSaved}
      onConflict={onConflict}
    />
  );
}
