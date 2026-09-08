import { IsoBox, IsoCylinder, iso, poly, shade } from "./iso.tsx";

// Seating. Every sofa is about two desks wide on the floor and faces the
// viewer (its back is on the far side, b = -d/2).

type Back = "far" | "near";

export interface SeatSpec {
  /** Overall footprint and the shell's total height. */
  w: number;
  d: number;
  /** Top of the plinth: everything above it is the shell and the seat. */
  seatZ: number;
  shellH: number;
  armW: number;
  backD: number;
  color: string;
  /** Seat sections. */
  seats: number;
  /** Scatter pillows: [a offset, colour, tilt, width]. */
  pillows?: Array<[number, string, number, number?]>;
  /** Drawn under the plinth (the loveseat's legs). */
  under?: React.ReactNode;
  /** Drawn on the backrest's inner face (the chesterfield's buttoning). */
  onBack?: (fb: number) => React.ReactNode;
  /** Drawn along the plinth's front top edge (the chesterfield's nails). */
  onPlinth?: (fb: number) => React.ReactNode;
}

/** Every sofa and armchair: a plinth, a shell standing on it, and a seat. */
function UpholsteredPiece({
  spec,
  back = "far",
}: {
  spec: SeatSpec;
  back?: Back;
}) {
  const { w, d, seatZ, shellH, armW, backD, color: c, seats } = spec;
  const fb = back === "far" ? 1 : -1;
  const armA = w / 2 - armW / 2;
  const shell = shellH - seatZ;
  // The parts carry a name so the draw order can be asserted in a test, and
  // so a reader of the DOM can see which way a piece is turned.
  const backRest = (
    <g key="back" data-part="back">
      <IsoBox
        w={w}
        d={backD}
        h={shell}
        b={fb * (-d / 2 + backD / 2)}
        z={seatZ}
        color={c}
      />
    </g>
  );
  const arms = [-armA, armA].map((a) => (
    <IsoBox
      key={`arm${a}`}
      w={armW}
      d={d - backD}
      h={shell}
      a={a}
      b={fb * (backD / 2)}
      z={seatZ}
      color={c}
    />
  ));
  const deck = (
    <g key="seat" data-part="seat">
      <SeatDeck
        key="deck"
        n={seats}
        w={w - 2 * armW}
        d={d - backD}
        b={fb * (backD / 2)}
        z={seatZ}
        color={shade(c, 1.07)}
      />
    </g>
  );
  const pillows = (spec.pillows ?? []).map(([a, col, tilt, pw], i) => (
    <Pillow
      key={`p${i}`}
      a={a}
      b={fb * -2}
      z={seatZ + 7}
      color={col}
      tilt={tilt}
      w={pw}
    />
  ));
  return (
    <g>
      {spec.under}
      {/* The plinth. The shell stands ON it, so below the seat the front is
          one face across the whole width: an arm carried down to the floor
          splits that face with a seam at each end. */}
      <IsoBox w={w} d={d} h={seatZ} color={shade(c, 0.85)} />
      {spec.onPlinth?.(fb)}
      {back === "far" ? (
        <>
          {backRest}
          {spec.onBack?.(fb)}
          {arms[0]}
          {deck}
          {pillows}
          {arms[1]}
        </>
      ) : (
        <>
          {deck}
          {arms}
          {backRest}
        </>
      )}
    </g>
  );
}

