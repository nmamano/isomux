// The Asks page (ui/components/AsksView.tsx) over a real reducer: groups by
// agent with the longest wait first, a group goes with its last card, Tab
// crosses groups, and a card's panel buttons open its agent's chat. An answer
// waits ASK_UNDO_MS for an Undo on a line that scrolls into view, and is sent
// at once when the page goes away.
// The filter row sorts and filters the groups, and a card shows its priority.
// The agent's name opening its chat and an ask from an agent the client does
// not have are in ui/App.inbox.dom.test.tsx; the card itself, which the chat's
// stack sends at once, is in AsksStack.dom.test.tsx.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { useReducer, useState, createElement } = await import("react");
const { AsksView, ASK_UNDO_MS } = await import("./AsksView.tsx");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { getAsksSeen, setAsksFilter } = await import("../device-settings.ts");
const {
  checkedFilterValues,
  filterButton,
  filterCounts,
  filterOptions,
  openCheckboxFilter,
  setCheckboxFilter,
} = await import("../test-support/checkbox-filters.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;
type TaskPriority = import("../../shared/types.ts").TaskPriority;
type AppState = typeof initialState;

const NOW = Date.now();
const ask = (id: string, agentId: string, ageMin: number): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: NOW - ageMin * 60_000,
  updatedAt: NOW - ageMin * 60_000,
});

let posts: string[] = [];
let bodies: unknown[] = [];
let answer: () => Promise<unknown> = async () => undefined;
beforeEach(() => {
  posts = [];
  bodies = [];
  answer = async () => undefined;
  setApiShim(async (method, path, body) => {
    if (method !== "POST") return undefined;
    posts.push(path);
    bodies.push(body);
    return answer();
  });
});
afterEach(() => jest.useRealTimers());
afterAll(() => setApiShim(null));

// Moves the fake clock, then lets the shim's promise and its dispatch land.
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

function mount(
  asks: AskEntry[],
  place: Partial<Pick<AppState, "rooms" | "agents">> = {},
) {
  const seeded: AppState = {
    ...initialState,
    asks,
    rooms: [
      { id: "r1", name: "Room One" },
      { id: "r2", name: "Room Two" },
    ] as AppState["rooms"],
    agents: [
      { id: "a1", name: "Scout", roomId: "r1" },
      { id: "a2", name: "Ranger", roomId: "r2" },
    ] as AppState["agents"],
    ...place,
  };
  const focused: string[] = [];
  const latest: {
    state: AppState;
    dispatch: (action: Parameters<typeof reducer>[1]) => void;
    // Replaces the rooms and agents slices, as a full_state would.
    setPlace: (place: Pick<AppState, "rooms" | "agents">) => void;
  } = { state: seeded, dispatch: () => {}, setPlace: () => {} };
  function Harness() {
    const [reduced, dispatch] = useReducer(reducer, seeded);
    const [place, setPlace] = useState<Partial<AppState>>({});
    const state = { ...reduced, ...place };
    latest.state = state;
    latest.dispatch = dispatch;
    latest.setPlace = setPlace;
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(AsksView, {
          onFocusAgent: (id: string) => focused.push(id),
        }),
      ),
    );
  }
  const view = render(createElement(Harness));
  return { view, focused, latest };
}

// The page in order: each group's agent and the cards under it up to the next
// group, whether the group wraps its cards or only heads them.
const runsOf = (view: ReturnType<typeof render>) => {
  const runs: { agent: string; cards: string[] }[] = [];
  for (const el of view.container.querySelectorAll<HTMLElement>(
    "[data-asks-group], [data-ask]",
  )) {
    if (el.dataset.asksGroup !== undefined)
      runs.push({ agent: el.dataset.asksGroup, cards: [] });
    else runs[runs.length - 1].cards.push(el.dataset.ask!);
  }
  return runs;
};
const groupIds = (view: ReturnType<typeof render>) =>
  runsOf(view).map((r) => r.agent);
const cardIds = (view: ReturnType<typeof render>, agentId: string) =>
  runsOf(view)
    .filter((r) => r.agent === agentId)
    .flatMap((r) => r.cards);

it("groups by agent, longest wait first, cards oldest first, with the room", () => {
  const { view } = mount([
    ask("a1new", "a1", 5),
    ask("a2old", "a2", 90),
    ask("a1old", "a1", 30),
  ]);
  expect(groupIds(view)).toEqual(["a2", "a1"]);
  expect(cardIds(view, "a1")).toEqual(["a1old", "a1new"]);
  const header = view.container.querySelector('[data-asks-group="a2"]')!;
  expect(header.textContent).toContain("Ranger");
  expect(header.textContent).toContain("Room Two");
  // The name that opens the agent's chat is a real button, so the keyboard
  // reaches it.
  expect(header.querySelector('[data-asks-agent="a2"]')?.tagName).toBe(
    "BUTTON",
  );
});

// The card is AskCard, whose app name AsksStack.dom.test.tsx pins; this pins
// that the Inbox shows it too (task 1f453011).
it("names the app that opened an ask on that ask's card in the agent's group", () => {
  const { view } = mount([
    { ...ask("a1app", "a1", 5), app: { name: "triage-bot", createdAt: NOW } },
    ask("a1own", "a1", 3),
  ]);
  expect(cardIds(view, "a1")).toEqual(["a1app", "a1own"]);
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
  expect(card("a1app").textContent).toContain("triage-bot");
  expect(card("a1own").textContent).not.toContain("triage-bot");
});

it("drops a group with its last card, then shows the empty state", async () => {
  const { view } = mount([ask("onlyA", "a1", 5), ask("onlyB", "a2", 10)]);
  expect(view.container.querySelector("[data-asks-empty]")).toBeNull();
  const reply = (id: string) =>
    view.container
      .querySelector(`[data-ask="${id}"]`)!
      .querySelector<HTMLButtonElement>('button[type="submit"]')!;
  jest.useFakeTimers();
  await act(async () => fireEvent.click(reply("onlyA")));
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual(["/api/asks/onlyA/reply"]);
  expect(groupIds(view)).toEqual(["a2"]);
  // The form's other button is Dismiss; Show more sits outside the form.
  const dismiss = view.container
    .querySelector('[data-ask="onlyB"]')!
    .querySelector<HTMLButtonElement>('form button[type="button"]')!;
  await act(async () => fireEvent.click(dismiss));
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual(["/api/asks/onlyA/reply", "/api/asks/onlyB/dismiss"]);
  expect(groupIds(view)).toEqual([]);
  expect(view.container.querySelector("[data-asks-empty]")).not.toBeNull();
  // No ask is open, so no filter hides one.
  expect(view.container.querySelector("[data-asks-filtered-empty]")).toBeNull();
});

