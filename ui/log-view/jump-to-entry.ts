/**
 * Scrolls the chat to the entry rendered with data-log-entry-id = id inside
 * `root` and rings it for a moment, so the eye finds it. Returns false, and
 * does nothing, when it is not rendered there.
 */
export function jumpToLogEntry(
  id: string,
  root: ParentNode = document,
): boolean {
  const card = root.querySelector<HTMLElement>(`[data-log-entry-id="${id}"]`);
  if (!card) return false;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.style.outline = "2px solid var(--orange)";
  card.style.outlineOffset = "2px";
  card.style.borderRadius = "8px";
  setTimeout(() => {
    card.style.outline = "";
    card.style.outlineOffset = "";
    card.style.borderRadius = "";
  }, 1600);
  return true;
}
