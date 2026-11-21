// The chat composers grow with the draft up to a cap, then scroll. On a phone
// the open keyboard leaves little screen, so the cap there is eight lines
// (20px line height plus the 4px bottom padding the composers share).
const DESKTOP_MAX_HEIGHT = 200;
const MOBILE_MAX_HEIGHT = 8 * 20 + 4;

// The mobile size matches the message text in the chat log.
export const COMPOSER_MOBILE_FONT_SIZE = 15;

export function composerMaxHeight(isMobile: boolean | undefined): number {
  return isMobile ? MOBILE_MAX_HEIGHT : DESKTOP_MAX_HEIGHT;
}

export function fitComposer(
  el: HTMLTextAreaElement,
  isMobile: boolean | undefined,
): void {
  el.style.height = "auto";
  // scrollHeight leaves out the border; a border-box field needs it added.
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = `${Math.min(el.scrollHeight + border, composerMaxHeight(isMobile))}px`;
}

// Put the caret at `caret` in a chat composer, fit the composer to its
// draft, and scroll the composer so the caret line shows. The fit comes
// first: it sets the height to auto, which scrolls the field to the top, and
// setSelectionRange does not scroll the field back to the caret. Synchronous,
// so a focus inside a tap still opens the phone keyboard.
export function placeComposerCaret(
  el: HTMLTextAreaElement,
  caret: number,
  isMobile: boolean | undefined,
  opts?: { focus?: boolean },
): void {
  fitComposer(el, isMobile);
  if (opts?.focus !== false) el.focus({ preventScroll: true });
  const value = el.value;
  const c = Math.min(Math.max(caret, 0), value.length);
  el.setSelectionRange(c, c);
  if (el.scrollHeight <= el.clientHeight) return;
  if (c === value.length) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  // The height of the text before the caret puts the caret line at the
  // bottom of the field. Measured with that text alone in the field, then
  // the draft and the caret go back.
  el.value = value.slice(0, c);
  const caretBottom = el.scrollHeight;
  el.value = value;
  el.setSelectionRange(c, c);
  el.scrollTop = Math.max(0, caretBottom - el.clientHeight);
}
