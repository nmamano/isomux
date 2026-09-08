import { IsoBox, IsoCylinder, iso, poly, shade } from "./iso.tsx";
import { Leg } from "./props-seating.tsx";

// Tables, fireplaces, shelves, tanks and lamps.

export function TableRound() {
  const wood = "#a8784a";
  return (
    <g>
      <IsoCylinder r={9} h={2} color="#7a5634" gradId="lobby-tr-foot" />
      <IsoCylinder r={3} h={16} color="#8a6440" gradId="lobby-tr-stem" />
      <IsoCylinder r={24} h={3} z={16} color={wood} gradId="lobby-tr-top" />
      {/* Steaming mug and a magazine */}
      <g transform={`translate(${iso(6, -4, 19).join(" ")})`}>
        <ellipse cx="0" cy="0" rx="3.2" ry="1.6" fill="#f2ede4" />
        <path d="M-3.2 0 L-3.2 -5 A3.2 1.6 0 0 1 3.2 -5 L3.2 0 A3.2 1.6 0 0 1 -3.2 0" fill="#f2ede4" stroke="#c9c1b4" strokeWidth="0.4" />
        <ellipse cx="0" cy="-5" rx="3.2" ry="1.6" fill="#5a3a24" />
        <path d="M3.2 -3.5 q3 0 3 -1.2 q0 -1.4 -3 -1.4" fill="none" stroke="#e5ded2" strokeWidth="1" />
        <path d="M-1 -7 q1 -2 0 -4 M1.5 -7.5 q1 -2 0 -4" fill="none" stroke="#fff" strokeWidth="0.6" opacity="0.6">
          <animate attributeName="opacity" values="0.6;0.15;0.6" dur="2.4s" repeatCount="indefinite" />
        </path>
      </g>
      <path d={poly([[-14, 2, 19], [-2, 2, 19], [-2, 12, 19], [-14, 12, 19]])} fill="#e9e2d3" stroke="#b8b0a2" strokeWidth="0.4" />
      <path d={poly([[-13, 3, 19.3], [-3, 3, 19.3], [-3, 8, 19.3], [-13, 8, 19.3]])} fill="#6f9ac0" />
    </g>
  );
}

export function TableGlass() {
  const w = 52,
    d = 26;
  const legs: Array<[number, number]> = [
    [-w / 2 + 3, -d / 2 + 3],
    [w / 2 - 3, -d / 2 + 3],
    [-w / 2 + 3, d / 2 - 3],
    [w / 2 - 3, d / 2 - 3],
  ];
  return (
    <g>
      {legs.map(([a, b], i) => {
        const [x, y] = iso(a, b, 0);
        return <path key={i} d={`M${x - 1} ${y} L${x + 1} ${y} L${x + 1} ${y - 17} L${x - 1} ${y - 17} Z`} fill="#9aa2ab" />;
      })}
      {/* Lower shelf */}
      <path d={poly([[-w / 2 + 2, -d / 2 + 2, 6], [w / 2 - 2, -d / 2 + 2, 6], [w / 2 - 2, d / 2 - 2, 6], [-w / 2 + 2, d / 2 - 2, 6]])} fill="#8f6a44" stroke="#5a3f28" strokeWidth="0.4" />
      {/* Glass top with a light tint and a highlight streak */}
      <path d={poly([[-w / 2, -d / 2, 17], [w / 2, -d / 2, 17], [w / 2, d / 2, 17], [-w / 2, d / 2, 17]])} fill="#bfe3ea" fillOpacity="0.55" stroke="#dff5f8" strokeWidth="0.8" />
      <path d={poly([[-w / 2, -d / 2, 15.5], [w / 2, -d / 2, 15.5], [w / 2, d / 2, 15.5], [-w / 2, d / 2, 15.5]])} fill="none" stroke="#7fb9c4" strokeWidth="0.6" />
      <path d={`M${iso(-w / 2 + 6, -d / 2 + 4, 17.2).join(" ")} L${iso(-w / 2 + 22, -d / 2 + 4, 17.2).join(" ")}`} stroke="#fff" strokeWidth="1.2" opacity="0.7" strokeLinecap="round" />
      {/* A small bowl */}
      <g transform={`translate(${iso(8, 4, 17.5).join(" ")})`}>
        <ellipse cx="0" cy="0" rx="5" ry="2.4" fill="#c96a4b" />
        <ellipse cx="0" cy="-1.2" rx="4" ry="1.8" fill="#e08a68" />
        <circle cx="-1.2" cy="-1.6" r="1.1" fill="#d94b3a" />
        <circle cx="1.4" cy="-1.3" r="1.1" fill="#e8b23a" />
      </g>
    </g>
  );
}

