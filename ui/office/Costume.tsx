import type { AgentOutfit } from "../../shared/types.ts";

type Costume = NonNullable<AgentOutfit["costume"]>;

export const COSTUME_COLORS: Record<Costume, string | null> = {
  none: null,
  doctor: "#f6f7f5",
  police: "#263c68",
  firefighter: "#c79737",
  chef: "#f6f7f5",
  construction: "#df8745",
  astronaut: "#e9eef3",
};

// The seated torso is an ellipse centered at (26, 50); the standing one is
// a 20x16 rectangle at (16, 36). Details stay inside each shape.
export function CostumeBody({
  costume,
  seated,
}: {
  costume: Costume;
  seated: boolean;
}) {
  if (costume === "none") return null;
  const y = seated ? 48 : 39;
  const clipId = seated ? "costume-torso-seated" : "costume-torso-standing";
  return (
    <g transform={`translate(26 ${y})`} data-costume-body={costume}>
      <defs>
        <clipPath id={clipId}>
          {seated ? (
            <ellipse cx="0" cy="2" rx="11" ry="10" />
          ) : (
            <rect x="-10" y="-3" width="20" height="16" rx="3" />
          )}
        </clipPath>
      </defs>
      <g
        clipPath={`url(#${clipId})`}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 -5 Q5 7 1 13 H12 V-5 Z" fill="#172b42" opacity=".1" />
        <path
          d="M-9 -1 Q-7 -3 -5 -3"
          fill="none"
          stroke="white"
          strokeOpacity=".35"
          strokeWidth="1"
        />
        {costume === "doctor" && (
          <>
            <path d="M-3 -3 L0 3 L3 -3" fill="#83bfc0" />
            <path
              d="M-5 -3 L-6 1 L-2 4 L-3 6 M5 -3 L6 1 L2 4 L3 6 M0 4 V12"
              fill="none"
              stroke="#a8b9bd"
              strokeWidth=".8"
            />
            <path
              d="M-5 -2 V3 Q-5 6 -2.5 6 Q0 6 0 3 V0 M0 3 Q4 4 4 7"
              fill="none"
              stroke="#38545d"
              strokeWidth="1.2"
            />
            <circle cx="4" cy="7" r="1.6" fill="#38545d" />
            <circle cx="4" cy="7" r=".8" fill="#c4d7dc" />
          </>
        )}
        {costume === "police" && (
          <>
            <path
              d="M-5 -3 L0 1 L5 -3 M0 1 V9"
              fill="none"
              stroke="#657b99"
              strokeWidth=".8"
            />
            <path d="M3 1 H7 V4 L5 5.5 L3 4 Z" fill="#ddbd60" />
            <path d="M-7 2 H-3 V5 H-7 Z" fill="#1c3050" />
            <path d="M-9 9 H9" stroke="#101f38" strokeWidth="2" />
            <rect x="-1.5" y="8" width="3" height="2" rx=".4" fill="#c5b783" />
          </>
        )}
        {costume === "firefighter" && (
          <>
            <path
              d="M-6 -2 V11 M6 -2 V11 M-9 7 H9"
              stroke="#e5e2a3"
              strokeWidth="2.5"
            />
            <path d="M0 -2 V11" stroke="#765a24" strokeWidth="1" />
            <path d="M-2 1 H2 M-2 4 H2" stroke="#68552f" strokeWidth="1" />
          </>
        )}
        {costume === "chef" && (
          <>
            <path
              d="M-5 -2 L0 2 L5 -2"
              fill="none"
              stroke="#c3cbd0"
              strokeWidth="1.2"
            />
            {[3, 6.5, 10].map((y) => (
              <g key={y}>
                <circle cx="-3" cy={y} r=".8" fill="#50616c" />
                <circle cx="3" cy={y} r=".8" fill="#50616c" />
              </g>
            ))}
          </>
        )}
        {costume === "construction" && (
          <>
            <path
              d="M-5 -2 V11 M5 -2 V11 M-9 7 H9"
              stroke="#ede4a0"
              strokeWidth="2.5"
            />
            <path d="M0 -2 V11" stroke="#925c37" strokeWidth="1" />
          </>
        )}
        {costume === "astronaut" && (
          <>
            <path d="M-8 0 V9 M8 0 V9" stroke="#aebdc8" strokeWidth="1.5" />
            <rect x="-5" y="1" width="10" height="7" rx="1.5" fill="#879eaf" />
            <rect x="-4" y="2" width="8" height="5" rx=".8" fill="#3e647e" />
            <path d="M-2 3 H1" stroke="#b6dce5" strokeWidth="1" />
            <circle cx="2" cy="5" r=".8" fill="#e4a379" />
            <path
              d="M-5 8 Q-9 8 -8 11 H0"
              fill="none"
              stroke="#718b9e"
              strokeWidth="1"
            />
            <path d="M-7 10 H7" stroke="#9cabb8" strokeWidth="2" />
          </>
        )}
      </g>
    </g>
  );
}

