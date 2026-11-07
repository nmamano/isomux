// Settings -> Enterprise (task 8b80e61f; its own group since task f1304a60):
// the Enterprise Contract box, the secret input and the seat service's
// answer. Owner-only. The server decides the lock and keeps the secret: this
// section never reads it back.
import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type {
  EnterpriseProblem,
  EnterpriseViewRes,
} from "../../shared/contract-shapes.ts";
import type { MessageKey } from "../../shared/i18n/translate.ts";
import { dialogInput, dialogSaveBtn } from "./dialog-styles.ts";
import { sectionHeader } from "./access-shared.tsx";
import { ENTERPRISE_HELP_EMAIL } from "../send-failure.ts";

const DETAILS_URL = "https://isomux.com/enterprise";

const PROBLEM_KEYS = {
  bad_secret: "settings.office.enterprise.problemBadSecret",
  not_signed: "settings.office.enterprise.problemNotSigned",
  unreachable: "settings.office.enterprise.problemUnreachable",
} as const satisfies Record<EnterpriseProblem, MessageKey>;

// The route error codes of a refused secret (server/enterprise-seats.ts).
const ERROR_KEYS = {
  enterprise_secret_rejected: "settings.office.enterprise.errorRejected",
  enterprise_not_signed: "settings.office.enterprise.errorNotSigned",
  enterprise_unreachable: "settings.office.enterprise.errorUnreachable",
  invalid_secret: "settings.office.enterprise.errorInvalid",
  enterprise_rate_limited: "settings.office.enterprise.errorRateLimited",
} as const satisfies Record<string, MessageKey>;

// Whether Settings shows the Enterprise group: for an owner, where the box is
// available (never on Hosted). A failed read shows it, so the section's retry
// is reachable.
export function useEnterpriseAvailable(isOwner: boolean): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!isOwner) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    apiFetch<EnterpriseViewRes>("GET", "/api/office/enterprise").then(
      (view) => {
        if (!cancelled) setAvailable(view.available);
      },
      () => {
        if (!cancelled) setAvailable(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isOwner]);
  return available;
}

export function EnterprisePane() {
  const { t } = useI18n();
  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("settings.sidebar.enterpriseContract")}</h4>
      <EnterpriseContractSection />
    </div>
  );
}

export function EnterpriseContractSection() {
  const { t, tn, rich } = useI18n();
  const [view, setView] = useState<EnterpriseViewRes | null>(null);
  // A failed read shows an alert with a retry: inside the lock, an empty
  // section would leave the owner with no way out.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loads, setLoads] = useState(0);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState("");

  // Read the stored state, then ask the service for today's count.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let read: EnterpriseViewRes;
      try {
        read = await apiFetch<EnterpriseViewRes>(
          "GET",
          "/api/office/enterprise",
        );
      } catch {
        if (!cancelled) setLoadFailed(true);
        return;
      }
      if (cancelled) return;
      setLoadFailed(false);
      setView(read);
      if (!read.connected) return;
      setChecking(true);
      try {
        const fresh = await apiFetch<EnterpriseViewRes>(
          "POST",
          "/api/office/enterprise/check",
        );
        if (!cancelled) setView(fresh);
      } catch {
        // Keep the stored count.
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loads]);

  const messageOf = (err: unknown) => {
    if (!(err instanceof ApiError)) return String(err);
    return Object.hasOwn(ERROR_KEYS, err.code)
      ? t(ERROR_KEYS[err.code as keyof typeof ERROR_KEYS])
      : err.message;
  };

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setView(
        await apiFetch<EnterpriseViewRes>("PUT", "/api/office/enterprise", {
          enabled,
        }),
      );
      setSecret("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setView(
        await apiFetch<EnterpriseViewRes>(
          "POST",
          "/api/office/enterprise/secret",
          { secret },
        ),
      );
      setSecret("");
    } catch (err) {
      // The typed value stays, so a typo can be fixed in place.
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadFailed)
    return (
      <div style={{ marginTop: 14 }}>
        <p role="alert" style={alertStyle}>
          {t("settings.office.enterprise.loadFailed")}
        </p>
        <button
          type="button"
          onClick={() => setLoads((n) => n + 1)}
          style={{ ...dialogSaveBtn, marginTop: 6 }}
        >
          {t("settings.office.enterprise.retry")}
        </button>
      </div>
    );
  if (!view?.available) return null;
  const connected = view.connected;
  const alert = error ?? (view.problem ? t(PROBLEM_KEYS[view.problem]) : null);

  return (
    <div style={{ marginTop: 14 }}>
      <label style={labelStyle}>
        <input
          type="checkbox"
          checked={view.enabled}
          disabled={busy}
          onChange={(event) => void setEnabled(event.target.checked)}
        />
        {t("settings.office.enterprise.label")}
      </label>
      <p style={hintStyle}>
        {rich("settings.office.enterprise.hint", {
          link: (chunk) => (
            <a
              href={DETAILS_URL}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent-text)" }}
            >
              {chunk}
            </a>
          ),
        })}
      </p>

      {view.enabled && (
        <div style={{ marginTop: 10, paddingLeft: 22 }}>
          {view.locked && (
            <p style={{ ...lineStyle, color: "var(--text-primary)" }}>
              {t("settings.office.enterprise.locked")}
            </p>
          )}
          {connected && (
            <div style={{ marginBottom: 8 }}>
              <p style={{ ...lineStyle, fontWeight: 600 }}>
                {t("settings.office.enterprise.connected")}
              </p>
              <Row label={t("settings.office.enterprise.kind")}>
                {connected.kind === "negotiated"
                  ? t("settings.office.enterprise.kindNegotiated")
                  : t("settings.office.enterprise.kindStandard")}
              </Row>
              <Row label={t("settings.office.enterprise.account")}>
                {connected.company}
              </Row>
              <Row label={t("settings.office.enterprise.seats")}>
                {checking
                  ? t("settings.office.enterprise.checking")
                  : tn(
                      "settings.office.enterprise.seatsUsed",
                      connected.offices,
                      { inUse: connected.inUse, seats: connected.seats },
                    )}
              </Row>
            </div>
          )}
          <form onSubmit={(event) => void submit(event)}>
            <label style={{ ...hintStyle, display: "block", marginTop: 0 }}>
              {connected
                ? t("settings.office.enterprise.newSecret")
                : t("settings.office.enterprise.secret")}
            </label>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <input
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                style={{ ...dialogInput, flex: 1, minWidth: 0 }}
              />
              <button
                type="submit"
                disabled={busy || !secret.trim()}
                style={dialogSaveBtn}
              >
                {busy && !connected
                  ? t("settings.office.enterprise.connecting")
                  : connected
                    ? t("settings.office.enterprise.replace")
                    : t("settings.office.enterprise.connect")}
              </button>
            </div>
            {!connected && (
              <p style={hintStyle}>
                {t("settings.office.enterprise.secretHint")}
              </p>
            )}
          </form>
          {alert && (
            <p role="alert" style={alertStyle}>
              {alert}
            </p>
          )}
          <p style={{ ...hintStyle, marginTop: 8 }}>
            {t("settings.office.enterprise.help", {
              email: ENTERPRISE_HELP_EMAIL,
            })}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p style={lineStyle}>
      <span style={{ color: "var(--text-hint)" }}>{label}: </span>
      {children}
    </p>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  fontSize: 12,
  color: "var(--text-primary)",
};
const hintStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-ghost)",
  margin: "3px 0 0",
};
const lineStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-secondary)",
  margin: "2px 0",
};
const alertStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--red-text)",
  margin: "4px 0 0",
};
