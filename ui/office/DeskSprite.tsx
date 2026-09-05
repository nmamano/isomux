import type { AgentBackendType, AgentState } from "../../shared/types.ts";
import { deskModelLabel, hashIndex, type DeskProp } from "../model-styles.ts";
import { shortenCwd } from "../cwd-display.ts";
import { Pot } from "./plants.tsx";

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

// Leaf variants - each is 3 leaves, and each leaf is [midrib, blade fill,
// midrib colour]. A leaf grows from the soil at the origin and points up.
//
// Only the midrib is written down. The blade around it is DERIVED, never
// authored: a blade is the same quadratic with its control point pushed to
// either side of the curve, and a hand-written blade that puts both control
// points on the same side collapses to a sliver - which is invisible in the
// path data and obvious only on screen. Deriving it makes that unexpressible.
type Midrib = [number, number, number, number, number, number]; // bx by cx cy tx ty
// [midrib, blade fill, midrib colour].
type Leaf = [Midrib, string, string];

const PLANT_VARIANTS: Leaf[][] = [
  // Upright bushy
  [
    [[0, 0, -6, -8, -2, -14], "#3F8A3F", "#2C6B2C"],
    [[0, -2, 4, -10, 8, -12], "#4F9A4F", "#357535"],
    [[0, -1, -3, -6, 1, -10], "#357A35", "#245C24"],
  ],
  // Droopy fern
  [
    [[0, 0, -8, -5, -10, -10], "#2E8A4A", "#1F6B37"],
    [[0, -1, 6, -8, 10, -8], "#3A9A5A", "#277943"],
    [[0, 0, -2, -9, 2, -13], "#2E7A3A", "#1F5C2A"],
  ],
  // Spiky succulent
  [
    [[0, 0, -2, -10, -1, -15], "#4A8A3A", "#356B29"],
    [[0, -1, 3, -10, 5, -14], "#5A9A4A", "#437936"],
    [[0, 0, -4, -7, -6, -11], "#4A7A3A", "#355C29"],
  ],
  // Wide spreading
  [
    [[0, 0, -9, -6, -12, -9], "#3A8A4A", "#286B36"],
    [[0, -1, 8, -6, 12, -8], "#4A9A3A", "#357929"],
    [[0, 0, 0, -8, -1, -13], "#3A7A4A", "#285C36"],
  ],
];

// How wide a blade is at its middle, as a fraction of the leaf's length, with
// a floor and a ceiling so a short leaf is not a needle and a long one is not
// a paddle.
const LEAF_WIDTH_RATIO = 0.28;
const LEAF_WIDTH_MIN = 2.6;
const LEAF_WIDTH_MAX = 4.6;

function leafPaths([bx, by, cx, cy, tx, ty]: Midrib): {
  blade: string;
  rib: string;
} {
  const dx = tx - bx;
  const dy = ty - by;
  const len = Math.hypot(dx, dy);
  const width = Math.min(
    LEAF_WIDTH_MAX,
    Math.max(LEAF_WIDTH_MIN, LEAF_WIDTH_RATIO * len),
  );
  // Normal to the base-to-tip chord, scaled to the blade's width. Offsetting
  // the control point by +/- this separates the two edges by exactly `width`
  // at the middle of the leaf.
  const nx = (-dy / len) * width;
  const ny = (dx / len) * width;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    rib: `M${bx} ${by} Q${cx} ${cy} ${tx} ${ty}`,
    blade:
      `M${bx} ${by} Q${round(cx + nx)} ${round(cy + ny)} ${tx} ${ty} ` +
      `Q${round(cx - nx)} ${round(cy - ny)} ${bx} ${by} Z`,
  };
}

// Book color variants - [front cover, back/side, spine/dark] - green (index 0) is the BCTCI easter egg
const BOOK_VARIANTS: Array<[string, string, string]> = [
  ["#30995a", "#2a8a4a", "#1e7a3c"], // Green (BCTCI - gets the clock)
  ["#3a6ea5", "#2e5e8a", "#224e74"], // Blue
  ["#a03a3a", "#8a2e2e", "#742222"], // Red
  ["#7a5aa0", "#6a4a8a", "#5a3a74"], // Purple
  ["#c47a2a", "#aa6a22", "#8a5a1a"], // Orange
];

