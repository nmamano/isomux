// Append a block to the end of a composer draft, separated from any existing
// text by a blank line so the two never run together. Never replaces text.
export function appendBlockToDraft(current: string, block: string): string {
  if (current === "") return block;
  const sep = current.endsWith("\n\n")
    ? ""
    : current.endsWith("\n")
      ? "\n"
      : "\n\n";
  return current + sep + block;
}
