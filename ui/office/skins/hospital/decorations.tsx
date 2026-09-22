import { useTheme } from "../../../store.tsx";
import { hospitalColors } from "./palette.ts";

/** Hospital furniture and wall decorations. */
export function BedsideCabinet({ at }: { at: { x: number; y: number } }) {
  const { mode } = useTheme();
  const c = hospitalColors(mode);
  return (
    <g
      aria-hidden="true"
      data-hospital-decoration="cabinet"
      transform={`translate(${at.x}, ${at.y})`}
    >
      <path
        d="M0 -18 L23 -6 L0 6 L-23 -6 Z"
        fill={c.shadow}
        filter="url(#hospital-soft)"
      />
      <path
        d="M-21 -37 L0 -26 V3 L-21 -8 Z"
        fill={c.crossPlate}
        stroke={c.crossPlateEdge}
        strokeWidth="0.8"
      />
      <path d="M0 -26 L21 -37 V-8 L0 3 Z" fill={c.frameShade} />
      <path
        d="M-23 -38 L0 -49 L23 -38 L0 -26 Z"
        fill={c.mattress}
        stroke={c.crossPlateEdge}
        strokeWidth="1"
      />
      <path
        d="M-19 -25 L-2 -16 M-19 -11 L-2 -2"
        stroke={c.crossPlateEdge}
        strokeWidth="0.8"
      />
      <path
        d="M-14 -27 L-8 -24 M-14 -14 L-8 -11"
        stroke={c.metalShade}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M-18 -8 V-4 M-2 1 V5 M18 -8 V-4"
        stroke={c.metalShade}
        strokeWidth="2"
      />
      {/* Cup on the cabinet top. */}
      <path
        d="M13 -46 Q18 -47 17 -43 Q16 -41 13 -42"
        fill="none"
        stroke={c.linenShade}
        strokeWidth="1.4"
      />
      <path
        d="M6 -48 L14 -48 L13 -41 Q10 -39 7 -41 Z"
        fill={c.linen}
        stroke={c.linenShade}
        strokeWidth="0.6"
      />
      <ellipse cx="10" cy="-48" rx="4" ry="1.8" fill={c.metalShade} />
    </g>
  );
}

export function FramedLandscape() {
  const { mode } = useTheme();
  const dark = mode === "dark";
  return (
    <g
      aria-hidden="true"
      data-hospital-decoration="landscape"
      transform="translate(370, -5) skewY(27)"
    >
      <rect
        x="-43"
        y="-30"
        width="88"
        height="60"
        rx="1"
        fill="#000"
        opacity="0.12"
      />
      <rect
        x="-45"
        y="-32"
        width="88"
        height="60"
        rx="1"
        fill={dark ? "#655846" : "#a58a64"}
      />
      <rect
        x="-41"
        y="-28"
        width="80"
        height="52"
        fill={dark ? "#b0b7b1" : "#f4f0e5"}
      />
      <rect
        x="-36"
        y="-23"
        width="70"
        height="42"
        fill={dark ? "#455c68" : "#b8d4dc"}
      />
      <circle cx="18" cy="-12" r="5" fill={dark ? "#b5ab82" : "#f4e4ad"} />
      <path
        d="M-36 3 L-17 -13 L0 2 L11 -5 L34 8 V19 H-36 Z"
        fill={dark ? "#566965" : "#9db8ad"}
      />
      <path
        d="M-36 10 Q-15 -2 3 11 Q18 2 34 10 V19 H-36 Z"
        fill={dark ? "#344d49" : "#6f9585"}
      />
      <path
        d="M-10 19 Q5 12 0 8 Q10 12 5 19"
        fill={dark ? "#6d8790" : "#d5e7e8"}
      />
    </g>
  );
}

