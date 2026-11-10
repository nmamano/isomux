import type { ReactNode } from "react";
import {
  AGENT_ACCESS_STOPS,
  belowStandard,
  engineRunsAccess,
  stopHasFolder,
  stopIncludes,
  type AgentAccess,
} from "../../shared/agent-access.ts";
import type { ApiTokenAccess } from "../../shared/api-token-limits.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import type { AgentInfo } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { dialogHint, dialogLabel } from "./dialog-styles.ts";
import { StepSlider } from "./StepSlider.tsx";

// The agent's access slider. The slider is the room view level's step bar; a
// stop the engine and model cannot run yet is disabled. The stop alone sets
// what the agent's office token can do.
export interface AccessSliderProps {
  access: AgentAccess;
  onAccess: (access: AgentAccess) => void;
  // The engine and model the dialog will save. A stop the two cannot run
  // is disabled (engineRunsAccess); "" is no model yet.
  agentType: AgentInfo["agentType"];
  model: string;
  // A line under the stop hint, for example that saving restarts the
  // session.
  note?: ReactNode;
  // The agent ceiling of the manager's permission pack: stops above it are
  // disabled.
  ceiling?: AgentAccess;
  // The room has no folder, and the agent works in it (a member with a
  // pack): the folder and web stops are disabled.
  noFolder?: boolean;
}

export const STOP_LABEL: Record<AgentAccess, PlainMessageKey> = {
  chat: "dialogs.agent.access.chat",
  office: "dialogs.agent.access.office",
  folder: "dialogs.agent.access.folder",
  web: "dialogs.agent.access.web",
  standard: "dialogs.agent.access.standard",
  privileged: "dialogs.agent.access.privileged",
};

export const STOP_HINT: Record<AgentAccess, PlainMessageKey> = {
  chat: "dialogs.agent.access.chatHint",
  office: "dialogs.agent.access.officeHint",
  folder: "dialogs.agent.access.folderHint",
  web: "dialogs.agent.access.webHint",
  standard: "dialogs.agent.access.standardHint",
  privileged: "dialogs.agent.privilegedHint",
};

export const LEVEL_LABEL: Record<ApiTokenAccess | "none", PlainMessageKey> = {
  none: "settings.apiTokens.level.none",
  read: "settings.apiTokens.level.read",
  write: "settings.apiTokens.level.write",
};

export function AccessSlider({
  access,
  onAccess,
  agentType,
  model,
  note,
  ceiling,
  noFolder = false,
}: AccessSliderProps) {
  const aboveCeiling = (stop: AgentAccess) =>
    ceiling !== undefined && !stopIncludes(ceiling, stop);
  const needsFolder = (stop: AgentAccess) => noFolder && stopHasFolder(stop);
  const { t } = useI18n();
  return (
    <div className="agent-access-field">
      <span style={{ ...dialogLabel, marginTop: 14 }}>
        {t("dialogs.agent.access")}
      </span>
      <div style={{ display: "flex", marginTop: 6 }}>
        <StepSlider
          steps={AGENT_ACCESS_STOPS}
          value={access}
          onChange={onAccess}
          stepLabel={(stop) => t(STOP_LABEL[stop])}
          ariaLabel={t("dialogs.agent.access")}
          attr="data-access-stop"
          stepDisabled={(stop) =>
            aboveCeiling(stop) ||
            needsFolder(stop) ||
            !engineRunsAccess(agentType, stop, model || null)
          }
          stepTitle={(stop) =>
            aboveCeiling(stop)
              ? t("dialogs.agent.access.aboveCeiling")
              : needsFolder(stop)
                ? t("dialogs.agent.access.roomHasNoFolder")
                : t("dialogs.agent.access.engineCannot")
          }
        />
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
    </div>
  );
}
