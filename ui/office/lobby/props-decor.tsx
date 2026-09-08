import { useI18n } from "../../i18n.tsx";
import { IsoBox, iso, poly, shade, wallTransform } from "./iso.tsx";
import { CornerPlant } from "../plants.tsx";

// Rugs, plants, wall pieces, cats, directory boards and the counter.

export function RugOval() {
  const { t } = useI18n();
  const [cx, cy] = iso(0, 0, 0);
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx={52} ry={26} fill="#b8734a" />
      <ellipse cx={cx} cy={cy} rx={46} ry={22} fill="#d69a6a" />
      <ellipse
        cx={cx}
        cy={cy}
        rx={46}
        ry={22}
        fill="none"
        stroke="#a5613a"
        strokeWidth="1"
        strokeDasharray="4 3"
      />
      {/* Text lies on the floor plane: x along COL, y along ROW. */}
      <text
        transform={`matrix(0.9 0.45 -0.9 0.45 ${cx} ${cy}) translate(0 4)`}
        textAnchor="middle"
        fontSize="12"
        fontFamily="DM Sans, sans-serif"
        fontWeight="700"
        fill="#7a3f1f"
        letterSpacing="2"
        textLength="76"
        lengthAdjust="spacingAndGlyphs"
      >
        {t("lobby.welcome")}
      </text>
    </g>
  );
}

export function RugRect() {
  const w = 96,
    d = 60;
  const stripes = [];
  for (let i = 1; i < 6; i++) {
    const b = -d / 2 + (d / 6) * i;
    stripes.push(
      <path
        key={i}
        d={`M${iso(-w / 2 + 6, b, 0).join(" ")} L${iso(w / 2 - 6, b, 0).join(" ")}`}
        stroke={i % 2 ? "#e5c48c" : "#b7455a"}
        strokeWidth="3"
      />,
    );
  }
  return (
    <g>
      <path
        d={poly([
          [-w / 2, -d / 2, 0],
          [w / 2, -d / 2, 0],
          [w / 2, d / 2, 0],
          [-w / 2, d / 2, 0],
        ])}
        fill="#8f3a4a"
      />
      <path
        d={poly([
          [-w / 2 + 4, -d / 2 + 4, 0],
          [w / 2 - 4, -d / 2 + 4, 0],
          [w / 2 - 4, d / 2 - 4, 0],
          [-w / 2 + 4, d / 2 - 4, 0],
        ])}
        fill="#c9556a"
      />
      {stripes}
      <path
        d={poly([
          [-22, -12, 0],
          [22, -12, 0],
          [22, 12, 0],
          [-22, 12, 0],
        ])}
        fill="#e5c48c"
      />
      <path
        d={poly([
          [-14, -7, 0],
          [14, -7, 0],
          [14, 7, 0],
          [-14, 7, 0],
        ])}
        fill="#8f3a4a"
      />
      {/* Fringe */}
      {Array.from({ length: 12 }, (_, i) => {
        const a = -w / 2 + 4 + i * 8;
        return (
          <path
            key={i}
            d={`M${iso(a, d / 2, 0).join(" ")} l-1.5 3 M${iso(a, -d / 2, 0).join(" ")} l1.5 -3`}
            stroke="#e5c48c"
            strokeWidth="1"
          />
        );
      })}
    </g>
  );
}

export function RugRound() {
  const [cx, cy] = iso(0, 0, 0);
  const rings = [
    "#6d8b74",
    "#c9d3b0",
    "#7f9c86",
    "#e2d9b8",
    "#6d8b74",
    "#c9d3b0",
  ];
  return (
    <g>
      {rings.map((col, i) => (
        <ellipse
          key={i}
          cx={cx}
          cy={cy}
          rx={44 - i * 7}
          ry={22 - i * 3.5}
          fill={col}
        />
      ))}
      <ellipse
        cx={cx}
        cy={cy}
        rx={44}
        ry={22}
        fill="none"
        stroke="#4e6b55"
        strokeWidth="0.8"
      />
    </g>
  );
}

export function PlantCorner() {
  return (
    <g
      transform={`translate(${iso(0, 0, 0).join(" ")}) translate(0 -30) scale(1.5)`}
    >
      <CornerPlant />
    </g>
  );
}

