// Put the caret at the end of a fixed-height text field and scroll the field
// so the caret line shows. It does not focus the field. A field that grows
// with its draft (a chat composer) uses placeComposerCaret instead.
export function caretToEnd(el: HTMLTextAreaElement): void {
  const end = el.value.length;
  el.setSelectionRange(end, end);
  // setSelectionRange does not scroll a field whose text arrived after the
  // focus, so the scroll is explicit.
  el.scrollTop = el.scrollHeight;
}
