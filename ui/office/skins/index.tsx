import type { ReactElement } from "react";
import {
  DEFAULT_ROOM_SKIN,
  effectiveRoomSkin,
  type RoomSkin,
} from "../../../shared/room-skins.ts";
import { useAppState, useTheme } from "../../store.tsx";
import type { ThemeMode } from "../../themes.ts";
import { hospitalSceneVars } from "./hospital/palette.ts";
import { HospitalProps, HospitalWalls } from "./hospital/props.tsx";

// A room skin is a LOOK: a set of theme variables the office scene already
// paints itself from, plus whatever the skin hangs on the walls and stands on
// the floor. The scene draws itself the same way under every skin - eight desks
// in the same eight places, with the same characters and status lights.
// Each skin can hide decor that does not fit its room.
//
// Adding one is: a new module beside hospital/, one entry in ROOM_SKIN_MODULES,
// one id in shared/room-skins.ts, and its name in the three languages.
export interface RoomSkinModule {
  hideNeon?: boolean;
  hidePet?: boolean;
  /** Theme variables to override on the scene container. Every key must be one
   *  ui/themes.ts declares, because the scene reads them from the theme. */
  vars(mode: ThemeMode): Record<string, string>;
  /** Wall-plane decor, mounted inside the Walls svg (before the doors). */
  Walls?: () => ReactElement;
  /** Floor furniture, mounted in the props svg (before the desks). */
  Props?: () => ReactElement;
}

export const ROOM_SKIN_MODULES: Record<RoomSkin, RoomSkinModule> = {
  // The identity entry: the room every office has drawn since before skins
  // existed. It overrides nothing and adds nothing, which is what makes an
  // absent skin field cost a record nothing.
  office: { vars: () => ({}) },
  hospital: {
    vars: hospitalSceneVars,
    hideNeon: true,
    hidePet: true,
    Walls: HospitalWalls,
    Props: HospitalProps,
  },
};

/** The skin the scene is being drawn in right now. The lobby has its own scene
 *  and takes no skin, so it always answers with the office. */
export function useCurrentRoomSkin(): RoomSkin {
  const { currentRoomId, rooms, lobbyOpen } = useAppState();
  if (lobbyOpen) return DEFAULT_ROOM_SKIN;
  const room = rooms.find((r) => r.id === currentRoomId);
  if (!room || room.type === "lobby") return DEFAULT_ROOM_SKIN;
  return effectiveRoomSkin(room);
}

/** The scene container's variable overrides for the current room. Spread into
 *  its style: everything drawn inside inherits them, and nothing outside the
 *  scene - the tab bar, the HUD, the panels - is touched. */
export function useRoomSkinVars(): Record<string, string> {
  const skin = useCurrentRoomSkin();
  const { mode } = useTheme();
  return ROOM_SKIN_MODULES[skin].vars(mode);
}

export function SkinWalls() {
  const Layer = ROOM_SKIN_MODULES[useCurrentRoomSkin()].Walls;
  return Layer ? <Layer /> : null;
}

/** Takes the skin as a prop rather than reading it: this one is mounted inside
 *  the memoized props scene, whose whole point is not to re-reconcile the prop
 *  svg on every action, and a whole-state subscription in here would undo
 *  that. */
export function SkinProps({ skin }: { skin: RoomSkin }) {
  const Layer = ROOM_SKIN_MODULES[skin].Props;
  return Layer ? <Layer /> : null;
}
