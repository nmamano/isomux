// The Asks page (ui/components/AsksView.tsx) over a real reducer: groups by
// agent with the longest wait first, a group goes with its last card, Tab
// crosses groups, and a card's panel buttons open its agent's chat. An answer
// waits ASK_UNDO_MS for an Undo, and is sent at once when the page goes away.
// The agent's name opening its chat and an ask from an agent the client does
// not have are in ui/App.inbox.dom.test.tsx; the card itself, which the chat's
// stack sends at once, is in AsksStack.dom.test.tsx.
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { useReducer, createElement } = await import("react");
const { AsksView, ASK_UNDO_MS } = await import("./AsksView.tsx");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;
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

function mount(asks: AskEntry[]) {
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
  };
  const focused: string[] = [];
  const latest: { state: AppState } = { state: seeded };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, seeded);
    latest.state = state;
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

const groupIds = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll<HTMLElement>("[data-asks-group]")].map(
    (el) => el.dataset.asksGroup,
  );
const cardIds = (view: ReturnType<typeof render>, agentId: string) =>
  [
    ...view.container.querySelectorAll<HTMLElement>(
      `[data-asks-group="${agentId}"] [data-ask]`,
    ),
  ].map((el) => el.dataset.ask);

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
});

it("moves with Tab from one agent's reply field to the next agent's, in page order", () => {
  const { view } = mount([ask("later", "a1", 30), ask("first", "a2", 90)]);
  const field = (id: string) =>
    view.container.querySelector<HTMLInputElement>(
      `[data-ask="${id}"] form input`,
    )!;
  // A scalar: a failed toBe on two DOM nodes serialises both.
  const focused = () => {
    const el = document.activeElement;
    return `${el?.closest<HTMLElement>("[data-ask]")?.dataset.ask}/${el?.tagName}`;
  };
  // a2 waited longest, so its group is drawn first.
  act(() => field("first").focus());
  let free = true;
  act(() => {
    free = fireEvent.keyDown(field("first"), { key: "Tab" });
  });
  expect(free).toBe(false);
  expect(focused()).toBe("later/INPUT");
  act(() => {
    free = fireEvent.keyDown(field("later"), { key: "Tab", shiftKey: true });
  });
  expect(free).toBe(false);
  expect(focused()).toBe("first/INPUT");
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
  cardEl(view, id)!.querySelector<HTMLInputElement>(
    "input[data-ask-reply-input]",
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

it("brings the card back on Undo, with the draft and focus in its field, and a new answer runs on its own timer", async () => {
  jest.useFakeTimers();
  const half = Math.floor(ASK_UNDO_MS / 2);
  const { view } = mount([ask("undone", "a1", 5)]);
  await answerAsk(view, "undone", "reply", "half a thought");
  expect(pendingOf(view, "undone")).toBe("reply");
  await advance(half);
  await act(async () => fireEvent.click(undoOf(view, "undone")));
  expect(pendingOf(view, "undone")).toBeNull();
  expect(fieldOf(view, "undone").value).toBe("half a thought");
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
