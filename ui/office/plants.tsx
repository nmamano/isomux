// Shared plant drawing for the office scene.
//
// Three places grow plants: the window-sill plant in Floor.tsx, the corner
// floor plant in RoomProps.tsx, and the small desk plants in DeskSprite.tsx.
// The leaf and blossom shapes and the tones live here so they read as one
// set instead of three unrelated sketches, and so a change to the leaf lands
// everywhere at once.
//
// Nothing here refers to a gradient or filter by url(). Every shape is flat
// fills and explicit shading paths, so a caller can drop one into any SVG in
// the scene without carrying defs along or minting ids that collide.

export const LEAF_TONES = ["#5aa85c", "#46934a", "#377b3d", "#4e9d54"];
export const BACK_LEAF_TONES = ["#2f6a37", "#356f3b", "#285c30", "#316a38"];

// Golden-pothos marbling, picked per leaf. Leaves on the far side of a plant
// stay plain: marbling them flattens the depth.
export const MARBLE_TONES = ["#e4ecab", "#f0e9c8"];
export const BLOSSOM_TONES = ["#ef8fa2", "#f6ecdc", "#f0a77e"];

// A five-petal blossom, petals swung around the origin. The pale ring and
// the gold eye give it a centre to read at scene scale, where the whole
// flower is only three or four units across.
export function Blossom({
  x,
  y,
  size,
  tone,
}: {
  x: number;
  y: number;
  size: number;
  tone: string;
}) {
  const s = size;
  return (
    <g
      transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}
      aria-hidden="true"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <ellipse
          key={i}
          cx="0"
          cy={-0.58 * s}
          rx={0.34 * s}
          ry={0.58 * s}
          transform={`rotate(${i * 72})`}
          fill={tone}
        />
      ))}
      <circle r={0.4 * s} fill="#fff" opacity="0.32" />
      <circle r={0.26 * s} fill="#f0c04a" />
    </g>
  );
}

