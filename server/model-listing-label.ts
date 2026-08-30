import type { AgentInfo } from "../shared/types.ts";
import {
  familyDisplayLabel,
  modelLabelImpliesEngine,
} from "../shared/types.ts";

export function modelListingLabel(
  agentType: AgentInfo["agentType"],
  modelFamily: string,
): string {
  const label = familyDisplayLabel(modelFamily);
  if (agentType === "opencode" && !modelLabelImpliesEngine(modelFamily)) {
    return `${label} · opencode`;
  }
  return label;
}
