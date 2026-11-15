// The desktop sidebar on a page refresh (task 3010302f; Nil, 2026-11-15:
// "when i refresh the office page, the pinned and recent sections of the side
// bar are missing and load a bit later. so the member list appears in their
// place instead, and then suddenly gets yanked away"). The server sends
// session_context, the member's own record, users_list and full_state, each
// in its own frame. Pinned and Recent need the agents of full_state, so the
// lists below the Office row wait for full_state and then draw at once, in
// their final order.
//
// The page rows and the Office row follow the member's own record (a
// permission pack hides some rows; Nil, 2026-11-15: "Fix the cause: the page
// gets the member's own permissions (their self record) with its first data,
// so the page rows are right from the start and no member waits"). They draw
// when that record arrives, already right, and later frames do not change
// them. The header draws at load.
//
// This file sends each frame itself, in the server's order (the fixture's
// boot() sends full_state first). The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { SceneDecorationContext } =
  await import("./office/scene-decoration.tsx");
const { StoreProvider } = await import("./store.tsx");
const { setShim, shimEmit } = await import("./ws.ts");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const {
  LOAD_ENTRY,
  backbencher,
  builder,
  faraway,
  memberWire,
  navRow,
  ranger,
  receptionist,
  scout,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;
type UserRecord = import("../shared/types.ts").UserRecord;

setUpChatSidebarTests();

const ROOMS = [
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
  { id: "r2", name: "Second room", prompt: null, canCloseWhenEmpty: true },
];

const count = (view: View, selector: string) =>
  view.container.querySelectorAll(`nav[data-chat-sidebar] ${selector}`).length;
const one = (view: View, selector: string) =>
  view.container.querySelector(`nav[data-chat-sidebar] ${selector}`);

// Load the office at "/" with the socket open and no frame sent yet.
async function mount(): Promise<View> {
  window.history.replaceState(LOAD_ENTRY, "", "/");
  let opened!: () => void;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  setShim(
    () => {},
    () => opened(),
  );
  const view = render(
    createElement(
      StoreProvider,
      null,
      createElement(
        SceneDecorationContext.Provider,
        { value: false },
        createElement(App),
      ),
    ),
  );
  await act(async () => {
    await open;
  });
  return view;
}

async function frame(msg: unknown): Promise<void> {
  await act(async () => {
    shimEmit(msg as never);
  });
}

const sessionContext = {
  type: "session_context",
  context: { username: "member", userId: "u1", role: "member" },
};
const selfFrame = (over: Partial<UserRecord>) => ({
  type: "user_self_updated",
  user: {
    ...selfUserRecord(null),
    id: "u1",
    name: "member",
    role: "member",
    allowedRooms: ["r1", "r2"],
    ...over,
  },
});
const usersList = {
  type: "users_list",
  users: [
    { ...memberWire("u1", "member"), role: "member" },
    memberWire("u2", "Ada"),
  ],
};
const fullState = {
  type: "full_state",
  agents: [scout, ranger, builder, faraway, backbencher, receptionist],
  rooms: ROOMS,
  office: { name: "Test Office" },
  recentCwds: [],
  killedAgents: [],
  interactions: [],
};

it("draws Pinned, Recent and Members together at full_state, Pinned and Recent first", async () => {
  const view = await mount();
  // The frames the server sends before full_state, in its order.
  await frame(sessionContext);
  await frame(
    selfFrame({ pinnedAgents: [faraway.id], recentAgents: [ranger.id] }),
  );
  await frame(usersList);
  await act(async () => {});

  // Before full_state: the sidebar and its Office row are there, the lists
  // below it are not.
  expect(view.container.querySelectorAll("nav[data-chat-sidebar]").length).toBe(
    1,
  );
  expect(navRow(view, "office")).not.toBeNull();
  expect(count(view, "[data-sidebar-members]")).toBe(0);
  expect(count(view, "[data-sidebar-member]")).toBe(0);
  expect(count(view, '[data-sidebar-nav="members-chat"]')).toBe(0);
  expect(count(view, "[data-sidebar-section]")).toBe(0);
  expect(count(view, "[data-sidebar-room]")).toBe(0);

  await frame(fullState);

  // At full_state: every list, with the data of the earlier frames.
  const pinned = one(view, 'button[data-sidebar-section="pinned"]');
  const recent = one(view, 'button[data-sidebar-section="recent"]');
  const members = one(view, "[data-sidebar-members]");
  expect(pinned).not.toBeNull();
  expect(recent).not.toBeNull();
  expect(members).not.toBeNull();
  expect(
    count(
      view,
      `[data-sidebar-section-agents="pinned"] [data-sidebar-agent="${faraway.id}"]`,
    ),
  ).toBe(1);
  expect(
    count(
      view,
      `[data-sidebar-section-agents="recent"] [data-sidebar-agent="${ranger.id}"]`,
    ),
  ).toBe(1);
  expect(count(view, '[data-sidebar-member="u2"]')).toBe(1);
  expect(count(view, '[data-sidebar-room="r1"]')).toBe(1);
  // Pinned, then Recent, then Members.
  const follows = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  expect(follows(pinned!, recent!)).toBe(true);
  expect(follows(recent!, members!)).toBe(true);
});

it("draws the page rows with the member's own record, already right for a pack, and later frames keep them", async () => {
  const view = await mount();
  // The rows a member sees, by name; Tasks and Apps are outside this pack.
  const rows = () =>
    (["tasks", "apps", "integrations", "settings", "office"] as const).map(
      (row) => navRow(view, row) !== null,
    );
  const without = [false, false, true, true, true];

  await frame(sessionContext);
  // Before the member's own record: the sidebar, no row.
  expect(view.container.querySelectorAll("nav[data-chat-sidebar]").length).toBe(
    1,
  );
  expect(count(view, "[data-sidebar-nav]")).toBe(0);

  await frame(
    selfFrame({
      pack: { areas: { agentManagement: "read" }, agentCeiling: "web" },
    }),
  );
  expect(rows()).toEqual(without);

  // The public roster does not turn the record back into a public one.
  await frame(usersList);
  expect(rows()).toEqual(without);

  await frame(fullState);
  expect(rows()).toEqual(without);
  expect(count(view, "[data-sidebar-members]")).toBe(1);
});
