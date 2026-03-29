import type { AgentState } from "../../shared/types.ts";

// Map our states to visual categories
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

// Leaf pattern variants — each is 3 stems with [quadratic control points, stroke color, width]
const PLANT_VARIANTS: Array<Array<[string, string, number]>> = [
  // Upright bushy
  [["M0 0 Q-6 -8 -2 -14", "#3a7a3a", 1.5], ["M0 -2 Q4 -10 8 -12", "#4a8a4a", 1.2], ["M0 -1 Q-3 -6 1 -10", "#3a7a3a", 1]],
  // Droopy fern
  [["M0 0 Q-8 -5 -10 -10", "#2e8a4a", 1.4], ["M0 -1 Q6 -8 10 -8", "#3a9a5a", 1.1], ["M0 0 Q-2 -9 2 -13", "#2e7a3a", 1]],
  // Spiky succulent
  [["M0 0 Q-2 -10 -1 -15", "#4a8a3a", 1.6], ["M0 -1 Q3 -10 5 -14", "#5a9a4a", 1.3], ["M0 0 Q-4 -7 -6 -11", "#4a7a3a", 1.1]],
  // Wide spreading
  [["M0 0 Q-9 -6 -12 -9", "#3a8a4a", 1.3], ["M0 -1 Q8 -6 12 -8", "#4a9a3a", 1.2], ["M0 0 Q0 -8 -1 -13", "#3a7a4a", 1.4]],
  // Tall single stem with side shoots
  [["M0 0 Q-1 -10 0 -16", "#3a8a3a", 1.6], ["M0 -6 Q-6 -10 -8 -12", "#4a9a4a", 1], ["M0 -8 Q5 -11 7 -13", "#3a7a3a", 0.9]],
];

// Mug color variants — [body, darker side, rim/top, liquid fill]
const MUG_VARIANTS: Array<[string, string, string, string]> = [
  ["#E8E8E0", "#D0D0C8", "#F0F0E8", "#3A2010"], // White ceramic
  ["#2E5E8A", "#1E4A6E", "#3A6E9A", "#3A2010"], // Navy blue
  ["#C44040", "#A43030", "#D45050", "#3A2010"], // Red
  ["#3A3A3A", "#2A2A2A", "#4A4A4A", "#3A2010"], // Matte black
  ["#D4A04A", "#B88838", "#E0B05A", "#3A2010"], // Mustard yellow
];

// Deterministic: desks 0,2,4,5,7 get plants; 1,3,6 don't (~37% empty)
const DESKS_WITHOUT_PLANT = new Set([1, 3, 6]);
// Desks 0,1,3,4,6 get mugs; 2,5,7 don't (~37% empty, different set than plants)
const DESKS_WITHOUT_MUG = new Set([2, 5, 7]);

