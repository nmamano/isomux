import type { AgentBackendType } from "../shared/types.ts";
import type { MessageKey } from "../shared/i18n/translate.ts";

// The engine names are proper nouns and stay as they are (ruling 11); the line
// under each one is prose, so it is a catalog key the card renders through t()
// (internal-docs/i18n-loop.md, S4).
export const ENGINE_OPTIONS: Array<{
  agentType: AgentBackendType;
  label: string;
  blurbKey: Extract<MessageKey, `dialogs.agent.engineBlurb.${string}`>;
  accent: string;
}> = [
  {
    agentType: "claude",
    label: "Claude",
    blurbKey: "dialogs.agent.engineBlurb.claude",
    accent: "rgba(100,160,255,0.85)",
  },
  {
    agentType: "codex",
    label: "Codex",
    blurbKey: "dialogs.agent.engineBlurb.codex",
    accent: "rgba(120,220,160,0.85)",
  },
  {
    agentType: "opencode",
    label: "OpenCode",
    blurbKey: "dialogs.agent.engineBlurb.opencode",
    accent: "rgba(245,180,80,0.85)",
  },
];

export const ENGINE_ACCENT: Record<AgentBackendType, string> = {
  claude: "rgba(100,160,255,0.85)",
  codex: "rgba(120,220,160,0.85)",
  opencode: "rgba(245,180,80,0.85)",
};

export function alternateEngineOptions(current: AgentBackendType) {
  return ENGINE_OPTIONS.filter((option) => option.agentType !== current);
}
