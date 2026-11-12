// Unread across every human chat: Members chat plus each 1:1 chat. The lobby
// chat button and the collapsed sidebar's open button show it.
import { useAppState } from "../store.tsx";

export function useHumanChatUnread(): number {
  const { membersChat, memberDms } = useAppState();
  let total = membersChat.unread;
  for (const dm of Object.values(memberDms)) total += dm.unread;
  return total;
}