export function DeskSprite({ state, deskIndex = 0 }: { state: AgentState; deskIndex?: number }) {
  const vs = visualState(state);
  const glow = { working: "#50B86C", active: "#9B59B6", error: "#E85D75", idle: "#223" }[vs];
  const on = vs !== "idle";
  const hasPlant = !DESKS_WITHOUT_PLANT.has(deskIndex);
  const hasMug = !DESKS_WITHOUT_MUG.has(deskIndex);
  const leaves = PLANT_VARIANTS[deskIndex % PLANT_VARIANTS.length];
  const [mugBody, mugSide, mugRim, mugLiquid] = MUG_VARIANTS[deskIndex % MUG_VARIANTS.length];

  const lampId = `lamp-glow-${deskIndex}`;

  return (
    <svg width="180" height="140" viewBox="0 0 180 140" overflow="visible">
      <defs>
        <radialGradient id={lampId} cx="50%" cy="40%" r="50%">
          <stop offset="0%" stopColor="#F5D090" stopOpacity="0.45" />
          <stop offset="50%" stopColor="#F5C060" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#F5C060" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Shadow under desk */}
      <ellipse cx="90" cy="126" rx="55" ry="10" fill="rgba(0,0,0,0.15)" />

      {/* Chair */}
      <path d="M56 95 L90 110 L124 95 L90 80 Z" fill="#2a2a3a" />
      <path d="M56 95 L56 72 L90 57 L90 80 Z" fill="#333345" stroke="#2a2a3a" strokeWidth="0.5" />

      {/* Desk legs — from front panel corners to floor */}
      {/* Left leg */}
      <path d="M40 90 L40 122 L43 124 L43 92 Z" fill="#4A3C2A" />
      <path d="M38 122 L41.5 124 L45 122 L41.5 120 Z" fill="#3E3220" />
      {/* Right leg */}
      <path d="M137 90 L137 122 L140 124 L140 92 Z" fill="#4A3C2A" />
      <path d="M135.5 122 L138.5 124 L141.5 122 L138.5 120 Z" fill="#3E3220" />
      {/* Front leg */}
      <path d="M89 114 L89 144 L91 145 L91 115 Z" fill="#352a1c" />
      <path d="M91 115 L91 145 L93 144 L93 114 Z" fill="#3E3220" />
      {/* Front leg foot */}
      <path d="M87 144 L91 146 L95 144 L91 142 Z" fill="#3E3220" />

      {/* Desktop surface */}
      <path d="M20 62 L90 28 L160 62 L90 96 Z" fill="#5C4C38" />
      <path d="M20 62 L90 96 L90 104 L20 70 Z" fill="#4A3C2A" />
      <path d="M90 96 L160 62 L160 70 L90 104 Z" fill="#3E3220" />

      {/* Front panel */}
      <path d="M40 72 L90 96 L140 72 L140 92 L90 116 L40 92 Z" fill="#3a2e20" />
      <path d="M40 72 L90 96 L90 116 L40 92 Z" fill="#352a1c" />

      {/* Keyboard — rendered first (behind monitor) */}
      {/* Top face */}
      <path d="M60 66 L87 79 L114 66 L87 53 Z" fill="#2a2a2a" stroke="#333" strokeWidth="0.4" />
      {/* Front-left face (depth) */}
      <path d="M60 66 L87 79 L87 82 L60 69 Z" fill="#1e1e1e" />
      {/* Front-right face (depth) */}
      <path d="M87 79 L114 66 L114 69 L87 82 Z" fill="#252525" />
      {/* Key rows */}
      <path d="M68 64 L87 73 L106 64" stroke="#3a3a3a" strokeWidth="0.4" fill="none" />
      <path d="M70 66 L87 74 L104 66" stroke="#3a3a3a" strokeWidth="0.4" fill="none" />
      <path d="M72 68 L87 75.5 L102 68" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />
      {/* Individual key hints on top row */}
      <path d="M73 61 L78 58.5" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />
      <path d="M80 57.5 L85 55" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />
      <path d="M89 56 L94 58.5" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />
      <path d="M97 60 L102 62.5" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />

      {/* Monitor stand — rendered second (behind screen) */}
      {/* Stand neck */}
      <path d="M85 52 L91 55 L91 64 L85 61 Z" fill="#2a2a3a" />
      <path d="M91 55 L95 53 L95 62 L91 64 Z" fill="#1a1a28" />
      {/* Stand base — isometric diamond */}
      <path d="M78 64 L90 58 L102 64 L90 70 Z" fill="#2a2a3a" />
      <path d="M78 64 L90 70 L90 72 L78 66 Z" fill="#1a1a28" />
      <path d="M90 70 L102 64 L102 66 L90 72 Z" fill="#222233" />

      {/* Monitor screen — rendered last (in front) */}
      <path d="M64 16 L110 36 L110 62 L64 42 Z" fill="#222233" stroke="#1a1a28" strokeWidth="0.8" />
      {/* Top edge thickness */}
      <path d="M64 16 L110 36 L114 34 L68 14 Z" fill="#2a2a3a" />
      {/* Right edge thickness */}
      <path d="M110 36 L114 34 L114 60 L110 62 Z" fill="#1a1a28" />
      {/* Screen area */}
      <path d="M66 18 L108 37 L108 60 L66 41 Z" fill={on ? "#0d1117" : "#141820"} />
      {on && (
        <path d="M66 18 L108 37 L108 60 L66 41 Z" fill={glow} opacity="0.15">
          <animate attributeName="opacity" values="0.1;0.2;0.1" dur="3s" repeatCount="indefinite" />
        </path>
      )}
      {on && (
        <path d="M66 30 L108 48" stroke={glow} strokeWidth="0.8" opacity="0.3">
          <animate
            attributeName="d"
            values="M66 18 L108 37;M66 41 L108 60;M66 18 L108 37"
            dur="4s"
            repeatCount="indefinite"
          />
        </path>
      )}

      {/* Coffee mug — solid ceramic */}
      {hasMug && (
        <g>
          {/* Mug body — front face */}
          <path d="M134 62 L134 55 L146 55 L146 62" fill={mugBody} />
          {/* Mug body — side shading */}
          <path d="M134 55 L134 62 L137 62 L137 55 Z" fill={mugSide} />
          {/* Bottom ellipse */}
          <ellipse cx="140" cy="62" rx="6" ry="3" fill={mugSide} />
          {/* Rim / top ellipse */}
          <ellipse cx="140" cy="55" rx="6" ry="3" fill={mugRim} />
          {/* Liquid inside */}
          <ellipse cx="140" cy="55.5" rx="4.5" ry="2" fill={mugLiquid} />
          {/* Handle */}
          <path d="M146 57 Q152 57 152 60 Q152 63 146 62" fill="none" stroke={mugSide} strokeWidth="1.5" strokeLinecap="round" />
          {/* Steam when active */}
          {on && (
            <path d="M138 53 Q136 47 140 43" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8">
              <animate
                attributeName="d"
                values="M138 53 Q136 47 140 43;M138 53 Q140 45 137 40;M138 53 Q136 47 140 43"
                dur="2.5s"
                repeatCount="indefinite"
              />
            </path>
          )}
        </g>
      )}

      {/* Small plant — terracotta pot, varies by desk */}
      {hasPlant && (
        <g transform="translate(35, 54)">
          <rect x="-3" y="0" width="6" height="7" rx="1" fill="#C4634F" />
          <ellipse cx="0" cy="0" rx="4" ry="1.5" fill="#D4735F" />
          {leaves.map(([d, stroke, width], i) => (
            <path key={i} d={d} stroke={stroke} fill="none" strokeWidth={width} />
          ))}
        </g>
      )}

      {/* Desk lamp — south corner */}
      <g transform="translate(72, 78)">
        {/* Light pool on desk surface (dark mode only) */}
        <ellipse cx="0" cy="2" rx="22" ry="12" fill={`url(#${lampId})`} className="lamp-glow" />
        {/* Base — small iso diamond */}
        <path d="M-4 4 L0 2 L4 4 L0 6 Z" fill="#2a2a2a" />
        {/* Arm — straight up */}
        <line x1="0" y1="3" x2="0" y2="-12" stroke="#333" strokeWidth="1.5" strokeLinecap="round" />
        {/* Shade — small cone/trapezoid */}
        <path d="M-5 -10 L5 -10 L3 -14 L-3 -14 Z" fill="#C8A050" />
        <path d="M-5 -10 L-3 -14 L-3 -12 L-5 -9 Z" fill="#B08830" />
        {/* Bulb glow under shade (dark mode only) */}
        <ellipse cx="0" cy="-9" rx="3" ry="1.5" fill="#F5D090" opacity="0.6" className="lamp-glow" />
      </g>
    </svg>
  );
}
