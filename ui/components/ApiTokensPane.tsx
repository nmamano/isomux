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
  writesEqualFullAccess,
  type ApiTokenAccess,
  type ApiTokenArea,
  type ApiTokenAreaLevels,
  type ApiTokenLimits,
} from "../../shared/api-token-limits.ts";

const DEVELOPER_API_GUIDE = "https://isomux.com/docs/developer-api";

const EXPIRY_OPTIONS = [30, 365, null] as const;
type ExpiryChoice = (typeof EXPIRY_OPTIONS)[number];

// "full" mints without limits; the presets fill the area list, and any change
// to it makes the choice "custom".
const ACCESS_CHOICES = [
  "full",
  "readOnly",
  "talkToAgents",
  "repliesOnly",
  "custom",
] as const;
type AccessChoice = (typeof ACCESS_CHOICES)[number];
type Areas = ApiTokenAreaLevels;

const ACCESS_LABEL: Record<AccessChoice, PlainMessageKey> = {
  full: "settings.apiTokens.access.full",
  readOnly: "settings.apiTokens.access.readOnly",
  talkToAgents: "settings.apiTokens.access.talkToAgents",
  repliesOnly: "settings.apiTokens.access.repliesOnly",
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
  if (!limits?.areas) return limits?.repliesOnly ? "custom" : "full";
  const talk = sameAreas(limits.areas, API_TOKEN_PRESETS.talkToAgents.areas);
  if (limits.repliesOnly) return talk ? "repliesOnly" : "custom";
  if (sameAreas(limits.areas, API_TOKEN_PRESETS.readOnly.areas))
    return "readOnly";
  return talk ? "talkToAgents" : "custom";
}

