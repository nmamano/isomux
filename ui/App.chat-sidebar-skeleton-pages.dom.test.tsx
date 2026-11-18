// The desktop sidebar's page rows while it loads (task f66e07e3; Nil,
// 2026-11-15: "The deterministic buttons at the top can appear from the very
// beginning. Only the dynamic region should look like that while loading."):
// they draw from the first paint, and the rows a permission pack hides draw,
// until the member's own record arrives, as this device last drew them. Split
// from ui/App.chat-sidebar-skeleton.dom.test.tsx, which holds the lists'
// placeholders, because the 5 s cap is per file. The parse checks are in
// ui/chat-sidebar.test.ts.
//
// This file sends each frame itself, in the server's order, as
// ui/App.chat-sidebar-refresh.dom.test.tsx does.
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
const { CHAT_SIDEBAR_SHAPE_DEFAULT } = await import("./chat-sidebar.ts");
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
type ChatSidebarShapeBlock = import("./chat-sidebar.ts").ChatSidebarShapeBlock;
setUpChatSidebarTests();

const PAGES_KEY = "isomux-chat-sidebar-pages";

// The page rows of the top block, in order, and the ones a pack can hide.
const ALL_ROWS = [
  "apps",
  "asks",
  "tasks",
  "cronjobs",
  "skills",
  "integrations",
  "settings",
  "office",
];
const GATED = ["apps", "tasks", "cronjobs", "skills"];
const rowsWith = (gated: string[]) =>
  ALL_ROWS.filter((row) => !GATED.includes(row) || gated.includes(row));

const ROOMS = [
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
  { id: "r2", name: "Second room", prompt: null, canCloseWhenEmpty: true },
];

const count = (view: View, selector: string) =>
  view.container.querySelectorAll(`nav[data-chat-sidebar] ${selector}`).length;
const one = (view: View, selector: string) =>
  view.container.querySelector(`nav[data-chat-sidebar] ${selector}`);
const wrapper = (view: View, block: "top" | "lists") =>
  one(view, `[data-sidebar-block="${block}"]`) as HTMLElement | null;
// The rows the top block draws, by name, in order.
const pageRows = (view: View) =>
  [
    ...(wrapper(view, "top")?.querySelectorAll("button[data-sidebar-nav]") ??
      []),
  ].map((el) => el.getAttribute("data-sidebar-nav"));
const skeleton = (view: View) =>
  one(
    view,
    `[data-sidebar-block="lists"] [data-sidebar-skeleton="lists"]`,
  ) as HTMLElement | null;
const skeletonItems = (view: View) => [
  ...(skeleton(view)?.querySelectorAll<HTMLElement>(
    "[data-sidebar-skeleton-item]",
  ) ?? []),
];
const skeletonKinds = (view: View) =>
  skeletonItems(view).map((el) =>
    el.getAttribute("data-sidebar-skeleton-item"),
  );
const kinds = (b: ChatSidebarShapeBlock) => b.items.map((i) => i.kind);
// The first-visit placeholders' leading rows: the default shape's. The room
// groups that fill the rest are checked in the first-visit test.
const defaultKinds = (view: View) =>
  skeletonKinds(view).slice(0, CHAT_SIDEBAR_SHAPE_DEFAULT.lists.items.length);

