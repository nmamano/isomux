/**
 * Scrolls the chat to the entry rendered with data-log-entry-id = id and
 * rings it for a moment, so the eye finds it. No-op when it is not rendered.
 */
export function jumpToLogEntry(id: string): void {
  const card = document.querySelector<HTMLElement>(
    `[data-log-entry-id="${id}"]`,
  );
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.style.outline = "2px solid var(--orange)";
  card.style.outlineOffset = "2px";
  card.style.borderRadius = "8px";
  setTimeout(() => {
    card.style.outline = "";
    card.style.outlineOffset = "";
    card.style.borderRadius = "";
  }, 1600);
}
