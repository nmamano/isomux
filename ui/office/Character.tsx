import type { AgentState, AgentOutfit } from "../../shared/types.ts";

import { costumeOf } from "../../shared/outfit-options.ts";
import { COSTUME_COLORS, CostumeBody, CostumeHead } from "./Costume.tsx";

export const CHARACTER_GEOMETRY = { width: 52, height: 68, feetY: 62 } as const;

function visualState(
  state: AgentState,
): "working" | "waiting_for_response" | "error" | "idle" {
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

/** Hair paths use the head center so both poses share the same silhouette. */
function Hair({ style, color, headCx, headCy }: {
  style: AgentOutfit["hairStyle"]; color: string; headCx: number; headCy: number;
}) {
  if (style === "bald") return null;
  const cap = "M-10 0 Q-12 -10 -3 -11 Q7 -14 10 -5 L10 0 L8 -3 Q4 -3 2 -7 Q-2 -2 -8 -3 Z";
  let shape: React.ReactNode;
  switch (style) {
    case "long":
      shape = <>
        <path d="M-11 7 L-11 -4 Q-11 -12 0 -12 Q11 -12 11 -4 L12 10 Q9 12 7 9 L7 -4 Q1 -3 -2 -8 Q-4 -4 -8 -3 L-7 9 Q-10 12 -12 9 Z" />
        <path d="M-9 -1 L-9 8 M9 -1 L10 8" fill="none" stroke="white" strokeOpacity=".12" />
      </>;
      break;
    case "ponytail":
      shape = <>
        <path d="M8 -6 Q16 -10 16 -1 Q16 7 11 10 Q13 4 10 1 L8 -3 Z" />
        <path d="M13 -4 Q15 1 12 6" fill="none" stroke="white" strokeOpacity=".12" />
        <path d={cap} />
        <path d="M10 -5 L11 -2" stroke="#da7796" strokeWidth="2" />
      </>;
      break;
    case "bun":
      shape = <>
        <ellipse cy="-12" rx="5" ry="4.5" />
        <path d="M-3 -14 Q1 -17 3 -12" fill="none" stroke="white" strokeOpacity=".16" />
        <path d={cap} />
      </>;
      break;
    case "pigtails":
      shape = <>
        <path d="M-8 -5 Q-16 -7 -15 1 Q-15 6 -11 8 L-10 1 Z M8 -5 Q16 -7 15 1 Q15 6 11 8 L10 1 Z" />
        <path d={cap} />
        <path d="M-12 -3 L-10 -2 M10 -2 L12 -3" stroke="#da7796" strokeWidth="2" />
      </>;
      break;
    case "curly":
      shape = <>
        <path d="M-10 1 Q-15 0 -12 -5 Q-14 -10 -8 -11 Q-7 -15 -2 -12 Q2 -16 6 -12 Q12 -13 12 -7 Q16 -3 11 1 Q8 3 7 -2 Q4 1 1 -3 Q-3 0 -5 -3 Q-8 3 -10 1 Z" />
        <path d="M-9 -8 Q-6 -11 -4 -8 M0 -9 Q3 -12 5 -8 M8 -6 Q11 -6 10 -3" fill="none" stroke="white" strokeOpacity=".15" />
      </>;
      break;
    default:
      shape = <path d={cap} />;
  }
  return <g transform={`translate(${headCx} ${headCy})`} fill={color} strokeLinecap="round" strokeWidth=".8">
    {shape}
    {style !== "curly" && <path d="M-7 -7 Q-3 -11 2 -9" fill="none" stroke="white" strokeOpacity=".13" />}
  </g>;
}

function Hat({ type, color, headCx, headCy }: {
  type: AgentOutfit["hat"]; color: string; headCx: number; headCy: number;
}) {
  let shape: React.ReactNode;
  switch (type) {
    case "cap":
      shape = <>
        <path d="M-11 -5 Q-12 -15 0 -15 Q11 -15 11 -5 Z" fill={color} />
        <path d="M0 -14 Q4 -11 3 -6" fill="none" stroke="white" strokeOpacity=".22" />
        <path d="M-11 -6 Q0 -7 11 -6 L13 -4 Q4 -1 -14 -3 Q-17 -4 -14 -5 Z" fill={color} />
        <path d="M-14 -4 Q0 -2 12 -4" fill="none" stroke="black" strokeOpacity=".22" strokeWidth="1.5" />
      </>;
      break;
    case "beanie":
      shape = <>
        <path d="M-11 -6 Q-12 -17 0 -17 Q12 -17 11 -6 Z" fill={color} />
        <path d="M-5 -14 L-6 -8 M0 -15 V-8 M5 -14 L6 -8" stroke="white" strokeOpacity=".16" />
        <path d="M-11 -8 Q0 -6 11 -8 V-3 Q0 -1 -11 -3 Z" fill={color} />
        <path d="M-11 -8 Q0 -6 11 -8 M-10 -3 Q0 -1 10 -3" fill="none" stroke="black" strokeOpacity=".18" />
      </>;
      break;
    case "bow":
      shape = <g transform="translate(3 -11) rotate(12)">
        <path d="M0 0 Q-7 -6 -7 -3 L-7 3 Q-6 5 0 1 Q7 5 7 3 V-3 Q6 -5 0 0 Z" fill="#df7596" />
        <path d="M-5 -1 L0 1 L5 -1" fill="none" stroke="#a8466e" />
        <rect x="-1.5" y="-1.5" width="3" height="4" rx="1" fill="#b94f79" />
      </g>;
      break;
    case "headband":
      shape = <>
        <path d="M-10 -1 Q-11 -11 0 -11 Q11 -11 10 -1" stroke="#cf743e" strokeWidth="2.5" fill="none" />
        <path d="M-8 -6 Q-6 -10 0 -10 Q5 -10 8 -6" stroke="#ffc68b" strokeWidth=".8" fill="none" />
      </>;
      break;
    default: return null;
  }
  return <g transform={`translate(${headCx} ${headCy})`} strokeWidth=".8" strokeLinejoin="round" strokeLinecap="round">{shape}</g>;
}

function Beard({ type, color, headCx, headCy }: {
  type: AgentOutfit["beard"]; color: string; headCx: number; headCy: number;
}) {
  let shape: React.ReactNode;
  switch (type) {
    case "stubble":
      shape = <>
        <path d="M-8 4 Q-6 10 0 10 Q6 10 8 4 L5 5 Q0 9 -5 5 Z" opacity=".22" />
        <g opacity=".65">{[[-6,5],[-4,7],[-2,8],[0,8.5],[2,8],[4,7],[6,5]].map(([x,y]) => <path key={x} d={`M${x} ${y} v.6`} stroke={color} strokeWidth=".7" />)}</g>
      </>;
      break;
    case "full":
      shape = <>
        <path d="M-9 2 L-7 4 Q-4 4 -3 6 Q0 8 3 6 Q4 4 7 4 L9 2 Q9 10 4 12 Q0 15 -4 12 Q-9 10 -9 2 Z" />
        <path d="M-5 8 Q0 13 5 8" fill="none" stroke="white" strokeOpacity=".13" strokeWidth=".8" />
      </>;
      break;
    case "goatee":
      shape = <>
        <path d="M-3.5 6 Q0 8 3.5 6 L3 11 Q0 14 -3 11 Z" />
        <path d="M-1.5 10 Q0 12 1.5 10" fill="none" stroke="white" strokeOpacity=".15" strokeWidth=".7" />
      </>;
      break;
    case "mustache":
      shape = <path d="M0 5 Q-2 3 -4 5 Q-5 6 -7 6 Q-6 9 -2 7 L0 6 L2 7 Q6 9 7 6 Q5 6 4 5 Q2 3 0 5 Z" />;
      break;
    default: return null;
  }
  return <g transform={`translate(${headCx} ${headCy})`} fill={color} strokeLinecap="round">{shape}</g>;
}

function Accessory({ type, headCx, headCy }: {
  type: AgentOutfit["accessory"]; headCx: number; headCy: number;
}) {
  let shape: React.ReactNode;
  switch (type) {
    case "glasses":
      shape = <g fill="none" stroke="#40505d" strokeWidth="1">
        <rect x="-8.5" y="-2" width="7" height="6" rx="2.3" />
        <rect x="1.5" y="-2" width="7" height="6" rx="2.3" />
        <path d="M-1.5 0 Q0 -1 1.5 0 M-10 -1 L-8.5 0 M8.5 0 L10 -1" />
        <path d="M-7 -1 H-5 M3 -1 H5" stroke="white" strokeOpacity=".5" strokeWidth=".7" />
      </g>;
      break;
    case "headphones":
      shape = <>
        <path d="M-12 0 V-4 Q-12 -14 0 -14 Q12 -14 12 -4 V0" fill="none" stroke="#35404d" strokeWidth="3" />
        <path d="M-10 -8 Q0 -17 10 -8" fill="none" stroke="#84909c" strokeWidth=".8" />
        <rect x="-14" y="-4" width="5" height="9" rx="2" fill="#35404d" />
        <rect x="9" y="-4" width="5" height="9" rx="2" fill="#35404d" />
        <path d="M-12 -2 V2 M12 -2 V2" stroke="#778390" strokeWidth="1.5" />
      </>;
      break;
    case "bow_tie":
      shape = <g transform="translate(0 13)">
        <path d="M-1 0 L-5 -2.5 Q-6 -2 -5 3 L-1 1 M1 0 L5 -2.5 Q6 -2 5 3 L1 1" fill="#ce637c" />
        <path d="M-4 0 L0 1 L4 0" fill="none" stroke="#9c3f5e" strokeWidth=".7" />
        <rect x="-1.2" y="-1" width="2.4" height="3" rx=".8" fill="#9c3f5e" />
      </g>;
      break;
    case "tie":
      shape = <>
        <path d="M-1.2 14 L-2.5 22 L0 24 L2.5 22 L1.2 14 Z" fill="#33465c" />
        <path d="M0 15 L1 22" stroke="#73879c" strokeWidth=".7" />
        <path d="M-2 11 H2 L1.2 14 H-1.2 Z" fill="#26384b" />
      </>;
      break;
    case "earrings":
      shape = <g stroke="#be9036" fill="none" strokeWidth="1.2">
        <ellipse cx="-10" cy="6" rx="1.6" ry="2.1" />
        <ellipse cx="10" cy="6" rx="1.6" ry="2.1" />
        <path d="M-11 5 V6 M9 5 V6" stroke="#ffe3a0" strokeWidth=".8" />
      </g>;
      break;
    default: return null;
  }
  return <g transform={`translate(${headCx} ${headCy})`} strokeLinecap="round" strokeLinejoin="round">{shape}</g>;
}

export function Character({
  state,
  outfit,
  portrait = false,
  height = CHARACTER_GEOMETRY.height,
}: {
  state: AgentState;
  outfit: AgentOutfit;
  portrait?: boolean;
  height?: number;
}) {
  const skin = outfit.skin ?? "#FFD5B8";
  const costume = costumeOf(outfit.costume);
  const bc = COSTUME_COLORS[costume] ?? outfit.color;
  const hair = outfit.hair;
  const hairStyle = outfit.hairStyle ?? "short";
  const beard = outfit.beard ?? "none";
  const vs = visualState(state);

  const wrap = (children: React.ReactNode, anim?: React.CSSProperties) => (
    <svg
      width={Math.round(
        (CHARACTER_GEOMETRY.width / CHARACTER_GEOMETRY.height) * height,
      )}
      height={height}
      viewBox={`0 0 ${CHARACTER_GEOMETRY.width} ${CHARACTER_GEOMETRY.height}`}
      overflow="visible"
      style={{ filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.35))", ...anim }}
    >
      {children}
    </svg>
  );

  if (vs === "idle" || portrait) {
    const hCx = 26,
      hCy = 37;
    const figure = (
      <>
        <ellipse cx={hCx} cy={50} rx={11} ry={10} fill={bc} />
        <CostumeBody costume={costume} seated />
        <ellipse cx={hCx} cy={hCy} rx={10} ry={9} fill={skin} />
        <Hair style={hairStyle} color={hair} headCx={hCx} headCy={hCy} />
        {costume === "none" || costume === "doctor" ? (
          <Hat
            type={outfit.hat}
            color={outfit.color}
            headCx={hCx}
            headCy={hCy}
          />
        ) : (
          <CostumeHead costume={costume} headCx={hCx} headCy={hCy} />
        )}
        <Accessory type={outfit.accessory} headCx={hCx} headCy={hCy} />
        <line
          x1={hCx - 6}
          y1={hCy + 1}
          x2={hCx - 2}
          y2={hCy + 1}
          stroke="#333"
          strokeWidth={1}
          strokeLinecap="round"
        />
        <line
          x1={hCx + 2}
          y1={hCy + 1}
          x2={hCx + 6}
          y2={hCy + 1}
          stroke="#333"
          strokeWidth={1}
          strokeLinecap="round"
        />
        <Beard type={beard} color={hair} headCx={hCx} headCy={hCy} />
      </>
    );
    if (portrait) return wrap(figure);
    return wrap(
      <>
        {figure}
        <g>
          <text
            x="36"
            y="28"
            fontSize="14"
            fill="rgba(200,220,255,0.7)"
            fontFamily="monospace"
            fontWeight="bold"
          >
            <animate
              attributeName="y"
              values="28;22;28"
              dur="2s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.5;0.9;0.5"
              dur="2s"
              repeatCount="indefinite"
            />
            z
          </text>
          <text
            x="44"
            y="18"
            fontSize="12"
            fill="rgba(200,220,255,0.6)"
            fontFamily="monospace"
            fontWeight="bold"
          >
            <animate
              attributeName="y"
              values="18;12;18"
              dur="2.5s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.4;0.8;0.4"
              dur="2.5s"
              repeatCount="indefinite"
            />
            z
          </text>
          <text
            x="50"
            y="10"
            fontSize="10"
            fill="rgba(200,220,255,0.5)"
            fontFamily="monospace"
            fontWeight="bold"
          >
            <animate
              attributeName="y"
              values="10;4;10"
              dur="3s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.3;0.7;0.3"
              dur="3s"
              repeatCount="indefinite"
            />
            z
          </text>
        </g>
      </>,
    );
  }

  if (vs === "error") {
    const hCx = 26,
      hCy = 25;
    return wrap(
      <>
        <rect x={16} y={36} width={20} height={16} fill={bc} rx={3} />
        <CostumeBody costume={costume} seated={false} />
        <rect
          x={5}
          y={28}
          width={7}
          height={4}
          fill={skin}
          rx={2}
          transform="rotate(-25 8 30)"
        />
        <rect
          x={40}
          y={28}
          width={7}
          height={4}
          fill={skin}
          rx={2}
          transform="rotate(25 43 30)"
        />
        <ellipse cx={hCx} cy={hCy} rx={10} ry={10} fill={skin} />
        <Hair style={hairStyle} color={hair} headCx={hCx} headCy={hCy} />
        {costume === "none" || costume === "doctor" ? (
          <Hat
            type={outfit.hat}
            color={outfit.color}
            headCx={hCx}
            headCy={hCy}
          />
        ) : (
          <CostumeHead costume={costume} headCx={hCx} headCy={hCy} />
        )}
        <g stroke="#c33" strokeWidth={1.5} strokeLinecap="round">
          <line x1={hCx - 6} y1={hCy - 3} x2={hCx - 3} y2={hCy + 1} />
          <line x1={hCx - 3} y1={hCy - 3} x2={hCx - 6} y2={hCy + 1} />
          <line x1={hCx + 3} y1={hCy - 3} x2={hCx + 6} y2={hCy + 1} />
          <line x1={hCx + 6} y1={hCy - 3} x2={hCx + 3} y2={hCy + 1} />
        </g>
        <path
          d={`M${hCx - 4} ${hCy + 6} Q${hCx - 2} ${hCy + 4} ${hCx} ${hCy + 6} Q${hCx + 2} ${hCy + 8} ${hCx + 4} ${hCy + 6}`}
          stroke="#c33"
          fill="none"
          strokeWidth={0.8}
        />
        <Beard type={beard} color={hair} headCx={hCx} headCy={hCy} />
        <g>
          <circle cx={42} cy={10} r={8} fill="#E85D75">
            <animate
              attributeName="r"
              values="8;9;8"
              dur="1s"
              repeatCount="indefinite"
            />
          </circle>
          <text x={39} y={14} fontSize={11} fill="white" fontWeight="bold">
            !
          </text>
        </g>
        <rect
          x={18}
          y={CHARACTER_GEOMETRY.feetY - 10}
          width={6}
          height={10}
          fill="#444"
          rx={2}
        />
        <rect
          x={28}
          y={CHARACTER_GEOMETRY.feetY - 10}
          width={6}
          height={10}
          fill="#444"
          rx={2}
        />
      </>,
      { animation: "errShake 0.4s ease-in-out infinite" },
    );
  }

  if (vs === "waiting_for_response") {
    const hCx = 26,
      hCy = 25;
    return wrap(
      <>
        <rect x={16} y={36} width={20} height={16} fill={bc} rx={3} />
        <CostumeBody costume={costume} seated={false} />
        <ellipse cx={hCx} cy={hCy} rx={10} ry={10} fill={skin} />
        <Hair style={hairStyle} color={hair} headCx={hCx} headCy={hCy} />
        {costume === "none" || costume === "doctor" ? (
          <Hat
            type={outfit.hat}
            color={outfit.color}
            headCx={hCx}
            headCy={hCy}
          />
        ) : (
          <CostumeHead costume={costume} headCx={hCx} headCy={hCy} />
        )}
        <Accessory type={outfit.accessory} headCx={hCx} headCy={hCy} />
        <circle cx={hCx - 4} cy={hCy + 1} r={1.8} fill="#333" />
        <circle cx={hCx + 4} cy={hCy + 1} r={1.8} fill="#333" />
        <circle cx={hCx - 3.5} cy={hCy + 0.5} r={0.6} fill="white" />
        <circle cx={hCx + 4.5} cy={hCy + 0.5} r={0.6} fill="white" />
        <path
          d={`M${hCx - 3} ${hCy + 5} Q${hCx} ${hCy + 7} ${hCx + 3} ${hCy + 5}`}
          stroke="#333"
          fill="none"
          strokeWidth={0.8}
        />
        <Beard type={beard} color={hair} headCx={hCx} headCy={hCy} />
        <rect x={7} y={40} width={7} height={4} fill={skin} rx={2} />
        {/* Raised right arm - arm and hand pivot together at the shoulder */}
        <g>
          <rect x={34} y={20} width={4} height={19} fill={skin} rx={2} />
          <circle cx={36} cy={19} r={4} fill={skin} />
          <animateTransform
            attributeName="transform"
            type="rotate"
            values="-15 36 39;15 36 39;-15 36 39"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
        <rect
          x={18}
          y={CHARACTER_GEOMETRY.feetY - 10}
          width={6}
          height={10}
          fill="#444"
          rx={2}
        />
        <rect
          x={28}
          y={CHARACTER_GEOMETRY.feetY - 10}
          width={6}
          height={10}
          fill="#444"
          rx={2}
        />
      </>,
      { animation: "waitBounce 2s ease-in-out infinite" },
    );
  }

  // working / starting
  const hCx = 26,
    hCy = 25;
  return wrap(
    <>
      <rect x={16} y={36} width={20} height={16} fill={bc} rx={3} />
      <CostumeBody costume={costume} seated={false} />
      <g>
        <rect x={7} y={42} width={8} height={4} fill={skin} rx={2}>
          <animate
            attributeName="y"
            values="42;41;42"
            dur="0.3s"
            repeatCount="indefinite"
          />
        </rect>
        <rect x={37} y={42} width={8} height={4} fill={skin} rx={2}>
          <animate
            attributeName="y"
            values="42;43;42"
            dur="0.3s"
            repeatCount="indefinite"
          />
        </rect>
      </g>
      <ellipse cx={hCx} cy={hCy} rx={10} ry={10} fill={skin} />
      <Hair style={hairStyle} color={hair} headCx={hCx} headCy={hCy} />
      {costume === "none" || costume === "doctor" ? (
        <Hat type={outfit.hat} color={outfit.color} headCx={hCx} headCy={hCy} />
      ) : (
        <CostumeHead costume={costume} headCx={hCx} headCy={hCy} />
      )}
      <Accessory type={outfit.accessory} headCx={hCx} headCy={hCy} />
      <circle cx={hCx - 4} cy={hCy + 1} r={1.5} fill="#333" />
      <circle cx={hCx + 4} cy={hCy + 1} r={1.5} fill="#333" />
      <Beard type={beard} color={hair} headCx={hCx} headCy={hCy} />
      <rect
        x={18}
        y={CHARACTER_GEOMETRY.feetY - 10}
        width={6}
        height={10}
        fill="#444"
        rx={2}
      />
      <rect
        x={28}
        y={CHARACTER_GEOMETRY.feetY - 10}
        width={6}
        height={10}
        fill="#444"
        rx={2}
      />
    </>,
  );
}
