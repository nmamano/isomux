import { LOBBY_ROOM_ID, type PresenceInfo } from "../../../shared/types.ts";
import { useI18n } from "../../i18n.tsx";
import { GhostBody, GhostTag, SVG_HEIGHT_RATIO } from "../Ghost.tsx";
import { SCENE_W, VB_X, VB_Y } from "../grid.ts";
import { floorXY } from "./geometry.ts";
import type { LayoutSpec } from "./layouts.ts";

import {
  type GhostPlacement,
  GHOST_LOBBY_BASE_X,
  GHOST_LOBBY_BASE_Y,
  GHOST_LOBBY_GAP,
} from "../useGhostTransitions.ts";

const SIZE = 40;
// Leave the right-side zoom stack and its inset clear in scene coordinates.
export const LOBBY_OVERFLOW_RIGHT_MARGIN = 110;
const BODY_HEIGHT = Math.round(SIZE * SVG_HEIGHT_RATIO);

export function lobbyGhostPlacements(
  presences: PresenceInfo[],
  spots: LayoutSpec["ghostSpots"],
) {
  let overflow = 0;
  const visible = presences
    .filter((p) => p.currentRoomId === LOBBY_ROOM_ID)
    .sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  const columns = Math.max(
    1,
    Math.floor(
      (SCENE_W - LOBBY_OVERFLOW_RIGHT_MARGIN - GHOST_LOBBY_BASE_X - SIZE) /
        GHOST_LOBBY_GAP,
    ) + 1,
  );
  // Wrap upward once. Later overflow stacks on that row, so an arrival does
  // not change the spacing of existing ghosts or put bodies below the viewport.
  return visible.map((presence) => {
    const spot = spots.find(
      (s) => s.id !== undefined && s.id === presence.lobbySpotId,
    );
    const point = spot ? floorXY(spot.b, spot.a) : null;
    const position = point
      ? {
          left: point.x - VB_X - SIZE / 2,
          top: point.y - VB_Y - BODY_HEIGHT + 8,
        }
      : {
          left: GHOST_LOBBY_BASE_X + (overflow % columns) * GHOST_LOBBY_GAP,
          top:
            GHOST_LOBBY_BASE_Y -
            Math.min(1, Math.floor(overflow / columns)) * GHOST_LOBBY_GAP,
        };
    if (!point) overflow++;
    return {
      presence,
      dimmed: presence.viewMode === "away",
      ...position,
      // Keep the chip immediately above its own head, even in a full lobby.
      tagTop: spot ? position.top : undefined,
    };
  });
}

export function LobbyGhosts({
  presences,
  spots,
  placements: animatedPlacements,
  naturalPlacements,
  onMove,
  onOpenUser,
}: {
  presences: PresenceInfo[];
  placements?: GhostPlacement[];
  naturalPlacements?: GhostPlacement[];
  spots: LayoutSpec["ghostSpots"];
  onMove?: (spotId: string) => void;
  onOpenUser?: (userId: string) => void;
}) {
  const { t } = useI18n();
  const natural = naturalPlacements ?? lobbyGhostPlacements(presences, spots);
  const placements = animatedPlacements ?? natural;
  const occupied = new Set(natural.map((p) => p.presence.lobbySpotId));
  return (
    <>
      <style>{`.lobby-ghost-spot { border: 1px dashed transparent; } .lobby-ghost-spot:hover, .lobby-ghost-spot:focus-visible { border-color: var(--text-dim); }`}</style>
      {onMove &&
        spots
          .filter((s) => s.id && !occupied.has(s.id))
          .map((s) => {
            const { x, y } = floorXY(s.b, s.a);
            return (
              <button
                className="lobby-ghost-spot"
                key={s.id}
                type="button"
                data-no-pan
                data-lobby-spot={s.id}
                aria-label={t("lobby.moveHere")}
                title={t("lobby.moveHere")}
                onClick={(e) => {
                  e.stopPropagation();
                  onMove(s.id!);
                }}
                style={{
                  position: "absolute",
                  left: x - VB_X - 22,
                  top: y - VB_Y - 22,
                  width: 44,
                  height: 44,
                  padding: 0,
                  zIndex: 199,
                  borderRadius: "50%",
                  background: "transparent",
                  opacity: 0.45,
                  cursor: "pointer",
                }}
              />
            );
          })}
      {placements.map(({ presence: p, left, top }) => (
        <GhostBody
          key={p.connectionId}
          left={left}
          top={top}
          size={SIZE}
          variant={p.avatarVariant}
          color={p.avatarColor}
          username={p.username}
          device={p.device}
          userId={p.userId}
          dimmed={p.viewMode === "away"}
          onClick={onOpenUser}
        />
      ))}
      {placements
        .filter((p) => p.tagTop !== undefined)
        .map(({ presence: p, left, tagTop }) => (
          <GhostTag
            key={p.connectionId}
            left={left}
            top={tagTop!}
            size={SIZE}
            variant={p.avatarVariant}
            color={p.avatarColor}
            username={p.username}
            device={p.device}
            userId={p.userId}
            dimmed={p.viewMode === "away"}
            onClick={onOpenUser}
          />
        ))}
    </>
  );
}
