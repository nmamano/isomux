// SVG drawing for the 8 ghost variants. Each <GhostGraphic> renders a
// single ghost at the requested size, with a per-variant bob animation
// and any per-variant inner motion (arm wave, halo pulse, etc.).
//
// The visual decisions and color palette are documented in the design
// memo on task 0eb9d326. The 8 variants and the color palette are kept
// in shared/avatar.ts so server validation and the user-edit form
// reference the same source.

import type { GhostVariant } from "../../shared/avatar.ts";

interface GhostGraphicProps {
  variant: GhostVariant;
  color: string;
  // Pixel width. Height scales to keep the body proportions; the
  // viewBox provides margin for hats / halos / arms that extend past
  // the body box, so the rendered footprint is slightly taller and
  // wider than the body alone.
  size?: number;
}

// Per-variant bob period. A handful of small differences keep multiple
// ghosts in the same scene from syncing into a kick-line.
const BOB_DUR_S: Record<GhostVariant, number> = {
  classic: 2.4,
  "big-eyes": 2.2,
  sleepy: 3.2,
  "tongue-out": 1.8,
  "stubby-arms": 2.0,
  "wisp-tail": 2.6,
  nightcap: 2.4,
  "glow-halo": 2.8,
};

export function GhostGraphic({ variant, color, size = 40 }: GhostGraphicProps) {
  // Body sits in a 100x100 box (head at y=0, waves at y=100); the
  // viewBox extends -15..115 horizontally and -30..140 vertically to
  // accommodate the nightcap above and the wisp-tail / glow halo below
  // and around. Height stays proportional to that 130:170 ratio so
  // the ghost reads the same regardless of `size`.
  const width = size;
  const height = Math.round(size * (170 / 130));
  return (
    <svg
      width={width}
      height={height}
      viewBox="-15 -30 130 170"
      overflow="visible"
      style={{ filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.35))" }}
    >
      <g>
        <animateTransform
          attributeName="transform"
          type="translate"
          values="0,0; 0,-4; 0,0"
          dur={`${BOB_DUR_S[variant]}s`}
          repeatCount="indefinite"
        />
        {renderVariant(variant, color)}
      </g>
    </svg>
  );
}

function renderVariant(variant: GhostVariant, color: string) {
  switch (variant) {
    case "classic":
      return (
        <>
          <BodyClassic color={color} />
          <FaceBigEyes />
        </>
      );
    case "big-eyes":
      return (
        <>
          <BodyClassic color={color} />
          <FaceAnimeEyes />
        </>
      );
    case "sleepy":
      return (
        <>
          <BodyClassic color={color} />
          <FaceSleepy />
        </>
      );
    case "tongue-out":
      return (
        <>
          <BodyClassic color={color} />
          <FaceTongueOut />
        </>
      );
    case "stubby-arms":
      return (
        <>
          <BodyClassic color={color} />
          <StubbyArms color={color} />
          <FaceBigEyes />
        </>
      );
    case "wisp-tail":
      return (
        <>
          <BodyWispTail color={color} />
          <FaceBigEyes />
        </>
      );
    case "nightcap":
      return (
        <>
          <Nightcap color={color} />
          <BodyClassic color={color} />
          <FaceBigEyes />
        </>
      );
    case "glow-halo":
      return (
        <>
          <GlowHalo color={color} />
          <BodyClassic color={color} />
          <FaceBigEyes />
        </>
      );
  }
}

// --- Body shapes ---------------------------------------------------------

function BodyClassic({ color }: { color: string }) {
  return (
    <path
      d="M50,0 C26,0 14,20 14,44 L14,88 Q22,100 30,88 Q38,100 46,88 Q54,100 62,88 Q70,100 78,88 Q86,100 94,88 L94,44 C94,20 74,0 50,0 Z"
      fill={color}
      opacity={0.84}
    />
  );
}

function BodyWispTail({ color }: { color: string }) {
  return (
    <path
      d="M50,0 C26,0 14,20 14,44 L14,80 Q14,94 26,96 Q38,98 44,112 Q47,124 50,134 Q53,124 56,112 Q62,98 74,96 Q86,94 86,80 L86,44 C86,20 74,0 50,0 Z"
      fill={color}
      opacity={0.84}
    />
  );
}

// --- Face details --------------------------------------------------------