function Flames({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path d="M-8 0 Q-9 -8 -3 -12 Q-1 -6 2 -9 Q8 -4 6 2 Q4 8 0 8 Q-8 8 -8 0 Z" fill="#f06a1e">
        <animate attributeName="d" values="M-8 0 Q-9 -8 -3 -12 Q-1 -6 2 -9 Q8 -4 6 2 Q4 8 0 8 Q-8 8 -8 0 Z;M-7 0 Q-10 -7 -4 -14 Q0 -8 3 -11 Q9 -5 6 1 Q4 8 0 8 Q-8 8 -7 0 Z;M-8 0 Q-9 -8 -3 -12 Q-1 -6 2 -9 Q8 -4 6 2 Q4 8 0 8 Q-8 8 -8 0 Z" dur="1.1s" repeatCount="indefinite" />
      </path>
      <path d="M-4 3 Q-5 -3 -1 -6 Q1 -2 3 -4 Q6 0 4 4 Q2 7 0 7 Q-4 7 -4 3 Z" fill="#ffb02e">
        <animate attributeName="d" values="M-4 3 Q-5 -3 -1 -6 Q1 -2 3 -4 Q6 0 4 4 Q2 7 0 7 Q-4 7 -4 3 Z;M-4 3 Q-6 -2 -2 -8 Q1 -3 3 -5 Q6 1 4 4 Q2 7 0 7 Q-4 7 -4 3 Z;M-4 3 Q-5 -3 -1 -6 Q1 -2 3 -4 Q6 0 4 4 Q2 7 0 7 Q-4 7 -4 3 Z" dur="0.9s" repeatCount="indefinite" />
      </path>
      <ellipse cx="0" cy="5" rx="3" ry="2" fill="#fff0a0" opacity="0.9" />
      {/* Logs */}
      <path d="M-9 7 L7 5 L8 8 L-8 10 Z" fill="#5a3a22" />
      <path d="M-7 9 L9 7 L9 10 L-6 12 Z" fill="#6c4629" />
    </g>
  );
}

export function FireplaceBrick() {
  const brick = "#a5573f";
  const w = 68,
    d = 18,
    h = 58;
  const bricks = [];
  // Brick courses on the lit (left) face
  for (let row = 0; row < 9; row++) {
    const z = 3 + row * 6;
    const offset = row % 2 === 0 ? 0 : 6;
    for (let i = 0; i < 5; i++) {
      const a0 = -w / 2 + 2 + offset + i * 12;
      if (a0 + 10 > w / 2 - 2) continue;
      bricks.push(
        <path key={`${row}-${i}`} d={poly([[a0, d / 2, z], [a0 + 10, d / 2, z], [a0 + 10, d / 2, z + 4.5], [a0, d / 2, z + 4.5]])} fill={i % 3 === 1 ? shade(brick, 0.9) : shade(brick, 1.02)} />,
      );
    }
  }
  return (
    <g>
      <IsoBox w={w} d={d} h={h} color={brick} left={shade(brick, 0.82)} />
      {bricks}
      {/* Firebox: a dark arched opening on the lit face */}
      <g transform={`translate(${iso(0, d / 2, 0).join(" ")})`}>
        <path d="M-17 0 L-17 -22 Q-17 -36 0 -36 Q17 -36 17 -22 L17 0 Z" transform="matrix(1 0.5 0 1 0 0)" fill="#1d1410" />
        <g transform="matrix(1 0.5 0 1 0 -4)">
          <path d="M-13 0 L-13 -20 Q-13 -30 0 -30 Q13 -30 13 -20 L13 0 Z" fill="#2c1c14" />
          <Flames x={0} y={-10} />
          <path d="M-17 0 L-17 -22 Q-17 -36 0 -36 Q17 -36 17 -22 L17 0" fill="none" stroke="#5f5a58" strokeWidth="1.2" />
        </g>
      </g>
      {/* Mantel shelf */}
      <IsoBox w={w + 6} d={d + 4} h={4} z={h} color="#5e4030" />
      {/* Chimney breast above the mantel */}
      <IsoBox w={w - 10} d={d - 4} h={22} b={-2} z={h + 4} color={shade(brick, 0.95)} />
      {/* Mantel clutter: a small frame and a candle */}
      <path d={poly([[-22, -2, h + 4], [-12, -2, h + 4], [-12, -2, h + 14], [-22, -2, h + 14]])} fill="#3c2a1e" />
      <path d={poly([[-20.5, -2.2, h + 5.5], [-13.5, -2.2, h + 5.5], [-13.5, -2.2, h + 12.5], [-20.5, -2.2, h + 12.5]])} fill="#a9c7d8" />
      <g transform={`translate(${iso(18, 0, h + 4).join(" ")})`}>
        <path d="M-2 0 L2 0 L1.6 -9 L-1.6 -9 Z" fill="#f3e7c8" />
        <path d="M0 -9 q-1.4 -2 0 -4 q1.4 2 0 4 Z" fill="#ffc63b">
          <animate attributeName="opacity" values="1;0.7;1" dur="1.6s" repeatCount="indefinite" />
        </path>
      </g>
    </g>
  );
}

