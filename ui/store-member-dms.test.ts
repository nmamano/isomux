// The store's 1:1 chats and the open human chat (task 019e4d7c), through the
// exported reducer.
//
// Pins: full_state's summaries are the whole set (a peer missing from them is
// dropped); a dm_message makes the row of a peer the store did not know, with
// the name from the roster; the peer's new message raises unread, your own
// never does, an update never does; a dm_* frame whose peerId is your own id
// is ignored (a self pair never makes a row); dm_read and dm_deleted touch
// only their peer; the open human chat and the focused agent exclude each
// other; drafts are per chat.

import { describe, it, expect } from "bun:test";
import { reducer, initialState, type AppState } from "./store.tsx";
import type {
  MemberDmSummary,
  MembersChatMessage,
  UserPublicWire,
} from "../shared/types.ts";
import { MEMBERS_CHAT } from "./human-chat.ts";

type Action = Parameters<typeof reducer>[1];
const run = (state: AppState, ...actions: unknown[]) =>
  actions.reduce<AppState>((s, a) => reducer(s, a as Action), state);

const user = (id: string, name: string): UserPublicWire => ({
  id,
  name,
  role: "member",
  avatarColor: "#4a90d9",
  avatarVariant: "classic",
  createdAt: 0,
});

const fullState = (memberDms?: MemberDmSummary[]) => ({
  type: "full_state",
  agents: [{ id: "a1", name: "Scout", roomId: "r1" }],
  recentCwds: [],
  office: { prompt: null, name: null },
  rooms: [{ id: "r1", name: "Room" }],
  killedAgents: [],
  interactions: [],
  ...(memberDms ? { memberDms } : {}),
});

const summary = (
  peerId: string,
  peerName: string,
  over: Partial<MemberDmSummary> = {},
): MemberDmSummary => ({
  peerId,
  peerName,
  removed: false,
  readPointer: null,
  unread: 0,
  lastAt: 1_000,
  ...over,
});

let seq = 0;
const message = (
  userId: string,
  over: Partial<MembersChatMessage> = {},
): MembersChatMessage => ({
  id: `202611-${(++seq).toString(16).padStart(8, "0")}`,
  kind: "user",
  userId,
  userName: userId,
  timestamp: 5_000 + seq,
  content: "hi",
  attachments: [],
  ...over,
});

// Signed in as Nil (u1); Pau (u2) and Mia (u3) are members.
function signedIn(): AppState {
  return run(
    initialState,
    {
      type: "session_context",
      context: {
        userId: "u1",
        username: "Nil",
        role: "owner",
        currentSessionPrefix: "00000000",
        connectionId: "c1",
      },
    },
    {
      type: "users_list",
      users: [user("u1", "Nil"), user("u2", "Pau"), user("u3", "Mia")],
    },
  );
}

