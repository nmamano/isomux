import { useAppState, useTheme } from "../store.tsx";
import { SCENE_W, SCENE_H, VB_X, VB_Y } from "./grid.ts";

// Contact shadows for the props that stand on the floor: the pet bed, the
// potted plant and the water cooler.
//
// Each shadow sits CENTRED under its prop and carries no light direction.
// The window on the left wall is the scene's key light, so a shadow offset
// down and to the right is the geometrically correct drawing, and that is
// what this file did first. It looked worse: an off-centre shadow reads as a
// mistake at this scale, whatever the sun says (Nil, 2026-09-05). Centred and
// faint wins.
//
// The desks are deliberately not in this list. DeskSprite.tsx draws its own
// shadow inside the sprite, that one is the keeper, and a second shadow under
// it did not read as one shadow (Nil, 2026-09-05).

// "grounded" keeps a solid core and drops it over the last third of the
// radius, which reads as a penumbra. "soft" fades from the centre, which is
// more of a haze. Both are drawn at floor perspective (2:1) - the switch is
// only the falloff.
const SHADOW_STYLE: "grounded" | "soft" = "grounded";

// Floor diamond, from the tile grid in Floor.tsx: back (120,40),
// left (-355,277.5), right (595,277.5), front (120,515). Everything is
// clipped to it so no shadow runs off the slab.
const FLOOR_CLIP = "M120 40 L-355 277.5 L120 515 L595 277.5 Z";

// The cat bed in RoomProps.tsx sits at translate(120,460); its base ellipse is
// cx 0 cy 10 rx 26 ry 14, so the bed meets the floor centred on (120,470).
// The bed sets the reference weight; dim scales a prop down from it.
const CAT_BED = { cx: 120, cy: 470, rx: 36, ry: 19, dim: 1 };

// The potted plant sits at translate(-245,212) scale(1.5); its pot runs from
// local y 0 to y 20 and is 16 wide, so the pot meets the floor at (-245,242).
// The pot is half the width of its shadow and stands on the room's darkest
// tiles, so the bed's weight reads heavy under it (Nil, 2026-09-05).
const PLANT = { cx: -245, cy: 242, rx: 25, ry: 12.5, dim: 0.55 };

// The water cooler sits at translate(540,225) scale(1.5) and only in the last
// room; its base plate runs from local y 30 to 34 and is 14 wide. Same
// narrow-base-under-a-wide-shadow case as the plant.
const COOLER = { cx: 540, cy: 276, rx: 22, ry: 11, dim: 0.55 };

function Blob({
  cx,
  cy,
  rx,
  ry,
  dim,
}: {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  dim: number;
}) {
  return (
    <ellipse
      cx={cx}
      cy={cy}
      rx={rx}
      ry={ry}
      fill="url(#gs-blob)"
      opacity={dim}
    />
  );
}

export function GroundShadows() {
  const { currentRoomId, rooms } = useAppState();
  const { mode } = useTheme();
  const isLastRoom = rooms[rooms.length - 1]?.id === currentRoomId;

  // A near-black floor swallows a shadow, so the dark theme carries the
  // stronger one; the light theme seats the props at less.
  const core = mode === "light" ? 0.24 : 0.42;

  const stops =
    SHADOW_STYLE === "grounded" ? (
      <>
        <stop offset="0" stopColor="#000" stopOpacity={core} />
        <stop offset="0.55" stopColor="#000" stopOpacity={core} />
        <stop offset="0.78" stopColor="#000" stopOpacity={core * 0.5} />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </>
    ) : (
      <>
        <stop offset="0" stopColor="#000" stopOpacity={core * 0.85} />
        <stop offset="0.3" stopColor="#000" stopOpacity={core * 0.6} />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </>
    );

  return (
    <svg
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      width={SCENE_W}
      height={SCENE_H}
      viewBox={`${VB_X} ${VB_Y} ${SCENE_W} ${SCENE_H}`}
      overflow="visible"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="gs-blob">{stops}</radialGradient>
        <clipPath id="gs-floor">
          <path d={FLOOR_CLIP} />
        </clipPath>
      </defs>
      <g clipPath="url(#gs-floor)">
        <Blob {...CAT_BED} />
        <Blob {...PLANT} />
        {isLastRoom && <Blob {...COOLER} />}
      </g>
    </svg>
  );
}
