import { useState, useEffect } from "react";
import { SCENE_W, SCENE_H, VB_X, VB_Y } from "./grid.ts";
import { useAppState } from "../store.tsx";

const NEON_COLORS = [
  "#ff6ec7", // hot pink (original)
  "#6effb4", // mint green
  "#6ec7ff", // sky blue
  "#ffb46e", // warm amber
  "#c76eff", // purple
  "#ff6e6e", // coral red
];

const SVG_STYLE: React.CSSProperties = {
  position: "absolute", top: 0, left: 0, pointerEvents: "none",
};
const VB = `${VB_X} ${VB_Y} ${SCENE_W} ${SCENE_H}`;

export function Floor() {
  const { currentRoom } = useAppState();
  const neon = NEON_COLORS[currentRoom % NEON_COLORS.length];
  // Floor diamond matches wall bottom edges (2:1 isometric ratio):
  // back=(120,40), left=(-260,230), right=(500,230), front=(120,420)
  const backX = 120, backY = 40;
  const rowDx = -47.5, rowDy = 23.75;
  const colDx = 47.5, colDy = 23.75;
  const N = 10;

  const tiles = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const bx = backX + r * rowDx + c * colDx;
      const by = backY + r * rowDy + c * colDy;
      const light = (r + c) % 2 === 0;
      tiles.push(
        <path
          key={`${r}-${c}`}
          d={`M${bx} ${by} L${bx + rowDx} ${by + rowDy} L${bx + rowDx + colDx} ${by + rowDy + colDy} L${bx + colDx} ${by + colDy} Z`}
          fill={light ? "var(--floor-light)" : "var(--floor-dark)"}
          stroke="var(--floor-stroke)"
          strokeWidth="0.5"
        />
      );
    }
  }
  return (
    <svg style={SVG_STYLE} width={SCENE_W} height={SCENE_H} viewBox={VB} overflow="visible">
      {tiles}
    </svg>
  );
}

interface DoorProps {
  label: string;
  onClick: () => void;
  dragOver?: boolean;
  reject?: boolean;
}

