// The desktop sidebar while it loads (task 4dcad6bf; Nil, 2026-11-15: "Keep
// the sidebar's layout while it loads: draw the sections dimmed, or
// placeholders of the same shape, not an empty space that then fills"). The
// list has two blocks: the page rows with the Office row and the divider, and
// the lists below them (ready at full_state). The page rows draw from the
// first paint (task f66e07e3; Nil, 2026-11-15: "The deterministic buttons at
// the top can appear from the very beginning. Only the dynamic region should
// look like that while loading."). The rows a permission pack hides draw, until
// the member's own record arrives, as this device last drew them. Until the
// lists are ready, placeholders hold their place in the shape they last had
// on this device, stored when the page hides. The parse checks are in
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
const { CHAT_SIDEBAR_SHAPE_DEFAULT, CHAT_SIDEBAR_SHAPE_MAX_ITEMS } =
  await import("./chat-sidebar.ts");
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
type ChatSidebarShapeItem = import("./chat-sidebar.ts").ChatSidebarShapeItem;

setUpChatSidebarTests();

// The device keys: a stored value from an earlier load must keep reading.
const SHAPE_KEY = "isomux-chat-sidebar-shape";
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

// The lists' placeholders as drawn: the block's height (held as a height or
// a min-height) and each item's place.
const drawn = (view: View) => ({
  H: skeleton(view)?.style.minHeight || skeleton(view)?.style.height,
  items: skeletonItems(view).map((el) => [
    el.getAttribute("data-sidebar-skeleton-item"),
    el.style.top,
    el.style.height,
  ]),
});
const expected = (b: ChatSidebarShapeBlock) => ({
  H: `${b.H}px`,
  items: b.items.map((i) => [i.kind, `${i.top}px`, `${i.h}px`]),
});

const storedRaw = (key: string) => window.localStorage.getItem(key);
const storedLists = (): unknown => {
  const raw = storedRaw(SHAPE_KEY);
  return raw === null ? null : (JSON.parse(raw) as { lists?: unknown }).lists;
};
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

