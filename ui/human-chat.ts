// The human chats (task 019e4d7c): Members chat and each 1:1 chat with another
// member. One opens full screen in the main pane, like an agent chat.

export type HumanChatKey = { kind: "members" } | { kind: "dm"; peerId: string };

export const MEMBERS_CHAT: HumanChatKey = { kind: "members" };

// The key a chat's draft and the switcher use: "members", or the peer's id.
export function humanChatId(chat: HumanChatKey): string {
  return chat.kind === "members" ? "members" : chat.peerId;
}

export function sameHumanChat(
  a: HumanChatKey | null,
  b: HumanChatKey | null,
): boolean {
  if (a === null || b === null) return a === b;
  return humanChatId(a) === humanChatId(b);
}

// The chat an address names: /chats/members, or /chats/<userId> (a web push
// link). A trailing slash is forgiven. Null for any other path.
export function humanChatForPath(pathname: string): HumanChatKey | null {
  const m = /^\/chats\/([^/]+)\/*$/.exec(pathname);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (id === "members") return MEMBERS_CHAT;
  return id && !id.includes("/") ? { kind: "dm", peerId: id } : null;
}
