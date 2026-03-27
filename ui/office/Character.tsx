import type { AgentState, AgentOutfit } from "../../shared/types.ts";

// Map our states to visual poses
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

export function Character({ state, outfit }: { state: AgentState; outfit: AgentOutfit }) {
  const skin = "#FFD5B8";
  const bc = outfit.color;
  const hair = outfit.hair;
  const vs = visualState(state);

  const wrap = (children: React.ReactNode, anim?: React.CSSProperties) => (
    <svg
      width="52"
      height="68"
      viewBox="0 0 52 68"
      overflow="visible"
      style={{ filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.35))", ...anim }}
    >
      {children}
    </svg>
  );

  if (vs === "idle") {
    return wrap(
      <>
        <ellipse cx="26" cy="44" rx="11" ry="7" fill={bc} />
        <ellipse cx="26" cy="37" rx="10" ry="9" fill={skin} />
        <ellipse cx="26" cy="31" rx="10" ry="5.5" fill={hair} />
        {outfit.accessory === "glasses" && <rect x="18" y="37" width="5" height="3" rx="1" fill="#555" opacity="0.5" />}
        <g>
          <text x="38" y="28" fontSize="10" fill="rgba(200,220,255,0.35)" fontFamily="monospace">
            <animate attributeName="y" values="28;23;28" dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.3;0.7;0.3" dur="2s" repeatCount="indefinite" />
            z
          </text>
          <text x="43" y="20" fontSize="8" fill="rgba(200,220,255,0.25)" fontFamily="monospace">
            <animate attributeName="y" values="20;15;20" dur="2.5s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.2;0.5;0.2" dur="2.5s" repeatCount="indefinite" />
            z
          </text>
        </g>
      </>
    );
  }

  if (vs === "error") {
    return wrap(
      <>
        <rect x="16" y="36" width="20" height="16" fill={bc} rx="3" />
        <rect x="5" y="28" width="7" height="4" fill={skin} rx="2" transform="rotate(-25 8 30)" />
        <rect x="40" y="28" width="7" height="4" fill={skin} rx="2" transform="rotate(25 43 30)" />
        <ellipse cx="26" cy="25" rx="10" ry="10" fill={skin} />
        <ellipse cx="26" cy="18" rx="10" ry="5.5" fill={hair} />
        {outfit.hat === "cap" && (
          <>
            <path d="M15 20 Q26 12 37 20" fill={bc} />
            <rect x="11" y="19" width="15" height="3" fill={bc} rx="1" />
          </>
        )}
        {outfit.hat === "beanie" && <ellipse cx="26" cy="16" rx="11" ry="6.5" fill={bc} />}
        <g stroke="#c33" strokeWidth="1.5" strokeLinecap="round">
          <line x1="20" y1="22" x2="23" y2="26" />
          <line x1="23" y1="22" x2="20" y2="26" />
          <line x1="29" y1="22" x2="32" y2="26" />
          <line x1="32" y1="22" x2="29" y2="26" />
        </g>
        <path d="M22 31 Q24 29 26 31 Q28 33 30 31" stroke="#c33" fill="none" strokeWidth="0.8" />
        <g>
          <circle cx="42" cy="10" r="8" fill="#E85D75">
            <animate attributeName="r" values="8;9;8" dur="1s" repeatCount="indefinite" />
          </circle>
          <text x="39" y="14" fontSize="11" fill="white" fontWeight="bold">
            !
          </text>
        </g>
        <rect x="18" y="52" width="6" height="10" fill="#444" rx="2" />
        <rect x="28" y="52" width="6" height="10" fill="#444" rx="2" />
      </>,
      { animation: "errShake 0.4s ease-in-out infinite" }
    );
  }

  if (vs === "waiting") {
    return wrap(
      <>
        <rect x="16" y="36" width="20" height="16" fill={bc} rx="3" />
        <g>
          <rect x="38" y="20" width="7" height="10" fill={skin} rx="2">
            <animate
              attributeName="transform"
              values="rotate(-5 41 25);rotate(12 41 25);rotate(-5 41 25)"
              dur="0.8s"
              repeatCount="indefinite"
            />
          </rect>
          <circle cx="41" cy="17" r="5.5" fill={skin}>
            <animate attributeName="cy" values="17;15;17" dur="0.8s" repeatCount="indefinite" />
          </circle>
        </g>
        <rect x="7" y="40" width="7" height="4" fill={skin} rx="2" />
        <ellipse cx="26" cy="25" rx="10" ry="10" fill={skin} />
        <ellipse cx="26" cy="18" rx="10" ry="5.5" fill={hair} />
        {outfit.hat === "cap" && (
          <>
            <path d="M15 20 Q26 12 37 20" fill={bc} />
            <rect x="11" y="19" width="15" height="3" fill={bc} rx="1" />
          </>
        )}
        {outfit.hat === "beanie" && <ellipse cx="26" cy="16" rx="11" ry="6.5" fill={bc} />}
        {outfit.accessory === "glasses" && (
          <>
            <circle cx="22" cy="25" r="4" stroke="#666" fill="none" strokeWidth="0.8" />
            <circle cx="30" cy="25" r="4" stroke="#666" fill="none" strokeWidth="0.8" />
          </>
        )}
        {outfit.accessory === "headphones" && (
          <path d="M14 20 Q14 9 26 9 Q38 9 38 20" stroke="#555" fill="none" strokeWidth="3" />
        )}
        <circle cx="22" cy="26" r="1.8" fill="#333" />
        <circle cx="30" cy="26" r="1.8" fill="#333" />
        <circle cx="22.5" cy="25.5" r="0.6" fill="white" />
        <circle cx="30.5" cy="25.5" r="0.6" fill="white" />
        <path d="M23 30 Q26 32 29 30" stroke="#333" fill="none" strokeWidth="0.8" />
        <g>
          <rect x="0" y="4" width="14" height="13" rx="5" fill="#F5A623" opacity="0.9">
            <animate attributeName="opacity" values="0.9;0.55;0.9" dur="2s" repeatCount="indefinite" />
          </rect>
          <text x="4" y="14" fontSize="10" fill="white" fontWeight="bold">
            ?
          </text>
        </g>
        <rect x="18" y="52" width="6" height="10" fill="#444" rx="2" />
        <rect x="28" y="52" width="6" height="10" fill="#444" rx="2" />
      </>,
      { animation: "waitBounce 2s ease-in-out infinite" }
    );
  }

  // working / starting
  return wrap(
    <>
      <rect x="16" y="36" width="20" height="16" fill={bc} rx="3" />
      <g>
        <rect x="7" y="42" width="8" height="4" fill={skin} rx="2">
          <animate attributeName="y" values="42;41;42" dur="0.3s" repeatCount="indefinite" />
        </rect>
        <rect x="37" y="42" width="8" height="4" fill={skin} rx="2">
          <animate attributeName="y" values="42;43;42" dur="0.3s" repeatCount="indefinite" />
        </rect>
      </g>
      <ellipse cx="26" cy="25" rx="10" ry="10" fill={skin} />
      <ellipse cx="26" cy="18" rx="10" ry="5.5" fill={hair} />
      {outfit.hat === "cap" && (
        <>
          <path d="M15 20 Q26 12 37 20" fill={bc} />
          <rect x="28" y="19" width="15" height="3" fill={bc} rx="1" />
        </>
      )}
      {outfit.hat === "beanie" && <ellipse cx="26" cy="16" rx="11" ry="6.5" fill={bc} />}
      {outfit.accessory === "glasses" && (
        <>
          <circle cx="22" cy="25" r="4" stroke="#666" fill="none" strokeWidth="0.8" />
          <circle cx="30" cy="25" r="4" stroke="#666" fill="none" strokeWidth="0.8" />
          <line x1="26" y1="25" x2="26" y2="25" stroke="#666" strokeWidth="0.8" />
        </>
      )}
      {outfit.accessory === "headphones" && (
        <path d="M14 20 Q14 9 26 9 Q38 9 38 20" stroke="#555" fill="none" strokeWidth="3" />
      )}
      <circle cx="22" cy="26" r="1.5" fill="#333" />
      <circle cx="30" cy="26" r="1.5" fill="#333" />
      <rect x="18" y="52" width="6" height="10" fill="#444" rx="2" />
      <rect x="28" y="52" width="6" height="10" fill="#444" rx="2" />
    </>
  );
}
