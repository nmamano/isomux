// The other members as the human chats list them (the sidebar's Members
// section and the phone's chat switcher): every live member but yourself, and
// a removed member only while a chat with them exists. Order: the newest chat
// first, like a chat app (task b2889127), then the members with no chat by
// name. A message sent or received moves its chat to the top; a read or a
// sign-in never moves a row.
import { useMemo } from "react";
import { useAppState } from "../store.tsx";
import { defaultGhostColorForUserId } from "../../shared/avatar.ts";

export interface MemberChatRow {
  id: string;
  name: string;
  avatarColor: string;
  avatarVariant: string;
  online: boolean;
  unread: number;
  removed: boolean;
  lastAt: number | null;
}

// Whether a 1:1 chat's peer is removed: once the roster has loaded, a peer
// not in it; before that, the summary's flag. The live roster wins over a
// summary from before a removal or a restore.
export function peerIsRemoved(
  usersLoaded: boolean,
  live: boolean,
  summaryRemoved: boolean | undefined,
): boolean {
  return usersLoaded ? !live : summaryRemoved === true;
}

// A 1:1 chat's peer as its view shows it: the roster's name, else the
// summary's, and the removed rule above.
export function useDmPeer(peerId: string): {
  name: string;
  removed: boolean;
  live: boolean;
} {
  const { users, memberDms, usersLoaded } = useAppState();
  return useMemo(() => {
    let live: { name: string } | null = null;
    for (const u of users.values())
      if (u.id === peerId) {
        live = u;
        break;
      }
    const dm = memberDms[peerId];
    return {
      name: live?.name ?? dm?.peerName ?? "",
      removed: peerIsRemoved(usersLoaded, live !== null, dm?.removed),
      live: live !== null,
    };
  }, [users, memberDms, usersLoaded, peerId]);
}

export function useMemberChatRows(): MemberChatRow[] {
  const { users, memberDms, onlineUserIds, sessionContext, usersLoaded } =
    useAppState();
  const self = sessionContext?.userId ?? null;
  return useMemo(() => {
    const rows = new Map<string, MemberChatRow>();
    for (const u of users.values()) {
      if (u.id === self) continue;
      const dm = memberDms[u.id];
      rows.set(u.id, {
        id: u.id,
        name: u.name,
        avatarColor: u.avatarColor ?? defaultGhostColorForUserId(u.id),
        avatarVariant: u.avatarVariant ?? "classic",
        online: onlineUserIds.includes(u.id),
        unread: dm?.unread ?? 0,
        removed: false,
        lastAt: dm?.lastAt ?? null,
      });
    }
    for (const [peerId, dm] of Object.entries(memberDms)) {
      if (peerId === self || rows.has(peerId)) continue;
      rows.set(peerId, {
        id: peerId,
        name: dm.peerName,
        avatarColor: defaultGhostColorForUserId(peerId),
        avatarVariant: "classic",
        online: false,
        unread: dm.unread,
        removed: peerIsRemoved(usersLoaded, false, dm.removed),
        lastAt: dm.lastAt,
      });
    }
    return [...rows.values()].sort(
      (a, b) =>
        (b.lastAt ?? -Infinity) - (a.lastAt ?? -Infinity) ||
        a.name.localeCompare(b.name),
    );
  }, [users, memberDms, onlineUserIds, self, usersLoaded]);
}
