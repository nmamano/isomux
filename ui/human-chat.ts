// The human chats (task 019e4d7c): each room's chat (task 5b055cf3; the
// lobby's was the members chat) and each 1:1 chat with another member. One
// opens full screen in the main pane, like an agent chat.
import { LOBBY_ROOM_ID } from "../shared/types.ts";

export type HumanChatKey =
  { kind: "room"; roomId: string } | { kind: "dm"; peerId: string };

export function roomChat(roomId: string): HumanChatKey {
  return { kind: "room", roomId };
}

export const LOBBY_CHAT: HumanChatKey = roomChat(LOBBY_ROOM_ID);

// The key a chat's draft and the switcher use: "room:<roomId>", or the
// peer's id.
export function humanChatId(chat: HumanChatKey): string {
  return chat.kind === "room" ? `room:${chat.roomId}` : chat.peerId;
}

export function sameHumanChat(
  a: HumanChatKey | null,
  b: HumanChatKey | null,
): boolean {
  if (a === null || b === null) return a === b;
  return humanChatId(a) === humanChatId(b);
}

function decoded(segment: string): string | null {
  try {
    const id = decodeURIComponent(segment);
    return id && !id.includes("/") ? id : null;
  } catch {
    return null;
  }
}

// The chat an address names: /chats/rooms/<roomId>, /chats/members (the
// lobby's chat, from before room chats), or /chats/<userId> (a web push
// link). A trailing slash is forgiven. Null for any other path. Whether the
// member reaches that room is the caller's check.
export function humanChatForPath(pathname: string): HumanChatKey | null {
  const room = /^\/chats\/rooms\/([^/]+)\/*$/.exec(pathname);
  if (room) {
    const roomId = decoded(room[1]);
    return roomId ? roomChat(roomId) : null;
  }
  const m = /^\/chats\/([^/]+)\/*$/.exec(pathname);
  if (!m) return null;
  const id = decoded(m[1]);
  if (id === null) return null;
  if (id === "members") return LOBBY_CHAT;
  return { kind: "dm", peerId: id };
}
