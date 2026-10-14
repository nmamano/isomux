// Automatic handoff (internal-docs/auto-handoff-design.md): the pure parts.
// When an agent's switch is on and a completed turn leaves its context at or
// above the trigger, agent-manager runs one more turn for the brief and then
// hands off to a fresh session. The state machine lives in agent-manager; this
// module holds the trigger and the words.

import type { ManagedAgent } from "./internal-types.ts";

// Nil, 2026-10-13: hand off at 500k tokens or at 90% of the window, whichever
// comes first.
export const AUTO_HANDOFF_MAX_TOKENS = 500_000;
export const AUTO_HANDOFF_MAX_PERCENT = 90;
// An engine that compacts on its own before that point would compact first and
// the handoff would never fire, so the trigger moves this many points of the
// window ahead of the engine's compaction point. The room is for the brief
// turn, which runs in the old context.
export const AUTO_HANDOFF_COMPACTION_MARGIN_PERCENT = 5;

export type AutoHandoffMeasure = "tokens" | "percent" | "compaction";

export interface AutoHandoffTrigger {
  // Arms when the sample's totalTokens is at or above this.
  tokens: number;
  // Which of the three limits set `tokens`, for the member's lines.
  measure: AutoHandoffMeasure;
  // The window the trigger was computed against.
  maxTokens: number;
}

/** The trigger for one fullness sample. `compactAtTokens` is the engine's own
 *  compaction point, absent when the engine does not compact or its point is
 *  not knowable (Codex: see backends/codex/adapter.ts getContextUsage). On a
 *  tie the earlier limit in the order tokens, percent, compaction is the one
 *  reported. */
export function autoHandoffTrigger(snap: {
  maxTokens: number;
  compactAtTokens?: number;
}): AutoHandoffTrigger {
  const { maxTokens } = snap;
  let best: AutoHandoffTrigger = {
    tokens: AUTO_HANDOFF_MAX_TOKENS,
    measure: "tokens",
    maxTokens,
  };
  // Strict comparisons keep the earlier limit on a tie.
  const percent = (maxTokens * AUTO_HANDOFF_MAX_PERCENT) / 100;
  if (percent < best.tokens)
    best = { tokens: percent, measure: "percent", maxTokens };
  if (snap.compactAtTokens !== undefined && snap.compactAtTokens > 0) {
    const guard =
      snap.compactAtTokens -
      (maxTokens * AUTO_HANDOFF_COMPACTION_MARGIN_PERCENT) / 100;
    if (guard < best.tokens)
      best = { tokens: guard, measure: "compaction", maxTokens };
  }
  return best;
}

/** The limit that fired, for the member's two lines: the trigger itself, not
 *  the measured value, so both lines name the same reason. */
export function autoHandoffMeasureParams(trigger: AutoHandoffTrigger): {
  thousands: number;
  percent: number;
} {
  return {
    thousands: Math.round(trigger.tokens / 1000),
    percent: Math.round((trigger.tokens / trigger.maxTokens) * 100),
  };
}

/** Whether an automatic attempt can still happen in this conversation. While
 *  it can, the fullness notices that tell the agent or the member to hand off
 *  stay quiet; after a failed or paused attempt they fire as before. */
export function autoHandoffPossible(managed: ManagedAgent): boolean {
  return (
    managed.info.autoHandoff === true &&
    managed.info.capabilities.autoHandoff &&
    !managed.autoHandoffSpent
  );
}

/** The brief turn's prompt. Keeps the content rules of /handoff step 1
 *  (skills/isomux-handoff/SKILL.md) and no more. */
export function autoHandoffBriefPrompt(sample: {
  totalTokens: number;
  percentage: number;
}): string {
  const tokens = sample.totalTokens.toLocaleString("en-US");
  const pct = Math.round(sample.percentage);
  return (
    `[automatic handoff: your context is at ${tokens} tokens (${pct}% full), and after this turn Isomux hands this session off to a fresh one. ` +
    `Reply with only the handoff brief. It is forward-looking: the goal, the next concrete steps, working state not obvious from disk, decisions the fresh session should not relitigate, open questions to revisit with the member, and pointers (files, docs, task IDs). ` +
    `Leave out a recap of this session and anything already in your system prompt, custom instructions or memory. Keep it tight. Do not call the handoff route.]`
  );
}

/** The fresh session's one-shot notice, sent with the brief. */
export const AUTO_HANDOFF_FRESH_NOTICE =
  "[automatic handoff: Isomux handed your previous session off to this one when its context became full. The brief below is from that session. " +
  "Before an action that depends on earlier work the brief does not cover, look that work up in your past conversations: GET /api/agent-reference/conversation-history tells you how.]";

/** The brief from the brief turn's text chunks: everything the agent wrote
 *  after its last tool call. OpenCode streams deltas, so its chunks join
 *  with nothing; the other engines send whole blocks. */
export function joinBriefChunks(
  agentType: ManagedAgent["info"]["agentType"],
  chunks: readonly string[],
): string {
  return chunks.join(agentType === "opencode" ? "" : "\n\n").trim();
}
