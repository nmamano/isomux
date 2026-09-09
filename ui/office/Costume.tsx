import type { AgentOutfit } from "../../shared/types.ts";

type Costume = NonNullable<AgentOutfit["costume"]>;

export const COSTUME_COLORS: Record<Costume, string | null> = {
  none: null, doctor: "#f6f7f5", police: "#263c68", firefighter: "#e9bb34",
  chef: "#f6f7f5", construction: "#f08030", astronaut: "#e9eef3",
};

// The seated torso is an ellipse centered at (26, 50); the standing one is
// a 20x16 rectangle at (16, 36). Details stay inside each shape.
export function CostumeBody({ costume, seated }: { costume: Costume; seated: boolean }) {
  if (costume === "none") return null;
  const y = seated ? 48 : 39;
  const clipId = seated ? "costume-torso-seated" : "costume-torso-standing";
  return <g transform={`translate(26 ${y})`} data-costume-body={costume}>
    <defs>
      <clipPath id={clipId}>
        {seated ? <ellipse cx="0" cy="2" rx="11" ry="10" />
          : <rect x="-10" y="-3" width="20" height="16" rx="3" />}
      </clipPath>
    </defs>
    <g clipPath={`url(#${clipId})`}>
    {costume === "doctor" && <>
      <path d="M-5 -3 L0 3 L5 -3 M0 3 V10" fill="none" stroke="#a6bec4" strokeWidth="1.5" />
      <path d="M-6 -2 V3 Q-6 7 -3 7 Q0 7 0 3 V-2" fill="none" stroke="#294653" strokeWidth="1.6" />
      <circle cx="4" cy="6" r="2.2" fill="#294653" />
    </>}
    {costume === "police" && <>
      <path d="M3 0 H8 V4 L5.5 6 L3 4 Z" fill="#f5cb4d" />
      <path d="M-1 -2 V11 M-9 8 H9" stroke="#101f38" strokeWidth="2" />
    </>}
    {costume === "firefighter" && <>
      <path d="M-6 -2 V11 M6 -2 V11 M-9 7 H9" stroke="#f4f4ba" strokeWidth="3" />
      <path d="M0 -2 V11" stroke="#765a24" strokeWidth="1.5" />
    </>}
    {costume === "chef" && <>
      <path d="M-5 -2 L0 2 L5 -2" fill="none" stroke="#c3cbd0" strokeWidth="1.2" />
      {[2, 6, 10].map(y => <g key={y}><circle cx="-3" cy={y} r="1" fill="#354451" /><circle cx="3" cy={y} r="1" fill="#354451" /></g>)}
    </>}
    {costume === "construction" && <>
      <path d="M-5 -2 V11 M5 -2 V11 M-9 7 H9" stroke="#f8ee90" strokeWidth="2.5" />
      <path d="M0 -2 V11" stroke="#885027" strokeWidth="1.5" />
    </>}
    {costume === "astronaut" && <>
      <rect x="-6" y="0" width="12" height="8" rx="1.5" fill="#3e719b" />
      <rect x="-4" y="2" width="5" height="3" fill="#a3dbec" />
      <circle cx="3" cy="3" r="1.2" fill="#ec885b" />
      <path d="M-7 10 H7" stroke="#9cabb8" strokeWidth="2" />
    </>}
    </g>
  </g>;
}

// Color belongs to the uniform, independent of the saved shirt color.
export function CostumeHead({ costume, headCx, headCy }: { costume: Costume; headCx: number; headCy: number }) {
  return <g transform={`translate(${headCx} ${headCy})`} data-costume-head={costume}>
    {costume === "police" && <>
      <path d="M-11 -9 L-8 -17 H8 L11 -9 Z" fill="#263c68" />
      <path d="M-11 -9 Q0 -4 11 -9" fill="#13213b" stroke="#13213b" strokeWidth="3" />
      <path d="M-2 -14 H2 V-11 L0 -9 L-2 -11 Z" fill="#f5cb4d" />
    </>}
    {(costume === "firefighter" || costume === "construction") && <>
      <path d="M-11 -8 Q-11 -21 0 -21 Q11 -21 11 -8 Z" fill={costume === "firefighter" ? "#d84536" : "#f3c52e"} />
      <path d="M-13 -8 H13 M0 -19 V-10" stroke={costume === "firefighter" ? "#9c2d29" : "#bb8b20"} strokeWidth="3" strokeLinecap="round" />
      {costume === "firefighter" && <path d="M-3 -15 H3 V-11 L0 -9 L-3 -11 Z" fill="#f9df7d" />}
    </>}
    {costume === "chef" && <>
      <path d="M-8 -8 V-16 Q-15 -17 -11 -23 Q-7 -28 -3 -24 Q0 -30 5 -25 Q12 -28 13 -21 Q14 -16 8 -15 V-8 Z" fill="#fafbf9" stroke="#c2cdd3" strokeWidth="1" />
      <path d="M-8 -11 H8" stroke="#c2cdd3" strokeWidth="1.5" />
    </>}
    {costume === "astronaut" && <>
      <ellipse cy="-1" rx="13" ry="14" fill="none" stroke="#e9eef3" strokeWidth="4" />
      <path d="M-8 -11 Q0 -17 8 -11" fill="none" stroke="#85bdd5" strokeWidth="2" />
      <rect x="-14" y="-3" width="4" height="8" rx="1" fill="#94aabb" />
      <rect x="10" y="-3" width="4" height="8" rx="1" fill="#94aabb" />
    </>}
  </g>;
}
