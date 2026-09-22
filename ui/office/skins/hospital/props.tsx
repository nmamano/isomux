import type { ReactElement } from "react";
import { useAppState, useTheme } from "../../../store.tsx";
import { hospitalColors, type HospitalColors } from "./palette.ts";
import { BedsideCabinet, FramedLandscape, MedicalChart, WindowCurtains } from "./decorations.tsx";

// The hospital's own drawings. Two layers, because they sit at two depths in
// the scene: HospitalWalls is mounted inside the Walls svg, which is drawn
// before the doors, so a band along the wall cannot paint over an open door;
// HospitalProps is mounted in the props svg, which is drawn before the desks,
// so a desk in front of a prop occludes it.
//
// Everything here is in scene coordinates (viewBox -355 -100 950 700). The two
// floor axes are the ones the tiles are laid on: (2,1) toward the lower right
// and (-2,1) toward the lower left, so a rectangle standing on the floor is
// drawn from those two directions and nothing else.

// Both walls rise at the 2:1 isometric slope, so their bottom edges are the two
// lines below. The wainscot is the band above each of them.
const WALL_BOTTOM = {
  left: { x1: -355, y1: 277.5, x2: 120, y2: 40 },
  right: { x1: 120, y1: 40, x2: 595, y2: 277.5 },
} as const;
const WAINSCOT_H = 34;
const RAIL_H = 7;

function Wainscot({ side, c }: { side: "left" | "right"; c: HospitalColors }) {
  const e = WALL_BOTTOM[side];
  const band = `M${e.x1} ${e.y1} L${e.x2} ${e.y2} L${e.x2} ${e.y2 - WAINSCOT_H} L${e.x1} ${e.y1 - WAINSCOT_H} Z`;
  const rail = `M${e.x1} ${e.y1 - WAINSCOT_H + RAIL_H} L${e.x2} ${e.y2 - WAINSCOT_H + RAIL_H} L${e.x2} ${e.y2 - WAINSCOT_H} L${e.x1} ${e.y1 - WAINSCOT_H} Z`;
  return (
    <>
      <path d={band} fill={side === "left" ? c.wainscot : c.wainscotShade} />
      {/* The bumper rail along the top of the band, which is the detail that
          makes a painted band read as a corridor wall rather than a stripe. */}
      <path d={rail} fill={c.rail} />
    </>
  );
}

// The cross sign on the right wall, clear of the clock (240,-85), the neon sign
// (370,-5) and the vent (500,60). Skewed into the wall plane like every other
// prop hung there.
export function CrossSign({ c }: { c: HospitalColors }) {
  const arm = 7.5;
  const reach = 19;
  return (
    <g transform="translate(190, -10) skewY(27)">
      <rect
        x={-reach - 5}
        y={-reach - 5}
        width={(reach + 5) * 2}
        height={(reach + 5) * 2}
        rx="3"
        fill={c.crossPlate}
        stroke={c.crossPlateEdge}
        strokeWidth="1.2"
      />
      <path
        d={`M${-arm} ${-reach} H${arm} V${-arm} H${reach} V${arm} H${arm} V${reach} H${-arm} V${arm} H${-reach} V${-arm} H${-arm} Z`}
        fill={c.cross}
      />
    </g>
  );
}

/** The first-aid cabinet below the notice board, right of the window. */
function FirstAidCabinet({ c }: { c: HospitalColors }) {
  const w = 20;
  const h = 14;
  return (
    <g transform="translate(-58, 62) skewY(-27)">
      <rect
        x={-w}
        y={-h}
        width={w * 2}
        height={h * 2}
        rx="2"
        fill={c.crossPlate}
        stroke={c.crossPlateEdge}
        strokeWidth="1.2"
      />
      {/* The door split and its handle: without them the box is a plaque. */}
      <path d={`M2 ${-h} V${h}`} stroke={c.crossPlateEdge} strokeWidth="0.9" />
      <rect x={4} y={-2} width="4.4" height="4" rx="1" fill={c.rail} />
      <path
        d="M-15 -2 H-11 V-6 H-7 V-2 H-3 V2 H-7 V6 H-11 V2 H-15 Z"
        fill={c.cross}
      />
    </g>
  );
}

export function HospitalWalls() {
  const { rooms, currentRoomId } = useAppState();
  const hospitalIndex = rooms
    .filter((room) => room.type !== "lobby" && room.skin === "hospital")
    .findIndex((room) => room.id === currentRoomId);
  const { mode } = useTheme();
  const c = hospitalColors(mode);
  return (
    <g aria-hidden="true" data-skin-layer="hospital-walls">
      <Wainscot side="left" c={c} />
      <Wainscot side="right" c={c} />
      <FirstAidCabinet c={c} />
      <WindowCurtains />
      {hospitalIndex % 2 === 1 ? <MedicalChart /> : <FramedLandscape />}
    </g>
  );
}

