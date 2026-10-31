import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  ApiTokenCreateRes,
  ApiTokenListRes,
  ApiTokenWire,
} from "../../shared/contract-shapes.ts";
import {
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
  disabledLook,
} from "./dialog-styles.ts";
import { cardStyle, hint, sectionHeader } from "./access-shared.tsx";
import { useI18n } from "../i18n.tsx";
import { formatDateTime } from "../../shared/i18n/time.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import {
  API_TOKEN_AREAS,
  API_TOKEN_PRESETS,
  FULL_ACCESS_WRITE_AREAS,
  type ApiTokenAccess,
  type ApiTokenArea,
  type ApiTokenLimits,
} from "../../shared/api-token-limits.ts";

const DEVELOPER_API_GUIDE = "https://isomux.com/docs/developer-api";

const EXPIRY_OPTIONS = [30, 365, null] as const;
type ExpiryChoice = (typeof EXPIRY_OPTIONS)[number];

// "full" mints without limits; the presets fill the area list, and any change
// to it makes the choice "custom".
const ACCESS_CHOICES = ["full", "readOnly", "talkToAgents", "custom"] as const;
type AccessChoice = (typeof ACCESS_CHOICES)[number];
type Areas = ApiTokenLimits["areas"];

const ACCESS_LABEL: Record<AccessChoice, PlainMessageKey> = {
  full: "settings.apiTokens.access.full",
  readOnly: "settings.apiTokens.access.readOnly",
  talkToAgents: "settings.apiTokens.access.talkToAgents",
  custom: "settings.apiTokens.access.custom",
};

const AREA_LABEL: Record<ApiTokenArea, PlainMessageKey> = {
  office: "settings.apiTokens.area.office",
  rooms: "settings.apiTokens.area.rooms",
  agents: "settings.apiTokens.area.agents",
  agentManagement: "settings.apiTokens.area.agentManagement",
  logs: "settings.apiTokens.area.logs",
  files: "settings.apiTokens.area.files",
  tasks: "settings.apiTokens.area.tasks",
  asks: "settings.apiTokens.area.asks",
  membersChat: "settings.apiTokens.area.membersChat",
  memory: "settings.apiTokens.area.memory",
  skills: "settings.apiTokens.area.skills",
  schedules: "settings.apiTokens.area.schedules",
  apps: "settings.apiTokens.area.apps",
  webhooks: "settings.apiTokens.area.webhooks",
  pager: "settings.apiTokens.area.pager",
  environment: "settings.apiTokens.area.environment",
  voice: "settings.apiTokens.area.voice",
};

const LEVEL_LABEL: Record<ApiTokenAccess | "none", PlainMessageKey> = {
  none: "settings.apiTokens.level.none",
  read: "settings.apiTokens.level.read",
  write: "settings.apiTokens.level.write",
};

function sameAreas(a: Areas, b: Areas): boolean {
  const keys = Object.keys(a) as ApiTokenArea[];
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

// The choice a token's limits match: no limits is full access, a preset by its
// name, anything else custom.
function accessOf(limits: ApiTokenLimits | undefined): AccessChoice {
  if (!limits) return "full";
  if (sameAreas(limits.areas, API_TOKEN_PRESETS.readOnly.areas))
    return "readOnly";
  if (sameAreas(limits.areas, API_TOKEN_PRESETS.talkToAgents.areas))
    return "talkToAgents";
  return "custom";
}

export function ApiTokensPane() {
  const { t, tn, rich } = useI18n();
  const [tokens, setTokens] = useState<ApiTokenWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<ExpiryChoice>(30);
  const [access, setAccess] = useState<AccessChoice>("full");
  const [areas, setAreas] = useState<Areas>({});
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
      ...(access === "full" ? {} : { limits: { areas } }),
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

  function chooseAccess(choice: AccessChoice) {
    setAccess(choice);
    if (choice === "full") setAreas({});
    else if (choice !== "custom")
      setAreas({ ...API_TOKEN_PRESETS[choice].areas });
  }

  function setArea(area: ApiTokenArea, level: ApiTokenAccess | "none") {
    setAccess("custom");
    setAreas((current) => {
      const next = { ...current };
      if (level === "none") delete next[area];
      else next[area] = level;
      return next;
    });
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
              style={{ color: "var(--accent-text)" }}
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
            data-testid="api-token-name"
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
        <label style={{ display: "block", fontSize: 12, marginTop: 8 }}>
          {t("settings.apiTokens.access")}
          <select
            data-testid="api-token-access"
            value={access}
            onChange={(event) =>
              chooseAccess(event.target.value as AccessChoice)
            }
            style={{
              ...dialogInput,
              display: "block",
              width: "100%",
              marginTop: 5,
            }}
          >
            {ACCESS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t(ACCESS_LABEL[choice])}
              </option>
            ))}
          </select>
        </label>
        {access !== "full" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              alignItems: "center",
              gap: "6px 10px",
              marginTop: 10,
              fontSize: 12,
            }}
          >
            {API_TOKEN_AREAS.map((area) => (
              <AreaRow
                key={area}
                area={area}
                level={areas[area] ?? "none"}
                onChange={(level) => setArea(area, level)}
              />
            ))}
          </div>
        )}
        <button
          data-testid="api-token-create"
          onClick={create}
          disabled={pending || !name.trim()}
          style={{
            ...dialogSaveBtn,
            marginTop: 12,
            ...(pending ? disabledLook : null),
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

      {error && (
        <p style={{ color: "var(--red-text)", fontSize: 12 }}>{error}</p>
      )}

      <div style={{ marginTop: 18 }}>
        {!loaded ? (
          <p style={hint}>{t("common.loading")}</p>
        ) : tokens.length === 0 ? (
          <p style={hint}>{t("settings.apiTokens.empty")}</p>
        ) : (
          <ApiTokenCards tokens={tokens} onRevoke={revoke} />
        )}
      </div>
    </div>
  );
}

