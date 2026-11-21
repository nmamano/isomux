// The Inbox, AsksView over a real reducer: a held answer sent before its
// time, by the line's × (Send now, task aa8a9ddb) on a card or the pinned ask,
// when the Inbox goes away, or on pagehide and a hidden page; and the pinned
// frame's × hidden while its line shows (task 691d067a). Split from
// ui/components/AsksView.held.dom.test.tsx, which holds the Undo line, its
// timers, its scroll and the list, because the 5 s cap is per file;
// ui/components/AsksView.dom.test.tsx holds the groups, the cards and the asks
// seen.
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
type View = ReturnType<typeof import("@testing-library/react").render>;
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { ASK_UNDO_MS } = await import("./AsksView.tsx");
const { setApiShim } = await import("../api.ts");
const { ask, mount, pageOrder } = await import("../test-support/asks-view.ts");
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

type Kind = "reply" | "dismiss" | "postpone";
// Types the text in the card's field and clicks the answer of that kind: a
// dismiss and a postpone are a tag on the field (task 1466ea8b), sent by
// the send button that names it. A card back from Undo keeps its tag.
async function answerAsk(view: View, id: string, kind: Kind, text?: string) {
  const card = cardEl(view, id)!;
  const click = (selector: string) =>
    act(async () =>
      fireEvent.click(card.querySelector<HTMLButtonElement>(selector)!),
    );
  const chip = card.querySelector<HTMLElement>("[data-ask-tag-chip]")?.dataset
    .askTagChip;
  if (kind === "dismiss" && chip !== "dismiss")
    await click('[data-ask-tag="dismiss"]');
  if (kind === "postpone" && chip !== "postpone")
    await click('[data-ask-tag="postpone"]');
  if (text !== undefined)
    fireEvent.change(fieldOf(view, id), { target: { value: text } });
  await click(
    kind === "reply"
      ? 'button[type="submit"][data-ask-send="reply"]'
      : `button[type="submit"][data-ask-send="${kind}"]`,
  );
}

// The line's × sends the held answer at once (task aa8a9ddb): the POST and
// body the end of the Undo time sends, once, and the line goes, so no Undo is
// left. Its name says it sends: on a line that can read Dismissed, the shared
// Dismiss name would hide that.
for (const [kind, text] of [
  ["reply", "Ship it on Monday"],
  ["dismiss", "Not this week"],
  ["postpone", "Do it after the release"],
] as const) {
  it(`sends a held ${kind} at once from the line's ×, and only once`, async () => {
    jest.useFakeTimers();
    // The POST is held open: the line goes when the ask turns sending, not
    // when the server answers.
    let settle!: () => void;
    answer = () =>
      new Promise<undefined>((resolve) => {
        settle = () => resolve(undefined);
      });
    const { view } = mount([ask("now", "a1", 30), ask("next", "a2", 20)]);
    const host = view.container.querySelector("[data-asks-undo-host]")!;
    await answerAsk(view, "now", kind, text);
    expect(pendingOf(view, "now")).toBe(kind);
    const send = host.querySelector<HTMLButtonElement>(
      '[data-ask="now"] [data-ask-send-now]',
    );
    expect(send?.tagName).toBe("BUTTON");
    const name = send!.getAttribute("aria-label");
    expect(name ?? "").not.toBe("");
    expect(send!.title).toBe(name!);
    expect(name).not.toBe(translatorFor("en").t("common.dismiss"));
    expect(name).not.toBe(undoOf(view, "now").textContent);
    await advance(1);
    expect(posts).toEqual([]);
    await act(async () => fireEvent.click(send!));
    await act(async () => {});
    expect(posts).toEqual([`/api/asks/now/${kind}`]);
    expect(bodies).toEqual([{ text }]);
    expect(cardEl(view, "now")).toBeNull();
    expect(host.childElementCount).toBe(0);
    expect(pageOrder(view)).toEqual(["a2:next"]);
    await act(async () => settle());
    // Neither the end of the Undo time nor leaving the Inbox sends it again.
    await advance(ASK_UNDO_MS * 2);
    expect(posts).toHaveLength(1);
    await act(async () => view.unmount());
    expect(posts).toHaveLength(1);
  });
}

// The pinned ask draws its line in place, not in the list's toast host: its
// × sends the same way.
it("sends a held answer at once from the × on the pinned ask's line, and only once", async () => {
  jest.useFakeTimers();
  const { view } = mount(
    [ask("pin", "a1", 30), ask("next", "a2", 20)],
    {},
    null,
    "pin",
  );
  const pinned = view.container.querySelector("[data-asks-pinned]")!;
  expect(pageOrder(view)).toEqual(["a2:next"]);
  await answerAsk(view, "pin", "reply", "From the pin");
  const line = pinned.querySelector<HTMLElement>('[data-ask="pin"]');
  expect(line?.dataset.askPending).toBe("reply");
  const send = line!.querySelector<HTMLButtonElement>("[data-ask-send-now]");
  expect(send?.tagName).toBe("BUTTON");
  await act(async () => fireEvent.click(send!));
  await act(async () => {});
  expect(posts).toEqual(["/api/asks/pin/reply"]);
  expect(bodies).toEqual([{ text: "From the pin" }]);
  expect(view.container.querySelector("[data-ask-pending]")).toBeNull();
  expect(view.container.querySelector("[data-ask-undo]")).toBeNull();
  await advance(ASK_UNDO_MS * 2);
  expect(posts).toHaveLength(1);
  await act(async () => view.unmount());
  expect(posts).toHaveLength(1);
});

