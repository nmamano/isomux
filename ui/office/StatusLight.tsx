import type { AgentState } from "../../shared/types.ts";

const COLORS: Record<string, string> = {
  thinking: "var(--green)",
  tool_executing: "var(--green)",
  waiting_permission: "var(--orange)",
  idle: "var(--text-muted)",
  error: "var(--red)",
  starting: "var(--purple)",
  stopped: "var(--text-muted)",
};

export function StatusLight({ state, size = 10 }: { state: AgentState; size?: number }) {
  const c = COLORS[state] || "var(--text-muted)";
  const pulse = state !== "idle" && state !== "stopped";
  return (
    <span style={{ position: "relative", display: "inline-flex", width: size, height: size }}>
      {pulse && (
        <span
          style={{
            position: "absolute",
            inset: -3,
            borderRadius: "50%",
            background: c,
            opacity: 0.3,
            animation: "dotPulse 2s ease-in-out infinite",
          }}
        />
      )}
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: c,
          boxShadow: `0 0 ${size}px ${c}`,
        }}
      />
    </span>
  );
}