// Mug color variants - [body, darker side, rim/top]. The ceramic is the desk's
// (it stays with the furniture); what is in it is the agent's, below.
const MUG_VARIANTS: Array<[string, string, string]> = [
  ["#E8E8E0", "#D0D0C8", "#F0F0E8"], // White ceramic
  ["#2E5E8A", "#1E4A6E", "#3A6E9A"], // Navy blue
  ["#C44040", "#A43030", "#D45050"], // Red
  ["#3A3A3A", "#2A2A2A", "#4A4A4A"], // Matte black
  ["#D4A04A", "#B88838", "#E0B05A"], // Mustard yellow
];

// The VESSEL says which backend the agent runs on. Nothing about it is random:
// the desk is a legend, so one backend always looks the same and every desk
// carries its token. A desk drawn with no backend (fixtures) gets the mug, so
// it still reads as a desk in use.
const VESSEL: Record<AgentBackendType, "mug" | "cup" | "duck"> = {
  claude: "mug",
  codex: "cup",
  opencode: "duck",
};

// What is IN the vessel is decoration, not signal: picked per agent id, so it
// is stable across renders and follows the agent through a desk swap. Each
// vessel keeps to drinks you would plausibly find in it, so the variety never
// argues with the vessel.
//
// [surface, lit edge, foam or null] - the lit edge is a highlight on the west
// side of the surface, where the desk lamp stands, so the liquid reads as a
// pool with depth rather than a flat disc.
type Drink = [string, string, string | null];

const MUG_DRINKS: Drink[] = [
  ["#3A2010", "#5C3A1E", null], // Coffee
  ["#5A3220", "#7A4A30", "#F4E6D2"], // Hot chocolate, with marshmallows
  ["#7C9C3E", "#9BBB5A", null], // Matcha
];
const CUP_DRINKS: Drink[] = [
  ["#B5701F", "#D08F3C", null], // Black tea
  ["#9AAE4C", "#B9C96E", null], // Green tea
  ["#A33A34", "#C25850", null], // Hibiscus
];

// Deterministic: desks 0,2,4,5,7 get plants; 1,3,6 don't (~37% empty)
const DESKS_WITHOUT_PLANT = new Set([1, 3, 6]);

// The desk's top surface. One source of truth: it fills the surface and it
// clips the lamp's light pool, so the light can never reach past the edge it
// is supposed to be lying on.
const DESK_TOP_PATH = "M20 62 L90 28 L160 62 L90 96 Z";

// The right-hand half of the front panel: the one flat face big enough to
// carry a label. Its top edge runs (90,104) -> (140,80) - 50 across, 24 up, the
// scene's 2:1 isometric slope. The label is set horizontally and skewed onto
// that slope, the same trick the monitor's cwd text uses, so it lies on the
// wood instead of floating in front of it.
//
// Skewed back into the label's own frame the face is a plain rectangle, 50
// wide and 12 tall, centred on the point below - which is what makes "does it
// fit" a straight comparison against those two numbers.
// The plate sits on the front-right band of the desk's top slab: the band is
// 70 units wide but only 8 tall, which is what fixes the plate's proportions.
// Nothing else on the desk reaches that band, so the plate is never covered.
//
// The band's top edge runs (90,96) -> (160,62), the scene's 2:1 isometric
// slope. The plate and its text are drawn horizontally and skewed onto that
// slope, the same trick the monitor's cwd text uses, so they lie on the wood
// instead of floating in front of it. Skewed back into its own frame the band
// is a plain rectangle centred on the origin, which is what makes "does it
// fit" a straight comparison against the two numbers below.
const LABEL_TRANSFORM = "translate(125,83) skewY(-25.909)"; // atan(34 / 70)
const PLATE_MAX_WIDTH = 60; // of the band's 70
const PLATE_MAX_HEIGHT = 6.6; // of the band's 8
const PLATE_VPAD = 2; // above and below the glyph box, together
const MODEL_LABEL_MAX_SIZE = 6.4;

