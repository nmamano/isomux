// An answer with automate keeps its card in place (task 2b814eda). From the
// tap, the card goes straight to the rule stage's frozen look ("Updating"
// banner, the sent answer, no answer controls) and stays there, on the same
// element, through the Inbox's Undo time, the send, and the server's push and
// the POST's reply in either order. On the Inbox the banner carries the
// hold's Undo (no Undo toast); Don't save comes only with the server's
// answer. The card that draws the ask later (the pin closed during the hold)
// draws it frozen too. A failed send brings the answer controls back with the
// error. The banner is scrolled into view once, at the tap.
//
// Hooks: [data-ask] (the card), [data-ask-pending] (the Undo toast's line),
// [data-ask-updating] (the banner), [data-ask-undo], [data-ask-send-now],
// [data-ask-frozen], [data-ask-answer-sent], [data-ask-rule-decline],
// [data-asks-list], [data-asks-pinned], [data-asks-pinned-close].
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const inbox = await import("../test-support/asks-view.ts");
const { mount: stackMount, seeded } =
  await import("../test-support/asks-stack-fixture.tsx");
const { ASK_UNDO_MS } = await import("../components/AsksView.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

type Post = { path: string; body: Record<string, unknown> };
let posts: Post[] = [];
// The reply POST waits until the test settles it, with a 204 or a failure.
let settle: ((ok: boolean) => void) | null = null;
beforeEach(() => {
  posts = [];
  settle = null;
  setApiShim(async (method, path, body) => {
    if (method !== "POST") return undefined;
    posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
    await new Promise<void>((resolve, reject) => {
      settle = (ok) => (ok ? resolve() : reject(new Error("offline")));
    });
    return undefined;
  });
});
afterEach(() => {
  jest.useRealTimers();
  restoreScroll?.();
  restoreScroll = null;
});
afterAll(() => setApiShim(null));

const REPLY = "Ship now";
const WORDS = "Pick the copy yourself next time.";
const open = (id: string): AskEntry => ({
  ...inbox.ask(id, "a1", 5),
  options: [REPLY, "Wait"],
});
// What the server pushes once it holds the answer at the rule stage.
const pushed = (id: string): AskEntry => {
  const at = Date.now();
  return {
    ...open(id),
    updatedAt: at,
    automateRequest: {
      at,
      byUserId: "u1",
      words: WORDS,
      answer: { outcome: "replied", text: REPLY, at },
    },
  };
};

// Each scrollIntoView of the update banner.
let scrolls: string[] = [];
let restoreScroll: (() => void) | null = null;
function spyScroll() {
  scrolls = [];
  const proto = Element.prototype as unknown as {
    scrollIntoView?: (options?: unknown) => void;
  };
  const before = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  proto.scrollIntoView = function (this: Element) {
    if (this.hasAttribute("data-ask-updating"))
      scrolls.push(this.closest("[data-ask]")?.getAttribute("data-ask") ?? "");
  };
  restoreScroll = () => {
    if (before) Object.defineProperty(proto, "scrollIntoView", before);
    else delete proto.scrollIntoView;
  };
}

const click = (el: HTMLElement) => act(async () => void fireEvent.click(el));
const type = (el: HTMLElement, value: string) =>
  act(async () => void fireEvent.change(el, { target: { value } }));
const advance = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });
const finish = async (ok: boolean) => {
  expect(settle !== null).toBe(true);
  await act(async () => settle!(ok));
  await act(async () => {});
};

// The card where `where` draws it (never the Undo toast's line).
const cardIn = (where: string, id: string) =>
  document.body.querySelector<HTMLElement>(
    `${where} [data-ask="${id}"]:not([data-ask-pending])`,
  );
// The answer controls a rule stage hides.
const ANSWER_CONTROLS =
  "[data-ask-option], [data-ask-reply-input], [data-ask-tag], [data-ask-send], [data-ask-automate-open]";