describe("1:1 chats in the store", () => {
  it("full_state's summaries are the whole set: a peer missing from the next one is dropped", () => {
    const first = run(
      signedIn(),
      fullState([
        summary("u2", "Pau", { unread: 2, lastAt: 9 }),
        summary("u9", "Zed", { removed: true }),
      ]),
    );
    expect(Object.keys(first.memberDms).sort()).toEqual(["u2", "u9"]);
    expect(first.memberDms.u2).toMatchObject({
      peerName: "Pau",
      removed: false,
      unread: 2,
      lastAt: 9,
      readPointer: null,
      loaded: false,
    });
    expect(first.memberDms.u9.removed).toBe(true);

    const second = run(first, fullState([summary("u2", "Pau")]));
    expect(Object.keys(second.memberDms)).toEqual(["u2"]);
  });

  it("a full_state with no summaries (an older server, or no directMessages area) keeps the held chats and the members chat unread", () => {
    const held = run(
      signedIn(),
      fullState([summary("u2", "Pau", { unread: 2 })]),
      { type: "members_chat_read", readPointer: null, unread: 4 },
    );
    const next = run(held, fullState());
    expect(Object.keys(next.memberDms)).toEqual(["u2"]);
    expect(next.memberDms.u2.unread).toBe(2);
    expect(next.membersChat.unread).toBe(4);
  });

  it("a dm_message makes the row of an unknown peer; the peer's message raises unread, yours and updates never do", () => {
    const s0 = signedIn();
    const fromPau = message("u2");
    const s1 = run(s0, { type: "dm_message", peerId: "u2", message: fromPau });
    expect(s1.memberDms.u2).toMatchObject({
      peerName: "Pau",
      removed: false,
      unread: 1,
      lastAt: fromPau.timestamp,
    });

    const mine = message("u1");
    const s2 = run(s1, { type: "dm_message", peerId: "u2", message: mine });
    expect(s2.memberDms.u2.unread).toBe(1);
    expect(s2.memberDms.u2.lastAt).toBe(mine.timestamp);

    const edited = { ...fromPau, content: "hi!", editedAt: 9_999 };
    const s3 = run(s2, {
      type: "dm_message",
      peerId: "u2",
      message: edited,
      updateOnly: true,
    });
    expect(s3.memberDms.u2.unread).toBe(1);
    // An update of a message the store never held raises no unread either.
    const s4 = run(s0, {
      type: "dm_message",
      peerId: "u3",
      message: message("u3"),
      updateOnly: true,
    });
    expect(s4.memberDms.u3?.unread ?? 0).toBe(0);
  });

  it("ignores every dm frame whose peer is yourself", () => {
    const s0 = run(signedIn(), fullState([summary("u2", "Pau")]));
    const self = message("u1");
    const s1 = run(
      s0,
      { type: "dm_message", peerId: "u1", message: self },
      { type: "dm_read", peerId: "u1", readPointer: self.id, unread: 0 },
      { type: "dm_deleted", peerId: "u1", id: self.id },
    );
    expect(Object.keys(s1.memberDms)).toEqual(["u2"]);
    expect(s1.memberDms).toEqual(s0.memberDms);
  });

  it("dm_read and dm_deleted change only their peer's chat", () => {
    const s0 = run(
      signedIn(),
      fullState([
        summary("u2", "Pau", { unread: 3 }),
        summary("u3", "Mia", { unread: 4 }),
      ]),
    );
    const held = message("u2");
    const s1 = run(
      s0,
      {
        type: "dm_page",
        peerId: "u2",
        messages: [held],
        hasMore: false,
        readPointer: null,
        unread: 3,
        prepend: false,
      },
      { type: "dm_read", peerId: "u2", readPointer: held.id, unread: 0 },
    );
    expect(s1.memberDms.u2).toMatchObject({
      readPointer: held.id,
      unread: 0,
      loaded: true,
    });
    expect(s1.memberDms.u2.messages.map((m) => m.id)).toEqual([held.id]);
    expect(s1.memberDms.u3.unread).toBe(4);

    const s2 = run(s1, { type: "dm_deleted", peerId: "u2", id: held.id });
    expect(s2.memberDms.u2.messages.length).toBe(0);
    expect(s2.memberDms.u3).toEqual(s1.memberDms.u3);
  });

  it("the open human chat and the focused agent exclude each other", () => {
    const s0 = run(signedIn(), fullState());
    const focused = run(s0, { type: "focus", agentId: "a1" });
    expect(focused.focusedAgentId).toBe("a1");

    const chat = run(focused, {
      type: "open_human_chat",
      chat: { kind: "dm", peerId: "u2" },
    });
    expect(chat.openHumanChat).toEqual({ kind: "dm", peerId: "u2" });
    expect(chat.focusedAgentId).toBeNull();

    const back = run(chat, { type: "focus", agentId: "a1" });
    expect(back.focusedAgentId).toBe("a1");
    expect(back.openHumanChat).toBeNull();
  });

  it("keeps a draft per chat", () => {
    const s = run(
      signedIn(),
      { type: "set_human_chat_draft", chat: MEMBERS_CHAT, text: "to all" },
      {
        type: "set_human_chat_draft",
        chat: { kind: "dm", peerId: "u2" },
        text: "to pau",
      },
      {
        type: "set_human_chat_draft",
        chat: { kind: "dm", peerId: "u3" },
        text: "to mia",
      },
      {
        type: "set_human_chat_draft",
        chat: { kind: "dm", peerId: "u3" },
        text: "to mia, again",
      },
    );
    expect(s.humanChatDrafts).toEqual({
      members: "to all",
      u2: "to pau",
      u3: "to mia, again",
    });
  });
});
