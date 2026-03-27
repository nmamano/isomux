import type { AgentState } from "../../shared/types.ts";

const COLORS: Record<string, string> = {
  thinking: "#50B86C",
  tool_executing: "#50B86C",
  waiting_permission: "#F5A623",
  idle: "#5a6f8f",
  error: "#E85D75",
  starting: "#9B6DFF",
  stopped: "#5a6f8f",
};

export function StatusLight({ state, size = 10 }: { state: AgentState; size?: number }) {
  const c = COLORS[state] || "#5a6f8f";
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