function MonsteraLeaf({
  rot,
  len,
  color,
}: {
  rot: number;
  len: number;
  color: string;
}) {
  const s = len / 20;
  return (
    <g transform={`rotate(${rot}) scale(${s})`}>
      <path
        d="M0 0 Q1 -8 0 -20"
        fill="none"
        stroke="#2f6b39"
        strokeWidth="1.2"
      />
      <path
        d="M0 -20 Q-9 -24 -10 -14 Q-12 -6 -5 -3 Q-2 -1 0 0 Q2 -1 5 -3 Q12 -6 10 -14 Q9 -24 0 -20 Z"
        fill={color}
        stroke={shade(color, 0.7)}
        strokeWidth="0.5"
      />
      <path
        d="M-7 -13 q3 2 4 -2 M6 -9 q-3 1 -3 -3 M-5 -6 q2 1 3 -1"
        fill="none"
        stroke={shade(color, 0.6)}
        strokeWidth="0.7"
        strokeLinecap="round"
      />
      <path d="M0 -19 L0 -3" stroke={shade(color, 0.75)} strokeWidth="0.6" />
    </g>
  );
}

export function PlantMonstera() {
  const [x, y] = iso(0, 0, 0);
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M-11 0 L11 0 L9 -16 L-9 -16 Z" fill="#c4714c" />
      <path d="M-11 0 L11 0 L9 -16 L-9 -16 Z" fill="url(#lobby-pot-shade)" />
      <path d="M-12 -16 L12 -16 L12 -19 L-12 -19 Z" fill="#d68a63" />
      <ellipse cx="0" cy="-19" rx="12" ry="4" fill="#5a3e2a" />
      <g transform="translate(0 -20)">
        <MonsteraLeaf rot={-55} len={34} color="#3b8a48" />
        <MonsteraLeaf rot={40} len={38} color="#2f7a3f" />
        <MonsteraLeaf rot={-12} len={44} color="#46994f" />
        <MonsteraLeaf rot={78} len={28} color="#3b8a48" />
        <MonsteraLeaf rot={-90} len={26} color="#2f7a3f" />
      </g>
      <defs>
        <linearGradient id="lobby-pot-shade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.12" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.25" />
        </linearGradient>
      </defs>
    </g>
  );
}

const FLAG_COLORS = ["#e2574c", "#f2b134", "#4ea5d9", "#7bc47f", "#b98cd4"];

