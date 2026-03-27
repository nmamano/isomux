export function Floor() {
  const tiles = [];
  for (let r = -1; r < 6; r++) {
    for (let c = -1; c < 5; c++) {
      const tw = 120,
        th = 60;
      const x = (c - r) * (tw / 2);
      const y = (c + r) * (th / 2);
      const light = (r + c) % 2 === 0;
      tiles.push(
        <path
          key={`${r}-${c}`}
          d={`M${x} ${y + th / 2} L${x + tw / 2} ${y} L${x + tw} ${y + th / 2} L${x + tw / 2} ${y + th} Z`}
          fill={light ? "#181e2e" : "#151b28"}
          stroke="rgba(255,255,255,0.018)"
          strokeWidth="0.5"
        />
      );
    }
  }
  return (
    <svg
      style={{ position: "absolute", left: "50%", top: "52%", transform: "translate(-50%,-50%)", pointerEvents: "none" }}
      width="900"
      height="600"
      viewBox="-360 -60 900 600"
      overflow="visible"
    >
      {tiles}
    </svg>
  );
}

export function Walls() {
  return (
    <svg
      style={{ position: "absolute", left: "50%", top: "52%", transform: "translate(-50%,-50%)", pointerEvents: "none" }}
      width="900"
      height="600"
      viewBox="-360 -60 900 600"
      overflow="visible"
    >
      {/* Left wall */}
      <path d="M-340 200 L-340 -40 L120 -200 L120 40 Z" fill="#111825" stroke="rgba(255,255,255,0.025)" strokeWidth="0.5" />
      {/* Right wall */}
      <path d="M120 -200 L120 40 L580 200 L580 -40 Z" fill="#0f1520" stroke="rgba(255,255,255,0.025)" strokeWidth="0.5" />
      {/* Whiteboard on left wall */}
      <path d="M-100 30 L40 -40 L40 -110 L-100 -40 Z" fill="#1a2236" stroke="rgba(255,255,255,0.05)" strokeWidth="0.8" />
      <path d="M-90 25 L30 -40 L30 -100 L-90 -35 Z" fill="#1e2840" />
      <path d="M-70 -10 L-20 -35" stroke="rgba(80,184,108,0.2)" strokeWidth="0.8" fill="none" />
      <path d="M-60 0 L0 -30" stroke="rgba(126,184,255,0.15)" strokeWidth="0.8" fill="none" />
      <path d="M-50 10 L10 -20" stroke="rgba(245,166,35,0.15)" strokeWidth="0.6" fill="none" />
      {/* Clock on right wall */}
      <circle cx="350" cy="-80" r="18" fill="#1a2236" stroke="rgba(255,255,255,0.06)" strokeWidth="0.8" />
      <circle cx="350" cy="-80" r="15" fill="#151d2c" />
      <line x1="350" y1="-80" x2="350" y2="-90" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
      <line x1="350" y1="-80" x2="358" y2="-76" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" />
      {/* Poster on right wall */}
      <rect x="440" y="-120" width="50" height="65" rx="2" fill="#1a2236" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" transform="skewY(27)" />
    </svg>
  );
}
