import { useEffect, useState, type CSSProperties } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  OfficeSettingsReq,
  OfficeSettingsRes,
} from "../../shared/contract-shapes.ts";
import { cardStyle } from "./access-shared.tsx";
import { useI18n } from "../i18n.tsx";

// The fallback to the office sign-in (server/provider-fallback.ts), on the
// Integrations page's Model providers tab beside the office sign-ins. Owners
// only. A change saves at once: the PUT carries the version of a fresh read
// and this field alone, so the server keeps the rest of the settings blob. A
// server from before the setting omits it, and then the card does not
// render.
export function ProviderFallbackCard({
  style,
}: {
  // The Integrations page lays the card flat inside its own card.
  style?: CSSProperties;
} = {}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<OfficeSettingsRes | null>(null);
  // The value a save in flight writes; the stored one shows otherwise.
  const [saving, setSaving] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<OfficeSettingsRes>("GET", "/api/office/settings")
      .then((r) => {
        if (!cancelled) setSettings(r);
      })
      .catch(() => {
        // No version to write with: hide the card after loading.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loading && settings?.providerFallback === undefined) return null;

  async function save(next: boolean) {
    if (!settings) return;
    setSaving(next);
    setError(null);
    try {
      // The version of a fresh read: the member usage card beside this one
      // writes the same settings, and the PUT carries only this field.
      const { version } = await apiFetch<OfficeSettingsRes>(
        "GET",
        "/api/office/settings",
      );
      const body: OfficeSettingsReq = { version, providerFallback: next };
      await apiFetch<void>("PUT", "/api/office/settings", body);
      try {
        setSettings(
          await apiFetch<OfficeSettingsRes>("GET", "/api/office/settings"),
        );
      } catch {
        setError(t("settings.office.reloadFailed"));
      }
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "version_conflict"
          ? t("settings.office.conflict")
          : e instanceof ApiError
            ? e.message
            : t("common.saveFailed"),
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <section
      data-provider-fallback-card
      aria-busy={loading}
      style={{ ...cardStyle, marginTop: 14, ...style }}
    >
      <label
        style={{
          display: "flex",
          gap: 6,
          fontSize: 12,
          fontWeight: 650,
          color: "var(--text-primary)",
        }}
      >
        <input
          type="checkbox"
          // Unknown until the settings arrive: never a real "off".
          ref={(box) => {
            if (box) box.indeterminate = loading;
          }}
          disabled={loading || saving !== null}
          checked={saving ?? settings?.providerFallback ?? false}
          onChange={(e) => void save(e.target.checked)}
        />
        <span>{t("settings.office.providerFallback")}</span>
      </label>
      <p
        style={{
          fontSize: 10,
          color: "var(--text-ghost)",
          margin: "3px 0 0",
          lineHeight: 1.4,
        }}
      >
        {t("settings.office.providerFallbackHint")}
      </p>
      {error && (
        <p
          role="alert"
          style={{ color: "var(--red-text)", fontSize: 11, margin: "6px 0 0" }}
        >
          {error}
        </p>
      )}
    </section>
  );
}