function FaceBigEyes() {
  return (
    <>
      <ellipse cx={36} cy={44} rx={8} ry={10} fill="white" />
      <ellipse cx={64} cy={44} rx={8} ry={10} fill="white" />
      <ellipse cx={36} cy={46} rx={4} ry={5.4} fill="#1a2030" />
      <ellipse cx={64} cy={46} rx={4} ry={5.4} fill="#1a2030" />
      <circle cx={38.5} cy={43} r={2} fill="white" />
      <circle cx={66.5} cy={43} r={2} fill="white" />
      <path
        d="M44,68 Q50,72 56,68"
        stroke="#1a2030"
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
    </>
  );
}

function FaceAnimeEyes() {
  return (
    <>
      <ellipse cx={34} cy={44} rx={10} ry={13} fill="white" />
      <ellipse cx={66} cy={44} rx={10} ry={13} fill="white" />
      <ellipse cx={34} cy={47} rx={5} ry={7} fill="#1a2030" />
      <ellipse cx={66} cy={47} rx={5} ry={7} fill="#1a2030" />
      <circle cx={37} cy={42} r={2.6} fill="white" />
      <circle cx={69} cy={42} r={2.6} fill="white" />
      <circle cx={31} cy={50} r={1.2} fill="white" />
      <circle cx={63} cy={50} r={1.2} fill="white" />
      <path
        d="M44,68 Q50,72 56,68"
        stroke="#1a2030"
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
    </>
  );
}

function FaceSleepy() {
  return (
    <>
      <path
        d="M30,46 Q38,40 46,46"
        stroke="#1a2030"
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M54,46 Q62,40 70,46"
        stroke="#1a2030"
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M42,64 Q50,70 58,64"
        stroke="#1a2030"
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
      />
      <ellipse cx={26} cy={58} rx={4} ry={2.4} fill="#ff9eb4" opacity={0.5} />
      <ellipse cx={74} cy={58} rx={4} ry={2.4} fill="#ff9eb4" opacity={0.5} />
    </>
  );
}

function FaceTongueOut() {
  return (
    <>
      <path
        d="M30,46 Q38,40 46,46"
        stroke="#1a2030"
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M54,46 Q62,40 70,46"
        stroke="#1a2030"
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M42,62 Q50,72 58,62 Q54,70 50,70 Q46,70 42,62 Z"
        fill="#4a1525"
      />
      <ellipse cx={50} cy={70} rx={5} ry={3} fill="#ff7099" />
      <line
        x1={50}
        y1={67}
        x2={50}
        y2={72}
        stroke="#c8527a"
        strokeWidth={0.6}
      />
      <ellipse cx={26} cy={58} rx={4} ry={2.4} fill="#ff9eb4" opacity={0.6} />
      <ellipse cx={74} cy={58} rx={4} ry={2.4} fill="#ff9eb4" opacity={0.6} />
    </>
  );
}

// --- Accessories / extras ------------------------------------------------

function StubbyArms({ color }: { color: string }) {
  return (
    <>
      <ellipse cx={9} cy={66} rx={9} ry={6} fill={color} opacity={0.84} />
      <ellipse cx={99} cy={60} rx={9} ry={6} fill={color} opacity={0.84}>
        <animateTransform
          attributeName="transform"
          type="rotate"
          values="-18 92 60; 18 92 60; -18 92 60"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </ellipse>
    </>
  );
}

function Nightcap({ color }: { color: string }) {
  return (
    <>
      <path
        d="M30,12 L70,12 L60,-22 Q56,-28 52,-22 Z"
        fill={color}
        opacity={0.92}
      />
      <rect
        x={26}
        y={8}
        width={48}
        height={8}
        rx={4}
        fill="white"
        opacity={0.92}
      />
      <circle cx={56} cy={-24} r={6} fill="white" opacity={0.92} />
    </>
  );
}

function GlowHalo({ color }: { color: string }) {
  return (
    <>
      <ellipse cx={50} cy={50} rx={62} ry={68} fill={color} opacity={0.14}>
        <animate
          attributeName="rx"
          values="58; 66; 58"
          dur="3s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="ry"
          values="64; 72; 64"
          dur="3s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          values="0.10; 0.20; 0.10"
          dur="3s"
          repeatCount="indefinite"
        />
      </ellipse>
      <ellipse cx={50} cy={50} rx={48} ry={56} fill={color} opacity={0.22} />
    </>
  );
}