// The card as scalars (never DOM nodes in an assertion). `same`: the card is
// the element the test marked, so it was never gone or drawn again.
function look(where: string, id: string) {
  const c = cardIn(where, id);
  const banner = c?.querySelector<HTMLElement>("[data-ask-updating]") ?? null;
  return {
    present: c !== null,
    same: c?.hasAttribute("data-test-mark") ?? false,
    frozen: c?.querySelectorAll("[data-ask-frozen]").length ?? -1,
    banner: banner !== null,
    sent: (
      c?.querySelector("[data-ask-answer-sent]")?.textContent ?? ""
    ).includes(REPLY),
    controls: c?.querySelectorAll(ANSWER_CONTROLS).length ?? -1,
    bannerUndo: banner?.querySelectorAll("[data-ask-undo]").length ?? 0,
    decline: c?.querySelectorAll("[data-ask-rule-decline]").length ?? -1,
    toast: document.body.querySelectorAll(`[data-ask-pending]`).length,
    sendNow: document.body.querySelectorAll("[data-ask-send-now]").length,
  };
}
const mark = (where: string, id: string) =>
  cardIn(where, id)!.setAttribute("data-test-mark", "");
// Frozen at the rule stage with the sent answer, before the server's answer:
// no Don't save yet.
const FROZEN = {
  present: true,
  same: true,
  frozen: 1,
  banner: true,
  sent: true,
  controls: 0,
  bannerUndo: 0,
  decline: 0,
  toast: 0,
  sendNow: 0,
};
const HELD = { ...FROZEN, bannerUndo: 1 };
const WITH_RULE_STAGE = { ...FROZEN, decline: 1 };

// The member's reply with automate, from the card's automate section.
async function answerWithAutomate(where: string, id: string) {
  const c = () => cardIn(where, id)!;
  await type(c().querySelector<HTMLElement>("[data-ask-reply-input]")!, REPLY);
  await click(c().querySelector<HTMLElement>("[data-ask-automate-open]")!);
  await type(
    c().querySelector<HTMLElement>("[data-ask-automate-input]")!,
    WORDS,
  );
  await click(c().querySelector<HTMLElement>("[data-ask-automate-send]")!);
}

const LIST = "[data-asks-list]";

it("on the Inbox the card stays in place and frozen from the tap: through the Undo time (Undo on the banner, no toast), the send, and the push and the reply in either order; Don't save comes with the server's answer; one scroll, at the tap", async () => {
  for (const order of ["reply first", "push first"] as const) {
    jest.useFakeTimers();
    spyScroll();
    posts = [];
    const id = order === "reply first" ? "kp01" : "kp02";
    const { view, latest } = inbox.mount([open(id)]);
    await advance(1);
    mark(LIST, id);
    await answerWithAutomate(LIST, id);
    expect({
      order,
      step: "held",
      posts: posts.length,
      ...look(LIST, id),
    }).toEqual({ order, step: "held", posts: 0, ...HELD });
    expect({ order, scrolls }).toEqual({ order, scrolls: [id] });
    // The card keeps its agent's heading: a held "undo" card's run drops it.
    expect({
      order,
      heading: view.container.querySelectorAll('[data-asks-group="a1"]').length,
    }).toEqual({ order, heading: 1 });
    // Through the Undo time, a moment at a time.
    await advance(ASK_UNDO_MS / 2);
    expect({ order, step: "mid-hold", ...look(LIST, id) }).toEqual({
      order,
      step: "mid-hold",
      ...HELD,
    });
    await advance(ASK_UNDO_MS / 2);
    expect({
      order,
      posts: posts.map((p) => [p.path, p.body.automate]),
    }).toEqual({ order, posts: [[`/api/asks/${id}/reply`, WORDS]] });
    expect({ order, step: "sending", ...look(LIST, id) }).toEqual({
      order,
      step: "sending",
      ...FROZEN,
    });
    const push = () =>
      act(async () => {
        latest.dispatch({ type: "ask_upserted", entry: pushed(id) } as never);
      });
    if (order === "reply first") {
      await finish(true);
      expect({ order, step: "replied", ...look(LIST, id) }).toEqual({
        order,
        step: "replied",
        ...FROZEN,
      });
      await push();
    } else {
      await push();
      expect({ order, step: "pushed", ...look(LIST, id) }).toEqual({
        order,
        step: "pushed",
        ...WITH_RULE_STAGE,
      });
      await finish(true);
    }
    expect({ order, step: "both", ...look(LIST, id) }).toEqual({
      order,
      step: "both",
      ...WITH_RULE_STAGE,
    });
    expect({ order, scrolls }).toEqual({ order, scrolls: [id] });
    view.unmount();
    restoreScroll?.();
    restoreScroll = null;
    jest.useRealTimers();
  }
});

