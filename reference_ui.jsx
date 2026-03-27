import { useState, useEffect, useRef } from "react";

/*─────────────────────────────────────────────
  MOCK DATA
─────────────────────────────────────────────*/
const OUTFITS = [
  { hat: "none", color: "#4A90D9", hair: "#3a2a1a", acc: "glasses" },
  { hat: "cap", color: "#E85D75", hair: "#8B4513", acc: "headphones" },
  { hat: "none", color: "#50B86C", hair: "#1a1a2e", acc: null },
  { hat: "beanie", color: "#D4A843", hair: "#C4A265", acc: "glasses" },
  { hat: "none", color: "#9B6DFF", hair: "#2a1a1a", acc: "headphones" },
  { hat: "cap", color: "#FF8C42", hair: "#5a3a1a", acc: null },
];
const TERM_LINES = [
  ["$ claude --model opus", "Reading files...", "✓ 47 files loaded"],
  ["Editing src/auth.ts", "Applied 3 changes", "Running tests..."],
  ["$ npm run build", "compiled ok", "✓ Build done"],
  ["Analyzing codebase...", "Found 12 patterns", "Refactoring..."],
  ["$ git diff --stat", "5 files changed", "+142 -38"],
  ["Writing tests...", "12 cases added", "All passing ✓"],
];
const TASKS = ["Refactoring auth", "API endpoints", "Test coverage", "DB migrations", "UI components", "Bug fix #234"];
const CWDS = ["~/proj/api", "~/proj/web", "~/proj/core", "~/proj/db", "~/proj/ui", "~/proj/test"];
const INIT_STATES = ["working", "waiting", "idle", "error", "working", "working"];
const ACTS = ["editing src/auth.ts", "running tests", "npm install", "git commit", "reading files", "writing docs"];

const FULL_TERM = [
  { t: "❯ claude --model opus --project ./src", s: { color: "#50B86C", fontWeight: "bold" } },
  { t: "" },
  { t: "  ╭──────────────────────────────────────╮", s: { opacity: 0.5 } },
  { t: "  │  Claude Code v1.42.0                 │", s: { opacity: 0.5 } },
  { t: "  │  Model: claude-opus-4-6              │", s: { opacity: 0.5 } },
  { t: "  │  Project: ~/proj/api/src             │", s: { opacity: 0.5 } },
  { t: "  ╰──────────────────────────────────────╯", s: { opacity: 0.5 } },
  { t: "" },
  { t: "● Reading project structure...", s: { color: "#45B7D1" } },
  { t: "  Found 47 files across 12 directories" },
  { t: "" },
  { t: "● Analyzing src/auth/middleware.ts", s: { color: "#45B7D1" } },
  { t: "  ⚠ Deprecated: jwt.verify() callback", s: { color: "#D4A843" } },
  { t: "  ✓ Refactored to async/await", s: { color: "#50B86C" } },
  { t: "" },
  { t: "● Editing src/auth/middleware.ts", s: { color: "#45B7D1" } },
  { t: "  -  jwt.verify(token, secret, (err, decoded) => {", s: { opacity: 0.5 } },
  { t: "  +  const decoded = await jwt.verify(token, secret);", s: { color: "#50B86C" } },
  { t: "" },
  { t: "  ✓ Applied 3 changes to middleware.ts", s: { color: "#50B86C" } },
  { t: "" },
  { t: "● Running affected tests...", s: { color: "#45B7D1" } },
  { t: "  ✓ auth.middleware.test.ts (8 passed)", s: { color: "#50B86C" } },
  { t: "  ✓ auth.session.test.ts (5 passed)", s: { color: "#50B86C" } },
  { t: "  ✓ auth.integration.test.ts (3 passed)", s: { color: "#50B86C" } },
  { t: "" },
  { t: "16/16 tests passing | 3 files analyzed", s: { color: "#50B86C", fontWeight: "bold" } },
  { t: "" },
  { t: "? Continue with remaining auth files?", s: { color: "#D4A843", fontWeight: "bold" } },
];