export function FireplaceModern() {
  const stone = "#c8c0b2";
  const w = 76,
    d = 16,
    h = 52;
  return (
    <g>
      <IsoBox w={w} d={d} h={h} color={stone} />
      {/* Wide low rectangular firebox */}
      <g transform={`translate(${iso(0, d / 2, 0).join(" ")})`}>
        <g transform="matrix(1 0.5 0 1 0 -8)">
          <rect x="-26" y="-22" width="52" height="22" fill="#151211" />
          <rect x="-24" y="-20" width="48" height="18" fill="#221a16" />
          <Flames x={-10} y={-8} scale={0.8} />
          <Flames x={8} y={-8} scale={0.7} />
          <rect x="-26" y="-22" width="52" height="22" fill="none" stroke="#3a3633" strokeWidth="1" />
        </g>
      </g>
      {/* Slab mantel */}
      <IsoBox w={w + 4} d={d + 2} h={3} z={h} color="#8f857a" />
      {/* Log stack beside it on the floor */}
      <g transform={`translate(${iso(w / 2 + 12, 4, 0).join(" ")})`}>
        {[
          [0, -3],
          [-5, -8],
          [5, -8],
          [0, -13],
        ].map(([x, y], i) => (
          <g key={i} transform={`translate(${x} ${y})`}>
            <path d="M-4 0 L6 -4 L6 -9 L-4 -5 Z" fill="#6a4a2e" />
            <ellipse cx="-4" cy="-2.5" rx="2.4" ry="3" fill="#c9a674" />
            <ellipse cx="-4" cy="-2.5" rx="1.2" ry="1.6" fill="none" stroke="#9a7a4e" strokeWidth="0.4" />
          </g>
        ))}
      </g>
    </g>
  );
}

const SPINES = ["#c0392b", "#2e86ab", "#f39c12", "#27ae60", "#8e44ad", "#e67e22", "#16a085", "#d35400", "#34495e", "#f1c40f"];

function ShelfBooks({ a0, a1, b, z, seed }: { a0: number; a1: number; b: number; z: number; seed: number }) {
  const out = [];
  let a = a0;
  let i = seed;
  while (a < a1 - 2) {
    const tw = 2 + ((i * 7) % 3);
    const th = 9 + ((i * 5) % 5);
    const lean = i % 7 === 3;
    out.push(
      <path key={i} d={poly([[a, b, z], [a + tw, b, z], [a + tw + (lean ? 2 : 0), b, z + th], [a + (lean ? 2 : 0), b, z + th]])} fill={SPINES[i % SPINES.length]} stroke="rgba(0,0,0,0.25)" strokeWidth="0.3" />,
    );
    a += tw + 0.6;
    i++;
  }
  return <g>{out}</g>;
}

