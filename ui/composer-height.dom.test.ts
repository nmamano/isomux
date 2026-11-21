// placeComposerCaret (task fefacd08): it puts the caret in a chat composer,
// fits the composer to its draft and scrolls it so the caret line shows. On a
// phone a long cite left the field scrolled to its top with the caret out of
// view below: the fit after the caret placement set the height to auto, which
// scrolls the field back to the top. The call sites are in
// LogView.composer-caret.dom.test.tsx.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { composerMaxHeight, placeComposerCaret } =
  await import("./composer-height.ts");
const { layOutTextareas, textHeight } =
  await import("./test-support/textarea-layout.ts");

// 30 lines: taller than either cap.
const LONG = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

let undo = () => {};
let el: HTMLTextAreaElement;
beforeEach(() => {
  undo = layOutTextareas();
  el = document.createElement("textarea");
  document.body.append(el);
  el.value = LONG;
  // One line tall, as before the draft grew.
  el.style.height = `${textHeight("")}px`;
});
afterEach(() => {
  el.remove();
  undo();
});

for (const isMobile of [true, false]) {
  it(`${isMobile ? "on a phone" : "on a desktop"}, a caret at the end of a long draft shows at the bottom of the capped field, with focus`, () => {
    const cap = composerMaxHeight(isMobile);
    expect(textHeight(LONG)).toBeGreaterThan(cap);
    placeComposerCaret(el, LONG.length, isMobile);
    expect(el.style.height).toBe(`${cap}px`);
    expect(el.value).toBe(LONG);
    expect([el.selectionStart, el.selectionEnd]).toEqual([
      LONG.length,
      LONG.length,
    ]);
    expect(el.scrollTop).toBe(textHeight(LONG) - cap);
    expect(document.activeElement === el).toBe(true);
  });
}

it("a caret in the middle of a long draft shows its line at the bottom of the field, and the draft and the caret stay", () => {
  // Inside line 15: the text before the caret is 15 lines tall.
  const caret = LONG.indexOf("line 15") + 3;
  const before = textHeight(LONG.slice(0, caret));
  const cap = composerMaxHeight(true);
  expect(before).toBeGreaterThan(cap);
  expect(before).toBeLessThan(textHeight(LONG));
  placeComposerCaret(el, caret, true);
  expect(el.value).toBe(LONG);
  expect([el.selectionStart, el.selectionEnd]).toEqual([caret, caret]);
  expect(el.scrollTop).toBe(before - cap);
});

it("a caret in the first lines of a long draft leaves the field at its top", () => {
  // The member had scrolled the capped field down.
  el.style.height = `${composerMaxHeight(true)}px`;
  el.scrollTop = 300;
  expect(el.scrollTop).toBe(300);
  const caret = LONG.indexOf("line 3") + 2;
  placeComposerCaret(el, caret, true);
  expect([el.selectionStart, el.selectionEnd]).toEqual([caret, caret]);
  expect(el.scrollTop).toBe(0);
});

it("with focus off, places the caret and shows it without taking focus", () => {
  expect(document.activeElement === el).toBe(false);
  placeComposerCaret(el, LONG.length, true, { focus: false });
  expect(document.activeElement === el).toBe(false);
  expect(el.selectionStart).toBe(LONG.length);
  expect(el.scrollTop).toBe(textHeight(LONG) - composerMaxHeight(true));
});
