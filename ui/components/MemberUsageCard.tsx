import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  OfficeSettingsReq,
  OfficeSettingsRes,
  OfficeUsageStatusWire,
} from "../../shared/contract-shapes.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import {
  DEFAULT_MEMBER_SHARE,
  MEMBER_SHARE_OPTIONS,
} from "../../shared/member-usage-share.ts";
import { cardStyle } from "./access-shared.tsx";
import {
  dialogCancelBtn,
  dialogInput,
  dialogSaveBtn,
} from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";

// The member usage cap, on the office half of Connections beside the office
// sign-ins it limits. It shares the office settings blob (and its version)
// with the Office pane's name and prompt, so the PUT sends back the prompt it
// read and omits the name: the server treats an absent prompt as a clear and
// an absent name as keep. Owners only; a server from before the switch
// omits it, and then the card does not render.
export function MemberUsageCard() {
  const { t, language } = useI18n();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<OfficeSettingsRes | null>(null);
  const [usageCap, setUsageCap] = useState(false);
  const [usageShare, setUsageShare] = useState(DEFAULT_MEMBER_SHARE);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function adopt(next: OfficeSettingsRes) {
    setSettings(next);
    setUsageCap(next.memberUsageCap ?? false);
    setUsageShare(next.memberUsageShare ?? DEFAULT_MEMBER_SHARE);
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<OfficeSettingsRes>("GET", "/api/office/settings")
      .then((r) => {
        if (!cancelled) adopt(r);
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

  if (!loading && (!settings || settings.memberUsageCap === undefined)) return null;

  const baselineCap = settings?.memberUsageCap ?? false;
  const baselineShare = settings?.memberUsageShare ?? DEFAULT_MEMBER_SHARE;
  const shareKnown = settings?.memberUsageShare !== undefined;
  const dirty = usageCap !== baselineCap || usageShare !== baselineShare;

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    const body: OfficeSettingsReq = {
      prompt: settings.prompt ?? null,
      version: settings.version,
      memberUsageCap: usageCap,
      ...(shareKnown ? { memberUsageShare: usageShare } : {}),
    };
    try {
      await apiFetch<void>("PUT", "/api/office/settings", body);
      setSavedAt(Date.now());
      try {
        adopt(await apiFetch<OfficeSettingsRes>("GET", "/api/office/settings"));
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
      setSaving(false);
    }
  }

  return (
    <section aria-busy={loading} style={{ ...cardStyle, marginTop: 14 }}>
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
          disabled={loading}
          checked={usageCap}
          onChange={(e) => setUsageCap(e.target.checked)}
        />
        <span>{t("settings.office.memberUsageCap")}</span>
      </label>
      <p
        style={{
          fontSize: 10,
          color: "var(--text-ghost)",
          margin: "3px 0 0",
          lineHeight: 1.4,
        }}
      >
        {t("settings.office.memberUsageCapHint")}
      </p>
      {usageCap && shareKnown && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 8,
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          <span>{t("settings.office.memberUsageShare")}</span>
          <select
            value={usageShare}
            onChange={(e) => setUsageShare(Number(e.target.value))}
            style={{
              ...dialogInput,
              width: "auto",
              padding: "2px 6px",
              cursor: "pointer",
            }}
          >
            {MEMBER_SHARE_OPTIONS.map((share) => (
              <option key={share} value={share}>
                {t("settings.office.memberUsageShareOption", {
                  share: formatNumber(language, share),
                })}
              </option>
            ))}
          </select>
        </label>
      )}
      {baselineCap &&
        (settings?.memberUsageStatus ?? []).map((row) => (
          <p
            key={row.provider}
            style={{
              fontSize: 10,
              color:
                row.state === "failed"
                  ? "var(--red-text)"
                  : "var(--text-muted)",
              margin: "3px 0 0",
            }}
          >
            {usageStatusLine(row, t, language)}
          </p>
        ))}
      {error && (
        <p
          role="alert"
          style={{ color: "var(--red-text)", fontSize: 11, margin: "6px 0 0" }}
        >
          {error}
        </p>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 12,
        }}
      >
        <button
          onClick={() => {
            setUsageCap(baselineCap);
            setUsageShare(baselineShare);
            setError(null);
          }}
          style={dialogCancelBtn}
          disabled={loading || saving || !dirty}
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={() => void handleSave()}
          style={dialogSaveBtn}
          disabled={loading || saving || !dirty}
        >
          {saving
            ? t("common.saving")
            : savedAt && !dirty
              ? t("common.saved")
              : t("common.save")}
        </button>
      </div>
    </section>
  );
}

// One status line of the member usage cap. Provider names are proper nouns.
function usageStatusLine(
  row: OfficeUsageStatusWire,
  t: ReturnType<typeof useI18n>["t"],
  language: ReturnType<typeof useI18n>["language"],
): string {
  const provider = row.provider === "claude" ? "Claude" : "Codex";
  if (row.state !== "weekly")
    return row.state === "no_limit"
      ? t("settings.office.memberUsageNoLimit", { provider })
      : t("settings.office.memberUsageFailed", { provider });
  return t("settings.office.memberUsageWeekly", {
    provider,
    used: formatNumber(language, Math.round(row.usedPercent)),
    // One decimal: a rounded line (11% for 11.4%) would read as a stop at a
    // use that still runs.
    line: formatNumber(language, Math.round(row.linePercent * 10) / 10),
  });
}
