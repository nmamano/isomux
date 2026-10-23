// Integrations → Pager → This device: switch pager pushes on or off for
// this browser, send a test, and remove the member's other devices (a
// collapsed row). Server side: server/web-push-*.ts and the pushDevices.* routes.

import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type {
  PushDevice,
  PushDeviceFailure,
  PushDeviceReq,
  PushDevicesRes,
  PushTestRes,
} from "../../shared/contract-shapes.ts";
import type { MessageKey } from "../../shared/i18n/en.ts";
import { cardActionBtn, dialogHint, disabledLook } from "./dialog-styles.ts";
import { cardStyle } from "./access-shared.tsx";
import { getDevice } from "../device-settings.ts";
import {
  currentDeviceId,
  guessDeviceLabel,
  pushSupport,
  readPushEnv,
  subscribe,
  unsubscribe,
} from "../push-subscription.ts";

const PUSH_FAILURE_KEYS = {
  gone: "push.failure.gone",
  rejected: "push.failure.rejected",
  unreachable: "push.failure.unreachable",
} as const satisfies Record<PushDeviceFailure, MessageKey>;

export function PushDevicesBlock({ username }: { username: string }) {
  const { t } = useI18n();
  const path = `/api/users/${encodeURIComponent(username)}/push-devices`;
  const [env] = useState(readPushEnv);
  const [data, setData] = useState<PushDevicesRes | null>(null);
  const [thisId, setThisId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const mounted = useRef(true);
  // An office with no key (the demo) cannot send.
  const support = data?.publicKey === "" ? "unsupported" : pushSupport(env);

  async function load() {
    const next = await apiFetch<PushDevicesRes>("GET", path);
    let id: string | null = null;
    if (next.publicKey && pushSupport(env) === "ok") {
      id = await currentDeviceId(next.publicKey).catch(() => null);
    }
    if (!mounted.current) return;
    setData(next);
    setThisId(id && next.devices.some((d) => d.id === id) ? id : null);
  }

  useEffect(() => {
    mounted.current = true;
    load().catch(() => {
      // The block stays hidden: the pager pane above reports a dead server.
    });
    return () => {
      mounted.current = false;
    };
    // load reads only path and the browser.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  async function run(
    work: () => Promise<{ ok: boolean; text: string } | null>,
  ) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await work();
      if (mounted.current) setStatus(result);
    } catch (e) {
      if (mounted.current) {
        setStatus({
          ok: false,
          text: e instanceof ApiError ? e.message : t("push.settings.failed"),
        });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const turnOn = () =>
    run(async () => {
      // First, inside the tap: iOS asks only from a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        return { ok: false, text: t("push.settings.blocked") };
      }
      const sub = await subscribe(data!.publicKey);
      const body: PushDeviceReq = {
        ...sub,
        label: getDevice() ?? guessDeviceLabel(env),
      };
      await apiFetch<PushDevice>("POST", path, body);
      await load();
      return null;
    });

  const remove = (id: string) =>
    run(async () => {
      await apiFetch<void>("DELETE", `${path}/${encodeURIComponent(id)}`);
      if (id === thisId) await unsubscribe().catch(() => {});
      await load();
      return null;
    });

  const test = () =>
    run(async () => {
      const res = await apiFetch<PushTestRes>(
        "POST",
        `${path}/${encodeURIComponent(thisId!)}/test`,
      );
      if (res.delivered) return { ok: true, text: t("push.settings.testSent") };
      if (res.failure === "gone") await load();
      return {
        ok: false,
        text: t("push.settings.testFailed", {
          reason: t(PUSH_FAILURE_KEYS[res.failure]),
        }),
      };
    });

  const others = data?.devices.filter((d) => d.id !== thisId) ?? [];
  const blocked =
    support === "ok" && Notification.permission === "denied" && !thisId;
  const on = thisId !== null;

  return (
    <div style={cardStyle} data-testid="push-devices">
      {support === "ok" ? (
        <div style={row}>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            data-testid="push-toggle"
            data-on={on}
            onClick={() => void (thisId ? remove(thisId) : turnOn())}
            disabled={busy || !data}
            style={{
              ...switchButton,
              ...(busy || !data ? disabledLook : null),
            }}
          >
            <span
              aria-hidden
              style={{
                ...switchTrack,
                background: on ? "var(--accent)" : "var(--border-medium)",
              }}
            >
              <span style={{ ...switchKnob, left: on ? 16 : 2 }} />
            </span>
            {t("push.settings.switch")}
          </button>
          {on && (
            <button
              data-testid="push-test"
              onClick={() => void test()}
              disabled={busy}
              style={{ ...cardActionBtn, ...(busy ? disabledLook : null) }}
            >
              {t("push.settings.test")}
            </button>
          )}
          {status && (
            <span
              role="status"
              data-testid="push-status"
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
      ) : (
        <p
          data-testid="push-unsupported"
          data-reason={support}
          style={{ ...dialogHint, margin: 0 }}
        >
          {support === "ios-install"
            ? t("push.settings.iosInstall")
            : t("push.settings.unsupported")}
        </p>
      )}
      {blocked && (
        <p style={{ ...dialogHint, margin: "8px 0 0" }}>
          {t("push.settings.blocked")}
        </p>
      )}
      {others.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            data-testid="push-others"
            aria-expanded={othersOpen}
            onClick={() => setOthersOpen(!othersOpen)}
            style={disclosure}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              aria-hidden
              style={{
                transform: othersOpen ? "rotate(90deg)" : undefined,
                transition: "transform 120ms",
              }}
            >
              <path
                d="M3 1.5 L7 5 L3 8.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
            {t("push.settings.otherDevices", { count: others.length })}
          </button>
          {othersOpen &&
            others.map((d) => (
              <div
                key={d.id}
                data-testid="push-device"
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                  marginTop: 6,
                  paddingLeft: 16,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <span>{d.label || t("push.settings.unnamed")}</span>
                {d.lastFailure && (
                  <span style={{ color: "var(--red-text)", fontSize: 11 }}>
                    {t("pager.delivery.failed", {
                      reason: t(PUSH_FAILURE_KEYS[d.lastFailure]),
                    })}
                  </span>
                )}
                <button
                  onClick={() => void remove(d.id)}
                  disabled={busy}
                  style={{ ...cardActionBtn, ...(busy ? disabledLook : null) }}
                >
                  {t("push.settings.remove")}
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
};

const switchButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: 13,
  cursor: "pointer",
};

const switchTrack: React.CSSProperties = {
  position: "relative",
  display: "inline-block",
  width: 32,
  height: 18,
  borderRadius: 9,
  transition: "background 120ms",
};

const switchKnob: React.CSSProperties = {
  position: "absolute",
  top: 2,
  width: 14,
  height: 14,
  borderRadius: "50%",
  background: "#fff",
  transition: "left 120ms",
};

const disclosure: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: 12,
  cursor: "pointer",
};
