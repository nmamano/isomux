// The desktop sidebar's placeholders while it loads (task 4dcad6bf; Nil,
// 2026-11-15: "Keep the sidebar's layout while it loads: draw the sections
// dimmed, or placeholders of the same shape, not an empty space that then
// fills"). The list has two blocks: the page rows with the Office row and
// the divider (ready with the member's own record), and the lists below
// them (ready at full_state). Until a block is ready, placeholders hold its
// place in the shape it last had on this device, stored when the page hides.
// The stored shape's checks are in ui/chat-sidebar.test.ts.
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
type ChatSidebarShape = import("./chat-sidebar.ts").ChatSidebarShape;
type ChatSidebarShapeBlock = import("./chat-sidebar.ts").ChatSidebarShapeBlock;
type ChatSidebarShapeItem = import("./chat-sidebar.ts").ChatSidebarShapeItem;

setUpChatSidebarTests();

// The device key: a stored value from an earlier load must keep reading.
const SHAPE_KEY = "isomux-chat-sidebar-shape";

const ROOMS = [
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
  { id: "r2", name: "Second room", prompt: null, canCloseWhenEmpty: true },
];

type Block = "top" | "lists";

const count = (view: View, selector: string) =>
  view.container.querySelectorAll(`nav[data-chat-sidebar] ${selector}`).length;
const one = (view: View, selector: string) =>
  view.container.querySelector(`nav[data-chat-sidebar] ${selector}`);
const wrapper = (view: View, block: Block) =>
  one(view, `[data-sidebar-block="${block}"]`) as HTMLElement | null;
const skeleton = (view: View, block: Block) =>
  one(
    view,
    `[data-sidebar-block="${block}"] [data-sidebar-skeleton="${block}"]`,
  ) as HTMLElement | null;
const skeletonItems = (view: View, block: Block) => [
  ...(skeleton(view, block)?.querySelectorAll<HTMLElement>(
    "[data-sidebar-skeleton-item]",
  ) ?? []),
];
const skeletonKinds = (view: View, block: Block) =>
  skeletonItems(view, block).map((el) =>
    el.getAttribute("data-sidebar-skeleton-item"),
  );
const kinds = (b: ChatSidebarShapeBlock) => b.items.map((i) => i.kind);

// The placeholders as drawn: the block's height and each item's place.
const drawn = (view: View, block: Block) => ({
  H: skeleton(view, block)?.style.height,
  items: skeletonItems(view, block).map((el) => [
    el.getAttribute("data-sidebar-skeleton-item"),
    el.style.top,
    el.style.height,
  ]),
});
const expected = (b: ChatSidebarShapeBlock) => ({
  H: `${b.H}px`,
  items: b.items.map((i) => [i.kind, `${i.top}px`, `${i.h}px`]),
});

const stored = (): unknown => {
  const raw = window.localStorage.getItem(SHAPE_KEY);
  return raw === null ? null : JSON.parse(raw);
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
// A member whose pack hides some page rows (Apps, Tasks, ...).
const packSelf = selfFrame({
  pinnedAgents: [faraway.id],
  recentAgents: [ranger.id],
  pack: { areas: { agentManagement: "read" }, agentCeiling: "web" },
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

// The rows a block's shape lists, in order: each sidebar row that is not
// inside another, and the divider.
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

// Places a ready block's wrapper at `at` and its rows one under the other,
// `pitch` px apart; the block is `H` px high, or ends 8 px (the divider's
// margin) under its last row. Returns the shape that layout has.
function layOut(
  view: View,
  block: Block,
  at: number,
  pitch: number,
  H?: number,
): ChatSidebarShapeBlock {
  const el = wrapper(view, block);
  expect(el).not.toBeNull();
  const rows = shapeRows(el!);
  expect(rows.length).toBeGreaterThan(0);
  const items = rows.map((row, i) => {
    const h = shapeKind(row) === "divider" ? 1 : pitch - 1;
    place(row, at + i * pitch + 3, h);
    return { kind: shapeKind(row), top: i * pitch + 3, h };
  });
  const last = items[items.length - 1];
  const height = H ?? last.top + last.h + 8;
  place(el!, at, height);
  return { H: height, items };
}

const hidePage = () =>
  act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });

it("holds both blocks' places with the default shape on a device with nothing stored, until each is ready", async () => {
  const view = await mount();
  await frame(sessionContext);

  // Before the member's own record: placeholders in both blocks, the page
  // rows first, and no row a member could click.
  expect(skeletonKinds(view, "top")).toEqual(
    kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.top),
  );
  expect(skeletonKinds(view, "lists")).toEqual(
    kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.lists),
  );
  expect(drawn(view, "top")).toEqual(expected(CHAT_SIDEBAR_SHAPE_DEFAULT.top));
  for (const block of ["top", "lists"] as const) {
    const el = skeleton(view, block)!;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelectorAll("button, a, input, [tabindex]").length).toBe(0);
  }
  const follows = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  expect(follows(wrapper(view, "top")!, wrapper(view, "lists")!)).toBe(true);
  expect(count(view, "[data-sidebar-nav]")).toBe(0);
  expect(count(view, "[data-sidebar-section]")).toBe(0);
  expect(count(view, "[data-sidebar-room]")).toBe(0);
  expect(count(view, "[data-sidebar-members]")).toBe(0);

  // The member's own record: the page rows take the top block's place; the
  // lists still wait for full_state.
  // Pinned draws only with rows: this member pins an agent.
  await frame(selfFrame({ pinnedAgents: [faraway.id] }));
  await frame(usersList);
  expect(skeleton(view, "top")).toBeNull();
  expect(navRow(view, "office")).not.toBeNull();
  expect(wrapper(view, "top")!.contains(navRow(view, "office"))).toBe(true);
  expect(skeletonKinds(view, "lists")).toEqual(
    kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.lists),
  );
  expect(count(view, "[data-sidebar-members]")).toBe(0);

  // full_state: no placeholder left, the lists in their block.
  await frame(fullState);
  expect(count(view, "[data-sidebar-skeleton]")).toBe(0);
  expect(count(view, "[data-sidebar-skeleton-item]")).toBe(0);
  const lists = wrapper(view, "lists")!;
  expect(
    lists.querySelector('button[data-sidebar-section="pinned"]'),
  ).not.toBeNull();
  expect(lists.querySelector('[data-sidebar-room="r1"]')).not.toBeNull();
  expect(lists.querySelector("[data-sidebar-members]")).not.toBeNull();
});

