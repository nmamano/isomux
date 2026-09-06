import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ApiTokenCreateRes,
  ApiTokenListRes,
  ApiTokenWire,
} from "../../shared/contract-shapes.ts";
import { dialogInput, dialogLabel, dialogSaveBtn } from "./dialog-styles.ts";
import { cardStyle, hint, sectionHeader } from "./access-shared.tsx";
import { useI18n } from "../i18n.tsx";
import { formatDateTime } from "../../shared/i18n/time.ts";

const DEVELOPER_API_GUIDE = "https://isomux.com/docs/developer-api";

const EXPIRY_OPTIONS = [30, 365, null] as const;
type ExpiryChoice = (typeof EXPIRY_OPTIONS)[number];

export function ApiTokensPane() {
  const { t, tn, rich, language } = useI18n();
  const [tokens, setTokens] = useState<ApiTokenWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<ExpiryChoice>(30);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiFetch<ApiTokenListRes>("GET", "/api/me/api-tokens")
      .then((res) => setTokens(res.apiTokens))
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : t("settings.apiTokens.loadFailed"),
        ),
      )
      .finally(() => setLoaded(true));
  }

  // Once, on mount. `load` reads the catalog for its error fallback, but a
  // language change is no reason to refetch the token list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  function create() {
    if (!name.trim()) return;
    setPending(true);
    setError(null);
    setRawToken(null);
    setCopied(false);
    apiFetch<ApiTokenCreateRes>("POST", "/api/me/api-tokens", {
      name: name.trim(),
      expiresInDays,
    })
      .then((res) => {
        setTokens((current) => [res.apiToken, ...current]);
        setRawToken(res.token);
        setName("");
      })
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : t("settings.apiTokens.createFailed"),
        ),
      )
      .finally(() => setPending(false));
  }

  function revoke(id: string) {
    setError(null);
    apiFetch<void>("DELETE", `/api/me/api-tokens/${encodeURIComponent(id)}`)
      .then(() =>
        setTokens((current) => current.filter((token) => token.id !== id)),
      )
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : t("settings.apiTokens.revokeFailed"),
        ),
      );
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("settings.sidebar.apiTokens")}</h4>
      <p style={hint}>
        {rich("settings.apiTokens.intro", {
          link: (chunk) => (
            <a
              href={DEVELOPER_API_GUIDE}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {chunk}
            </a>
          ),
        })}
      </p>
      <label style={{ ...dialogLabel, marginTop: 14 }}>
        {t("settings.apiTokens.howToUse")}
      </label>
      <pre
        style={{
          margin: "0 0 12px",
          padding: "8px 10px",
          borderRadius: 6,
          background: "var(--bg-code)",
          border: "1px solid var(--border)",
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: "var(--text-secondary)",
          userSelect: "text",
        }}
      >
        {`# list your agents and their ids
curl ${window.location.origin}/agents -H "Authorization: Bearer <token>"

# message one
curl -X POST ${window.location.origin}/api/agents/<id>/messages \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"..."}'`}
      </pre>

      <div style={cardStyle}>
        <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
          {t("common.name")}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("settings.apiTokens.namePlaceholder")}
            maxLength={64}
            style={{
              ...dialogInput,
              display: "block",
              width: "100%",
              marginTop: 5,
            }}
          />
        </label>
        <label style={{ display: "block", fontSize: 12 }}>
          {t("settings.apiTokens.expiresAfter")}
          <select
            value={expiresInDays === null ? "never" : expiresInDays}
            onChange={(event) =>
              setExpiresInDays(
                event.target.value === "never"
                  ? null
                  : (Number(event.target.value) as ExpiryChoice),
              )
            }
            style={{
              ...dialogInput,
              display: "block",
              width: "100%",
              marginTop: 5,
            }}
          >
            {EXPIRY_OPTIONS.map((days) => (
              <option
                key={days === null ? "never" : days}
                value={days === null ? "never" : days}
              >
                {days === null
                  ? t("settings.apiTokens.unlimited")
                  : tn("common.days", days)}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={create}
          disabled={pending || !name.trim()}
          style={{
            ...dialogSaveBtn,
            marginTop: 12,
            opacity: pending ? 0.5 : 1,
          }}
        >
          {pending
            ? t("settings.apiTokens.creating")
            : t("settings.apiTokens.create")}
        </button>
      </div>

      {rawToken && (
        <div style={{ ...cardStyle, marginTop: 12 }}>
          <strong style={{ fontSize: 12 }}>
            {t("settings.apiTokens.copyNow")}
          </strong>
          <p style={hint}>{t("settings.apiTokens.shownOnce")}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <code
              style={{
                flex: 1,
                minWidth: 0,
                overflowWrap: "anywhere",
                userSelect: "all",
              }}
            >
              {rawToken}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(rawToken).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  },
                  () => {},
                );
              }}
              style={{ ...dialogSaveBtn, flexShrink: 0 }}
            >
              {copied ? t("common.copied") : t("common.copy")}
            </button>
          </div>
        </div>
      )}

      {error && <p style={{ color: "#ff6b6b", fontSize: 12 }}>{error}</p>}

      <div style={{ marginTop: 18 }}>
        {!loaded ? (
          <p style={hint}>{t("common.loading")}</p>
        ) : tokens.length === 0 ? (
          <p style={hint}>{t("settings.apiTokens.empty")}</p>
        ) : (
          tokens.map((token) => (
            <div key={token.id} style={{ ...cardStyle, marginBottom: 8 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div>
                  <strong style={{ fontSize: 13 }}>{token.name}</strong>
                  <div style={hint}>
                    {token.tokenPrefix}… ·{" "}
                    {token.expiresAt === null
                      ? t("settings.apiTokens.neverExpires")
                      : t("settings.apiTokens.expiresOn", {
                          date: formatDateTime(
                            language,
                            token.expiresAt,
                            "date",
                          ),
                        })}
                  </div>
                  <div style={hint}>
                    {t("settings.apiTokens.lastRequest", {
                      when: token.lastUsedAt
                        ? t("settings.apiTokens.about", {
                            date: formatDateTime(
                              language,
                              token.lastUsedAt,
                              "dateTimeSeconds",
                            ),
                          })
                        : t("settings.apiTokens.never"),
                    })}
                  </div>
                </div>
                <button
                  onClick={() => revoke(token.id)}
                  style={{ ...dialogSaveBtn, alignSelf: "start" }}
                >
                  {t("common.revoke")}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
