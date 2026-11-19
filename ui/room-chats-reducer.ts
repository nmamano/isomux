// The store's room chats (task 5b055cf3): state.roomChats, by room id. The
// lobby's is the old members chat. Each slice is hydrated by a REST page
// fetch while its chat is open and kept live by the room_chat_* wire events.
// `loaded` drops on every full_state so an open chat refetches; `unread` is
// the server's count after the caller's read pointer, bumped locally for a
// new post that is not the member's own until the next markRead answer.
import { recentMembersChatPins } from "../shared/members-chat.ts";
import {
  LOBBY_ROOM_ID,
  ordinaryRooms,
  type MembersChatMessage,
  type MembersChatSummary,
} from "../shared/types.ts";
import type { Action, AppState, MembersChatState } from "./store.tsx";

type RoomChatAction = Extract<
  Action,
  {
    type:
      | "room_chat_page"
      | "room_chat_pins"
      | "room_chat_message"
      | "room_chat_deleted"
      | "room_chat_read";
  }
>;

// The room chats as the human chats list them: the lobby's, then each room
// the member sees, in their room order. A hidden room is not in state.rooms,
// so its chat lists, counts and lights nothing, even while its posts reach
// the store. No rows at all without full_state's room chat summaries (a
// permission pack without the room chats area).
export interface RoomChatRow {
  roomId: string;
  // The room's name; null for the lobby, which the caller names.
  name: string | null;
  unread: number;
}

export function roomChatRows(
  state: Pick<AppState, "rooms" | "roomChats">,
): RoomChatRow[] {
  const lobby = state.roomChats[LOBBY_ROOM_ID];
  if (!lobby) return [];
  const rows: RoomChatRow[] = [
    { roomId: LOBBY_ROOM_ID, name: null, unread: lobby.unread },
  ];
  for (const room of ordinaryRooms(state.rooms)) {
    const chat = state.roomChats[room.id];
    if (chat)
      rows.push({ roomId: room.id, name: room.name, unread: chat.unread });
  }
  return rows;
}

export const EMPTY_ROOM_CHAT: MembersChatState = {
  messages: [],
  hasMore: false,
  loaded: false,
  readPointer: null,
  unread: 0,
};

function withRoom(
  state: AppState,
  roomId: string,
  chat: MembersChatState,
): AppState {
  return { ...state, roomChats: { ...state.roomChats, [roomId]: chat } };
}

// Whether a post counts as the member's own for the local unread bump: the
// member or their API token, never one of their agents (the server counts an
// agent's post as unread for its manager).
export function isOwnPost(
  message: Pick<MembersChatMessage, "userId" | "kind">,
  userId: string | undefined,
): boolean {
  return message.userId === userId && message.kind !== "agent";
}

// full_state's summaries are the whole set of room chats the member reaches.
// A held chat keeps its messages but drops loaded, so an open chat refetches;
// a room missing from the summaries goes. An older server sends none: the
// held chats stay, unloaded.
export function roomChatsFromSummaries(
  held: Record<string, MembersChatState>,
  summaries: Record<string, MembersChatSummary> | undefined,
): Record<string, MembersChatState> {
  if (!summaries) {
    const out: Record<string, MembersChatState> = {};
    for (const [roomId, chat] of Object.entries(held))
      out[roomId] = { ...chat, loaded: false };
    return out;
  }
  const out: Record<string, MembersChatState> = {};
  for (const [roomId, s] of Object.entries(summaries)) {
    const prev = held[roomId] ?? EMPTY_ROOM_CHAT;
    out[roomId] = {
      ...prev,
      readPointer: s.readPointer,
      unread: s.unread,
      pinCount: s.pins,
      loaded: false,
    };
  }
  return out;
}

export function dropRoomChat(state: AppState, roomId: string): AppState {
  if (!(roomId in state.roomChats)) return state;
  const roomChats = { ...state.roomChats };
  delete roomChats[roomId];
  return { ...state, roomChats };
}

