// Authoritative context-window sizes per exact model id (task c6085ddf).
//
// Why isomux keeps its own table instead of trusting the backend: the pinned
// Claude Agent SDK reports the window from its own build-time model list, so a
// model released after the pin isn't recognized and the SDK falls back to a
// default of 200k. Every reading then measures against the wrong denominator --
// percentages over 100%, a CTX battery drained to red on a healthy session, and
// wrap-up notices firing at a fifth of the real capacity. The model ids the
// SDK doesn't know are exactly the ones we point families at first, so the
// backend is the wrong source of truth for this number.
//
// Source: https://platform.claude.com/docs/en/about-claude/models/overview
// (the "Context window" row; older models live in the Legacy accordion),
// checked 2026-07-24. Only add ids verified against that page.
//
// An id that isn't listed here keeps whatever the backend reported, so an
// unknown future model degrades to today's behavior instead of a wrong number.
// Codex models never match: their usage is labeled with a display name
// ("GPT-5.6 Sol"), and their window comes live from the Codex app-server.
const MILLION = 1_000_000;

// Partial, so a lookup types as `number | undefined` and the unknown-model
// branch below is a real check rather than one the compiler thinks is dead
// (this repo doesn't set noUncheckedIndexedAccess).
export const MODEL_CONTEXT_WINDOW: Readonly<Partial<Record<string, number>>> = {
  "claude-fable-5": MILLION,
  "claude-opus-5": MILLION,
  "claude-sonnet-5": MILLION,
  "claude-opus-4-8": MILLION,
  "claude-opus-4-7": MILLION,
  "claude-opus-4-6": MILLION,
  "claude-sonnet-4-6": MILLION,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
};

/** Replace a backend-reported window with the authoritative one when we know
 *  the model, and recompute the percentage against it -- the reported
 *  percentage was derived from the stale maximum, so keeping it would leave the
 *  reading internally inconsistent. Unknown models pass through untouched
 *  (same object, so callers can compare by identity). Structural generic: the
 *  correction only needs these four fields, and every other field of the
 *  caller's shape (categories, autoCompactThreshold, ...) is preserved. */
export function correctContextWindow<
  T extends {
    model: string;
    totalTokens: number;
    maxTokens: number;
    percentage: number;
  },
>(usage: T): T {
  const known = MODEL_CONTEXT_WINDOW[usage.model];
  if (known === undefined || known === usage.maxTokens) return usage;
  return {
    ...usage,
    maxTokens: known,
    percentage: (usage.totalTokens / known) * 100,
  };
}