// Padding either side of the text plus room for the two screws.
const PLATE_PADDING = 8;

// The text is the short desk label from model-styles, cut to 15 characters and
// then set at whatever size fills what is left of the plate. The longest label
// a backend produces today is the one that hits the width cap.
const MODEL_LABEL_MAX_CHARS = 15;
// Monospace advance per em, taken at the wide end of the fonts a browser may
// substitute, so a fitted size never overflows on any platform.
const MONO_ADVANCE = 0.62;

function fitModelLabel(
  modelFamily: string | undefined,
): { text: string; size: number; width: number } | null {
  const short = deskModelLabel(modelFamily);
  if (!short) return null;
  const text =
    short.length > MODEL_LABEL_MAX_CHARS
      ? `${short.slice(0, MODEL_LABEL_MAX_CHARS - 1)}\u2026`
      : short;
  const size = Math.min(
    MODEL_LABEL_MAX_SIZE,
    (PLATE_MAX_WIDTH - PLATE_PADDING) / (text.length * MONO_ADVANCE),
  );
  return { text, size, width: text.length * size * MONO_ADVANCE };
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
    let breakAt = remaining.lastIndexOf("/", CWD_CHARS_PER_LINE);
    if (breakAt <= 0) breakAt = CWD_CHARS_PER_LINE;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  return lines;
}

