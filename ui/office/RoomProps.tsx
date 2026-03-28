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
      {/* Potted plant — near left wall inside office */}
      <g transform="translate(-100, 150)">
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
      <g transform="translate(350, 140)">
        <rect x="-9" y="0" width="18" height="30" rx="2" fill="var(--room-prop-body)" stroke="var(--border-subtle)" strokeWidth="0.5" />
        <rect x="-5" y="-12" width="10" height="14" rx="2" fill="var(--room-prop-accent)" opacity="0.6" />
        <ellipse cx="0" cy="-12" rx="6" ry="2" fill="var(--room-prop-accent)" opacity="0.5" />
        <circle cx="-3" cy="18" r="2" fill="#4a90d9" opacity="0.4" />
        <circle cx="3" cy="18" r="2" fill="#e85d75" opacity="0.4" />
        <rect x="-7" y="30" width="14" height="4" rx="1" fill="var(--room-prop-base)" />
      </g>
    </svg>
  );
}
