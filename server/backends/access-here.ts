// Whether an engine runs an access stop on this server: the engine and model
// rule (engineRunsAccess) plus each engine's proven-version check below
// standard (Codex: backends/codex/access.ts; OpenCode:
// backends/opencode/access.ts).
import {
  engineRunsAccess,
  type AgentAccess,
} from "../../shared/agent-access.ts";
import { codexRunsBelowStandard } from "./codex/access.ts";
import { openCodeRunsBelowStandard } from "./opencode/access.ts";

export function engineRunsAccessHere(
  agentType: string,
  access: AgentAccess,
  model: string | null,
): boolean {
  if (!engineRunsAccess(agentType, access, model)) return false;
  if (agentType === "codex") return codexRunsBelowStandard(access);
  if (agentType === "opencode") return openCodeRunsBelowStandard(access);
  return true;
}