function SeatDeck({
  n,
  w,
  d,
  z,
  b = 0,
  h = 7,
  color,
}: {
  n: number;
  w: number;
  d: number;
  z: number;
  b?: number;
  h?: number;
  color: string;
}) {
  const seams = [];
  for (let i = 1; i < n; i++) {
    const a = -w / 2 + (w / n) * i;
    seams.push(
      <path
        key={`d${i}`}
        d={`M${iso(a, b - d / 2 + 1, z + h).join(" ")} L${iso(a, b + d / 2 - 1, z + h).join(" ")}`}
        stroke={shade(color, 0.66)}
        strokeWidth="0.8"
        strokeLinecap="round"
      />,
    );
  }
  const creases = [];
  for (let i = 0; i < n; i++) {
    const a = -w / 2 + (w / n) * (i + 0.5);
    const cw = w / n;
    creases.push(
      <path
        key={`c${i}`}
        d={`M${iso(a - cw / 2 + 3, b - d / 2 + 3, z + h).join(" ")} L${iso(a + cw / 2 - 3, b - d / 2 + 3, z + h).join(" ")}`}
        stroke={shade(color, 0.76)}
        strokeWidth="0.6"
        strokeLinecap="round"
        opacity="0.8"
      />,
    );
  }
  return (
    <g>
      {/* One box, not three: three cushions each carry their own side faces,
          and the end one's face lands in the arm's plane as a stray sliver. */}
      <IsoBox
        w={w}
        d={d}
        h={h}
        b={b}
        z={z}
        color={color}
        stroke={shade(color, 0.62)}
      />
      {seams}
      {creases}
    </g>
  );
}

function Pillow({
  a,
  b,
  z,
  color,
  tilt = 0,
  w = 14,
}: {
  a: number;
  b: number;
  z: number;
  color: string;
  tilt?: number;
  w?: number;
}) {
  // A flat square cushion: wide, low and thin, resting on the seat and leaning
  // on the back. A tall one reads as a ball or a box standing on end (Marc,
  // 2026-09-06). Drawn with its BASE on the origin so it sits on the cushion
  // under it.
  const h = w * 0.62;
  const t = 3; // thickness, in the iso plane
  const [x, y] = iso(a, b, z);
  return (
    <g transform={`translate(${x} ${y}) rotate(${tilt})`}>
      <path
        d={`M${-w / 2} 0 L${-w / 2} ${-h} L${-w / 2 + t} ${-h - t / 2} L${w / 2 + t} ${-h - t / 2} L${w / 2 + t} ${-t / 2} L${w / 2} 0 Z`}
        fill={shade(color, 0.82)}
        stroke={shade(color, 0.6)}
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
      <rect
        x={-w / 2}
        y={-h}
        width={w}
        height={h}
        rx="1.6"
        fill={color}
        stroke={shade(color, 0.6)}
        strokeWidth="0.5"
      />
      <path
        d={`M${-w / 2 + 2} ${-h + 2.2} q${w / 2 - 2} 1.4 ${w - 4} 0`}
        fill="none"
        stroke={shade(color, 0.78)}
        strokeWidth="0.6"
        strokeLinecap="round"
      />
    </g>
  );
}

export function SofaBoxy({ back }: { back?: "far" | "near" }) {
  const c = "#5f7d98";
  return (
    <UpholsteredPiece
      back={back}
      spec={{
        w: 84,
        d: 34,
        seatZ: 13,
        shellH: 31,
        armW: 7,
        backD: 9,
        color: c,
        seats: 3,
        pillows: [
          [-21, "#e2b07a", -7],
          [21, "#d99a62", 5],
        ],
      }}
    />
  );
}

export function SofaLoveseat({ back }: { back?: "far" | "near" }) {
  const c = "#d9a441";
  const w = 66,
    d = 32,
    legH = 6;
  return (
    <UpholsteredPiece
      back={back}
      spec={{
        w,
        d,
        seatZ: legH + 12,
        shellH: 34,
        armW: 9,
        backD: 9,
        color: c,
        seats: 2,
        pillows: [[-13, "#5c6f8a", -6, 12]],
        // Tapered legs, drawn under the plinth.
        under: (
          <>
            {(
              [
                [-w / 2 + 5, d / 2 - 4],
                [w / 2 - 5, d / 2 - 4],
                [w / 2 - 5, -d / 2 + 4],
              ] as Array<[number, number]>
            ).map(([a, b], i) => (
              <Leg key={i} a={a} b={b} h={legH} />
            ))}
          </>
        ),
      }}
    />
  );
}