export function DeskSprite({
  state,
  deskIndex = 0,
  cwd,
  deskProp,
  agentId,
  agentType,
  modelFamily,
}: {
  state: AgentState;
  deskIndex?: number;
  cwd?: string;
  deskProp?: DeskProp;
  agentId?: string;
  agentType?: AgentBackendType;
  modelFamily?: string;
}) {
  const vs = visualState(state);
  const glow = {
    working: "#50B86C",
    waiting_for_response: "#9B59B6",
    error: "#E85D75",
    idle: "#223",
  }[vs];
  const on = vs !== "idle";
  const hasPlant = !DESKS_WITHOUT_PLANT.has(deskIndex);
  const vessel = agentType ? VESSEL[agentType] : "mug";
  // Seed for the drink. A desk drawn with no agent behind it still gets one
  // stable pour per slot instead of flickering.
  const identity = agentId || `desk-${deskIndex}`;
  const drinks = vessel === "cup" ? CUP_DRINKS : MUG_DRINKS;
  const [drinkSurface, drinkLit, drinkFoam] =
    drinks[hashIndex(`cup:${identity}`, drinks.length)];
  const leaves = PLANT_VARIANTS[deskIndex % PLANT_VARIANTS.length];
  const [mugBody, mugSide, mugRim] =
    MUG_VARIANTS[deskIndex % MUG_VARIANTS.length];

  const lampId = `lamp-glow-${deskIndex}`;
  const screenClipId = `screen-clip-${deskIndex}`;
  const deskTopClipId = `desk-top-clip-${deskIndex}`;
  const bulbId = `lamp-bulb-${deskIndex}`;
  const shortCwd = cwd ? shortenCwd(cwd) : "";
  const modelLabel = fitModelLabel(modelFamily);

  return (
    <svg width="180" height="140" viewBox="0 0 180 140" overflow="visible">
      <defs>
        <clipPath id={screenClipId}>
          <path d="M66 18 L108 37 L108 60 L66 41 Z" />
        </clipPath>
        <clipPath id={deskTopClipId}>
          <path d={DESK_TOP_PATH} />
        </clipPath>
        <radialGradient id={lampId} cx="50%" cy="40%" r="50%">
          <stop offset="0%" stopColor="#F5D090" stopOpacity="0.45" />
          <stop offset="50%" stopColor="#F5C060" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#F5C060" stopOpacity="0" />
        </radialGradient>
        {/* The glow under the shade. Its own gradient rather than the pool's:
            it is brighter in the middle and it has to reach zero before the
            ellipse ends, or the bulb reads as a hard yellow blob. */}
        <radialGradient id={bulbId} cx="50%" cy="38%" r="52%">
          <stop offset="0%" stopColor="#FFF4D8" stopOpacity="0.9" />
          <stop offset="30%" stopColor="#F8DCA0" stopOpacity="0.5" />
          <stop offset="65%" stopColor="#F5C874" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#F5C060" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Shadow under desk */}
      <path
        d="M45 121 L85 102 Q90 100 95 102 L135 121 Q140 124 135 127 L95 146 Q90 148 85 146 L45 127 Q40 124 45 121 Z"
        fill="rgba(0,0,0,0.12)"
      />

      {/* Chair */}
      <path d="M56 95 L90 110 L124 95 L90 80 Z" fill="#2a2a3a" />
      <path
        d="M56 95 L56 72 L90 57 L90 80 Z"
        fill="#333345"
        stroke="#2a2a3a"
        strokeWidth="0.5"
      />

      {/* Desk legs - from front panel corners to floor */}
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
      <path d={DESK_TOP_PATH} fill="#5C4C38" />
      <path d="M20 62 L90 96 L90 104 L20 70 Z" fill="#4A3C2A" />
      <path d="M90 96 L160 62 L160 70 L90 104 Z" fill="#3E3220" />

      {/* Front panel. It hangs from the UNDERSIDE of the top slab, not from the
          top face: its top edge is the slab's bottom edge dropped 8, the slab's
          thickness. Starting it at the top face instead painted over that
          thickness wherever the panel reached, so the slab looked 8 units thick
          at the two outer corners and paper-thin in the middle. */}
      <path
        d="M40 80 L90 104 L140 80 L140 92 L90 116 L40 92 Z"
        fill="#3a2e20"
      />
      <path d="M40 80 L90 104 L90 116 L40 92 Z" fill="#352a1c" />

      {/* Model name, lying on the panel's right-hand face */}
      {modelLabel &&
        (() => {
          const { text, size, width } = modelLabel;
          const baseline = size * 0.35;
          const plateW = width + PLATE_PADDING;
          const plateH = Math.min(size * 0.7 + PLATE_VPAD, PLATE_MAX_HEIGHT);
          const plateX = -plateW / 2;
          const plateY = -plateH / 2;
          return (
            <g
              transform={LABEL_TRANSFORM}
              style={{ userSelect: "none", pointerEvents: "none" }}
              fontFamily="monospace"
              fontWeight={700}
              fontSize={size}
              textAnchor="middle"
            >
              {/* Brass plate: shadow, face, lit top lip, two screws */}
              <rect
                x={plateX}
                y={plateY + 0.7}
                width={plateW}
                height={plateH}
                rx="1.2"
                fill="rgba(0,0,0,0.35)"
              />
              <rect
                x={plateX}
                y={plateY}
                width={plateW}
                height={plateH}
                rx="1.2"
                fill="#8A7748"
                stroke="#A89158"
                strokeWidth="0.3"
              />
              <rect
                x={plateX + 0.6}
                y={plateY + 0.45}
                width={plateW - 1.2}
                height="0.7"
                rx="0.35"
                fill="#C8B078"
                opacity="0.7"
              />
              <circle cx={plateX + 1.8} cy="0" r="0.55" fill="#5F5029" />
              <circle
                cx={plateX + plateW - 1.8}
                cy="0"
                r="0.55"
                fill="#5F5029"
              />
              <text x="0" y={baseline} fill="#2B2312">
                {text}
              </text>
            </g>
          );
        })()}

      {/* Keyboard + Monitor group - shifted NW on desk */}
      <g transform="translate(-12, -6)">
        {/* Keyboard - rendered first (behind monitor) */}
        {/* Top face */}
        <path
          d="M60 66 L87 79 L114 66 L87 53 Z"
          fill="#2a2a2a"
          stroke="#333"
          strokeWidth="0.4"
        />
        {/* Front-left face (depth) */}
        <path d="M60 66 L87 79 L87 82 L60 69 Z" fill="#1e1e1e" />
        {/* Front-right face (depth) */}
        <path d="M87 79 L114 66 L114 69 L87 82 Z" fill="#252525" />
        {/* Key rows */}
        <path
          d="M68 64 L87 73 L106 64"
          stroke="#3a3a3a"
          strokeWidth="0.4"
          fill="none"
        />
        <path
          d="M70 66 L87 74 L104 66"
          stroke="#3a3a3a"
          strokeWidth="0.4"
          fill="none"
        />
        <path
          d="M72 68 L87 75.5 L102 68"
          stroke="#3a3a3a"
          strokeWidth="0.3"
          fill="none"
        />
        {/* Individual key hints on top row */}
        <path
          d="M73 61 L78 58.5"
          stroke="#3a3a3a"
          strokeWidth="0.3"
          fill="none"
        />
        <path
          d="M80 57.5 L85 55"
          stroke="#3a3a3a"
          strokeWidth="0.3"
          fill="none"
        />
        <path
          d="M89 56 L94 58.5"
          stroke="#3a3a3a"
          strokeWidth="0.3"
          fill="none"
        />
        <path
          d="M97 60 L102 62.5"
          stroke="#3a3a3a"
          strokeWidth="0.3"
          fill="none"
        />

        {/* Monitor stand - rendered second (behind screen) */}
        {/* Stand neck */}
        <path d="M85 52 L91 55 L91 64 L85 61 Z" fill="#2a2a3a" />
        <path d="M91 55 L95 53 L95 62 L91 64 Z" fill="#1a1a28" />
        {/* Stand base - isometric diamond */}
        <path d="M78 64 L90 58 L102 64 L90 70 Z" fill="#2a2a3a" />
        <path d="M78 64 L90 70 L90 72 L78 66 Z" fill="#1a1a28" />
        <path d="M90 70 L102 64 L102 66 L90 72 Z" fill="#222233" />

        {/* Monitor screen - rendered last (in front) */}
        <path
          d="M64 16 L110 36 L110 62 L64 42 Z"
          fill="#222233"
          stroke="#1a1a28"
          strokeWidth="0.8"
        />
        {/* Top edge thickness */}
        <path d="M64 16 L110 36 L114 34 L68 14 Z" fill="#2a2a3a" />
        {/* Right edge thickness */}
        <path d="M110 36 L114 34 L114 60 L110 62 Z" fill="#1a1a28" />
        {/* Screen area */}
        <path
          d="M66 18 L108 37 L108 60 L66 41 Z"
          fill={on ? "#0d1117" : "#141820"}
        />
        {on && (
          <path d="M66 18 L108 37 L108 60 L66 41 Z" fill={glow} opacity="0.15">
            <animate
              attributeName="opacity"
              values="0.1;0.2;0.1"
              dur="3s"
              repeatCount="indefinite"
            />
          </path>
        )}
        {on && (
          <path
            d="M66 30 L108 48"
            stroke={glow}
            strokeWidth="0.8"
            opacity="0.3"
          >
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
              style={{
                transformOrigin: "68px 24px",
                userSelect: "none",
                pointerEvents: "none",
              }}
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

      {/* Mug - what a Claude agent has. Solid ceramic; the ceramic colour
          varies by desk, the drink by agent. */}
      {vessel === "mug" && (
        <g>
          {/* Mug body - front face */}
          <path d="M134 62 L134 55 L146 55 L146 62" fill={mugBody} />
          {/* Mug body - side shading */}
          <path d="M134 55 L134 62 L137 62 L137 55 Z" fill={mugSide} />
          {/* Bottom ellipse */}
          <ellipse cx="140" cy="62" rx="6" ry="3" fill={mugSide} />
          {/* Rim / top ellipse */}
          <ellipse cx="140" cy="55" rx="6" ry="3" fill={mugRim} />
          {/* Liquid inside - surface, lamp-side highlight, optional foam */}
          <ellipse cx="140" cy="55.5" rx="4.5" ry="2" fill={drinkSurface} />
          <ellipse
            cx="138.9"
            cy="54.9"
            rx="2.4"
            ry="0.9"
            fill={drinkLit}
            opacity="0.75"
          />
          {drinkFoam && (
            <g fill={drinkFoam}>
              <ellipse cx="140.8" cy="55.4" rx="1.3" ry="0.7" />
              <ellipse cx="142.1" cy="56.1" rx="0.9" ry="0.5" />
            </g>
          )}
          {/* Handle */}
          <path
            d="M146 57 Q152 57 152 60 Q152 63 146 62"
            fill="none"
            stroke={mugSide}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {/* Steam when active */}
          {on && (
            <path
              d="M138 53 Q136 47 140 43"
              fill="none"
              stroke="rgba(255,255,255,0.15)"
              strokeWidth="0.8"
            >
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

      {/* Teacup and saucer - what a Codex agent has. Shallower and wider than
          the mug, and the saucer is what tells the two apart at a glance. */}
      {vessel === "cup" && (
        <g>
          {/* Saucer - rim edge, top face, then the well the cup sits in */}
          <ellipse cx="140" cy="63.1" rx="8.2" ry="3.5" fill={mugSide} />
          <ellipse cx="140" cy="62.4" rx="8.2" ry="3.5" fill={mugBody} />
          <ellipse
            cx="140"
            cy="62.4"
            rx="5"
            ry="2.1"
            fill={mugSide}
            opacity="0.55"
          />
          {/* Bowl - tapers from the rim down to the foot */}
          <path
            d="M134.5 57.2 Q135 61.2 140 62 Q145 61.2 145.5 57.2 Z"
            fill={mugBody}
          />
          {/* Bowl - lamp-shaded left flank */}
          <path
            d="M134.5 57.2 Q135 61.2 140 62 Q137.2 59.9 137 57.2 Z"
            fill={mugSide}
          />
          {/* Rim */}
          <ellipse cx="140" cy="57.2" rx="5.5" ry="2.5" fill={mugRim} />
          {/* Tea - surface, then the lamp-side highlight */}
          <ellipse cx="140" cy="57.5" rx="4.2" ry="1.8" fill={drinkSurface} />
          <ellipse
            cx="139"
            cy="57"
            rx="2.2"
            ry="0.8"
            fill={drinkLit}
            opacity="0.75"
          />
          {/* Handle - a small loop, smaller than the mug's */}
          <path
            d="M145.4 58.4 Q149.2 58.4 149.2 60.1 Q149.2 61.6 145.6 61.2"
            fill="none"
            stroke={mugSide}
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          {/* Steam when active */}
          {on && (
            <path
              d="M138.6 55.2 Q136.6 49.4 140.4 45.6"
              fill="none"
              stroke="rgba(255,255,255,0.15)"
              strokeWidth="0.8"
            >
              <animate
                attributeName="d"
                values="M138.6 55.2 Q136.6 49.4 140.4 45.6;M138.6 55.2 Q140.6 47.6 137.8 42.8;M138.6 55.2 Q136.6 49.4 140.4 45.6"
                dur="2.5s"
                repeatCount="indefinite"
              />
            </path>
          )}
        </g>
      )}

      {/* Rubber duck - what an OpenCode agent has instead of a cup. Same
          footprint as the mug so the desk layout does not shift. */}
      {vessel === "duck" && (
        <g transform="translate(140, 61) scale(0.85)">
          {/* Contact shadow on the desk */}
          <ellipse cx="0" cy="1.6" rx="7.6" ry="3.1" fill="rgba(0,0,0,0.20)" />
          {/* Tail */}
          <path d="M-5.2 -3.6 L-9.4 -6 L-5 -1.4 Z" fill="#E8B62C" />
          {/* Body */}
          <ellipse cx="0.4" cy="-2.4" rx="6.4" ry="4.3" fill="#F5C63A" />
          {/* Underside shading - light falls from the desk lamp, west of here */}
          <path d="M-6 -1.4 Q0.4 4.2 6.7 -1.6 Q3 2 -6 -1.4 Z" fill="#D9A423" />
          {/* Wing */}
          <path
            d="M-2.8 -3.4 Q1.2 -6.6 4.2 -3.2 Q0.8 -0.9 -2.8 -3.4 Z"
            fill="#E8B62C"
          />
          {/* Head */}
          <circle cx="4.7" cy="-8.3" r="3.6" fill="#F8CE44" />
          {/* Head highlight */}
          <circle cx="3.7" cy="-9.4" r="1.7" fill="#FFE188" opacity="0.55" />
          {/* Beak */}
          <path d="M7.7 -8.2 L11.7 -7.1 L7.7 -5.9 Z" fill="#E8862A" />
          <path d="M7.7 -7.1 L11.7 -7.1 L7.7 -5.9 Z" fill="#C96D1E" />
          {/* Eye */}
          <circle cx="5.6" cy="-9.1" r="0.65" fill="#2A2118" />
          <circle cx="5.4" cy="-9.35" r="0.22" fill="#FFFFFF" />
        </g>
      )}

      {/* Small plant - terracotta pot, varies by desk */}
      {hasPlant && (
        <g transform="translate(35, 54)">
          {/* The pot is the scene's shared one (ui/office/plants.tsx), at the
              same size the window sill and corner plants use it, so all the
              terracotta in the room matches. The leaves are this file's. */}
          <Pot x={0} y={0} rimRx={4} height={7} taper={0.76} />
          {/* Leaves, growing out of the soil */}
          <g transform="translate(0, 0.3)">
            {leaves.map(([midrib, fill, ribColor], i) => {
              const { blade, rib } = leafPaths(midrib);
              return (
                <g key={i}>
                  <path d={blade} fill={fill} />
                  <path
                    d={rib}
                    stroke={ribColor}
                    fill="none"
                    strokeWidth="0.5"
                    strokeLinecap="round"
                  />
                </g>
              );
            })}
          </g>
        </g>
      )}

      {/* Model-specific desk item - SE area (see ui/model-styles.ts) */}
      {deskProp === "crayons" && (
        <g transform="translate(100, 68)">
          {/* Scattered crayons */}
          <rect
            x="0"
            y="0"
            width="14"
            height="3"
            rx="1"
            fill="#E85D75"
            transform="rotate(-15 7 1.5)"
          />
          <rect
            x="4"
            y="5"
            width="14"
            height="3"
            rx="1"
            fill="#4A9AE8"
            transform="rotate(10 11 6.5)"
          />
          <rect
            x="-2"
            y="9"
            width="12"
            height="3"
            rx="1"
            fill="#F5C040"
            transform="rotate(-5 4 10.5)"
          />
          {/* Crayon tips */}
          <path
            d="M13.5 -0.8 L16 0.8 L13.5 2.3"
            fill="#C44050"
            transform="rotate(-15 7 1.5)"
          />
          <path
            d="M17.5 4.5 L20 6 L17.5 7.5"
            fill="#3A80C8"
            transform="rotate(10 11 6.5)"
          />
          <path
            d="M9.5 8.5 L12 10 L9.5 11.5"
            fill="#D8A030"
            transform="rotate(-5 4 10.5)"
          />
        </g>
      )}
      {deskProp === "book" &&
        (() => {
          const [bookFront, bookBack, bookSpine] =
            BOOK_VARIANTS[deskIndex % BOOK_VARIANTS.length];
          const isGreen = deskIndex % BOOK_VARIANTS.length === 0;
          return (
            <g transform="translate(102.5, 69.5) scale(0.8)">
              {/* Book on desk - color varies by desk */}
              <path d="M-4 8 L15 -1.5 L29 5.5 L10 15 Z" fill={bookBack} />
              <path d="M-4 8 L10 15 L10 16 L-4 9 Z" fill={bookSpine} />
              <path d="M-2 4 L10 10 L10 14 L-2 8 Z" fill="#F0EDE4" />
              <path d="M10 16 L29 6.5 L29 -0.5 L10 9 Z" fill={bookSpine} />
              <path d="M-4 2 L15 -7.5 L29 -0.5 L10 9 Z" fill={bookFront} />
              <path d="M-4 2 L10 9 L10 10 L-4 3 Z" fill={bookBack} />
              {/* Title lines - parallel to SW edge */}
              <line
                x1="0.95"
                y1="1.63"
                x2="10.75"
                y2="6.53"
                stroke="#1a1a1a"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <line
                x1="4.82"
                y1="0.84"
                x2="11.12"
                y2="3.99"
                stroke="#1a1a1a"
                strokeWidth="0.9"
                strokeLinecap="round"
              />
              {/* Silver clock - only on the green BCTCI book */}
              {isGreen && (
                <g transform="matrix(4.02,-2.01,4.02,2.01,15.35,-0.68)">
                  <circle
                    cx="0"
                    cy="0"
                    r="1"
                    fill="#C0C0C0"
                    stroke="#888"
                    strokeWidth="0.1"
                  />
                  <circle
                    cx="0"
                    cy="0"
                    r="0.88"
                    fill="#D8D8D8"
                    stroke="#A0A0A0"
                    strokeWidth="0.04"
                  />
                  <line
                    x1="0"
                    y1="-0.78"
                    x2="0"
                    y2="-0.6"
                    stroke="#444"
                    strokeWidth="0.07"
                  />
                  <line
                    x1="0.78"
                    y1="0"
                    x2="0.6"
                    y2="0"
                    stroke="#444"
                    strokeWidth="0.07"
                  />
                  <line
                    x1="0"
                    y1="0.78"
                    x2="0"
                    y2="0.6"
                    stroke="#444"
                    strokeWidth="0.07"
                  />
                  <line
                    x1="-0.78"
                    y1="0"
                    x2="-0.6"
                    y2="0"
                    stroke="#444"
                    strokeWidth="0.07"
                  />
                  <line
                    x1="0"
                    y1="0"
                    x2="-0.33"
                    y2="-0.48"
                    stroke="#333"
                    strokeWidth="0.1"
                    strokeLinecap="round"
                  />
                  <line
                    x1="0"
                    y1="0"
                    x2="0.28"
                    y2="-0.62"
                    stroke="#333"
                    strokeWidth="0.07"
                    strokeLinecap="round"
                  />
                  <circle cx="0" cy="0" r="0.08" fill="#555" />
                </g>
              )}
            </g>
          );
        })()}

      {/* Light pool on desk surface (dark mode only). Clipped to the desk top
          and drawn outside the lamp's translated group, so the clip path can
          be written in the same coordinates as the surface it lies on. */}
      <g clipPath={`url(#${deskTopClipId})`}>
        <ellipse
          cx="72"
          cy="80"
          rx="22"
          ry="12"
          fill={`url(#${lampId})`}
          className="lamp-glow"
        />
      </g>

      {/* Desk lamp - south corner */}
      <g transform="translate(72, 78)">
        {/* Base - small iso diamond */}
        <path d="M-4 4 L0 2 L4 4 L0 6 Z" fill="#2a2a2a" />
        {/* Arm - straight up */}
        <line
          x1="0"
          y1="3"
          x2="0"
          y2="-12"
          stroke="#333"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* Shade - small cone/trapezoid. The shaded left band runs along the
            left edge and stops on the rim: its last corner used to sit a unit
            below the bottom edge, which left a dark spike hanging off the
            silhouette in both themes. */}
        <path d="M-5 -10 L5 -10 L3 -14 L-3 -14 Z" fill="#C8A050" />
        <path d="M-5 -10 L-3 -14 L-1.9 -14 L-3.5 -10 Z" fill="#B08830" />
        {/* The shade's opening, seen from above: an ellipse, not a straight
            line, so the shade reads as a cone rather than a flat cut-out. */}
        <ellipse cx="0" cy="-10" rx="5" ry="1.25" fill="#A87F2E" />
        {/* Bulb glow under shade (dark mode only). Three parts, all fading:
            a wide halo that never reaches an edge, the lit lower lip of the
            shade, and a small filament core. */}
        <ellipse
          cx="0"
          cy="-8.4"
          rx="6.5"
          ry="3.6"
          fill={`url(#${bulbId})`}
          className="lamp-glow"
        />
        <ellipse
          cx="0"
          cy="-10.05"
          rx="4.4"
          ry="0.95"
          fill="#FFE6A8"
          opacity="0.7"
          className="lamp-glow"
        />
        <ellipse
          cx="0"
          cy="-9.3"
          rx="1.5"
          ry="0.75"
          fill="#FFF6E2"
          opacity="0.85"
          className="lamp-glow"
        />
      </g>
    </svg>
  );
}
