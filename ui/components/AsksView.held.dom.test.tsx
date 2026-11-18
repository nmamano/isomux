// The Inbox, AsksView over a real reducer: an answer waits ASK_UNDO_MS for an
// Undo on a line that scrolls into view, and a held answer leaves the list at
// once and comes back on Undo or a refusal. Split from
// ui/components/AsksView.dom.test.tsx, which holds the groups, the cards and
// the asks seen, because the 5 s cap is per file;
// ui/components/AsksView.held-send.dom.test.tsx holds a held answer sent
// before its time (Send now, the Inbox going away, pagehide).
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
type View = ReturnType<typeof import("@testing-library/react").render>;
const { ASK_UNDO_MS } = await import("./AsksView.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { ask, mount, groupIds, pageOrder } =
  await import("../test-support/asks-view.ts");
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

const cardEl = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
const fieldOf = (view: View, id: string) =>
  cardEl(view, id)!.querySelector<HTMLTextAreaElement>(
    "[data-ask-reply-input]",
  )!;
// The pending line's kind (marked on the card's box or inside it), or null
// while the card is drawn.
const pendingOf = (view: View, id: string) => {
  const card = cardEl(view, id);
  const marked = card?.matches("[data-ask-pending]")
    ? card
    : card?.querySelector<HTMLElement>("[data-ask-pending]");
  return marked?.dataset.askPending ?? null;
};
const undoOf = (view: View, id: string) =>
  cardEl(view, id)!.querySelector<HTMLButtonElement>("[data-ask-undo]")!;

type Kind = "reply" | "dismiss" | "file-task";
// Types the text in the card's field and clicks the answer of that kind.
async function answerAsk(view: View, id: string, kind: Kind, text?: string) {
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

// Each scrollIntoView call while it is installed: the ask it was called on
// (null for any other element), whether it was the held card's empty place in
// the list, and the options. happy-dom has no layout, so the call is what a
// test can see of the scroll.
type ScrollCall = {
  ask: string | null;
  place: boolean;
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
      ask:
        this.closest<HTMLElement>("[data-ask]")?.dataset.ask ??
        this.getAttribute("data-ask-place"),
      place: this.hasAttribute("data-ask-place"),
      block: options.block ?? null,
      smooth: options.behavior === "smooth",
    });
  };
  restoreScroll = () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", original);
  };
  return calls;
}

// A tall card leaves the list for its Undo toast, so the list moves up under
// a scroller that keeps its place: the card's empty place scrolls into view,
// nearest edge and at once, so the next ask starts under it (tasks bfae0ab8,
// 02274529).
for (const kind of ["reply", "dismiss", "file-task"] as const) {
  it(`scrolls the place of a held ${kind} into view once, and not on Undo or when the line goes`, async () => {
    jest.useFakeTimers();
    const calls = watchScroll();
    const { view, latest } = mount([
      ask("tall", "a1", 30),
      ask("next", "a1", 20),
    ]);
    expect(calls).toEqual([]);
    const line = {
      ask: "tall",
      place: true,
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

// The Undo line is a toast over the list, and the held card leaves the list
// at once, with its agent's name when it was that run's only card: nothing in
// the list moves when the line goes (task 02274529).
it("moves a held answer out of the list at once, with its agent's name, and back on Undo", async () => {
  jest.useFakeTimers();
  const { view } = mount([ask("only", "a1", 30), ask("next", "a2", 20)]);
  const host = view.container.querySelector("[data-asks-undo-host]")!;
  const nameOf = (agentId: string) =>
    view.container.querySelector<HTMLElement>(
      `[data-asks-group="${agentId}"]`,
    )!;
  expect(pageOrder(view)).toEqual(["a1:only", "a2:next"]);
  expect(nameOf("a2").style.margin.startsWith("0px ")).toBe(false);
  await answerAsk(view, "only", "reply", "go");
  expect(
    host.querySelector('[data-ask="only"]')?.getAttribute("data-ask-pending"),
  ).toBe("reply");
  expect(pageOrder(view)).toEqual(["a2:next"]);
  // The first name showing has no space above it, as it will once sent.
  expect(nameOf("a2").style.margin.startsWith("0px ")).toBe(true);
  await act(async () => fireEvent.click(undoOf(view, "only")));
  expect(pageOrder(view)).toEqual(["a1:only", "a2:next"]);
  expect(host.childElementCount).toBe(0);
  await answerAsk(view, "only", "reply", "go");
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual(["/api/asks/only/reply"]);
  expect(pageOrder(view)).toEqual(["a2:next"]);
  expect(nameOf("a2").style.margin.startsWith("0px ")).toBe(true);
  expect(host.childElementCount).toBe(0);
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
    // x and z are sent and gone, and y and w are held, so no card shows.
    expect([...posts].sort()).toEqual([
      "/api/asks/x/reply",
      "/api/asks/z/reply",
    ]);
    expect(pageOrder(view)).toEqual([]);
    expect(pendingOf(view, "y")).toBe("reply");
    expect(pendingOf(view, "w")).toBe("reply");
    await act(async () => fireEvent.click(undoOf(view, "w")));
    expect(fieldOf(view, "w").value).toBe("joins");
    expect(pageOrder(view)).toEqual(["a1:w"]);
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