it("moves with Tab from one agent's reply field to the next agent's, in page order", () => {
  const { view } = mount([ask("later", "a1", 30), ask("first", "a2", 90)]);
  const field = (id: string) =>
    view.container.querySelector<HTMLTextAreaElement>(
      `[data-ask="${id}"] form [data-ask-reply-input]`,
    )!;
  // A scalar: a failed toBe on two DOM nodes serialises both.
  const focused = () => {
    const el = document.activeElement;
    return `${el?.closest<HTMLElement>("[data-ask]")?.dataset.ask}/${el?.hasAttribute("data-ask-reply-input") ? "field" : el?.tagName}`;
  };
  // a2 waited longest, so its group is drawn first.
  act(() => field("first").focus());
  let free = true;
  act(() => {
    free = fireEvent.keyDown(field("first"), { key: "Tab" });
  });
  expect(free).toBe(false);
  expect(focused()).toBe("later/field");
  act(() => {
    free = fireEvent.keyDown(field("later"), { key: "Tab", shiftKey: true });
  });
  expect(free).toBe(false);
  expect(focused()).toBe("first/field");
});

it("hands an editor or command card to the ask's agent and opens that agent's chat", async () => {
  const { view, focused, latest } = mount([
    {
      ...ask("acts", "a2", 5),
      commands: ["bun test"],
      editFiles: [{ cwd: "/w", path: "/w/notes.md" }],
    },
  ]);
  const card = view.container.querySelector('[data-ask="acts"]')!;
  await act(async () =>
    fireEvent.click(
      card.querySelector("[data-ask-edit-file] button[data-panel-action]")!,
    ),
  );
  expect(focused).toEqual(["a2"]);
  expect(latest.state.pendingEditorPaths.get("a2")).toBe("/w/notes.md");
  expect(latest.state.sidePanels.get("a2")).toBe("editor");
  await act(async () =>
    fireEvent.click(
      card.querySelector("[data-ask-command] button[data-panel-action]")!,
    ),
  );
  expect(focused).toEqual(["a2", "a2"]);
  expect(latest.state.pendingTerminalCommands.get("a2")).toBe("bun test");
  expect(latest.state.sidePanels.get("a2")).toBe("terminal");
  // Nothing was answered, and the card stays.
  expect(posts).toEqual([]);
  expect(cardIds(view, "a2")).toEqual(["acts"]);
});