const storedRaw = (key: string) => window.localStorage.getItem(key);
// The stored page rows as a set (sorted), or null when none is stored.
const storedPages = (): string[] | null => {
  const raw = storedRaw(PAGES_KEY);
  return raw === null ? null : [...(JSON.parse(raw) as string[])].sort();
};

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
// A member whose pack hides every gated page row.
const packSelf = selfFrame({
  pinnedAgents: [faraway.id],
  recentAgents: [ranger.id],
  pack: { areas: { agentManagement: "read" }, agentCeiling: "web" },
});
// A pack with Tasks and webhooks (Automations): two of the gated rows.
const tasksHooksSelf = selfFrame({
  pack: {
    areas: { agentManagement: "read", tasks: "read", webhooks: "read" },
    agentCeiling: "web",
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

const hidePage = () =>
  act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });

it("draws the page rows from the first paint, before any frame; only the lists hold placeholders until full_state", async () => {
  const view = await mount();

  // Before any frame, on a device with nothing stored: every page row, the
  // Office row and the divider, real and in their order; no placeholder in
  // the top block.
  expect(pageRows(view)).toEqual(ALL_ROWS);
  expect(count(view, '[data-sidebar-block="top"] [data-sidebar-divider]')).toBe(
    1,
  );
  expect(
    count(view, '[data-sidebar-block="top"] [data-sidebar-skeleton]'),
  ).toBe(0);
  expect(
    count(view, '[data-sidebar-block="top"] [data-sidebar-skeleton-item]'),
  ).toBe(0);
  // The lists: the default placeholders, hidden from assistive tech, with
  // nothing a member could click, under the page rows.
  expect(defaultKinds(view)).toEqual(kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.lists));
  const el = skeleton(view)!;
  expect(el.getAttribute("aria-hidden")).toBe("true");
  expect(el.querySelectorAll("button, a, input, [tabindex]").length).toBe(0);
  const follows = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  expect(follows(wrapper(view, "top")!, wrapper(view, "lists")!)).toBe(true);
  expect(count(view, "[data-sidebar-section]")).toBe(0);
  expect(count(view, "[data-sidebar-room]")).toBe(0);
  expect(count(view, "[data-sidebar-members]")).toBe(0);

  // A page row works before any data: Tasks opens its page.
  await act(async () => {
    navRow(view, "tasks")!.click();
  });
  expect(navRow(view, "tasks")!.getAttribute("aria-current")).toBe("page");

  // The member's own record (no pack): the same rows; the lists still wait.
  await frame(sessionContext);
  expect(pageRows(view)).toEqual(ALL_ROWS);
  await frame(selfFrame({ pinnedAgents: [faraway.id] }));
  await frame(usersList);
  expect(pageRows(view)).toEqual(ALL_ROWS);
  expect(defaultKinds(view)).toEqual(kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.lists));
  expect(count(view, "[data-sidebar-members]")).toBe(0);

  // full_state: no placeholder left, the lists in their block.
  await frame(fullState);
  expect(count(view, "[data-sidebar-skeleton]")).toBe(0);
  expect(count(view, "[data-sidebar-skeleton-item]")).toBe(0);
  expect(pageRows(view)).toEqual(ALL_ROWS);
  const lists = wrapper(view, "lists")!;
  expect(
    lists.querySelector('button[data-sidebar-section="pinned"]'),
  ).not.toBeNull();
  expect(lists.querySelector('[data-sidebar-room="r1"]')).not.toBeNull();
  expect(lists.querySelector("[data-sidebar-members]")).not.toBeNull();
});

it("before the member's own record, draws the gated page rows this device stored; the record's permissions then win", async () => {
  // A pack holder's set from an earlier load: only Tasks.
  window.localStorage.setItem(PAGES_KEY, JSON.stringify(["tasks"]));
  let view = await mount();
  expect(pageRows(view)).toEqual(rowsWith(["tasks"]));
  // Frames before the record, and a page hide, keep the stored set as it is.
  await frame(sessionContext);
  await frame(usersList);
  await frame(fullState);
  await hidePage();
  expect(pageRows(view)).toEqual(rowsWith(["tasks"]));
  expect(storedRaw(PAGES_KEY)).toBe(JSON.stringify(["tasks"]));
  // The record's pack gives Tasks and webhooks: Automations joins.
  await frame(tasksHooksSelf);
  expect(pageRows(view)).toEqual(rowsWith(["tasks", "cronjobs"]));
  view.unmount();

  // The same stored set, then a record with no pack: every row.
  window.localStorage.setItem(PAGES_KEY, JSON.stringify(["tasks"]));
  view = await mount();
  expect(pageRows(view)).toEqual(rowsWith(["tasks"]));
  await frame(sessionContext);
  await frame(selfFrame({}));
  expect(pageRows(view)).toEqual(ALL_ROWS);
  view.unmount();

  // A stored empty set (a pack with none of them) is not "nothing stored".
  window.localStorage.setItem(PAGES_KEY, JSON.stringify([]));
  view = await mount();
  expect(pageRows(view)).toEqual(rowsWith([]));
});

it("stores the gated page rows when the member's own record sets them, without a page hide, and nothing before it", async () => {
  const view = await mount();
  await frame(sessionContext);
  await frame(usersList);
  // No record yet: a page hide stores no page set.
  await hidePage();
  expect(storedRaw(PAGES_KEY)).toBeNull();

  // A pack with none of the gated areas: the empty set, stored at once.
  await frame(packSelf);
  expect(pageRows(view)).toEqual(rowsWith([]));
  expect(storedPages()).toEqual([]);

  // A pack change that arrives live is stored at once too.
  await frame(tasksHooksSelf);
  expect(storedPages()).toEqual(["cronjobs", "tasks"]);
  await frame(selfFrame({}));
  expect(storedPages()).toEqual([...GATED].sort());
  await frame(tasksHooksSelf);
  expect(storedPages()).toEqual(["cronjobs", "tasks"]);
  view.unmount();

  // The next load draws that set before the record, so nothing moves when
  // the same record arrives.
  const next = await mount();
  expect(pageRows(next)).toEqual(rowsWith(["tasks", "cronjobs"]));
  await frame(sessionContext);
  await frame(tasksHooksSelf);
  expect(pageRows(next)).toEqual(rowsWith(["tasks", "cronjobs"]));
});
