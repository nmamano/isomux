// The permission pack of a member in the member panel (task 134b8f77): a
// preset, the per-area levels and the highest agent level. null is no pack
// (full access).

import type { AgentAccess } from "../../shared/agent-access.ts";
import {
  MEMBER_CEILING_STOPS,
  MEMBER_PACK_PRESETS,
  type MemberPack,
} from "../../shared/pack-fit.ts";
import type {
  ApiTokenAccess,
  ApiTokenArea,
  ApiTokenAreaLevels,
} from "../../shared/api-token-limits.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { useI18n } from "../i18n.tsx";
import { STOP_HINT, STOP_LABEL } from "./AccessSlider.tsx";
import { AreaLevelsGrid } from "./AreaLevelsGrid.tsx";
import { dialogHint, dialogInput, dialogLabel } from "./dialog-styles.ts";
import { StepSlider } from "./StepSlider.tsx";

const CHOICES = ["full", "readOnly", "workWithAgents", "custom"] as const;
type Choice = (typeof CHOICES)[number];

const CHOICE_LABEL: Record<Choice, PlainMessageKey> = {
  full: "settings.apiTokens.access.full",
  readOnly: "settings.apiTokens.access.readOnly",
  workWithAgents: "settings.memberPack.workWithAgents",
  custom: "settings.apiTokens.access.custom",
};

function sameAreas(a: ApiTokenAreaLevels, b: ApiTokenAreaLevels): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k as ApiTokenArea] === b[k as ApiTokenArea]);
}

// Whether two packs give the same areas and ceiling.
export function samePack(
  a: MemberPack | null | undefined,
  b: MemberPack | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.agentCeiling === b.agentCeiling && sameAreas(a.areas, b.areas);
}

function choiceOf(pack: MemberPack | null): Choice {
  if (!pack) return "full";
  if (samePack(pack, MEMBER_PACK_PRESETS.readOnly)) return "readOnly";
  if (samePack(pack, MEMBER_PACK_PRESETS.workWithAgents))
    return "workWithAgents";
  return "custom";
}

export function MemberPackEditor({
  pack,
  onPack,
  disabled = false,
}: {
  pack: MemberPack | null;
  onPack: (pack: MemberPack | null) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const choice = choiceOf(pack);
  const choose = (next: Choice) => {
    if (next === "full") onPack(null);
    else if (next === "custom")
      onPack(pack ?? { ...MEMBER_PACK_PRESETS.readOnly });
    else onPack({ ...MEMBER_PACK_PRESETS[next] });
  };
  const setArea = (area: ApiTokenArea, level: ApiTokenAccess | "none") => {
    if (!pack) return;
    const areas = { ...pack.areas };
    if (level === "none") delete areas[area];
    else areas[area] = level;
    onPack({ ...pack, areas });
  };
  return (
    <div data-member-pack="">
      <label style={dialogLabel}>
        {t("settings.apiTokens.access")}
        <select
          data-member-pack-preset=""
          value={choice}
          disabled={disabled}
          onChange={(event) => choose(event.target.value as Choice)}
          style={{
            ...dialogInput,
            display: "block",
            width: "100%",
            marginTop: 5,
          }}
        >
          {CHOICES.map((c) => (
            <option key={c} value={c}>
              {t(CHOICE_LABEL[c])}
            </option>
          ))}
        </select>
      </label>
      <p style={{ ...dialogHint, margin: "6px 0 0", lineHeight: 1.4 }}>
        {t("settings.memberPack.hint")}
      </p>
      {pack && (
        <>
          <span style={{ ...dialogLabel, display: "block", marginTop: 12 }}>
            {t("settings.memberPack.ceiling")}
          </span>
          <div style={{ display: "flex", marginTop: 6 }}>
            <StepSlider<AgentAccess>
              steps={MEMBER_CEILING_STOPS}
              value={pack.agentCeiling}
              onChange={(agentCeiling) => onPack({ ...pack, agentCeiling })}
              stepLabel={(stop) => t(STOP_LABEL[stop])}
              ariaLabel={t("settings.memberPack.ceiling")}
              attr="data-member-ceiling"
              disabled={disabled}
            />
          </div>
          <p style={{ ...dialogHint, margin: "6px 0 0", lineHeight: 1.4 }}>
            {t(STOP_HINT[pack.agentCeiling])}
          </p>
          <AreaLevelsGrid areas={pack.areas} onArea={setArea} />
        </>
      )}
    </div>
  );
}
