import type { LogEntry } from "../../shared/types.ts";
import { describeMessageSender } from "./LogEntryCard.tsx";

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
    if (
      entry.kind !== "user_message" ||
      !describeMessageSender(entry.metadata).fromHuman
    )
      continue;
    const rect = rectForId(entry.id);
    if (!rect) continue;
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) return null;
    if (rect.bottom <= viewport.top) return entry.id;
  }
  return null;
}
