import type { AgentState, AgentOutfit } from "../../shared/types.ts";

// Map our states to visual poses
function visualState(state: AgentState): "working" | "waiting_for_response" | "error" | "idle" {
  switch (state) {
    case "thinking":
    case "tool_executing":
      return "working";
    case "waiting_for_response":
      return "waiting_for_response";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** Render hair based on style, positioned relative to head center */
function Hair({ style, color, headCx, headCy }: { style: AgentOutfit["hairStyle"]; color: string; headCx: number; headCy: number }) {
  const topY = headCy - 6;
  switch (style) {
    case "long":
      return (
        <>
          <ellipse cx={headCx} cy={topY} rx={10} ry={5.5} fill={color} />
          {/* Hair flowing down sides, touching the top of the hair cap */}
          <rect x={headCx - 12} y={topY - 1} width={5} height={16} rx={2.5} fill={color} />
          <rect x={headCx + 7} y={topY - 1} width={5} height={16} rx={2.5} fill={color} />
        </>
      );
    case "ponytail":
      return (
        <>
          <ellipse cx={headCx} cy={topY} rx={10} ry={5.5} fill={color} />
          {/* Ponytail swooping to the right */}
          <path
            d={`M${headCx + 8} ${topY} Q${headCx + 16} ${topY - 2} ${headCx + 14} ${topY + 10} Q${headCx + 13} ${topY + 16} ${headCx + 10} ${topY + 14}`}
            fill={color}
          />
          {/* Hair tie at the intersection of head and tail */}
          <circle cx={headCx + 10} cy={topY + 1} r={1.5} fill="#FF6B9D" />
        </>
      );
    case "bun":
      return (
        <>
          <ellipse cx={headCx} cy={topY} rx={10} ry={5.5} fill={color} />
          {/* Round bun on top */}
          <circle cx={headCx} cy={topY - 4} r={5} fill={color} />
        </>
      );
    case "pigtails":
      return (
        <>
          <ellipse cx={headCx} cy={topY} rx={10} ry={5.5} fill={color} />
          {/* Two pigtails */}
          <ellipse cx={headCx - 12} cy={topY + 5} rx={3} ry={6} fill={color} />
          <ellipse cx={headCx + 12} cy={topY + 5} rx={3} ry={6} fill={color} />
          {/* Cute hair ties */}
          <circle cx={headCx - 11} cy={topY + 1} r={1.5} fill="#FF6B9D" />
          <circle cx={headCx + 11} cy={topY + 1} r={1.5} fill="#FF6B9D" />
        </>
      );
    case "curly":
      return (
        <>
          <ellipse cx={headCx} cy={topY - 1} rx={12} ry={7} fill={color} />
          {/* Curly volume bumps */}
          <circle cx={headCx - 10} cy={topY + 3} r={3.5} fill={color} />
          <circle cx={headCx + 10} cy={topY + 3} r={3.5} fill={color} />
          <circle cx={headCx - 6} cy={topY - 5} r={3} fill={color} />
          <circle cx={headCx + 6} cy={topY - 5} r={3} fill={color} />
        </>
      );
    case "bald":
      return null;
    default: // "short"
      return <ellipse cx={headCx} cy={topY} rx={10} ry={5.5} fill={color} />;
  }
}

/** Render hat */
function Hat({ type, color, headCx, headCy }: { type: AgentOutfit["hat"]; color: string; headCx: number; headCy: number }) {
  const topY = headCy - 6;
  switch (type) {
    case "cap":
      return (
        <>
          <path d={`M${headCx - 13} ${topY + 2} Q${headCx} ${topY - 14} ${headCx + 13} ${topY + 2}`} fill={color} />
          <rect x={headCx - 15} y={topY + 1} width={27} height={3} fill={color} rx={1} />
        </>
      );
    case "beanie":
      return <ellipse cx={headCx} cy={topY - 2} rx={11} ry={6.5} fill={color} />;
    case "bow":
      return (
        <>
          {/* Cute hair bow */}
          <path d={`M${headCx - 2} ${topY - 3} Q${headCx - 8} ${topY - 9} ${headCx - 2} ${topY - 6}`} fill="#FF6B9D" />
          <path d={`M${headCx + 2} ${topY - 3} Q${headCx + 8} ${topY - 9} ${headCx + 2} ${topY - 6}`} fill="#FF6B9D" />
          <circle cx={headCx} cy={topY - 4.5} r={1.5} fill="#E84393" />
        </>
      );
    case "headband":
      return (
        <path
          d={`M${headCx - 10} ${topY + 2} Q${headCx} ${topY - 2} ${headCx + 10} ${topY + 2}`}
          stroke="#FF8C42"
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
        />
      );
    default:
      return null;
  }
}

/** Render beard */
function Beard({ type, color, headCx, headCy }: { type: AgentOutfit["beard"]; color: string; headCx: number; headCy: number }) {
  // Slightly darker version of hair color for beard
  switch (type) {
    case "stubble":
      return (
        <g fill={color} opacity={0.7}>
          {[[-4, 6], [-1, 6], [2, 6], [5, 6], [-5, 8], [-2, 8], [1, 8], [4, 8], [-3, 10], [0, 10], [3, 10], [-1, 11], [1, 11]].map(([dx, dy], i) => (
            <circle key={i} cx={headCx + dx} cy={headCy + dy} r={0.9} />
          ))}
        </g>
      );
    case "full":
      return (
        <path
          d={`M${headCx - 6} ${headCy + 5} Q${headCx - 7} ${headCy + 11} ${headCx} ${headCy + 13} Q${headCx + 7} ${headCy + 11} ${headCx + 6} ${headCy + 5}`}
          fill={color}
          opacity={0.9}
        />
      );
    case "goatee":
      return (
        <path
          d={`M${headCx - 4} ${headCy + 7} Q${headCx - 5} ${headCy + 11} ${headCx} ${headCy + 13} Q${headCx + 5} ${headCy + 11} ${headCx + 4} ${headCy + 7}`}
          fill={color}
          opacity={0.9}
        />
      );
    case "mustache":
      return (
        <>
          {/* Thick chevron mustache */}
          <path
            d={`M${headCx - 7} ${headCy + 7} Q${headCx - 4} ${headCy + 4} ${headCx} ${headCy + 5} Q${headCx + 4} ${headCy + 4} ${headCx + 7} ${headCy + 7} Q${headCx + 4} ${headCy + 6} ${headCx} ${headCy + 7} Q${headCx - 4} ${headCy + 6} ${headCx - 7} ${headCy + 7} Z`}
            fill={color}
            opacity={0.9}
          />
        </>
      );
    default:
      return null;
  }
}

/** Render accessory */
function Accessory({ type, headCx, headCy }: { type: AgentOutfit["accessory"]; headCx: number; headCy: number }) {
  switch (type) {
    case "glasses":
      return (
        <>
          <circle cx={headCx - 4} cy={headCy + 1} r={4} stroke="#666" fill="none" strokeWidth={0.8} />
          <circle cx={headCx + 4} cy={headCy + 1} r={4} stroke="#666" fill="none" strokeWidth={0.8} />
        </>
      );
    case "headphones":
      return (
        <>
          <path d={`M${headCx - 12} ${headCy - 4} Q${headCx - 12} ${headCy - 15} ${headCx} ${headCy - 15} Q${headCx + 12} ${headCy - 15} ${headCx + 12} ${headCy - 4}`} stroke="#555" fill="none" strokeWidth={3} />
          <rect x={headCx - 16} y={headCy - 6} width={8} height={10} rx={3} fill="#555" />
          <rect x={headCx + 8} y={headCy - 6} width={8} height={10} rx={3} fill="#555" />
        </>
      );
    case "bow_tie":
      return (
        <>
          {/* Bow tie at neck/collar area */}
          <path d={`M${headCx - 1} ${headCy + 10} L${headCx - 5} ${headCy + 7} L${headCx - 5} ${headCy + 13} Z`} fill="#E85D75" />
          <path d={`M${headCx + 1} ${headCy + 10} L${headCx + 5} ${headCy + 7} L${headCx + 5} ${headCy + 13} Z`} fill="#E85D75" />
          <circle cx={headCx} cy={headCy + 10} r={1.5} fill="#c33" />
        </>
      );
    case "tie":
      return (
        <>
          {/* Knot */}
          <path d={`M${headCx - 2} ${headCy + 9} L${headCx} ${headCy + 11} L${headCx + 2} ${headCy + 9} Z`} fill="#2c3e50" />
          {/* Tie body */}
          <path d={`M${headCx - 2} ${headCy + 11} L${headCx - 3} ${headCy + 22} L${headCx} ${headCy + 24} L${headCx + 3} ${headCy + 22} L${headCx + 2} ${headCy + 11} Z`} fill="#2c3e50" />
        </>
      );
    case "earrings":
      return (
        <>
          <circle cx={headCx - 10} cy={headCy + 4} r={2} fill="#FFD700" />
          <circle cx={headCx + 10} cy={headCy + 4} r={2} fill="#FFD700" />
        </>
      );
    default:
      return null;
  }
}

export function Character({ state, outfit }: { state: AgentState; outfit: AgentOutfit }) {
  const skin = outfit.skin ?? "#FFD5B8";
  const bc = outfit.color;
  const hair = outfit.hair;
  const hairStyle = outfit.hairStyle ?? "short";
  const beard = outfit.beard ?? "none";
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
    const hCx = 26, hCy = 37;
    return wrap(
      <>
        <ellipse cx={hCx} cy={50} rx={11} ry={10} fill={bc} />
        <ellipse cx={hCx} cy={hCy} rx={10} ry={9} fill={skin} />
        <Hair style={hairStyle} color={hair} headCx={hCx} headCy={hCy} />
        <Hat type={outfit.hat} color={bc} headCx={hCx} headCy={hCy} />
        <Accessory type={outfit.accessory} headCx={hCx} headCy={hCy} />
        {/* Closed eyes */}
        <line x1={hCx - 6} y1={hCy + 1} x2={hCx - 2} y2={hCy + 1} stroke="#333" strokeWidth={1} strokeLinecap="round" />
        <line x1={hCx + 2} y1={hCy + 1} x2={hCx + 6} y2={hCy + 1} stroke="#333" strokeWidth={1} strokeLinecap="round" />
        <Beard type={beard} color={hair} headCx={hCx} headCy={hCy} />
        <g>
          <text x="36" y="28" fontSize="14" fill="rgba(200,220,255,0.7)" fontFamily="monospace" fontWeight="bold">
            <animate attributeName="y" values="28;22;28" dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0.9;0.5" dur="2s" repeatCount="indefinite" />
            z
          </text>
          <text x="44" y="18" fontSize="12" fill="rgba(200,220,255,0.6)" fontFamily="monospace" fontWeight="bold">
            <animate attributeName="y" values="18;12;18" dur="2.5s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.4;0.8;0.4" dur="2.5s" repeatCount="indefinite" />
            z
          </text>
          <text x="50" y="10" fontSize="10" fill="rgba(200,220,255,0.5)" fontFamily="monospace" fontWeight="bold">
            <animate attributeName="y" values="10;4;10" dur="3s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.3;0.7;0.3" dur="3s" repeatCount="indefinite" />
            z
          </text>
        </g>
      </>
    );
  }

  if (vs === "error") {
    const hCx = 26, hCy = 25;
    return wrap(
      <>
        <rect x={16} y={36} width={20} height={16} fill={bc} rx={3} />
        <rect x={5} y={28} width={7} height={4} fill={skin} rx={2} transform="rotate(-25 8 30)" />
        <rect x={40} y={28} width={7} height={4} fill={skin} rx={2} transform="rotate(25 43 30)" />
        <ellipse cx={hCx} cy={hCy} rx={10} ry={10} fill={skin} />
        <Hair style={hairStyle} color={hair} headCx={hCx} headCy={hCy} />
        <Hat type={outfit.hat} color={bc} headCx={hCx} headCy={hCy} />
        <g stroke="#c33" strokeWidth={1.5} strokeLinecap="round">
          <line x1={hCx - 6} y1={hCy - 3} x2={hCx - 3} y2={hCy + 1} />
          <line x1={hCx - 3} y1={hCy - 3} x2={hCx - 6} y2={hCy + 1} />
          <line x1={hCx + 3} y1={hCy - 3} x2={hCx + 6} y2={hCy + 1} />
          <line x1={hCx + 6} y1={hCy - 3} x2={hCx + 3} y2={hCy + 1} />
        </g>
        <path d={`M${hCx - 4} ${hCy + 6} Q${hCx - 2} ${hCy + 4} ${hCx} ${hCy + 6} Q${hCx + 2} ${hCy + 8} ${hCx + 4} ${hCy + 6}`} stroke="#c33" fill="none" strokeWidth={0.8} />
        <Beard type={beard} color={hair} headCx={hCx} headCy={hCy} />
        <g>
          <circle cx={42} cy={10} r={8} fill="#E85D75">
            <animate attributeName="r" values="8;9;8" dur="1s" repeatCount="indefinite" />
          </circle>
          <text x={39} y={14} fontSize={11} fill="white" fontWeight="bold">
            !
          </text>
        </g>
        <rect x={18} y={52} width={6} height={10} fill="#444" rx={2} />
        <rect x={28} y={52} width={6} height={10} fill="#444" rx={2} />
      </>,
      { animation: "errShake 0.4s ease-in-out infinite" }
    );
  }

  if (vs === "waiting_for_response") {
    const hCx = 26, hCy = 25;
    return wrap(
      <>
        <rect x={16} y={36} width={20} height={16} fill={bc} rx={3} />
        <g>
          <rect x={38} y={20} width={7} height={10} fill={skin} rx={2}>
            <animate
              attributeName="transform"
              values="rotate(-5 41 25);rotate(12 41 25);rotate(-5 41 25)"
              dur="0.8s"
              repeatCount="indefinite"
            />
          </rect>
          <circle cx={41} cy={17} r={5.5} fill={skin}>
            <animate attributeName="cy" values="17;15;17" dur="0.8s" repeatCount="indefinite" />
          </circle>
        </g>
        <rect x={7} y={40} width={7} height={4} fill={skin} rx={2} />
        <ellipse cx={hCx} cy={hCy} rx={10} ry={10} fill={skin} />
        <Hair style={hairStyle} color={hair} headCx={hCx} headCy={hCy} />
        <Hat type={outfit.hat} color={bc} headCx={hCx} headCy={hCy} />
        <Accessory type={outfit.accessory} headCx={hCx} headCy={hCy} />
        <circle cx={hCx - 4} cy={hCy + 1} r={1.8} fill="#333" />
        <circle cx={hCx + 4} cy={hCy + 1} r={1.8} fill="#333" />
        <circle cx={hCx - 3.5} cy={hCy + 0.5} r={0.6} fill="white" />
        <circle cx={hCx + 4.5} cy={hCy + 0.5} r={0.6} fill="white" />
        <path d={`M${hCx - 3} ${hCy + 5} Q${hCx} ${hCy + 7} ${hCx + 3} ${hCy + 5}`} stroke="#333" fill="none" strokeWidth={0.8} />
        <Beard type={beard} color={hair} headCx={hCx} headCy={hCy} />
        <rect x={18} y={52} width={6} height={10} fill="#444" rx={2} />
        <rect x={28} y={52} width={6} height={10} fill="#444" rx={2} />
      </>,
      { animation: "waitBounce 2s ease-in-out infinite" }
    );
  }

  // working / starting
  const hCx = 26, hCy = 25;
  return wrap(
    <>
      <rect x={16} y={36} width={20} height={16} fill={bc} rx={3} />
      <g>
        <rect x={7} y={42} width={8} height={4} fill={skin} rx={2}>
          <animate attributeName="y" values="42;41;42" dur="0.3s" repeatCount="indefinite" />
        </rect>
        <rect x={37} y={42} width={8} height={4} fill={skin} rx={2}>
          <animate attributeName="y" values="42;43;42" dur="0.3s" repeatCount="indefinite" />
        </rect>
      </g>
      <ellipse cx={hCx} cy={hCy} rx={10} ry={10} fill={skin} />
      <Hair style={hairStyle} color={hair} headCx={hCx} headCy={hCy} />
      <Hat type={outfit.hat} color={bc} headCx={hCx} headCy={hCy} />
      <Accessory type={outfit.accessory} headCx={hCx} headCy={hCy} />
      <circle cx={hCx - 4} cy={hCy + 1} r={1.5} fill="#333" />
      <circle cx={hCx + 4} cy={hCy + 1} r={1.5} fill="#333" />
      <Beard type={beard} color={hair} headCx={hCx} headCy={hCy} />
      <rect x={18} y={52} width={6} height={10} fill="#444" rx={2} />
      <rect x={28} y={52} width={6} height={10} fill="#444" rx={2} />
    </>
  );
}
