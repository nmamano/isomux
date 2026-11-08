// The per-area levels of a permission pack: one row per area with a none /
// read / read and write select. The API token form and the member panel share
// it (task 134b8f77).

import {
  API_TOKEN_AREAS,
  writesEqualFullAccess,
  type ApiTokenAccess,
  type ApiTokenArea,
  type ApiTokenAreaLevels,
} from "../../shared/api-token-limits.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { useI18n } from "../i18n.tsx";
import { dialogInput } from "./dialog-styles.ts";

export const AREA_LABEL: Record<ApiTokenArea, PlainMessageKey> = {
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

export const LEVEL_LABEL: Record<ApiTokenAccess | "none", PlainMessageKey> = {
  none: "settings.apiTokens.level.none",
  read: "settings.apiTokens.level.read",
  write: "settings.apiTokens.level.write",
};

export function AreaLevelsGrid({
  areas,
  onArea,
  quiet = false,
  disabled = false,
}: {
  areas: ApiTokenAreaLevels;
  onArea: (area: ApiTokenArea, level: ApiTokenAccess | "none") => void;
  // Muted names, for values a preset fills in; the selects stay controls.
  quiet?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "center",
        gap: "6px 10px",
        marginTop: 10,
        fontSize: 12,
        color: quiet ? "var(--text-muted)" : undefined,
      }}
    >
      {API_TOKEN_AREAS.map((area) => (
        <AreaRow
          key={area}
          area={area}
          level={areas[area] ?? "none"}
          onChange={(level) => onArea(area, level)}
          disabled={disabled}
          warn={!quiet}
        />
      ))}
    </div>
  );
}

// One area of a limited token: its name, a none / read / read and write
// select, and a mark when its write equals full access.
function AreaRow({
  area,
  level,
  onChange,
  disabled,
  warn,
}: {
  area: ApiTokenArea;
  level: ApiTokenAccess | "none";
  onChange: (level: ApiTokenAccess | "none") => void;
  disabled: boolean;
  // The equals-full-access mark; a preset's own values carry none.
  warn: boolean;
}) {
  const { t } = useI18n();
  const fullAccess = warn && level === "write" && writesEqualFullAccess(area);
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
        disabled={disabled}
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
