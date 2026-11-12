// The store's 1:1 chats (task 019e4d7c): state.memberDms, by the peer's id.
// A frame whose peer is the member's own id is ignored: a self pair never
// makes a row.
import type { MemberDmSummary } from "../shared/types.ts";
import type { Action, AppState, MemberDmState } from "./store.tsx";

type DmAction = Extract<
  Action,
  { type: "dm_page" | "dm_message" | "dm_deleted" | "dm_read" }
>;

// An empty 1:1 chat with peerId, named from the roster (the full_state
// summary names it when it comes).
function newDm(state: AppState, peerId: string): MemberDmState {
  let peerName = peerId;
  for (const u of state.users.values())
    if (u.id === peerId) {
      peerName = u.name;
      break;
    }
  return {
    messages: [],
    hasMore: false,
    loaded: false,
    readPointer: null,
    unread: 0,
    peerName,
    removed: false,
    lastAt: null,
  };
}

function withDm(state: AppState, peerId: string, dm: MemberDmState): AppState {
  return { ...state, memberDms: { ...state.memberDms, [peerId]: dm } };
}

// full_state's summaries are the whole set of the member's chats. A held
// chat keeps its messages but drops loaded, so an open chat refetches.
export function dmsFromSummaries(
  held: Record<string, MemberDmState>,
  summaries: MemberDmSummary[] | undefined,
): Record<string, MemberDmState> {
  if (!summaries) return held;
  const out: Record<string, MemberDmState> = {};
  for (const s of summaries) {
    const prev = held[s.peerId];
    out[s.peerId] = {
      messages: prev?.messages ?? [],
      hasMore: prev?.hasMore ?? false,
      loaded: false,
      readPointer: s.readPointer,
      unread: s.unread,
      peerName: s.peerName,
      removed: s.removed,
      lastAt: s.lastAt,
    };
  }
  return out;
}

export function reduceMemberDm(state: AppState, action: DmAction): AppState {
  switch (action.type) {
    case "dm_page": {
      if (action.peerId === state.sessionContext?.userId) return state;
      const dm = state.memberDms[action.peerId] ?? newDm(state, action.peerId);
      const incoming = action.messages;
      const ids = new Set(incoming.map((m) => m.id));
      const kept = dm.messages.filter((m) => !ids.has(m.id));
      const heldAtRequest = new Set(action.heldAtRequest ?? []);
      const messages = action.prepend
        ? [...incoming, ...kept]
        : [...incoming, ...kept.filter((m) => !heldAtRequest.has(m.id))];
      return withDm(state, action.peerId, {
        ...dm,
        messages,
        hasMore: action.prepend ? action.hasMore : action.hasMore || dm.hasMore,
        loaded: true,
        readPointer: action.readPointer,
        unread: action.unread,
      });
    }
    // A post or an in-place update in a 1:1 chat, as members_chat_message.
    // A message from a peer the store did not know makes that peer's row.
    case "dm_message": {
      const self = state.sessionContext?.userId;
      if (action.peerId === self) return state;
      const known = state.memberDms[action.peerId];
      const dm = known ?? newDm(state, action.peerId);
      const idx = dm.messages.findIndex((m) => m.id === action.message.id);
      if (idx !== -1) {
        const messages = dm.messages.slice();
        messages[idx] = action.message;
        return withDm(state, action.peerId, { ...dm, messages });
      }
      if (action.updateOnly) return state;
      const mine = action.message.userId === self;
      return withDm(state, action.peerId, {
        ...dm,
        messages: [...dm.messages, action.message],
        unread: mine ? dm.unread : dm.unread + 1,
        lastAt: action.message.timestamp,
      });
    }
    case "dm_deleted": {
      const dm = state.memberDms[action.peerId];
      if (action.peerId === state.sessionContext?.userId || !dm) return state;
      if (!dm.messages.some((m) => m.id === action.id)) return state;
      return withDm(state, action.peerId, {
        ...dm,
        messages: dm.messages.filter((m) => m.id !== action.id),
      });
    }
    case "dm_read": {
      const dm = state.memberDms[action.peerId];
      if (action.peerId === state.sessionContext?.userId || !dm) return state;
      return withDm(state, action.peerId, {
        ...dm,
        readPointer: action.readPointer,
        unread: action.unread,
      });
    }
  }
}
