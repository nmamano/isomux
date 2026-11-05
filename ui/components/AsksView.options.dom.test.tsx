// Option taps on the Inbox (tasks d05f2968, a8416d7d): a tap on the option
// the reply field holds sends it, held for Undo like a Reply; a tap on any
// other option fills the field. A one-option ask starts with its option in
// the field, so one tap sends it, and so does the recommended option. The
// chat's stack, which sends at once, is in ui/log-view/AsksStack.dom.test.tsx.
// A separate file because each DOM file has a wall-time budget.
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
type View = ReturnType<typeof mount>["view"];
const { ASK_UNDO_MS } = await import("./AsksView.tsx");
const { setApiShim } = await import("../api.ts");
const { ask, mount } = await import("../test-support/asks-view.ts");

let posts: string[] = [];
let bodies: unknown[] = [];
beforeEach(() => {
  posts = [];
  bodies = [];
  setApiShim(async (method, path, body) => {
    if (method !== "POST") return undefined;
    posts.push(path);
    bodies.push(body);
    return undefined;
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
const optionOf = (view: View, id: string, i: number) =>
  cardEl(view, id)!.querySelectorAll<HTMLButtonElement>("[data-ask-option]")[i];

const sendsOf = (view: View, id: string) =>
  [
    ...cardEl(view, id)!.querySelectorAll<HTMLButtonElement>(
      "[data-ask-option-sends]",
    ),
  ].map((b) => b.textContent);

it("holds a one-option tap as a reply with that option, and Undo brings the card back as it was", async () => {
  jest.useFakeTimers();
  const { view } = mount([{ ...ask("step", "a1", 10), options: ["Done"] }]);
  expect(fieldOf(view, "step").value).toBe("Done");
  expect(sendsOf(view, "step")).toEqual(["Done"]);

  await act(async () => fireEvent.click(optionOf(view, "step", 0)));
  expect(pendingOf(view, "step")).toBe("reply");
  expect(cardEl(view, "step")!.textContent).toContain("Done");
  await act(async () => fireEvent.click(undoOf(view, "step")));
  expect(pendingOf(view, "step")).toBeNull();
  expect(fieldOf(view, "step").value).toBe("Done");
  expect(sendsOf(view, "step")).toEqual(["Done"]);

  await act(async () => fireEvent.click(optionOf(view, "step", 0)));
  await advance(ASK_UNDO_MS - 1);
  expect(posts).toEqual([]);
  await advance(1);
  expect(posts).toEqual(["/api/asks/step/reply"]);
  expect(bodies).toEqual([{ text: "Done" }]);
});

it("a typed note turns the only option into a fill: a tap puts the option back and sends nothing, the next tap sends", async () => {
  jest.useFakeTimers();
  const { view } = mount([{ ...ask("note", "a1", 5), options: ["Done"] }]);
  fireEvent.change(fieldOf(view, "note"), {
    target: { value: "Done\n\ntook two tries" },
  });
  expect(sendsOf(view, "note")).toEqual([]);
  await act(async () => fireEvent.click(optionOf(view, "note", 0)));
  expect(pendingOf(view, "note")).toBeNull();
  expect(fieldOf(view, "note").value).toBe("Done");
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual([]);

  await act(async () => fireEvent.click(optionOf(view, "note", 0)));
  expect(pendingOf(view, "note")).toBe("reply");
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual(["/api/asks/note/reply"]);
  expect(bodies).toEqual([{ text: "Done" }]);
});

it("two options: the first tap fills, the second tap on the same option is held as the reply", async () => {
  jest.useFakeTimers();
  const { view } = mount([
    { ...ask("pick", "a2", 5), options: ["Jim", "Dwight"] },
  ]);
  expect(sendsOf(view, "pick")).toEqual([]);
  await act(async () => fireEvent.click(optionOf(view, "pick", 1)));
  expect(pendingOf(view, "pick")).toBeNull();
  expect(fieldOf(view, "pick").value).toBe("Dwight");
  expect(sendsOf(view, "pick")).toEqual(["Dwight"]);
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual([]);

  await act(async () => fireEvent.click(optionOf(view, "pick", 1)));
  expect(pendingOf(view, "pick")).toBe("reply");
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual(["/api/asks/pick/reply"]);
  expect(bodies).toEqual([{ text: "Dwight" }]);
});

it("sends the recommended option with one tap, and another option with two; the recommended mark stays", async () => {
  jest.useFakeTimers();
  const { view } = mount([
    {
      ...ask("rec", "a1", 5),
      options: ["Yes", "No"],
      recommended: "No",
    },
    { ...ask("other", "a2", 4), options: ["Yes", "No"], recommended: "No" },
  ]);
  const recommendedOf = (id: string) =>
    [
      ...cardEl(view, id)!.querySelectorAll<HTMLButtonElement>(
        "[data-ask-option-recommended]",
      ),
    ].map((b) => b.textContent);
  expect(fieldOf(view, "rec").value).toBe("No");
  expect(sendsOf(view, "rec")).toEqual(["No"]);
  await act(async () => fireEvent.click(optionOf(view, "rec", 1)));
  expect(pendingOf(view, "rec")).toBe("reply");
  await advance(ASK_UNDO_MS);
  expect(posts).toEqual(["/api/asks/rec/reply"]);
  expect(bodies).toEqual([{ text: "No" }]);

  await act(async () => fireEvent.click(optionOf(view, "other", 0)));
  expect(pendingOf(view, "other")).toBeNull();
  expect(sendsOf(view, "other")).toEqual(["Yes"]);
  expect(recommendedOf("other")).toEqual(["No"]);
  await act(async () => fireEvent.click(optionOf(view, "other", 0)));
  expect(pendingOf(view, "other")).toBe("reply");
  await advance(ASK_UNDO_MS);
  expect(bodies).toEqual([{ text: "No" }, { text: "Yes" }]);
});

// The primary pointer while `run` mounts and taps: coarse is a touch screen.
async function withPointer(coarse: boolean, run: () => Promise<void>) {
  const original = window.matchMedia;
  window.matchMedia = (query: string) =>
    query === "(pointer: coarse)"
      ? ({ matches: coarse, media: query } as MediaQueryList)
      : original.call(window, query);
  try {
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(coarse);
    await run();
  } finally {
    window.matchMedia = original;
  }
}
const fieldFocused = (view: View, id: string) =>
  document.activeElement?.hasAttribute("data-ask-reply-input") === true &&
  document.activeElement.closest<HTMLElement>("[data-ask]")?.dataset.ask === id;

for (const coarse of [true, false])
  it(`a fill ${coarse ? "on a touch screen leaves the field unfocused, so no keyboard moves the options" : "with a mouse focuses the field"}`, async () => {
    await withPointer(coarse, async () => {
      const { view } = mount([
        { ...ask("pick", "a2", 5), options: ["Jim", "Dwight"] },
      ]);
      expect(fieldFocused(view, "pick")).toBe(false);
      await act(async () => fireEvent.click(optionOf(view, "pick", 1)));
      expect(fieldOf(view, "pick").value).toBe("Dwight");
      expect(sendsOf(view, "pick")).toEqual(["Dwight"]);
      expect(fieldFocused(view, "pick")).toBe(!coarse);
      view.unmount();
    });
  });
