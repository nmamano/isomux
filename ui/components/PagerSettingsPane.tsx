// Settings → You → Pager: where the member's pages go, in three sections:
// this device (Web Push, PushDevicesBlock), Discord (the webhook, the user to
// mention and a test send), and how often an open page repeats, which saves
// on its own. Server side: server/pager-settings.ts and the pagerSettings.*
// routes.
//
// The webhook URL is a credential: the server only ever returns its masked
// form, so the field starts empty and a typed URL replaces the saved one.

import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type {
  PagerSettingsReq,
  PagerSettingsRes,
  PagerTestRes,
} from "../../shared/contract-shapes.ts";
import type { PagerDeliveryFailure } from "../../shared/types.ts";
import type { MessageKey } from "../../shared/i18n/en.ts";
import {
  cardActionBtn,
  dialogHint,
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
  disabledLook,
} from "./dialog-styles.ts";
import { sectionHeader, hint, cardStyle } from "./access-shared.tsx";
import { HelpTip } from "../integrations/kit.tsx";
import { MaskedInput } from "./MaskedInput.tsx";
import { Reserved } from "./Reserved.tsx";
import { getPagerLayout, setPagerLayout } from "../device-settings.ts";
import { PushDevicesBlock } from "./PushDevicesBlock.tsx";

const REPEAT_CHOICES = [1, 5, 15, 30, 60, 480, 1440];

// A delivery failure class, in words.
export const PAGER_FAILURE_KEYS = {
  no_webhook: "pager.failure.noWebhook",
  http_4xx: "pager.failure.http4xx",
  http_5xx: "pager.failure.http5xx",
  rate_limited: "pager.failure.rateLimited",
  network: "pager.failure.network",
} as const satisfies Record<PagerDeliveryFailure, MessageKey>;
const NEVER = "never";
// The space a saved webhook's row takes while the settings load: the shape of
// a masked URL (server/pager-settings.ts maskWebhookUrl).
const HELD_WEBHOOK = "https://discord.com/api/webhooks/…0000";

