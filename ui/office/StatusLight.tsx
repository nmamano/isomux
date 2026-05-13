import type { AgentState } from "../../shared/types.ts";

const COLORS: Record<string, string> = {
  thinking: "var(--green)",
  tool_executing: "var(--green)",
  waiting_for_response: "var(--purple)",
  idle: "var(--text-muted)",
  error: "var(--red)",
  stopped: "var(--text-muted)",
};

const ESCALATION_AMBER_MS = 2 * 60 * 1000;
const ESCALATION_RED_MS = 5 * 60 * 1000;

export function StatusLight({
  state,
  size = 10,
  elapsedMs,
}: {
  state: AgentState;
  size?: number;
  elapsedMs?: number;
}) {
  let c = COLORS[state] || "var(--text-muted)";
  // Apply escalation colors for active states
  if (
    elapsedMs != null &&
    (state === "thinking" || state === "tool_executing")
  ) {
    if (elapsedMs >= ESCALATION_RED_MS) c = "var(--red)";
    else if (elapsedMs >= ESCALATION_AMBER_MS) c = "var(--orange)";
  }
  const pulse = state !== "idle" && state !== "stopped";
  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        width: size,
        height: size,
      }}
    >
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
