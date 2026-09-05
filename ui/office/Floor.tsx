import { useState, useEffect } from "react";
import {
  SCENE_W,
  SCENE_H,
  VB_X,
  VB_Y,
  isoXY,
  roomPaletteIndex,
} from "./grid.ts";
import { DESK_SLOTS } from "../../shared/desks.ts";
import {
  Leaf,
  Blossom,
  BlossomJar,
  LEAF_TONES,
  BACK_LEAF_TONES,
  MARBLE_TONES,
  BLOSSOM_TONES,
} from "./plants.tsx";
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
  position: "absolute",
  top: 0,
  left: 0,
  pointerEvents: "none",
};
const VB = `${VB_X} ${VB_Y} ${SCENE_W} ${SCENE_H}`;

// desk8Cable: the cable belongs to the desk at slot 8, so a room without
// that desk shows no cable.
export function Floor({ desk8Cable = true }: { desk8Cable?: boolean }) {
  // Floor diamond matches wall bottom edges (2:1 isometric ratio):
  // back=(120,40), left=(-260,230), right=(500,230), front=(120,420)
  const backX = 120,
    backY = 40;
  const rowDx = -47.5,
    rowDy = 23.75;
  const colDx = 47.5,
    colDy = 23.75;
  const N = 10;

  // Slab thickness, and the outer corners where the slab passes under the
  // wall (the wall footprint is 9 x 4.5 wider than the tile grid on each side).
  const SLAB_H = 14;
  const outerLeftX = -364,
    outerRightX = 604,
    outerY = 273;

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
        />,
      );
    }
  }

  // The slab sides carry the checkerboard down over the thickness, so each
  // front-edge tile continues as its own slab. The tile that meets the left
  // side is (N-1, i); the one that meets the right side is (i, N-1), so both
  // share the same parity. The first slab on each side reaches out to the
  // wall's outer corner.
  const slabs = [];
  for (let i = 0; i < N; i++) {
    const fill = `var(--floor-edge-${(N - 1 + i) % 2 === 0 ? "light" : "dark"}-`;
    const lx = i === 0 ? outerLeftX : -355 + i * colDx;
    const ly = i === 0 ? outerY : 277.5 + i * colDy;
    const lex = -355 + (i + 1) * colDx,
      ley = 277.5 + (i + 1) * colDy;
    const rx = i === 0 ? outerRightX : 595 - i * colDx;
    const ry = i === 0 ? outerY : 277.5 + i * colDy;
    const rex = 595 - (i + 1) * colDx,
      rey = 277.5 + (i + 1) * colDy;
    slabs.push(
      <path
        key={`sl-${i}`}
        d={`M${lx} ${ly} L${lex} ${ley} L${lex} ${ley + SLAB_H} L${lx} ${ly + SLAB_H} Z`}
        fill={`${fill}left)`}
        stroke="var(--floor-stroke)"
        strokeWidth="0.5"
      />,
      <path
        key={`sr-${i}`}
        d={`M${rx} ${ry} L${rex} ${rey} L${rex} ${rey + SLAB_H} L${rx} ${ry + SLAB_H} Z`}
        fill={`${fill}right)`}
        stroke="var(--floor-stroke)"
        strokeWidth="0.5"
      />,
    );
  }

  // Desk 8 (slot index 7) is the desk nearest the visible floor edge, so its
  // cable is the one that can reach the lip and fall over it. Reading the
  // slot through isoXY keeps the cable on the desk if the slot table moves.
  const desk8 = isoXY(DESK_SLOTS[7].row, DESK_SLOTS[7].col);
  // The front-left edge runs from the slab's left corner along the column
  // axis, so its slope is colDy/colDx.
  const leftCornerX = backX + N * rowDx,
    leftCornerY = backY + N * rowDy;
  const edgeY = (x: number) =>
    leftCornerY + (x - leftCornerX) * (colDy / colDx);
  // Where the cable goes over the lip.
  const lipX = desk8.x - 65,
    lipY = edgeY(lipX);
  // Along the floor: the run starts inside the desk's front panel, so the
  // cable has no loose end - it emerges past the near leg on its own. The
  // desk sprite is a sibling DOM layer drawn after this SVG, so it occludes
  // whatever of the run passes under it. Points are offsets from the desk's
  // floor point, so the whole route travels with the desk.
  //
  // The slack is coiled on the floor on the way, the way a too-long cable
  // always is. The coil lies flat, so it is a 2:1 ellipse like everything
  // else on the floor, and it winds inward as it goes - without that the
  // second lap would land on the first and the coil would read as one thick
  // ring instead of a wound cable.
  //
  // Three curves are spliced together here - the approach, the coil, the drop
  // - and a splice reads as a kink unless the two sides leave the joint in
  // the SAME direction. So every control point next to a joint is placed
  // along the direction of the curve it meets, rather than picked by eye.
  const coilCx = desk8.x - 26,
    coilCy = desk8.y + 16;
  const COIL_RX = 14,
    COIL_RY = 7;
  // The cable arrives from the desk travelling down-left, so the coil has to
  // start where its own tangent points that way too. On this ellipse the
  // tangent at angle a is (-RX sin a, RY cos a); down-left in the ratio the
  // run already has means tan a = 2 RY / RX, so a = 0.588 rad. Winding the
  // other way, as this did, put the tangent up-left and left a 37-degree
  // corner at the joint.
  const COIL_A0 = 0.588,
    COIL_TURNS = 1.2;
  const coil: Array<[number, number]> = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const a = COIL_A0 + COIL_TURNS * 2 * Math.PI * t;
    const r = 1 - 0.26 * t;
    coil.push([
      coilCx + Math.cos(a) * COIL_RX * r,
      coilCy + Math.sin(a) * COIL_RY * r,
    ]);
  }
  const unit = (
    [ax, ay]: [number, number],
    [bx, by]: [number, number],
  ): [number, number] => {
    const dx = bx - ax,
      dy = by - ay,
      len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  const coilIn = coil[0],
    coilOut = coil[coil.length - 1];
  const inDir = unit(coilIn, coil[1]);
  const outDir = unit(coil[coil.length - 2], coilOut);
  // The direction the run travels across the floor, and so the direction it
  // must still be travelling as it reaches the lip: the row axis.
  const runLen = Math.hypot(rowDx, rowDy);
  const runDx = rowDx / runLen,
    runDy = rowDy / runLen;
  const at = (x: number, y: number) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  const cableFloor =
    `M${at(desk8.x + 30, desk8.y - 26)}` +
    ` C${at(desk8.x + 18, desk8.y - 18)} ${at(coilIn[0] - inDir[0] * 16, coilIn[1] - inDir[1] * 16)} ${at(coilIn[0], coilIn[1])}` +
    coil
      .slice(1)
      .map(([x, y]) => `L${at(x, y)}`)
      .join("") +
    ` C${at(coilOut[0] + outDir[0] * 13, coilOut[1] + outDir[1] * 13)} ${at(lipX - runDx * 13, lipY - runDy * 13)} ${at(lipX, lipY)}`;
  // Over the lip: down the SLAB_H-deep side face, then free, sagging out and
  // settling back under the weight of the plug on the end. The first control
  // continues along the run's direction, so the cable rounds the edge instead
  // of turning a corner on it.
  const cableDrop =
    `M${at(lipX, lipY)}` +
    ` C${at(lipX + runDx * 7, lipY + runDy * 7)} ${at(lipX - 1, lipY + SLAB_H)} ${at(lipX - 3, lipY + SLAB_H + 9)}` +
    ` C${at(lipX - 6.5, lipY + SLAB_H + 22)} ${at(lipX - 1.5, lipY + SLAB_H + 30)} ${at(lipX - 3, lipY + SLAB_H + 40)}`;
  const plugY = lipY + SLAB_H + 40;

  return (
    <svg
      style={SVG_STYLE}
      width={SCENE_W}
      height={SCENE_H}
      viewBox={VB}
      overflow="visible"
    >
      <defs>
        <linearGradient id="sunray-wide" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff4b8" stopOpacity="0" />
          <stop offset="0.22" stopColor="#fff4b8" stopOpacity="0.2" />
          <stop offset="1" stopColor="#fff4b8" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sunray-narrow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff9d8" stopOpacity="0" />
          <stop offset="0.2" stopColor="#fff9d8" stopOpacity="0.16" />
          <stop offset="1" stopColor="#fff9d8" stopOpacity="0" />
        </linearGradient>
      </defs>
      {slabs}
      {tiles}

      {/* Desk 8's cable: out from under the desk, across to the lip, over
          the side of the slab and off the edge of the world. Each run is a
          dark body under a thin offset highlight, which is what makes a
          stroke read as a round cable rather than a drawn line. */}
      {desk8Cable && (
        <g aria-hidden="true">
          <path
            d={cableFloor}
            transform="translate(1.6 0.9)"
            fill="none"
            stroke="#000"
            strokeOpacity="0.16"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={cableFloor}
            fill="none"
            stroke="#3c414f"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={cableDrop}
            fill="none"
            stroke="#3c414f"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={cableFloor}
            transform="translate(-0.3 -0.5)"
            fill="none"
            stroke="#575e72"
            strokeWidth="0.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={cableDrop}
            transform="translate(-0.55 -0.2)"
            fill="none"
            stroke="#575e72"
            strokeWidth="0.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* The plug is the weight that explains why the free end hangs
              straight instead of curling. */}
          <g transform={`translate(${lipX - 3} ${plugY})`}>
            <rect
              x="-3.2"
              y="0"
              width="6.4"
              height="8.6"
              rx="1.6"
              fill="#2f333f"
            />
            <rect
              x="-3.2"
              y="0"
              width="2.5"
              height="8.6"
              rx="1.25"
              fill="#464c5c"
            />
            <rect
              x="-1.9"
              y="8"
              width="1.1"
              height="3.2"
              rx="0.5"
              fill="#8d93a3"
            />
            <rect
              x="0.8"
              y="8"
              width="1.1"
              height="3.2"
              rx="0.5"
              fill="#8d93a3"
            />
          </g>
        </g>
      )}

      <g className="sunrays" aria-hidden="true">
        <path
          d="M-205 -5 L18 350 L-38 361 Z"
          fill="url(#sunray-wide)"
          opacity="0.5"
        />
        <path
          d="M-205 -5 L125 344 L55 361 Z"
          fill="url(#sunray-wide)"
          opacity="0.55"
        />
        <path
          d="M-205 -5 L232 296 L174 324 Z"
          fill="url(#sunray-narrow)"
          opacity="0.65"
        />
      </g>
    </svg>
  );
}

