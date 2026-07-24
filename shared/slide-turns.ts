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

// Digest fingerprinting EVERY input a slide is generated from — the frozen
// prompt, the answer text, and any error. Two turns with identical content hash
// equal; a placeholder (empty text) and the eventual answer differ, which is the
// signal Slide Mode reconciles on: a stored slide is valid only while its digest
// matches the live turn's. Fields are length-prefixed so no field boundary is
// ambiguous (a delimiter inside a field can't forge a different framing).
// FNV-1a/32 — not cryptographic, just a stable content fingerprint.
export function slideContentDigest(turn: {
  promptText: string;
  assistantText: string;
  errorText: string | null;
}): string {
  const fields = [turn.promptText, turn.assistantText, turn.errorText ?? ""];
  const s = fields.map((f) => `${f.length}:${f}`).join(" ");
  // Two FNV-1a lanes with distinct seeds/primes -> a 64-bit digest (16 hex).
  // Wider than one 32-bit lane so the operational collision risk for a content
  // change is negligible (~2^-64); a fixed-width hash always has collisions in
  // principle, this just makes them vanishingly unlikely in practice.
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca77);
  }
  const hex = (h: number) => (h >>> 0).toString(16).padStart(8, "0");
  return hex(h1) + hex(h2);
}

// Is a turn TERMINAL (settled), so its slide may be generated? A turn is
// in-flight only while it is the anchor of the currently-running turn; every
// other turn — including the whole transcript after a restart, when there is no
// running turn at all — is terminal. `runningAnchorId` is the in-flight turn's
// anchor entry id, or null when nothing is running (which is exactly the state a
// fresh boot restores: pendingTurn=null, so a persisted partial tail reads
// terminal and its slide reflects the persisted transcript). This is the whole
// boot terminal boundary, isolated so it's provable without standing up a
// manager: no running turn => every turn terminal.
export function turnIsTerminal(
  runningAnchorId: string | null | undefined,
  entryId: string,
): boolean {
  return runningAnchorId !== entryId;
}

// Slide Mode client request gating (pure, so the deck's request lifecycle is
// testable without a browser). Skip a turn whose cached slide is VERIFIED — it
// carries a content digest, so it was written by the terminal gate for content
// that is immutable within the conversation. Otherwise request it (a miss, or a
// digestless legacy record that must be reconciled) unless a request is already
// in flight. `inFlight` is the client's in-flight marker, which is cleared on
// every terminal outcome (ready / unavailable / slide_ready / fetch reject) so a
// turn CAN be re-requested later; while a request is pending it dedupes.
export function shouldRequestSlide(
  cached: { contentDigest?: string } | undefined,
  inFlight: boolean,
): boolean {
  if (cached && cached.contentDigest !== undefined) return false;
  return !inFlight;
}

// Find one turn by its anchor entry id (server generation path).
export function findDeckTurn(
  logs: readonly LogEntry[],
  entryId: string,
): DeckTurn | null {
  return buildDeckTurns(logs).find((t) => t.entryId === entryId) ?? null;
}
