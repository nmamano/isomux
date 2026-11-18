// The Asks page (ui/components/AsksView.tsx) over a real reducer: groups by
// agent with the longest wait first, a group goes with its last card, Tab
// crosses groups, and a card's panel buttons open its agent's chat. An answer
// waits ASK_UNDO_MS for an Undo on a line that scrolls into view, and is sent
// at once when the page goes away: that is in AsksView.held.dom.test.tsx and
// AsksView.held-send.dom.test.tsx.
// A card shows its priority. The filter row, which sorts and filters the
// groups, is in the AsksView.filter*.dom.test.tsx files, and the sort's
// direction in AsksView.sort-dir.dom.test.tsx.
// The agent's name opening its chat and an ask from an agent the client does
// not have are in ui/App.inbox.dom.test.tsx; the card itself, which the chat's
// stack sends at once, is in AsksStack.reply.dom.test.tsx.
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
const { setAsksFilter } = await import("../device-settings.ts");
const { useInboxCounts } = await import("../inbox.ts");
const { resetInboxSeenForTests } = await import("../inbox-seen.ts");
const { selfUserRecord } = await import("../test-support/language-fixture.tsx");
const {
  ask,
  ranked,
  mount,
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
// What the member has seen (task a930c9d6, task 64d3950a): while the Asks tab
// shows on a visible page, every open ask the member can see is marked seen,
// whatever the filters, so the Inbox badge lights only for what came since.
// The marks are on the member's record (inboxSeen), so they reach every
// device: the tab sends the server only the marks the record lacks, once.
describe("asks seen", () => {
  const ALL_SORT_IDS = SORT_ASKS.map((a) => a.id).sort();
  const SEEN_PATH = "/api/me/view/inbox-seen";
  beforeEach(() => {
    localStorage.clear();
    resetInboxSeenForTests();
  });
  // Each mark the tab sent, its keys sorted.
  const sent = () =>
    bodies
      .filter((_, i) => posts[i] === SEEN_PATH)
      .map((b) => [...(b as { keys: string[] }).keys].sort());
  const record = (inboxSeen?: string[]) => ({
    ...selfUserRecord(null),
    id: "u1",
    name: "Mia",
    role: "member" as const,
    ...(inboxSeen ? { inboxSeen } : {}),
  });
  // The session's member and their record, as the server sends it at connect.
  const me = (inboxSeen?: string[]): Partial<AppState> => ({
    sessionContext: {
      userId: "u1",
      username: "Mia",
      role: "member",
    } as AppState["sessionContext"],
    // The store keys a record by its lowercased name (ui/user-merge.ts).
    users: new Map([["mia", record(inboxSeen)]]) as AppState["users"],
  });
  const selfUpdated = (inboxSeen: string[]) =>
    ({
      type: "user_self_updated",
      user: record(inboxSeen),
    }) as unknown as Parameters<
      ReturnType<typeof mount>["latest"]["dispatch"]
    >[0];

  it("sends every open ask it can show that the record lacks, whatever the filters, then only one that arrives or whose agent arrives", async () => {
    setAsksFilter({
      uncheckedRooms: ["r2"],
      uncheckedAgents: [],
      priorities: ["P1"],
    });
    const { view, latest } = mount(
      [...SORT_ASKS, ranked("ghostAsk", "a9", 3, "P1")],
      { rooms: SORT_ROOMS, agents: SORT_AGENTS, ...me(["a1old", "elsewhere"]) },
    );
    await act(async () => {});
    // The filters are on: only a3's P1 ask in r1 shows.
    expect(pageOrder(view)).toEqual(["a3:a3p1"]);
    // Every ask of an agent the client has, not the ghost's, and not a1old,
    // which another device marked.
    expect(sent()).toEqual([ALL_SORT_IDS.filter((id) => id !== "a1old")]);
    // A new ask in the unchecked room: sent at once, alone.
    await act(async () =>
      latest.dispatch({
        type: "ask_upserted",
        entry: ranked("a2late", "a2", 0, "P2"),
      }),
    );
    expect(pageOrder(view)).toEqual(["a3:a3p1"]);
    expect(sent().slice(1)).toEqual([["a2late"]]);
    // The ghost's agent arrives: its ask is now one the member can see.
    await act(async () =>
      latest.setPlace({
        rooms: SORT_ROOMS,
        agents: [
          ...SORT_AGENTS,
          { id: "a9", name: "Ghost", roomId: "r2" },
        ] as AppState["agents"],
      }),
    );
    expect(sent().slice(2)).toEqual([["ghostAsk"]]);
  });

  it("sends a mark once while it is in flight or on the record; a failed mark lights the badge again and goes with the next showing", async () => {
    // The Inbox badge, in a tree of its own over the same member and asks.
    function Probe() {
      const c = useInboxCounts();
      return createElement("output", {
        "data-counts": `${c.asks}/${c.newAsks}`,
      });
    }
    const probeState = {
      ...initialState,
      asks: SORT_ASKS,
      rooms: SORT_ROOMS,
      agents: SORT_AGENTS,
      ...me([]),
    } as AppState;
    const probe = render(
      createElement(
        StateCtx.Provider,
        { value: probeState },
        createElement(Probe),
      ),
    );
    const counts = () =>
      probe.container.querySelector<HTMLElement>("[data-counts]")!.dataset
        .counts;
    expect(counts()).toBe("6/6");

    // The server's answer to the first mark, held until the test settles it.
    const settle = { fail: () => {} };
    answer = () =>
      new Promise<unknown>((_resolve, reject) => {
        settle.fail = () =>
          reject(new ApiError(503, "unavailable", "Try again."));
      });
    const { latest } = mount(SORT_ASKS, {
      rooms: SORT_ROOMS,
      agents: SORT_AGENTS,
      ...me([]),
    });
    await act(async () => {});
    expect(sent()).toEqual([ALL_SORT_IDS]);
    // In flight: the badge is clear at once.
    expect(counts()).toBe("6/0");
    // The agents slice changes while the mark is in flight: nothing again.
    await act(async () =>
      latest.setPlace({ rooms: SORT_ROOMS, agents: [...SORT_AGENTS] }),
    );
    expect(sent().length).toBe(1);

    // The server refuses it: the badge lights again.
    await act(async () => settle.fail());
    expect(counts()).toBe("6/6");
    // The next showing sends the refused marks again, with the new one.
    answer = async () => undefined;
    await act(async () =>
      latest.dispatch({
        type: "ask_upserted",
        entry: ranked("a1late", "a1", 0),
      }),
    );
    expect(sent().slice(1)).toEqual([[...ALL_SORT_IDS, "a1late"].sort()]);

    // The record comes back with them: a later change sends nothing.
    await act(async () =>
      latest.dispatch(selfUpdated([...ALL_SORT_IDS, "a1late"])),
    );
    await act(async () =>
      latest.setPlace({ rooms: SORT_ROOMS, agents: [...SORT_AGENTS] }),
    );
    expect(sent().length).toBe(2);
  });

  it("sends nothing before the member's record is in, then what the record lacks", async () => {
    const { latest } = mount(SORT_ASKS, {
      rooms: SORT_ROOMS,
      agents: SORT_AGENTS,
      ...me(),
      users: new Map() as AppState["users"],
    });
    await act(async () => {});
    expect(sent()).toEqual([]);
    await act(async () => latest.dispatch(selfUpdated(["a2only"])));
    expect(sent()).toEqual([ALL_SORT_IDS.filter((id) => id !== "a2only")]);
  });

  it("marks nothing while the page is hidden, and everything shown once it is visible again", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      const { view, latest } = mount(SORT_ASKS, {
        rooms: SORT_ROOMS,
        agents: SORT_AGENTS,
        ...me(),
      });
      // The tab shows the asks; the page is hidden.
      expect(pageOrder(view)).toEqual(BY_AGENT);
      await act(async () =>
        latest.dispatch({
          type: "ask_upserted",
          entry: ranked("a1late", "a1", 0),
        }),
      );
      expect(sent()).toEqual([]);
      await act(async () => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(sent()).toEqual([[...ALL_SORT_IDS, "a1late"].sort()]);
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
