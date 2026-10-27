// Backend-neutral one-line label for background work and breadcrumbs.

export const TASK_LABEL_MAX = 200;

// Collapse to one line and cap length: task descriptions, summaries and
// commands are model- or user-authored free text, and labels must stay
// unobtrusive.
export function sanitizeTaskLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > TASK_LABEL_MAX
    ? `${oneLine.slice(0, TASK_LABEL_MAX - 1)}…`
    : oneLine;
}
