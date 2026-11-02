// The Asks page (ui/components/AsksView.tsx) over a real reducer: groups by
// agent with the longest wait first, a group goes with its last card, Tab
// crosses groups, and a card's panel buttons open its agent's chat. An answer
// waits ASK_UNDO_MS for an Undo on a line that scrolls into view, and is sent
// at once when the page goes away.
// A card shows its priority. The filter row, which sorts and filters the
// groups, is in AsksView.filters.dom.test.tsx, and the sort's direction in
// AsksView.sort-dir.dom.test.tsx.
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
const { createElement } = await import("react");
const { AsksView, ASK_UNDO_MS } = await import("./AsksView.tsx");
const { AsksStack } = await import("../log-view/AsksStack.tsx");
const { StateCtx, DispatchCtx, initialState } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { getAsksSeen, setAsksFilter } = await import("../device-settings.ts");
const {
  ask,
  ranked,
  mount,
  mountSorted,
  groupIds,
  cardIds,
  pageOrder,
  SORT_ROOMS,
  SORT_AGENTS,
  SORT_ASKS,
  BY_AGENT,
} = await import("../test-support/asks-view.ts");
type AppState = typeof initialState;

const NOW = Date.now();

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

// The Inbox is where a member reads asks, so its card shows more of the prompt
// before Show more than the chat's stack, where space is tight (task
// 5af30517). happy-dom does not lay out, so this reads the clamp each draws.
it("clamps an ask's prompt at more lines in the Inbox than in the chat's stack", () => {
  // happy-dom drops -webkit-line-clamp, which React sets as
  // style.WebkitLineClamp. Keep what React writes there for this test only.
  const proto = CSSStyleDeclaration.prototype;
  const written = new WeakMap<object, string>();
  Object.defineProperty(proto, "WebkitLineClamp", {
    configurable: true,
    get() {
      return written.get(this) ?? "";
    },
    set(value) {
      written.set(this, String(value));
    },
  });
  try {
    clampCase();
  } finally {
    delete (proto as { WebkitLineClamp?: unknown }).WebkitLineClamp;
  }
});

function clampCase() {
  const long = { ...ask("a1long", "a1", 5), prompt: "Line\n".repeat(40) };
  const state: AppState = {
    ...initialState,
    asks: [long],
    rooms: [{ id: "r1", name: "Room One" }] as AppState["rooms"],
    agents: [{ id: "a1", name: "Scout", roomId: "r1" }] as AppState["agents"],
  };
  const clampIn = (element: ReturnType<typeof createElement>) => {
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: state },
        createElement(DispatchCtx.Provider, { value: () => {} }, element),
      ),
    );
    const prompt = view.container.querySelector<HTMLElement>(
      '[data-ask="a1long"] [data-ask-prompt]',
    )!;
    const lines = Number(
      (prompt.style as { WebkitLineClamp?: string }).WebkitLineClamp,
    );
    view.unmount();
    return lines;
  };
  const stack = clampIn(
    createElement(AsksStack, { agentId: "a1", isMobile: false }),
  );
  const inbox = clampIn(createElement(AsksView, { onFocusAgent: () => {} }));
  // Both cards clamp: a missing clamp reads 0, not a larger number.
  expect(stack).toBeGreaterThan(0);
  expect(inbox).toBeGreaterThan(stack);
}

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
