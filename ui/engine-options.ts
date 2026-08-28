import type { AgentBackendType } from "../shared/types.ts";

export const ENGINE_OPTIONS: Array<{
  agentType: AgentBackendType;
  label: string;
  blurb: string;
  accent: string;
}> = [
  {
    agentType: "claude",
    label: "Claude",
    blurb: "Works with your Claude Code login.",
    accent: "rgba(100,160,255,0.85)",
  },
  {
    agentType: "codex",
    label: "Codex",
    blurb: "Works with your ChatGPT login.",
    accent: "rgba(120,220,160,0.85)",
  },
  {
    agentType: "opencode",
    label: "OpenCode",
    blurb: "Works with models configured through OpenCode.",
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