// One leaf: base at the origin, tip up at rotation 0. The darker half and
// the midrib give it a fold instead of reading as a flat blob.
export function Leaf({
  x,
  y,
  angle,
  size,
  tone,
  varTone,
  varBig,
}: {
  x: number;
  y: number;
  angle: number;
  size: number;
  tone: string;
  varTone?: string;
  varBig?: boolean;
}) {
  const s = size;
  const vw = varBig ? 1 : 0.62;
  return (
    <g
      transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${angle.toFixed(1)})`}
    >
      <path
        d={`M0 0 C${-0.3 * s} ${-0.1 * s} ${-0.58 * s} ${-0.5 * s} ${-0.42 * s} ${-0.95 * s} C${-0.3 * s} ${-1.24 * s} ${-0.12 * s} ${-1.32 * s} 0 ${-1.38 * s} C${0.12 * s} ${-1.32 * s} ${0.3 * s} ${-1.24 * s} ${0.42 * s} ${-0.95 * s} C${0.58 * s} ${-0.5 * s} ${0.3 * s} ${-0.1 * s} 0 0 Z`}
        fill={tone}
      />
      {/* Marbling sits between the leaf and its shaded half, so the fold
          still darkens it and the leaf does not go flat. */}
      {varTone && (
        <path
          d={`M0 ${-0.14 * s} C${-0.34 * vw * s} ${-0.42 * s} ${-0.5 * vw * s} ${-0.8 * s} ${-0.28 * vw * s} ${-1.08 * s} C${-0.15 * vw * s} ${-1.24 * s} ${-0.04 * s} ${-1.2 * s} 0 ${-1.05 * s} Z`}
          fill={varTone}
        />
      )}
      <path
        d={`M0 0 C${0.3 * s} ${-0.1 * s} ${0.58 * s} ${-0.5 * s} ${0.42 * s} ${-0.95 * s} C${0.3 * s} ${-1.24 * s} ${0.12 * s} ${-1.32 * s} 0 ${-1.38 * s} Z`}
        fill="#1d4526"
        opacity="0.3"
      />
      <path
        d={`M0 ${-0.08 * s} L0 ${-1.22 * s}`}
        stroke="#b6e2b8"
        strokeWidth={Math.max(0.3, s * 0.07)}
        opacity="0.4"
      />
    </g>
  );
}

// A terracotta pot standing on a horizontal surface, drawn from its centre
// at the rim. Every horizontal surface in the scene - floor, desktop, window
// sill - lies on the same two axes, so a circle standing on any of them
// projects to the same 2:1 ellipse and one pot serves all three.
//
// The cone is split into a lit left face and a shaded right face rather than
// filled with a gradient, so it needs no defs and can be dropped into any
// SVG in the scene.
export function Pot({
  x,
  y,
  rimRx,
  height,
  taper = 0.72,
}: {
  x: number;
  y: number;
  rimRx: number;
  height: number;
  taper?: number;
}) {
  const rimRy = rimRx / 2;
  const lipRx = rimRx * 0.92;
  const lipH = Math.max(1.4, height * 0.17);
  const baseRx = rimRx * taper;
  const baseY = y + height;
  const bodyTop = y + lipH;
  return (
    <g aria-hidden="true">
      {/* Contact shadow, offset the way every other shadow in the scene is */}
      <ellipse
        cx={x + rimRx * 0.1}
        cy={baseY + rimRy * 0.3}
        rx={baseRx * 1.25}
        ry={baseRx * 0.42}
        fill="#000"
        opacity="0.2"
      />
      {/* Cone, split along its front-most line - where a real cylinder's
          terminator falls. Both halves end on the ellipses' FRONT points
          (y + semi-minor), not on their centres: ending at the centre leaves
          a notch bitten out of the base. */}
      <path
        d={`M${x - lipRx} ${bodyTop} A${lipRx} ${lipRx / 2} 0 0 0 ${x} ${bodyTop + lipRx / 2} L${x} ${baseY + baseRx / 2} A${baseRx} ${baseRx / 2} 0 0 1 ${x - baseRx} ${baseY} Z`}
        fill="#b9704e"
      />
      <path
        d={`M${x} ${bodyTop + lipRx / 2} A${lipRx} ${lipRx / 2} 0 0 0 ${x + lipRx} ${bodyTop} L${x + baseRx} ${baseY} A${baseRx} ${baseRx / 2} 0 0 1 ${x} ${baseY + baseRx / 2} Z`}
        fill="#9c5b3b"
      />
      {/* Rim: full ellipse, soil, then the lip's front band over both */}
      <ellipse cx={x} cy={y} rx={rimRx} ry={rimRy} fill="#c8825e" />
      <ellipse
        cx={x}
        cy={y + rimRy * 0.08}
        rx={rimRx * 0.82}
        ry={rimRy * 0.82}
        fill="#493425"
      />
      <path
        d={`M${x - rimRx} ${y} A${rimRx} ${rimRy} 0 0 0 ${x + rimRx} ${y} L${x + rimRx} ${y + lipH} A${rimRx} ${rimRy} 0 0 1 ${x - rimRx} ${y + lipH} Z`}
        fill="#bb7550"
      />
      <path
        d={`M${x} ${y + rimRy} A${rimRx} ${rimRy} 0 0 0 ${x + rimRx} ${y} L${x + rimRx} ${y + lipH} A${rimRx} ${rimRy} 0 0 1 ${x} ${y + rimRy + lipH} Z`}
        fill="#8b4c30"
        opacity="0.55"
      />
    </g>
  );
}

// --- The west-corner floor plant -------------------------------------------
// An upright arching shrub, drawn at the origin with the pot's rim at y=0 so
// the caller places and scales it.
//
// Stems are generated, not drawn. x moves out as t squared, so a stem leaves
// the pot upright and only bends outward near its tip; y eases as it rises,
// so the arch flattens at the top. Leaves are read off the same curve and
// squared to its tangent, exactly as the window plant's are, and the first
// CORNER_BACK_STEMS entries are the far side: darker, and never marbled.
const CORNER_BACK_STEMS = 2;
// [x at the soil, sideways reach at the tip, height, leaves, phase]
type ArchStem = [number, number, number, number, number];
const CORNER_STEMS: ArchStem[] = [
  [-2, -7, 26, 5, 0.6],
  [2, 6.5, 23, 4, 3.4],
  [-2.5, -9, 32, 6, 1.9],
  [-0.8, -3, 41, 7, 4.6],
  [1.2, 3.5, 36, 6, 2.7],
  [2.8, 8.5, 28, 5, 5.5],
];
function archStemXY(
  stem: ArchStem,
  t: number,
): [number, number] {
  const [x0, reach, height, , phase] = stem;
  return [
    x0 + reach * t * t + 0.7 * t * Math.sin(phase + t * 2.8),
    0.6 - height * t * (1.3 - 0.3 * t),
  ];
}

function archStemPath(stem: ArchStem): string {
  let d = "";
  for (let i = 0; i <= 16; i++) {
    const [x, y] = archStemXY(stem, i / 16);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

function archStemLeaves(
  stem: ArchStem,
  si: number,
  back: boolean,
  leafSize: number,
  tipSize: number,
  // A desk plant's leaf is about three units across. Marbling it just makes
  // the whole sprig paler, so the caller turns it off.
  marbled = true,
) {
  const count = stem[3];
  const phase = stem[4];
  const tones = back ? BACK_LEAF_TONES : LEAF_TONES;
  const out = [];
  const leafAt = (t: number, angleOffset: number, size: number, i: number) => {
    const [x, y] = archStemXY(stem, t);
    const [ax, ay] = archStemXY(stem, Math.max(0, t - 0.04));
    const [bx, by] = archStemXY(stem, Math.min(1, t + 0.04));
    const along = (Math.atan2(bx - ax, -(by - ay)) * 180) / Math.PI;
    const marble = (si * 5 + i * 3) % 4;
    return (
      <Leaf
        key={`s${si}l${i}`}
        x={x}
        y={y}
        angle={along + angleOffset}
        size={size}
        tone={tones[(si * 3 + i) % tones.length]}
        varTone={
          marbled && !back && marble < 3
            ? MARBLE_TONES[(si + i) % MARBLE_TONES.length]
            : undefined
        }
        varBig={marble === 0}
      />
    );
  };
  for (let i = 0; i < count; i++) {
    const t = 0.18 + (i / Math.max(1, count - 1)) * 0.7;
    const side = i % 2 === 0 ? 1 : -1;
    out.push(
      leafAt(
        t,
        side * (48 + 18 * Math.sin(phase + i * 1.9)),
        leafSize * (1 - 0.26 * t),
        i,
      ),
    );
  }
  // A terminal leaf square on the tip, so a stem ends in a leaf and not in a
  // bare stroke.
  out.push(leafAt(1, 0, tipSize, count));
  return out;
}

export function CornerPlant() {
  return (
    <g aria-hidden="true">
      <Pot x={0} y={0} rimRx={10} height={20} />
      <g opacity="0.82">
        {CORNER_STEMS.slice(0, CORNER_BACK_STEMS).map((s, i) => (
          <path
            key={`bs${i}`}
            d={archStemPath(s)}
            fill="none"
            stroke="#2c6434"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ))}
        {CORNER_STEMS.slice(0, CORNER_BACK_STEMS).map((s, i) =>
          archStemLeaves(s, i, true, 5.4, 4.8),
        )}
      </g>
      {CORNER_STEMS.slice(CORNER_BACK_STEMS).map((s, i) => (
        <path
          key={`s${i}`}
          d={archStemPath(s)}
          fill="none"
          stroke={i % 2 === 0 ? "#3f8446" : "#356f3b"}
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      ))}
      {CORNER_STEMS.slice(CORNER_BACK_STEMS).map((s, i) =>
        archStemLeaves(s, i + CORNER_BACK_STEMS, false, 6.4, 5.6),
      )}
    </g>
  );
}

// --- Blossom jar -----------------------------------------------------------
// A jar of cherry blossom for the window sill. Its bottom is nearly flat:
// the sill ledge is only 8 units deep and rises 1 unit for every 2 to the
// right, so every unit the body bulges below the group origin is a unit
// of slide the jar loses before it overhangs the front lip. Drawn by Worker 6 on the
// visual2-slot lane as a seasonal item; Nil's call on 2026-09-05 was to keep
// it permanently, standing next to the window plant, so it moved here.
//
// Drawn at the origin with the jar's base at (0,0), so the caller places it.
// It must land ON the sill line or it floats - Floor.tsx owns that line and
// does the placing. The base and rim ellipses carry rotate(-26.565) so they
// lie in the sill's plane at the scene's 2:1 ratio; a rotation of
// atan(0.5) = 26.565 degrees is what turns a plain ellipse onto that plane.
// Keep it if the jar moves.
//
// The two drifting petals are SMIL, like the cat's tail and the window stars.
// The host layer must stay pointer-events: none, or the jar steals the
// window's "Change theme" click.
// Branches: a polyline per limb, drawn as segments whose width falls from w
// to a bit under half of it. An SVG stroke cannot taper, and round caps make
// the step between segments invisible, so this is a taper for the price of a
// stroke. The two mains start below the water line so they read through the
// glass. {pts, w}
const JAR_BRANCHES: Array<{ pts: Array<[number, number]>; w: number }> = [
  {
    pts: [
      [-1, -4],
      [-2.5, -14],
      [-5, -25],
      [-8, -35],
      [-11.5, -45],
    ],
    w: 1.8,
  },
  {
    pts: [
      [1, -4],
      [2, -14],
      [3.5, -25],
      [6, -34],
      [8, -42],
    ],
    w: 1.5,
  },
  {
    pts: [
      [-5, -25],
      [-9, -29],
      [-13.2, -33.6],
    ],
    w: 1,
  },
  {
    pts: [
      [-8, -35],
      [-4.5, -39],
      [-1.6, -43],
    ],
    w: 0.9,
  },
  {
    pts: [
      [3.5, -25],
      [7, -28],
      [10, -32],
    ],
    w: 0.9,
  },
  {
    pts: [
      [6, -34],
      [3.4, -38],
      [1.4, -41.5],
    ],
    w: 0.8,
  },
];

const SAKURA_TONES = ["#F8D0DF", "#F3B9CE", "#EFA6C0"];
// Behind the branches, so the cluster has depth rather than sitting in one
// plane. [x, y, size, tone]
const JAR_BACK_BLOOMS: Array<[number, number, number, number]> = [
  [-7.5, -30.5, 2, 2],
  [3.5, -34, 1.9, 2],
  [-9, -42, 2.1, 2],
];
// In front. [x, y, size, tone, bud]
const JAR_BLOOMS: Array<[number, number, number, number, number]> = [
  [-9, -26, 2.3, 1, 0],
  [-3, -33, 2.6, 0, 0],
  [4, -29, 2.2, 2, 0],
  [-13.2, -34.4, 2.5, 1, 0],
  [-6, -41, 2.7, 0, 0],
  [2, -38, 2.4, 2, 0],
  [10, -32.8, 2.3, 1, 0],
  [-11.4, -45.8, 2.6, 2, 0],
  [-1.6, -43.8, 2.4, 0, 0],
  [8, -42.8, 2.5, 1, 0],
  [-14.6, -30, 1.5, 0, 1],
  [1.4, -42.3, 1.4, 2, 1],
  [11.2, -36.4, 1.3, 1, 1],
  [-5.5, -20.6, 1.5, 1, 1],
];

// A cherry blossom: five petals, each notched at the tip the way a real
// sakura petal is. That notch is the whole difference between reading as
// blossom and reading as a pink dot, which is what a plain circle gives you.
function SakuraBloom({
  x,
  y,
  size,
  tone,
  rot,
}: {
  x: number;
  y: number;
  size: number;
  tone: string;
  rot: number;
}) {
  const s = size;
  const petal = `M0 0 C${-0.44 * s} ${-0.16 * s} ${-0.56 * s} ${-0.62 * s} ${-0.3 * s} ${-0.93 * s} C${-0.17 * s} ${-1.06 * s} ${-0.06 * s} ${-1} 0 ${-0.86 * s} C${0.06 * s} ${-1} ${0.17 * s} ${-1.06 * s} ${0.3 * s} ${-0.93 * s} C${0.56 * s} ${-0.62 * s} ${0.44 * s} ${-0.16 * s} 0 0 Z`;
  return (
    <g
      transform={`translate(${x} ${y}) rotate(${rot})`}
      aria-hidden="true"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <path
          key={i}
          d={petal}
          fill={tone}
          transform={`rotate(${i * 72}) translate(0 ${-0.22 * s})`}
        />
      ))}
      <circle r={0.3 * s} fill="#FBE9C4" />
      {/* Stamens: three specks, enough to read as a centre at this size */}
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx={Math.cos((i * 2.1 + 0.5) * 1) * 0.34 * s}
          cy={Math.sin((i * 2.1 + 0.5) * 1) * 0.34 * s}
          r={0.11 * s}
          fill="#D98BA8"
        />
      ))}
    </g>
  );
}

// A bud: closed, so an oval with a small calyx rather than an open flower.
function SakuraBud({
  x,
  y,
  size,
  tone,
  rot,
}: {
  x: number;
  y: number;
  size: number;
  tone: string;
  rot: number;
}) {
  const s = size;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`} aria-hidden="true">
      {/* Calyx first. Painted over the bud instead, it swallows it and the
          bud reads as a dark smudge rather than a flower about to open. */}
      <path
        d={`M${-0.42 * s} ${0.05 * s} Q0 ${-0.5 * s} ${0.42 * s} ${0.05 * s} Q0 ${0.3 * s} ${-0.42 * s} ${0.05 * s} Z`}
        fill="#5E4029"
      />
      <ellipse cx="0" cy={-0.62 * s} rx={0.6 * s} ry={0.92 * s} fill={tone} />
      <ellipse
        cx={-0.19 * s}
        cy={-0.74 * s}
        rx={0.22 * s}
        ry={0.46 * s}
        fill="#FBE3EC"
        opacity="0.55"
      />
    </g>
  );
}

