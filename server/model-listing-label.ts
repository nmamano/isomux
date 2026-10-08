import type { AgentInfo } from "../shared/types.ts";
import {
  familyDisplayLabel,
  modelLabelImpliesEngine,
} from "../shared/types.ts";

export function modelListingLabel(
  agentType: AgentInfo["agentType"],
  modelFamily: string,
  models?: AgentInfo["claudeFamilyModels"],
): string {
  const label = familyDisplayLabel(modelFamily, models);
  if (agentType === "opencode" && !modelLabelImpliesEngine(modelFamily)) {
    return `${label} · opencode`;
  }
  return label;
}
