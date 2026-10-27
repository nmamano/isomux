import { useEffect, useRef, useState, type CSSProperties } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  OfficeSettingsReq,
  OfficeSettingsRes,
  OfficeUsageStatusRes,
  OfficeUsageStatusWire,
} from "../../shared/contract-shapes.ts";
import type { ProviderAccountProvider } from "../../shared/types.ts";
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
  disabledLook,
} from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";

// The owner's switches for the office sign-ins, on the Integrations page's
// Model providers tab beside them: the member usage cap, and the fallback to
// the office sign-in (server/provider-fallback.ts). One Save writes both. The
// card shares the office settings blob (and its version) with the Office
// pane's name and the Audit pane's Record terminals, so the PUT omits those,
// which the server keeps. Owners only; a server from before the usage cap
// omits it, and then the card does not render. A server from before the
// fallback omits that, and then its switch does not render.
//
// While the settings load, the switches are neither on nor off, the card says
// it loads, and it holds the space of the share row and status lines it
// showed last on this device. The status lines have their own route, read per
// provider once the settings say the cap is on: a provider read can take
// seconds, and each line shows that it loads until its own answer comes.
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
  const [fallback, setFallback] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reserve] = useState(getMemberUsageLayout);
  // Per provider: undefined while its read is out, null when it has no line.
  const [status, setStatus] = useState<StatusSlots>({});
  // Each status read (and unmount) moves it on; an older answer is dropped.
  const statusRead = useRef(0);

  function adopt(next: OfficeSettingsRes) {
    setSettings(next);
    setUsageCap(next.memberUsageCap ?? false);
    setUsageShare(next.memberUsageShare ?? DEFAULT_MEMBER_SHARE);
    setFallback(next.providerFallback ?? false);
    if (next.memberUsageCap === undefined) return;
    const share = next.memberUsageCap && next.memberUsageShare !== undefined;
    if (next.memberUsageCap) readStatus(share);
    else {
      statusRead.current++;
      setStatus({});
      setMemberUsageLayout({ share, status: 0 });
    }
  }

  // A failed read has no line, with no error: the cap lets members through.
  function readStatus(share: boolean) {
    const read = ++statusRead.current;
    const slots: StatusSlots = { claude: undefined, codex: undefined };
    setStatus(slots);
    let pending = PROVIDERS.length;
    for (const provider of PROVIDERS)
      void apiFetch<OfficeUsageStatusRes>(
        "GET",
        `/api/office/member-usage-status?provider=${provider}`,
      )
        .then(
          (r) =>
            r.memberUsageStatus.find((row) => row.provider === provider) ??
            null,
          () => null,
        )
        .then((row) => {
          if (read !== statusRead.current) return;
          slots[provider] = row;
          setStatus({ ...slots });
          if (--pending === 0)
            setMemberUsageLayout({
              share,
              status: PROVIDERS.filter((p) => slots[p]).length,
            });
        });
  }

  useEffect(() => {
    let cancelled = false;
    // A counter, not a node: the cleanup wants its value at unmount.
    const reads = statusRead;
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
      reads.current++;
    };
  }, []);

  if (!loading && (!settings || settings.memberUsageCap === undefined))
    return null;

  const baselineCap = settings?.memberUsageCap ?? false;
  const baselineShare = settings?.memberUsageShare ?? DEFAULT_MEMBER_SHARE;
  const shareKnown = settings?.memberUsageShare !== undefined;
  const baselineFallback = settings?.providerFallback ?? false;
  const fallbackKnown = settings?.providerFallback !== undefined;
  const dirty =
    usageCap !== baselineCap ||
    usageShare !== baselineShare ||
    fallback !== baselineFallback;

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
    try {
      // The version of a fresh read: the Office and Audit panes write the
      // same settings, and the PUT carries only these fields.
      const { version } = await apiFetch<OfficeSettingsRes>(
        "GET",
        "/api/office/settings",
      );
      const body: OfficeSettingsReq = {
        version,
        memberUsageCap: usageCap,
        ...(shareKnown ? { memberUsageShare: usageShare } : {}),
        ...(fallbackKnown ? { providerFallback: fallback } : {}),
      };
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
      <label style={switchLabelStyle}>
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
      <p style={switchHintStyle}>{t("settings.office.memberUsageCapHint")}</p>
      {loading && (
        <p role="status" style={{ ...statusLineStyle, color: mutedText }}>
          {t("common.loading")}
        </p>
      )}
      {loading
        ? reserve.share && <Reserved>{shareRow}</Reserved>
        : usageCap && shareKnown && shareRow}
      {/* The loading line above takes the place of one held status line. */}
      {loading && reserve.status > 1 && (
        <Reserved>
          {Array.from({ length: reserve.status - 1 }, (_, i) => (
            <p key={i} style={statusLineStyle}>
              {"\u00a0"}
            </p>
          ))}
        </Reserved>
      )}
      {baselineCap &&
        PROVIDERS.map((provider) => {
          const row = status[provider];
          if (row === null || !(provider in status)) return null;
          return row === undefined ? (
            <p
              key={provider}
              data-usage-provider={provider}
              data-loading
              style={{ ...statusLineStyle, color: mutedText }}
            >
              {t("settings.office.memberUsageLoading", {
                provider: providerName(provider),
              })}
            </p>
          ) : (
            <p
              key={provider}
              data-usage-provider={provider}
              style={{
                ...statusLineStyle,
                color: row.state === "failed" ? "var(--red-text)" : mutedText,
              }}
            >
              {usageStatusLine(row, t, language)}
            </p>
          );
        })}
      {/* A new block after the Pace lines, above the Save row that writes it. */}
      {(loading || fallbackKnown) && (
        <div data-provider-fallback style={{ marginTop: 12 }}>
          <label style={switchLabelStyle}>
            <input
              type="checkbox"
              // Unknown until the settings arrive: never a real "off".
              ref={(box) => {
                if (box) box.indeterminate = loading;
              }}
              disabled={loading}
              checked={fallback}
              onChange={(e) => setFallback(e.target.checked)}
            />
            <span>{t("settings.office.providerFallback")}</span>
          </label>
          <p style={switchHintStyle}>
            {t("settings.office.providerFallbackHint")}
          </p>
        </div>
      )}
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
            setFallback(baselineFallback);
            setError(null);
          }}
          style={dialogCancelBtn}
          disabled={loading || saving || !dirty}
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={() => void handleSave()}
          style={{
            ...dialogSaveBtn,
            ...(loading || saving ? disabledLook : null),
          }}
          disabled={loading || saving}
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
const switchLabelStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  fontSize: 12,
  fontWeight: 650,
  color: "var(--text-primary)",
};
const switchHintStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--text-ghost)",
  margin: "3px 0 0",
  lineHeight: 1.4,
};
const mutedText = "var(--text-muted)";

// The status lines in the order they show.
const PROVIDERS: ProviderAccountProvider[] = ["claude", "codex"];

type StatusSlots = Partial<
  Record<ProviderAccountProvider, OfficeUsageStatusWire | null | undefined>
>;

// Provider names are proper nouns.
function providerName(provider: ProviderAccountProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

// One status line of the member usage cap.
function usageStatusLine(
  row: OfficeUsageStatusWire,
  t: ReturnType<typeof useI18n>["t"],
  language: ReturnType<typeof useI18n>["language"],
): string {
  const provider = providerName(row.provider);
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
