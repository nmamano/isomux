// The desktop sidebar's Members section (task 019e4d7c), through the real App,
// store and socket shim: Members chat, then a row per other member, in a
// stable order (unread first, then the newest chat, then the name; never by
// online, so rows do not move under the pointer). A row opens its chat full
// screen in the main pane, in place of an agent chat; an owner's gear opens
// Settings on that member. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
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
  navRow,
  openFirstDesk,
  press,
  requests,
  roomHeader,
  setMemberDms,
  setMembers,
  setOnline,
  setRole,
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

it("lists Members chat, then each other member: unread first, then the newest chat, then the name, never by online", async () => {
  seedOffice();
  const view = await boot();
  const section = view.container.querySelector("[data-sidebar-members]");
  expect(section).not.toBeNull();
  // Document order: the section header, Members chat, then the member rows.
  const order = [
    ...view.container.querySelectorAll(
      "[data-sidebar-members], [data-sidebar-nav='members-chat'], [data-sidebar-member]",
    ),
  ].map(
    (el) =>
      el.getAttribute("data-sidebar-member") ??
      el.getAttribute("data-sidebar-nav") ??
      "header",
  );
  expect(order).toEqual([
    "header",
    "members-chat",
    "u4",
    "u5",
    "u3",
    "u9",
    "u2",
    "u6",
  ]);
  expect(memberRow(view, "u4")?.textContent).toContain("Cid");
  expect(
    memberRow(view, "u4")?.querySelector("[data-sidebar-badge]")?.textContent,
  ).toContain("2");
  expect(
    memberRow(view, "u5")?.querySelector("[data-sidebar-badge]") ?? null,
  ).toBeNull();
  // Only Zed's row is a removed member's; only Eve's is online.
  expect(
    memberRowIds(view).filter((id) =>
      memberRow(view, id!)!.hasAttribute("data-removed"),
    ),
  ).toEqual(["u9"]);
  expect(
    memberRowIds(view).filter((id) =>
      memberRow(view, id!)!.hasAttribute("data-online"),
    ),
  ).toEqual(["u6"]);
  // A member who is not an owner gets no gear.
  expect(
    view.container.querySelectorAll("[data-sidebar-member-settings]").length,
  ).toBe(0);

  // A first message from Ann makes her chat, unread, at the top.
  await act(async () => {
    shimEmit({
      type: "dm_message",
      peerId: "u2",
      message: {
        id: "202611-000000a1",
        kind: "user",
        userId: "u2",
        userName: "Ann",
        timestamp: 300,
        content: "hello",
        attachments: [],
      },
    } as never);
  });
  expect(memberRowIds(view)).toEqual(["u2", "u4", "u5", "u3", "u9", "u6"]);
  expect(
    memberRow(view, "u2")?.querySelector("[data-sidebar-badge]")?.textContent,
  ).toContain("1");
});

it("an owner gets a gear on each live member's row, which opens Settings on that member", async () => {
  seedOffice();
  setRole("owner");
  const view = await boot();
  const gears = [
    ...view.container.querySelectorAll("[data-sidebar-member-settings]"),
  ].map((g) => g.getAttribute("data-sidebar-member-settings"));
  expect(gears.sort()).toEqual(["u2", "u3", "u4", "u5", "u6"]);
  // Reachable by keyboard.
  const beaGear = view.container.querySelector<HTMLElement>(
    '[data-sidebar-member-settings="u3"]',
  )!;
  expect(beaGear.tabIndex).toBeGreaterThanOrEqual(0);

  await click(beaGear);
  const detail = view.container.querySelector(
    "[data-testid='settings-content']",
  );
  expect(detail).not.toBeNull();
  expect(
    view.container.querySelector('[aria-current="true"]')?.textContent,
  ).toContain("Bea");
  expect(humanChat(view)).toBeNull();
});

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

it("Members chat, from a page over a chat, opens Members chat full screen with no page or agent chat left", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await press("t");
  await click(navRow(view, "members-chat"));
  expect({
    chat: humanChat(view),
    agentChat: chatOpen(view),
    tasks: view.container.querySelector("[data-tasks-page]") !== null,
    current: navRow(view, "members-chat")?.getAttribute("aria-current"),
  }).toEqual({
    chat: "members",
    agentChat: false,
    tasks: false,
    current: "page",
  });
});

it("a load at /chats/<id> or /chats/members opens that chat", async () => {
  seedOffice();
  const first = await boot(undefined, "/chats/u4");
  expect(humanChat(first)).toBe("u4");
  expect(memberRow(first, "u4")?.getAttribute("aria-current")).toBe("page");
  first.unmount();

  const second = await boot(undefined, "/chats/members");
  expect(humanChat(second)).toBe("members");
});

it("the collapsed sidebar's open button shows a dot while a human chat has unread", async () => {
  seedOffice();
  const view = await boot();
  await click(memberRow(view, "u3"));
  expect(view.container.querySelector("[data-sidebar-unread-dot]")).toBeNull();
  await click(view.container.querySelector("button[data-sidebar-collapse]"));
  // Cid's 2 unread.
  expect(
    view.container.querySelector("[data-sidebar-unread-dot]"),
  ).not.toBeNull();

  // Cid's chat read on another device: no unread anywhere, no dot.
  await act(async () => {
    shimEmit({
      type: "dm_read",
      peerId: "u4",
      readPointer: "202611-00000009",
      unread: 0,
    } as never);
  });
  expect(view.container.querySelector("[data-sidebar-unread-dot]")).toBeNull();
});
