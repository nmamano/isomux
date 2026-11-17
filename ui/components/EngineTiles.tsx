import type { AgentBackendType } from "../../shared/types.ts";
import { ENGINE_OPTIONS } from "../engine-options.ts";
import { useI18n } from "../i18n.tsx";

// The engine setting's one control (AGENTS.md "UI rules"; task ff602b30): an
// option tile per engine, with its hint, in the New agent dialog, on the Agent
// settings page and in the schedule dialog. Each place decides which engines it
// disables; the tile shows the needs-Linux reason for an engine the host cannot
// run.
export function EngineTiles({
  labelId,
  value,
  onChange,
  isDisabled,
  unavailable,
}: {
  labelId: string;
  value: AgentBackendType;
  onChange: (engine: AgentBackendType) => void;
  isDisabled: (engine: AgentBackendType) => boolean;
  unavailable: (engine: AgentBackendType) => boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="engine-options" role="group" aria-labelledby={labelId}>
      {ENGINE_OPTIONS.map((option) => {
        const selected = value === option.agentType;
        const disabled = isDisabled(option.agentType);
        return (
          <button
            key={option.agentType}
            type="button"
            data-engine={option.agentType}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.agentType)}
            style={{
              background: selected ? "var(--bg-hover)" : "var(--bg-surface)",
              border: `2px solid ${selected ? option.accent : "var(--border-medium)"}`,
              borderRadius: 8,
              padding: "12px 14px",
              textAlign: "left",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.55 : 1,
              color: disabled ? "var(--text-hint)" : "var(--text-primary)",
              boxShadow: selected ? `0 0 0 1px ${option.accent}` : "none",
            }}
          >
            <span
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 700,
                marginBottom: 4,
              }}
            >
              {option.label}
            </span>
            <span
              style={{
                display: "block",
                fontSize: 12,
                color: "var(--text-dim)",
                lineHeight: 1.4,
              }}
            >
              {unavailable(option.agentType)
                ? t("dialogs.agent.engineNeedsLinux")
                : t(option.blurbKey)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