// Color belongs to the uniform, independent of the saved shirt color.
export function CostumeHead({
  costume,
  headCx,
  headCy,
}: {
  costume: Costume;
  headCx: number;
  headCy: number;
}) {
  return (
    <g transform={`translate(${headCx} ${headCy})`} data-costume-head={costume}>
      {costume === "police" && (
        <>
          <path d="M-10 -7 L-11 -12 Q0 -18 11 -12 L10 -7 Z" fill="#304a73" />
          <path
            d="M-9 -12 Q0 -15 8 -12"
            fill="none"
            stroke="#7186a1"
            strokeWidth=".8"
          />
          <path d="M-10 -8 Q0 -6 10 -8 L11 -5 Q0 -1 -11 -5 Z" fill="#182b49" />
          <path
            d="M-9 -7 Q0 -5 9 -7"
            fill="none"
            stroke="#ad965c"
            strokeWidth=".8"
          />
          <path d="M-2 -12 H2 V-9 L0 -7 L-2 -9 Z" fill="#ddbd60" />
        </>
      )}
      {(costume === "firefighter" || costume === "construction") && (
        <>
          <path
            d={
              costume === "firefighter"
                ? "M-11 -6 Q-12 -17 0 -17 Q12 -17 11 -6 L14 -3 Q0 -1 -14 -3 Z"
                : "M-11 -5 Q-12 -17 0 -17 Q12 -17 11 -5 Z"
            }
            fill={costume === "firefighter" ? "#be5142" : "#e4b944"}
          />
          <path
            d="M-8 -8 Q-8 -13 -4 -14 M4 -14 Q8 -13 8 -8"
            fill="none"
            stroke="white"
            strokeOpacity=".22"
            strokeWidth="1"
          />
          <path
            d="M0 -16 V-7"
            stroke={costume === "firefighter" ? "#883d35" : "#ba8d30"}
            strokeWidth="2.5"
          />
          <path
            d="M-12 -5 Q0 -3 12 -5"
            fill="none"
            stroke={costume === "firefighter" ? "#883d35" : "#ba8d30"}
            strokeWidth="2"
            strokeLinecap="round"
          />
          {costume === "firefighter" && (
            <path d="M-3 -11 H3 V-7 L0 -5 L-3 -7 Z" fill="#e8d59b" />
          )}
        </>
      )}
      {costume === "chef" && (
        <>
          <path
            d="M-8 -7 L-9 -15 Q-14 -16 -12 -21 Q-10 -25 -5 -23 Q-2 -28 3 -24 Q9 -27 12 -22 Q15 -17 9 -15 L8 -7 Z"
            fill="#f3f4ef"
            stroke="#b9c4c9"
            strokeWidth=".8"
          />
          <path
            d="M5 -23 Q9 -20 6 -15 L6 -8 H8 L9 -15 Q15 -17 12 -22 Q9 -26 5 -23"
            fill="#d9e0e1"
          />
          <path
            d="M-5 -19 L-4 -13 M1 -20 V-13"
            stroke="#c8d1d2"
            strokeWidth=".8"
            strokeLinecap="round"
          />
          <path
            d="M-8 -12 Q0 -10 8 -12 L8 -7 Q0 -5 -8 -7 Z"
            fill="#edf0ed"
            stroke="#b9c4c9"
            strokeWidth=".8"
          />
        </>
      )}
      {costume === "astronaut" && (
        <>
          <ellipse
            cy="-1"
            rx="12.5"
            ry="13"
            fill="none"
            stroke="#8399a9"
            strokeWidth="4"
          />
          <ellipse
            cy="-1.5"
            rx="12.5"
            ry="13"
            fill="none"
            stroke="#e4eaed"
            strokeWidth="2.5"
          />
          <path
            d="M-9 -8 Q-8 -11 -4 -12"
            fill="none"
            stroke="#b0d7e3"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <rect x="-15" y="-3" width="4" height="7" rx="1.5" fill="#a9bbc6" />
          <rect x="11" y="-3" width="4" height="7" rx="1.5" fill="#a9bbc6" />
          <path
            d="M-8 11 Q0 14 8 11"
            fill="none"
            stroke="#a9bbc6"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      )}
    </g>
  );
}
