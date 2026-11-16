// Automatic handoff (internal-docs/auto-handoff-design.md): the pure parts.
// When an agent's switch is on and a completed turn leaves its context at or
// above the trigger, agent-manager runs one more turn for the brief and then
// hands off to a fresh session. The state machine lives in agent-manager; this
// module holds the trigger and the words.

import { defuseFileMentions } from "../shared/identity.ts";
import { AUTO_HANDOFF_DEFAULT_TOKENS } from "../shared/auto-handoff.ts";
import type { ManagedAgent, SettingHandoffRequest } from "./internal-types.ts";

// Nil, 2026-10-13 and 2026-10-14: hand off at the agent's token value (500k
// by default) or at 85% of the window, whichever comes first.
export const AUTO_HANDOFF_MAX_PERCENT = 85;
// An engine that compacts on its own before that point would compact first and
// the handoff would never fire, so the trigger sits a margin ahead of the
// engine's compaction point: 5 points of the window or 40k tokens, whichever
// is larger, and at most half the compaction point, so the trigger stays above
// zero. The margin holds the turn that crosses the trigger (it always
// finishes) and then the brief turn, both in the old context. One turn in 50
// adds about 40k tokens, so 5 points alone (10k on a 200k window) let the
// engine compact first on small windows.
export const AUTO_HANDOFF_COMPACTION_MARGIN_PERCENT = 5;
export const AUTO_HANDOFF_COMPACTION_MARGIN_TOKENS = 40_000;

// A brief turn that fails retries after the next completed turn. From this
// many failures in a row, temporary ones not counted, each failure makes the
// mode wait AUTO_HANDOFF_BACKOFF_TURNS completed turns before it arms again,
// so a brief that always fails costs one brief turn per that many replies.
export const AUTO_HANDOFF_BACKOFF_FAILURES = 3;
export const AUTO_HANDOFF_BACKOFF_TURNS = 10;

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
 *  reported. `tokens` is the agent's own value (AgentInfo.autoHandoffTokens). */
export function autoHandoffTrigger(
  snap: {
    maxTokens: number;
    compactAtTokens?: number;
  },
  tokens: number = AUTO_HANDOFF_DEFAULT_TOKENS,
): AutoHandoffTrigger {
  const { maxTokens } = snap;
  let best: AutoHandoffTrigger = {
    tokens,
    measure: "tokens",
    maxTokens,
  };
  // Strict comparisons keep the earlier limit on a tie.
  const percent = (maxTokens * AUTO_HANDOFF_MAX_PERCENT) / 100;
  if (percent < best.tokens)
    best = { tokens: percent, measure: "percent", maxTokens };
  if (snap.compactAtTokens !== undefined && snap.compactAtTokens > 0) {
    const margin = Math.min(
      Math.max(
        (maxTokens * AUTO_HANDOFF_COMPACTION_MARGIN_PERCENT) / 100,
        AUTO_HANDOFF_COMPACTION_MARGIN_TOKENS,
      ),
      snap.compactAtTokens / 2,
    );
    const guard = snap.compactAtTokens - margin;
    if (guard < best.tokens)
      best = { tokens: guard, measure: "compaction", maxTokens };
  }
  return best;
}

/** The agent's own token value, or the default. */
export function autoHandoffTokensOf(info: {
  autoHandoffTokens?: number;
}): number {
  return info.autoHandoffTokens ?? AUTO_HANDOFF_DEFAULT_TOKENS;
}

/** The token value for agents.json and the agent history: written only off
 *  the default, so a default value reads as absent. */
export function persistedAutoHandoffTokens(value: number | undefined): {
  autoHandoffTokens?: number;
} {
  return value !== undefined && value !== AUTO_HANDOFF_DEFAULT_TOKENS
    ? { autoHandoffTokens: value }
    : {};
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

/** Whether the mode can still arm in this conversation: the switch is on and
 *  the loop guard has not paused it. A back-off wait does not stop it. */
export function autoHandoffCanArm(managed: ManagedAgent): boolean {
  return (
    managed.info.autoHandoff !== false &&
    managed.info.capabilities.autoHandoff &&
    !managed.autoHandoffPaused
  );
}

/** Whether the automatic handoff stands in for the fullness notices that tell
 *  the agent or the member to hand off. It does while it can arm and has not
 *  backed off; from the back-off on, and after a pause, they fire as before. */
export function autoHandoffPossible(managed: ManagedAgent): boolean {
  return (
    autoHandoffCanArm(managed) &&
    managed.autoHandoffFailures < AUTO_HANDOFF_BACKOFF_FAILURES
  );
}

// What a brief holds, for both brief prompts (automatic and /handoff).
const BRIEF_RULES =
  `Reply with only the handoff brief. It is forward-looking: the goal, the next concrete steps, working state not obvious from disk, decisions the fresh session should not relitigate, open questions to revisit with the member, and pointers (files, docs, task IDs). ` +
  `Leave out a recap of this session and anything already in your system prompt, custom instructions or memory. Keep it tight. Do not call the handoff route.`;

/** The automatic brief turn's prompt. */
export function autoHandoffBriefPrompt(sample: {
  totalTokens: number;
  percentage: number;
}): string {
  const tokens = sample.totalTokens.toLocaleString("en-US");
  const pct = Math.round(sample.percentage);
  return `[automatic handoff: your context is at ${tokens} tokens (${pct}% full), and after this turn Isomux hands this session off to a fresh one. ${BRIEF_RULES}]`;
}

/** The brief turn's prompt for a member's /handoff. `note` is the text the
 *  member typed after the command. */
export function handoffBriefPrompt(note?: string): string {
  const prompt = `[handoff: the member asked for a handoff, and after this turn Isomux hands this session off to a fresh one. ${BRIEF_RULES}]`;
  return note ? `${prompt}\n\nMember's note: ${note}` : prompt;
}

const ENGINE_NAMES = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
} as const;