it("the banner's Undo in the hold brings the card back unanswered, with the automate section open and its words; nothing is sent", async () => {
  jest.useFakeTimers();
  const id = "kp10";
  const { view, latest } = inbox.mount([open(id)]);
  await advance(1);
  mark(LIST, id);
  await answerWithAutomate(LIST, id);
  expect(look(LIST, id)).toEqual(HELD);
  const undo = cardIn(LIST, id)!.querySelector<HTMLElement>(
    "[data-ask-updating] [data-ask-undo]",
  )!;
  await click(undo);
  const c = cardIn(LIST, id)!;
  const back = look(LIST, id);
  expect({
    ...back,
    controls: back.controls > 0,
    reply: c.querySelector<HTMLTextAreaElement>("[data-ask-reply-input]")
      ?.value,
    words: c.querySelector<HTMLTextAreaElement>("[data-ask-automate-input]")
      ?.value,
  }).toEqual({
    present: true,
    same: true,
    frozen: 0,
    banner: false,
    sent: false,
    controls: true,
    bannerUndo: 0,
    decline: 0,
    toast: 0,
    sendNow: 0,
    reply: REPLY,
    words: WORDS,
  });
  await advance(ASK_UNDO_MS * 2);
  expect(posts.length).toBe(0);
  expect({
    answered: latest.state.answeredAsks.size,
    sent: latest.state.askSentAnswers.size,
  }).toEqual({ answered: 0, sent: 0 });
  view.unmount();
});

it("the pin closed during the hold: the answer is sent, and the list's card draws the ask frozen with the sent answer, never the answer controls", async () => {
  jest.useFakeTimers();
  const id = "kp20";
  const PIN = "[data-asks-pinned]";
  const { view, latest } = inbox.mount([open(id)], {}, null, id);
  await advance(1);
  expect({
    pin: cardIn(PIN, id) !== null,
    list: cardIn(LIST, id) !== null,
  }).toEqual({ pin: true, list: false });
  await answerWithAutomate(PIN, id);
  expect({ ...look(PIN, id), same: true }).toEqual(HELD);
  // The pin's × stays: the card is in the pin, not in a toast.
  const close = document.body.querySelector<HTMLElement>(
    "[data-asks-pinned-close]",
  )!;
  expect(close.style.visibility).toBe("");
  await click(close);
  expect(latest.focus).toBe(null);
  // The pinned card's unmount sends the held answer at once.
  expect(posts.map((p) => [p.path, p.body.automate])).toEqual([
    [`/api/asks/${id}/reply`, WORDS],
  ]);
  const listed = () => ({ ...look(LIST, id), same: true });
  expect({ step: "sending", ...listed() }).toEqual({
    step: "sending",
    ...FROZEN,
  });
  await finish(true);
  expect({ step: "replied", ...listed() }).toEqual({
    step: "replied",
    ...FROZEN,
  });
  await act(async () => {
    latest.dispatch({ type: "ask_upserted", entry: pushed(id) } as never);
  });
  expect({ step: "pushed", ...listed() }).toEqual({
    step: "pushed",
    ...WITH_RULE_STAGE,
  });
  view.unmount();
});

