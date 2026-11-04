// An owner's office-wide checkbox that saves at once, as the Record terminals
// switch does, but with the Office pane's settings version: a change by
// another writer since the pane's read is a conflict here too, and only this
// switch's own write moves the pane's version.
import { useState, type ReactElement } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type { OfficeSettingsRes } from "../../shared/contract-shapes.ts";

export function OfficeSettingSwitch({
  field,
  checked,
  version,
  label,
  hint,
  note,
  onSaved,
  onConflict,
}: {
  // The settings field this checkbox writes.
  field: "processIsolation" | "claudeIsomuxLabel";
  // From the pane's settings read; null until it loads. Undefined when the
  // server does not know the field (an older server): nothing renders.
  checked: boolean | null | undefined;
  version: string | null;
  label: string;
  hint: string;
  // A line under the hint, for example why the switch has no effect here.
  note?: string | null;
  // The settings read after this switch's own write.
  onSaved: (next: OfficeSettingsRes) => void;
  onConflict: () => void;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async (value: boolean) => {
    if (version === null) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch("PUT", "/api/office/settings", {
        version,
        [field]: value,
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
  if (checked === undefined) return null;
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
          checked={checked === true}
          disabled={checked === null || version === null || busy}
          onChange={(event) => void change(event.target.checked)}
        />
        {label}
      </label>
      <p
        style={{ fontSize: 10, color: "var(--text-ghost)", margin: "3px 0 0" }}
      >
        {hint}
      </p>
      {note && (
        <p
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            margin: "4px 0 0",
          }}
        >
          {note}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
