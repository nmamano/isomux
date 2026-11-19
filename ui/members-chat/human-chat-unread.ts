// Unread across every human chat: the room chats the member sees plus each
// 1:1 chat. The phone's chat button and the collapsed sidebar's open button
// show it.
import { useAppState } from "../store.tsx";
import { useRoomChatRows } from "./room-chat-rows.ts";

export function useHumanChatUnread(): number {
  const { memberDms } = useAppState();
  let total = 0;
  for (const row of useRoomChatRows()) total += row.unread;
  for (const dm of Object.values(memberDms)) total += dm.unread;
  return total;
}