export function BookshelfTall() {
  const wood = "#7a5236";
  const w = 44,
    d = 14,
    h = 72;
  return (
    <g>
      <IsoBox w={w} d={d} h={h} color={wood} />
      {/* Cut the open face: a darker interior on the lit face, shelves in front */}
      <path d={poly([[-w / 2 + 2, d / 2, 2], [w / 2 - 2, d / 2, 2], [w / 2 - 2, d / 2, h - 2], [-w / 2 + 2, d / 2, h - 2]])} fill={shade(wood, 0.55)} />
      {[3, 20, 37, 54].map((z, i) => (
        <g key={z}>
          <ShelfBooks a0={-w / 2 + 3} a1={w / 2 - 3} b={d / 2 + 0.1} z={z} seed={i * 11 + 2} />
          <path d={poly([[-w / 2 + 2, d / 2, z - 1], [w / 2 - 2, d / 2, z - 1], [w / 2 - 2, d / 2 + 1, z], [-w / 2 + 2, d / 2 + 1, z]])} fill={shade(wood, 1.15)} />
        </g>
      ))}
      {/* A leaning frame on top, holding the office cat's formal portrait:
          dark ground, gold mount, a ruff. The office keeps a pet in every
          room, so the lobby hangs the boss. */}
      <path d={poly([[-8, 0, h], [4, 0, h], [4, -3, h + 11], [-8, -3, h + 11]])} fill="#3c2a1e" />
      <path d={poly([[-7.2, -0.2, h + 0.8], [3.2, -0.2, h + 0.8], [3.2, -2.8, h + 10.2], [-7.2, -2.8, h + 10.2]])} fill="#c8a24e" />
      <path d={poly([[-6.5, -0.4, h + 1.5], [2.5, -0.4, h + 1.5], [2.5, -2.6, h + 9.5], [-6.5, -2.6, h + 9.5]])} fill="#243028" />
      <g transform={`translate(${iso(-2, -1.5, h + 4.6).join(" ")})`}>
        {/* Ruff, head, ears, muzzle: the whole sitter is six shapes wide. */}
        <ellipse cx="0" cy="1.9" rx="3.1" ry="1.1" fill="#efe7d2" />
        <path d="M-2.3 -1.6 L-1.7 -3.6 L-0.6 -2.2 Z M2.3 -1.6 L1.7 -3.6 L0.6 -2.2 Z" fill="#e8a04a" />
        <ellipse cx="0" cy="0" rx="2.4" ry="2.1" fill="#e8a04a" />
        <ellipse cx="-0.9" cy="-0.2" rx="0.35" ry="0.5" fill="#243028" />
        <ellipse cx="0.9" cy="-0.2" rx="0.35" ry="0.5" fill="#243028" />
        <path d="M-0.4 0.9 L0.4 0.9 L0 1.3 Z" fill="#d9776a" />
      </g>
    </g>
  );
}

export function Credenza() {
  const wood = "#b0885a";
  const w = 60,
    d = 16,
    h = 26;
  return (
    <g>
      {[
        [-w / 2 + 4, d / 2 - 3],
        [w / 2 - 4, d / 2 - 3],
        [w / 2 - 4, -d / 2 + 3],
      ].map(([a, b], i) => (
        <Leg key={i} a={a} b={b} h={6} />
      ))}
      <IsoBox w={w} d={d} h={h - 6} z={6} color={wood} />
      {/* Two sliding doors with round pulls */}
      <path d={`M${iso(0, d / 2, 6).join(" ")} L${iso(0, d / 2, h).join(" ")}`} stroke={shade(wood, 0.6)} strokeWidth="0.6" />
      <circle cx={iso(-5, d / 2, 16)[0]} cy={iso(-5, d / 2, 16)[1]} r="1" fill="#e8d3a2" />
      <circle cx={iso(5, d / 2, 16)[0]} cy={iso(5, d / 2, 16)[1]} r="1" fill="#e8d3a2" />
      {/* Record player on top */}
      <IsoBox w={16} d={12} h={3} a={-14} b={0} z={h} color="#3d3a37" />
      <ellipse cx={iso(-14, 0, h + 3)[0]} cy={iso(-14, 0, h + 3)[1]} rx="5" ry="2.5" fill="#111" />
      <ellipse cx={iso(-14, 0, h + 3)[0]} cy={iso(-14, 0, h + 3)[1]} rx="1.6" ry="0.8" fill="#c0392b" />
    </g>
  );
}

