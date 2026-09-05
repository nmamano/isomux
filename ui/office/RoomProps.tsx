import { SCENE_W, SCENE_H, VB_X, VB_Y, roomPaletteIndex } from "./grid.ts";
import { CornerPlant } from "./plants.tsx";
import { useAppState } from "../store.tsx";

// `face` colours the eyes and whiskers; dark coats need a light stroke or the
// face disappears into the body (the black cat used to render as a blob).
const CAT_PALETTES = [
  // orange tabby
  {
    body: "#E8A050",
    stripe: "#C08030",
    ear: "#D08040",
    nose: "#D08080",
    face: "#333333",
  },
  // silver
  {
    body: "#A0A0A8",
    stripe: "#707078",
    ear: "#909098",
    nose: "#C09090",
    face: "#333333",
  },
  // black
  {
    body: "#3A3A3A",
    stripe: "#222222",
    ear: "#4A4A4A",
    nose: "#A07070",
    face: "#C8C8C8",
  },
  // white
  {
    body: "#E8E0D8",
    stripe: "#C0B8B0",
    ear: "#DCC8C0",
    nose: "#D0A0A0",
    face: "#333333",
  },
  // ginger
  {
    body: "#D07030",
    stripe: "#A05020",
    ear: "#C06030",
    nose: "#C07060",
    face: "#333333",
  },
  // siamese
  {
    body: "#E0D8C8",
    stripe: "#8B7060",
    ear: "#C0A890",
    nose: "#C08888",
    face: "#333333",
  },
];

