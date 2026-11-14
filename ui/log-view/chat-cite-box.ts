import { PILL_GAP, PILL_HEIGHT } from "./CiteSelectionButton.tsx";

// The chat's jump-to-bottom button: a round button above the composer's
// top-right corner (LogView places it with these values).
export const JUMP_SIZE = 36;
export const JUMP_RIGHT = 32;
export const JUMP_GAP = 12;

// The box the pinned Cite pill (iOS touch) takes its bottom-right corner
// from, for a selection in the chat and in an ask of its asks stack alike
// (task 3d440170): the pill sits just above the message box (the composer's
// input row) at its right, over whatever is above the row, the asks stack
// included. Where the pill would meet the jump-to-bottom button's place, its
// right edge moves left of that place. The place counts while the button is
// hidden too: a scroll shows and hides it, and the pill must not move under
// the member's finger.
//
// The box is read when the pill renders, with no ResizeObserver: the input
// row is the composer's bottom child, so it moves only with the textarea's
// height and the viewport (the keyboard), and both re-render LogView.
//
// Null when `composer` has no input row.
export function chatCitePinnedBox(composer: Element): DOMRect | null {
  const row = composer.querySelector("[data-chat-input-row]");
  if (!row) return null;
  const box = composer.getBoundingClientRect();
  const { top, right } = row.getBoundingClientRect();
  const pillBottom = top - PILL_GAP;
  const jumpBottom = box.top - JUMP_GAP;
  const meets =
    pillBottom - PILL_HEIGHT < jumpBottom &&
    pillBottom > jumpBottom - JUMP_SIZE;
  const edge = meets
    ? Math.min(right, box.right - JUMP_RIGHT - JUMP_SIZE)
    : right;
  return new DOMRect(box.left, box.top, edge - box.left, top - box.top);
}
