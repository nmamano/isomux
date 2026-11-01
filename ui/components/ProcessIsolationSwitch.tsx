// The owner's switch for one PID namespace per agent (task 8db21c8b), with
// the line that says why it cannot work on this host. It saves at once, as
// the Record terminals switch does, but with the Office pane's settings
// version: a change by another writer since the pane's read is a conflict
// here too, and only this switch's own write moves the pane's version.
import { useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type { OfficeSettingsRes } from "../../shared/contract-shapes.ts";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async (value: boolean) => {
    if (version === null) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch("PUT", "/api/office/settings", {
        version,
        processIsolation: value,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "version_conflict")
        onConflict();
      else setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
      return;
    }
    try {
      onSaved(await apiFetch<OfficeSettingsRes>("GET", "/api/office/settings"));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  // An older server sends neither field: show nothing.
  if (settings && settings.processIsolation === undefined) return null;
  const status = settings?.processIsolationStatus;
  const unavailable =
    status === "needs_linux"
      ? t("settings.office.processIsolationNeedsLinux")
      : status === "no_bwrap"
        ? t("settings.office.processIsolationNoBwrap")
        : status === "denied"
          ? t("settings.office.processIsolationDenied")
          : null;
  return (
    <div style={{ marginTop: 14 }}>
      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 12,
          color: "var(--text-primary)",
        }}
      >
        <input
          type="checkbox"
          checked={settings?.processIsolation === true}
          disabled={settings === null || version === null || busy}
          onChange={(event) => void change(event.target.checked)}
        />
        {t("settings.office.processIsolation")}
      </label>
      <p
        style={{ fontSize: 10, color: "var(--text-ghost)", margin: "3px 0 0" }}
      >
        {t("settings.office.processIsolationHint")}
      </p>
      {unavailable && (
        <p
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            margin: "4px 0 0",
          }}
        >
          {unavailable}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
