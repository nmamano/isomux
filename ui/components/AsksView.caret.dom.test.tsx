// An ask's reply field shows its caret after its text changes under it (task
// 75c7ce43): an option tap with a mouse and an Undo put the caret at the end
// of a draft taller than the field's cap, and the field scrolls so the caret
// line shows. The fit sets the height to auto, which scrolls the field to the
// top, so the caret goes in after the fit. The chat composer's own cases are
// in ui/log-view/LogView.composer-caret.dom.test.tsx; the focus itself in
// AsksView.options.dom.test.tsx and AsksView.held.dom.test.tsx.
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
type View = ReturnType<typeof mount>["view"];
const { setApiShim } = await import("../api.ts");
const { ask, mount } = await import("../test-support/asks-view.ts");
const { layOutTextareas, scrolledToEnd } =
  await import("../test-support/textarea-layout.ts");
const { primaryPointer } = await import("../test-support/pointer.ts");

// Taller than the cap on a phone and on a desktop. The model has no wrap, so
// a long line is written as many lines.
const LONG = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

let undoLayout = () => {};
let undoPointer = () => {};
beforeEach(() => {
  setApiShim(async () => undefined);
  undoLayout = layOutTextareas();
});
afterEach(() => {
  undoPointer();
  undoPointer = () => {};
  undoLayout();
  jest.useRealTimers();
});
afterAll(() => setApiShim(null));

const cardEl = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
const fieldOf = (view: View, id: string) =>
  cardEl(view, id).querySelector<HTMLTextAreaElement>(
    "[data-ask-reply-input]",
  )!;
// A boolean, not toBe on two nodes: a red run would serialise both.
const focused = (el: HTMLElement) => document.activeElement === el;

it("an option tap with a mouse puts a long option in the field with its end in view and the caret there", async () => {
  undoPointer = primaryPointer(false);
  const { view } = mount([
    { ...ask("pick", "a1", 5), options: ["Short", LONG] },
  ]);
  const option = cardEl(view, "pick").querySelectorAll<HTMLButtonElement>(
    "[data-ask-option]",
  )[1];
  await act(async () => fireEvent.click(option));
  const field = fieldOf(view, "pick");
  expect(field.value).toBe(LONG);
  expect(focused(field)).toBe(true);
  expect(field.selectionStart).toBe(LONG.length);
  expect(scrolledToEnd(field)).toEqual({ overflows: true, atEnd: true });
  view.unmount();
});

it("Undo of a long held reply on a phone brings the draft back with its end in view and the caret there", async () => {
  jest.useFakeTimers();
  undoPointer = primaryPointer(true);
  const { view } = mount([ask("held", "a1", 5)], { isMobile: true });
  fireEvent.change(fieldOf(view, "held"), { target: { value: LONG } });
  await act(async () =>
    fireEvent.click(
      cardEl(view, "held").querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!,
    ),
  );
  const undo = cardEl(view, "held").querySelector<HTMLButtonElement>(
    "[data-ask-undo]",
  );
  expect(undo).not.toBeNull();
  await act(async () => fireEvent.click(undo!));
  const field = fieldOf(view, "held");
  expect(field.value).toBe(LONG);
  expect(focused(field)).toBe(true);
  expect(field.selectionStart).toBe(LONG.length);
  expect(scrolledToEnd(field)).toEqual({ overflows: true, atEnd: true });
  view.unmount();
});