it("draws the stored shape: each placeholder at its stored place, each block at its stored height", async () => {
  const shape: ChatSidebarShape = {
    top: {
      H: 111,
      items: [
        { kind: "nav", top: 0, h: 29 },
        { kind: "nav", top: 31, h: 29 },
        { kind: "nav", top: 62, h: 29 },
        { kind: "divider", top: 101, h: 1 },
      ],
    },
    lists: {
      H: 205,
      items: [
        { kind: "header", top: 0, h: 26 },
        { kind: "row", top: 27, h: 38 },
        { kind: "header", top: 80, h: 26 },
        { kind: "nav", top: 107, h: 29 },
      ],
    },
  };
  window.localStorage.setItem(SHAPE_KEY, JSON.stringify(shape));
  const view = await mount();
  await frame(sessionContext);
  expect(drawn(view, "top")).toEqual(expected(shape.top));
  expect(drawn(view, "lists")).toEqual(expected(shape.lists));
  expect(count(view, "[data-sidebar-nav]")).toBe(0);
});

it("reads a broken or oversized stored shape as the default, without an error", async () => {
  const tooMany = {
    top: CHAT_SIDEBAR_SHAPE_DEFAULT.top,
    lists: {
      H: 100,
      items: Array.from({ length: CHAT_SIDEBAR_SHAPE_MAX_ITEMS + 1 }, () => ({
        kind: "row",
        top: 0,
        h: 1,
      })),
    },
  };
  for (const raw of ["{not json", "[]", JSON.stringify(tooMany)]) {
    window.localStorage.setItem(SHAPE_KEY, raw);
    const view = await mount();
    await frame(sessionContext);
    expect(skeletonKinds(view, "top"), raw.slice(0, 20)).toEqual(
      kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.top),
    );
    expect(skeletonKinds(view, "lists"), raw.slice(0, 20)).toEqual(
      kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.lists),
    );
    view.unmount();
  }
});

it("stores the drawn shape when the page hides, and a pack holder's next load holds the place of the rows it had", async () => {
  const view = await mount();
  await frame(sessionContext);
  await frame(packSelf);
  await frame(usersList);
  await frame(fullState);
  expect(count(view, "[data-sidebar-skeleton]")).toBe(0);

  const top = layOut(view, "top", 50, 30);
  const lists = layOut(view, "lists", 50 + top.H + 1, 40, 640);
  // A pack holder has fewer page rows than a device with nothing stored.
  const navs = top.items.filter((i) => i.kind === "nav").length;
  expect(navs).toBe(
    count(view, '[data-sidebar-block="top"] [data-sidebar-nav]'),
  );
  expect(navs).toBeLessThan(
    kinds(CHAT_SIDEBAR_SHAPE_DEFAULT.top).filter((k) => k === "nav").length,
  );
  expect(kinds(top).at(-1)).toBe("divider");

  expect(stored()).toBeNull();
  await hidePage();
  expect(stored()).toEqual({ top, lists });

  // A closed sidebar stores nothing more.
  view.unmount();
  await hidePage();
  expect(stored()).toEqual({ top, lists });

  // The next load: before the member's own record, the placeholders have
  // the shape the rows had, so nothing moves when they arrive.
  const next = await mount();
  await frame(sessionContext);
  expect(drawn(next, "top")).toEqual(expected(top));
  expect(drawn(next, "lists")).toEqual(expected(lists));
  expect(count(next, "[data-sidebar-nav]")).toBe(0);
});

it("when the tab hides, stores only the blocks that are ready; a block still loading keeps its stored shape", async () => {
  const earlier: ChatSidebarShape = {
    top: { H: 40, items: [{ kind: "nav", top: 0, h: 29 }] },
    lists: {
      H: 90,
      items: [
        { kind: "header", top: 0, h: 26 },
        { kind: "row", top: 27, h: 38 },
      ],
    },
  };
  window.localStorage.setItem(SHAPE_KEY, JSON.stringify(earlier));
  const view = await mount();
  await frame(sessionContext);
  await frame(selfFrame({}));
  // The top block is ready, the lists wait for full_state.
  expect(skeleton(view, "top")).toBeNull();
  expect(skeleton(view, "lists")).not.toBeNull();
  // A sidebar that takes no space (hidden) stores nothing.
  await hidePage();
  expect(stored()).toEqual(earlier);
  const top = layOut(view, "top", 60, 32);
  // The lists' placeholders take their place too: they are not measured.
  place(wrapper(view, "lists")!, 60 + top.H + 1, earlier.lists.H);

  const visibility = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  let state: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  try {
    // Shown again: nothing to store.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stored()).toEqual(earlier);
    state = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(stored()).toEqual({ top, lists: earlier.lists });
  } finally {
    if (visibility)
      Object.defineProperty(document, "visibilityState", visibility);
    else delete (document as { visibilityState?: unknown }).visibilityState;
  }
});
