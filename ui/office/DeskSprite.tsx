import type { AgentState } from "../../shared/types.ts";

// Map our states to visual categories
function visualState(state: AgentState): "working" | "waiting" | "error" | "idle" {
  switch (state) {
    case "thinking":
    case "tool_executing":
    case "starting":
      return "working";
    case "waiting_permission":
      return "waiting";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

export function DeskSprite({ state }: { state: AgentState }) {
  const vs = visualState(state);
  const glow = { working: "#50B86C", waiting: "#F5A623", error: "#E85D75", idle: "#223" }[vs];
  const on = vs !== "idle";

  return (
    <svg width="180" height="140" viewBox="0 0 180 140" overflow="visible">
      {/* Chair */}
      <path d="M56 95 L90 110 L124 95 L90 80 Z" fill="#2a2a3a" />
      <path d="M56 95 L56 72 L90 57 L90 80 Z" fill="#333345" stroke="#2a2a3a" strokeWidth="0.5" />
      <ellipse cx="90" cy="112" rx="20" ry="5" fill="#222" opacity="0.4" />
      <line x1="72" y1="112" x2="72" y2="116" stroke="#333" strokeWidth="1.5" />
      <line x1="108" y1="112" x2="108" y2="116" stroke="#333" strokeWidth="1.5" />
      <line x1="90" y1="114" x2="90" y2="118" stroke="#333" strokeWidth="1.5" />

      {/* Desktop surface */}
      <path d="M20 62 L90 28 L160 62 L90 96 Z" fill="#5C4C38" />
      <path d="M20 62 L90 96 L90 104 L20 70 Z" fill="#4A3C2A" />
      <path d="M90 96 L160 62 L160 70 L90 104 Z" fill="#3E3220" />

      {/* Front panel */}
      <path d="M40 72 L90 96 L140 72 L140 92 L90 116 L40 92 Z" fill="#3a2e20" />
      <path d="M40 72 L90 96 L90 116 L40 92 Z" fill="#352a1c" />

      {/* Monitor */}
      <path d="M64 16 L110 36 L110 62 L64 42 Z" fill="#222233" stroke="#1a1a28" strokeWidth="0.8" />
      <path d="M66 18 L108 37 L108 60 L66 41 Z" fill={on ? "#0d1117" : "#141820"} />
      {on && (
        <path d="M66 18 L108 37 L108 60 L66 41 Z" fill={glow} opacity="0.06">
          <animate attributeName="opacity" values="0.04;0.1;0.04" dur="3s" repeatCount="indefinite" />
        </path>
      )}
      {on && (
        <path d="M66 30 L108 48" stroke={glow} strokeWidth="0.3" opacity="0.15">
          <animate
            attributeName="d"
            values="M66 18 L108 37;M66 41 L108 60;M66 18 L108 37"
            dur="4s"
            repeatCount="indefinite"
          />
        </path>
      )}
      <line x1="87" y1="56" x2="87" y2="68" stroke="#222233" strokeWidth="3" />
      <path d="M78 68 L96 68 L92 72 L82 72 Z" fill="#222233" />

      {/* Keyboard */}
      <path d="M60 66 L87 79 L114 66 L87 53 Z" fill="#2a2a2a" stroke="#333" strokeWidth="0.4" />
      <path d="M68 64 L87 73 L106 64" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />
      <path d="M70 66 L87 74 L104 66" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />

      {/* Coffee mug */}
      <g>
        <ellipse cx="140" cy="55" rx="6" ry="3" fill="#7B5B14" />
        <path d="M134 55 L134 48 L146 48 L146 55" fill="none" stroke="#7B5B14" strokeWidth="1.5" />
        <path d="M146 50 Q151 50 151 53 Q151 56 146 55" fill="none" stroke="#7B5B14" strokeWidth="0.8" />
        {on && (
          <path d="M138 46 Q136 40 140 36" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8">
            <animate
              attributeName="d"
              values="M138 46 Q136 40 140 36;M138 46 Q140 38 137 33;M138 46 Q136 40 140 36"
              dur="2.5s"
              repeatCount="indefinite"
            />
          </path>
        )}
      </g>

      {/* Small plant */}
      <g transform="translate(32, 42)">
        <rect x="-3" y="0" width="6" height="7" rx="1" fill="#5a4a35" />
        <path d="M0 0 Q-6 -8 -2 -14" stroke="#3a7a3a" fill="none" strokeWidth="1.5" />
        <path d="M0 -2 Q4 -10 8 -12" stroke="#4a8a4a" fill="none" strokeWidth="1.2" />
        <path d="M0 -1 Q-3 -6 1 -10" stroke="#3a7a3a" fill="none" strokeWidth="1" />
      </g>

      {/* Shadow under desk */}
      <ellipse cx="90" cy="108" rx="60" ry="12" fill="rgba(0,0,0,0.15)" />
    </svg>
  );
}
