// A one-option ask on the Inbox (task d05f2968): a step the member does,
// then tells the agent. A tap on the only option answers with it, held for
// Undo like a Reply; with two options a tap only fills the field. The chat's
// stack, which sends at once, is in ui/log-view/AsksStack.dom.test.tsx. A
// separate file because each DOM file has a wall-time budget.
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

it("holds a one-option tap as a reply with that option, Undo brings the field back as it was, and a two-option tap only fills the field", async () => {
  jest.useFakeTimers();
  const { view } = mount([
    { ...ask("step", "a1", 10), options: ["Done"] },
    { ...ask("pick", "a2", 5), options: ["Jim", "Dwight"] },
  ]);
  await act(async () => fireEvent.click(optionOf(view, "pick", 1)));
  expect(pendingOf(view, "pick")).toBeNull();
  expect(fieldOf(view, "pick").value).toBe("Dwight");

  // Undo brings back the member's note, not the option.
  fireEvent.change(fieldOf(view, "step"), { target: { value: "it failed" } });
  await act(async () => fireEvent.click(optionOf(view, "step", 0)));
  expect(pendingOf(view, "step")).toBe("reply");
  expect(cardEl(view, "step")!.textContent).toContain("Done");
  await act(async () => fireEvent.click(undoOf(view, "step")));
  expect(pendingOf(view, "step")).toBeNull();
  expect(fieldOf(view, "step").value).toBe("it failed");
  fireEvent.change(fieldOf(view, "step"), { target: { value: "" } });

  await act(async () => fireEvent.click(optionOf(view, "step", 0)));
  await advance(ASK_UNDO_MS - 1);
  expect(posts).toEqual([]);
  await advance(1);
  expect(posts).toEqual(["/api/asks/step/reply"]);
  expect(bodies).toEqual([{ text: "Done" }]);
});

for (const [label, recommended, typed, sent] of [
  [
    "a typed note goes after the option",
    undefined,
    "took two tries",
    "Done\n\ntook two tries",
  ],
  [
    "a typed note that is the option is not repeated",
    undefined,
    " Done ",
    "Done",
  ],
  ["a blank field adds nothing", undefined, "   ", "Done"],
  ["the untouched recommended default adds nothing", "Done", undefined, "Done"],
] as const) {
  it(`one-option tap: ${label}`, async () => {
    jest.useFakeTimers();
    const { view } = mount([
      {
        ...ask("note", "a1", 5),
        options: ["Done"],
        ...(recommended ? { recommended } : {}),
      },
    ]);
    if (typed !== undefined)
      fireEvent.change(fieldOf(view, "note"), { target: { value: typed } });
    await act(async () => fireEvent.click(optionOf(view, "note", 0)));
    expect(pendingOf(view, "note")).toBe("reply");
    await advance(ASK_UNDO_MS);
    expect(posts).toEqual(["/api/asks/note/reply"]);
    expect(bodies).toEqual([{ text: sent }]);
  });
}
