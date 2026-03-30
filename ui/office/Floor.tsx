import { useState, useEffect } from "react";
import { SCENE_W, SCENE_H, VB_X, VB_Y } from "./grid.ts";

const SVG_STYLE: React.CSSProperties = {
  position: "absolute", top: 0, left: 0, pointerEvents: "none",
};
const VB = `${VB_X} ${VB_Y} ${SCENE_W} ${SCENE_H}`;

export function Floor() {
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

export function Walls({ onToggleTheme }: { onToggleTheme?: () => void }) {
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
    const topY = 30 + u * ((-40) - 30);    // top edge: 30 to -40
    const botY = 120 + u * (50 - 120);      // bottom edge: 120 to 50
    const x = -295 + u * 140;
    const y = topY + v * (botY - topY);
    return [x, y, r] as [number, number, number];
  });

  return (
    <svg style={SVG_STYLE} width={SCENE_W} height={SCENE_H} viewBox={VB} overflow="visible">
      <defs>
        {/* Clip the sky scene to the window pane (iso parallelogram) */}
        <clipPath id="window-clip">
          <path d="M-295 120 L-155 50 L-155 -40 L-295 30 Z" />
        </clipPath>
      </defs>

      {/* Left wall (2:1 iso ratio) */}
      <path d="M-355 277.5 L-355 37.5 L120 -200 L120 40 Z" fill="var(--wall-left)" stroke="var(--wall-stroke)" strokeWidth="0.5" />
      {/* Right wall (2:1 iso ratio) */}
      <path d="M120 -200 L120 40 L595 277.5 L595 37.5 Z" fill="var(--wall-right)" stroke="var(--wall-stroke)" strokeWidth="0.5" />

      {/* Window on left wall */}
      {/* Frame */}
      <path d="M-300 125 L-150 50 L-150 -45 L-300 30 Z" fill="var(--wall-decor)" stroke="var(--wall-stroke)" strokeWidth="1" />
      {/* Pane area */}
      <path d="M-295 120 L-155 50 L-155 -40 L-295 30 Z" fill="#0a0e1a" />

      {/* Night scene (dark mode) */}
      <g clipPath="url(#window-clip)" className="window-night">
        <path d="M-295 120 L-155 50 L-155 -40 L-295 30 Z" fill="#0a0e1a" />
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
          <circle cx={-210} cy={-5} r={18} fill="transparent" />
          <circle cx={-210} cy={-5} r={12} fill="#E8E0C8" />
          <circle cx={-210 + moonPhase * 10} cy={-6} r={10} fill="#0a0e1a" />
          {/* Moon glow */}
          <circle cx={-210} cy={-5} r={18} fill="#E8E0C8" opacity="0.05" />
        </g>
      </g>

      {/* Day scene (light mode) */}
      <g clipPath="url(#window-clip)" className="window-day">
        <path d="M-295 120 L-155 50 L-155 -40 L-295 30 Z" fill="#87CEEB" />
        {/* Sun (clickable to toggle theme) */}
        <g onClick={onToggleTheme} style={{ cursor: "pointer", pointerEvents: "auto" }}>
          <circle cx={-215} cy={0} r={20} fill="transparent" />
          <circle cx={-215} cy={0} r={14} fill="#F5D060" />
          <circle cx={-215} cy={0} r={20} fill="#F5D060" opacity="0.15" />
        </g>
        {/* Clouds */}
        <ellipse cx={-250} cy={45} rx={18} ry={6} fill="white" opacity="0.7" />
        <ellipse cx={-240} cy={42} rx={12} ry={5} fill="white" opacity="0.6" />
        <ellipse cx={-185} cy={10} rx={14} ry={5} fill="white" opacity="0.5" />
        <ellipse cx={-175} cy={8} rx={10} ry={4} fill="white" opacity="0.45" />
      </g>

      {/* Window crossbar (vertical center divider) */}
      <line x1={-225} y1={85} x2={-225} y2={-5} stroke="var(--wall-decor)" strokeWidth="2" />
      {/* Window crossbar (horizontal, following iso slope) */}
      <path d="M-295 75 L-155 5" stroke="var(--wall-decor)" strokeWidth="2" fill="none" />

      {/* Whiteboard on left wall */}
      <path d="M-100 30 L40 -40 L40 -110 L-100 -40 Z" fill="var(--whiteboard-outer)" stroke="var(--wall-stroke)" strokeWidth="0.8" />
      <path d="M-90 17 L30 -43 L30 -97 L-90 -37 Z" fill="var(--whiteboard-inner)" />
      {/* Clock on right wall (skewed to match 2:1 wall angle ~27°) */}
      <g transform="translate(240,-85) skewY(27)">
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
      <g className="neon-sign-on" transform="translate(370, -5) skewY(27)" style={{ animation: "neonFlicker 5s ease-in-out infinite, neonGlow 3s ease-in-out infinite" }}>
        {/* Hit area */}
        <rect x="-38" y="-18" width="92" height="32" fill="transparent" style={{ cursor: "pointer", pointerEvents: "auto" }} onClick={() => window.open("https://isomux.com", "_blank")} />
        {/* Letters as thick strokes */}
        <g fill="none" stroke="#ff6ec7" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {/* i — dot + stem */}
          <circle cx="-32" cy="-12" r="1.2" fill="#ff6ec7" stroke="none" />
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
        <g fill="none" stroke="#ff6ec7" strokeWidth="1.2" strokeLinecap="round" opacity="0.7">
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
        <line x1="-34" y1="9" x2="52" y2="9" stroke="#ff6ec7" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
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
    </svg>
  );
}
