import type { ReactNode } from "react";
import {
  AGENT_ACCESS_STOPS,
  AGENT_PACK_AREAS,
  AGENT_PACK_PRESETS,
  agentPackPresetOf,
  belowStandard,
  engineRunsAccess,
  stopHasPack,
  type AgentAccess,
  type AgentPackArea,
  type AgentPackPreset,
} from "../../shared/agent-access.ts";
import {
  READ_SHOWS_SECRETS,
  type ApiTokenAccess,
  type ApiTokenLimits,
} from "../../shared/api-token-limits.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import type { AgentInfo } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { useMemberRooms } from "./ApiTokensPane.tsx";
import { dialogHint, dialogInput, dialogLabel } from "./dialog-styles.ts";
import { RoomPicker } from "./RoomPicker.tsx";

// The agent's access slider and, at office, folder and web, its pack
// picker. Each stop is a radio (data-access-stop); a stop the engine and
// model cannot run yet is disabled. The pack is state of its own: it stays while the
// member moves the slider, and the dialog sends it only at a stop with a
// pack.
export interface AccessSliderProps {
  access: AgentAccess;
  onAccess: (access: AgentAccess) => void;
  pack: ApiTokenLimits;
  onPack: (pack: ApiTokenLimits) => void;
  // The engine and model the dialog will save. A stop the two cannot run
  // is disabled (engineRunsAccess); "" is no model yet.
  agentType: AgentInfo["agentType"];
  model: string;
  // A line under the stop hint, for example that saving restarts the
  // session.
  note?: ReactNode;
}

const STOP_LABEL: Record<AgentAccess, PlainMessageKey> = {
  chat: "dialogs.agent.access.chat",
  office: "dialogs.agent.access.office",
  folder: "dialogs.agent.access.folder",
  web: "dialogs.agent.access.web",
  standard: "dialogs.agent.access.standard",
  privileged: "dialogs.agent.access.privileged",
};

const STOP_HINT: Record<AgentAccess, PlainMessageKey> = {
  chat: "dialogs.agent.access.chatHint",
  office: "dialogs.agent.access.officeHint",
  folder: "dialogs.agent.access.folderHint",
  web: "dialogs.agent.access.webHint",
  standard: "dialogs.agent.access.standardHint",
  privileged: "dialogs.agent.privilegedHint",
};

const PRESET_LABEL: Record<AgentPackPreset | "custom", PlainMessageKey> = {
  asksOnly: "dialogs.agent.pack.asksOnly",
  tasksAndAsks: "dialogs.agent.pack.tasksAndAsks",
  talkToAgents: "settings.apiTokens.access.talkToAgents",
  custom: "settings.apiTokens.access.custom",
};

const AREA_LABEL: Record<AgentPackArea, PlainMessageKey> = {
  agents: "settings.apiTokens.area.agents",
  logs: "settings.apiTokens.area.logs",
  tasks: "settings.apiTokens.area.tasks",
  asks: "settings.apiTokens.area.asks",
};

// The levels an agent tool exists for: logs has only reads, asks only its
// own asks (write).
const AREA_LEVELS: Record<AgentPackArea, Array<ApiTokenAccess | "none">> = {
  agents: ["none", "read", "write"],
  logs: ["none", "read"],
  tasks: ["none", "read", "write"],
  asks: ["none", "write"],
};

const LEVEL_LABEL: Record<ApiTokenAccess | "none", PlainMessageKey> = {
  none: "settings.apiTokens.level.none",
  read: "settings.apiTokens.level.read",
  write: "settings.apiTokens.level.write",
};

