// The board's priority scale in the UI, shared by the task board and the
// Inbox's asks (an ask carries the same P0-P4), so a level sorts and looks
// the same on both.

import type { TaskPriority } from "../shared/types.ts";

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  P0: "var(--red-text)",
  P1: "var(--orange-text)",
  P2: "var(--accent-text)",
  P3: "var(--text-muted)",
  // P4 is the old backlog, and keeps its color.
  P4: "var(--purple-text)",
};

/** Higher priority first; no priority after every level. */
export function comparePriority(
  a: TaskPriority | undefined,
  b: TaskPriority | undefined,
): number {
  return (
    (a ? PRIORITY_ORDER[a] : Number.MAX_SAFE_INTEGER) -
    (b ? PRIORITY_ORDER[b] : Number.MAX_SAFE_INTEGER)
  );
}
