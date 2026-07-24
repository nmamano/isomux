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

// Find one turn by its anchor entry id (server generation path).
export function findDeckTurn(
  logs: readonly LogEntry[],
  entryId: string,
): DeckTurn | null {
  return buildDeckTurns(logs).find((t) => t.entryId === entryId) ?? null;
}