function Fish({ x, y, color, dur, flip = false }: { x: number; y: number; color: string; dur: string; flip?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -1 : 1} 1)`}>
      <animateTransform attributeName="transform" type="translate" values={`${x} ${y};${x + (flip ? -10 : 10)} ${y - 2};${x} ${y}`} dur={dur} repeatCount="indefinite" additive="replace" />
      <g transform={`scale(${flip ? -1 : 1} 1)`}>
        <ellipse cx="0" cy="0" rx="4" ry="2.2" fill={color} />
        <path d="M-3.5 0 L-6.5 -2.5 L-6.5 2.5 Z" fill={color} />
        <circle cx="2" cy="-0.5" r="0.6" fill="#111" />
      </g>
    </g>
  );
}

export function FishTankStand() {
  const w = 40,
    d = 18;
  return (
    <g>
      <IsoBox w={w} d={d} h={24} color="#4b4f55" />
      {/* Glass tank: faces drawn with translucent fills so the water shows through */}
      <path d={poly([[-w / 2, -d / 2, 24], [w / 2, -d / 2, 24], [w / 2, d / 2, 24], [-w / 2, d / 2, 24]])} fill="#2b5a7a" />
      {/* Back walls of water (inside) */}
      <path d={poly([[-w / 2, -d / 2, 24], [w / 2, -d / 2, 24], [w / 2, -d / 2, 24 + 26], [-w / 2, -d / 2, 24 + 26]])} fill="#3a7ea5" />
      <path d={poly([[-w / 2, -d / 2, 24], [-w / 2, d / 2, 24], [-w / 2, d / 2, 24 + 26], [-w / 2, -d / 2, 24 + 26]])} fill="#3273a0" />
      {/* Gravel and plants */}
      <path d={poly([[-w / 2 + 1, -d / 2 + 1, 25], [w / 2 - 1, -d / 2 + 1, 25], [w / 2 - 1, d / 2 - 1, 25], [-w / 2 + 1, d / 2 - 1, 25]])} fill="#8a9a6a" />
      <g transform={`translate(${iso(-12, 2, 26).join(" ")})`}>
        <path d="M0 0 q-4 -8 -1 -18 M0 0 q4 -7 2 -16 M0 0 q0 -10 -3 -14" fill="none" stroke="#2f8f5a" strokeWidth="1.4" strokeLinecap="round">
          <animate attributeName="stroke-width" values="1.4;1.7;1.4" dur="3s" repeatCount="indefinite" />
        </path>
      </g>
      <Fish x={iso(4, 0, 40)[0]} y={iso(4, 0, 40)[1]} color="#ff8c42" dur="5s" />
      <Fish x={iso(-4, 4, 33)[0]} y={iso(-4, 4, 33)[1]} color="#ffd23f" dur="7s" flip />
      <Fish x={iso(10, -2, 30)[0]} y={iso(10, -2, 30)[1]} color="#4fc3f7" dur="6s" />
      {/* Bubbles */}
      {[0, 1, 2].map((i) => {
        const [bx, by] = iso(12, 5, 27);
        return (
          <circle key={i} cx={bx} cy={by} r={0.9} fill="#fff" opacity="0.7">
            <animate attributeName="cy" values={`${by};${by - 22}`} dur={`${2.2 + i * 0.7}s`} begin={`${i * 0.8}s`} repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.7;0" dur={`${2.2 + i * 0.7}s`} begin={`${i * 0.8}s`} repeatCount="indefinite" />
          </circle>
        );
      })}
      {/* Front glass faces, translucent, with edge highlights */}
      <path d={poly([[-w / 2, d / 2, 24], [w / 2, d / 2, 24], [w / 2, d / 2, 50], [-w / 2, d / 2, 50]])} fill="#9ad3e8" fillOpacity="0.22" stroke="#d7f1fa" strokeWidth="0.8" />
      <path d={poly([[w / 2, -d / 2, 24], [w / 2, d / 2, 24], [w / 2, d / 2, 50], [w / 2, -d / 2, 50]])} fill="#6fb7d6" fillOpacity="0.25" stroke="#d7f1fa" strokeWidth="0.8" />
      {/* Water surface */}
      <path d={poly([[-w / 2, -d / 2, 47], [w / 2, -d / 2, 47], [w / 2, d / 2, 47], [-w / 2, d / 2, 47]])} fill="#bfe9f7" fillOpacity="0.6" />
      <path d={`M${iso(-w / 2 + 3, d / 2, 46).join(" ")} L${iso(-w / 2 + 3, d / 2, 28).join(" ")}`} stroke="#fff" strokeWidth="1.2" opacity="0.55" strokeLinecap="round" />
      {/* Hood light */}
      <IsoBox w={w + 2} d={d + 2} h={3} z={50} color="#3b3f45" />
    </g>
  );
}

export function FishBowl() {
  return (
    <g>
      {/* Side table */}
      <IsoCylinder r={13} h={1.5} color="#6b4a2e" gradId="lobby-bowl-foot" />
      <IsoCylinder r={2.2} h={20} color="#7a5636" gradId="lobby-bowl-stem" />
      <IsoCylinder r={15} h={2.5} z={20} color="#b28a5c" gradId="lobby-bowl-top" />
      <g transform={`translate(${iso(0, 0, 23).join(" ")})`}>
        <ellipse cx="0" cy="0" rx="7" ry="3" fill="#7f9aa8" opacity="0.5" />
        <circle cx="0" cy="-11" r="11" fill="#bfe3ee" fillOpacity="0.5" stroke="#e3f6fb" strokeWidth="0.8" />
        <path d="M-9.5 -7 A11 11 0 0 0 9.5 -7 L9.5 -12 A11 4 0 0 0 -9.5 -12 Z" fill="#4aa3c9" fillOpacity="0.55" />
        <ellipse cx="0" cy="-12" rx="9.5" ry="3.2" fill="#9fd9ec" fillOpacity="0.7" />
        <path d="M-5 -3 q5 -2 10 0" fill="none" stroke="#8a9a6a" strokeWidth="2" strokeLinecap="round" />
        <Fish x={-1} y={-8} color="#ff8c42" dur="4s" />
        <path d="M-6 -16 A9 9 0 0 1 -2 -19" fill="none" stroke="#fff" strokeWidth="1" opacity="0.7" strokeLinecap="round" />
      </g>
    </g>
  );
}

export function LampArc() {
  return (
    <g>
      <IsoCylinder r={10} h={2} color="#8a8f96" gradId="lobby-arc-base" />
      <path d={`M${iso(0, 0, 2).join(" ")} L${iso(0, 0, 70).join(" ")} Q${iso(0, 0, 112).join(" ")} ${iso(-38, 0, 100).join(" ")}`} fill="none" stroke="#9aa0a8" strokeWidth="2.2" strokeLinecap="round" />
      <path d={`M${iso(0, 0, 2).join(" ")} L${iso(0, 0, 70).join(" ")} Q${iso(0, 0, 112).join(" ")} ${iso(-38, 0, 100).join(" ")}`} fill="none" stroke="#d8dde3" strokeWidth="0.7" strokeLinecap="round" />
      <g transform={`translate(${iso(-38, 0, 100).join(" ")})`}>
        <path d="M-12 12 A12 12 0 0 1 12 12 L11 14 A11 5 0 0 1 -11 14 Z" fill="#c8ccd2" stroke="#7e848c" strokeWidth="0.5" />
        <ellipse cx="0" cy="14" rx="11" ry="4.5" fill="#fff4cc" />
        <ellipse cx="0" cy="14" rx="7" ry="2.8" fill="#fff9e0" className="lamp-glow" />
      </g>
    </g>
  );
}

export function LampTripod() {
  const legs: Array<[number, number]> = [
    [-9, 5],
    [9, 5],
    [0, -10],
  ];
  return (
    <g>
      {legs.map(([a, b], i) => (
        <path key={i} d={`M${iso(a, b, 0).join(" ")} L${iso(0, 0, 52).join(" ")}`} stroke="#6a4a2e" strokeWidth="2" strokeLinecap="round" />
      ))}
      <g transform={`translate(${iso(0, 0, 52).join(" ")})`}>
        <ellipse cx="0" cy="0" rx="15" ry="6" fill="#e3d3b3" />
        <path d="M-15 0 L-15 -24 A15 6 0 0 1 15 -24 L15 0 A15 6 0 0 1 -15 0 Z" fill="#efe1c5" stroke="#b9a684" strokeWidth="0.5" />
        <ellipse cx="0" cy="-24" rx="15" ry="6" fill="#f5eada" stroke="#b9a684" strokeWidth="0.5" />
        <path d="M-15 -18 L-15 -6" stroke="#fff" strokeWidth="1.2" opacity="0.5" />
        <ellipse cx="0" cy="1" rx="8" ry="3" fill="#fff3c4" opacity="0.9" className="lamp-glow" />
      </g>
    </g>
  );
}