export function reduceRoomChat(
  state: AppState,
  action: RoomChatAction,
): AppState {
  const held = state.roomChats[action.roomId];
  const mc = held ?? EMPTY_ROOM_CHAT;
  switch (action.type) {
    // `prepend` is an older page landing above what the chat already holds;
    // otherwise the page REPLACES the slice (initial load or a reconnect
    // refetch), keeping any live message that arrived meanwhile.
    case "room_chat_page": {
      const incoming = action.messages;
      const ids = new Set(incoming.map((m) => m.id));
      const kept = mc.messages.filter((m) => !ids.has(m.id));
      // Message ids carry a random suffix and do not sort. A fresh page
      // replaces the request-time cache, retaining only arrivals during fetch.
      const heldAtRequest = new Set(action.heldAtRequest ?? []);
      const messages = action.prepend
        ? [...incoming, ...kept]
        : [...incoming, ...kept.filter((m) => !heldAtRequest.has(m.id))];
      return withRoom(state, action.roomId, {
        ...mc,
        ...(action.pinned &&
        action.pinsRevisionAtRequest === (mc.pinsRevision ?? 0)
          ? { pinned: action.pinned, pinsStale: false }
          : {}),
        messages,
        hasMore: action.prepend ? action.hasMore : action.hasMore || mc.hasMore,
        loaded: true,
        readPointer: action.readPointer,
        unread: action.unread,
      });
    }
    case "room_chat_pins":
      if (!held || action.pinsRevisionAtRequest !== (mc.pinsRevision ?? 0))
        return state;
      return withRoom(state, action.roomId, {
        ...mc,
        pinned: action.pinned,
        pinsStale: false,
      });
    // A post or an in-place update. A held message is replaced where it sits,
    // a new message goes to the end. A new post that is not the member's own
    // bumps the local unread until the next markRead answer replaces it.
    case "room_chat_message": {
      // Edits and reactions in a chat the store does not hold are no news.
      if (!held && action.updateOnly) return state;
      const pinAffected =
        (mc.pinned ?? []).some((message) => message.id === action.message.id) ||
        action.message.pinnedAt !== undefined;
      const pinState = pinAffected
        ? {
            pinned: recentMembersChatPins([
              ...(mc.pinned ?? []).filter(
                (message) => message.id !== action.message.id,
              ),
              action.message,
            ]),
            pinsRevision: (mc.pinsRevision ?? 0) + 1,
            pinsStale: true,
          }
        : {};
      const idx = mc.messages.findIndex((m) => m.id === action.message.id);
      if (idx !== -1) {
        const messages = mc.messages.slice();
        messages[idx] = action.message;
        return withRoom(state, action.roomId, { ...mc, ...pinState, messages });
      }
      // Edits and reactions to an unloaded message are not new arrivals.
      if (action.updateOnly)
        return pinAffected
          ? withRoom(state, action.roomId, { ...mc, ...pinState })
          : state;
      const mine = isOwnPost(action.message, state.sessionContext?.userId);
      return withRoom(state, action.roomId, {
        ...mc,
        ...pinState,
        messages: [...mc.messages, action.message],
        unread: mine ? mc.unread : mc.unread + 1,
      });
    }
    case "room_chat_deleted": {
      if (!held) return state;
      const pinAffected = (mc.pinned ?? []).some(
        (message) => message.id === action.id,
      );
      if (!mc.messages.some((m) => m.id === action.id) && !pinAffected)
        return state;
      return withRoom(state, action.roomId, {
        ...mc,
        messages: mc.messages.filter((m) => m.id !== action.id),
        ...(pinAffected
          ? {
              pinned: mc.pinned!.filter((message) => message.id !== action.id),
              pinsRevision: (mc.pinsRevision ?? 0) + 1,
              pinsStale: true,
            }
          : {}),
      });
    }
    case "room_chat_read":
      return withRoom(state, action.roomId, {
        ...mc,
        readPointer: action.readPointer,
        unread: action.unread,
      });
  }
}