// --- Floor props -----------------------------------------------------------

// Half-length from the middle of a bed to its foot, and half-width to its side,
// both on the floor axes: the head is up-right against the back-right wall and
// the foot points down-left into the room.
export const BED_U = { x: -40, y: 20 };
export const BED_V = { x: 18, y: 9 };
// How high the mattress stands off the floor, and how far each rail rises
// above it.
export const BED_H = 20;
export const HEAD_RAIL = 24;
const FOOT_RAIL = 16;

// Where each prop stands, as its contact point on the floor, LISTED BACK TO
// FRONT: the layer is drawn in this order, so a prop nearer the viewer has to
// come later or it ends up behind the one it stands in front of.
//
// PLACEMENT IS A CONSTRAINT HERE, NOT A TASTE. The eight desks are drawn AFTER
// this whole layer, so a desk whose drawing overlaps a bed paints over it -
// and the desks nearest these props stand FURTHER from the viewer than the
// props do, which makes that overlap read as a hole rather than as depth. So
// both beds stand clear of all eight desk footprints and in front of the desk
// grid, along the room's front-right floor edge, where the ward is visible end
// to end. layout.test.ts holds the numbers.
export const PLACEMENT = {
  cabinet: { x: 384, y: 362 },
  bedFar: { x: 300, y: 400 },
  ivStand: { x: 246, y: 432 },
  bedNear: { x: 180, y: 460 },
} as const;

/** Which of these places holds a bed. The layout test measures these against
 *  the desks; everything else here is thin enough to share a tile with one. */
export const BED_SPOTS = ["bedFar", "bedNear"] as const;

/** The box a bed paints, in scene coordinates: the floor rectangle widened to
 *  the frame corners and raised to the top of the head rail. */
export function bedBox(at: { x: number; y: number }) {
  const halfX = -BED_U.x + BED_V.x;
  const halfY = BED_U.y + BED_V.y;
  return {
    minX: at.x - halfX,
    maxX: at.x + halfX,
    minY: at.y - halfY - BED_H - HEAD_RAIL,
    maxY: at.y + halfY,
  };
}

function point(c: { x: number; y: number }, u: number, v: number) {
  return {
    x: c.x + BED_U.x * u + BED_V.x * v,
    y: c.y + BED_U.y * u + BED_V.y * v,
  };
}