export function Walls({ onToggleTheme, onEditOfficePrompt, hasOfficePrompt, onOpenTasks, onOpenCronjobs, taskCount = 0, leftDoor, rightDoor }: { onToggleTheme?: () => void; onEditOfficePrompt?: () => void; hasOfficePrompt?: boolean; onOpenTasks?: () => void; onOpenCronjobs?: () => void; taskCount?: number; leftDoor?: DoorProps | null; rightDoor?: DoorProps | null }) {
  const { currentRoom } = useAppState();
  const neon = NEON_COLORS[currentRoom % NEON_COLORS.length];
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const hours = now.getHours() % 12;
  const minutes = now.getMinutes();
  const hourAngle = (hours + minutes / 60) * 30; // 360/12 = 30° per hour
  const minuteAngle = minutes * 6; // 360/60 = 6° per minute
  const R = 24; // clock radius
  const r = R * 0.83; // face radius

  // Hand endpoints (angle 0 = 12 o'clock, clockwise)
  const hLen = r * 0.55;
  const mLen = r * 0.78;
  const hx = hLen * Math.sin((hourAngle * Math.PI) / 180);
  const hy = -hLen * Math.cos((hourAngle * Math.PI) / 180);
  const mx = mLen * Math.sin((minuteAngle * Math.PI) / 180);
  const my = -mLen * Math.cos((minuteAngle * Math.PI) / 180);

  // Moon phase: day of month 1-31 maps to crescent offset
  const dayOfMonth = now.getDate();
  const moonPhase = (dayOfMonth / 30) * 2 - 1; // -1 to ~1, controls crescent offset

  // Stars — placed in parallelogram coords, then projected
  // Pane corners: TL(-295,30) TR(-155,-40) BL(-295,120) BR(-155,50)
  // u=0..1 is left-to-right, v=0..1 is top-to-bottom
  const starUV: Array<[number, number, number]> = [
    [0.1, 0.2, 0.6], [0.3, 0.1, 0.9], [0.5, 0.3, 0.5], [0.8, 0.15, 0.7],
    [0.15, 0.5, 0.5], [0.4, 0.4, 0.8], [0.65, 0.2, 0.6], [0.9, 0.35, 0.5],
    [0.2, 0.75, 0.9], [0.45, 0.6, 0.6], [0.7, 0.5, 0.7], [0.85, 0.7, 0.5],
    [0.05, 0.9, 0.5], [0.35, 0.8, 0.7], [0.6, 0.75, 0.6], [0.95, 0.55, 0.8],
    [0.25, 0.35, 0.5], [0.55, 0.85, 0.6], [0.75, 0.4, 0.7], [0.1, 0.65, 0.5],
    [0.5, 0.15, 0.8], [0.7, 0.9, 0.5], [0.85, 0.1, 0.6], [0.3, 0.55, 0.5],
  ];
  const stars = starUV.map(([u, v, r]) => {
    const topY = 25 + u * ((-45) - 25);    // top edge: 25 to -45
    const botY = 115 + u * (45 - 115);      // bottom edge: 115 to 45
    const x = -285 + u * 140;
    const y = topY + v * (botY - topY);
    return [x, y, r] as [number, number, number];
  });

  return (
    <svg style={SVG_STYLE} width={SCENE_W} height={SCENE_H} viewBox={VB} overflow="visible">
      <defs>
        {/* Clip the sky scene to the window pane (iso parallelogram) */}
        <clipPath id="window-clip">
          <path d="M-285 115 L-145 45 L-145 -45 L-285 25 Z" />
        </clipPath>
      </defs>

      {/* Left wall (2:1 iso ratio) */}
      <path d="M-355 277.5 L-355 37.5 L120 -200 L120 40 Z" fill="var(--wall-left)" stroke="var(--wall-stroke)" strokeWidth="0.5" />
      {/* Right wall (2:1 iso ratio) */}
      <path d="M120 -200 L120 40 L595 277.5 L595 37.5 Z" fill="var(--wall-right)" stroke="var(--wall-stroke)" strokeWidth="0.5" />

      {/* Window on left wall */}
      {/* Frame */}
      <path d="M-290 120 L-140 45 L-140 -50 L-290 25 Z" fill="var(--wall-decor)" stroke="var(--wall-stroke)" strokeWidth="1" />
      {/* Pane area */}
      <path d="M-285 115 L-145 45 L-145 -45 L-285 25 Z" fill="#0a0e1a" />

      {/* Night scene (dark mode) */}
      <g clipPath="url(#window-clip)" className="window-night">
        <path d="M-285 115 L-145 45 L-145 -45 L-285 25 Z" fill="#0a0e1a" />
        {/* Stars */}
        {stars.map(([sx, sy, sr], i) => (
          <circle key={i} cx={sx} cy={sy} r={sr} fill="white" opacity={0.4 + (i % 4) * 0.15}>
            {i % 5 === 0 && (
              <animate attributeName="opacity" values={`${0.3 + (i % 3) * 0.1};${0.7 + (i % 2) * 0.2};${0.3 + (i % 3) * 0.1}`} dur={`${2 + (i % 3)}s`} repeatCount="indefinite" />
            )}
          </circle>
        ))}
        {/* Moon — crescent via overlapping circles (clickable to toggle theme) */}
        <g onClick={onToggleTheme} style={{ cursor: "pointer", pointerEvents: "auto" }}>
          <circle cx={-203} cy={-8} r={18} fill="transparent" />
          <circle cx={-203} cy={-8} r={12} fill="#E8E0C8" />
          <circle cx={-203 + moonPhase * 10} cy={-9} r={10} fill="#0a0e1a" />
          {/* Moon glow */}
          <circle cx={-203} cy={-8} r={18} fill="#E8E0C8" opacity="0.05" />
        </g>
      </g>

      {/* Day scene (light mode) */}
      <g clipPath="url(#window-clip)" className="window-day">
        <path d="M-285 115 L-145 45 L-145 -45 L-285 25 Z" fill="#87CEEB" />
        {/* Sun (clickable to toggle theme) */}
        <g onClick={onToggleTheme} style={{ cursor: "pointer", pointerEvents: "auto" }}>
          <circle cx={-205} cy={-5} r={20} fill="transparent" />
          <circle cx={-205} cy={-5} r={14} fill="#F5D060" />
          <circle cx={-205} cy={-5} r={20} fill="#F5D060" opacity="0.15" />
        </g>
        {/* Clouds */}
        <ellipse cx={-240} cy={40} rx={18} ry={6} fill="white" opacity="0.7" />
        <ellipse cx={-230} cy={37} rx={12} ry={5} fill="white" opacity="0.6" />
        <ellipse cx={-175} cy={5} rx={14} ry={5} fill="white" opacity="0.5" />
        <ellipse cx={-165} cy={3} rx={10} ry={4} fill="white" opacity="0.45" />
      </g>

      {/* Window crossbar (vertical center divider) */}
      <line x1={-215} y1={80} x2={-215} y2={-10} stroke="var(--wall-decor)" strokeWidth="2" />
      {/* Window crossbar (horizontal, following iso slope) */}
      <path d="M-285 70 L-145 0" stroke="var(--wall-decor)" strokeWidth="2" fill="none" />

      {/* Corkboard on left wall — casual, mutable feel */}
      <g transform="translate(-55, -30) skewY(-27)" onClick={onOpenTasks} style={{ cursor: "pointer", pointerEvents: "auto" }}>
        {/* Board frame */}
        <rect x="-50" y="-40" width="95" height="70" rx="2" fill="#5a4430" stroke="#4a3620" strokeWidth="1" />
        {/* Cork surface */}
        <rect x="-46" y="-36" width="87" height="62" rx="1" fill="#c49a6c" />
        {/* Cork texture — subtle speckles */}
        <circle cx="-30" cy="-20" r="0.8" fill="#b88a58" opacity="0.5" />
        <circle cx="-10" cy="-10" r="0.6" fill="#b88a58" opacity="0.4" />
        <circle cx="15" cy="-25" r="0.7" fill="#b88a58" opacity="0.5" />
        <circle cx="25" cy="5" r="0.6" fill="#b88a58" opacity="0.4" />
        <circle cx="-35" cy="10" r="0.7" fill="#b88a58" opacity="0.3" />
        <circle cx="5" cy="15" r="0.5" fill="#b88a58" opacity="0.4" />

        {/* Index card 1 — slightly tilted, top-left */}
        <g transform="translate(-32, -22) rotate(-3)">
          <rect x="0" y="0" width="28" height="20" rx="1" fill="#f5f0e0" stroke="#e0d8c4" strokeWidth="0.3" />
          {taskCount >= 1 && (
            <>
              <line x1="3" y1="6" x2="25" y2="6" stroke="#ccc" strokeWidth="0.3" />
              <line x1="3" y1="10" x2="22" y2="10" stroke="#ccc" strokeWidth="0.3" />
              <line x1="3" y1="14" x2="18" y2="14" stroke="#ccc" strokeWidth="0.3" />
            </>
          )}
          {/* Red pushpin */}
          <circle cx="14" cy="2" r="2.5" fill="#e04040" />
          <circle cx="14" cy="2" r="1.2" fill="#c03030" />
        </g>

        {/* Index card 2 — slightly tilted other way, center-right */}
        <g transform="translate(5, -18) rotate(2)">
          <rect x="0" y="0" width="30" height="22" rx="1" fill="#eef4ff" stroke="#d0d8e8" strokeWidth="0.3" />
          {taskCount >= 2 && (
            <>
              <line x1="3" y1="6" x2="27" y2="6" stroke="#bbc" strokeWidth="0.3" />
              <line x1="3" y1="10" x2="25" y2="10" stroke="#bbc" strokeWidth="0.3" />
              <line x1="3" y1="14" x2="20" y2="14" stroke="#bbc" strokeWidth="0.3" />
              <line x1="3" y1="18" x2="15" y2="18" stroke="#bbc" strokeWidth="0.3" />
            </>
          )}
          {/* Blue pushpin */}
          <circle cx="15" cy="2" r="2.5" fill="#4080d0" />
          <circle cx="15" cy="2" r="1.2" fill="#3060b0" />
        </g>

        {/* Index card 3 — bottom left, slight tilt */}
        <g transform="translate(-28, 4) rotate(1.5)">
          <rect x="0" y="0" width="26" height="18" rx="1" fill="#fff8e0" stroke="#e8dcc0" strokeWidth="0.3" />
          {taskCount >= 3 && (
            <>
              <line x1="3" y1="5" x2="23" y2="5" stroke="#dda" strokeWidth="0.3" />
              <line x1="3" y1="9" x2="20" y2="9" stroke="#dda" strokeWidth="0.3" />
              <line x1="3" y1="13" x2="16" y2="13" stroke="#dda" strokeWidth="0.3" />
            </>
          )}
          {/* Yellow pushpin */}
          <circle cx="13" cy="1" r="2.5" fill="#e8c020" />
          <circle cx="13" cy="1" r="1.2" fill="#c8a010" />
        </g>

        {/* Empty pin hole — card was removed */}
        <g transform="translate(18, 8)">
          <circle cx="0" cy="0" r="2.5" fill="#40b060" />
          <circle cx="0" cy="0" r="1.2" fill="#309048" />
          {/* Tiny pinhole shadow underneath */}
          <circle cx="0" cy="3" r="0.8" fill="#a08050" opacity="0.3" />
        </g>
      </g>

      {/* Framed wall sign on left wall — formal, authoritative feel */}
      <g transform="translate(50, -75) skewY(-27)" onClick={onEditOfficePrompt} style={{ cursor: "pointer", pointerEvents: "auto" }}>
        {/* Outer frame — dark wood/brass */}
        <rect x="-30" y="-32" width="60" height="58" rx="2" fill="#3a3028" stroke="#2a2018" strokeWidth="1.2" />
        {/* Inner frame — thin brass inset */}
        <rect x="-27" y="-29" width="54" height="52" rx="1" fill="none" stroke="#8a7a60" strokeWidth="0.5" />
        {/* Cream background */}
        <rect x="-25" y="-27" width="50" height="48" rx="1" fill={hasOfficePrompt ? "#f5f0e4" : "#ece8dc"} />
        {/* Title line — always visible */}
        <line x1="-14" y1="-20" x2="14" y2="-20" stroke="#333" strokeWidth="1" opacity="0.35" strokeLinecap="round" />
        {hasOfficePrompt ? (
          <>
            {/* Divider */}
            <line x1="-10" y1="-16" x2="10" y2="-16" stroke="#999" strokeWidth="0.3" opacity="0.3" />
            {/* Body text lines — small, illegible, typed feel */}
            <line x1="-18" y1="-10" x2="18" y2="-10" stroke="#444" strokeWidth="0.6" opacity="0.25" />
            <line x1="-18" y1="-5" x2="16" y2="-5" stroke="#444" strokeWidth="0.6" opacity="0.25" />
            <line x1="-18" y1="0" x2="17" y2="0" stroke="#444" strokeWidth="0.6" opacity="0.25" />
            <line x1="-18" y1="5" x2="14" y2="5" stroke="#444" strokeWidth="0.6" opacity="0.25" />
            <line x1="-18" y1="10" x2="12" y2="10" stroke="#444" strokeWidth="0.6" opacity="0.25" />
            {/* Subtle seal/stamp at bottom */}
            <circle cx="0" cy="17" r="4" fill="none" stroke="#8a6040" strokeWidth="0.5" opacity="0.2" />
            <circle cx="0" cy="17" r="2" fill="#8a6040" opacity="0.08" />
          </>
        ) : (
          <>
            {/* Empty state — blank sign, faint placeholder */}
            <line x1="-8" y1="-4" x2="8" y2="-4" stroke="#bbb" strokeWidth="0.6" opacity="0.3" strokeLinecap="round" />
            <line x1="-6" y1="0" x2="6" y2="0" stroke="#bbb" strokeWidth="0.5" opacity="0.2" strokeLinecap="round" />
            <line x1="-4" y1="4" x2="4" y2="4" stroke="#bbb" strokeWidth="0.4" opacity="0.15" strokeLinecap="round" />
          </>
        )}
      </g>
      {/* Clock on right wall (skewed to match 2:1 wall angle ~27°) */}
      <g transform="translate(240,-85) skewY(27)" onClick={onOpenCronjobs} style={onOpenCronjobs ? { cursor: "pointer", pointerEvents: "auto" } : undefined}>
        {/* Slightly larger transparent hit area for forgiving clicks */}
        {onOpenCronjobs && <circle cx="0" cy="0" r={R + 4} fill="transparent" />}
        <circle cx="0" cy="0" r={R} fill="var(--wall-decor)" stroke="var(--wall-decor-stroke)" strokeWidth="1" />
        <circle cx="0" cy="0" r={r} fill="var(--wall-decor-inner)" />
        {/* Hour ticks */}
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          const x1 = (r - 2) * Math.sin(a);
          const y1 = -(r - 2) * Math.cos(a);
          const x2 = (r - 5) * Math.sin(a);
          const y2 = -(r - 5) * Math.cos(a);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--wall-decor-stroke)" strokeWidth={i % 3 === 0 ? 1.2 : 0.6} />;
        })}
        {/* Hour hand */}
        <line x1="0" y1="0" x2={hx} y2={hy} stroke="var(--clock-hand)" strokeWidth="1.5" strokeLinecap="round" />
        {/* Minute hand */}
        <line x1="0" y1="0" x2={mx} y2={my} stroke="var(--clock-hand)" strokeWidth="1" strokeLinecap="round" />
        {/* Center dot */}
        <circle cx="0" cy="0" r="1.5" fill="var(--clock-hand)" />
      </g>
      {/* Neon sign — right wall, hand-drawn tube letters with ligaments */}
      {/* Letter positions: i(-38), s(-25), o(-11), m(5), u(23), x(37) */}
      {/* On (dark mode) */}
      <g className="neon-sign-on" transform="translate(370, -5) skewY(27)" style={{ animation: "neonFlicker 5s ease-in-out infinite", filter: `drop-shadow(0 0 4px ${neon}) drop-shadow(0 0 12px ${neon})` }}>
        {/* Hit area */}
        <rect x="-38" y="-18" width="92" height="32" fill="transparent" style={{ cursor: "pointer", pointerEvents: "auto" }} onClick={() => window.open("https://isomux.com", "_blank")} />
        {/* Letters as thick strokes */}
        <g fill="none" stroke={neon} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {/* i — dot + stem */}
          <circle cx="-32" cy="-12" r="1.2" fill={neon} stroke="none" />
          <line x1="-32" y1="-8" x2="-32" y2="2" />
          {/* s */}
          <g transform="rotate(20, -22, -3.5)">
            <path d="M-20 -11 Q-27 -11 -27 -7 Q-27 -3 -22 -3 Q-17 -3 -17 1 Q-17 4 -24 4" />
          </g>
          {/* o */}
          <ellipse cx="-8" cy="-3.5" rx="5.5" ry="7" />
          {/* m */}
          <path d="M3 4 L3 -6 Q3 -11 7 -11 Q11 -11 11 -6 L11 -2 Q11 -11 15 -11 Q19 -11 19 -6 L19 4" />
          {/* u */}
          <path d="M24 -11 L24 -1 Q24 4 28.5 4 Q33 4 33 -1 L33 -11" />
          {/* x */}
          <line x1="38" y1="-11" x2="48" y2="4" />
          <line x1="48" y1="-11" x2="38" y2="4" />
        </g>
        {/* Ligaments — thin connecting tubes between letters */}
        <g fill="none" stroke={neon} strokeWidth="1.2" strokeLinecap="round" opacity="0.7">
          {/* i→s: bottom of i stem to start of s */}
          <path d="M-32 2 Q-28 8 -24 4" />
          {/* s→o: end of s to top of o */}
          <path d="M-20 -11 Q-17 -14 -13.5 -10.5" />
          {/* o→m: right of o to start of m */}
          <path d="M-2.5 -3.5 Q0 -1 3 4" />
          {/* m→u: end of m to start of u */}
          <path d="M19 4 Q21 6 24 -1" />
          {/* u→x: end of u to start of x */}
          <path d="M33 -11 Q35 -14 38 -11" />
        </g>
        {/* Underline */}
        <line x1="-34" y1="9" x2="52" y2="9" stroke={neon} strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
      </g>
      {/* Off (light mode) */}
      <g className="neon-sign-off" transform="translate(370, -5) skewY(27)">
        {/* Hit area */}
        <rect x="-38" y="-18" width="92" height="32" fill="transparent" style={{ cursor: "pointer", pointerEvents: "auto" }} onClick={() => window.open("https://isomux.com", "_blank")} />
        <g fill="none" stroke="#444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.7">
          <circle cx="-32" cy="-12" r="1.2" fill="#444" stroke="none" />
          <line x1="-32" y1="-8" x2="-32" y2="2" />
          <g transform="rotate(20, -22, -3.5)">
            <path d="M-20 -11 Q-27 -11 -27 -7 Q-27 -3 -22 -3 Q-17 -3 -17 1 Q-17 4 -24 4" />
          </g>
          <ellipse cx="-8" cy="-3.5" rx="5.5" ry="7" />
          <path d="M3 4 L3 -6 Q3 -11 7 -11 Q11 -11 11 -6 L11 -2 Q11 -11 15 -11 Q19 -11 19 -6 L19 4" />
          <path d="M24 -11 L24 -1 Q24 4 28.5 4 Q33 4 33 -1 L33 -11" />
          <line x1="38" y1="-11" x2="48" y2="4" />
          <line x1="48" y1="-11" x2="38" y2="4" />
        </g>
        <g fill="none" stroke="#444" strokeWidth="1.2" strokeLinecap="round" opacity="0.45">
          <path d="M-32 2 Q-28 8 -24 4" />
          <path d="M-20 -11 Q-17 -14 -13.5 -10.5" />
          <path d="M-2.5 -3.5 Q0 -1 3 4" />
          <path d="M19 4 Q21 6 24 -1" />
          <path d="M33 -11 Q35 -14 38 -11" />
        </g>
        <line x1="-34" y1="9" x2="52" y2="9" stroke="#444" strokeWidth="1.5" strokeLinecap="round" opacity="0.35" />
      </g>

      {/* Vent — upper-east area of right wall */}
      <g transform="translate(500, 60) skewY(27)">
        <rect x="-25" y="-15" width="50" height="30" rx="2" fill="var(--wall-decor)" stroke="var(--wall-decor-stroke)" strokeWidth="0.8" />
        <line x1="-22" y1="-8" x2="22" y2="-8" stroke="var(--wall-decor-stroke)" strokeWidth="1.5" />
        <line x1="-22" y1="-2" x2="22" y2="-2" stroke="var(--wall-decor-stroke)" strokeWidth="1.5" />
        <line x1="-22" y1="4" x2="22" y2="4" stroke="var(--wall-decor-stroke)" strokeWidth="1.5" />
        <line x1="-22" y1="10" x2="22" y2="10" stroke="var(--wall-decor-stroke)" strokeWidth="1.5" />
      </g>

      {/* Left wall door — leads to previous room */}
      {leftDoor && (
        <g onClick={leftDoor.onClick} style={{ cursor: "pointer", pointerEvents: "auto" }}>
          <g transform="translate(-315, 237) skewY(-27)">
            <rect x="-33" y="-93" width="66" height="113" rx="3" fill={leftDoor.reject ? "#5a2020" : leftDoor.dragOver ? "#5a4a2a" : "#3a2a1a"} stroke="#2a1a0a" strokeWidth="1.5" />
            <rect x="-27" y="-87" width="54" height="101" rx="1.5" fill={leftDoor.reject ? "#7a3030" : leftDoor.dragOver ? "#7a6050" : "#5a4030"} />
            <rect x="-21" y="-78" width="42" height="36" rx="1.5" fill={leftDoor.reject ? "#8a4040" : leftDoor.dragOver ? "#8a7060" : "#6a5040"} stroke="#4a3020" strokeWidth="0.5" />
            <rect x="-21" y="-31" width="42" height="36" rx="1.5" fill={leftDoor.reject ? "#8a4040" : leftDoor.dragOver ? "#8a7060" : "#6a5040"} stroke="#4a3020" strokeWidth="0.5" />
            <circle cx="15" cy="-25" r="5" fill="#8a7040" />
            <circle cx="15" cy="-25" r="3.5" fill="#c0a060" />
            <ellipse cx="14.5" cy="-26" rx="2" ry="1.5" fill="#d8c080" opacity="0.6" />
            {leftDoor.dragOver && <rect x="-33" y="-93" width="66" height="113" rx="3" fill="rgba(126,184,255,0.15)" stroke="rgba(126,184,255,0.6)" strokeWidth="2" />}
            {leftDoor.reject && <rect x="-33" y="-93" width="66" height="113" rx="3" fill="rgba(255,60,60,0.25)" stroke="rgba(255,60,60,0.7)" strokeWidth="2" />}
            <text x="0" y="-98" textAnchor="middle" fill={leftDoor.reject ? "var(--red, #f85149)" : leftDoor.dragOver ? "var(--accent, #58a6ff)" : "var(--text-dim)"} fontSize="12" fontFamily="'JetBrains Mono',monospace" fontWeight="600" style={{ userSelect: "none" }}>
              {leftDoor.label}
            </text>
          </g>
        </g>
      )}

      {/* Right wall door — leads to next room */}
      {rightDoor && (
        <g onClick={rightDoor.onClick} style={{ cursor: "pointer", pointerEvents: "auto" }}>
          <g transform="translate(555, 237) skewY(27)">
            <rect x="-33" y="-93" width="66" height="113" rx="3" fill={rightDoor.reject ? "#5a2020" : rightDoor.dragOver ? "#5a4a2a" : "#3a2a1a"} stroke="#2a1a0a" strokeWidth="1.5" />
            <rect x="-27" y="-87" width="54" height="101" rx="1.5" fill={rightDoor.reject ? "#7a3030" : rightDoor.dragOver ? "#7a6050" : "#5a4030"} />
            <rect x="-21" y="-78" width="42" height="36" rx="1.5" fill={rightDoor.reject ? "#8a4040" : rightDoor.dragOver ? "#8a7060" : "#6a5040"} stroke="#4a3020" strokeWidth="0.5" />
            <rect x="-21" y="-31" width="42" height="36" rx="1.5" fill={rightDoor.reject ? "#8a4040" : rightDoor.dragOver ? "#8a7060" : "#6a5040"} stroke="#4a3020" strokeWidth="0.5" />
            <circle cx="-15" cy="-25" r="5" fill="#8a7040" />
            <circle cx="-15" cy="-25" r="3.5" fill="#c0a060" />
            <ellipse cx="-15.5" cy="-26" rx="2" ry="1.5" fill="#d8c080" opacity="0.6" />
            {rightDoor.dragOver && <rect x="-33" y="-93" width="66" height="113" rx="3" fill="rgba(126,184,255,0.15)" stroke="rgba(126,184,255,0.6)" strokeWidth="2" />}
            {rightDoor.reject && <rect x="-33" y="-93" width="66" height="113" rx="3" fill="rgba(255,60,60,0.25)" stroke="rgba(255,60,60,0.7)" strokeWidth="2" />}
            <text x="0" y="-98" textAnchor="middle" fill={rightDoor.reject ? "var(--red, #f85149)" : rightDoor.dragOver ? "var(--accent, #58a6ff)" : "var(--text-dim)"} fontSize="12" fontFamily="'JetBrains Mono',monospace" fontWeight="600" style={{ userSelect: "none" }}>
              {rightDoor.label}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
