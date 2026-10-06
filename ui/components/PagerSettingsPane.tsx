// Settings → You → Pager: where the member's pages go (a Discord webhook),
// the Discord user to mention, how often an open page repeats, and a test
// send. Server side: server/pager-settings.ts and the pagerSettings.* routes.
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

const REPEAT_CHOICES = [1, 5, 15, 30, 60, 480, 1440];
const ISSUES_URL = "https://github.com/nmamano/isomux/issues";

// A delivery failure class, in words.
export const PAGER_FAILURE_KEYS = {
  no_webhook: "pager.failure.noWebhook",
  http_4xx: "pager.failure.http4xx",
  http_5xx: "pager.failure.http5xx",
  rate_limited: "pager.failure.rateLimited",
  network: "pager.failure.network",
} as const satisfies Record<PagerDeliveryFailure, MessageKey>;
const NEVER = "never";

export function PagerSettingsPane({ username }: { username: string }) {
  const { t, tn, rich } = useI18n();
  const bold = (chunk: React.ReactNode) => (
    <strong style={{ color: "var(--text-secondary)" }}>{chunk}</strong>
  );
  const path = `/api/users/${encodeURIComponent(username)}/pager-settings`;
  const [saved, setSaved] = useState<PagerSettingsRes | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [url, setUrl] = useState("");
  const [userId, setUserId] = useState("");
  const [repeat, setRepeat] = useState<string>(NEVER);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const mounted = useRef(true);

  function adopt(next: PagerSettingsRes) {
    setSaved(next);
    setUrl("");
    setUserId(next.discordUserId ?? "");
    setRepeat(next.repeatMinutes === null ? NEVER : String(next.repeatMinutes));
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

  const repeatMinutes = repeat === NEVER ? null : Number(repeat);
  const change: PagerSettingsReq = {};
  if (saved) {
    if (url.trim() !== "") change.webhookUrl = url.trim();
    if (userId.trim() !== (saved.discordUserId ?? "")) {
      change.discordUserId = userId.trim() === "" ? null : userId.trim();
    }
    if (repeatMinutes !== saved.repeatMinutes) {
      change.repeatMinutes = repeatMinutes;
    }
  }
  const dirty = Object.keys(change).length > 0;

  async function run(work: () => Promise<{ ok: boolean; text: string }>) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await work();
      if (mounted.current) setStatus(result);
    } catch (e) {
      if (mounted.current) {
        setStatus({
          ok: false,
          text: e instanceof ApiError ? e.message : t("common.saveFailed"),
        });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const save = (body: PagerSettingsReq) =>
    run(async () => {
      const next = await apiFetch<PagerSettingsRes>("PATCH", path, body);
      if (mounted.current) adopt(next);
      return { ok: true, text: t("pager.settings.saved") };
    });

  const test = () =>
    run(async () => {
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

  return (
    <div style={{ marginTop: 24 }} data-testid="pager-settings">
      <h4 style={sectionHeader}>{t("settings.sidebar.pager")}</h4>
      <p style={{ ...hint, marginTop: 4 }}>{t("pager.settings.intro")}</p>
      <p style={{ ...hint, marginTop: 6 }}>
        {rich("pager.settings.onlyDiscord", {
          link: (chunk) => (
            <a
              href={ISSUES_URL}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent-text)" }}
            >
              {chunk}
            </a>
          ),
        })}
      </p>
      {loadFailed ? (
        <p role="alert" style={hint}>
          {t("pager.settings.loadFailed")}
        </p>
      ) : !saved ? (
        <p style={hint}>{t("common.loading")}</p>
      ) : (
        <>
          <div style={cardStyle}>
            <label
              style={{ ...dialogLabel, marginTop: 0 }}
              htmlFor="pager-webhook"
            >
              {t("pager.settings.webhook")}
            </label>
            <input
              id="pager-webhook"
              data-testid="pager-webhook"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={url}
              placeholder="https://discord.com/api/webhooks/…"
              onChange={(e) => {
                setUrl(e.target.value);
                setStatus(null);
              }}
              style={dialogInput}
            />
            {saved.webhookUrlMasked ? (
              <div
                data-testid="pager-webhook-current"
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
                  {saved.webhookUrlMasked}
                </code>
                <button
                  data-testid="pager-webhook-remove"
                  onClick={() => void save({ webhookUrl: null })}
                  disabled={busy}
                  style={{
                    ...secondaryBtn,
                    ...(busy ? disabledLook : null),
                  }}
                >
                  {t("pager.settings.webhookRemove")}
                </button>
                <span style={{ ...dialogHint, flexBasis: "100%" }}>
                  {t("pager.settings.webhookReplace")}
                </span>
              </div>
            ) : (
              <p
                style={{ ...dialogHint, margin: "6px 0 0" }}
                data-testid="pager-webhook-current"
              >
                {t("pager.settings.webhookNone")}
              </p>
            )}
            <p style={{ ...dialogHint, margin: "8px 0 0" }}>
              {rich("pager.settings.webhookHint", { b: bold })}
            </p>

            <label style={fieldLabel} htmlFor="pager-user-id">
              {t("pager.settings.userId")}
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
            <p style={{ ...dialogHint, margin: "6px 0 0" }}>
              {rich("pager.settings.userIdHint", { b: bold })}
            </p>

            <label style={fieldLabel} htmlFor="pager-repeat">
              {t("pager.settings.repeat")}
            </label>
            <select
              id="pager-repeat"
              data-testid="pager-repeat"
              value={repeat}
              onChange={(e) => {
                setRepeat(e.target.value);
                setStatus(null);
              }}
              style={selectStyle}
            >
              <option value={NEVER}>{t("pager.settings.repeatNever")}</option>
              {repeatOptions.map((m) => (
                <option key={m} value={String(m)}>
                  {m >= 60 && m % 60 === 0
                    ? tn("pager.settings.repeatEveryHours", m / 60)
                    : t("pager.settings.repeatEvery", { count: m })}
                </option>
              ))}
            </select>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 10,
              marginTop: 14,
            }}
          >
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
              disabled={busy || dirty || !saved.webhookUrlMasked}
              style={{
                ...cardActionBtn,
                ...(busy || dirty || !saved.webhookUrlMasked
                  ? disabledLook
                  : null),
              }}
            >
              {t("pager.settings.test")}
            </button>
            {status && (
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
            )}
          </div>
          <p style={{ ...hint, marginTop: 12 }}>
            {rich("pager.settings.phoneHint", { b: bold })}
          </p>
        </>
      )}
    </div>
  );
}

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
