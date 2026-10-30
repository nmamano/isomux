// The background-work ring in an agent's own SVG (the office scene). The
// server renders this file (server/agent-avatar.ts, through
// ui/office/Character.tsx), so it imports react only and touches no browser
// global at module scope.

function reducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The arc turns once in 2.4 s; with reduced motion it stands still. */
export function spin(cx: number, cy: number) {
  if (reducedMotion()) return null;
  return (
    <animateTransform
      attributeName="transform"
      type="rotate"
      values={`0 ${cx} ${cy};360 ${cx} ${cy}`}
      dur="2.4s"
      repeatCount="indefinite"
    />
  );
}

/** Drawn in the character's own SVG units, centred on cx,cy (by default
 *  where the zZ sits). Above nine it writes 9+: on a phone the digit is
 *  about 6 px. */
export function SceneBackgroundMark({
  count,
  cx = 46,
  cy = 16,
}: {
  count: number;
  cx?: number;
  cy?: number;
}) {
  const text = count > 9 ? "9+" : String(count);
  return (
    <g data-background-mark="" transform={`translate(${cx - 46} ${cy - 16})`}>
      <circle
        cx="46"
        cy="16"
        r="9"
        fill="rgba(20,28,48,0.72)"
        stroke="rgba(200,220,255,0.35)"
        strokeWidth="0.8"
      />
      <circle
        cx="46"
        cy="16"
        r="6.6"
        fill="none"
        stroke="rgba(200,220,255,0.25)"
        strokeWidth="1.4"
      />
      <path
        d="M46 9.4 A6.6 6.6 0 0 1 52.6 16"
        fill="none"
        stroke="rgba(200,220,255,0.9)"
        strokeWidth="1.4"
        strokeLinecap="round"
      >
        {spin(46, 16)}
      </path>
      <text
        x="46"
        y={text.length > 1 ? 18.6 : 19}
        fontSize={text.length > 1 ? 7 : 8.5}
        fontWeight="bold"
        textAnchor="middle"
        fill="rgba(220,232,255,0.95)"
        fontFamily="system-ui, sans-serif"
      >
        {text}
      </text>
    </g>
  );
}
