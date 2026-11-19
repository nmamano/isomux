// Room chat state for tests (task 5b055cf3): the lobby's chat, once the
// members chat, as AppState.roomChats holds it.
import { LOBBY_ROOM_ID } from "../../shared/types.ts";
import { EMPTY_ROOM_CHAT } from "../room-chats-reducer.ts";
import type { AppState, MembersChatState } from "../store.tsx";

export { LOBBY_ROOM_ID };

// AppState.roomChats with only the lobby's chat.
export function lobbyChats(
  chat: Partial<MembersChatState>,
): Record<string, MembersChatState> {
  return { [LOBBY_ROOM_ID]: { ...EMPTY_ROOM_CHAT, ...chat } };
}

// The lobby's chat slice of a state (empty when it has none).
export function lobbyChat(
  state: Pick<AppState, "roomChats">,
): MembersChatState {
  return state.roomChats[LOBBY_ROOM_ID] ?? EMPTY_ROOM_CHAT;
}