it("a failed send brings the card back unfrozen with its answer controls and the error", async () => {
  jest.useFakeTimers();
  const id = "kp30";
  const { view, latest } = inbox.mount([open(id)]);
  await advance(1);
  mark(LIST, id);
  await answerWithAutomate(LIST, id);
  await advance(ASK_UNDO_MS);
  expect(posts.length).toBe(1);
  expect(look(LIST, id)).toEqual(FROZEN);
  await finish(false);
  const after = look(LIST, id);
  expect({
    present: after.present,
    frozen: after.frozen,
    banner: after.banner,
    controls: after.controls > 0,
    alert: cardIn(LIST, id)!.querySelectorAll("[role=alert]").length,
    sent: latest.state.askSentAnswers.size,
    answered: latest.state.answeredAsks.size,
  }).toEqual({
    present: true,
    frozen: 0,
    banner: false,
    controls: true,
    alert: 1,
    sent: 0,
    answered: 0,
  });
  view.unmount();
});

it("in the chat stack the card freezes at the tap and stays frozen when the reply comes before the push: the answer controls never come back", async () => {
  const id = "kp40";
  const STACK = "[data-asks-stack]";
  const view = stackMount(false, "a1");
  await act(async () => {
    seeded({ type: "connected" } as never);
    seeded({ type: "ask_upserted", entry: open(id) as never });
  });
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-asks-stack]").length).toBe(1),
  );
  const collapsed = view.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  );
  if (collapsed) await click(collapsed);
  await waitFor(() => expect(cardIn(STACK, id) !== null).toBe(true));
  mark(STACK, id);
  await answerWithAutomate(STACK, id);
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0].path).toBe(`/api/asks/${id}/reply`);
  expect({ step: "sending", ...look(STACK, id) }).toEqual({
    step: "sending",
    ...FROZEN,
  });
  await finish(true);
  expect({ step: "replied", ...look(STACK, id) }).toEqual({
    step: "replied",
    ...FROZEN,
  });
  await act(async () => {
    seeded({ type: "ask_upserted", entry: pushed(id) as never });
  });
  expect({ step: "pushed", ...look(STACK, id) }).toEqual({
    step: "pushed",
    ...WITH_RULE_STAGE,
  });
  view.unmount();
});

it("after a Rewrite and automate, the plain answer that carries its words keeps the card in place and frozen too, whether the push or the reply comes first", async () => {
  for (const order of ["reply first", "push first"] as const) {
    jest.useFakeTimers();
    posts = [];
    const id = order === "reply first" ? "kp50" : "kp51";
    const waiting: AskEntry = {
      ...open(id),
      automateRequest: {
        at: Date.now() - 60_000,
        byUserId: "u1",
        words: WORDS,
      },
    };
    const { view, latest } = inbox.mount([waiting]);
    await advance(1);
    mark(LIST, id);
    const c = () => cardIn(LIST, id)!;
    await type(
      c().querySelector<HTMLElement>("[data-ask-reply-input]")!,
      REPLY,
    );
    await click(c().querySelector<HTMLElement>("[data-ask-send]")!);
    expect({
      order,
      step: "held",
      posts: posts.length,
      ...look(LIST, id),
    }).toEqual({ order, step: "held", posts: 0, ...HELD });
    await advance(ASK_UNDO_MS);
    // The server carries the words: the body has none.
    expect(posts.map((p) => [p.path, p.body.automate])).toEqual([
      [`/api/asks/${id}/reply`, undefined],
    ]);
    expect({ order, step: "sending", ...look(LIST, id) }).toEqual({
      order,
      step: "sending",
      ...FROZEN,
    });
    const push = () =>
      act(async () => {
        latest.dispatch({ type: "ask_upserted", entry: pushed(id) } as never);
      });
    if (order === "reply first") {
      await finish(true);
      expect({ order, step: "replied", ...look(LIST, id) }).toEqual({
        order,
        step: "replied",
        ...FROZEN,
      });
      await push();
    } else {
      await push();
      await finish(true);
    }
    expect({
      order,
      step: "both",
      inStore: latest.state.asks.some((e) => e.id === id),
      ...look(LIST, id),
    }).toEqual({ order, step: "both", inStore: true, ...WITH_RULE_STAGE });
    view.unmount();
    jest.useRealTimers();
  }
});