function jarBranch(
  br: (typeof JAR_BRANCHES)[number],
  key: string,
  tone: string,
) {
  const segs = [];
  for (let i = 0; i < br.pts.length - 1; i++) {
    const f = i / Math.max(1, br.pts.length - 2);
    segs.push(
      <path
        key={`${key}-${i}`}
        d={`M${br.pts[i][0]} ${br.pts[i][1]} L${br.pts[i + 1][0]} ${br.pts[i + 1][1]}`}
        stroke={tone}
        strokeWidth={(br.w * (1 - 0.55 * f)).toFixed(2)}
        strokeLinecap="round"
        fill="none"
      />,
    );
  }
  return segs;
}

export function BlossomJar() {
  return (
    <g aria-hidden="true">
      {/* The far side of the glass and the far half of the water, drawn
          BEFORE the stems. Without them a stem has nothing behind it, so it
          reads as passing behind the jar rather than standing in it. The
          front faces further down are translucent enough that this shows
          through, which is what puts the stems between two panes of glass. */}
      <path d="M-5.4 -15.5 A5.4 2.7 0 0 1 5.4 -15.5 Q7 -13 6 -3 Q0 0.4 -6 -3 Q-7 -13 -5.4 -15.5 Z" fill="#6E9BAE" opacity="0.5" />
      <path
        d="M-6 -7.4 Q0 -3.6 6 -7.4 Q6.4 -4.6 6 -3 Q0 0.4 -6 -3 Q-6.4 -4.6 -6 -7.4 Z"
        fill="#54879E"
        opacity="0.55"
      />
      {/* The FAR lip of the mouth, also before the branches. The rim used to
          be one closed ellipse drawn last, which cut every stem at both lips.
          A stem going into a jar passes in FRONT of the far lip and BEHIND
          the near one, so the two halves belong on opposite sides of the
          branches. */}
      <path
        d="M-5.4 -15.5 A5.4 2.7 0 0 1 5.4 -15.5"
        fill="none"
        stroke="#DCEFF6"
        strokeWidth="0.85"
        opacity="0.38"
      />

      {/* Blossoms behind the branches first, then the branches over them */}
      {JAR_BACK_BLOOMS.map(([x, y, size, tone], i) => (
        <SakuraBloom
          key={`bb${i}`}
          x={x}
          y={y}
          size={size}
          tone={SAKURA_TONES[tone]}
          rot={i * 41}
        />
      ))}
      {JAR_BRANCHES.map((br, i) =>
        jarBranch(br, `br${i}`, i % 2 === 0 ? "#6B4A32" : "#5E4029"),
      )}
      {JAR_BLOOMS.map(([x, y, size, tone, bud], i) =>
        bud ? (
          <SakuraBud
            key={`fb${i}`}
            x={x}
            y={y}
            size={size}
            tone={SAKURA_TONES[tone]}
            rot={i * 53 - 20}
          />
        ) : (
          <SakuraBloom
            key={`fb${i}`}
            x={x}
            y={y}
            size={size}
            tone={SAKURA_TONES[tone]}
            rot={i * 37}
          />
        ),
      )}

      {/* Petals drifting down past the pane. The fall sways, because a petal
          that drops on a straight line reads as a bug, not as a petal. */}
      {[
        [-16, 0],
        [11, 1.7],
      ].map(([x, delay], i) => (
        <g key={`dp${i}`}>
          <path
            d="M0 0 C-1.9 -0.5 -2.2 -1.9 -0.9 -2.6 C-0.3 -2.9 0.4 -2.7 0.9 -2.1 C1.8 -1.1 1.3 -0.2 0 0 Z"
            fill="#F3B9CE"
            opacity="0"
          >
            <animate
              attributeName="opacity"
              values="0;0.9;0.9;0"
              dur="6s"
              begin={`${delay}s`}
              repeatCount="indefinite"
            />
          </path>
          <animateTransform
            attributeName="transform"
            type="translate"
            values={`${x} -40; ${x - 2.6} -28; ${x + 1.6} -17; ${x - 0.8} -6`}
            dur="6s"
            begin={`${delay}s`}
            repeatCount="indefinite"
          />
        </g>
      ))}

      {/* Jar: lit left face, shaded right face, rim and water line. The
          branches already run down past the mouth, so the translucent faces
          land on top of them and the stems read through the glass. */}
      {/* The mouth is a circle seen in iso, so the top of the silhouette is
          the BACK half of that ellipse. It used to be a straight L across,
          which read as a hard horizontal line cutting the top of the jar. */}
      {/* The near face starts at the FRONT lip, not the back one. Between
          the two lips you are looking through the mouth, where there is no
          near glass to tint what is behind it - so that strip of stem stays
          clear, over the far wall. */}
      <path
        d="M-5.4 -15.5 A5.4 2.7 0 0 0 5.4 -15.5 Q7 -13 6 -3 Q0 0.4 -6 -3 Q-7 -13 -5.4 -15.5 Z"
        fill="#9FCEDF"
        opacity="0.42"
      />
      {/* The shaded face's bottom edge is the body's own bottom curve, split
          at x=1 rather than redrawn by eye. The body bottom is
          Q(6,-3) ctrl(0,0.4) (-6,-3); solving 6-12t=1 gives t=5/12, and de
          Casteljau at that t gives control (3.5,-1.58) and end (1,-1.35).
          The hand-drawn edge it replaced ended at y=-0.4, a whole unit BELOW
          the base, so the face hung out under the jar as a thin tab. */}
      <path
        d="M0 -12.8 A5.4 2.7 0 0 0 5.4 -15.5 Q7 -13 6 -3 Q3.5 -1.58 1 -1.35 Z"
        fill="#5E93A8"
        opacity="0.45"
      />
      <path
        d="M-6 -7.4 Q0 -3.6 6 -7.4 Q6.4 -4.6 6 -3 Q0 0.4 -6 -3 Q-6.4 -4.6 -6 -7.4 Z"
        fill="#7FB6CC"
        opacity="0.5"
      />
      {/* The submerged stems again, shifted sideways: water displaces what
          you see through it, and the offset at the surface is the whole
          reason a jar of cut stems looks like glass and not like a cup. */}
      <g opacity="0.5">
        <path
          d="M-1.6 -6.6 L-2.2 -4"
          stroke="#6B4A32"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M1.6 -6.6 L2.2 -4"
          stroke="#5E4029"
          strokeWidth="1.3"
          strokeLinecap="round"
          fill="none"
        />
      </g>
      <path
        d="M-4.4 -14.4 Q-5.4 -9 -4.6 -4.6"
        stroke="#EAF6FB"
        strokeWidth="1.2"
        fill="none"
        opacity="0.65"
      />
      <path
        d="M4.9 -13.6 Q5.6 -10 5.2 -6.4"
        stroke="#EAF6FB"
        strokeWidth="0.6"
        fill="none"
        opacity="0.35"
      />
      {/* Axis-aligned and 2:1. The jar's mouth is a circle on a HORIZONTAL
          surface, and the two axes of any horizontal surface here project to
          slopes of +0.5 and -0.5; their bisectors, which are the ellipse's
          axes, come out horizontal and vertical at 2:1. The -26.565 degree
          tilt this carried is atan(0.5), which is the tilt for a circle lying
          in the WALL plane, not on a ledge. Same reasoning as the plant pot's
          rim. The jar's contact shadow is drawn by Floor.tsx instead, which
          owns the sill and can clip it to the ledge. */}
      <path
        d="M5.4 -15.5 A5.4 2.7 0 0 1 -5.4 -15.5"
        fill="none"
        stroke="#DCEFF6"
        strokeWidth="0.85"
        opacity="0.6"
      />
    </g>
  );
}