export function PagerSettingsPane({ username }: { username: string }) {
  const { t, tn } = useI18n();
  const path = `/api/users/${encodeURIComponent(username)}/pager-settings`;
  const [saved, setSaved] = useState<PagerSettingsRes | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [url, setUrl] = useState("");
  const [userId, setUserId] = useState("");
  const [repeat, setRepeat] = useState<string>(NEVER);
  const [busy, setBusy] = useState(false);
  // The result line, shown in the section that acted.
  const [status, setStatus] = useState<{
    ok: boolean;
    text: string;
    at: "discord" | "repeat";
  } | null>(null);
  const mounted = useRef(true);
  // While the settings load, the pane shows the form it showed last on this
  // device with nothing to act on, so it keeps its height when they arrive.
  const [held] = useState(getPagerLayout);
  const loading = !saved && !loadFailed;

  function adoptRepeat(next: PagerSettingsRes) {
    setSaved(next);
    setRepeat(next.repeatMinutes === null ? NEVER : String(next.repeatMinutes));
  }

  function adopt(next: PagerSettingsRes) {
    adoptRepeat(next);
    setPagerLayout({ webhook: !!next.webhookUrlMasked });
    setUrl("");
    setUserId(next.discordUserId ?? "");
  }

  useEffect(() => {
    mounted.current = true;
    apiFetch<PagerSettingsRes>("GET", path)
      .then((next) => {
        if (mounted.current) adopt(next);
      })
      .catch(() => {
        if (mounted.current) setLoadFailed(true);
      });
    return () => {
      mounted.current = false;
    };
  }, [path]);

  // The Discord fields save together; the repeat saves on its own.
  const change: PagerSettingsReq = {};
  if (saved) {
    if (url.trim() !== "") change.webhookUrl = url.trim();
    if (userId.trim() !== (saved.discordUserId ?? "")) {
      change.discordUserId = userId.trim() === "" ? null : userId.trim();
    }
  }
  const dirty = Object.keys(change).length > 0;

  async function run(
    at: "discord" | "repeat",
    work: () => Promise<{ ok: boolean; text: string }>,
  ) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await work();
      if (mounted.current) setStatus({ ...result, at });
    } catch (e) {
      if (mounted.current) {
        setStatus({
          ok: false,
          text: e instanceof ApiError ? e.message : t("common.saveFailed"),
          at,
        });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const save = (body: PagerSettingsReq) =>
    run("discord", async () => {
      const next = await apiFetch<PagerSettingsRes>("PATCH", path, body);
      if (mounted.current) adopt(next);
      return { ok: true, text: t("pager.settings.saved") };
    });

  // A typed but unsaved webhook URL or user ID stays in its field.
  const saveRepeat = (value: string) => {
    setRepeat(value);
    return run("repeat", async () => {
      const next = await apiFetch<PagerSettingsRes>("PATCH", path, {
        repeatMinutes: value === NEVER ? null : Number(value),
      });
      if (mounted.current) adoptRepeat(next);
      return { ok: true, text: t("pager.settings.saved") };
    });
  };

  const test = () =>
    run("discord", async () => {
      const res = await apiFetch<PagerTestRes>("POST", `${path}/test`);
      return res.delivered
        ? { ok: true, text: t("pager.settings.testSent") }
        : {
            ok: false,
            text: t("pager.settings.testFailed", {
              reason: t(PAGER_FAILURE_KEYS[res.failure]),
            }),
          };
    });

  const repeatOptions = [...REPEAT_CHOICES];
  if (
    saved?.repeatMinutes != null &&
    !repeatOptions.includes(saved.repeatMinutes)
  ) {
    repeatOptions.push(saved.repeatMinutes);
    repeatOptions.sort((a, b) => a - b);
  }

  // The saved webhook, or the line that says there is none. `masked` null:
  // none. The held copy, while loading, carries no test ids.
  const webhookCurrent = (masked: string | null, live = true) =>
    masked ? (
      <div
        data-testid={live ? "pager-webhook-current" : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--green-text)",
          }}
        >
          {t("pager.settings.webhookSaved")}
        </span>
        <code
          style={{
            fontSize: 11,
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--bg-code)",
            color: "var(--text-secondary)",
            wordBreak: "break-all",
          }}
        >
          {masked}
        </code>
        <button
          data-testid={live ? "pager-webhook-remove" : undefined}
          onClick={() => void save({ webhookUrl: null })}
          disabled={busy}
          style={{
            ...secondaryBtn,
            ...(busy ? disabledLook : null),
          }}
        >
          {t("pager.settings.webhookRemove")}
        </button>
      </div>
    ) : (
      <p
        style={{ ...dialogHint, margin: "6px 0 0" }}
        data-testid={live ? "pager-webhook-current" : undefined}
      >
        {t("pager.settings.webhookNone")}
      </p>
    );

  const statusLine = (at: "discord" | "repeat") =>
    status?.at === at && (
      <span
        role="status"
        data-testid="pager-status"
        data-ok={status.ok}
        style={{
          fontSize: 11,
          color: status.ok ? "var(--text-muted)" : "var(--red-text)",
        }}
      >
        {status.text}
      </span>
    );

  return (
    <div style={{ marginTop: 24 }} data-testid="pager-settings">
      <h4 style={sectionHeader}>{t("settings.sidebar.pager")}</h4>
      <p style={{ ...hint, marginTop: 4 }}>{t("pager.settings.intro")}</p>

      <h5 style={subHeader}>{t("pager.settings.thisDevice")}</h5>
      <PushDevicesBlock username={username} />

      <h5 style={subHeader}>{t("pager.settings.discord")}</h5>
      {loadFailed ? (
        <p role="alert" style={hint}>
          {t("pager.settings.loadFailed")}
        </p>
      ) : (
        <div inert={loading} aria-busy={loading}>
          <div style={cardStyle}>
            <label
              style={{ ...dialogLabel, marginTop: 0 }}
              htmlFor="pager-webhook"
            >
              {t("pager.settings.webhook")}
              <HelpTip text={t("pager.settings.webhookHint")} />
            </label>
            <MaskedInput
              id="pager-webhook"
              data-testid="pager-webhook"
              value={url}
              placeholder="https://discord.com/api/webhooks/…"
              onChange={(e) => {
                setUrl(e.target.value);
                setStatus(null);
              }}
              style={dialogInput}
            />
            {loading ? (
              <Reserved>
                {webhookCurrent(held.webhook ? HELD_WEBHOOK : null, false)}
              </Reserved>
            ) : (
              webhookCurrent(saved?.webhookUrlMasked ?? null)
            )}

            <label style={fieldLabel} htmlFor="pager-user-id">
              {t("pager.settings.userId")}
              <HelpTip
                text={`${t("pager.settings.userIdHint")} ${t("pager.settings.phoneHint")}`}
              />
            </label>
            <input
              id="pager-user-id"
              data-testid="pager-user-id"
              inputMode="numeric"
              autoComplete="off"
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                setStatus(null);
              }}
              style={dialogInput}
            />

            <div style={actionRow}>
              <button
                data-testid="pager-save"
                onClick={() => void save(change)}
                disabled={busy || !dirty}
                style={{
                  ...dialogSaveBtn,
                  ...(busy || !dirty ? disabledLook : null),
                }}
              >
                {busy ? t("common.saving") : t("common.save")}
              </button>
              <button
                data-testid="pager-test"
                onClick={() => void test()}
                disabled={busy || dirty || !saved?.webhookUrlMasked}
                style={{
                  ...cardActionBtn,
                  ...(busy || dirty || !saved?.webhookUrlMasked
                    ? disabledLook
                    : null),
                }}
              >
                {t("pager.settings.test")}
              </button>
              {loading && <span style={hint}>{t("common.loading")}</span>}
              {statusLine("discord")}
            </div>
          </div>

          <div style={{ ...actionRow, marginTop: 20 }}>
            <label style={{ ...dialogLabel, margin: 0 }} htmlFor="pager-repeat">
              {t("pager.settings.repeat")}
            </label>
            <select
              id="pager-repeat"
              data-testid="pager-repeat"
              value={loading ? "" : repeat}
              disabled={busy}
              onChange={(e) => void saveRepeat(e.target.value)}
              style={selectStyle}
            >
              {/* Nothing chosen until the settings arrive. */}
              {loading && <option value="" />}
              <option value={NEVER}>{t("pager.settings.repeatNever")}</option>
              {repeatOptions.map((m) => (
                <option key={m} value={String(m)}>
                  {m >= 60 && m % 60 === 0
                    ? tn("pager.settings.repeatEveryHours", m / 60)
                    : t("pager.settings.repeatEvery", { count: m })}
                </option>
              ))}
            </select>
            {statusLine("repeat")}
          </div>
        </div>
      )}
    </div>
  );
}

const subHeader: React.CSSProperties = {
  margin: "20px 0 8px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-primary)",
};

const actionRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
  marginTop: 14,
};

// Each field after the first sits under a hairline, so the three settings
// read as separate steps.
const fieldLabel: React.CSSProperties = {
  ...dialogLabel,
  marginTop: 18,
  paddingTop: 14,
  borderTop: "1px solid var(--border)",
};

// A filled button: a transparent one vanished on the card.
const secondaryBtn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-medium)",
  background: "var(--bg-code)",
  color: "var(--text-secondary)",
  fontSize: 11,
  cursor: "pointer",
};

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-medium)",
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  fontSize: 13,
  cursor: "pointer",
};