// --- Day-scene clouds ------------------------------------------------------
// The old clouds were four flat translucent ellipses, which read as lozenges
// rather than cloud. A cumulus has a flat base and a lumpy top, so the puffs
// all sit their BOTTOMS on one line and a bar fills the gaps between them:
// that single constraint is most of what makes a blob read as a cloud.
//
// [offset from the cloud's centre, radius]
const CLOUD_PUFFS: Array<[number, number]> = [
  [-12.5, 4.6],
  [-6.5, 7],
  [0.5, 8.6],
  [7, 6.4],
  [12.5, 4.8],
];

function CloudBody({ fill }: { fill: string }) {
  return (
    <g fill={fill}>
      {CLOUD_PUFFS.map(([dx, r], i) => (
        <circle key={i} cx={dx} cy={-r} r={r} />
      ))}
      <rect x={-13} y={-4.2} width={26.3} height={4.2} />
    </g>
  );
}

// Three copies of the silhouette, each smaller and brighter than the last,
// every one of them sitting on the SAME base line - scaling about the origin
// keeps y=0 fixed, so the flat bottom survives while the tops step back. It
// reads as stacked masses of cloud rather than one lump, and it stays crisp,
// which is the language the rest of the scene is drawn in: the sun, the moon
// and the desks are all flat facets with hard edges.
function Cloud({
  x,
  y,
  scale,
  opacity,
}: {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={opacity}>
      <CloudBody fill="#B7D2E7" />
      <g transform="translate(-1.5 0) scale(0.92)">
        <CloudBody fill="#E4EFF8" />
      </g>
      <g transform="translate(-4 0) scale(0.72)">
        <CloudBody fill="#FFFFFF" />
      </g>
    </g>
  );
}

// --- Window-sill plant -----------------------------------------------------
// The sill is horizontal in world space and runs ALONG the left wall, so its
// two axes are the same two floor axes: a circle standing on it projects to
// the same 2:1 ellipse as a circle on the floor. The sill line across the
// pane is y = 111 - 0.5 * (x + 290); at POT_X that puts the ledge at y=66,
// and the pot's base ellipse sits in the 9-unit band below it.
//
// POT_X is on the RIGHT half of the sill on purpose. The sill rises to the
// right, so there is far more clear wall under it there - the west-corner
// floor plant in RoomProps sits at x -260..-219, y 161 and up, and vines
// hung from the middle of the sill run straight into it.
const POT_X = -200;
const POT_SOIL_Y = 55.5;

// A vine leaves the soil, drapes over the rim, then falls and wanders.
// [start offset from POT_X, reach past the rim, drop, wander, phase, leaves]
// The first BACK_VINES entries are the back layer: shorter, darker and
// slightly transparent, so the plant has a near side and a far side instead
// of reading as one flat curtain.
const BACK_VINES = 2;
const VINES: Array<[number, number, number, number, number, number]> = [
  [-3.5, -9.5, 70, 2.6, 1.2, 6],
  [4.5, 9.5, 58, 2.2, 3.9, 5],
  [-6, -6.5, 96, 3.2, 0.4, 8],
  [-2, -2, 62, 2.4, 2.1, 6],
  [3, 4.5, 78, 3.6, 4.2, 7],
  [7, 8.5, 74, 2.8, 5.6, 6],
];

// exp() clears the rim fast, then the sine wander grows with the drop so the
// free tip moves more than the shoulder.
function vineXY(
  [start, reach, drop, wander, phase]: (typeof VINES)[number],
  t: number,
): [number, number] {
  return [
    POT_X +
      start +
      reach * (1 - Math.exp(-t * 9)) +
      wander * t * Math.sin(phase + t * 3.4),
    POT_SOIL_Y + drop * t,
  ];
}