// --- Desk plants -----------------------------------------------------------
// The little pot on a desk, drawn at the origin with the pot's rim at (0,0).
// Five silhouettes, kept from the shapes DeskSprite.tsx used to draw as three
// bare quadratic strokes, so which desk gets which does not change.
//
// These are small: the pot is eight units across and a leaf about three, so
// there is no back layer and no marbling. Both read as noise at this size and
// only make the sprig paler.
const DESK_PLANT_VARIANTS: ArchStem[][] = [
  // Upright bushy
  [
    [-0.5, -3, 13, 3, 0.4],
    [0.5, 4.5, 11, 3, 2.6],
    [0, -1, 15, 3, 4.4],
  ],
  // Droopy fern
  [
    [-0.6, -7, 9, 3, 1.2],
    [0.6, 7, 8, 3, 3.8],
    [0, -1.5, 12, 3, 5.6],
  ],
  // Spiky succulent
  [
    [-0.5, -1.5, 14, 3, 0.9],
    [0.5, 2.5, 13, 3, 3.1],
    [-0.8, -3.5, 10, 2, 5.1],
  ],
  // Wide spreading
  [
    [-0.6, -8, 8, 3, 2.2],
    [0.8, 8, 7, 3, 4.7],
    [0, -0.5, 12, 3, 0.7],
  ],
  // Tall single stem with side shoots
  [
    [0, -0.5, 16, 4, 1.7],
    [-0.4, -5, 10, 2, 3.3],
    [0.6, 4.5, 9, 2, 5.9],
  ],
];

export const DESK_PLANT_COUNT = DESK_PLANT_VARIANTS.length;

export function DeskPlant({ variant }: { variant: number }) {
  const stems = DESK_PLANT_VARIANTS[variant % DESK_PLANT_COUNT];
  return (
    <g aria-hidden="true">
      <Pot x={0} y={0} rimRx={4} height={7} taper={0.76} />
      {stems.map((stem, i) => (
        <path
          key={`ds${i}`}
          d={archStemPath(stem)}
          fill="none"
          stroke={i % 2 === 0 ? "#3f8446" : "#356f3b"}
          strokeWidth="0.9"
          strokeLinecap="round"
        />
      ))}
      {stems.map((stem, i) => archStemLeaves(stem, i, false, 3.2, 2.8, false))}
    </g>
  );
}