// Wall pieces draw flat (x along the wall, y up, origin at the wall contact
// point) and get skewed onto the wall plane by wallTransform.
export function Bunting({
  wall,
  text,
}: {
  wall: "left" | "right";
  text?: string;
}) {
  const { t } = useI18n();
  const letters = (text ?? t("lobby.welcome")).toUpperCase().split("");
  const step = 17;
  const width = step * letters.length;
  return (
    <g transform={wallTransform(wall, 0, 0)}>
      <path
        d={`M${-width / 2 - 8} -40 Q0 -20 ${width / 2 + 8} -40`}
        fill="none"
        stroke="#7a5a3a"
        strokeWidth="1"
      />
      {letters.map((ch, i) => {
        const t = (i + 0.5) / letters.length;
        const x = -width / 2 + step * (i + 0.5);
        const y = -40 + 20 * (1 - Math.pow(2 * t - 1, 2)) * 1;
        const col = FLAG_COLORS[i % FLAG_COLORS.length];
        return (
          <g key={i} transform={`translate(${x} ${y})`}>
            <path
              d="M-7 0 L7 0 L0 16 Z"
              fill={col}
              stroke={shade(col, 0.7)}
              strokeWidth="0.4"
            />
            <text
              x="0"
              y="8"
              textAnchor="middle"
              fontSize="7"
              fontWeight="700"
              fontFamily="DM Sans, sans-serif"
              fill="#fff"
            >
              {ch}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function FramedPoster({ wall }: { wall: "left" | "right" }) {
  const { t } = useI18n();
  return (
    <g transform={wallTransform(wall, 0, 0)}>
      <rect x="-24" y="-64" width="48" height="60" fill="#3c2a1e" />
      <rect x="-21" y="-61" width="42" height="54" fill="#f4ecd8" />
      {/* A tiny isometric office as the poster art */}
      <g transform="translate(0 -30)">
        <path d="M0 -14 L-16 -6 L0 2 L16 -6 Z" fill="#cfd8e6" />
        <path d="M-16 -6 L-16 8 L0 16 L0 2 Z" fill="#9fb0c8" />
        <path d="M0 2 L0 16 L16 8 L16 -6 Z" fill="#7d90ab" />
        <path d="M-6 -6 L-2 -8 L2 -6 L-2 -4 Z" fill="#e07a5f" />
        <path d="M4 -3 L8 -5 L12 -3 L8 -1 Z" fill="#81b29a" />
        <circle cx="-2" cy="-10" r="1.6" fill="#f2cc8f" />
        <circle cx="8" cy="-7" r="1.6" fill="#f2cc8f" />
      </g>
      <text
        x="0"
        y="-11"
        textAnchor="middle"
        fontSize="5"
        fontFamily="DM Sans, sans-serif"
        fontWeight="700"
        fill="#3d405b"
        letterSpacing="1"
      >
        {t("lobby.poster")}
      </text>
      <rect x="-21" y="-61" width="42" height="54" fill="url(#lobby-glass)" />
    </g>
  );
}

export function CatCurled() {
  const coat = "#e8a04a";
  const [x, y] = iso(0, 0, 0);
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse cx="0" cy="-3" rx="15" ry="8" fill={coat}>
        <animate
          attributeName="ry"
          values="8;8.5;8"
          dur="3.2s"
          repeatCount="indefinite"
        />
      </ellipse>
      <ellipse cx="0" cy="-3" rx="15" ry="8" fill="url(#lobby-cat-volume)" />
      {/* Stripes */}
      <path
        d="M-6 -9 q2 3 0 6 M-1 -10 q2 3 0 6 M4 -9 q2 3 0 6"
        fill="none"
        stroke={shade(coat, 0.75)}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* Tail wrapped around the front */}
      <path
        d="M12 -3 C20 6 0 10 -9 4 Q-12 1 -8 0"
        fill="none"
        stroke={shade(coat, 0.82)}
        strokeWidth="3.5"
        strokeLinecap="round"
      >
        <animate
          attributeName="d"
          values="M12 -3 C20 6 0 10 -9 4 Q-12 1 -8 0;M12 -3 C20 6 0 10 -9 4 Q-12 1 -8 -1;M12 -3 C20 6 0 10 -9 4 Q-12 1 -8 0"
          dur="4s"
          repeatCount="indefinite"
        />
      </path>
      {/* Head tucked in at the left */}
      <ellipse cx="-9" cy="-5" rx="7" ry="6" fill={coat} />
      <ellipse cx="-9" cy="-5" rx="7" ry="6" fill="url(#lobby-cat-volume)" />
      <path d="M-15 -9 L-13.5 -15 L-10 -10 Z" fill={coat} />
      <path d="M-8 -10 L-5.5 -15 L-3 -9 Z" fill={coat} />
      <path d="M-14 -9.5 L-13 -13 L-11 -10 Z" fill="#f4c7a0" />
      <path d="M-7.5 -10 L-6 -13 L-4.5 -9.5 Z" fill="#f4c7a0" />
      <path
        d="M-13 -5 q1.5 -1.6 3 0 M-8 -5.5 q1.5 -1.6 3 0"
        fill="none"
        stroke="#5a3a1a"
        strokeWidth="0.8"
        strokeLinecap="round"
      />
      <ellipse cx="-9.5" cy="-2.6" rx="1" ry="0.7" fill="#d9776a" />
      <path
        d="M-16 -3 l-4 -1 M-16 -2 l-4 1 M-3 -3 l4 -1 M-3 -2 l4 1"
        stroke="#5a3a1a"
        strokeWidth="0.35"
      />
      <defs>
        <radialGradient id="lobby-cat-volume" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </radialGradient>
      </defs>
    </g>
  );
}

export function CatSitting() {
  const coat = "#5f6672";
  const [x, y] = iso(0, 0, 0);
  return (
    <g transform={`translate(${x} ${y})`}>
      {/* Tail */}
      <path
        d="M7 -4 Q18 -2 16 -14"
        fill="none"
        stroke={coat}
        strokeWidth="3"
        strokeLinecap="round"
      >
        <animate
          attributeName="d"
          values="M7 -4 Q18 -2 16 -14;M7 -4 Q20 -4 15 -16;M7 -4 Q18 -2 16 -14"
          dur="3.5s"
          repeatCount="indefinite"
        />
      </path>
      {/* Body */}
      <path d="M-9 0 Q-11 -20 0 -22 Q11 -20 9 0 Z" fill={coat} />
      <ellipse cx="0" cy="-1" rx="9" ry="3.5" fill={coat} />
      <path
        d="M-9 0 Q-11 -20 0 -22 Q11 -20 9 0 Z"
        fill="url(#lobby-cat-volume2)"
      />
      {/* Chest patch and paws */}
      <path
        d="M-4 -12 Q0 -16 4 -12 Q3 -4 0 -3 Q-3 -4 -4 -12 Z"
        fill="#dfe3e8"
      />
      <ellipse cx="-4" cy="0" rx="3" ry="1.6" fill="#dfe3e8" />
      <ellipse cx="4" cy="0" rx="3" ry="1.6" fill="#dfe3e8" />
      {/* Head */}
      <circle cx="0" cy="-26" r="8" fill={coat} />
      <circle cx="0" cy="-26" r="8" fill="url(#lobby-cat-volume2)" />
      <path d="M-7 -31 L-6 -38 L-1 -33 Z" fill={coat} />
      <path d="M7 -31 L6 -38 L1 -33 Z" fill={coat} />
      <path d="M-5.5 -32 L-5 -36 L-2.5 -33 Z" fill="#f2b8c6" />
      <path d="M5.5 -32 L5 -36 L2.5 -33 Z" fill="#f2b8c6" />
      <ellipse cx="-3" cy="-27" rx="1.8" ry="2.2" fill="#c8e06a" />
      <ellipse cx="3" cy="-27" rx="1.8" ry="2.2" fill="#c8e06a" />
      <ellipse cx="-3" cy="-27" rx="0.7" ry="1.8" fill="#222">
        <animate
          attributeName="ry"
          values="1.8;1.8;0.2;1.8"
          keyTimes="0;0.9;0.95;1"
          dur="5s"
          repeatCount="indefinite"
        />
      </ellipse>
      <ellipse cx="3" cy="-27" rx="0.7" ry="1.8" fill="#222">
        <animate
          attributeName="ry"
          values="1.8;1.8;0.2;1.8"
          keyTimes="0;0.9;0.95;1"
          dur="5s"
          repeatCount="indefinite"
        />
      </ellipse>
      <path d="M-1 -23.5 L1 -23.5 L0 -22.5 Z" fill="#e79aa8" />
      <path
        d="M0 -22.5 q-1.5 1.5 -3 0.5 M0 -22.5 q1.5 1.5 3 0.5"
        fill="none"
        stroke="#333"
        strokeWidth="0.5"
      />
      <path
        d="M-8 -23 l-5 -1 M-8 -22 l-5 1 M8 -23 l5 -1 M8 -22 l5 1"
        stroke="#dfe3e8"
        strokeWidth="0.4"
      />
      <defs>
        <radialGradient id="lobby-cat-volume2" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#fff" stopOpacity="0.25" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.25" />
        </radialGradient>
      </defs>
    </g>
  );
}

// Directory text follows the reader; room and office names remain verbatim.
export interface DirectoryRoom {
  id: string;
  name: string;
}

export function DirectoryBoard({
  wall,
  rooms,
  officeName,
}: {
  wall: "left" | "right";
  rooms: DirectoryRoom[];
  officeName: string;
}) {
  const { t } = useI18n();
  const rows = rooms.slice(0, 6);
  const h = 34 + rows.length * 9;
  return (
    <g transform={wallTransform(wall, 0, 0)}>
      <rect x="-34" y={-h - 6} width="68" height={h + 6} fill="#5a4030" />
      <rect x="-31" y={-h - 3} width="62" height={h} fill="#f5ecd6" />
      <text
        x="0"
        y={-h + 8}
        textAnchor="middle"
        fontSize="6.5"
        fontWeight="700"
        fontFamily="DM Sans, sans-serif"
        fill="#7a5a3a"
        letterSpacing="1.5"
      >
        {t("lobby.directory")}
      </text>
      <text
        x="0"
        y={-h + 16}
        textAnchor="middle"
        fontSize="4.5"
        fontFamily="DM Sans, sans-serif"
        fill="#a08a6a"
      >
        {officeName}
      </text>
      <line
        x1="-26"
        y1={-h + 19}
        x2="26"
        y2={-h + 19}
        stroke="#c9b892"
        strokeWidth="0.6"
      />
      {rows.map((r, i) => (
        <g key={r.id} transform={`translate(0 ${-h + 28 + i * 9})`}>
          <text
            x="-25"
            y="0"
            fontSize="5.2"
            fontFamily="DM Sans, sans-serif"
            fill="#3a2818"
          >
            {r.name}
          </text>
          <path
            d="M20 -2 L24 -2 M22.5 -3.5 L24 -2 L22.5 -0.5"
            fill="none"
            stroke="#a08a6a"
            strokeWidth="0.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      ))}
      {/* Pushpins */}
      <circle cx="-28" cy={-h} r="1.6" fill="#d94b3a" />
      <circle cx="28" cy={-h} r="1.6" fill="#3a7bd5" />
    </g>
  );
}

export function DirectorySign({
  rooms,
  officeName,
}: {
  rooms: DirectoryRoom[];
  officeName: string;
}) {
  const rows = rooms.slice(0, 4);
  // A real A-frame: two boards hinged at an apex over the origin, splayed to
  // the floor front and back along b. The old one skewed a flat card with the
  // LEFT wall's matrix and propped a leg behind it with the right wall's, so
  // the two halves never met and the leg stuck out of the top corner (Marc,
  // 2026-09-07).
  const H = 46; // apex height
  const SPLAY = 9; // how far each board's foot stands from the apex, along b
  const HW = 17; // half width, along a
  const apex = iso(0, 0, H);
  const board = (bd: number) => [
    iso(-HW, bd, 0),
    iso(HW, bd, 0),
    iso(HW, 0, H),
    iso(-HW, 0, H),
  ];
  const path = (pts: Array<[number, number]>) =>
    `M${pts.map((q) => q.join(" ")).join(" L")} Z`;
  // Text lies IN the front board: x runs along a, y runs down the board from
  // the apex, so a row of it follows the lean instead of floating over it.
  const foot = iso(0, SPLAY, 0);
  const LOCAL_H = 40;
  const vx = (foot[0] - apex[0]) / LOCAL_H;
  const vy = (foot[1] - apex[1]) / LOCAL_H;
  const inBoard = `matrix(1 0.5 ${vx} ${vy} ${apex[0]} ${apex[1]})`;
  return (
    <g>
      {/* The far board, then the near one over it. */}
      <path
        d={path(board(-SPLAY))}
        fill="#4a3426"
        stroke="#3a2a1e"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
      <path
        d={path(board(SPLAY))}
        fill="#6b4a32"
        stroke="#3a2a1e"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
      {/* The slate inside the near board's frame. */}
      <path
        d={path([
          iso(-HW + 3, SPLAY - 0.4, 3),
          iso(HW - 3, SPLAY - 0.4, 3),
          iso(HW - 3, 0.4, H - 3),
          iso(-HW + 3, 0.4, H - 3),
        ])}
        fill="#2f3a35"
      />
      <g transform={inBoard} fill="#f6f1e6" fontFamily="DM Sans, sans-serif">
        <text x="0" y="11" textAnchor="middle" fontSize="6" fontWeight="700">
          {officeName}
        </text>
        <line
          x1="-9"
          y1="14.5"
          x2="9"
          y2="14.5"
          stroke="#f6f1e6"
          strokeWidth="0.5"
          opacity="0.6"
        />
        {rows.map((r, i) => (
          <g key={r.id}>
            <path
              d={`M-11 ${19.5 + i * 6} L-8 ${19.5 + i * 6} M-9 ${18.5 + i * 6} L-8 ${19.5 + i * 6} L-9 ${20.5 + i * 6}`}
              fill="none"
              stroke="#e8e1d2"
              strokeWidth="0.5"
              strokeLinecap="round"
            />
            <text x="-6" y={21 + i * 6} fontSize="4.4" fill="#e8e1d2">
              {r.name}
            </text>
          </g>
        ))}
      </g>
      {/* The hinge strap over the apex. */}
      <path
        d={`M${iso(-HW + 2, -1.5, H - 1).join(" ")} L${iso(HW - 2, -1.5, H - 1).join(" ")} L${iso(HW - 2, 1.5, H - 1).join(" ")} L${iso(-HW + 2, 1.5, H - 1).join(" ")} Z`}
        fill="#8a6a4a"
      />
    </g>
  );
}

export function ReceptionCounter({ back = "far" }: { back?: "far" | "near" }) {
  const w = 86,
    d = 24,
    h = 32;
  const body = "#8b6a4a";
  // The viewer always sees the b = +d/2 face. Which side of the counter that
  // is depends on the facing: the customer side, panelled in slats, or the
  // staff side, which is open shelving with the day's clutter in it (Marc,
  // 2026-09-06). The things standing ON the counter swap sides with it.
  const staffSide = back === "near";
  const fb = staffSide ? -1 : 1;
  const front = d / 2;
  return (
    <g>
      <IsoBox w={w} d={d} h={h - 3} color={body} />
      {staffSide ? (
        <g>
          {/* The working side: a recess under the counter with two shelves,
              boxed in by a frame so the carcass still reads as solid wood. */}
          <path
            d={poly([
              [-w / 2 + 4, front, 3],
              [w / 2 - 4, front, 3],
              [w / 2 - 4, front, h - 7],
              [-w / 2 + 4, front, h - 7],
            ])}
            fill={shade(body, 0.45)}
          />
          {[11, 19].map((z) => (
            <path
              key={z}
              d={poly([
                [-w / 2 + 4, front, z],
                [w / 2 - 4, front, z],
                [w / 2 - 4, front, z + 1.5],
                [-w / 2 + 4, front, z + 1.5],
              ])}
              fill={shade(body, 1.05)}
            />
          ))}
          {/* Two dividers, so the recess reads as cubbies. */}
          {[-14, 14].map((a) => (
            <path
              key={a}
              d={poly([
                [a, front, 3],
                [a + 1.5, front, 3],
                [a + 1.5, front, h - 7],
                [a, front, h - 7],
              ])}
              fill={shade(body, 0.95)}
            />
          ))}
          {/* Folders standing in the left cubby. */}
          {["#c0392b", "#e8b64c", "#2e86ab", "#7f9c86"].map((col, i) => (
            <path
              key={col}
              d={poly([
                [-w / 2 + 8 + i * 5, front, 20.5],
                [-w / 2 + 12 + i * 5, front, 20.5],
                [-w / 2 + 12 + i * 5, front, 20.5 + 9 - (i % 2)],
                [-w / 2 + 8 + i * 5, front, 20.5 + 9 - (i % 2)],
              ])}
              fill={col}
              stroke="rgba(0,0,0,0.25)"
              strokeWidth="0.3"
            />
          ))}
          {/* A storage box in the middle cubby, and a stack of paper below. */}
          <path
            d={poly([
              [-6, front, 12.5],
              [8, front, 12.5],
              [8, front, 18.5],
              [-6, front, 18.5],
            ])}
            fill="#b6a68c"
            stroke={shade(body, 0.5)}
            strokeWidth="0.4"
          />
          <path
            d={poly([
              [-2, front, 15],
              [4, front, 15],
              [4, front, 16],
              [-2, front, 16],
            ])}
            fill="#8d8371"
          />
          <path
            d={poly([
              [-4, front, 4],
              [10, front, 4],
              [10, front, 9],
              [-4, front, 9],
            ])}
            fill="#f1ece0"
            stroke="#c9c1b4"
            strokeWidth="0.3"
          />
          {/* The right cubby keeps a waste basket. */}
          <path
            d={poly([
              [22, front, 3],
              [34, front, 3],
              [32, front, 13],
              [24, front, 13],
            ])}
            fill="#6f7a80"
            stroke={shade("#6f7a80", 0.7)}
            strokeWidth="0.4"
          />
        </g>
      ) : (
        /* The public side: panel slats. */
        Array.from({ length: 9 }, (_, i) => {
          const a = -w / 2 + 5 + i * 9.5;
          return (
            <path
              key={i}
              d={`M${iso(a, front, 3).join(" ")} L${iso(a, front, h - 6).join(" ")}`}
              stroke={shade(body, 0.7)}
              strokeWidth="0.6"
            />
          );
        })
      )}
      <IsoBox
        w={w + 4}
        d={d + 4}
        h={3}
        z={h - 3}
        color="#e8d8bf"
        top="#f3e8d3"
      />
      {/* Bell */}
      <g transform={`translate(${iso(-20 * fb, fb * -2, h).join(" ")})`}>
        <ellipse cx="0" cy="0" rx="4.5" ry="2" fill="#a88a3c" />
        <path d="M-4 -1 A4 4 0 0 1 4 -1 L4 0 L-4 0 Z" fill="#e2c15a" />
        <circle cx="0" cy="-5" r="1" fill="#e2c15a" />
        <path
          d="M-2 -3 q2 -1 4 0"
          fill="none"
          stroke="#fff"
          strokeWidth="0.6"
          opacity="0.7"
        />
      </g>
      {/* Vase with tulips */}
      <g transform={`translate(${iso(22 * fb, fb * -3, h).join(" ")})`}>
        <path d="M-3 0 L3 0 L2.4 -8 Q0 -10 -2.4 -8 Z" fill="#7fb3c8" />
        <path
          d="M-1 -8 q-3 -6 -5 -12 M0 -8 q0 -7 1 -13 M1 -8 q3 -5 5 -11"
          fill="none"
          stroke="#4d8a4a"
          strokeWidth="0.8"
        />
        <ellipse cx="-5.5" cy="-21" rx="2" ry="2.6" fill="#e0567a" />
        <ellipse cx="1.4" cy="-22" rx="2" ry="2.6" fill="#f2b134" />
        <ellipse cx="6.5" cy="-20" rx="2" ry="2.6" fill="#e0567a" />
      </g>
      {/* The isomux cube from ui/icon.svg, as a desk ornament: same eight
          faces at 0.6 scale, standing on its bottom vertex. */}
      <g
        transform={`translate(${iso(7 * fb, fb * -3, h).join(" ")}) scale(0.6) translate(-16 -30)`}
      >
        <polygon points="2,10 16,18 16,30 2,22" fill="#209050" />
        <polygon points="30,10 16,18 16,30 30,22" fill="#186840" />
        <polygon points="16,8 24,12.5 16,17 8,12.5" fill="#0d1117" />
        <text
          x="16"
          y="14.5"
          textAnchor="middle"
          fontSize="6"
          fontFamily="monospace"
          fontWeight="bold"
          fill="#E6F5EC"
        >
          {">_"}
        </text>
        <polygon points="16,2 2,10 8,12.5 16,8" fill="#3AC874" />
        <polygon points="16,2 30,10 24,12.5 16,8" fill="#4BE88A" />
        <polygon points="2,10 16,18 16,17 8,12.5" fill="#30B76A" />
        <polygon points="30,10 16,18 16,17 24,12.5" fill="#41D57E" />
      </g>
      {/* A stack of papers */}
      <path
        d={poly([
          [4 * fb, fb * 2, h],
          [16 * fb, fb * 2, h],
          [16 * fb, fb * 10, h],
          [4 * fb, fb * 10, h],
        ])}
        fill="#f4efe4"
        stroke="#c9c1b4"
        strokeWidth="0.4"
      />
      <path
        d={poly([
          [5 * fb, fb * 3, h + 1],
          [17 * fb, fb * 3, h + 1],
          [17 * fb, fb * 11, h + 1],
          [5 * fb, fb * 11, h + 1],
        ])}
        fill="#fbf8f1"
        stroke="#c9c1b4"
        strokeWidth="0.4"
      />
    </g>
  );
}