// happy-dom lays nothing out: every rect is 0. Give an element a place.
function place(el: Element, top: number, height: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 240,
      width: 240,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

// The rows the lists' shape holds, in order: each sidebar row that is not
// inside another.
const shapeRows = (block: Element) =>
  [
    ...block.querySelectorAll(".chat-sidebar-row, [data-sidebar-divider]"),
  ].filter((el) => !el.parentElement?.closest(".chat-sidebar-row"));
const shapeKind = (el: Element): ChatSidebarShapeItem["kind"] =>
  el.hasAttribute("data-sidebar-divider")
    ? "divider"
    : el.hasAttribute("data-sidebar-nav")
      ? "nav"
      : el.hasAttribute("aria-expanded")
        ? "header"
        : "row";

// Places the ready lists' wrapper at `at` and its rows one under the other,
// `pitch` px apart. The block fills the sidebar (task 73b5c130), so it runs
// `fill` px past its last row. Returns the shape that layout has: its H is
// the last row's bottom, not the block's filled height.
function layOutLists(
  view: View,
  at: number,
  pitch: number,
  fill: number,
): ChatSidebarShapeBlock {
  const el = wrapper(view, "lists");
  expect(el).not.toBeNull();
  const rows = shapeRows(el!);
  expect(rows.length).toBeGreaterThan(0);
  const items = rows.map((row, i) => {
    place(row, at + i * pitch + 3, pitch - 1);
    return { kind: shapeKind(row), top: i * pitch + 3, h: pitch - 1 };
  });
  const last = items[items.length - 1];
  const H = last.top + last.h;
  place(el!, at, H + fill);
  return { H, items };
}

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

it("on a first visit, draws the default rows and then room groups down past any screen, clipped; a stored shape draws only its own rows", async () => {
  // Nothing stored (task 73b5c130): the default rows first, then a room
  // header with two rows, again and again, so the placeholders reach the
  // bottom of the sidebar and the loaded rows replace them in place.
  const view = await mount();
  const got = skeletonKinds(view);
  const first = kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.lists);
  expect(got.slice(0, first.length)).toEqual(first);
  const rest = got.slice(first.length);
  expect(rest.length).toBeGreaterThan(0);
  expect(rest.length % 3).toBe(0);
  for (let i = 0; i < rest.length; i += 3)
    expect(rest.slice(i, i + 3), `group at ${i}`).toEqual([
      "header",
      "row",
      "row",
    ]);
  // Down past a tall screen (a 1440p monitor turned upright: 2560 px), one
  // under the other.
  const items = skeletonItems(view);
  const tops = items.map((el) => parseFloat(el.style.top));
  for (let i = 1; i < tops.length; i++)
    expect(tops[i], `item ${i}`).toBeGreaterThan(tops[i - 1]);
  const last = items[items.length - 1];
  expect(
    parseFloat(last.style.top) + parseFloat(last.style.height),
  ).toBeGreaterThanOrEqual(2560);
  // Clipped to the space the sidebar has: the placeholders never make the
  // sidebar scroll.
  expect(skeleton(view)!.style.overflow).toBe("hidden");
  view.unmount();

  // A stored shape: its rows and nothing more.
  const lists: ChatSidebarShapeBlock = {
    H: 65,
    items: [
      { kind: "header", top: 0, h: 26 },
      { kind: "row", top: 27, h: 38 },
    ],
  };
  window.localStorage.setItem(SHAPE_KEY, JSON.stringify({ lists }));
  const next = await mount();
  expect(drawn(next)).toEqual(expected(lists));
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

it("reads a value stored before this change (with a top block) for its lists, and draws the page rows for real", async () => {
  const lists: ChatSidebarShapeBlock = {
    H: 90,
    items: [
      { kind: "header", top: 0, h: 26 },
      { kind: "row", top: 27, h: 38 },
    ],
  };
  const old = {
    top: {
      H: 40,
      items: [
        { kind: "nav", top: 0, h: 29 },
        { kind: "divider", top: 37, h: 1 },
      ],
    },
    lists,
  };
  window.localStorage.setItem(SHAPE_KEY, JSON.stringify(old));
  const view = await mount();
  expect(drawn(view)).toEqual(expected(lists));
  expect(pageRows(view)).toEqual(ALL_ROWS);
  expect(
    count(view, '[data-sidebar-block="top"] [data-sidebar-skeleton]'),
  ).toBe(0);
});

it("reads a broken or oversized stored shape as the default, without an error", async () => {
  const tooMany = {
    lists: {
      H: 100,
      items: Array.from({ length: CHAT_SIDEBAR_SHAPE_MAX_ITEMS + 1 }, () => ({
        kind: "row",
        top: 0,
        h: 1,
      })),
    },
  };
  for (const raw of ["{not json", JSON.stringify(tooMany)]) {
    window.localStorage.setItem(SHAPE_KEY, raw);
    const view = await mount();
    await frame(sessionContext);
    expect(defaultKinds(view), raw.slice(0, 20)).toEqual(
      kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.lists),
    );
    expect(pageRows(view), raw.slice(0, 20)).toEqual(ALL_ROWS);
    view.unmount();
  }
});

it("stores the drawn lists shape when the page hides, and the next load holds the place of the rows it had", async () => {
  const view = await mount();
  await frame(sessionContext);
  await frame(packSelf);
  await frame(usersList);
  await frame(fullState);
  expect(count(view, "[data-sidebar-skeleton]")).toBe(0);

  const lists = layOutLists(view, 200, 40, 180);
  expect(storedLists()).toBeNull();
  await hidePage();
  expect(storedLists()).toEqual(lists);

  // A closed sidebar stores nothing more.
  view.unmount();
  await hidePage();
  expect(storedLists()).toEqual(lists);

  // The next load: before full_state, the placeholders have the shape the
  // rows had, so nothing moves when they arrive.
  const next = await mount();
  await frame(sessionContext);
  expect(drawn(next)).toEqual(expected(lists));
  expect(count(next, "[data-sidebar-section]")).toBe(0);
});

it("when the tab hides, stores the lists only once they are ready and take space", async () => {
  const earlier: ChatSidebarShapeBlock = {
    H: 90,
    items: [
      { kind: "header", top: 0, h: 26 },
      { kind: "row", top: 27, h: 38 },
    ],
  };
  const raw = JSON.stringify({ lists: earlier });
  window.localStorage.setItem(SHAPE_KEY, raw);
  const view = await mount();
  await frame(sessionContext);
  await frame(selfFrame({}));
  // The lists wait for full_state: their placeholders are not measured.
  expect(skeleton(view)).not.toBeNull();
  place(wrapper(view, "lists")!, 300, earlier.H);

  const visibility = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  let state: DocumentVisibilityState = "hidden";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  const visibilityChange = () =>
    act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  try {
    await visibilityChange();
    expect(storedLists()).toEqual(earlier);

    await frame(fullState);
    expect(skeleton(view)).toBeNull();
    // A sidebar that takes no space (hidden) stores nothing.
    place(wrapper(view, "lists")!, 0, 0);
    await visibilityChange();
    expect(storedLists()).toEqual(earlier);

    const lists = layOutLists(view, 300, 36, 120);
    // Shown again: nothing to store.
    state = "visible";
    await visibilityChange();
    expect(storedLists()).toEqual(earlier);
    state = "hidden";
    await visibilityChange();
    expect(storedLists()).toEqual(lists);
  } finally {
    if (visibility)
      Object.defineProperty(document, "visibilityState", visibility);
    else delete (document as { visibilityState?: unknown }).visibilityState;
  }
});
