import type { AgentState } from "../../shared/types.ts";

const COLORS: Record<string, string> = {
  thinking: "var(--green)",
  tool_executing: "var(--green)",
  waiting_for_response: "var(--purple)",
  idle: "var(--text-muted)",
  error: "var(--red)",
  stopped: "var(--text-muted)",
};

/** A state's light colour, as a CSS value. */
export function statusColor(state: AgentState): string {
  return COLORS[state] || "var(--text-muted)";
}

const ESCALATION_AMBER_MS = 2 * 60 * 1000;
const ESCALATION_RED_MS = 5 * 60 * 1000;

export function StatusLight({
  state,
  size = 10,
  elapsedMs,
  ring = false,
}: {
  state: AgentState;
  size?: number;
  elapsedMs?: number;
  /** A dark edge, so a small light reads on any background. */
  ring?: boolean;
}) {
  let c = statusColor(state);
  if (
    elapsedMs != null &&
    (state === "thinking" || state === "tool_executing")
  ) {
    if (elapsedMs >= ESCALATION_RED_MS) c = "var(--red)";
    else if (elapsedMs >= ESCALATION_AMBER_MS) c = "var(--orange)";
  }
  // A light never pulses: its colour says the state, and the amber and
  // red of a long turn are the warning.
  return (
    <span
      style={{
        display: "inline-block",
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: "50%",
        background: c,
        boxShadow: ring
          ? `0 0 0 1px rgba(0,0,0,0.55), 0 0 ${size}px ${c}`
          : `0 0 ${size}px ${c}`,
      }}
    />
  );
}