function mkAgents(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i}`, name: `Agent ${i + 1}`, desk: i,
    outfit: OUTFITS[i], cwd: CWDS[i], taskLabel: TASKS[i],
    state: INIT_STATES[i], termLines: TERM_LINES[i], lastAct: ACTS[i],
  }));
}

/*─────────────────────────────────────────────
  ISOMETRIC GRID — positions for desks
  Arranged in two columns of 4 rows
─────────────────────────────────────────────*/
const DESK_SLOTS = [
  { row: 0, col: 0 }, { row: 0, col: 1 },
  { row: 1, col: 0 }, { row: 1, col: 1 },
  { row: 2, col: 0 }, { row: 2, col: 1 },
  { row: 3, col: 0 }, { row: 3, col: 1 },
];

function isoXY(row, col) {
  const tw = 240, th = 140;
  return {
    x: (col - row) * (tw / 2),
    y: (col + row) * (th / 2),
  };
}

/*─────────────────────────────────────────────
  ISOMETRIC FLOOR TILES (SVG)
─────────────────────────────────────────────*/
function Floor() {
  const tiles = [];
  for (let r = -1; r < 6; r++) {
    for (let c = -1; c < 5; c++) {
      const tw = 120, th = 60;
      const x = (c - r) * (tw / 2);
      const y = (c + r) * (th / 2);
      const light = (r + c) % 2 === 0;
      tiles.push(
        <path key={`${r}-${c}`}
          d={`M${x} ${y + th / 2} L${x + tw / 2} ${y} L${x + tw} ${y + th / 2} L${x + tw / 2} ${y + th} Z`}
          fill={light ? "#181e2e" : "#151b28"}
          stroke="rgba(255,255,255,0.018)"
          strokeWidth="0.5"
        />
      );
    }
  }
  return (
    <svg style={{ position: "absolute", left: "50%", top: "46%", transform: "translate(-50%,-50%)", pointerEvents: "none" }}
      width="900" height="600" viewBox="-360 -60 900 600" overflow="visible">
      {tiles}
    </svg>
  );
}

/*─────────────────────────────────────────────
  WALL SEGMENTS (back walls of the room)
─────────────────────────────────────────────*/
function Walls() {
  return (
    <svg style={{ position: "absolute", left: "50%", top: "46%", transform: "translate(-50%,-50%)", pointerEvents: "none" }}
      width="900" height="600" viewBox="-360 -60 900 600" overflow="visible">
      {/* Left wall */}
      <path d="M-340 200 L-340 -40 L120 -200 L120 40 Z" fill="#111825" stroke="rgba(255,255,255,0.025)" strokeWidth="0.5" />
      {/* Right wall */}
      <path d="M120 -200 L120 40 L580 200 L580 -40 Z" fill="#0f1520" stroke="rgba(255,255,255,0.025)" strokeWidth="0.5" />

      {/* Wall decorations — posters / whiteboard */}
      {/* Whiteboard on left wall */}
      <path d="M-100 30 L40 -40 L40 -110 L-100 -40 Z" fill="#1a2236" stroke="rgba(255,255,255,0.05)" strokeWidth="0.8" />
      <path d="M-90 25 L30 -40 L30 -100 L-90 -35 Z" fill="#1e2840" />
      {/* Whiteboard scribbles */}
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

/*─────────────────────────────────────────────
  FURNITURE SPRITE — isometric desk
─────────────────────────────────────────────*/
function DeskSprite({ state }) {
  const glow = { working: "#50B86C", waiting: "#F5A623", error: "#E85D75", idle: "#223" }[state] || "#223";
  const on = state !== "idle";

  return (
    <svg width="180" height="140" viewBox="0 0 180 140" overflow="visible">
      {/* === CHAIR === */}
      {/* Seat */}
      <path d="M56 95 L90 110 L124 95 L90 80 Z" fill="#2a2a3a" />
      {/* Chair back */}
      <path d="M56 95 L56 72 L90 57 L90 80 Z" fill="#333345" stroke="#2a2a3a" strokeWidth="0.5" />
      {/* Chair wheels/base */}
      <ellipse cx="90" cy="112" rx="20" ry="5" fill="#222" opacity="0.4" />
      <line x1="72" y1="112" x2="72" y2="116" stroke="#333" strokeWidth="1.5" />
      <line x1="108" y1="112" x2="108" y2="116" stroke="#333" strokeWidth="1.5" />
      <line x1="90" y1="114" x2="90" y2="118" stroke="#333" strokeWidth="1.5" />

      {/* === DESK === */}
      {/* Desktop surface */}
      <path d="M20 62 L90 28 L160 62 L90 96 Z" fill="#5C4C38" />
      <path d="M20 62 L90 96 L90 104 L20 70 Z" fill="#4A3C2A" />
      <path d="M90 96 L160 62 L160 70 L90 104 Z" fill="#3E3220" />

      {/* Front panel */}
      <path d="M40 72 L90 96 L140 72 L140 92 L90 116 L40 92 Z" fill="#3a2e20" />
      <path d="M40 72 L90 96 L90 116 L40 92 Z" fill="#352a1c" />

      {/* === MONITOR === */}
      {/* Monitor back/frame */}
      <path d="M64 16 L110 36 L110 62 L64 42 Z" fill="#222233" stroke="#1a1a28" strokeWidth="0.8" />
      {/* Screen */}
      <path d="M66 18 L108 37 L108 60 L66 41 Z" fill={on ? "#0d1117" : "#141820"} />
      {/* Screen glow */}
      {on && <path d="M66 18 L108 37 L108 60 L66 41 Z" fill={glow} opacity="0.06">
        <animate attributeName="opacity" values="0.04;0.1;0.04" dur="3s" repeatCount="indefinite" />
      </path>}
      {/* Screen scan line effect */}
      {on && <path d="M66 30 L108 48" stroke={glow} strokeWidth="0.3" opacity="0.15">
        <animate attributeName="d" values="M66 18 L108 37;M66 41 L108 60;M66 18 L108 37" dur="4s" repeatCount="indefinite" />
      </path>}
      {/* Monitor stand */}
      <line x1="87" y1="56" x2="87" y2="68" stroke="#222233" strokeWidth="3" />
      <path d="M78 68 L96 68 L92 72 L82 72 Z" fill="#222233" />

      {/* === DESK ITEMS === */}
      {/* Keyboard */}
      <path d="M60 66 L87 79 L114 66 L87 53 Z" fill="#2a2a2a" stroke="#333" strokeWidth="0.4" />
      {/* Key rows */}
      <path d="M68 64 L87 73 L106 64" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />
      <path d="M70 66 L87 74 L104 66" stroke="#3a3a3a" strokeWidth="0.3" fill="none" />

      {/* Coffee mug */}
      <g>
        <ellipse cx="140" cy="55" rx="6" ry="3" fill="#7B5B14" />
        <path d="M134 55 L134 48 L146 48 L146 55" fill="none" stroke="#7B5B14" strokeWidth="1.5" />
        <path d="M146 50 Q151 50 151 53 Q151 56 146 55" fill="none" stroke="#7B5B14" strokeWidth="0.8" />
        {on && <>
          <path d="M138 46 Q136 40 140 36" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8">
            <animate attributeName="d" values="M138 46 Q136 40 140 36;M138 46 Q140 38 137 33;M138 46 Q136 40 140 36" dur="2.5s" repeatCount="indefinite" />
          </path>
        </>}
      </g>

      {/* Small plant */}
      <g transform="translate(32, 42)">
        <rect x="-3" y="0" width="6" height="7" rx="1" fill="#5a4a35" />
        <path d="M0 0 Q-6 -8 -2 -14" stroke="#3a7a3a" fill="none" strokeWidth="1.5" />
        <path d="M0 -2 Q4 -10 8 -12" stroke="#4a8a4a" fill="none" strokeWidth="1.2" />
        <path d="M0 -1 Q-3 -6 1 -10" stroke="#3a7a3a" fill="none" strokeWidth="1" />
      </g>

      {/* Shadow under desk */}
      <ellipse cx="90" cy="108" rx="60" ry="12" fill="rgba(0,0,0,0.15)" />
    </svg>
  );
}

/*─────────────────────────────────────────────
  CHARACTER — isometric pixel person
─────────────────────────────────────────────*/
function Character({ state, outfit }) {
  const skin = "#FFD5B8";
  const bc = outfit.color;
  const hair = outfit.hair;

  const wrap = (children, anim = {}) => (
    <svg width="52" height="68" viewBox="0 0 52 68" overflow="visible" style={{ filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.35))", ...anim }}>{children}</svg>
  );

  if (state === "idle") {
    return wrap(<>
      <ellipse cx="26" cy="44" rx="11" ry="7" fill={bc} />
      <ellipse cx="26" cy="37" rx="10" ry="9" fill={skin} />
      <ellipse cx="26" cy="31" rx="10" ry="5.5" fill={hair} />
      {outfit.acc === "glasses" && <rect x="18" y="37" width="5" height="3" rx="1" fill="#555" opacity="0.5" />}
      <g><text x="38" y="28" fontSize="10" fill="rgba(200,220,255,0.35)" fontFamily="monospace"><animate attributeName="y" values="28;23;28" dur="2s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.3;0.7;0.3" dur="2s" repeatCount="indefinite" />z</text><text x="43" y="20" fontSize="8" fill="rgba(200,220,255,0.25)" fontFamily="monospace"><animate attributeName="y" values="20;15;20" dur="2.5s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.2;0.5;0.2" dur="2.5s" repeatCount="indefinite" />z</text></g>
    </>);
  }

  if (state === "error") {
    return wrap(<>
      <rect x="16" y="36" width="20" height="16" fill={bc} rx="3" />
      <rect x="5" y="28" width="7" height="4" fill={skin} rx="2" transform="rotate(-25 8 30)" />
      <rect x="40" y="28" width="7" height="4" fill={skin} rx="2" transform="rotate(25 43 30)" />
      <ellipse cx="26" cy="25" rx="10" ry="10" fill={skin} />
      <ellipse cx="26" cy="18" rx="10" ry="5.5" fill={hair} />
      {outfit.hat === "cap" && <><path d="M15 20 Q26 12 37 20" fill={bc} /><rect x="11" y="19" width="15" height="3" fill={bc} rx="1" /></>}
      {outfit.hat === "beanie" && <ellipse cx="26" cy="16" rx="11" ry="6.5" fill={bc} />}
      <g stroke="#c33" strokeWidth="1.5" strokeLinecap="round"><line x1="20" y1="22" x2="23" y2="26" /><line x1="23" y1="22" x2="20" y2="26" /><line x1="29" y1="22" x2="32" y2="26" /><line x1="32" y1="22" x2="29" y2="26" /></g>
      <path d="M22 31 Q24 29 26 31 Q28 33 30 31" stroke="#c33" fill="none" strokeWidth="0.8" />
      <g><circle cx="42" cy="10" r="8" fill="#E85D75"><animate attributeName="r" values="8;9;8" dur="1s" repeatCount="indefinite" /></circle><text x="39" y="14" fontSize="11" fill="white" fontWeight="bold">!</text></g>
      <rect x="18" y="52" width="6" height="10" fill="#444" rx="2" />
      <rect x="28" y="52" width="6" height="10" fill="#444" rx="2" />
    </>, { animation: "errShake 0.4s ease-in-out infinite" });
  }

  if (state === "waiting") {
    return wrap(<>
      <rect x="16" y="36" width="20" height="16" fill={bc} rx="3" />
      <g><rect x="38" y="20" width="7" height="10" fill={skin} rx="2"><animate attributeName="transform" values="rotate(-5 41 25);rotate(12 41 25);rotate(-5 41 25)" dur="0.8s" repeatCount="indefinite" /></rect><circle cx="41" cy="17" r="5.5" fill={skin}><animate attributeName="cy" values="17;15;17" dur="0.8s" repeatCount="indefinite" /></circle></g>
      <rect x="7" y="40" width="7" height="4" fill={skin} rx="2" />
      <ellipse cx="26" cy="25" rx="10" ry="10" fill={skin} />
      <ellipse cx="26" cy="18" rx="10" ry="5.5" fill={hair} />
      {outfit.hat === "cap" && <><path d="M15 20 Q26 12 37 20" fill={bc} /><rect x="11" y="19" width="15" height="3" fill={bc} rx="1" /></>}
      {outfit.hat === "beanie" && <ellipse cx="26" cy="16" rx="11" ry="6.5" fill={bc} />}
      {outfit.acc === "glasses" && <><circle cx="22" cy="25" r="4" stroke="#666" fill="none" strokeWidth="0.8" /><circle cx="30" cy="25" r="4" stroke="#666" fill="none" strokeWidth="0.8" /></>}
      {outfit.acc === "headphones" && <path d="M14 20 Q14 9 26 9 Q38 9 38 20" stroke="#555" fill="none" strokeWidth="3" />}
      <circle cx="22" cy="26" r="1.8" fill="#333" /><circle cx="30" cy="26" r="1.8" fill="#333" />
      <circle cx="22.5" cy="25.5" r="0.6" fill="white" /><circle cx="30.5" cy="25.5" r="0.6" fill="white" />
      <path d="M23 30 Q26 32 29 30" stroke="#333" fill="none" strokeWidth="0.8" />
      <g><rect x="0" y="4" width="14" height="13" rx="5" fill="#F5A623" opacity="0.9"><animate attributeName="opacity" values="0.9;0.55;0.9" dur="2s" repeatCount="indefinite" /></rect><text x="4" y="14" fontSize="10" fill="white" fontWeight="bold">?</text></g>
      <rect x="18" y="52" width="6" height="10" fill="#444" rx="2" /><rect x="28" y="52" width="6" height="10" fill="#444" rx="2" />
    </>, { animation: "waitBounce 2s ease-in-out infinite" });
  }

  // working / starting
  return wrap(<>
    <rect x="16" y="36" width="20" height="16" fill={bc} rx="3" />
    <g><rect x="7" y="42" width="8" height="4" fill={skin} rx="2"><animate attributeName="y" values="42;41;42" dur="0.3s" repeatCount="indefinite" /></rect><rect x="37" y="42" width="8" height="4" fill={skin} rx="2"><animate attributeName="y" values="42;43;42" dur="0.3s" repeatCount="indefinite" /></rect></g>
    <ellipse cx="26" cy="25" rx="10" ry="10" fill={skin} />
    <ellipse cx="26" cy="18" rx="10" ry="5.5" fill={hair} />
    {outfit.hat === "cap" && <><path d="M15 20 Q26 12 37 20" fill={bc} /><rect x="28" y="19" width="15" height="3" fill={bc} rx="1" /></>}
    {outfit.hat === "beanie" && <ellipse cx="26" cy="16" rx="11" ry="6.5" fill={bc} />}
    {outfit.acc === "glasses" && <><circle cx="22" cy="25" r="4" stroke="#666" fill="none" strokeWidth="0.8" /><circle cx="30" cy="25" r="4" stroke="#666" fill="none" strokeWidth="0.8" /><line x1="26" y1="25" x2="26" y2="25" stroke="#666" strokeWidth="0.8" /></>}
    {outfit.acc === "headphones" && <path d="M14 20 Q14 9 26 9 Q38 9 38 20" stroke="#555" fill="none" strokeWidth="3" />}
    <circle cx="22" cy="26" r="1.5" fill="#333" /><circle cx="30" cy="26" r="1.5" fill="#333" />
    <rect x="18" y="52" width="6" height="10" fill="#444" rx="2" /><rect x="28" y="52" width="6" height="10" fill="#444" rx="2" />
  </>);
}

/*─────────────────────────────────────────────
  STATUS LIGHT
─────────────────────────────────────────────*/
function StatusLight({ state, size = 10 }) {
  const c = { working: "#50B86C", waiting: "#F5A623", idle: "#5a6f8f", error: "#E85D75", starting: "#9B6DFF" }[state] || "#5a6f8f";
  const pulse = state !== "idle";
  return (
    <span style={{ position: "relative", display: "inline-flex", width: size, height: size }}>
      {pulse && <span style={{ position: "absolute", inset: -3, borderRadius: "50%", background: c, opacity: 0.3, animation: "dotPulse 2s ease-in-out infinite" }} />}
      <span style={{ width: size, height: size, borderRadius: "50%", background: c, boxShadow: `0 0 ${size}px ${c}` }} />
    </span>
  );
}

/*─────────────────────────────────────────────
  DESK UNIT (furniture + character + HUD)
─────────────────────────────────────────────*/
function DeskUnit({ agent, pos, onClick, onCtx }) {
  const [hov, setHov] = useState(false);
  const { x, y } = isoXY(pos.row, pos.col);
  const z = (pos.row * 2 + pos.col + 1) * 10;

  return (
    <div
      onClick={() => onClick(agent)}
      onContextMenu={e => { e.preventDefault(); onCtx(e, agent); }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        position: "absolute",
        left: `calc(50% + ${x}px - 90px)`,
        top: `${y + 50}px`,
        width: 180,
        cursor: "pointer",
        zIndex: z,
        transition: "filter 0.25s, transform 0.25s",
        filter: hov ? "brightness(1.2) drop-shadow(0 0 30px rgba(126,184,255,0.15))" : "brightness(1)",
        transform: hov ? "translateY(-5px)" : "translateY(0)",
      }}
    >
      {/* Shadow on floor */}
      <div style={{ position: "absolute", bottom: -2, left: "50%", transform: "translateX(-50%)", width: 120, height: 20, background: "radial-gradient(ellipse,rgba(0,0,0,0.2),transparent)", borderRadius: "50%", zIndex: 0 }} />

      {/* Character sits behind desk */}
      <div style={{ position: "absolute", left: 64, top: -28, zIndex: 1 }}>
        <Character state={agent.state} outfit={agent.outfit} />
      </div>

      {/* Desk */}
      <div style={{ position: "relative", zIndex: 2 }}>
        <DeskSprite state={agent.state} />
      </div>

      {/* Floating nametag — always visible */}
      <div style={{
        position: "absolute", top: -48, left: "50%", transform: "translateX(-50%)",
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 10px 3px 7px",
        background: "rgba(10,14,25,0.88)", backdropFilter: "blur(10px)",
        borderRadius: 20, border: "1px solid rgba(255,255,255,0.07)",
        whiteSpace: "nowrap", zIndex: 100,
        opacity: hov ? 1 : 0.8, transition: "opacity 0.2s",
      }}>
        <StatusLight state={agent.state} size={8} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "#e0e8f5", letterSpacing: "-0.01em" }}>{agent.name}</span>
      </div>

      {/* Expanded tooltip on hover */}
      {hov && (
        <div style={{
          position: "absolute", top: -105, left: "50%", transform: "translateX(-50%)",
          padding: "10px 14px", background: "rgba(10,14,25,0.94)", backdropFilter: "blur(14px)",
          borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)",
          whiteSpace: "nowrap", zIndex: 200, animation: "hudIn 0.12s ease-out",
          minWidth: 190, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#7eb8ff", marginBottom: 3 }}>{agent.taskLabel}</div>
          <div style={{ fontSize: 10, color: "#8a9ab8", fontFamily: "'JetBrains Mono',monospace" }}>📁 {agent.cwd}</div>
          <div style={{ fontSize: 10, color: "#8a9ab8", marginTop: 2 }}>⚡ {agent.lastAct}</div>
          <div style={{ marginTop: 6, padding: "4px 6px", background: "rgba(0,0,0,0.3)", borderRadius: 6 }}>
            {agent.termLines.slice(-2).map((l, i) => (
              <div key={i} style={{ fontSize: 9, color: "#5e7090", fontFamily: "'JetBrains Mono',monospace", lineHeight: 1.4 }}>{l}</div>
            ))}
          </div>
          {/* Arrow */}
          <div style={{ position: "absolute", bottom: -5, left: "50%", transform: "translateX(-50%) rotate(45deg)", width: 10, height: 10, background: "rgba(10,14,25,0.94)", borderRight: "1px solid rgba(255,255,255,0.08)", borderBottom: "1px solid rgba(255,255,255,0.08)" }} />
        </div>
      )}
    </div>
  );
}

/*─────────────────────────────────────────────
  EMPTY SLOT
─────────────────────────────────────────────*/
function EmptySlot({ pos, index, onClick }) {
  const [hov, setHov] = useState(false);
  const { x, y } = isoXY(pos.row, pos.col);
  return (
    <div onClick={() => onClick(index)} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ position: "absolute", left: `calc(50% + ${x}px - 90px)`, top: `${y + 50}px`, width: 180, height: 140, cursor: "pointer", zIndex: (pos.row * 2 + pos.col + 1) * 10 }}>
      <svg width="180" height="140" viewBox="0 0 180 140" overflow="visible" style={{ opacity: hov ? 0.7 : 0.18, transition: "opacity 0.3s" }}>
        <path d="M20 62 L90 28 L160 62 L90 96 Z" fill="none" stroke={hov ? "#7eb8ff" : "#5a6f8f"} strokeWidth="1.5" strokeDasharray="8 5" />
      </svg>
      {hov && (
        <div style={{ position: "absolute", top: 40, left: "50%", transform: "translateX(-50%)", textAlign: "center", animation: "hudIn 0.12s ease-out" }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid #7eb8ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color: "#7eb8ff", margin: "0 auto 6px", background: "rgba(126,184,255,0.06)" }}>+</div>
          <div style={{ fontSize: 11, color: "#7eb8ff", fontWeight: 500 }}>New Agent</div>
        </div>
      )}
    </div>
  );
}

/*─────────────────────────────────────────────
  ROOM PROPS (decorative objects in the scene)
─────────────────────────────────────────────*/
function RoomProps() {
  return <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
    {/* Potted plant (left side) */}
    <div style={{ position: "absolute", left: "7%", bottom: "18%", opacity: 0.8 }}>
      <svg width="40" height="60" viewBox="0 0 40 60" overflow="visible">
        <rect x="12" y="35" width="16" height="20" rx="3" fill="#5a4a35" />
        <ellipse cx="20" cy="35" rx="10" ry="4" fill="#6a5a45" />
        <path d="M20 35 Q10 15 16 5" stroke="#3a8a3a" fill="none" strokeWidth="2" />
        <path d="M20 35 Q28 18 32 8" stroke="#4a9a4a" fill="none" strokeWidth="1.8" />
        <path d="M20 35 Q15 20 22 10" stroke="#3a7a3a" fill="none" strokeWidth="1.5" />
        <ellipse cx="16" cy="5" rx="5" ry="4" fill="#3a8a3a" opacity="0.7" />
        <ellipse cx="32" cy="8" rx="4" ry="3" fill="#4a9a4a" opacity="0.7" />
        <ellipse cx="22" cy="10" rx="4" ry="3.5" fill="#3a7a3a" opacity="0.6" />
      </svg>
    </div>
    {/* Water cooler (right side) */}
    <div style={{ position: "absolute", right: "8%", top: "38%", opacity: 0.6 }}>
      <svg width="30" height="56" viewBox="0 0 30 56">
        <rect x="6" y="20" width="18" height="30" rx="2" fill="#2a3548" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
        <rect x="10" y="8" width="10" height="14" rx="2" fill="#3a5070" opacity="0.6" />
        <ellipse cx="15" cy="8" rx="6" ry="2" fill="#3a5070" opacity="0.5" />
        <circle cx="12" cy="38" r="2" fill="#4a90d9" opacity="0.4" />
        <circle cx="18" cy="38" r="2" fill="#e85d75" opacity="0.4" />
        <rect x="8" y="50" width="14" height="4" rx="1" fill="#222d3a" />
      </svg>
    </div>
  </div>;
}

/*─────────────────────────────────────────────
  TERMINAL VIEW
─────────────────────────────────────────────*/
function TerminalView({ agent, onBack }) {
  const ref = useRef(null);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState([]);

  useEffect(() => {
    let i = 0;
    const iv = setInterval(() => { if (i < FULL_TERM.length) { setLines(p => [...p, FULL_TERM[i]]); i++; } else clearInterval(iv); }, 35);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0a0e16", animation: "termEnter 0.3s ease-out" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 48, background: "rgba(15,20,32,0.95)", borderBottom: "1px solid rgba(255,255,255,0.05)", flexShrink: 0 }}>
        <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.03)", color: "#8a9ab8", fontFamily: "'DM Sans',sans-serif", fontSize: 13, cursor: "pointer" }}>← Back to Office</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <StatusLight state={agent.state} size={8} />
          <span style={{ fontWeight: 600 }}>{agent.name}</span>
          <span style={{ color: "#3a4a6a" }}>·</span>
          <span style={{ color: "#7eb8ff" }}>{agent.taskLabel}</span>
          <span style={{ color: "#3a4a6a" }}>·</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "#5a6f8f", fontSize: 12 }}>{agent.cwd}</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {["↻", "✕"].map((ic, i) => <button key={i} style={{ width: 32, height: 32, borderRadius: 6, border: "1px solid rgba(255,255,255,0.06)", background: "transparent", color: "#8a9ab8", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic}</button>)}
        </div>
      </div>
      <div ref={ref} style={{ flex: 1, overflowY: "auto", padding: "16px 24px", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, lineHeight: 1.7, color: "#c0c8d8" }}>
        {lines.map((l, i) => <div key={i} style={{ whiteSpace: "pre", minHeight: "1.7em", ...(l.s || {}) }}>{l.t}</div>)}
        <div style={{ display: "flex", alignItems: "center", marginTop: 8 }}>
          <span style={{ color: "#50B86C", fontWeight: 600 }}>❯ </span>
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && input.trim()) { setLines(p => [...p, { t: `❯ ${input}`, s: { color: "#50B86C", fontWeight: "bold" } }, { t: "Processing..." }]); setInput(""); } }}
            placeholder="Type a message to the agent..." autoFocus
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#c0c8d8", fontFamily: "inherit", fontSize: 13, caretColor: "#50B86C" }} />
        </div>
      </div>
    </div>
  );
}

/*─────────────────────────────────────────────
  CONTEXT MENU
─────────────────────────────────────────────*/
function CtxMenu({ x, y, agent, onClose, onAction }) {
  const ref = useRef(null);
  useEffect(() => { const h = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, [onClose]);
  const I = ({ icon, label, danger, action }) => (
    <button onClick={() => onAction(action)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", border: "none", background: "transparent", color: danger ? "#E85D75" : "#8a9ab8", fontFamily: "'DM Sans',sans-serif", fontSize: 13, borderRadius: 6, cursor: "pointer", textAlign: "left" }}
      onMouseEnter={e => e.currentTarget.style.background = danger ? "rgba(232,93,117,0.08)" : "rgba(255,255,255,0.04)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {icon} {label}
    </button>
  );
  return (
    <div ref={ref} style={{ position: "fixed", left: x, top: y, zIndex: 1000, background: "rgba(10,14,25,0.95)", backdropFilter: "blur(16px)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 5, minWidth: 180, boxShadow: "0 12px 40px rgba(0,0,0,0.5)", animation: "hudIn 0.12s ease-out" }}>
      <div style={{ padding: "5px 10px", fontSize: 10, fontWeight: 600, color: "#4a5a7a", textTransform: "uppercase", letterSpacing: "0.06em" }}>{agent.name}</div>
      <I icon="✏️" label="Rename" action="rename" />
      <I icon="🏷️" label="Change Task" action="label" />
      <I icon="🔄" label="Restart" action="restart" />
      <I icon="📂" label="Open Folder" action="folder" />
      <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "3px 8px" }} />
      <I icon="🗑️" label="Kill Agent" danger action="kill" />
    </div>
  );
}

/*─────────────────────────────────────────────
  SPAWN DIALOG
─────────────────────────────────────────────*/
function SpawnDlg({ idx, onClose, onCreate }) {
  const [n, setN] = useState("");
  const [c, setC] = useState("~/projects/");
  const [t, setT] = useState("");
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(10px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "rgba(14,20,35,0.96)", backdropFilter: "blur(16px)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "24px 28px", width: 360, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", animation: "hudIn 0.2s ease-out" }}>
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "#e0e8f5" }}>Spawn New Agent</h3>
        <p style={{ fontSize: 12, color: "#4a5a7a", margin: "2px 0 18px" }}>Desk #{idx + 1}</p>
        {[
          { l: "Name", v: n, s: setN, p: "e.g. Agent 9" },
          { l: "Working Dir", v: c, s: setC, p: "~/projects/my-app" },
          { l: "Task", v: t, s: setT, p: "e.g. Refactoring auth" },
        ].map(f => (
          <div key={f.l}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6a7a9a", marginBottom: 5, marginTop: 12 }}>{f.l}</label>
            <input value={f.v} onChange={e => f.s(e.target.value)} placeholder={f.p} style={{ width: "100%", padding: "9px 12px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, color: "#e0e8f5", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)", background: "transparent", color: "#8a9ab8", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Cancel</button>
          <button onClick={() => { onCreate({ name: n || `Agent ${idx + 1}`, cwd: c, task: t }); onClose(); }} style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: "#7eb8ff", color: "#0a0e16", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>Spawn</button>
        </div>
      </div>
    </div>
  );
}

/*─────────────────────────────────────────────
  MAIN APP
─────────────────────────────────────────────*/
export default function App() {
  const [agents, setAgents] = useState(() => mkAgents(6));
  const [focused, setFocused] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [spawn, setSpawn] = useState(null);
  const [toast, setToast] = useState(true);

  useEffect(() => {
    const iv = setInterval(() => {
      setAgents(p => p.map(a => Math.random() < 0.025 ? { ...a, state: ["working", "waiting", "idle"][Math.floor(Math.random() * 3)] } : a));
    }, 3000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(false), 6000); return () => clearTimeout(t); } }, [toast]);

  const waiting = agents.find(a => a.state === "waiting");
  const counts = { w: agents.filter(a => a.state === "working").length, q: agents.filter(a => a.state === "waiting").length, i: agents.filter(a => a.state === "idle").length, e: agents.filter(a => a.state === "error").length };

  if (focused) return <><style>{CSS}</style><TerminalView agent={focused} onBack={() => setFocused(null)} /></>;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "#0a0e16", color: "#e0e8f5", fontFamily: "'DM Sans',sans-serif" }}>
      <style>{CSS}</style>

      {/* HUD bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", height: 44, background: "rgba(10,14,22,0.7)", backdropFilter: "blur(16px)", borderBottom: "1px solid rgba(255,255,255,0.03)", flexShrink: 0, zIndex: 500 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontSize: 18 }}>🏢</span>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>The Office</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, padding: "2px 7px", borderRadius: 20, background: "rgba(126,184,255,0.08)", color: "#7eb8ff", letterSpacing: "0.05em" }}>CLAUDE CODE</span>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {[
            { n: counts.w, c: "#50B86C", l: "working" },
            { n: counts.q, c: "#F5A623", l: "waiting" },
            { n: counts.e, c: "#E85D75", l: "error" },
            { n: counts.i, c: "#5a6f8f", l: "idle" },
          ].filter(s => s.n > 0).map(s => (
            <div key={s.l} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 600, color: s.c, fontFamily: "'JetBrains Mono',monospace", letterSpacing: "0.02em" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.c, boxShadow: `0 0 6px ${s.c}` }} />
              {s.n} {s.l}
            </div>
          ))}
        </div>
        <div style={{ width: 80 }} />
      </div>

      {/* The Office Scene */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Ambient gradients */}
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 30%, rgba(126,184,255,0.025) 0%, transparent 50%), radial-gradient(ellipse at 25% 65%, rgba(80,184,108,0.015) 0%, transparent 35%), radial-gradient(ellipse at 75% 65%, rgba(245,166,35,0.01) 0%, transparent 35%)" }} />

        <Walls />
        <Floor />
        <RoomProps />

        {/* Desks + Characters */}
        <div style={{ position: "absolute", inset: 0 }}>
          {Array.from({ length: 8 }, (_, i) => {
            const pos = DESK_SLOTS[i];
            const ag = agents.find(a => a.desk === i);
            if (ag) return <DeskUnit key={ag.id} agent={ag} pos={pos} onClick={a => { setCtx(null); setFocused(a); }} onCtx={(e, a) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, agent: a }); }} />;
            return <EmptySlot key={`e${i}`} pos={pos} index={i} onClick={idx => setSpawn(idx)} />;
          })}
        </div>

        {/* Vignette */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", boxShadow: "inset 0 0 120px rgba(0,0,0,0.4)" }} />
      </div>

      {/* Bottom HUD */}
      <div style={{ padding: "6px 20px", background: "rgba(10,14,22,0.5)", backdropFilter: "blur(8px)", borderTop: "1px solid rgba(255,255,255,0.02)", display: "flex", justifyContent: "center", gap: 20, zIndex: 500 }}>
        {["CLICK → terminal", "RIGHT-CLICK → actions", "ESC → back"].map((h, i) => (
          <span key={i} style={{ fontSize: 9, color: "#3a4a68", fontFamily: "'JetBrains Mono',monospace", letterSpacing: "0.04em" }}>{h}</span>
        ))}
      </div>

      {/* Toast */}
      {toast && waiting && (
        <div onClick={() => { setFocused(waiting); setToast(false); }} style={{ position: "fixed", bottom: 48, right: 20, zIndex: 800, cursor: "pointer", animation: "toastSlide 0.4s cubic-bezier(0.16,1,0.3,1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "rgba(10,14,25,0.93)", backdropFilter: "blur(14px)", border: "1px solid rgba(245,166,35,0.15)", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.4), 0 0 24px rgba(245,166,35,0.08)" }}>
            <StatusLight state="waiting" size={9} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{waiting.name} needs input</div>
              <div style={{ fontSize: 10, color: "#4a5a7a", marginTop: 1 }}>{waiting.taskLabel}</div>
            </div>
          </div>
        </div>
      )}

      {ctx && <CtxMenu x={ctx.x} y={ctx.y} agent={ctx.agent} onClose={() => setCtx(null)} onAction={a => { if (a === "kill") setAgents(p => p.filter(ag => ag.id !== ctx.agent.id)); setCtx(null); }} />}
      {spawn !== null && <SpawnDlg idx={spawn} onClose={() => setSpawn(null)} onCreate={({ name, cwd, task }) => { setAgents(p => [...p, { id: `a${Date.now()}`, name, desk: spawn, outfit: OUTFITS[agents.length % OUTFITS.length], cwd, taskLabel: task || "New task", state: "starting", termLines: ["Spawning...", "Connecting...", "Ready."], lastAct: "starting up" }]); setTimeout(() => setAgents(p => p.map(a => a.state === "starting" ? { ...a, state: "working" } : a)), 2000); }} />}
    </div>
  );
}

/*─────────────────────────────────────────────
  CSS
─────────────────────────────────────────────*/
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0e16; overflow:hidden; }
  ::-webkit-scrollbar { width:6px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.06); border-radius:3px; }

  @keyframes waitBounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
  @keyframes errShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-2px)} 75%{transform:translateX(2px)} }
  @keyframes dotPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(1.5)} }
  @keyframes termEnter { from{opacity:0} to{opacity:1} }
  @keyframes hudIn { from{opacity:0;transform:translateY(4px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
  @keyframes toastSlide { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
`;