const cardEl = (view: ReturnType<typeof render>, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
const fieldOf = (view: ReturnType<typeof render>, id: string) =>
  cardEl(view, id)!.querySelector<HTMLTextAreaElement>(
    "[data-ask-reply-input]",
  )!;
// The pending line's kind (marked on the card's box or inside it), or null
// while the card is drawn.
const pendingOf = (view: ReturnType<typeof render>, id: string) => {
  const card = cardEl(view, id);
  const marked = card?.matches("[data-ask-pending]")
    ? card
    : card?.querySelector<HTMLElement>("[data-ask-pending]");
  return marked?.dataset.askPending ?? null;
};
const undoOf = (view: ReturnType<typeof render>, id: string) =>
  cardEl(view, id)!.querySelector<HTMLButtonElement>("[data-ask-undo]")!;
// The filter row and the sorts (task 995fc76a). Room order is the rooms
// slice's, which here differs from both id order and name order. Each group
// reads as "agent:card,card" in page order.
const SORT_ROOMS = [
  { id: "r2", name: "Room Two" },
  { id: "r1", name: "Room One" },
] as AppState["rooms"];
const SORT_AGENTS = [
  { id: "a1", name: "Scout", roomId: "r1" },
  { id: "a2", name: "Ranger", roomId: "r2" },
  { id: "a3", name: "Pathfinder", roomId: "r1" },
  { id: "a4", name: "Tracker", roomId: "r2" },
] as AppState["agents"];
const ranked = (
  id: string,
  agentId: string,
  ageMin: number,
  priority?: TaskPriority,
): AskEntry => ({
  ...ask(id, agentId, ageMin),
  ...(priority ? { priority } : {}),
});
const SORT_ASKS = [
  ranked("a1old", "a1", 100, "P2"),
  ranked("a1top", "a1", 5, "P0"),
  ranked("a2only", "a2", 60),
  ranked("a3p1", "a3", 30, "P1"),
  ranked("a4p1", "a4", 10, "P1"),
  ranked("a4none", "a4", 200),
];
const BY_AGENT = ["a4:a4none,a4p1", "a1:a1old,a1top", "a2:a2only", "a3:a3p1"];
const mountSorted = () =>
  mount(SORT_ASKS, { rooms: SORT_ROOMS, agents: SORT_AGENTS });
const pageOrder = (view: ReturnType<typeof render>) =>
  runsOf(view).map((r) => `${r.agent}:${r.cards.join(",")}`);
const control = (view: ReturnType<typeof render>, attr: "data-asks-sort") =>
  view.container.querySelector<HTMLSelectElement>(`select[${attr}]`)!;
const choose = (
  view: ReturnType<typeof render>,
  attr: "data-asks-sort",
  value: string,
) =>
  act(() => void fireEvent.change(control(view, attr), { target: { value } }));
// The room and priority filters are the Tasks page's checkbox lists
// (CheckboxFilter, task 2bbc5021): several choices at once, all checked at
// open, each with a count.
const ALL_PRIORITIES = ["P0", "P1", "P2", "P3", "P4", "none"];
const setRooms = (view: ReturnType<typeof render>, rooms: string[]) =>
  setCheckboxFilter(view.container, "room", rooms);
const setPriorities = (view: ReturnType<typeof render>, levels: string[]) =>
  setCheckboxFilter(view.container, "priority", levels);
const isOpen = (view: ReturnType<typeof render>, which: string) =>
  filterButton(view.container, which).getAttribute("aria-expanded");

describe("the filter row", () => {
  beforeEach(() => localStorage.clear());

  it("opens on all rooms, all priorities and the agent sort, and offers each room and level", async () => {
    const { view } = mountSorted();
    const c = view.container;
    // Each room in the office's order, every one checked.
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r1"]);
    expect(filterOptions(c, "room")).toEqual(["r2", "r1"]);
    expect(await checkedFilterValues(c, "priority")).toEqual(ALL_PRIORITIES);
    expect(filterOptions(c, "priority")).toEqual(ALL_PRIORITIES);
    expect(control(view, "data-asks-sort").value).toBe("agent");
    expect(
      [...control(view, "data-asks-sort").options].map((o) => o.value).sort(),
    ).toEqual(["age", "agent", "priority", "room"]);
    expect(pageOrder(view)).toEqual(BY_AGENT);
  });

  it("counts each room's asks under the priority filter, and each level's under the room filter", async () => {
    const { view, latest } = mount(
      [
        ...SORT_ASKS,
        // An agent the client does not have: no group, so no count.
        ranked("ghostAsk", "ghost", 50, "P0"),
        // Being sent: gone from the page, so gone from the counts.
        ranked("leaving", "a3", 40, "P0"),
      ],
      { rooms: SORT_ROOMS, agents: SORT_AGENTS },
    );
    act(() =>
      latest.dispatch({
        type: "ask_answered",
        id: "leaving",
        phase: "sending",
      }),
    );
    // Both are in the slice, so only the page's own rule leaves them out.
    expect(latest.state.asks.map((e) => e.id)).toContain("ghostAsk");
    expect(latest.state.answeredAsks.get("leaving")).toBe("sending");
    const c = view.container;
    expect(await filterCounts(c, "room")).toEqual({ r2: 3, r1: 3 });
    expect(await filterCounts(c, "priority")).toEqual({
      P0: 1,
      P1: 2,
      P2: 1,
      P3: 0,
      P4: 0,
      none: 2,
    });
    // A level's count follows the room filter, and not its own.
    await setRooms(view, ["r2"]);
    expect(await filterCounts(c, "priority")).toEqual({
      P0: 0,
      P1: 1,
      P2: 0,
      P3: 0,
      P4: 0,
      none: 2,
    });
    expect(await filterCounts(c, "room")).toEqual({ r2: 3, r1: 3 });
    // A room's count follows the priority filter, and not its own.
    await setPriorities(view, ["P0", "P1"]);
    expect(await filterCounts(c, "room")).toEqual({ r2: 1, r1: 2 });
    expect(await filterCounts(c, "priority")).toEqual({
      P0: 0,
      P1: 1,
      P2: 0,
      P3: 0,
      P4: 0,
      none: 2,
    });
  });

  it("names the checked rooms on the button, and keeps room names out of page translation", async () => {
    const { view } = mountSorted();
    const c = view.container;
    const summary = () => filterButton(c, "room").textContent ?? "";
    // All checked, and none: a word, not the rooms.
    const all = summary();
    expect(all).not.toContain("Room One");
    expect(all).not.toContain("Room Two");
    await setRooms(view, []);
    const none = summary();
    expect(none).not.toContain("Room One");
    expect(none).not.toContain("Room Two");
    expect(none).not.toBe(all);
    await setRooms(view, ["r1"]);
    expect(summary()).toContain("Room One");
    expect(summary()).not.toContain("Room Two");
    // A room name, in the list or on the button, is not translated.
    const nameEl = (text: string, within: Element) =>
      [...within.querySelectorAll<HTMLElement>("*")].find(
        (el) => el.children.length === 0 && el.textContent === text,
      );
    const button = filterButton(c, "room");
    expect(
      nameEl("Room One", button)?.closest("[translate=no]") ?? null,
    ).not.toBeNull();
    await openCheckboxFilter(c, "room");
    const list = button.parentElement!;
    for (const name of ["Room One", "Room Two"])
      expect(
        nameEl(name, list)?.closest("[translate=no]") ?? null,
      ).not.toBeNull();
    // A priority level's label is translatable.
    await openCheckboxFilter(c, "priority");
    const none_ = filterButton(c, "priority").parentElement!.querySelector(
      'input[value="none"]',
    )!;
    expect(none_.closest("label")!.querySelector("[translate=no]")).toBeNull();
  });

  it("shows a room that appears while the tab is open as checked, and drops a room that goes", async () => {
    const { view, latest } = mountSorted();
    const c = view.container;
    const all = filterButton(c, "room").textContent;
    await setRooms(view, ["r2"]);
    expect(pageOrder(view)).toEqual(["a4:a4none,a4p1", "a2:a2only"]);
    act(() =>
      latest.setPlace({
        rooms: [
          ...SORT_ROOMS,
          { id: "r3", name: "Room Three" },
        ] as AppState["rooms"],
        agents: [
          ...SORT_AGENTS,
          { id: "a5", name: "Scribe", roomId: "r3" },
        ] as AppState["agents"],
      }),
    );
    act(() =>
      latest.dispatch({
        type: "ask_upserted",
        entry: ranked("a5new", "a5", 1, "P3"),
      }),
    );
    // The new room is checked and its ask shows; the unchecked room stays out.
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r3"]);
    expect(pageOrder(view)).toEqual([
      "a4:a4none,a4p1",
      "a2:a2only",
      "a5:a5new",
    ]);
    expect(filterButton(c, "room").textContent).not.toBe(all);
    // r1 goes while unchecked: it leaves the list, nothing listed is
    // unchecked, so the button reads as all rooms again and no ask is hidden
    // by a room the list no longer offers.
    act(() =>
      latest.setPlace({
        rooms: [
          { id: "r2", name: "Room Two" },
          { id: "r3", name: "Room Three" },
        ] as AppState["rooms"],
        agents: latest.state.agents,
      }),
    );
    expect(filterOptions(c, "room")).toEqual(["r2", "r3"]);
    expect(await checkedFilterValues(c, "room")).toEqual(["r2", "r3"]);
    expect(filterButton(c, "room").textContent).toBe(all);
    expect(groupIds(view).sort()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("closes an open list on Escape, focus back on its button, and the Inbox stays", async () => {
    const { view } = mountSorted();
    const c = view.container;
    const reached: string[] = [];
    // App closes the page on a window bubble keydown (App.tsx handleKey).
    const appEscape = (e: KeyboardEvent) => reached.push(e.key);
    window.addEventListener("keydown", appEscape);
    try {
      // With no list open, Escape reaches App: the probe can see it.
      await act(async () =>
        fireEvent.keyDown(document.body, { key: "Escape" }),
      );
      expect(reached).toEqual(["Escape"]);
      reached.length = 0;
      // A list open, focus on one of its boxes.
      await openCheckboxFilter(c, "room");
      expect(isOpen(view, "room")).toBe("true");
      const box = c.querySelector<HTMLInputElement>(
        '[data-checkbox-filter="room"] input[value="r1"]',
      )!;
      act(() => box.focus());
      await act(async () => fireEvent.keyDown(box, { key: "Escape" }));
      expect(isOpen(view, "room")).toBe("false");
      expect(reached).toEqual([]);
      // A scalar: a failed toBe on two DOM nodes serialises both.
      const active = () => {
        const el = document.activeElement as HTMLElement | null;
        return `${el?.closest<HTMLElement>("[data-checkbox-filter]")?.dataset.checkboxFilter}/${el?.tagName}`;
      };
      expect(active()).toBe("room/BUTTON");
      // Focus on the page, as after a click in Safari: the list still closes
      // first, and focus goes to its button.
      await openCheckboxFilter(c, "priority");
      expect(isOpen(view, "priority")).toBe("true");
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(active()).toBe("undefined/BODY");
      await act(async () =>
        fireEvent.keyDown(document.body, { key: "Escape" }),
      );
      expect(isOpen(view, "priority")).toBe("false");
      expect(reached).toEqual([]);
      expect(active()).toBe("priority/BUTTON");
      // Other keys with a list open still reach the page.
      await openCheckboxFilter(c, "priority");
      await act(async () => fireEvent.keyDown(document.body, { key: "a" }));
      expect(reached).toEqual(["a"]);
      // One list at a time.
      await openCheckboxFilter(c, "room");
      expect(isOpen(view, "room")).toBe("true");
      expect(isOpen(view, "priority")).toBe("false");
    } finally {
      window.removeEventListener("keydown", appEscape);
    }
  });

  it("sorts by room in the office's room order, then by the oldest ask; cards stay oldest first", () => {
    const { view } = mountSorted();
    choose(view, "data-asks-sort", "room");
    expect(pageOrder(view)).toEqual([
      "a4:a4none,a4p1",
      "a2:a2only",
      "a1:a1old,a1top",
      "a3:a3p1",
    ]);
  });

  it("sorts by priority: cards by level then age, no priority last, and groups by their first card", () => {
    const { view } = mountSorted();
    choose(view, "data-asks-sort", "priority");
    // a3 and a4 both lead with a P1: a3's has waited longer, though a4's
    // group holds the oldest ask on the page.
    expect(pageOrder(view)).toEqual([
      "a1:a1top,a1old",
      "a3:a3p1",
      "a4:a4p1,a4none",
      "a2:a2only",
    ]);
  });

  // Sort by age (task 66532fa7): one list, longest wait first, with a header
  // at each change of agent, so an agent can head more than one run.
  const BY_AGE = [
    "a4:a4none",
    "a1:a1old",
    "a2:a2only",
    "a3:a3p1",
    "a4:a4p1",
    "a1:a1top",
  ];

  it("sorts by age: one list, longest wait first, a header with the agent and room at each change of agent", async () => {
    const { view } = mountSorted();
    choose(view, "data-asks-sort", "age");
    expect(pageOrder(view)).toEqual(BY_AGE);
    // The second a1 run has its own header: the name that opens the chat
    // and the room.
    const runs = view.container.querySelectorAll<HTMLElement>(
      '[data-asks-group="a1"]',
    );
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.querySelector("[data-asks-agent]")?.tagName).toBe("BUTTON");
      expect(run.textContent).toContain("Scout");
      expect(run.textContent).toContain("Room One");
    }
    // A filter change redraws the runs, and no header is left behind.
    await setRooms(view, ["r2"]);
    await setRooms(view, ["r2", "r1"]);
    expect(pageOrder(view)).toEqual(BY_AGE);
  });

  it("sorts by age after the filters, so a hidden ask joins the runs on each side of it", async () => {
    const { view } = mount(
      [
        ranked("aOld", "a1", 90, "P1"),
        ranked("bMid", "a2", 60, "P2"),
        ranked("aNew", "a1", 30, "P1"),
      ],
      { rooms: SORT_ROOMS, agents: SORT_AGENTS },
    );
    choose(view, "data-asks-sort", "age");
    expect(pageOrder(view)).toEqual(["a1:aOld", "a2:bMid", "a1:aNew"]);
    await setPriorities(view, ["P1"]);
    expect(pageOrder(view)).toEqual(["a1:aOld,aNew"]);
    await setPriorities(view, ALL_PRIORITIES);
    await setRooms(view, ["r2"]);
    expect(pageOrder(view)).toEqual(["a2:bMid"]);
  });

  it("sorts asks of the same age by ask id, whatever the agent or slice order", () => {
    const { view } = mount(
      [ask("tieB", "a1", 40), ask("tieA", "a2", 40), ask("tieC", "a1", 40)],
      { rooms: SORT_ROOMS, agents: SORT_AGENTS },
    );
    choose(view, "data-asks-sort", "age");
    expect(pageOrder(view)).toEqual(["a2:tieA", "a1:tieB,tieC"]);
  });

  it("filters by the checked rooms and levels, several at once, and groups by the cards it shows", async () => {
    const { view } = mountSorted();
    await setRooms(view, ["r1"]);
    expect(pageOrder(view)).toEqual(["a1:a1old,a1top", "a3:a3p1"]);
    await setRooms(view, ["r2", "r1"]);
    await setPriorities(view, ["P1"]);
    // a4's oldest ask is hidden, so its P1 card places the group.
    expect(pageOrder(view)).toEqual(["a3:a3p1", "a4:a4p1"]);
    await setPriorities(view, ["P1", "none"]);
    expect(pageOrder(view)).toEqual(["a4:a4none,a4p1", "a2:a2only", "a3:a3p1"]);
    await setPriorities(view, ["P0", "P2"]);
    expect(pageOrder(view)).toEqual(["a1:a1old,a1top"]);
    await setPriorities(view, ["P0", "P1"]);
    await setRooms(view, ["r2"]);
    expect(pageOrder(view)).toEqual(["a4:a4p1"]);
  });

  it("says when the filters hide every ask, and Show all clears both filters", async () => {
    const { view } = mountSorted();
    await setRooms(view, ["r1"]);
    await setPriorities(view, ["P1", "none"]);
    expect(pageOrder(view)).toEqual(["a3:a3p1"]);
    await setPriorities(view, ["none"]);
    expect(pageOrder(view)).toEqual([]);
    const filtered = view.container.querySelector("[data-asks-filtered-empty]");
    expect(filtered).not.toBeNull();
    // Not the "no open asks" state: asks are open, only hidden.
    expect(view.container.querySelector("[data-asks-empty]")).toBeNull();
    await act(async () =>
      fireEvent.click(
        view.container.querySelector<HTMLButtonElement>(
          "[data-asks-show-all]",
        )!,
      ),
    );
    expect(await checkedFilterValues(view.container, "room")).toEqual([
      "r2",
      "r1",
    ]);
    expect(await checkedFilterValues(view.container, "priority")).toEqual(
      ALL_PRIORITIES,
    );
    expect(pageOrder(view)).toEqual(BY_AGENT);
    expect(
      view.container.querySelector("[data-asks-filtered-empty]"),
    ).toBeNull();
  });

  // Task a930c9d6: the filters are remembered per browser like the sort, so
  // an Inbox opened again shows what the member left; Show all is remembered
  // too.
  it("remembers the sort and both filters on this device, and Show all", async () => {
    const first = mountSorted();
    choose(first.view, "data-asks-sort", "priority");
    await setRooms(first.view, ["r2"]);
    await setPriorities(first.view, ["P1"]);
    expect(pageOrder(first.view)).toEqual(["a4:a4p1"]);
    first.view.unmount();
    const second = mountSorted();
    expect(control(second.view, "data-asks-sort").value).toBe("priority");
    expect(await checkedFilterValues(second.view.container, "room")).toEqual([
      "r2",
    ]);
    expect(
      await checkedFilterValues(second.view.container, "priority"),
    ).toEqual(["P1"]);
    expect(pageOrder(second.view)).toEqual(["a4:a4p1"]);
    // No level checked is remembered as such, not read back as all.
    await setPriorities(second.view, []);
    second.view.unmount();
    const empty = mountSorted();
    expect(pageOrder(empty.view)).toEqual([]);
    const showAll = empty.view.container.querySelector<HTMLButtonElement>(
      "[data-asks-filtered-empty] [data-asks-show-all]",
    );
    expect(showAll).not.toBeNull();
    await act(async () => fireEvent.click(showAll!));
    empty.view.unmount();
    const third = mountSorted();
    expect(await checkedFilterValues(third.view.container, "room")).toEqual([
      "r2",
      "r1",
    ]);
    expect(await checkedFilterValues(third.view.container, "priority")).toEqual(
      ALL_PRIORITIES,
    );
    expect(pageOrder(third.view)).toEqual([
      "a1:a1top,a1old",
      "a3:a3p1",
      "a4:a4p1,a4none",
      "a2:a2only",
    ]);
  });

  // A room the member unchecks stays unchecked while it is gone from the
  // office, so it comes back unchecked, and hides nothing meanwhile.
  it("keeps a remembered unchecked room that went away, and it hides that room again when it comes back", async () => {
    const first = mountSorted();
    await setRooms(first.view, ["r1"]);
    first.view.unmount();
    const gone = mount(SORT_ASKS, {
      rooms: SORT_ROOMS.filter((r) => r.id !== "r2"),
      agents: SORT_AGENTS.map((a) => ({ ...a, roomId: "r1" })),
    });
    // r2 is gone and its agents moved: every ask shows.
    expect(runsOf(gone.view).flatMap((r) => r.cards)).toHaveLength(
      SORT_ASKS.length,
    );
    gone.view.unmount();
    const back = mountSorted();
    expect(await checkedFilterValues(back.view.container, "room")).toEqual([
      "r1",
    ]);
    expect(pageOrder(back.view)).toEqual(["a1:a1old,a1top", "a3:a3p1"]);
  });

  it("remembers the age sort on this device", () => {
    const first = mountSorted();
    choose(first.view, "data-asks-sort", "age");
    first.view.unmount();
    const second = mountSorted();
    expect(control(second.view, "data-asks-sort").value).toBe("age");
    expect(pageOrder(second.view)).toEqual(BY_AGE);
  });

  it("falls back to the agent sort when the stored sort is not one it knows", () => {
    const first = mountSorted();
    choose(first.view, "data-asks-sort", "room");
    first.view.unmount();
    // The stored choice, whatever its key and form: overwrite it.
    const keys = Array.from(
      { length: localStorage.length },
      (_, i) => localStorage.key(i)!,
    ).filter((k) => (localStorage.getItem(k) ?? "").includes("room"));
    expect(keys).toHaveLength(1);
    localStorage.setItem(keys[0], "bogus");
    const second = mountSorted();
    expect(control(second.view, "data-asks-sort").value).toBe("agent");
    expect(pageOrder(second.view)).toEqual(BY_AGENT);
  });
});

// What this browser has seen (task a930c9d6): while the Asks tab shows on a
// visible page, every open ask the member can see is marked seen, whatever
// the filters, so the Inbox badge lights only for what came since. A seen ask
// stays seen while it is open, even with its agent out of the agents slice.
describe("asks seen", () => {
  beforeEach(() => localStorage.clear());
  const seen = () => [...getAsksSeen()].sort();
  const ALL_SORT_IDS = SORT_ASKS.map((a) => a.id).sort();

  it("marks every open ask it can show seen, whatever the filters, and one that arrives or whose agent arrives", async () => {
    setAsksFilter({ uncheckedRooms: ["r2"], priorities: ["P1"] });
    const { view, latest } = mount(
      [...SORT_ASKS, ranked("ghostAsk", "a9", 3, "P1")],
      { rooms: SORT_ROOMS, agents: SORT_AGENTS },
    );
    // The filters are on: only a3's P1 ask in r1 shows.
    expect(pageOrder(view)).toEqual(["a3:a3p1"]);
    // Every ask of an agent the client has, not the ghost's.
    expect(seen()).toEqual(ALL_SORT_IDS);
    // A new ask in the unchecked room: seen at once.
    act(() =>
      latest.dispatch({
        type: "ask_upserted",
        entry: ranked("a2late", "a2", 0, "P2"),
      }),
    );
    expect(pageOrder(view)).toEqual(["a3:a3p1"]);
    expect(seen()).toEqual([...ALL_SORT_IDS, "a2late"].sort());
    // The ghost's agent arrives: its ask is now one the member can see.
    act(() =>
      latest.setPlace({
        rooms: SORT_ROOMS,
        agents: [
          ...SORT_AGENTS,
          { id: "a9", name: "Ghost", roomId: "r2" },
        ] as AppState["agents"],
      }),
    );
    expect(seen()).toEqual([...ALL_SORT_IDS, "a2late", "ghostAsk"].sort());
  });

  it("keeps a seen ask seen while its agent is out of the agents slice, and drops it when it closes", async () => {
    const { latest } = mountSorted();
    expect(seen()).toEqual(ALL_SORT_IDS);
    // a4's room is hidden: a4 leaves the agents slice, its asks stay open.
    act(() =>
      latest.setPlace({
        rooms: SORT_ROOMS,
        agents: SORT_AGENTS.filter((a) => a.id !== "a4"),
      }),
    );
    act(() =>
      latest.dispatch({
        type: "ask_upserted",
        entry: ranked("a1late", "a1", 0),
      }),
    );
    expect(seen()).toEqual([...ALL_SORT_IDS, "a1late"].sort());
    // A closed ask leaves the set.
    act(() => latest.dispatch({ type: "ask_removed", id: "a2only" }));
    expect(seen()).toEqual(
      [...ALL_SORT_IDS, "a1late"].filter((id) => id !== "a2only").sort(),
    );
  });

  it("marks nothing while the page is hidden, and everything shown once it is visible again", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      const { view, latest } = mountSorted();
      // The tab shows the asks; the page is hidden.
      expect(pageOrder(view)).toEqual(BY_AGENT);
      act(() =>
        latest.dispatch({
          type: "ask_upserted",
          entry: ranked("a1late", "a1", 0),
        }),
      );
      expect(seen()).toEqual([]);
      act(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(seen()).toEqual([...ALL_SORT_IDS, "a1late"].sort());
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });
});

it("marks an ask's priority on its card, and nothing on an ask without one", () => {
  const { view } = mount([
    ranked("urgent", "a1", 5, "P0"),
    ask("plain", "a2", 9),
  ]);
  const chip = cardEl(view, "urgent")!.querySelector<HTMLElement>(
    "[data-ask-priority]",
  );
  expect(chip?.dataset.askPriority).toBe("P0");
  expect(chip?.textContent).toBe("P0");
  expect(
    cardEl(view, "plain")!.querySelector("[data-ask-priority]"),
  ).toBeNull();
});

type Kind = "reply" | "dismiss" | "file-task";
// Types the text in the card's field and clicks the answer of that kind.
async function answerAsk(
  view: ReturnType<typeof render>,
  id: string,
  kind: Kind,
  text?: string,
) {
  if (text !== undefined)
    fireEvent.change(fieldOf(view, id), { target: { value: text } });
  const card = cardEl(view, id)!;
  const button =
    kind === "reply"
      ? card.querySelector<HTMLButtonElement>('button[type="submit"]')!
      : kind === "dismiss"
        ? card.querySelector<HTMLButtonElement>('form button[type="button"]')!
        : card.querySelector<HTMLButtonElement>("[data-ask-file-task]")!;
  await act(async () => fireEvent.click(button));
}

for (const [kind, text] of [
  ["reply", "Ship it on Monday"],
  ["dismiss", "Not this week"],
  ["file-task", "Do it after the release"],
] as const) {
  it(`holds a ${kind} for ASK_UNDO_MS, then sends it once`, async () => {
    jest.useFakeTimers();
    const { view } = mount([ask("held", "a1", 5)]);
    await answerAsk(view, "held", kind, text);
    // The card turns into the pending line, which shows what was chosen.
    expect(pendingOf(view, "held")).toBe(kind);
    expect(cardEl(view, "held")!.textContent).toContain(text);
    expect(cardEl(view, "held")!.querySelector("form")).toBeNull();
    await advance(ASK_UNDO_MS - 1);
    expect(posts).toEqual([]);
    await advance(1);
    expect(posts).toEqual([`/api/asks/held/${kind}`]);
    expect(bodies).toEqual([{ text }]);
    expect(cardEl(view, "held")).toBeNull();
    await advance(ASK_UNDO_MS * 2);
    expect(posts).toEqual([`/api/asks/held/${kind}`]);
  });
}

// At the end of the Undo time the line goes straight to nothing: the card is
// never drawn again while the answer is in flight (task ab332fb2). The POST
// is held open, so a card that waits for the server's answer stays in view.
it("goes from the Undo line to nothing when the answer is sent, with the POST still in flight", async () => {
  jest.useFakeTimers();
  let settle!: () => void;
  answer = () =>
    new Promise<undefined>((resolve) => {
      settle = () => resolve(undefined);
    });
  const { view, latest } = mount([
    ask("flash", "a1", 30),
    ask("stay", "a2", 5),
  ]);
  await answerAsk(view, "flash", "reply", "go");
  expect(pendingOf(view, "flash")).toBe("reply");
  // Every node added from here on: a card drawn and gone again inside one
  // batch is caught too.
  const drawn: string[] = [];
  const note = (records: MutationRecord[]) => {
    for (const r of records)
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const inCard =
          n.closest('[data-ask="flash"]') ??
          n.querySelector('[data-ask="flash"]');
        if (inCard && (n.matches("form, form *") || n.querySelector("form")))
          drawn.push(n.tagName);
      }
  };
  const observer = new MutationObserver(note);
  observer.observe(view.container, { childList: true, subtree: true });
  await advance(ASK_UNDO_MS);
  note(observer.takeRecords());
  observer.disconnect();
  expect(posts).toEqual(["/api/asks/flash/reply"]);
  // Still in flight: the ask is in the slice, and the page shows nothing of it.
  expect(latest.state.asks.map((e) => e.id)).toContain("flash");
  expect(drawn).toEqual([]);
  expect(cardEl(view, "flash")).toBeNull();
  expect(groupIds(view)).toEqual(["a2"]);
  await act(async () => settle());
  await act(async () => {});
  expect(latest.state.asks.map((e) => e.id)).toEqual(["stay"]);
  expect(cardEl(view, "flash")).toBeNull();
  expect(posts).toHaveLength(1);
});

it("brings the card back on Undo, with the draft, its height and focus in its field, and a new answer runs on its own timer", async () => {
  jest.useFakeTimers();
  const half = Math.floor(ASK_UNDO_MS / 2);
  // A draft three lines high: the field that Undo draws again fits it, with
  // no keystroke to set the height.
  const proto = window.HTMLTextAreaElement.prototype;
  Object.defineProperty(proto, "scrollHeight", {
    get: () => 70,
    configurable: true,
  });
  const { view } = mount([ask("undone", "a1", 5)]);
  try {
    await answerAsk(view, "undone", "reply", "half a thought");
    expect(pendingOf(view, "undone")).toBe("reply");
    expect(fieldOf(view, "undone")).toBeNull();
    await advance(half);
    await act(async () => fireEvent.click(undoOf(view, "undone")));
  } finally {
    delete (proto as unknown as Record<string, unknown>).scrollHeight;
  }
  expect(pendingOf(view, "undone")).toBeNull();
  expect(fieldOf(view, "undone").value).toBe("half a thought");
  expect(fieldOf(view, "undone").style.height).toBe("70px");
  expect(fieldOf(view, "undone").disabled).toBe(false);
  // A scalar: a failed toBe on two DOM nodes serialises both.
  const el = document.activeElement as HTMLElement | null;
  expect(
    `${el?.closest<HTMLElement>("[data-ask]")?.dataset.ask}/${el?.hasAttribute("data-ask-reply-input")}`,
  ).toBe("undone/true");
  // Answered again at once: the undone answer's time passes and sends
  // nothing, so its timer cannot send the new answer early.
  await answerAsk(view, "undone", "reply");
  await advance(ASK_UNDO_MS - half);
  expect(posts).toEqual([]);
  expect(pendingOf(view, "undone")).toBe("reply");
  await advance(half);
  expect(posts).toEqual(["/api/asks/undone/reply"]);
  expect(bodies).toEqual([{ text: "half a thought" }]);
  await advance(ASK_UNDO_MS * 2);
  expect(posts).toHaveLength(1);
});

it("keeps a timer per card: two quick answers send at their own time, and an Undo touches only its card", async () => {
  jest.useFakeTimers();
  const half = Math.floor(ASK_UNDO_MS / 2);
  const { view } = mount([
    ask("first", "a1", 30),
    ask("second", "a1", 20),
    ask("third", "a2", 10),
  ]);
  await answerAsk(view, "first", "reply", "one");
  await advance(half);
  await answerAsk(view, "second", "dismiss", "two");
  await answerAsk(view, "third", "reply", "three");
  await act(async () => fireEvent.click(undoOf(view, "third")));
  await advance(ASK_UNDO_MS - half);
  expect(posts).toEqual(["/api/asks/first/reply"]);
  expect(pendingOf(view, "second")).toBe("dismiss");
  await advance(half);
  expect(posts).toEqual(["/api/asks/first/reply", "/api/asks/second/dismiss"]);
  expect(bodies).toEqual([{ text: "one" }, { text: "two" }]);
  // The undone card is back and was never sent.
  expect(pendingOf(view, "third")).toBeNull();
  expect(fieldOf(view, "third").value).toBe("three");
});

it("sends every waiting answer at once when the Inbox goes away, and only once", async () => {
  jest.useFakeTimers();
  const { view } = mount([ask("left1", "a1", 30), ask("left2", "a2", 20)]);
  await answerAsk(view, "left1", "reply", "yes");
  await answerAsk(view, "left2", "file-task", "later");
  expect(posts).toEqual([]);
  await act(async () => view.unmount());
  expect([...posts].sort()).toEqual([
    "/api/asks/left1/reply",
    "/api/asks/left2/file-task",
  ]);
  await advance(ASK_UNDO_MS * 2);
  expect(posts).toHaveLength(2);
});

// Each scrollIntoView call while it is installed: the ask and the pending line
// it was called on (null for any other element), and the options. happy-dom
// has no layout, so the call is what a test can see of the scroll.
type ScrollCall = {
  ask: string | null;
  pending: string | null;
  block: string | null;
  smooth: boolean;
};
let restoreScroll: (() => void) | null = null;
afterEach(() => {
  restoreScroll?.();
  restoreScroll = null;
});
function watchScroll(): ScrollCall[] {
  const calls: ScrollCall[] = [];
  const original = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  )!;
  // The card's optional call must reach the spy, not skip a missing method.
  expect(typeof original.value).toBe("function");
  Element.prototype.scrollIntoView = function (
    this: Element,
    arg?: boolean | ScrollIntoViewOptions,
  ) {
    const options = typeof arg === "object" ? arg : {};
    calls.push({
      ask: this.closest<HTMLElement>("[data-ask]")?.dataset.ask ?? null,
      pending: this.getAttribute("data-ask-pending"),
      block: options.block ?? null,
      smooth: options.behavior === "smooth",
    });
  };
  restoreScroll = () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", original);
  };
  return calls;
}

