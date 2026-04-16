import type { AgentState, ModelFamily } from "../../shared/types.ts";

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

// Book color variants — [front cover, back/side, spine/dark] — green (index 0) is the BCTCI easter egg
const BOOK_VARIANTS: Array<[string, string, string]> = [
  ["#30995a", "#2a8a4a", "#1e7a3c"], // Green (BCTCI — gets the clock)
  ["#3a6ea5", "#2e5e8a", "#224e74"], // Blue
  ["#a03a3a", "#8a2e2e", "#742222"], // Red
  ["#7a5aa0", "#6a4a8a", "#5a3a74"], // Purple
  ["#c47a2a", "#aa6a22", "#8a5a1a"], // Orange
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

function shortenCwd(cwd: string): string {
  return cwd.replace(/^\/home\/[^/]+/, "~");
}

const CWD_CHARS_PER_LINE = 12;

function wrapCwd(text: string): string[] {
  if (text.length <= CWD_CHARS_PER_LINE) return [text];
  const lines: string[] = [];
  // Break at path separators when possible
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CWD_CHARS_PER_LINE) {
      lines.push(remaining);
      break;
    }
    // Find last slash within the line limit
    let breakAt = remaining.lastIndexOf("/", CWD_CHARS_PER_LINE);
    if (breakAt <= 0) breakAt = CWD_CHARS_PER_LINE;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  return lines;
}

export function DeskSprite({ state, deskIndex = 0, cwd, modelFamily }: { state: AgentState; deskIndex?: number; cwd?: string; modelFamily?: ModelFamily }) {
  const vs = visualState(state);
  const glow = { working: "#50B86C", waiting_for_response: "#9B59B6", error: "#E85D75", idle: "#223" }[vs];
  const on = vs !== "idle";
  const hasPlant = !DESKS_WITHOUT_PLANT.has(deskIndex);
  const hasMug = !DESKS_WITHOUT_MUG.has(deskIndex);
  const leaves = PLANT_VARIANTS[deskIndex % PLANT_VARIANTS.length];
  const [mugBody, mugSide, mugRim, mugLiquid] = MUG_VARIANTS[deskIndex % MUG_VARIANTS.length];

  const lampId = `lamp-glow-${deskIndex}`;
  const screenClipId = `screen-clip-${deskIndex}`;
  const shortCwd = cwd ? shortenCwd(cwd) : "";

  return (
    <svg width="180" height="140" viewBox="0 0 180 140" overflow="visible">
      <defs>
        <clipPath id={screenClipId}>
          <path d="M66 18 L108 37 L108 60 L66 41 Z" />
        </clipPath>
        <radialGradient id={lampId} cx="50%" cy="40%" r="50%">
          <stop offset="0%" stopColor="#F5D090" stopOpacity="0.45" />
          <stop offset="50%" stopColor="#F5C060" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#F5C060" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Shadow under desk */}
      <path d="M45 121 L85 102 Q90 100 95 102 L135 121 Q140 124 135 127 L95 146 Q90 148 85 146 L45 127 Q40 124 45 121 Z" fill="rgba(0,0,0,0.12)" />

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

      {/* Keyboard + Monitor group — shifted NW on desk */}
      <g transform="translate(-12, -6)">
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
        {/* CWD text on monitor */}
        {shortCwd && (
          <g clipPath={`url(#${screenClipId})`}>
            <text
              x="68"
              y="24"
              fill={on ? "rgba(180,220,255,0.85)" : "rgba(120,140,160,0.35)"}
              fontSize="5"
              fontFamily="monospace"
              transform="skewY(24)"
              style={{ transformOrigin: "68px 24px", userSelect: "none", pointerEvents: "none" }}
            >
              {wrapCwd(shortCwd).map((line, i) => (
                <tspan key={i} x="68" dy={i === 0 ? 0 : 6}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        )}
      </g>

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

      {/* Model-specific desk item — SE area */}
      {modelFamily === "haiku" && (
        <g transform="translate(100, 68)">
          {/* Scattered crayons */}
          <rect x="0" y="0" width="14" height="3" rx="1" fill="#E85D75" transform="rotate(-15 7 1.5)" />
          <rect x="4" y="5" width="14" height="3" rx="1" fill="#4A9AE8" transform="rotate(10 11 6.5)" />
          <rect x="-2" y="9" width="12" height="3" rx="1" fill="#F5C040" transform="rotate(-5 4 10.5)" />
          {/* Crayon tips */}
          <path d="M13.5 -0.8 L16 0.8 L13.5 2.3" fill="#C44050" transform="rotate(-15 7 1.5)" />
          <path d="M17.5 4.5 L20 6 L17.5 7.5" fill="#3A80C8" transform="rotate(10 11 6.5)" />
          <path d="M9.5 8.5 L12 10 L9.5 11.5" fill="#D8A030" transform="rotate(-5 4 10.5)" />
        </g>
      )}
      {modelFamily === "opus" && (() => {
        const [bookFront, bookBack, bookSpine] = BOOK_VARIANTS[deskIndex % BOOK_VARIANTS.length];
        const isGreen = deskIndex % BOOK_VARIANTS.length === 0;
        return (
        <g transform="translate(102.5, 69.5) scale(0.8)">
          {/* Book on desk — color varies by desk */}
          <path d="M-4 8 L15 -1.5 L29 5.5 L10 15 Z" fill={bookBack} />
          <path d="M-4 8 L10 15 L10 16 L-4 9 Z" fill={bookSpine} />
          <path d="M-2 4 L10 10 L10 14 L-2 8 Z" fill="#F0EDE4" />
          <path d="M10 16 L29 6.5 L29 -0.5 L10 9 Z" fill={bookSpine} />
          <path d="M-4 2 L15 -7.5 L29 -0.5 L10 9 Z" fill={bookFront} />
          <path d="M-4 2 L10 9 L10 10 L-4 3 Z" fill={bookBack} />
          {/* Title lines — parallel to SW edge */}
          <line x1="0.95" y1="1.63" x2="10.75" y2="6.53" stroke="#1a1a1a" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="4.82" y1="0.84" x2="11.12" y2="3.99" stroke="#1a1a1a" strokeWidth="0.9" strokeLinecap="round" />
          {/* Silver clock — only on the green BCTCI book */}
          {isGreen && (
            <g transform="matrix(4.02,-2.01,4.02,2.01,15.35,-0.68)">
              <circle cx="0" cy="0" r="1" fill="#C0C0C0" stroke="#888" strokeWidth="0.1" />
              <circle cx="0" cy="0" r="0.88" fill="#D8D8D8" stroke="#A0A0A0" strokeWidth="0.04" />
              <line x1="0" y1="-0.78" x2="0" y2="-0.6" stroke="#444" strokeWidth="0.07" />
              <line x1="0.78" y1="0" x2="0.6" y2="0" stroke="#444" strokeWidth="0.07" />
              <line x1="0" y1="0.78" x2="0" y2="0.6" stroke="#444" strokeWidth="0.07" />
              <line x1="-0.78" y1="0" x2="-0.6" y2="0" stroke="#444" strokeWidth="0.07" />
              <line x1="0" y1="0" x2="-0.33" y2="-0.48" stroke="#333" strokeWidth="0.1" strokeLinecap="round" />
              <line x1="0" y1="0" x2="0.28" y2="-0.62" stroke="#333" strokeWidth="0.07" strokeLinecap="round" />
              <circle cx="0" cy="0" r="0.08" fill="#555" />
            </g>
          )}
        </g>
        );
      })()}

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