export function MedicalChart() {
  const { mode } = useTheme();
  const c = hospitalColors(mode);
  return (
    <g
      aria-hidden="true"
      data-hospital-decoration="chart"
      transform="translate(370, -5) skewY(27)"
    >
      <rect x="-27" y="-34" width="54" height="68" rx="2" fill={c.frameShade} />
      <rect x="-24" y="-31" width="48" height="62" fill={c.linen} />
      <rect x="-18" y="-25" width="36" height="5" rx="1" fill={c.blanket} />
      {/* A small anatomy diagram and notes keep the chart legible at room scale. */}
      <g
        fill="none"
        stroke={c.metalShade}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="-8" cy="-12" r="3.5" />
        <path d="M-8 -8 V9 M-16 -3 H0 M-8 9 L-14 21 M-8 9 L-2 21" />
        <path d="M-13 -4 Q-16 4 -10 8 M-3 -4 Q0 4 -6 8" />
        <path
          d="M5 -12 H17 M5 -7 H14 M5 2 H17 M5 7 H15 M5 16 H17 M5 21 H12"
          strokeWidth="0.9"
        />
      </g>
      <path
        d="M-11 0 Q-15 -4 -12 -5 Q-9 -6 -8 -3 Q-6 -6 -4 -4 Q-2 -1 -8 3 Z"
        fill={c.cross}
      />
    </g>
  );
}

export function CallButtonPanel() {
  const { mode } = useTheme();
  const c = hospitalColors(mode);
  return (
    <g
      aria-hidden="true"
      data-hospital-decoration="call"
      transform="translate(370, -5) skewY(27)"
    >
      <rect
        x="-26"
        y="-14"
        width="52"
        height="28"
        rx="3"
        fill={c.crossPlate}
        stroke={c.crossPlateEdge}
        strokeWidth="1.2"
      />
      <path
        d="M-19 -7 H-9 M-19 -3 H-9 M-19 1 H-9"
        stroke={c.metalShade}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="9" cy="0" r="7" fill={c.cross} />
      <path
        d="M6 1 V-2 Q9 -6 12 -2 V1 L13 3 H5 Z M8 5 H10"
        fill="none"
        stroke={c.linen}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <circle cx="19" cy="-8" r="1.7" fill={c.blanket} />
      <path
        d="M-2 14 V23 Q-2 33 8 33 Q17 33 17 23 V20"
        fill="none"
        stroke={c.metalShade}
        strokeWidth="1.5"
      />
      <rect
        x="13"
        y="15"
        width="8"
        height="15"
        rx="3"
        fill={c.metal}
        stroke={c.metalShade}
        strokeWidth="0.7"
      />
      <circle cx="17" cy="20" r="2" fill={c.cross} />
    </g>
  );
}

/** Two tied-back panels, projected onto the window's 2:1 wall plane. */
export function WindowCurtains() {
  const { mode } = useTheme();
  const c = hospitalColors(mode);
  const dark = mode === "dark";
  const fabric = dark ? "#656779" : "#e9e3d5";
  const shade = dark ? "#494d61" : "#c8c2b5";
  const light = dark ? "#7e8093" : "#faf5e8";
  return (
    <g
      aria-hidden="true"
      data-hospital-decoration="window-curtains"
      transform="matrix(1 -0.5 0 1 -290 25)"
    >
      <path
        d="M-21 -12 H171"
        stroke={c.metalShade}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="-23" cy="-12" r="3.5" fill={c.metal} />
      <circle cx="173" cy="-12" r="3.5" fill={c.metal} />
      {[false, true].map((right) => (
        <g
          key={String(right)}
          transform={right ? "translate(150 0) scale(-1 1)" : undefined}
        >
          {/* The inner edge curves out to the tie, leaving the glass open. */}
          <path
            d="M-17 -8 H24 Q22 26 2 64 Q3 83 12 108 Q-3 114 -20 108 Q-12 83 -10 64 Z"
            fill={fabric}
            stroke={shade}
            strokeWidth="0.7"
          />
          <path
            d="M-15 -7 Q-8 25 -9 63 Q-10 87 -17 108 L-10 110 Q-3 84 -5 65 Q-1 27 -7 -7 Z"
            fill={shade}
            opacity="0.8"
          />
          <path
            d="M2 -7 Q8 26 -2 64 Q-1 89 3 110"
            fill="none"
            stroke={light}
            strokeWidth="2.7"
            strokeLinecap="round"
          />
          <path
            d="M14 -7 Q17 21 0 63 M1 68 Q3 89 9 108"
            fill="none"
            stroke={shade}
            strokeWidth="1.2"
          />
          <path d="M-11 62 Q-4 65 3 62 L3 67 Q-4 70 -11 67 Z" fill={c.rail} />
          <path
            d="M-11 66 Q-20 73 -17 81"
            fill="none"
            stroke={c.rail}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {[-13, -3, 7, 18].map((x) => (
            <path
              key={x}
              d={`M${x} -8 V-13`}
              stroke={c.metal}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          ))}
        </g>
      ))}
    </g>
  );
}