it("sends every waiting answer at once when the Inbox goes away, and only once", async () => {
  jest.useFakeTimers();
  const { view } = mount([ask("left1", "a1", 30), ask("left2", "a2", 20)]);
  await answerAsk(view, "left1", "reply", "yes");
  await answerAsk(view, "left2", "postpone", "later");
  expect(posts).toEqual([]);
  await act(async () => view.unmount());
  expect([...posts].sort()).toEqual([
    "/api/asks/left1/reply",
    "/api/asks/left2/postpone",
  ]);
  await advance(ASK_UNDO_MS * 2);
  expect(posts).toHaveLength(2);
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

// The pinned ask shows one × at a time (task 691d067a): while its answer is
// held, the frame's close is hidden and the line's Send now is the ×. The
// frame's close keeps its place (visibility, not removal), so the line does
// not move when it goes and comes back. It shows again on Undo, while the
// answer sends, and on the closed ask's read-only card. An answer held in
// the list, for another ask, leaves the pinned frame's close as it was.
it("hides the pinned frame's × only while the pinned ask's answer is held", async () => {
  jest.useFakeTimers();
  let settle!: () => void;
  answer = () =>
    new Promise<undefined>((resolve) => {
      settle = () => resolve(undefined);
    });
  const reads: string[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "GET") {
      reads.push(path);
      return {
        ...ask("pin", "a1", 30),
        closed: { at: 2_000, outcome: "replied", by: "member", answer: "x" },
        events: [],
      };
    }
    posts.push(path);
    bodies.push(body);
    return answer();
  });
  const { view } = mount(
    [ask("pin", "a1", 30), ask("next", "a2", 20)],
    {},
    null,
    "pin",
  );
  const pinned =
    view.container.querySelector<HTMLElement>("[data-asks-pinned]")!;
  const frameClose = () =>
    pinned.querySelector<HTMLButtonElement>("[data-asks-pinned-close]")!;
  // Hidden from sight but still laid out: the row keeps its height.
  const isHeld = (el: HTMLElement) =>
    getComputedStyle(el).visibility === "hidden" &&
    getComputedStyle(el).display !== "none";
  // Seen: no box from the button up to the frame is hidden or not drawn.
  const isSeen = (el: HTMLElement) => {
    for (let at: HTMLElement | null = el; at; at = at.parentElement) {
      const cs = getComputedStyle(at);
      if (at.hidden || cs.display === "none" || cs.visibility === "hidden")
        return false;
      if (at === pinned) return true;
    }
    return false;
  };
  const seenCloses = () =>
    [
      ...pinned.querySelectorAll<HTMLElement>(
        "[data-asks-pinned-close], [data-ask-send-now]",
      ),
    ].filter(isSeen).length;

  expect(frameClose().tagName).toBe("BUTTON");
  expect(isSeen(frameClose())).toBe(true);

  // An answer held in the list, for the other ask: the frame is not touched.
  await answerAsk(view, "next", "reply", "From the list");
  expect(pendingOf(view, "next")).toBe("reply");
  expect(isSeen(frameClose())).toBe(true);
  expect(seenCloses()).toBe(1);

  // Held on the pinned ask: the line's × is the only one.
  await answerAsk(view, "pin", "reply", "From the pin");
  expect(pendingOf(view, "pin")).toBe("reply");
  const sendNow = () =>
    pinned.querySelector<HTMLButtonElement>("[data-ask-send-now]");
  expect(isSeen(sendNow()!)).toBe(true);
  expect(frameClose()?.tagName).toBe("BUTTON");
  expect(isHeld(frameClose())).toBe(true);
  expect(seenCloses()).toBe(1);

  // Undo: the card is back, and so is the frame's ×.
  await act(async () => fireEvent.click(undoOf(view, "pin")));
  expect(pendingOf(view, "pin")).toBeNull();
  expect(sendNow()).toBeNull();
  expect(isSeen(frameClose())).toBe(true);

  // Held again, then sent now: while the POST is open the frame's × shows.
  await answerAsk(view, "pin", "dismiss");
  expect(isHeld(frameClose())).toBe(true);
  await act(async () => fireEvent.click(sendNow()!));
  await act(async () => {});
  expect(posts).toEqual(["/api/asks/pin/dismiss"]);
  expect(sendNow()).toBeNull();
  expect(isSeen(frameClose())).toBe(true);

  // Sent: the closed ask reads back read-only, with the frame's ×.
  await act(async () => settle());
  await act(async () => {});
  await act(async () => {});
  expect(reads).toEqual(["/api/asks/pin"]);
  expect(pinned.querySelector("[data-ask-readonly='pin']")).not.toBeNull();
  expect(isSeen(frameClose())).toBe(true);
  expect(seenCloses()).toBe(1);
});
