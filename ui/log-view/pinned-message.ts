import type { LogEntry } from "../../shared/types.ts";
import { senderIsHuman } from "./LogEntryCard.tsx";

export interface VerticalRect {
  top: number;
  bottom: number;
}

export function pinnedHumanMessageId(
  logs: readonly LogEntry[],
  rectForId: (id: string) => VerticalRect | undefined,
  viewport: VerticalRect,
): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    if (entry.kind !== "user_message" || !senderIsHuman(entry.metadata))
      continue;
    const rect = rectForId(entry.id);
    if (!rect) continue;
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) return null;
    if (rect.bottom <= viewport.top) return entry.id;
  }
  return null;
}

// Height of the pinned bar, which overlays the top of the chat scroller.
export const PINNED_BAR_HEIGHT = 30;

// The part of the scroller the bar does not cover. It does not depend on
// whether the bar shows, so showing or hiding it cannot flip the result.
export function pinnedViewport(root: VerticalRect): VerticalRect {
  return { top: root.top + PINNED_BAR_HEIGHT, bottom: root.bottom };
}