// One area of a limited token: its name, a none / read / read and write
// select, and a mark when its write equals full access.
function AreaRow({
  area,
  level,
  onChange,
}: {
  area: ApiTokenArea;
  level: ApiTokenAccess | "none";
  onChange: (level: ApiTokenAccess | "none") => void;
}) {
  const { t } = useI18n();
  const fullAccess = level === "write" && FULL_ACCESS_WRITE_AREAS.has(area);
  return (
    <>
      <span>
        {t(AREA_LABEL[area])}
        {fullAccess && (
          <span
            data-full-access-warning={area}
            style={{ color: "var(--red-text)", marginLeft: 6 }}
          >
            {t("settings.apiTokens.equalsFullAccess")}
          </span>
        )}
      </span>
      <select
        data-area={area}
        aria-label={t(AREA_LABEL[area])}
        value={level}
        onChange={(event) =>
          onChange(event.target.value as ApiTokenAccess | "none")
        }
        style={dialogInput}
      >
        {(["none", "read", "write"] as const).map((option) => (
          <option key={option} value={option}>
            {t(LEVEL_LABEL[option])}
          </option>
        ))}
      </select>
    </>
  );
}

// What a token card says about its access: the preset name, or for custom
// each area with its level.
function accessSummary(
  t: ReturnType<typeof useI18n>["t"],
  language: string,
  limits: ApiTokenLimits | undefined,
): string {
  const choice = accessOf(limits);
  if (choice !== "custom" || !limits) return t(ACCESS_LABEL[choice]);
  const granted = API_TOKEN_AREAS.filter((area) => limits.areas[area]).map(
    (area) =>
      t("settings.apiTokens.areaLevel", {
        area: t(AREA_LABEL[area]),
        level: t(LEVEL_LABEL[limits.areas[area]!]),
      }),
  );
  return t("settings.apiTokens.customAccess", {
    areas: granted.length
      ? new Intl.ListFormat(language, { type: "conjunction" }).format(granted)
      : t("settings.apiTokens.noAreas"),
  });
}

// One card per token: name, prefix, expiry, last request, access and Revoke. The
// member's own pane and an owner's view of a member share it.
export function ApiTokenCards({
  tokens,
  onRevoke,
}: {
  tokens: ApiTokenWire[];
  onRevoke: (id: string) => void;
}) {
  const { t, language } = useI18n();
  return tokens.map((token) => (
    <div
      key={token.id}
      data-api-token={token.id}
      style={{ ...cardStyle, marginBottom: 8 }}
    >
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
                  date: formatDateTime(language, token.expiresAt, "date"),
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
          <div style={hint} data-token-access={accessOf(token.limits)}>
            {t("settings.apiTokens.accessLine", {
              access: accessSummary(t, language, token.limits),
            })}
          </div>
        </div>
        <button
          onClick={() => onRevoke(token.id)}
          style={{ ...dialogSaveBtn, alignSelf: "start" }}
        >
          {t("common.revoke")}
        </button>
      </div>
    </div>
  ));
}