function poly(pts: Array<{ x: number; y: number }>, lift = 0) {
  return (
    pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y - lift}`).join(" ") + " Z"
  );
}

/** One bed: a mattress on a frame, a pillow at the head, a blanket over the
 *  foot half, and a rail at each end. Drawn from the two floor axes, so it
 *  stands on the grid the tiles and the desks stand on. */
function Bed({ at, c }: { at: { x: number; y: number }; c: HospitalColors }) {
  const foot = point(at, 1, 0);
  const head = point(at, -1, 0);
  // Floor rectangle, then the same rectangle lifted to mattress height.
  const corners = [
    point(at, 1, 1),
    point(at, 1, -1),
    point(at, -1, -1),
    point(at, -1, 1),
  ];
  const [nearFoot, farFoot, farHead, nearHead] = corners;
  return (
    <g aria-hidden="true">
      {/* Contact shadow. It is the bed's own FOOTPRINT softened, not an
          ellipse drawn around it: both beds stand a few units inside the
          front-right floor edge, and an ellipse wide enough to read under a
          bed hangs over that edge and lands on the slab below it. */}
      <path
        d={poly(corners, -3)}
        fill={c.shadow}
        filter="url(#hospital-soft)"
      />
      {/* The rear head castor and post are behind the mattress and pillow. */}
      <ellipse
        cx={farHead.x}
        cy={farHead.y - 2}
        rx="3"
        ry="1.8"
        fill={c.metalShade}
      />
      <rect
        x={farHead.x - 1.8}
        y={farHead.y - BED_H - HEAD_RAIL}
        width="3.6"
        height={HEAD_RAIL + BED_H}
        rx="1.4"
        fill={c.metalShade}
      />
      {/* The two faces of the frame that face the viewer */}
      <path
        d={`M${nearFoot.x} ${nearFoot.y} L${nearHead.x} ${nearHead.y} L${nearHead.x} ${nearHead.y - BED_H} L${nearFoot.x} ${nearFoot.y - BED_H} Z`}
        fill={c.frameShade}
      />
      <path
        d={`M${nearFoot.x} ${nearFoot.y} L${farFoot.x} ${farFoot.y} L${farFoot.x} ${farFoot.y - BED_H} L${nearFoot.x} ${nearFoot.y - BED_H} Z`}
        fill={c.frame}
      />
      {/* Mattress top */}
      <path d={poly(corners, BED_H)} fill={c.mattress} />
      {/* The sheet, inset so the mattress shows as a lip around it */}
      <path
        d={poly(
          [
            point(at, 0.88, 0.86),
            point(at, 0.88, -0.86),
            point(at, -0.88, -0.86),
            point(at, -0.88, 0.86),
          ],
          BED_H + 3,
        )}
        fill={c.linen}
      />
      {/* Blanket over the foot half, with its own hanging edge */}
      <path
        d={poly(
          [
            point(at, 0.9, 0.9),
            point(at, 0.9, -0.9),
            point(at, 0.08, -0.9),
            point(at, 0.08, 0.9),
          ],
          BED_H + 5,
        )}
        fill={c.blanket}
      />
      <path
        d={`M${point(at, 0.9, 0.9).x} ${point(at, 0.9, 0.9).y - BED_H - 5} L${point(at, 0.9, -0.9).x} ${point(at, 0.9, -0.9).y - BED_H - 5} L${point(at, 0.9, -0.9).x} ${point(at, 0.9, -0.9).y - BED_H + 4} L${point(at, 0.9, 0.9).x} ${point(at, 0.9, 0.9).y - BED_H + 4} Z`}
        fill={c.blanketShade}
      />
      {/* The turned-back top edge of the blanket: the pale band a made bed
          shows across its middle, and at this size the line that tells the
          covered half from the open sheet. */}
      <path
        d={poly(
          [
            point(at, 0.18, 0.9),
            point(at, 0.18, -0.9),
            point(at, 0.04, -0.9),
            point(at, 0.04, 0.9),
          ],
          BED_H + 6.5,
        )}
        fill={c.linen}
      />
      {/* Pillow at the head. Its shaded body is drawn FIRST and its top face
          over it, so the difference between the two lifts reads as the depth
          of the pillow. Drawn the other way round the top face is buried and
          the pillow disappears into the sheet. */}
      {[
        { lift: BED_H + 3, fill: c.linenShade },
        { lift: BED_H + 9, fill: c.pillow },
      ].map(({ lift, fill }) => (
        <path
          key={lift}
          d={poly(
            [
              point(at, -0.5, 0.62),
              point(at, -0.5, -0.62),
              point(at, -0.86, -0.62),
              point(at, -0.86, 0.62),
            ],
            lift,
          )}
          fill={fill}
        />
      ))}
      {/* Head and foot rails: two posts and three bars each */}
      {[
        { end: head, h: HEAD_RAIL, u: -1 },
        { end: foot, h: FOOT_RAIL, u: 1 },
      ].map(({ end, h, u }) => {
        const a = point(at, u, 1);
        const b = point(at, u, -1);
        return (
          <g key={u}>
            <rect
              x={a.x - 1.8}
              y={a.y - BED_H - h}
              width="3.6"
              height={h + BED_H}
              rx="1.4"
              fill={c.metal}
            />
            {u === 1 && (
            <rect
              x={b.x - 1.8}
              y={b.y - BED_H - h}
              width="3.6"
              height={h + BED_H}
              rx="1.4"
              fill={c.metalShade}
            />
            )}
            {[0, 0.45, 0.9].map((t) => (
              <path
                key={t}
                d={`M${a.x} ${a.y - BED_H - h + t * h} L${b.x} ${b.y - BED_H - h + t * h}`}
                stroke={c.metal}
                strokeWidth="2.2"
                strokeLinecap="round"
                fill="none"
              />
            ))}
            {/* The near post, drawn last so it reads as being in front */}
            <circle cx={end.x} cy={end.y - BED_H - h} r="2" fill={c.metal} />
          </g>
        );
      })}
      {/* Castors */}
      {[nearFoot, farFoot, nearHead].map((p, i) => (
        <ellipse
          key={i}
          cx={p.x}
          cy={p.y - 2}
          rx="3"
          ry="1.8"
          fill={c.metalShade}
        />
      ))}
    </g>
  );
}

/** The drip stand standing between the two beds: a wheeled base, a pole, a
 *  hook and a half-full bag with its line running down. */
function IvStand({
  at,
  c,
}: {
  at: { x: number; y: number };
  c: HospitalColors;
}) {
  const poleTop = at.y - 88;
  return (
    <g aria-hidden="true">
      <ellipse
        cx={at.x}
        cy={at.y + 1}
        rx="13"
        ry="6.5"
        fill={c.shadow}
        filter="url(#hospital-soft)"
      />
      {/* Base: three feet on the floor plane */}
      {[
        { dx: -14, dy: 7 },
        { dx: 14, dy: 7 },
        { dx: 0, dy: -7 },
      ].map((f, i) => (
        <path
          key={i}
          d={`M${at.x} ${at.y} L${at.x + f.dx} ${at.y + f.dy} `}
          stroke={c.metalShade}
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      ))}
      <rect
        x={at.x - 1.6}
        y={poleTop}
        width="3.2"
        height={at.y - poleTop}
        rx="1.4"
        fill={c.metal}
      />
      <path
        d={`M${at.x} ${poleTop + 3} L${at.x + 9} ${poleTop + 3}`}
        stroke={c.metal}
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
      {/* Bag, hung off the hook, and the line down from it */}
      <path
        d={`M${at.x + 4} ${poleTop + 7} h13 v24 q0 5 -6.5 5 q-6.5 0 -6.5 -5 Z`}
        fill={c.fluid}
        stroke={c.metalShade}
        strokeWidth="0.9"
      />
      {/* The fluid line across it: what makes a rounded rectangle read as a
          half-full bag rather than a label. */}
      <path
        d={`M${at.x + 4} ${poleTop + 16} h13`}
        stroke={c.metalShade}
        strokeWidth="0.8"
        opacity="0.75"
      />
      <path
        d={`M${at.x + 10} ${poleTop + 36} q3 18 -8 28`}
        stroke={c.metalShade}
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

// How high the curtain hangs and how far it drops. The two are set together:
// the hem has to land near the floor point or the curtain reads as a banner,
// and the rail has to clear the desk standing behind it, which is what fixes
// the height.
const CURTAIN_RISE = 96;
const CURTAIN_DROP = 88;

/** The cubicle curtain, gathered against its rail beside the far bed's head -
 *  which is how a curtain stands when nobody has pulled it round. */
function Curtain({
  at,
  c,
}: {
  at: { x: number; y: number };
  c: HospitalColors;
}) {
  const top = at.y - CURTAIN_RISE;
  // The rail runs along the floor axis the beds are laid on, so the curtain
  // hangs square to them rather than across the grid, and each fold hangs from
  // its own point on it - a flat top line reads as a board, not cloth.
  const width = 44;
  const drop = CURTAIN_DROP;
  const folds = [0, 0.25, 0.5, 0.75, 1];
  return (
    <g aria-hidden="true">
      <path
        d={`M${at.x - width / 2 - 6} ${top - 3 - width / 4} L${at.x + width / 2 + 6} ${top + 3 + width / 4}`}
        stroke={c.metalShade}
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* One panel behind the folds, so the gaps between them are cloth and
          not floor. */}
      <path
        d={`M${at.x - width / 2} ${top - width / 4} L${at.x + width / 2} ${top + width / 4} L${at.x + width / 2} ${top + width / 4 + drop} L${at.x - width / 2} ${top - width / 4 + drop} Z`}
        fill={c.curtainShade}
      />
      {/* The mesh band along the top, which every ward curtain carries and
          which is what separates one from a shower curtain. */}
      <path
        d={`M${at.x - width / 2} ${top - width / 4} L${at.x + width / 2} ${top + width / 4} L${at.x + width / 2} ${top + width / 4 + 11} L${at.x - width / 2} ${top - width / 4 + 11} Z`}
        fill={c.curtain}
        opacity="0.5"
      />
      {folds.map((t, i) => {
        const x = at.x - width / 2 + t * width;
        const y = top - width / 4 + t * (width / 2);
        const sway = i % 2 ? 2.5 : -2.5;
        return (
          <path
            key={t}
            d={`M${x} ${y} q${sway} ${drop / 2} ${-sway * 0.5} ${drop} l6 0 q${sway * 0.5} ${-drop} ${-sway} ${-drop} Z`}
            fill={i % 2 ? c.curtain : c.curtainShade}
          />
        );
      })}
      {/* The hem, which is where a curtain stops looking like a wall. */}
      <path
        d={`M${at.x - width / 2} ${top - width / 4 + drop} q${width / 4} ${8} ${width / 2} ${width / 4} q${width / 4} ${width / 4 - 8} ${width / 2} ${width / 4}`}
        fill="none"
        stroke={c.curtain}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </g>
  );
}

/** What stands at each place in PLACEMENT. Splitting it out is what lets the
 *  layer be drawn straight from PLACEMENT, so the list's back-to-front order
 *  IS the drawing order and neither can drift from the other. */
export const FURNITURE: Record<
  keyof typeof PLACEMENT | "curtain",
  (props: { at: { x: number; y: number }; c: HospitalColors }) => ReactElement
> = {
  curtain: Curtain,
  cabinet: BedsideCabinet,
  bedFar: Bed,
  ivStand: IvStand,
  bedNear: Bed,
};

export function HospitalProps() {
  const { mode } = useTheme();
  const c = hospitalColors(mode);
  return (
    <g data-skin-layer="hospital-props">
      <defs>
        <filter id="hospital-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
      </defs>
      {Object.entries(PLACEMENT).map(([spot, at]) => {
        const Piece = FURNITURE[spot as keyof typeof PLACEMENT];
        return <Piece key={spot} at={at} c={c} />;
      })}
    </g>
  );
}
