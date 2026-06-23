// Two-button engine picker that gates the spawn flow. The Round 3 decision
// for the Codex backend was "two separate buttons in the room — `+ New
// Claude Agent` and `+ New Codex Agent` — agentType is the only setting
// locked at creation, so make the irreversible choice obvious." This dialog
// surfaces that choice as the first step of spawning, before the full
// EditAgentDialog opens with agentType frozen.
//
// Below the engine buttons we render a "Revive" row of chips for any
// previously-killed agents (server-capped at 12, ACL-filtered per session).
// Clicking a chip restores the agent at the target desk with the same id,
// same outfit, and its preserved config — picking up the conversation from
// the resumable lastSessionId if the rollout/jsonl still exists.

import { useState } from "react";
import type {
  AgentBackendType,
  KilledAgentSummary,
} from "../../shared/types.ts";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { ReviveReq } from "../../shared/contract-shapes.ts";

type Props = {
  // The empty desk the user clicked. Used as the placement target for
  // both the new-engine path (passed through onPick) and revive.
  deskIndex: number;
  // The roomId of the room the user is currently viewing. Revive uses
  // this for placement; the original lastRoomId may differ or no
  // longer exist.
  roomId: string;
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

const ENGINE_ACCENT: Record<AgentBackendType, string> = {
  claude: "rgba(100,160,255,0.85)",
  codex: "rgba(120,220,160,0.85)",
};

export function EngineChooserDialog({
  deskIndex,
  roomId,
  onPick,
  onCancel,
}: Props) {
  const state = useAppState();
  const killedAgents = state.killedAgents;
  const [reviving, setReviving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  function handleRevive(agent: KilledAgentSummary) {
    if (reviving) return; // one revive at a time per dialog
    setError(null);
    setReviving(agent.id);
    apiFetch("POST", `/api/agents/${agent.id}/revive`, {
      desk: deskIndex,
      roomId,
    } satisfies ReviveReq)
      .then(() => onCancel()) // close; killed_agent_removed drops the chip
      .catch((e) => {
        // ApiError carries the server message; anything else (network/shim) falls
        // back to a generic message so the dialog never fails silently.
        setError(
          e instanceof ApiError
            ? e.message || "Revive failed"
            : "Revive failed",
        );
      })
      .finally(() => setReviving(null));
  }

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
          maxHeight: "85vh",
          overflowY: "auto",
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
        {killedAgents.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--text-dim)",
                marginBottom: 8,
              }}
            >
              Revive a killed agent
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
              }}
            >
              {killedAgents.map((agent) => {
                const accent = ENGINE_ACCENT[agent.agentType];
                const isThisReviving = reviving === agent.id;
                const disabled = reviving !== null && !isThisReviving;
                const title = agent.topic
                  ? `${agent.lastRoomName} — ${agent.topic}`
                  : agent.lastRoomName;
                return (
                  <button
                    key={agent.id}
                    onClick={() => handleRevive(agent)}
                    disabled={disabled}
                    title={title}
                    style={{
                      background: "var(--bg-surface)",
                      border: `1.5px solid ${accent}`,
                      borderRadius: 999,
                      padding: "5px 10px",
                      fontSize: 12,
                      color: "var(--text-primary)",
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled ? 0.4 : 1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      maxWidth: "100%",
                    }}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isThisReviving ? "Reviving…" : agent.name}
                    </span>
                  </button>
                );
              })}
            </div>
            {error && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: "var(--accent-error, #f88)",
                }}
              >
                {error}
              </div>
            )}
          </div>
        )}
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
