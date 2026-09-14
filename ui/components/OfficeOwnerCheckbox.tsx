import { useId } from "react";
import { useI18n } from "../i18n.tsx";

export function OfficeOwnerCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  const hintId = useId();
  return (
    <div style={{ marginTop: 12, marginBottom: 12 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--text-primary)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={hintId}
          style={{ accentColor: "var(--accent)" }}
        />
        {t("settings.role.officeOwner")}
      </label>
      <p
        id={hintId}
        style={{
          margin: "4px 0 0 22px",
          fontSize: 11,
          lineHeight: 1.5,
          color: "var(--text-muted)",
        }}
      >
        {t("settings.role.officeOwnerExplanation")}
      </p>
    </div>
  );
}
