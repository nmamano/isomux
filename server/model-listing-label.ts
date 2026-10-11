import type { AgentInfo } from "../shared/types.ts";
import { familyDisplayLabel, showEngineCue } from "../shared/types.ts";

export function modelListingLabel(
  agentType: AgentInfo["agentType"],
  modelFamily: string,
  models?: AgentInfo["claudeFamilyModels"],
): string {
  const label = familyDisplayLabel(modelFamily, models);
  if (showEngineCue(agentType, modelFamily, "listing")) {
    return `${label} · opencode`;
  }
  return label;
}
