// The member panel's Access section (task 2c57281c): the level line, the
// legend, their agents' ceiling and the per-area grid. Owner viewers only.
// Every level shows its values in live controls; an edit of them makes
// Custom, which is off the line (no step lit).

import type { AgentAccess } from "../../shared/agent-access.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import {
  MEMBER_CEILING_STOPS,
  type MemberPack,
} from "../../shared/pack-fit.ts";
import { useI18n } from "../i18n.tsx";
import {
  editValues,
  MEMBER_LEVELS,
  memberLevelOf,
  presetValues,
  shownValues,
  type MemberAccessEdit,
  type MemberLevel,
} from "../member-access.ts";
import { STOP_LABEL } from "./AccessSlider.tsx";
import { AreaLevelsGrid } from "./AreaLevelsGrid.tsx";
import { dialogHint, dialogLabel } from "./dialog-styles.ts";
import { StepSlider } from "./StepSlider.tsx";

export interface MemberAccessChange {
  owner: boolean;
  pack: MemberPack | null;
  startedFrom: MemberLevel | null;
}

export const LEVEL_LABEL: Record<MemberLevel, PlainMessageKey> = {
  readOnly: "settings.apiTokens.access.readOnly",
  workWithAgents: "settings.memberPack.workWithAgents",
  full: "settings.apiTokens.access.full",
  owner: "settings.memberAccess.owner",
};

const LEVEL_LEGEND: Record<MemberLevel, PlainMessageKey> = {
  readOnly: "settings.memberAccess.legend.readOnly",
  workWithAgents: "settings.memberAccess.legend.workWithAgents",
  full: "settings.memberAccess.legend.full",
  owner: "settings.memberAccess.legend.owner",
};

const lineStyle: React.CSSProperties = {
  ...dialogHint,
  margin: "6px 0 0",
  lineHeight: 1.4,
};

export function MemberAccessControl({
  owner,
  pack,
  startedFrom,
  savedOwner,
  onChange,
  headingStyle,
  disabled = false,
}: {
  owner: boolean;
  pack: MemberPack | null;
  // The level an edit left, for the Custom legend and the keyboard.
  startedFrom: MemberLevel | null;
  // The saved role: anything below Owner on a saved owner is a demote.
  savedOwner: boolean;
  onChange: (next: MemberAccessChange) => void;
  headingStyle?: React.CSSProperties;
  disabled?: boolean;
}) {
  const { t, rich } = useI18n();
  const draft = { owner, pack };
  const level = memberLevelOf(draft);
  const custom = level === "custom";
  const values = shownValues(draft);
  // Full access and Owner set no cap: a pack ends at Web.
  const anyLevel = level === "full" || level === "owner";

  function pickLevel(next: MemberLevel) {
    onChange({ ...presetValues(next), startedFrom: null });
  }
  function edit(change: MemberAccessEdit) {
    onChange({
      ...editValues(draft, change),
      startedFrom: level === "custom" ? startedFrom : level,
    });
  }

  return (
    <div data-member-access="">
      <h5
        style={{
          ...headingStyle,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {t("settings.memberAccess.title")}
        {custom && (
          <span
            data-member-access-custom=""
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "1px 8px",
              borderRadius: 999,
              border: "1px solid var(--accent)",
              color: "var(--accent-text)",
            }}
          >
            {t("settings.apiTokens.access.custom")}
          </span>
        )}
      </h5>
      <div style={{ display: "flex", marginTop: 12 }}>
        <StepSlider<MemberLevel>
          steps={MEMBER_LEVELS}
          value={custom ? null : level}
          anchor={startedFrom ?? undefined}
          onChange={pickLevel}
          stepLabel={(step) => t(LEVEL_LABEL[step])}
          ariaLabel={t("settings.memberAccess.title")}
          attr="data-member-level"
          disabled={disabled}
        />
      </div>
      <p style={{ ...lineStyle, color: "var(--text-dim)" }}>
        {custom
          ? rich("settings.memberAccess.legendLine", {
              level: t("settings.apiTokens.access.custom"),
              text: startedFrom
                ? t("settings.memberAccess.legend.customFrom", {
                    level: t(LEVEL_LABEL[startedFrom]),
                  })
                : t("settings.memberAccess.legend.custom"),
              strong: (chunk) => <strong>{chunk}</strong>,
            })
          : rich("settings.memberAccess.legendLine", {
              level: t(LEVEL_LABEL[level]),
              text: t(LEVEL_LEGEND[level]),
              strong: (chunk) => <strong>{chunk}</strong>,
            })}
      </p>
      {!anyLevel && (
        <p style={{ ...lineStyle, fontStyle: "italic" }}>
          {t("settings.memberPack.hint")}
        </p>
      )}
      {savedOwner && !owner && (
        <p
          data-member-access-demote=""
          style={{ ...lineStyle, color: "var(--red-text)" }}
        >
          {t("settings.memberAccess.demote")}
        </p>
      )}
      <span style={{ ...dialogLabel, marginTop: 16 }}>
        {anyLevel
          ? t("settings.memberAccess.ceilingAny")
          : t("settings.memberAccess.ceiling", {
              level: t(STOP_LABEL[values.agentCeiling]),
            })}
      </span>
      <div style={{ display: "flex", marginTop: 6 }}>
        <StepSlider<AgentAccess>
          steps={MEMBER_CEILING_STOPS}
          value={values.agentCeiling}
          onChange={(agentCeiling) => edit({ agentCeiling })}
          stepLabel={(stop) => t(STOP_LABEL[stop])}
          ariaLabel={t("settings.memberAccess.ceilingName")}
          attr="data-member-ceiling"
          disabled={disabled}
        />
      </div>
      {!anyLevel && (
        <p style={lineStyle}>{t("settings.memberAccess.ceilingHint")}</p>
      )}
      <span style={{ ...dialogLabel, marginTop: 16 }}>
        {t("settings.memberAccess.areas")}
      </span>
      <AreaLevelsGrid
        areas={values.areas}
        onArea={(area, areaLevel) => edit({ area, level: areaLevel })}
        quiet={!custom}
        disabled={disabled}
      />
    </div>
  );
}
