import {
  DEFAULT_ROOM_SKIN,
  effectiveRoomSkin,
  type RoomSkin,
} from "../../../shared/room-skins.ts";
import {
  storedRoomDecor,
  type ResolvedRoomDecor,
} from "../../../shared/room-decor.ts";
import { ordinaryRooms, type RoomWire } from "../../../shared/types.ts";
import { useAppState, useTheme } from "../../store.tsx";
import type { ThemeMode } from "../../themes.ts";
import { roomPaletteIndex } from "../grid.ts";
import { hospitalColors, hospitalSceneVars } from "./hospital/palette.ts";
import { FirstAidCabinet, HospitalProps, Wainscot } from "./hospital/props.tsx";
import {
  FramedLandscape,
  MedicalChart,
  WindowCurtains,
} from "./hospital/decorations.tsx";

// A room skin is a PRESET: a value for every decor slot in
// shared/room-decor.ts. A room draws its preset's value for each slot, replaced
// by whatever its members picked (room.decor). The scene draws itself the same
// way under every preset - eight desks in the same eight places, with the same
// characters and status lights - and only the decorations change.
//
// Adding a preset is: one entry in ROOM_PRESETS, one id in
// shared/room-skins.ts, its name in the four languages, and its tile drawing in
// ui/components/RoomDecorPicker.tsx.

/** The two room-dependent defaults: the sill alternates between the trailing
 *  plant and the blossom jar from room to room, and hospital rooms alternate
 *  their picture. Both keep the alternation every room had before the menu. */
interface PresetContext {
  blossom: boolean;
  hospitalIndex: number;
}

export const ROOM_PRESETS: Record<
  RoomSkin,
  (ctx: PresetContext) => ResolvedRoomDecor
> = {
  // The room every office has drawn since before skins existed.
  office: (ctx) => ({
    walls: "office",
    curtains: "none",
    sill: ctx.blossom ? "blossom" : "trailing",
    wallArt: "neon",
    trim: "none",
    cabinet: "none",
    floorPlant: "plant",
    ward: "none",
    pet: "shown",
  }),
  hospital: (ctx) => ({
    walls: "clinic",
    curtains: "tied",
    sill: ctx.blossom ? "blossom" : "trailing",
    wallArt: ctx.hospitalIndex % 2 === 1 ? "chart" : "landscape",
    trim: "rail",
    cabinet: "first-aid",
    floorPlant: "plant",
    ward: "beds",
    pet: "none",
  }),
};

function presetContext(roomId: string, rooms: RoomWire[]): PresetContext {
  return {
    blossom:
      roomPaletteIndex(
        ordinaryRooms(rooms).findIndex((r) => r.id === roomId),
        2,
      ) === 0,
    hospitalIndex: rooms
      .filter((r) => r.type !== "lobby" && r.skin === "hospital")
      .findIndex((r) => r.id === roomId),
  };
}

/** What the preset alone draws in this room, before any choice. The room is
 *  counted with `skin`, not with whatever it stores: the settings pane asks
 *  for a preset the room does not have yet, and the hospital picture rotates
 *  by the room's place among hospital rooms - which picking Hospital changes. */
export function presetDecor(
  skin: RoomSkin,
  roomId: string,
  rooms: RoomWire[],
): ResolvedRoomDecor {
  const withSkin = rooms.map((r) => (r.id === roomId ? { ...r, skin } : r));
  return ROOM_PRESETS[skin](presetContext(roomId, withSkin));
}

/** What a room draws: its preset, with its members' choices on top. */
export function resolveRoomDecor(
  room: RoomWire,
  rooms: RoomWire[],
): ResolvedRoomDecor {
  return {
    ...presetDecor(effectiveRoomSkin(room), room.id, rooms),
    ...storedRoomDecor(room.decor),
  };
}

/** The decor the scene is being drawn in right now. The lobby has its own
 *  scene and takes no decor, so it answers with the office preset. */
export function useCurrentRoomDecor(): ResolvedRoomDecor {
  const { currentRoomId, rooms, lobbyOpen } = useAppState();
  const room = rooms.find((r) => r.id === currentRoomId);
  if (lobbyOpen || !room || room.type === "lobby") {
    return ROOM_PRESETS[DEFAULT_ROOM_SKIN]({
      blossom: false,
      hospitalIndex: -1,
    });
  }
  return resolveRoomDecor(room, rooms);
}

/** The scene palette's variable overrides for a `walls` choice. The office
 *  palette is the theme's own, so it overrides nothing. */
export function sceneVarsFor(
  walls: ResolvedRoomDecor["walls"],
  mode: ThemeMode,
): Record<string, string> {
  return walls === "clinic" ? hospitalSceneVars(mode) : {};
}

/** The scene container's variable overrides for the current room. Spread into
 *  its style: everything drawn inside inherits them, and nothing outside the
 *  scene - the tab bar, the HUD, the panels - is touched. */
export function useRoomSkinVars(): Record<string, string> {
  const { walls } = useCurrentRoomDecor();
  const { mode } = useTheme();
  return sceneVarsFor(walls, mode);
}

/** The wall pieces a room's decor hangs, in scene coordinates. Mounted last
 *  inside the Walls svg; the settings tiles draw them small. */
export function DecorWallPieces({
  decor,
}: {
  decor: Pick<ResolvedRoomDecor, "trim" | "cabinet" | "curtains" | "wallArt">;
}) {
  const { mode } = useTheme();
  const c = hospitalColors(mode);
  return (
    <>
      {decor.trim === "rail" && (
        <>
          <Wainscot side="left" c={c} />
          <Wainscot side="right" c={c} />
        </>
      )}
      {decor.cabinet === "first-aid" && <FirstAidCabinet c={c} />}
      {decor.curtains === "tied" && <WindowCurtains />}
      {decor.wallArt === "landscape" && <FramedLandscape />}
      {decor.wallArt === "chart" && <MedicalChart />}
    </>
  );
}

export function DecorWalls() {
  const decor = useCurrentRoomDecor();
  const empty =
    decor.trim === "none" &&
    decor.cabinet === "none" &&
    decor.curtains === "none" &&
    decor.wallArt !== "landscape" &&
    decor.wallArt !== "chart";
  if (empty) return null;
  return (
    <g aria-hidden="true" data-skin-layer="decor-walls">
      <DecorWallPieces decor={decor} />
    </g>
  );
}

/** Takes the choice as a prop rather than reading it: this one is mounted
 *  inside the memoized props scene, whose whole point is not to re-reconcile
 *  the prop svg on every action, and a whole-state subscription in here would
 *  undo that. */
export function DecorProps({ ward }: { ward: ResolvedRoomDecor["ward"] }) {
  return ward === "beds" ? <HospitalProps /> : null;
}