/** What changed, in the words the setting handoff's prompt and notices use. */
function settingChangeText(request: SettingHandoffRequest): string {
  const by = request.changedBy ? `${request.changedBy} ` : "";
  const c = request.change;
  switch (c.kind) {
    case "engine":
      return `${by || "a member "}moved you from ${ENGINE_NAMES[c.from]} to ${ENGINE_NAMES[c.to]}`;
    case "manager":
      return `${by || "a member "}made ${c.to} your manager${c.from ? ` in place of ${c.from}` : ""}`;
    case "folder":
      return `${by || "a member "}moved your working folder from ${c.from} to ${c.to}`;
  }
}

// A new manager's word wins over what the previous manager allowed: the
// brief marks it, and the fresh conversation asks before it acts on it.
function managerTrustRule(
  request: SettingHandoffRequest,
  which: "brief" | "notice",
): string {
  const c = request.change;
  if (c.kind !== "manager") return "";
  const previous = c.from ?? "the previous manager";
  return which === "brief"
    ? ` Mark in the brief what ${previous} asked for or allowed: ${c.to} is your manager now.`
    : ` ${c.to} is your manager now, and their word wins. Before you act on a go-ahead from ${previous}, get ${c.to}'s confirmation.`;
}

// The change cut a running turn of the previous conversation: its last
// request may be unfinished. The same first sentence for every kind of
// change; the brief adds what to do with it.
function cutTurnText(
  request: SettingHandoffRequest,
  which: "brief" | "notice",
): string {
  if (!request.cutTurn) return "";
  const cut =
    " The change stopped a turn in progress, so the last request in the previous conversation may be unfinished.";
  return which === "brief"
    ? `${cut} Carry it as open work unless the conversation shows it done.`
    : cut;
}

/** The brief turn's prompt after a setting change that started a new
 *  conversation (a setting handoff). It runs in that new conversation, on the
 *  new settings, and reads the previous one from the logs of `agentId`. */
export function settingHandoffBriefPrompt(
  request: SettingHandoffRequest,
  agentId: string,
): string {
  const logs = `/api/agents/${agentId}/logs?session=${request.previousSessionId}`;
  // It quotes names and folder paths that no member typed here.
  return defuseFileMentions(
    `[settings handoff: ${settingChangeText(request)}, so Isomux started this new conversation. ` +
      `Your previous conversation is session ${request.previousSessionId}, and after this turn Isomux hands off to a fresh session with your reply as its brief. ` +
      `Read what you need from the previous conversation, not all of it: the member messages, where standing rules and go-aheads are (GET ${logs}&tier=prompts), ` +
      `then its summary and its last entries, where the open work is (GET ${logs}&tier=conversation&limit=60). ` +
      `GET /api/agent-reference/conversation-history has the details.${cutTurnText(request, "brief")}${managerTrustRule(request, "brief")} ` +
      `Reply with only the handoff brief. It is forward-looking: the goal, the next concrete steps, the standing rules the members gave, working state not obvious from disk, decisions the fresh session should not relitigate, open questions to revisit with the member, and pointers (files, docs, task IDs). ` +
      `Leave out a recap of the previous conversation and anything already in your system prompt, custom instructions or memory. Keep it tight. Do not call the handoff route.]`,
  );
}

/** The one-shot notice of the conversation a setting handoff opened, sent
 *  with the brief. */
export function settingHandoffFreshNotice(
  request: SettingHandoffRequest,
): string {
  return (
    `[settings handoff: ${settingChangeText(request)}, so Isomux started a new conversation. ` +
    `The brief below was written from your previous conversation, session ${request.previousSessionId}. ` +
    `Before an action that depends on earlier work the brief does not cover, look that work up: GET /api/agent-reference/conversation-history tells you how.${managerTrustRule(request, "notice")}]`
  );
}

/** The one-shot notice when a setting handoff wrote no brief: sent with the
 *  next prompt of the conversation the change opened, it names the previous
 *  conversation. */
export function settingHandoffPointerNotice(
  request: SettingHandoffRequest,
): string {
  return (
    `[settings handoff: ${settingChangeText(request)}, so Isomux started a new conversation, and no handoff brief was written. ` +
    `Your previous conversation is session ${request.previousSessionId}.${cutTurnText(request, "notice")} Before you continue, read its member messages for standing rules and its last entries for open work: GET /api/agent-reference/conversation-history tells you how.${managerTrustRule(request, "notice")}]`
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