export function RoomProps() {
  const { currentRoomId, rooms } = useAppState();
  const roomIndex = rooms.findIndex((r) => r.id === currentRoomId);
  const cat = CAT_PALETTES[roomPaletteIndex(roomIndex, CAT_PALETTES.length)];
  const isLastRoom = rooms[rooms.length - 1]?.id === currentRoomId;
  return (
    <svg
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      width={SCENE_W}
      height={SCENE_H}
      viewBox={`${VB_X} ${VB_Y} ${SCENE_W} ${SCENE_H}`}
      overflow="visible"
    >
      {/* Potted plant - west corner of office. Drawn in ui/office/plants.tsx,
          which the window plant and the desk plants also draw from. */}
      <g transform="translate(-245, 212) scale(1.5)">
        <CornerPlant />
      </g>

      {/* Water cooler - near right wall, only in last room (no right door) */}
      {isLastRoom && (
        <g transform="translate(540, 225) scale(1.5)">
          {/* Water jug (behind body) */}
          <rect
            x="-5"
            y="-12"
            width="10"
            height="14"
            rx="2"
            fill="var(--room-prop-accent)"
          />
          <ellipse
            cx="0"
            cy="-12"
            rx="6"
            ry="2"
            fill="var(--room-prop-accent)"
            opacity="0.8"
          />
          {/* Body */}
          <rect
            x="-9"
            y="0"
            width="18"
            height="30"
            rx="2"
            fill="var(--room-prop-body)"
            stroke="var(--border-subtle)"
            strokeWidth="0.5"
          />
          {/* Tap buttons */}
          <circle cx="-3" cy="18" r="2" fill="#5a9ada" />
          <circle cx="3" cy="18" r="2" fill="#e87090" />
          {/* Base */}
          <rect
            x="-7"
            y="30"
            width="14"
            height="4"
            rx="1"
            fill="var(--room-prop-base)"
          />
        </g>
      )}
      {/* Sleepy cat - south corner of office */}
      <g transform="translate(120, 460)">
        {/* Cat bed - isometric oval cushion */}
        {/* Bed base */}
        <ellipse cx="0" cy="10" rx="26" ry="14" fill="#8B6B4A" />
        {/* Bed inner cushion */}
        <ellipse cx="0" cy="8" rx="23" ry="12" fill="#A0785A" />
        {/* Bed rim highlight */}
        <ellipse
          cx="0"
          cy="6"
          rx="23"
          ry="12"
          fill="none"
          stroke="#96704E"
          strokeWidth="1.5"
        />
        {/* Cushion surface */}
        <ellipse cx="0" cy="6" rx="20" ry="10" fill="#C4976A" />
        {/* Curled body */}
        <ellipse cx="0" cy="0" rx="16" ry="9" fill={cat.body}>
          <animate
            attributeName="ry"
            values="9;9.5;9"
            dur="3s"
            repeatCount="indefinite"
          />
        </ellipse>
        {/* Darker stripes */}
        <path
          d="M-8 -4 Q-4 -7 0 -4"
          stroke={cat.stripe}
          strokeWidth="1"
          fill="none"
        />
        <path
          d="M2 -5 Q6 -8 10 -5"
          stroke={cat.stripe}
          strokeWidth="1"
          fill="none"
        />
        {/* Tail curling around - gentle sway */}
        <path
          d="M14 2 Q22 -2 20 -10 Q18 -16 12 -14"
          stroke={cat.body}
          strokeWidth="3.5"
          fill="none"
          strokeLinecap="round"
        >
          <animate
            attributeName="d"
            values="M14 2 Q22 -2 20 -10 Q18 -16 12 -14;M14 2 Q24 -4 22 -12 Q19 -18 13 -15;M14 2 Q22 -2 20 -10 Q18 -16 12 -14"
            dur="4s"
            repeatCount="indefinite"
          />
        </path>
        <path
          d="M14 2 Q22 -2 20 -10 Q18 -16 12 -14"
          stroke={cat.stripe}
          strokeWidth="1"
          fill="none"
          strokeLinecap="round"
        >
          <animate
            attributeName="d"
            values="M14 2 Q22 -2 20 -10 Q18 -16 12 -14;M14 2 Q24 -4 22 -12 Q19 -18 13 -15;M14 2 Q22 -2 20 -10 Q18 -16 12 -14"
            dur="4s"
            repeatCount="indefinite"
          />
        </path>
        {/* Head */}
        <ellipse cx="-12" cy="-2" rx="8" ry="7" fill={cat.body} />
        {/* Ears */}
        <path d="M-18 -7 L-16 -14 L-12 -8 Z" fill={cat.body} />
        <path d="M-12 -8 L-8 -14 L-6 -7 Z" fill={cat.body} />
        {/* Inner ears */}
        <path d="M-17 -7 L-15.5 -12 L-13 -8 Z" fill={cat.ear} />
        <path d="M-11 -8 L-8.5 -12 L-7 -7 Z" fill={cat.ear} />
        {/* Closed eyes - happy sleeping curves */}
        <path
          d="M-16 -2 Q-14.5 -4 -13 -2"
          stroke={cat.face}
          strokeWidth="0.8"
          fill="none"
        />
        <path
          d="M-11 -3 Q-9.5 -5 -8 -3"
          stroke={cat.face}
          strokeWidth="0.8"
          fill="none"
        />
        {/* Nose */}
        <ellipse cx="-12" cy="0" rx="1" ry="0.7" fill={cat.nose} />
        {/* Whiskers */}
        <line
          x1="-18"
          y1="-1"
          x2="-23"
          y2="-3"
          stroke={cat.face}
          strokeWidth="0.3"
        />
        <line
          x1="-18"
          y1="1"
          x2="-23"
          y2="1"
          stroke={cat.face}
          strokeWidth="0.3"
        />
        <line
          x1="-6"
          y1="-1"
          x2="-1"
          y2="-3"
          stroke={cat.face}
          strokeWidth="0.3"
        />
        <line
          x1="-6"
          y1="1"
          x2="-1"
          y2="1"
          stroke={cat.face}
          strokeWidth="0.3"
        />
        {/* Zzz */}
        <text
          x="-4"
          y="-14"
          fontSize="6"
          fill="rgba(200,220,255,0.5)"
          fontFamily="monospace"
          fontWeight="bold"
        >
          <animate
            attributeName="y"
            values="-14;-18;-14"
            dur="2.5s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.3;0.7;0.3"
            dur="2.5s"
            repeatCount="indefinite"
          />
          z
        </text>
        <text
          x="2"
          y="-20"
          fontSize="5"
          fill="rgba(200,220,255,0.4)"
          fontFamily="monospace"
          fontWeight="bold"
        >
          <animate
            attributeName="y"
            values="-20;-24;-20"
            dur="3s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.2;0.6;0.2"
            dur="3s"
            repeatCount="indefinite"
          />
          z
        </text>
      </g>
    </svg>
  );
}
