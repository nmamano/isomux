// Slide Mode turn splitting (design: internal-docs/slide-mode-design.md).
//
// A deck has one position per assistant turn, 1:1 with the conversation. A turn
// is anchored by the `user_message` LogEntry that started it and runs until the
// next `user_message`. This is the SINGLE source of that mapping, shared by:
//   - the server (server/slide-mode.ts) to build the content it formats, and
//   - the client (ui/log-view/DeckView.tsx) to lay out the deck positions.
// Sharing it keeps the two exactly in step — the anchor entry id the client
// requests is the same one the server keys the stored slide on.

import type { LogEntry } from "./types.ts";

export interface DeckTurn {
  // The `user_message` entry id that started the turn — the stable slide key.
  entryId: string;
  // The prompt that started the turn (frozen beneath the slide).
  promptText: string;
  // All assistant text spans in the turn, concatenated (no tool calls/results;
  // those never carry the answer's prose). Empty for a tool-only / interrupted
  // turn.
  assistantText: string;
  // The turn's error text, if it failed. Null otherwise.
  errorText: string | null;
  // True when the turn produced no assistant text (interrupted, failed, or
  // tool-only) — it still gets a placeholder position so the deck stays 1:1.
  placeholder: boolean;
}

// Split an ordered log into deck turns. Entries before the first user_message
// (a system_init banner, say) belong to no turn and are dropped — they are not
// assistant turns. Ephemeral UI markers ("Conversation cleared.") never count.
// The caller passes the log in display order (the client sorts by timestamp
// first; the server's cache is already append-ordered).
export function buildDeckTurns(logs: readonly LogEntry[]): DeckTurn[] {
  const turns: DeckTurn[] = [];
  let cur: {
    entryId: string;
    promptText: string;
    texts: string[];
    errorText: string | null;
  } | null = null;

  const finalize = (c: NonNullable<typeof cur>): DeckTurn => {
    const assistantText = c.texts.join("\n\n").trim();
    return {
      entryId: c.entryId,
      promptText: c.promptText,
      assistantText,
      errorText: c.errorText,
      placeholder: assistantText.length === 0,
    };
  };

  for (const e of logs) {
    if (e.ephemeral) continue;
    if (e.kind === "user_message") {
      if (cur) turns.push(finalize(cur));
      cur = {
        entryId: e.id,
        promptText: e.content,
        texts: [],
        errorText: null,
      };
      continue;
    }
    if (!cur) continue; // pre-first-turn noise (no anchor)
    if (e.kind === "text") {
      if (e.content) cur.texts.push(e.content);
    } else if (e.kind === "error") {
      cur.errorText = cur.errorText
        ? `${cur.errorText}\n${e.content}`
        : e.content;
    }
    // tool_call / tool_result / diff / file-view / etc. carry no slide prose.
  }
  if (cur) turns.push(finalize(cur));
  return turns;
}

// Deck navigation: given the viewer's current position, the deck length BEFORE
// a change, and the length AFTER, return the position to show. Clamps into range
// and follows the newest slide only when the viewer was on the last slide of the
// deck as it was BEFORE it grew. Comparing against `prevLen` (not the already-
// grown `newLen`) is the crux: a new turn arriving while the deck is open bumps
// the length in the same render the index still points at the old last slide, so
// testing at-end against `newLen` would read false for the very growth being
// reacted to and silently drop the follow.
export function nextDeckIndex(
  cur: number,
  prevLen: number,
  newLen: number,
): number {
  const last = Math.max(0, newLen - 1);
  if (cur > last) return last; // deck shrank past the cursor → clamp
  if (cur >= prevLen - 1) return last; // was on the last slide → follow newest
  return cur;
}

// The SETTLED deck position after a length change: the index to show (via
// nextDeckIndex) paired with whether that index is now the last slide.
// Persisting THIS — rather than the pre-advance render's stale index/atEnd — is
// what keeps "follow newest" correct across the chat<->deck toggle. Note it
// captures the case a plain index-change save misses: a shrink (edit/fork,
// /clear) that leaves the cursor numerically unchanged but makes it the new last
// slide, so atEnd flips false→true without index moving.
export function settledDeckPos(
  cur: number,
  prevLen: number,
  newLen: number,
): { index: number; atEnd: boolean } {
  const index = nextDeckIndex(cur, prevLen, newLen);
  return { index, atEnd: index >= newLen - 1 };
}

// The position to show on FIRST opening a deck, given the saved position (or
// null) and the current deck length. Restores the saved slide when the viewer
// had deliberately left NOT on the last slide (clamped into range); otherwise —
// no saved position, or they were following the newest — lands on the newest.
// Returns the settled {index, atEnd} so first-load can persist it DIRECTLY: a
// saved "behind" index that clamps onto the (now shorter) last slide, or that
// equals 0 and can't trigger a state-change save, must still be recorded as
// atEnd — otherwise re-entry wrongly treats the viewer as intentionally behind.
export function restoredDeckPos(
  saved: { index: number; atEnd: boolean } | null,
  len: number,
): { index: number; atEnd: boolean } {
  const last = Math.max(0, len - 1);
  const index =
    saved && !saved.atEnd ? Math.min(Math.max(0, saved.index), last) : last;
  return { index, atEnd: index >= len - 1 };
}

// Find one turn by its anchor entry id (server generation path).
export function findDeckTurn(
  logs: readonly LogEntry[],
  entryId: string,
): DeckTurn | null {
  return buildDeckTurns(logs).find((t) => t.entryId === entryId) ?? null;
}
