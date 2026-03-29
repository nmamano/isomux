import { SCENE_W, SCENE_H, VB_X, VB_Y } from "./grid.ts";

export function RoomProps() {
  return (
    <svg
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      width={SCENE_W}
      height={SCENE_H}
      viewBox={`${VB_X} ${VB_Y} ${SCENE_W} ${SCENE_H}`}
      overflow="visible"
    >
      {/* Potted plant — west corner of office */}
      <g transform="translate(-260, 230) scale(1.5)">
        <rect x="-8" y="0" width="16" height="20" rx="3" fill="#5a4a35" />
        <ellipse cx="0" cy="0" rx="10" ry="4" fill="#6a5a45" />
        <path d="M0 0 Q-10 -20 -4 -30" stroke="#3a8a3a" fill="none" strokeWidth="2" />
        <path d="M0 0 Q8 -17 12 -27" stroke="#4a9a4a" fill="none" strokeWidth="1.8" />
        <path d="M0 0 Q-3 -13 2 -22" stroke="#3a7a3a" fill="none" strokeWidth="1.5" />
        <ellipse cx="-4" cy="-30" rx="5" ry="4" fill="#3a8a3a" opacity="0.7" />
        <ellipse cx="12" cy="-27" rx="4" ry="3" fill="#4a9a4a" opacity="0.7" />
        <ellipse cx="2" cy="-22" rx="4" ry="3.5" fill="#3a7a3a" opacity="0.6" />
      </g>

      {/* Water cooler — near right wall inside office */}
      <g transform="translate(540, 225) scale(1.5)">
        {/* Water jug (behind body) */}
        <rect x="-5" y="-12" width="10" height="14" rx="2" fill="var(--room-prop-accent)" />
        <ellipse cx="0" cy="-12" rx="6" ry="2" fill="var(--room-prop-accent)" opacity="0.8" />
        {/* Body */}
        <rect x="-9" y="0" width="18" height="30" rx="2" fill="var(--room-prop-body)" stroke="var(--border-subtle)" strokeWidth="0.5" />
        {/* Tap buttons */}
        <circle cx="-3" cy="18" r="2" fill="#5a9ada" />
        <circle cx="3" cy="18" r="2" fill="#e87090" />
        {/* Base */}
        <rect x="-7" y="30" width="14" height="4" rx="1" fill="var(--room-prop-base)" />
      </g>
      {/* Sleepy cat — south corner of office */}
      <g transform="translate(120, 460)">
        {/* Cat bed — isometric oval cushion */}
        {/* Bed base */}
        <ellipse cx="0" cy="10" rx="26" ry="14" fill="#8B6B4A" />
        {/* Bed inner cushion */}
        <ellipse cx="0" cy="8" rx="23" ry="12" fill="#A0785A" />
        {/* Bed rim highlight */}
        <ellipse cx="0" cy="6" rx="23" ry="12" fill="none" stroke="#96704E" strokeWidth="1.5" />
        {/* Cushion surface */}
        <ellipse cx="0" cy="6" rx="20" ry="10" fill="#C4976A" />
        {/* Curled body */}
        <ellipse cx="0" cy="0" rx="16" ry="9" fill="#E8A050">
          <animate attributeName="ry" values="9;9.5;9" dur="3s" repeatCount="indefinite" />
        </ellipse>
        {/* Darker stripes */}
        <path d="M-8 -4 Q-4 -7 0 -4" stroke="#C08030" strokeWidth="1" fill="none" />
        <path d="M2 -5 Q6 -8 10 -5" stroke="#C08030" strokeWidth="1" fill="none" />
        {/* Tail curling around — gentle sway */}
        <path d="M14 2 Q22 -2 20 -10 Q18 -16 12 -14" stroke="#E8A050" strokeWidth="3.5" fill="none" strokeLinecap="round">
          <animate attributeName="d" values="M14 2 Q22 -2 20 -10 Q18 -16 12 -14;M14 2 Q24 -4 22 -12 Q19 -18 13 -15;M14 2 Q22 -2 20 -10 Q18 -16 12 -14" dur="4s" repeatCount="indefinite" />
        </path>
        <path d="M14 2 Q22 -2 20 -10 Q18 -16 12 -14" stroke="#C08030" strokeWidth="1" fill="none" strokeLinecap="round">
          <animate attributeName="d" values="M14 2 Q22 -2 20 -10 Q18 -16 12 -14;M14 2 Q24 -4 22 -12 Q19 -18 13 -15;M14 2 Q22 -2 20 -10 Q18 -16 12 -14" dur="4s" repeatCount="indefinite" />
        </path>
        {/* Head */}
        <ellipse cx="-12" cy="-2" rx="8" ry="7" fill="#E8A050" />
        {/* Ears */}
        <path d="M-18 -7 L-16 -14 L-12 -8 Z" fill="#E8A050" />
        <path d="M-12 -8 L-8 -14 L-6 -7 Z" fill="#E8A050" />
        {/* Inner ears */}
        <path d="M-17 -7 L-15.5 -12 L-13 -8 Z" fill="#D08040" />
        <path d="M-11 -8 L-8.5 -12 L-7 -7 Z" fill="#D08040" />
        {/* Closed eyes — happy sleeping curves */}
        <path d="M-16 -2 Q-14.5 -4 -13 -2" stroke="#333" strokeWidth="0.8" fill="none" />
        <path d="M-11 -3 Q-9.5 -5 -8 -3" stroke="#333" strokeWidth="0.8" fill="none" />
        {/* Nose */}
        <ellipse cx="-12" cy="0" rx="1" ry="0.7" fill="#D08080" />
        {/* Whiskers */}
        <line x1="-18" y1="-1" x2="-23" y2="-3" stroke="#333" strokeWidth="0.3" />
        <line x1="-18" y1="1" x2="-23" y2="1" stroke="#333" strokeWidth="0.3" />
        <line x1="-6" y1="-1" x2="-1" y2="-3" stroke="#333" strokeWidth="0.3" />
        <line x1="-6" y1="1" x2="-1" y2="1" stroke="#333" strokeWidth="0.3" />
        {/* Zzz */}
        <text x="-4" y="-14" fontSize="6" fill="rgba(200,220,255,0.5)" fontFamily="monospace" fontWeight="bold">
          <animate attributeName="y" values="-14;-18;-14" dur="2.5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.3;0.7;0.3" dur="2.5s" repeatCount="indefinite" />
          z
        </text>
        <text x="2" y="-20" fontSize="5" fill="rgba(200,220,255,0.4)" fontFamily="monospace" fontWeight="bold">
          <animate attributeName="y" values="-20;-24;-20" dur="3s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.2;0.6;0.2" dur="3s" repeatCount="indefinite" />
          z
        </text>
      </g>
    </svg>
  );
}
