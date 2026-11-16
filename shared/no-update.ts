// The reply an agent gives when a turn leaves nothing a member needs to know
// (task 51c187f4). The system prompt names it, and the chat folds a reply that
// is only this keyword into the folded line instead of showing a card.

import type { LogEntry } from "./types.ts";

export const NO_UPDATE = "NO_UPDATE";

// What the system prompt asked for before the keyword (task f416a938).
const LEGACY_REPLY = "(nothing to bring to the members' attention)";

/**
 * True for a "text" entry whose whole content is the keyword, or the phrase
 * agents used before it, "_(nothing to bring to the members' attention)_".
 * Wrapping emphasis or code marks, an escaped underscore and one trailing
 * period are ignored. Any other words in the entry make it false.
 */
export function isNoUpdateReply(
  entry: Pick<LogEntry, "kind" | "content">,
): boolean {
  if (entry.kind !== "text") return false;
  let reply = entry.content.trim();
  if (reply.endsWith(".")) reply = reply.slice(0, -1);
  // One pair of wrapping marks: *, **, _, __ or a backtick.
  const wrapped = /^(\*\*|__|[*_`])(.*)\1$/s.exec(reply);
  if (wrapped) reply = wrapped[2];
  reply = reply.replaceAll("\\_", "_").replaceAll("\u2019", "'");
  return reply === NO_UPDATE || reply === LEGACY_REPLY;
}
