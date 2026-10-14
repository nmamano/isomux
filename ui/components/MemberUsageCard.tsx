import { useEffect, useState, type CSSProperties } from "react";
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
import { Reserved } from "./Reserved.tsx";
import {
  getMemberUsageLayout,
  setMemberUsageLayout,
} from "../device-settings.ts";
import {
  dialogCancelBtn,
  dialogInput,
  dialogSaveBtn,
} from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";

// The member usage cap, on the Integrations page's Model providers tab beside
// the office sign-ins it limits. It shares the office settings blob (and its version)
// with the Office pane's name and prompt, so the PUT sends back the prompt it
// read and omits the name: the server treats an absent prompt as a clear and
// an absent name as keep. Owners only; a server from before the switch
// omits it, and then the card does not render.
//
// While the settings load, the switch is neither on nor off, and the card
// holds the space of the share row and status lines it showed last on this
// device: the read waits on the providers while the cap is on, so it can take
// a second.
export function MemberUsageCard({
  style,
}: {
  // The Integrations page lays the card flat inside its own card.
  style?: CSSProperties;
} = {}) {
  const { t, language } = useI18n();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<OfficeSettingsRes | null>(null);
  const [usageCap, setUsageCap] = useState(false);
  const [usageShare, setUsageShare] = useState(DEFAULT_MEMBER_SHARE);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reserve] = useState(getMemberUsageLayout);

  function adopt(next: OfficeSettingsRes) {
    setSettings(next);
    setUsageCap(next.memberUsageCap ?? false);
    setUsageShare(next.memberUsageShare ?? DEFAULT_MEMBER_SHARE);
    if (next.memberUsageCap !== undefined)
      setMemberUsageLayout({
        share: next.memberUsageCap && next.memberUsageShare !== undefined,
        status: next.memberUsageCap ? (next.memberUsageStatus ?? []).length : 0,
      });
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

  if (!loading && (!settings || settings.memberUsageCap === undefined))
    return null;

  const baselineCap = settings?.memberUsageCap ?? false;
  const baselineShare = settings?.memberUsageShare ?? DEFAULT_MEMBER_SHARE;
  const shareKnown = settings?.memberUsageShare !== undefined;
  const dirty = usageCap !== baselineCap || usageShare !== baselineShare;

  const shareRow = (
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
  );

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
    <section
      data-member-usage-card
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
      {loading
        ? reserve.share && <Reserved>{shareRow}</Reserved>
        : usageCap && shareKnown && shareRow}
      {loading && reserve.status > 0 && (
        <Reserved>
          {Array.from({ length: reserve.status }, (_, i) => (
            <p key={i} style={statusLineStyle}>
              {"\u00a0"}
            </p>
          ))}
        </Reserved>
      )}
      {baselineCap &&
        (settings?.memberUsageStatus ?? []).map((row) => (
          <p
            key={row.provider}
            style={{
              ...statusLineStyle,
              color:
                row.state === "failed"
                  ? "var(--red-text)"
                  : "var(--text-muted)",
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

const statusLineStyle: CSSProperties = { fontSize: 10, margin: "3px 0 0" };

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
