// The room chats as the human chats list them (task 5b055cf3): the lobby's,
// then each room the member sees, in their room order. A hidden room is not
// in state.rooms, so its chat lists, counts and lights nothing, even while
// its posts reach the store. No rows at all without full_state's room chat
// summaries (a permission pack without the room chats area).
import { useMemo } from "react";
import { useI18n } from "../i18n.tsx";
import { useAppState } from "../store.tsx";
import { LOBBY_ROOM_ID } from "../../shared/types.ts";
import { roomChatRows, type RoomChatRow } from "../room-chats-reducer.ts";

export type { RoomChatRow };

export function useRoomChatRows(): RoomChatRow[] {
  const { rooms, roomChats } = useAppState();
  return useMemo(() => roomChatRows({ rooms, roomChats }), [rooms, roomChats]);
}

// The unread count of one room's chat, or 0 for a room the member does not
// see.
export function useRoomChatUnread(roomId: string): number {
  return useRoomChatRows().find((row) => row.roomId === roomId)?.unread ?? 0;
}

// Whether the member reaches this room's chat now: it has a summary and the
// room is the lobby or one they see.
export function useRoomChatReachable(roomId: string): boolean {
  return useRoomChatRows().some((row) => row.roomId === roomId);
}

// A room chat's title: "<room> chat", the lobby's included.
export function useRoomChatTitle(roomId: string): string {
  const { t } = useI18n();
  const { rooms } = useAppState();
  const room =
    roomId === LOBBY_ROOM_ID
      ? t("common.lobby")
      : (rooms.find((r) => r.id === roomId)?.name ?? "");
  return t("roomChat.title", { room });
}
