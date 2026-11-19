// Opening a human chat from the desktop sidebar's Members section (task
// 019e4d7c), through the real App, store and socket shim: a member row opens
// its chat full screen in the main pane, in place of an agent chat, and a load
// at /chats/<id> or /chats/members opens that chat. Split from
// ui/App.human-chat-sidebar.dom.test.tsx, which holds the rows and their
// order, because the 5 s cap is per file. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  LOAD_ENTRY,
  activeRoom,
  agentRow,
  boot,
  chatOpen,
  click,
  currentRows,
  goBack,
  memberWire,
  openFirstDesk,
  requests,
  roomHeader,
  setMemberDms,
  setMembers,
  setOnline,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

// Ann has no chat; Bea, Cid and Dan have one; Cid has 2 unread; Eve is online
// and has no chat; Zed was removed and has a chat. "member" (u1) is the
// signed-in member and gets no row.
function seedOffice(): void {
  setMembers([
    memberWire("u2", "Ann"),
    memberWire("u3", "Bea"),
    memberWire("u4", "Cid"),
    memberWire("u5", "Dan"),
    memberWire("u6", "Eve"),
  ]);
  setOnline(["u1", "u6"]);
  const chat = (peerId: string, peerName: string, lastAt: number) => ({
    peerId,
    peerName,
    removed: false,
    readPointer: null,
    unread: 0,
    lastAt,
  });
  setMemberDms([
    chat("u3", "Bea", 100),
    { ...chat("u4", "Cid", 50), unread: 2 },
    chat("u5", "Dan", 200),
    { ...chat("u9", "Zed", 10), removed: true },
  ]);
}

const memberRow = (view: View, id: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-member="${id}"]`,
  );
const memberRowIds = (view: View) =>
  [
    ...view.container.querySelectorAll(
      "nav[data-chat-sidebar] button[data-sidebar-member]",
    ),
  ].map((row) => row.getAttribute("data-sidebar-member"));
const humanChat = (view: View) =>
  view.container
    .querySelector("[data-human-chat]")
    ?.getAttribute("data-human-chat") ?? null;
const pageRequests = (peerId: string) =>
  requests.filter(
    (r) => r.method === "GET" && r.path.startsWith(`/api/users/${peerId}/chat`),
  ).length;

it("a member row opens the 1:1 chat full screen, marks its row, fetches its page only then, and Back returns to the office", async () => {
  seedOffice();
  const view = await boot();
  expect(pageRequests("u3")).toBe(0);
  expect(humanChat(view)).toBeNull();
  const lobby = () =>
    view.container.querySelector("[data-lobby-tab]")?.outerHTML ?? null;
  const before = { room: activeRoom(view), lobby: lobby() };

  await click(memberRow(view, "u3"));
  expect({
    chat: humanChat(view),
    agentChat: chatOpen(view),
    current: memberRow(view, "u3")?.getAttribute("aria-current"),
  }).toEqual({ chat: "u3", agentChat: false, current: "page" });
  expect(pageRequests("u3")).toBe(1);
  // A deep entry over the load entry, as an agent chat makes.
  expect(window.history.state).toMatchObject({ isomux: true });
  expect(
    memberRowIds(view).filter(
      (id) => memberRow(view, id!)!.getAttribute("aria-current") === "page",
    ),
  ).toEqual(["u3"]);

  await goBack();
  expect({
    chat: humanChat(view),
    room: activeRoom(view),
    lobby: lobby(),
    entry: window.history.state,
  }).toEqual({ chat: null, ...before, entry: LOAD_ENTRY });
});

it("an agent chat and a human chat replace each other", async () => {
  seedOffice();
  const view = await boot();
  await openFirstDesk(view);
  await click(memberRow(view, "u5"));
  expect({ chat: humanChat(view), agentChat: chatOpen(view) }).toEqual({
    chat: "u5",
    agentChat: false,
  });

  if (roomHeader(view, "r1")?.getAttribute("aria-expanded") !== "true")
    await click(roomHeader(view, "r1"));
  await click(agentRow(view, "a1"));
  expect({
    chat: humanChat(view),
    agentChat: chatOpen(view),
    agents: currentRows(view),
    member: memberRow(view, "u5")?.getAttribute("aria-current") ?? null,
  }).toEqual({ chat: null, agentChat: true, agents: ["a1"], member: null });
});

it("a load at /chats/<id>, /chats/rooms/<id> or /chats/members opens that chat", async () => {
  seedOffice();
  const first = await boot(undefined, "/chats/u4");
  expect(humanChat(first)).toBe("u4");
  expect(memberRow(first, "u4")?.getAttribute("aria-current")).toBe("page");
  first.unmount();

  // The old members chat address opens the lobby's room chat.
  const second = await boot(undefined, "/chats/members");
  expect(humanChat(second)).toBe("room:lobby");
  second.unmount();

  const third = await boot(undefined, "/chats/rooms/r2");
  expect(humanChat(third)).toBe("room:r2");
  third.unmount();
});

// Task 5b055cf3: the address of a room the member does not reach opens no
// chat, so no panel shows whose posts would get a 403; the office shows.
it("a load at the chat of a room the member does not reach opens no chat", async () => {
  seedOffice();
  const view = await boot(undefined, "/chats/rooms/zz-not-mine");
  expect(humanChat(view)).toBeNull();
  expect(view.container.querySelector("nav[data-chat-sidebar]") !== null).toBe(
    true,
  );
  expect(
    requests.filter((r) => r.path.startsWith("/api/rooms/zz-not-mine/")),
  ).toHaveLength(0);
});