export function SofaChesterfield({ back }: { back?: "far" | "near" }) {
  const c = "#7d3b3b";
  const w = 90,
    d = 36,
    armW = 12,
    backD = 12,
    seatZ = 14;
  return (
    <UpholsteredPiece
      back={back}
      spec={{
        w,
        d,
        seatZ,
        shellH: 36,
        armW,
        backD,
        color: c,
        seats: 3,
        // The buttoning, on whichever face of the backrest the viewer sees.
        onBack: (fb) => (
          <>
            {Array.from({ length: 10 }, (_, k) => {
              const i = k % 5;
              const j = Math.floor(k / 5);
              const a = -w / 2 + armW + 6 + i * ((w - 2 * armW - 12) / 4);
              const [x, y] = iso(a, fb * (-d / 2 + backD), seatZ + 8 + j * 8);
              return (
                <circle key={k} cx={x} cy={y} r={1.1} fill={shade(c, 0.6)} />
              );
            })}
          </>
        ),
        // Brass nail trim along the plinth's top edge, on the visible side.
        onPlinth: (fb) => (
          <>
            {Array.from({ length: 9 }, (_, i) => {
              const [x, y] = iso(-w / 2 + 5 + i * 10, fb * (d / 2), seatZ);
              return (
                <circle key={i} cx={x} cy={y + 1.4} r={0.7} fill="#d6b45a" />
              );
            })}
          </>
        ),
      }}
    />
  );
}

export function ArmchairClub({ back }: { back?: "far" | "near" }) {
  const c = "#8a5a3c";
  return (
    <UpholsteredPiece
      back={back}
      spec={{
        w: 36,
        d: 32,
        seatZ: 13,
        shellH: 31,
        armW: 8,
        backD: 9,
        color: c,
        seats: 1,
      }}
    />
  );
}

export function ArmchairEgg() {
  const c = "#9fb6a1";
  const [x, y] = iso(0, 0, 0);
  return (
    <g>
      {/* Pedestal */}
      <IsoCylinder r={9} h={3} color="#8a8f96" gradId="lobby-egg-base" />
      <IsoCylinder r={2.5} h={14} color="#8a8f96" gradId="lobby-egg-stem" />
      {/* Shell: a tall rounded back opening towards the viewer */}
      <path
        d={`M${x - 20} ${y - 18} Q${x - 22} ${y - 56} ${x} ${y - 58} Q${x + 22} ${y - 56} ${x + 20} ${y - 18} Q${x + 18} ${y - 8} ${x} ${y - 6} Q${x - 18} ${y - 8} ${x - 20} ${y - 18} Z`}
        fill={c}
        stroke={shade(c, 0.55)}
        strokeWidth="0.5"
      />
      {/* Inner cushion */}
      <path
        d={`M${x - 14} ${y - 18} Q${x - 15} ${y - 46} ${x} ${y - 48} Q${x + 15} ${y - 46} ${x + 14} ${y - 18} Q${x + 12} ${y - 10} ${x} ${y - 9} Q${x - 12} ${y - 10} ${x - 14} ${y - 18} Z`}
        fill={shade(c, 0.8)}
      />
      <ellipse cx={x} cy={y - 14} rx={12} ry={5} fill={shade(c, 1.1)} />
      <path
        d={`M${x - 8} ${y - 30} Q${x} ${y - 26} ${x + 8} ${y - 30}`}
        fill="none"
        stroke={shade(c, 0.65)}
        strokeWidth="0.7"
      />
    </g>
  );
}

// Used by other props that need a plain wooden leg.
export function Leg({ a, b, h }: { a: number; b: number; h: number }) {
  const [x, y] = iso(a, b, 0);
  return (
    <path
      d={`M${x - 1.5} ${y} L${x + 1.5} ${y} L${x + 1.2} ${y - h} L${x - 1.2} ${y - h} Z`}
      fill="#5a3f28"
    />
  );
}

export { poly };