// A tall card turns into the one-line Undo line, so the list moves up under
// a scroller that keeps its place: the line scrolls into view, nearest edge
// and at once, so the next ask starts under it (task bfae0ab8).
for (const kind of ["reply", "dismiss", "file-task"] as const) {
  it(`scrolls the Undo line of a ${kind} into view once, and not on Undo or when the line goes`, async () => {
    jest.useFakeTimers();
    const calls = watchScroll();
    const { view, latest } = mount([
      ask("tall", "a1", 30),
      ask("next", "a1", 20),
    ]);
    expect(calls).toEqual([]);
    const line = {
      ask: "tall",
      pending: kind,
      block: "nearest",
      smooth: false,
    };
    await answerAsk(view, "tall", kind, "noted");
    expect(pendingOf(view, "tall")).toBe(kind);
    expect(calls).toEqual([line]);
    // The held card draws again on a store change, and does not scroll again.
    await act(async () =>
      latest.dispatch({ type: "set_ask_draft", askId: "next", text: "x" }),
    );
    expect(fieldOf(view, "next").value).toBe("x");
    expect(calls).toEqual([line]);
    // Undo brings the card back from where the line was: no scroll.
    await act(async () => fireEvent.click(undoOf(view, "tall")));
    expect(pendingOf(view, "tall")).toBeNull();
    expect(calls).toEqual([line]);
    // Answered again, then sent: the line goes and nothing scrolls.
    await answerAsk(view, "tall", kind);
    expect(calls).toEqual([line, line]);
    await advance(ASK_UNDO_MS);
    expect(posts).toEqual([`/api/asks/tall/${kind}`]);
    expect(cardEl(view, "tall")).toBeNull();
    expect(cardEl(view, "next")).not.toBeNull();
    expect(calls).toEqual([line, line]);
  });
}