export function AccessSlider({
  access,
  onAccess,
  pack,
  onPack,
  agentType,
  model,
  note,
}: AccessSliderProps) {
  const { t } = useI18n();
  return (
    <div className="agent-access-field">
      <span style={{ ...dialogLabel, marginTop: 14 }}>
        {t("dialogs.agent.access")}
      </span>
      <div
        className="agent-access-stops"
        role="radiogroup"
        aria-label={t("dialogs.agent.access")}
      >
        {AGENT_ACCESS_STOPS.map((stop) => {
          const runs = engineRunsAccess(agentType, stop, model || null);
          return (
            <label
              key={stop}
              className="agent-access-stop"
              title={runs ? undefined : t("dialogs.agent.access.engineCannot")}
              data-selected={stop === access || undefined}
              data-disabled={!runs || undefined}
            >
              <input
                type="radio"
                name="agent-access"
                data-access-stop={stop}
                checked={stop === access}
                disabled={!runs}
                onChange={() => onAccess(stop)}
              />
              <span>{t(STOP_LABEL[stop])}</span>
            </label>
          );
        })}
      </div>
      <p style={{ ...dialogHint, margin: "6px 0 0", lineHeight: 1.4 }}>
        {t(STOP_HINT[access])}
      </p>
      {note && (
        <p style={{ ...dialogHint, margin: "6px 0 0", lineHeight: 1.4 }}>
          {note}
        </p>
      )}
      {!belowStandard(access) && (
        <p
          data-access-boundary-note=""
          style={{ ...dialogHint, margin: "6px 0 0", lineHeight: 1.4 }}
        >
          {t("dialogs.agent.access.boundaryNote")}
        </p>
      )}
      {stopHasPack(access) && <PackPicker pack={pack} onPack={onPack} />}
    </div>
  );
}

function PackPicker({
  pack,
  onPack,
}: {
  pack: ApiTokenLimits;
  onPack: (pack: ApiTokenLimits) => void;
}) {
  const { t } = useI18n();
  const memberRooms = useMemberRooms();
  const areas = pack.areas ?? {};
  const preset = agentPackPresetOf(pack);

  function choosePreset(choice: AgentPackPreset | "custom") {
    if (choice === "custom") return;
    onPack({ ...pack, areas: { ...AGENT_PACK_PRESETS[choice].areas } });
  }

  function setArea(area: AgentPackArea, level: ApiTokenAccess | "none") {
    const next = { ...areas };
    if (level === "none") delete next[area];
    else next[area] = level;
    onPack({ ...pack, areas: next });
  }

  // The agent's room ids stay as they are: the loaded room list only draws
  // the checkboxes.
  function setScope(scope: "all" | "some") {
    if (scope === "all") {
      const { rooms: _rooms, ...rest } = pack;
      onPack(rest);
    } else onPack({ ...pack, rooms: pack.rooms ?? [] });
  }

  return (
    <div className="agent-pack-picker" style={{ marginTop: 10 }}>
      <label style={{ display: "block", fontSize: 12 }}>
        {t("settings.apiTokens.access")}
        <select
          data-pack-preset=""
          value={preset}
          onChange={(event) =>
            choosePreset(event.target.value as AgentPackPreset | "custom")
          }
          style={{
            ...dialogInput,
            display: "block",
            width: "100%",
            marginTop: 5,
          }}
        >
          {(Object.keys(PRESET_LABEL) as Array<AgentPackPreset | "custom">).map(
            (key) => (
              <option key={key} value={key}>
                {t(PRESET_LABEL[key])}
              </option>
            ),
          )}
        </select>
      </label>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: "6px 10px",
          alignItems: "center",
          marginTop: 10,
          fontSize: 12,
        }}
      >
        {AGENT_PACK_AREAS.map((area) => {
          const level = areas[area] ?? "none";
          return (
            <PackAreaRow
              key={area}
              area={area}
              level={level}
              onChange={(next) => setArea(area, next)}
            />
          );
        })}
      </div>
      <RoomPicker
        scope={pack.rooms ? "some" : "all"}
        onScope={setScope}
        picked={pack.rooms ?? []}
        onPicked={(rooms) => onPack({ ...pack, rooms })}
        rooms={memberRooms}
        testId="agent-pack-rooms"
      />
    </div>
  );
}

function PackAreaRow({
  area,
  level,
  onChange,
}: {
  area: AgentPackArea;
  level: ApiTokenAccess | "none";
  onChange: (level: ApiTokenAccess | "none") => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <span>
        {t(AREA_LABEL[area])}
        {level !== "none" && READ_SHOWS_SECRETS.has(area) && (
          <span
            data-pack-secrets-warning=""
            style={{ color: "var(--red-text)", marginLeft: 6 }}
          >
            {t("dialogs.agent.pack.showsSecrets")}
          </span>
        )}
      </span>
      <select
        data-pack-area={area}
        aria-label={t(AREA_LABEL[area])}
        value={level}
        onChange={(event) =>
          onChange(event.target.value as ApiTokenAccess | "none")
        }
        style={dialogInput}
      >
        {AREA_LEVELS[area].map((option) => (
          <option key={option} value={option}>
            {t(LEVEL_LABEL[option])}
          </option>
        ))}
      </select>
    </>
  );
}
