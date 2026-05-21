// Two-button engine picker that gates the spawn flow. The Round 3 decision
// for the Codex backend was "two separate buttons in the room — `+ New
// Claude Agent` and `+ New Codex Agent` — agentType is the only setting
// locked at creation, so make the irreversible choice obvious." This dialog
// surfaces that choice as the first step of spawning, before the full
// EditAgentDialog opens with agentType frozen.

import type { AgentBackendType } from "../../shared/types.ts";

type Props = {
  onPick: (agentType: AgentBackendType) => void;
  onCancel: () => void;
};

const ENGINE_OPTIONS: Array<{
  agentType: AgentBackendType;
  label: string;
  blurb: string;
  accent: string;
}> = [
  {
    agentType: "claude",
    label: "Claude",
    blurb: "Anthropic. Uses your Claude Code login.",
    accent: "rgba(100,160,255,0.85)",
  },
  {
    agentType: "codex",
    label: "Codex",
    blurb:
      "OpenAI — GPT-5 family. Uses your ChatGPT subscription or OPENAI_API_KEY.",
    accent: "rgba(120,220,160,0.85)",
  },
];

export function EngineChooserDialog({ onPick, onCancel }: Props) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--border-light)",
          borderRadius: 16,
          padding: 20,
          width: 460,
          maxWidth: "90vw",
          boxShadow: "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <h3
          style={{
            margin: 0,
            marginBottom: 4,
            fontSize: 17,
            fontWeight: 700,
            color: "var(--text-primary)",
          }}
        >
          Spawn an agent
        </h3>
        <p
          style={{
            margin: 0,
            marginBottom: 16,
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          Pick the engine. Fixed for the agent's lifetime.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ENGINE_OPTIONS.map((opt) => (
            <button
              key={opt.agentType}
              onClick={() => onPick(opt.agentType)}
              style={{
                background: "var(--bg-surface)",
                border: `2px solid ${opt.accent}`,
                borderRadius: 8,
                padding: "12px 14px",
                textAlign: "left",
                cursor: "pointer",
                color: "var(--text-primary)",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                + New {opt.label} Agent
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  lineHeight: 1.4,
                }}
              >
                {opt.blurb}
              </div>
            </button>
          ))}
        </div>
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}
        >
          <button
            onClick={onCancel}
            style={{
              background: "transparent",
              border: "1px solid var(--border-medium)",
              borderRadius: 6,
              padding: "6px 14px",
              fontSize: 13,
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