export function ApiTokensPane() {
  const { t, tn, rich } = useI18n();
  const [tokens, setTokens] = useState<ApiTokenWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<ExpiryChoice>(30);
  const [access, setAccess] = useState<AccessChoice>("full");
  const [areas, setAreas] = useState<Areas>({});
  // Only while Agents is Read and write.
  const [repliesOnly, setRepliesOnly] = useState(false);
  // "all": no room limit. "some": only the picked rooms.
  const [roomScope, setRoomScope] = useState<"all" | "some">("all");
  const [pickedRooms, setPickedRooms] = useState<string[]>([]);
  const memberRooms = useMemberRooms();
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
      ...mintLimits(
        access,
        areas,
        repliesOnly,
        roomScope,
        pickedRooms,
        memberRooms,
      ),
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
    if (choice !== "custom") setRepliesOnly(choice === "repliesOnly");
  }

  function setArea(area: ApiTokenArea, level: ApiTokenAccess | "none") {
    setAccess("custom");
    if (area === "agents" && level !== "write") setRepliesOnly(false);
    setAreas((current) => {
      const next = { ...current };
      if (level === "none") delete next[area];
      else next[area] = level;
      return next;
    });
  }

  function toggleRepliesOnly(on: boolean) {
    setRepliesOnly(on);
    setAccess(accessOf({ areas, ...(on ? { repliesOnly: true } : {}) }));
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
                repliesOnly={repliesOnly}
                onChange={(level) => setArea(area, level)}
              />
            ))}
          </div>
        )}
        {access !== "full" && areas.agents === "write" && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
              fontSize: 12,
            }}
          >
            <input
              type="checkbox"
              data-testid="api-token-replies-only"
              checked={repliesOnly}
              onChange={(event) => toggleRepliesOnly(event.target.checked)}
            />
            {t("settings.apiTokens.access.repliesOnly")}
            <span style={hint}>{t("settings.apiTokens.repliesOnlyHint")}</span>
          </label>
        )}
        <label style={{ display: "block", fontSize: 12, marginTop: 8 }}>
          {t("settings.apiTokens.rooms")}
          <select
            data-testid="api-token-rooms"
            value={roomScope}
            onChange={(event) =>
              setRoomScope(event.target.value as "all" | "some")
            }
            style={{
              ...dialogInput,
              display: "block",
              width: "100%",
              marginTop: 5,
            }}
          >
            <option value="all">{t("settings.apiTokens.rooms.all")}</option>
            <option value="some">{t("settings.apiTokens.rooms.some")}</option>
          </select>
        </label>
        {roomScope === "some" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginTop: 10,
              fontSize: 12,
            }}
          >
            {memberRooms.map((room) => (
              <label
                key={room.id}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <input
                  type="checkbox"
                  data-room={room.id}
                  checked={pickedRooms.includes(room.id)}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setPickedRooms((current) =>
                      checked
                        ? [...current, room.id]
                        : current.filter((id) => id !== room.id),
                    );
                  }}
                />
                {room.name}
              </label>
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
          <ApiTokenCards
            tokens={tokens}
            onRevoke={revoke}
            rooms={memberRooms}
          />
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
  repliesOnly,
  onChange,
}: {
  area: ApiTokenArea;
  level: ApiTokenAccess | "none";
  repliesOnly: boolean;
  onChange: (level: ApiTokenAccess | "none") => void;
}) {
  const { t } = useI18n();
  const fullAccess =
    level === "write" &&
    writesEqualFullAccess(
      area,
      repliesOnly ? { repliesOnly: true } : undefined,
    );
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

export interface MemberRoom {
  id: string;
  name: string;
}

// The ordinary rooms the signed-in member can access (GET /api/me/rooms), for
// the room picker and to name a token's rooms. Empty until loaded or on error.
export function useMemberRooms(): MemberRoom[] {
  const [rooms, setRooms] = useState<MemberRoom[]>([]);
  useEffect(() => {
    let live = true;
    apiFetch<{ rooms: MemberRoom[] }>("GET", "/api/me/rooms")
      .then((res) => {
        if (live && Array.isArray(res.rooms)) setRooms(res.rooms);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return rooms;
}

// The limits a mint sends: none for Full access on every room, else the
// areas (unless Full access), replies only while Agents is Read and write,
// and the picked rooms (in the picker's order).
function mintLimits(
  access: AccessChoice,
  areas: Areas,
  repliesOnly: boolean,
  roomScope: "all" | "some",
  picked: readonly string[],
  memberRooms: readonly MemberRoom[],
): { limits?: ApiTokenLimits } {
  const limits: ApiTokenLimits = {};
  if (access !== "full") limits.areas = areas;
  if (access !== "full" && repliesOnly && areas.agents === "write")
    limits.repliesOnly = true;
  if (roomScope === "some")
    limits.rooms = memberRooms
      .map((room) => room.id)
      .filter((id) => picked.includes(id));
  return Object.keys(limits).length ? { limits } : {};
}

// What a token card says about its rooms: every room, or the rooms it names.
// A room the viewer cannot name (closed, or out of reach) counts as "other".
function roomsSummary(
  t: ReturnType<typeof useI18n>["t"],
  tn: ReturnType<typeof useI18n>["tn"],
  language: string,
  limits: ApiTokenLimits | undefined,
  rooms: readonly MemberRoom[],
): string {
  const ids = limits?.rooms;
  if (!ids) return t("settings.apiTokens.allRooms");
  if (ids.length === 0) return t("settings.apiTokens.noRooms");
  const names = ids.flatMap((id) => {
    const room = rooms.find((r) => r.id === id);
    return room ? [room.name] : [];
  });
  const others = ids.length - names.length;
  if (others > 0) names.push(tn("settings.apiTokens.otherRooms", others));
  return new Intl.ListFormat(language, { type: "conjunction" }).format(names);
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
  const areas = limits.areas;
  const granted = areas
    ? API_TOKEN_AREAS.filter((area) => areas[area]).map((area) =>
        t("settings.apiTokens.areaLevel", {
          area: t(AREA_LABEL[area]),
          level: t(LEVEL_LABEL[areas[area]!]),
        }),
      )
    : [t("settings.apiTokens.allAreas")];
  if (limits.repliesOnly) granted.push(t("settings.apiTokens.repliesOnlyItem"));
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
  rooms,
}: {
  tokens: ApiTokenWire[];
  onRevoke: (id: string) => void;
  // The viewer's rooms, to name a token's rooms.
  rooms: readonly MemberRoom[];
}) {
  const { t, tn, language } = useI18n();
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
          <div
            style={hint}
            data-token-rooms={token.limits?.rooms ? "some" : "all"}
          >
            {t("settings.apiTokens.roomsLine", {
              rooms: roomsSummary(t, tn, language, token.limits, rooms),
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