it("shows the card again with the error and the draft when the held answer is refused", async () => {
  jest.useFakeTimers();
  answer = async () => {
    throw new ApiError(409, "ask_busy", "ask_busy");
  };
  const { view } = mount([ask("refused", "a1", 5)]);
  await answerAsk(view, "refused", "reply", "go");
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual(["/api/asks/refused/reply"]);
  expect(pendingOf(view, "refused")).toBeNull();
  expect(
    cardEl(view, "refused")!.querySelector("[role=alert]")?.textContent,
  ).toContain("ask_busy");
  expect(fieldOf(view, "refused").value).toBe("go");
  expect(fieldOf(view, "refused").disabled).toBe(false);
  await advance(ASK_UNDO_MS * 2);
  expect(posts).toHaveLength(1);
});

// Under the age sort a card is the same card while the cards around it go: a
// run that loses its first card, or two runs of one agent that join when the
// card between them goes, keep each held answer held, with its Undo
// (task 66532fa7).
it("keeps a held answer held under the age sort while other cards leave and runs join", async () => {
  localStorage.clear();
  jest.useFakeTimers();
  const half = Math.floor(ASK_UNDO_MS / 2);
  const { view } = mount([
    ask("x", "a1", 90),
    ask("y", "a1", 80),
    ask("z", "a2", 60),
    ask("w", "a1", 30),
  ]);
  act(
    () =>
      void fireEvent.change(
        view.container.querySelector<HTMLSelectElement>(
          "select[data-asks-sort]",
        )!,
        { target: { value: "age" } },
      ),
  );
  try {
    expect(groupIds(view)).toEqual(["a1", "a2", "a1"]);
    await answerAsk(view, "x", "reply", "first");
    await answerAsk(view, "z", "reply", "between");
    await advance(half);
    await answerAsk(view, "y", "reply", "head next");
    await answerAsk(view, "w", "reply", "joins");
    await advance(ASK_UNDO_MS - half);
    // x and z are sent and gone: y now heads its run, and w's run joins it.
    expect([...posts].sort()).toEqual([
      "/api/asks/x/reply",
      "/api/asks/z/reply",
    ]);
    expect(pageOrder(view)).toEqual(["a1:y,w"]);
    expect(pendingOf(view, "y")).toBe("reply");
    expect(pendingOf(view, "w")).toBe("reply");
    await act(async () => fireEvent.click(undoOf(view, "w")));
    expect(fieldOf(view, "w").value).toBe("joins");
    await advance(half);
    expect([...posts].sort()).toEqual([
      "/api/asks/x/reply",
      "/api/asks/y/reply",
      "/api/asks/z/reply",
    ]);
  } finally {
    localStorage.clear();
  }
});