function vinePath(vine: (typeof VINES)[number], samples = 26): string {
  let d = "";
  for (let i = 0; i <= samples; i++) {
    const [x, y] = vineXY(vine, i / samples);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

// Leaves hang off alternating sides, shrinking toward the tip. The stem is
// sampled either side of the anchor for its tangent, so a leaf always sits
// square to the vine it grows on. Spacing and the angle off the stem both
// carry the vine's phase, so no two vines ladder the same way - a strict
// zigzag at a fixed angle reads as a fishbone, not a plant. Lower leaves
// hug the stem harder, the way a hanging leaf does under its own weight.
function vineLeaves(vine: (typeof VINES)[number], vi: number) {
  const count = vine[5];
  const phase = vine[4];
  const back = vi < BACK_VINES;
  const out = [];
  for (let i = 0; i < count; i++) {
    const t =
      0.12 +
      (i / Math.max(1, count - 1)) * 0.85 +
      0.03 * Math.sin(phase + i * 2.3);
    const [x, y] = vineXY(vine, t);
    const [ax, ay] = vineXY(vine, Math.max(0, t - 0.03));
    const [bx, by] = vineXY(vine, Math.min(1, t + 0.03));
    const along = (Math.atan2(bx - ax, -(by - ay)) * 180) / Math.PI;
    const side = i % 2 === 0 ? 1 : -1;
    const spread = (26 + 16 * Math.sin(phase + i * 1.7)) * (1 - 0.3 * t);
    const tones = back ? BACK_LEAF_TONES : LEAF_TONES;
    // Marbling: three leaves in four carry it, one of those a big patch.
    const marble = (vi * 5 + i * 3) % 4;
    out.push(
      <Leaf
        key={`v${vi}l${i}`}
        x={x}
        y={y}
        angle={along + side * spread}
        size={(back ? 5.4 : 6.6) * (1 - 0.42 * t)}
        tone={tones[(vi * 3 + i) % tones.length]}
        varTone={
          !back && marble < 3
            ? MARBLE_TONES[(vi + i) % MARBLE_TONES.length]
            : undefined
        }
        varBig={marble === 0}
      />,
    );
  }
  return out;
}

// Crown leaves stand out of the soil so the plant has a top, not just tails.
// [dx, dy, angle, size, tone index]
const CROWN: Array<[number, number, number, number, number]> = [
  [-7, -1, -66, 6.4, 1],
  [-3.5, -2.5, -28, 7.4, 0],
  [1.5, -3, 12, 7.8, 3],
  [6, -1.5, 52, 6.8, 2],
  [-0.5, -1, -6, 5.6, 2],
];

// Blossoms over the crown, so the colour reads at the top of the plant and
// not only down the tails. [dx, dy, size, tone index]
const CROWN_FLOWERS: Array<[number, number, number, number]> = [
  [-5.5, -7, 3.7, 0],
  [1.5, -9, 4.1, 1],
  [6.5, -5.5, 3.4, 2],
];

function WindowPlant() {
  return (
    <g aria-hidden="true">
      {/* Cast shadow: the plant lifts off the wall. Invisible on the dark
          themes, where the wall is already near-black, and that is right -
          a shadow only shows where there is light to block. */}
      <g
        transform="translate(2.6 1.3)"
        filter="url(#plant-soft)"
        opacity="0.16"
      >
        {VINES.map((v, i) => (
          <path
            key={`sh${i}`}
            d={vinePath(v, 12)}
            fill="none"
            stroke="#000"
            strokeWidth="3.4"
            strokeLinecap="round"
          />
        ))}
        <ellipse cx={POT_X} cy={64} rx="10" ry="11" fill="#000" />
      </g>

      {/* Pot: a truncated cone under a lipped rim. The body gradient runs
          light-to-dark across it, so it reads as round rather than flat. */}
      <path
        d={`M${POT_X - 9} 58.5 A9 4.5 0 0 1 ${POT_X + 9} 58.5 L${POT_X + 6.4} 70.5 A6.4 3.2 0 0 1 ${POT_X - 6.4} 70.5 Z`}
        fill="url(#pot-body)"
      />
      <ellipse cx={POT_X} cy={55} rx="10" ry="5" fill="#c8825e" />
      <ellipse cx={POT_X} cy={55.5} rx="8.2" ry="4.1" fill="#493425" />
      <path
        d={`M${POT_X - 10} 55 A10 5 0 0 0 ${POT_X + 10} 55 L${POT_X + 10} 58.5 A10 5 0 0 1 ${POT_X - 10} 58.5 Z`}
        fill="url(#pot-lip)"
      />
      {/* Back layer, then the crown, then the front layer. Within a layer the
          stems all go down before any leaf, so a leaf base covers the stem it
          grows from instead of being cut by a later stroke. */}
      <g opacity="0.82">
        {VINES.slice(0, BACK_VINES).map((v, i) => (
          <path
            key={`bv${i}`}
            d={vinePath(v)}
            fill="none"
            stroke="#2c6434"
            strokeWidth="1"
            strokeLinecap="round"
          />
        ))}
        {VINES.slice(0, BACK_VINES).map((v, i) => vineLeaves(v, i))}
      </g>
      {CROWN.map(([dx, dy, angle, size, tone], i) => (
        <Leaf
          key={`c${i}`}
          x={POT_X + dx}
          y={POT_SOIL_Y + dy}
          angle={angle}
          size={size}
          tone={LEAF_TONES[tone]}
        />
      ))}
      {VINES.slice(BACK_VINES).map((v, i) => (
        <path
          key={`v${i}`}
          d={vinePath(v)}
          fill="none"
          stroke={i % 2 === 0 ? "#3f8446" : "#356f3b"}
          strokeWidth="1.15"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {VINES.slice(BACK_VINES).map((v, i) => vineLeaves(v, i + BACK_VINES))}
      {CROWN_FLOWERS.map(([dx, dy, size, tone], i) => (
        <Blossom
          key={`cf${i}`}
          x={POT_X + dx}
          y={POT_SOIL_Y + dy}
          size={size}
          tone={BLOSSOM_TONES[tone]}
        />
      ))}
    </g>
  );
}

interface DoorProps {
  label: string;
  onClick: () => void;
  dragOver?: boolean;
  reject?: boolean;
  // Counts ghosts that have passed through this door. A rise seen by a
  // mounted door plays the ajar animation once; the value itself is never
  // read, so any monotonic counter works.
  passCount?: number;
}

type DoorSide = "left" | "right";

// Both walls rise at the same 2:1 isometric slope, so one step along a
// wall lifts the drawing by WALL_SLOPE (the left wall up, the right wall
// down). The doors are drawn in wall-plane coordinates centred on the
// doorway: x -33..33, y -93..20.
const WALL_SKEW_DEG = 27;
const WALL_SLOPE = Math.tan((WALL_SKEW_DEG * Math.PI) / 180);
const DOOR_HALF_W = 33;
const DOOR_ORIGIN: Record<DoorSide, { x: number; y: number }> = {
  left: { x: -315, y: 237 },
  right: { x: 555, y: 237 },
};

// Both doors hinge on the wall edge farthest from the viewer - the edge
// the knob sits farthest from - and open into the room, so the free edge
// swings down and towards the viewer.
function doorHingeX(side: DoorSide): number {
  return side === "left" ? DOOR_HALF_W : -DOOR_HALF_W;
}

// The panel transform for a door standing `deg` out of its wall.
//
// A point `s` from the hinge lies at s*cos along the wall and s*sin out
// of it. In this projection those two floor directions have opposite
// screen-x signs and the same screen-y sign, so the panel narrows by
// (cos - sin) while its free edge drops by slope*(cos + sin): the door
// foreshortens and tilts at once, which is what sells the depth. The
// resulting matrix [[a,0],[b,1]] is exactly skewY(atan(b/a)) scaleX(a),
// and both of those fix the hinge line, so the panel only needs its
// transform-origin pinned to the hinge edge - no origin arithmetic.
//
// The same matrix also describes the door swinging the other way, out of
// the room: the two are mirror images through the wall, and this
// projection maps them onto each other. Only the hinge edge differs.
function doorSwingTransform(side: DoorSide, deg: number): string {
  const t = (deg * Math.PI) / 180;
  const narrow = Math.cos(t) - Math.sin(t);
  const rise =
    WALL_SLOPE * (Math.cos(t) + Math.sin(t)) * (side === "left" ? -1 : 1);
  const skew = (Math.atan2(rise, narrow) * 180) / Math.PI;
  return `skewY(${skew.toFixed(3)}deg) scaleX(${narrow.toFixed(4)})`;
}

const DOOR_OPEN_DEG = 11;
const DOOR_AJAR_MS = 900;

function doorRestTransform(side: DoorSide): string {
  return doorSwingTransform(side, 0);
}

function doorOpenTransform(side: DoorSide): string {
  return doorSwingTransform(side, DOOR_OPEN_DEG);
}

// Open fast, hold while the ghost crosses, fall shut slower. The ghost
// slide it accompanies is 220ms, so the panel is wide open by the time
// the ghost reaches the doorway.
const DOOR_AJAR_CSS = (["left", "right"] as const)
  .map(
    (side) => `
@keyframes isomuxDoorAjar-${side} {
  0% { transform: ${doorRestTransform(side)}; filter: brightness(1);
       animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1); }
  22% { transform: ${doorOpenTransform(side)}; filter: brightness(1.07); }
  52% { transform: ${doorOpenTransform(side)}; filter: brightness(1.07);
        animation-timing-function: cubic-bezier(0.5, 0, 0.75, 1); }
  100% { transform: ${doorRestTransform(side)}; filter: brightness(1); }
}`,
  )
  .join("\n");

function WallDoor({ side, door }: { side: DoorSide; door: DoorProps }) {
  const origin = DOOR_ORIGIN[side];
  const hingeX = doorHingeX(side);
  const skewDeg = side === "left" ? -WALL_SKEW_DEG : WALL_SKEW_DEG;
  // The knob sits on the free half of the panel, away from the hinge.
  const knobX = side === "left" ? -15 : 15;
  const panelFill = door.reject
    ? "#5a2020"
    : door.dragOver
      ? "#5a4a2a"
      : "#3a2a1a";
  const faceFill = door.reject
    ? "#7a3030"
    : door.dragOver
      ? "#7a6050"
      : "#5a4030";
  const inlayFill = door.reject
    ? "#8a4040"
    : door.dragOver
      ? "#8a7060"
      : "#6a5040";
  const pass = door.passCount ?? 0;
  // The swing plays only for a crossing this mounted door has seen: the
  // counter it keys on advances when passCount rises after mount, never on
  // mount itself. Otherwise a room switch, which mounts the doors of the
  // new room with the session's running count, would swing them for the
  // viewer's own navigation. Render-phase derived state, like the hook.
  const [seen, setSeen] = useState({ pass, swings: 0 });
  const swings = pass > seen.pass ? seen.swings + 1 : seen.swings;
  if (pass !== seen.pass) setSeen({ pass, swings });
  return (
    <g
      data-no-pan
      onClick={door.onClick}
      style={{ cursor: "pointer", pointerEvents: "auto" }}
    >
      <style>{DOOR_AJAR_CSS}</style>
      <g transform={`translate(${origin.x}, ${origin.y})`}>
        {/* The room on the other side: this room's own wall and floor
            colours, then a shadow over both, so the opening stays in the
            scene palette and follows the theme. Inset by 1.5 so the
            closed panel covers it to the last pixel, including its
            rounded corners; the swing uncovers the rest. */}
        <g transform={`skewY(${skewDeg})`}>
          <rect
            x="-31.5"
            y="-91.5"
            width="63"
            height="110"
            rx="2"
            fill={`var(--wall-${side})`}
          />
          <rect
            x="-31.5"
            y="-8"
            width="63"
            height="26.5"
            fill="var(--floor-dark)"
          />
          <rect
            x="-31.5"
            y="-91.5"
            width="63"
            height="110"
            rx="2"
            fill="url(#door-opening)"
          />
        </g>
        {/* Hinge at the local origin, so the panel transform is a pure
            skew + scale about the transform-origin edge below. The hinge
            edge is the far one, so it sits above the door centre. */}
        <g
          transform={`translate(${hingeX}, ${(-DOOR_HALF_W * WALL_SLOPE).toFixed(3)})`}
        >
          <g
            key={swings}
            style={{
              transformBox: "fill-box",
              // The panel's bounding box ends (left door) or starts
              // (right door) at the hinge, and skewY / scaleX both fix
              // that edge, so only its x matters here.
              transformOrigin: side === "left" ? "100% 50%" : "0% 50%",
              transform: doorRestTransform(side),
              ...(swings > 0
                ? { animation: `isomuxDoorAjar-${side} ${DOOR_AJAR_MS}ms both` }
                : {}),
            }}
          >
            <g transform={`translate(${-hingeX}, 0)`}>
              <rect
                x="-33"
                y="-93"
                width="66"
                height="113"
                rx="3"
                fill={panelFill}
                stroke="#2a1a0a"
                strokeWidth="1.5"
              />
              <rect
                x="-27"
                y="-87"
                width="54"
                height="101"
                rx="1.5"
                fill={faceFill}
              />
              <rect
                x="-21"
                y="-78"
                width="42"
                height="36"
                rx="1.5"
                fill={inlayFill}
                stroke="#4a3020"
                strokeWidth="0.5"
              />
              <rect
                x="-21"
                y="-31"
                width="42"
                height="36"
                rx="1.5"
                fill={inlayFill}
                stroke="#4a3020"
                strokeWidth="0.5"
              />
              <ellipse
                cx={knobX + 1.2}
                cy="-23.8"
                rx="5"
                ry="4"
                fill="#241509"
                opacity="0.5"
              />
              <circle cx={knobX} cy="-25" r="5.2" fill="#6d5128" />
              <circle cx={knobX} cy="-25" r="4.3" fill="url(#door-knob)" />
              <ellipse
                cx={knobX - 1.4}
                cy="-26.5"
                rx="1.35"
                ry="0.9"
                fill="#fff5c8"
                opacity="0.78"
              />
              {door.dragOver && (
                <rect
                  x="-33"
                  y="-93"
                  width="66"
                  height="113"
                  rx="3"
                  fill="rgba(126,184,255,0.15)"
                  stroke="rgba(126,184,255,0.6)"
                  strokeWidth="2"
                />
              )}
              {door.reject && (
                <rect
                  x="-33"
                  y="-93"
                  width="66"
                  height="113"
                  rx="3"
                  fill="rgba(255,60,60,0.25)"
                  stroke="rgba(255,60,60,0.7)"
                  strokeWidth="2"
                />
              )}
            </g>
          </g>
        </g>
        <g transform={`skewY(${skewDeg})`}>
          <text
            x="0"
            y="-98"
            textAnchor="middle"
            fill={
              door.reject
                ? "var(--red, #f85149)"
                : door.dragOver
                  ? "var(--accent, #58a6ff)"
                  : "var(--text-dim)"
            }
            fontSize="12"
            fontFamily="'JetBrains Mono',monospace"
            fontWeight="600"
            style={{ userSelect: "none" }}
          >
            {door.label}
          </text>
        </g>
      </g>
    </g>
  );
}

// The doors sit in their own layer, drawn after the floor: a door that
// opens into the room swings its bottom corner past the wall-floor
// junction, and the floor slab would otherwise paint over it.
export function WallDoors({
  leftDoor,
  rightDoor,
}: {
  leftDoor?: DoorProps | null;
  rightDoor?: DoorProps | null;
}) {
  return (
    <svg
      style={SVG_STYLE}
      width={SCENE_W}
      height={SCENE_H}
      viewBox={VB}
      overflow="visible"
    >
      <defs>
        <radialGradient id="door-knob" cx="32%" cy="28%" r="68%">
          <stop offset="0" stopColor="#fff1ad" />
          <stop offset="0.32" stopColor="#d8bd72" />
          <stop offset="0.72" stopColor="#a08042" />
          <stop offset="1" stopColor="#60451f" />
        </radialGradient>
        {/* Shadow over the room beyond, deepest at the top where the
            doorway's own head cuts the light off. */}
        <linearGradient id="door-opening" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.86" />
          <stop offset="0.66" stopColor="#000" stopOpacity="0.7" />
          <stop offset="1" stopColor="#000" stopOpacity="0.5" />
        </linearGradient>
      </defs>
      {/* Left wall door - leads to previous room */}
      {leftDoor && <WallDoor side="left" door={leftDoor} />}
      {/* Right wall door - leads to next room */}
      {rightDoor && <WallDoor side="right" door={rightDoor} />}
    </svg>
  );
}

export function Walls({
  onToggleTheme,
  onWallPanelClick,
  hasOfficePrompt,
  onOpenTasks,
  onOpenCronjobs,
  taskCount = 0,
}: {
  onToggleTheme?: () => void;
  onWallPanelClick?: (x: number, y: number) => void;
  hasOfficePrompt?: boolean;
  onOpenTasks?: () => void;
  onOpenCronjobs?: () => void;
  taskCount?: number;
}) {
  const { currentRoomId, rooms } = useAppState();
  const roomIndex = rooms.findIndex((r) => r.id === currentRoomId);
  const neon = NEON_COLORS[roomPaletteIndex(roomIndex, NEON_COLORS.length)];
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

  // Stars - placed in parallelogram coords, then projected
  // Pane corners: TL(-295,30) TR(-155,-40) BL(-295,120) BR(-155,50)
  // u=0..1 is left-to-right, v=0..1 is top-to-bottom
  const starUV: Array<[number, number, number]> = [
    [0.1, 0.2, 0.6],
    [0.3, 0.1, 0.9],
    [0.5, 0.3, 0.5],
    [0.8, 0.15, 0.7],
    [0.15, 0.5, 0.5],
    [0.4, 0.4, 0.8],
    [0.65, 0.2, 0.6],
    [0.9, 0.35, 0.5],
    [0.2, 0.75, 0.9],
    [0.45, 0.6, 0.6],
    [0.7, 0.5, 0.7],
    [0.85, 0.7, 0.5],
    [0.05, 0.9, 0.5],
    [0.35, 0.8, 0.7],
    [0.6, 0.75, 0.6],
    [0.95, 0.55, 0.8],
    [0.25, 0.35, 0.5],
    [0.55, 0.85, 0.6],
    [0.75, 0.4, 0.7],
    [0.1, 0.65, 0.5],
    [0.5, 0.15, 0.8],
    [0.7, 0.9, 0.5],
    [0.85, 0.1, 0.6],
    [0.3, 0.55, 0.5],
  ];
  const stars = starUV.map(([u, v, r]) => {
    const topY = 25 + u * (-45 - 25); // top edge: 25 to -45
    const botY = 115 + u * (45 - 115); // bottom edge: 115 to 45
    const x = -285 + u * 140;
    const y = topY + v * (botY - topY);
    return [x, y, r] as [number, number, number];
  });

  return (
    <svg
      style={SVG_STYLE}
      width={SCENE_W}
      height={SCENE_H}
      viewBox={VB}
      overflow="visible"
    >
      <defs>
        {/* Clip the sky scene to the window pane (iso parallelogram) */}
        <clipPath id="window-clip">
          <path d="M-290 111 L-149 40.5 L-149 -45.5 L-290 25 Z" />
        </clipPath>
        {/* Moon halo: a soft falloff, not a flat disc. The old halo was a
            5%-opacity circle painted ON TOP of the moon, so it both washed
            the disc and showed its own hard edge (and the chord where the
            window frame clipped it) as a grey circle behind the moon. */}
        <radialGradient id="moon-halo">
          <stop offset="0" stopColor="#E8E0C8" stopOpacity="0.18" />
          <stop offset="0.4" stopColor="#E8E0C8" stopOpacity="0.1" />
          <stop offset="0.7" stopColor="#E8E0C8" stopOpacity="0.03" />
          <stop offset="1" stopColor="#E8E0C8" stopOpacity="0" />
        </radialGradient>
        {/* The crescent is the disc MINUS the shadow, so the shadow is a hole
            and the halo behind stays continuous. Filling the shadow with the
            sky colour instead would punch an opaque bite out of the halo. */}
        {/* The sill's top surface: the band between the pane's bottom edge
            and the wall opening's bottom edge. Contact shadows are clipped to
            it, so a shadow stops at the front lip instead of running on down
            the wall. */}
        <clipPath id="sill-clip">
          <path d="M-290 111 L-149 40.5 L-140 45 L-290 120 Z" />
        </clipPath>
        {/* A generous region: the default -10%/120% box crops the blur off
            shadows this flat. */}
        <filter id="sill-shadow" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="1.7" />
        </filter>
        <mask id="moon-crescent">
          <circle cx={-203} cy={-8} r={12} fill="#fff" />
          <circle cx={-203 + moonPhase * 10} cy={-9} r={10} fill="#000" />
        </mask>
        <linearGradient id="pot-body" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#b9704e" />
          <stop offset="0.34" stopColor="#a85e3e" />
          <stop offset="1" stopColor="#7b4028" />
        </linearGradient>
        <linearGradient id="pot-lip" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#cd8a66" />
          <stop offset="0.34" stopColor="#bb7550" />
          <stop offset="1" stopColor="#8b4c30" />
        </linearGradient>
        <filter id="plant-soft">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>

      {/* Cut ends and narrow cap faces make the wall planes read as solid. */}
      <path
        d="M-355 37.5 L-355 277.5 L-364 273 L-364 33 Z"
        fill="var(--wall-end-left)"
        stroke="var(--wall-stroke)"
        strokeWidth="0.5"
      />
      <path
        d="M595 37.5 L595 277.5 L604 273 L604 33 Z"
        fill="var(--wall-end-right)"
        stroke="var(--wall-stroke)"
        strokeWidth="0.5"
      />
      <path
        d="M-355 37.5 L120 -200 L120 -209 L-364 33 Z"
        fill="var(--wall-top-left)"
        stroke="var(--wall-stroke)"
        strokeWidth="0.5"
      />
      <path
        d="M120 -200 L595 37.5 L604 33 L120 -209 Z"
        fill="var(--wall-top-right)"
        stroke="var(--wall-stroke)"
        strokeWidth="0.5"
      />

      {/* Left wall (2:1 iso ratio) */}
      <path
        d="M-355 277.5 L-355 37.5 L120 -200 L120 40 Z"
        fill="var(--wall-left)"
        stroke="var(--wall-stroke)"
        strokeWidth="0.5"
      />
      {/* Right wall (2:1 iso ratio) */}
      <path
        d="M120 -200 L120 40 L595 277.5 L595 37.5 Z"
        fill="var(--wall-right)"
        stroke="var(--wall-stroke)"
        strokeWidth="0.5"
      />

      {/* Window on left wall */}
      <g
        data-no-pan
        role="button"
        tabIndex={0}
        aria-label="Change theme"
        onClick={onToggleTheme}
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggleTheme?.();
          }
        }}
        style={{ cursor: "pointer", pointerEvents: "auto" }}
      >
        {/* Four-sided wall opening, with its depth visible inside. */}
        <path
          d="M-290 120 L-140 45 L-140 -50 L-290 25 Z"
          fill="var(--wall-end-left)"
          stroke="var(--wall-stroke)"
          strokeWidth="0.5"
        />
        <path
          d="M-140 45 L-140 -50 L-149 -45.5 L-149 40.5 Z"
          fill="var(--wall-top-left)"
          stroke="var(--wall-stroke)"
          strokeWidth="0.5"
        />

        {/* Night scene (dark mode) */}
        <g clipPath="url(#window-clip)" className="window-night">
          <path
            d="M-290 111 L-149 40.5 L-149 -45.5 L-290 25 Z"
            fill="#0a0e1a"
          />
          {/* Stars */}
          {stars.map(([sx, sy, sr], i) => (
            <circle
              key={i}
              cx={sx}
              cy={sy}
              r={sr}
              fill="white"
              opacity={0.4 + (i % 4) * 0.15}
            >
              {i % 5 === 0 && (
                <animate
                  attributeName="opacity"
                  values={`${0.3 + (i % 3) * 0.1};${0.7 + (i % 2) * 0.2};${0.3 + (i % 3) * 0.1}`}
                  dur={`${2 + (i % 3)}s`}
                  repeatCount="indefinite"
                />
              )}
            </circle>
          ))}
          {/* Moon - a masked crescent over a soft halo */}
          <g>
            <circle cx={-203} cy={-8} r={30} fill="url(#moon-halo)" />
            <circle
              cx={-203}
              cy={-8}
              r={12}
              fill="#E8E0C8"
              mask="url(#moon-crescent)"
            />
          </g>
        </g>

        {/* Day scene (light mode) */}
        <g clipPath="url(#window-clip)" className="window-day">
          <path
            d="M-290 111 L-149 40.5 L-149 -45.5 L-290 25 Z"
            fill="#87CEEB"
          />
          {/* Sun */}
          <g>
            <circle cx={-205} cy={-5} r={20} fill="transparent" />
            <circle cx={-205} cy={-5} r={14} fill="#F5D060" />
            <circle cx={-205} cy={-5} r={20} fill="#F5D060" opacity="0.15" />
          </g>
          {/* Clouds. Placed to the pane and clear of the sill props: the
              upper-left pane, the upper-right pane past the sun, and one
              small distant one low left of the jar. */}
          <Cloud x={-250} y={22} scale={0.9} opacity={0.95} />
          <Cloud x={-172} y={4} scale={1.05} opacity={0.92} />
          <Cloud x={-262} y={66} scale={0.6} opacity={0.68} />
        </g>

        {/* The outer-edge frame is hidden on the left and top. */}
        <path
          d="M-290 111 L-149 40.5"
          stroke="var(--wall-decor)"
          strokeWidth="2"
        />
        <path
          d="M-149 40.5 L-149 -45.5"
          stroke="var(--wall-decor)"
          strokeWidth="2"
        />

        {/* Window crossbar (vertical center divider) */}
        <line
          x1={-215}
          y1={73.5}
          x2={-215}
          y2={-12.5}
          stroke="var(--wall-decor)"
          strokeWidth="2"
        />
        {/* Window crossbar (horizontal, following iso slope) */}
        <path
          d="M-290 68 L-149 -2.5"
          stroke="var(--wall-decor)"
          strokeWidth="2"
          fill="none"
        />
      </g>

      {/* Everything standing on the sill casts its contact shadow here, in
          one blurred group clipped to the ledge, so both stop at the same
          edge and neither runs on down the wall. Blur first, then clip: the
          shadow is soft where it lies on the sill and cut where the sill
          ends, which is what a real one does. */}
      <g clipPath="url(#sill-clip)" aria-hidden="true">
        <g filter="url(#sill-shadow)">
          {/* Centred under what casts them. Offsetting a contact shadow to
              suggest a light direction is what makes the object read as
              floating: the one place a shadow must touch its object is
              directly under it. Each sits in the plane of that object's base
              ellipse - the pot's at y=70.5, the jar's at its own origin. */}
          <ellipse
            cx={POT_X}
            cy={70.5}
            rx="8.2"
            ry="3"
            fill="#000"
            opacity="0.34"
          />
        </g>
      </g>

      <WindowPlant />

      {/* Jar of cherry blossom, standing on the sill left of the plant.
          The sill is the wall opening's bottom edge, from (-290,120) to
          (-140,45), so y = 120 - 0.5 * (x + 290): at x=-248 that is 99.
          Slide the translate ALONG that line to move it - off the line and
          the jar floats. Worker 6 drew it at x=-200, which is where the
          plant's pot stands, so it moved left. It sits in this SVG, whose
          pointer-events are none, so it does not take the window's
          "Change theme" click. */}
      <g transform="translate(-236 92.6)">
        <BlossomJar />
      </g>

      {/* Corkboard on left wall - casual, mutable feel */}
      <g
        data-no-pan
        transform="translate(-55, -30) skewY(-27)"
        onClick={onOpenTasks}
        style={{ cursor: "pointer", pointerEvents: "auto" }}
      >
        {/* Board frame */}
        <rect
          x="-50"
          y="-40"
          width="95"
          height="70"
          rx="2"
          fill="#5a4430"
          stroke="#4a3620"
          strokeWidth="1"
        />
        {/* Cork surface */}
        <rect x="-46" y="-36" width="87" height="62" rx="1" fill="#c49a6c" />
        {/* Frame bevel - the window lights the top and left edges */}
        <path
          d="M-49 29 L-49 -39 L44 -39"
          fill="none"
          stroke="#7a5f42"
          strokeWidth="1.5"
        />
        <path
          d="M-49 29 L44 29 L44 -39"
          fill="none"
          stroke="#3a2a18"
          strokeWidth="1.5"
        />
        {/* Cork texture - subtle speckles */}
        <circle cx="-30" cy="-20" r="0.8" fill="#b88a58" opacity="0.5" />
        <circle cx="-10" cy="-10" r="0.6" fill="#b88a58" opacity="0.4" />
        <circle cx="15" cy="-25" r="0.7" fill="#b88a58" opacity="0.5" />
        <circle cx="25" cy="5" r="0.6" fill="#b88a58" opacity="0.4" />
        <circle cx="-35" cy="10" r="0.7" fill="#b88a58" opacity="0.3" />
        <circle cx="5" cy="15" r="0.5" fill="#b88a58" opacity="0.4" />

        {/* Index card 1 - slightly tilted, top-left */}
        <g transform="translate(-32, -22) rotate(-3)">
          <rect
            x="0"
            y="0"
            width="28"
            height="20"
            rx="1"
            fill="#f5f0e0"
            stroke="#e0d8c4"
            strokeWidth="0.3"
          />
          {taskCount >= 1 && (
            <>
              <line
                x1="3"
                y1="6"
                x2="25"
                y2="6"
                stroke="#ccc"
                strokeWidth="0.3"
              />
              <line
                x1="3"
                y1="10"
                x2="22"
                y2="10"
                stroke="#ccc"
                strokeWidth="0.3"
              />
              <line
                x1="3"
                y1="14"
                x2="18"
                y2="14"
                stroke="#ccc"
                strokeWidth="0.3"
              />
            </>
          )}
          {/* Red pushpin */}
          <circle cx="14" cy="2" r="2.5" fill="#e04040" />
          <circle cx="14" cy="2" r="1.2" fill="#c03030" />
        </g>

        {/* Index card 2 - slightly tilted other way, center-right */}
        <g transform="translate(5, -18) rotate(2)">
          <rect
            x="0"
            y="0"
            width="30"
            height="22"
            rx="1"
            fill="#eef4ff"
            stroke="#d0d8e8"
            strokeWidth="0.3"
          />
          {taskCount >= 2 && (
            <>
              <line
                x1="3"
                y1="6"
                x2="27"
                y2="6"
                stroke="#bbc"
                strokeWidth="0.3"
              />
              <line
                x1="3"
                y1="10"
                x2="25"
                y2="10"
                stroke="#bbc"
                strokeWidth="0.3"
              />
              <line
                x1="3"
                y1="14"
                x2="20"
                y2="14"
                stroke="#bbc"
                strokeWidth="0.3"
              />
              <line
                x1="3"
                y1="18"
                x2="15"
                y2="18"
                stroke="#bbc"
                strokeWidth="0.3"
              />
            </>
          )}
          {/* Blue pushpin */}
          <circle cx="15" cy="2" r="2.5" fill="#4080d0" />
          <circle cx="15" cy="2" r="1.2" fill="#3060b0" />
        </g>

        {/* Index card 3 - bottom left, slight tilt */}
        <g transform="translate(-28, 4) rotate(1.5)">
          <rect
            x="0"
            y="0"
            width="26"
            height="18"
            rx="1"
            fill="#fff8e0"
            stroke="#e8dcc0"
            strokeWidth="0.3"
          />
          {taskCount >= 3 && (
            <>
              <line
                x1="3"
                y1="5"
                x2="23"
                y2="5"
                stroke="#dda"
                strokeWidth="0.3"
              />
              <line
                x1="3"
                y1="9"
                x2="20"
                y2="9"
                stroke="#dda"
                strokeWidth="0.3"
              />
              <line
                x1="3"
                y1="13"
                x2="16"
                y2="13"
                stroke="#dda"
                strokeWidth="0.3"
              />
            </>
          )}
          {/* Yellow pushpin */}
          <circle cx="13" cy="1" r="2.5" fill="#e8c020" />
          <circle cx="13" cy="1" r="1.2" fill="#c8a010" />
        </g>

        {/* Empty pin hole - card was removed */}
        <g transform="translate(18, 8)">
          <circle cx="0" cy="0" r="2.5" fill="#40b060" />
          <circle cx="0" cy="0" r="1.2" fill="#309048" />
          {/* Tiny pinhole shadow underneath */}
          <circle cx="0" cy="3" r="0.8" fill="#a08050" opacity="0.3" />
        </g>
      </g>

      {/* Framed wall sign on left wall - formal, authoritative feel */}
      <g
        data-no-pan
        transform="translate(50, -75) skewY(-27)"
        onClick={(e) => onWallPanelClick?.(e.clientX, e.clientY)}
        style={{ cursor: "pointer", pointerEvents: "auto" }}
      >
        {/* Outer frame - dark wood/brass */}
        <rect
          x="-30"
          y="-32"
          width="60"
          height="58"
          rx="2"
          fill="#3a3028"
          stroke="#2a2018"
          strokeWidth="1.2"
        />
        {/* Inner frame - thin brass inset */}
        <rect
          x="-27"
          y="-29"
          width="54"
          height="52"
          rx="1"
          fill="none"
          stroke="#8a7a60"
          strokeWidth="0.5"
        />
        {/* Frame bevel - lit top and left, shaded bottom and right */}
        <path
          d="M-29 25 L-29 -31 L29 -31"
          fill="none"
          stroke="#6a5a48"
          strokeWidth="1.2"
        />
        <path
          d="M-29 25 L29 25 L29 -31"
          fill="none"
          stroke="#1a120c"
          strokeWidth="1.2"
        />
        {/* Cream background */}
        <rect
          x="-25"
          y="-27"
          width="50"
          height="48"
          rx="1"
          fill={hasOfficePrompt ? "#f5f0e4" : "#ece8dc"}
        />
        {/* Title line - always visible */}
        <line
          x1="-14"
          y1="-20"
          x2="14"
          y2="-20"
          stroke="#333"
          strokeWidth="1"
          opacity="0.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hasOfficePrompt ? (
          <>
            {/* Divider */}
            <line
              x1="-10"
              y1="-16"
              x2="10"
              y2="-16"
              stroke="#999"
              strokeWidth="0.3"
              opacity="0.3"
            />
            {/* Body text lines - small, illegible, typed feel */}
            <line
              x1="-18"
              y1="-10"
              x2="18"
              y2="-10"
              stroke="#444"
              strokeWidth="0.6"
              opacity="0.25"
            />
            <line
              x1="-18"
              y1="-5"
              x2="16"
              y2="-5"
              stroke="#444"
              strokeWidth="0.6"
              opacity="0.25"
            />
            <line
              x1="-18"
              y1="0"
              x2="17"
              y2="0"
              stroke="#444"
              strokeWidth="0.6"
              opacity="0.25"
            />
            <line
              x1="-18"
              y1="5"
              x2="14"
              y2="5"
              stroke="#444"
              strokeWidth="0.6"
              opacity="0.25"
            />
            <line
              x1="-18"
              y1="10"
              x2="12"
              y2="10"
              stroke="#444"
              strokeWidth="0.6"
              opacity="0.25"
            />
            {/* Subtle seal/stamp at bottom */}
            <circle
              cx="0"
              cy="17"
              r="4"
              fill="none"
              stroke="#8a6040"
              strokeWidth="0.5"
              opacity="0.2"
            />
            <circle cx="0" cy="17" r="2" fill="#8a6040" opacity="0.08" />
          </>
        ) : (
          <>
            {/* Empty state - blank sign, faint placeholder */}
            <line
              x1="-8"
              y1="-4"
              x2="8"
              y2="-4"
              stroke="#bbb"
              strokeWidth="0.6"
              opacity="0.3"
              strokeLinecap="round"
            />
            <line
              x1="-6"
              y1="0"
              x2="6"
              y2="0"
              stroke="#bbb"
              strokeWidth="0.5"
              opacity="0.2"
              strokeLinecap="round"
            />
            <line
              x1="-4"
              y1="4"
              x2="4"
              y2="4"
              stroke="#bbb"
              strokeWidth="0.4"
              opacity="0.15"
              strokeLinecap="round"
            />
          </>
        )}
      </g>
      {/* Clock on right wall (skewed to match 2:1 wall angle ~27°) */}
      <g
        data-no-pan
        transform="translate(240,-85) skewY(27)"
        onClick={onOpenCronjobs}
        style={
          onOpenCronjobs
            ? { cursor: "pointer", pointerEvents: "auto" }
            : undefined
        }
      >
        {/* Slightly larger transparent hit area for forgiving clicks */}
        {onOpenCronjobs && (
          <circle cx="0" cy="0" r={R + 4} fill="transparent" />
        )}
        <circle
          cx="0"
          cy="0"
          r={R}
          fill="var(--wall-decor)"
          stroke="var(--wall-decor-stroke)"
          strokeWidth="1"
        />
        <circle cx="0" cy="0" r={r} fill="var(--wall-decor-inner)" />
        {/* Hour ticks */}
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          const x1 = (r - 2) * Math.sin(a);
          const y1 = -(r - 2) * Math.cos(a);
          const x2 = (r - 5) * Math.sin(a);
          const y2 = -(r - 5) * Math.cos(a);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--wall-decor-stroke)"
              strokeWidth={i % 3 === 0 ? 1.2 : 0.6}
            />
          );
        })}
        {/* Hour hand */}
        <line
          x1="0"
          y1="0"
          x2={hx}
          y2={hy}
          stroke="var(--clock-hand)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Minute hand */}
        <line
          x1="0"
          y1="0"
          x2={mx}
          y2={my}
          stroke="var(--clock-hand)"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Center dot */}
        <circle cx="0" cy="0" r="1.5" fill="var(--clock-hand)" />
      </g>
      {/* Neon sign - right wall, hand-drawn tube letters with ligaments */}
      {/* Letter positions: i(-38), s(-25), o(-11), m(5), u(23), x(37) */}
      {/* On (dark mode) */}
      <g
        className="neon-sign-on"
        transform="translate(370, -5) skewY(27)"
        style={{
          animation: "neonFlicker 5s ease-in-out infinite",
          filter: `drop-shadow(0 0 4px ${neon}) drop-shadow(0 0 12px ${neon})`,
        }}
      >
        {/* Hit area */}
        <rect
          data-no-pan
          x="-38"
          y="-18"
          width="92"
          height="32"
          fill="transparent"
          style={{ cursor: "pointer", pointerEvents: "auto" }}
          onClick={() => window.open("https://isomux.com", "_blank")}
        />
        {/* Letters as thick strokes */}
        <g
          fill="none"
          stroke={neon}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* i - dot + stem */}
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
        {/* Ligaments - thin connecting tubes between letters */}
        <g
          fill="none"
          stroke={neon}
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.7"
        >
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
        <line
          x1="-34"
          y1="9"
          x2="52"
          y2="9"
          stroke={neon}
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.6"
        />
      </g>
      {/* Off (light mode) */}
      <g className="neon-sign-off" transform="translate(370, -5) skewY(27)">
        {/* Hit area */}
        <rect
          data-no-pan
          x="-38"
          y="-18"
          width="92"
          height="32"
          fill="transparent"
          style={{ cursor: "pointer", pointerEvents: "auto" }}
          onClick={() => window.open("https://isomux.com", "_blank")}
        />
        <g
          fill="none"
          stroke="#444"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.7"
        >
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
        <g
          fill="none"
          stroke="#444"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.45"
        >
          <path d="M-32 2 Q-28 8 -24 4" />
          <path d="M-20 -11 Q-17 -14 -13.5 -10.5" />
          <path d="M-2.5 -3.5 Q0 -1 3 4" />
          <path d="M19 4 Q21 6 24 -1" />
          <path d="M33 -11 Q35 -14 38 -11" />
        </g>
        <line
          x1="-34"
          y1="9"
          x2="52"
          y2="9"
          stroke="#444"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.35"
        />
      </g>

      {/* Vent - upper-east area of right wall */}
      <g transform="translate(500, 60) skewY(27)">
        {/* Drop shadow, falling right and down like every other shadow in
            the scene. The corkboard and the framed sign carry a bevel and no
            shadow; only the vent takes both. That is deliberate, judged on
            the frames one prop at a time (Nil, 2026-09-05). */}
        <rect
          x="-22.5"
          y="-12.5"
          width="50"
          height="30"
          rx="2"
          fill="#000"
          opacity="0.16"
        />
        <rect
          x="-25"
          y="-15"
          width="50"
          height="30"
          rx="2"
          fill="var(--wall-decor)"
          stroke="var(--wall-decor-stroke)"
          strokeWidth="0.8"
        />
        <line
          x1="-22"
          y1="-8"
          x2="22"
          y2="-8"
          stroke="var(--wall-decor-stroke)"
          strokeWidth="1.5"
        />
        <line
          x1="-22"
          y1="-2"
          x2="22"
          y2="-2"
          stroke="var(--wall-decor-stroke)"
          strokeWidth="1.5"
        />
        <line
          x1="-22"
          y1="4"
          x2="22"
          y2="4"
          stroke="var(--wall-decor-stroke)"
          strokeWidth="1.5"
        />
        <line
          x1="-22"
          y1="10"
          x2="22"
          y2="10"
          stroke="var(--wall-decor-stroke)"
          strokeWidth="1.5"
        />
        {/* Plate bevel. The vent takes its colour from the theme, so the
            bevel is a white and a black overlay, which read in both. */}
        <path
          d="M-24 14 L-24 -14 L24 -14"
          fill="none"
          stroke="#fff"
          strokeWidth="1"
          opacity="0.18"
        />
        <path
          d="M-24 14 L24 14 L24 -14"
          fill="none"
          stroke="#000"
          strokeWidth="1"
          opacity="0.25"
        />
      </g>
    </svg>
  );
}