// The page going away (closed, reloaded, or hidden on a phone, where the OS
// can end it with no pagehide) sends a held answer at once, from inside the
// event, with keepalive so the request outlives the page. Over keepalive's
// 64 KiB body limit, fetch would refuse at once, so a large answer goes
// without it. The demo shim ignores keepalive, so these run on fetch.
for (const [label, fire, text, keepalive] of [
  ["pagehide", "pagehide", "close it", true],
  ["visibilitychange to hidden", "hidden", "hide it", true],
  ["pagehide with a large answer", "pagehide", "x".repeat(70_000), false],
] as const) {
  it(`sends a held answer at once on ${label}, keepalive ${keepalive}`, async () => {
    jest.useFakeTimers();
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    setApiShim(null);
    try {
      const { view } = mount([ask("gone", "a1", 5)]);
      await answerAsk(view, "gone", "reply", text);
      // A page that turns visible sends nothing.
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(calls).toHaveLength(0);
      act(() => {
        if (fire === "pagehide") window.dispatchEvent(new Event("pagehide"));
        else {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      // Inside the event: no await between the event and fetch.
      expect(calls.map((c) => c.url)).toEqual(["/api/asks/gone/reply"]);
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.keepalive ?? false).toBe(keepalive);
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ text });
      await advance(ASK_UNDO_MS * 2);
      expect(calls).toHaveLength(1);
      view.unmount();
      expect(calls).toHaveLength(1);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      globalThis.fetch = realFetch;
    }
  });
}
