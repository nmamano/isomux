// Display labels for AgentInfo.pendingPrompt (task 29daebe2).
//
// A parked agent sits at state `waiting_for_response`, which has no STATE_LABELS
// entry, so nothing rendered at all - the desk and the log-view header looked
// identical to an agent that had simply finished its turn, or to one whose
// backend had died. These labels are what makes the wait visible.
//
// GENERIC BY DESIGN. They name the KIND of answer wanted and nothing else: the
// prompt text, the tool name and the command stay out of them, matching the
// wire field, which carries only the kind.

import type { PendingPromptKind } from "../shared/types.ts";

// Nameplate badge: sits next to the agent name on the office floor, where there
// is room for one word.
export const PENDING_PROMPT_BADGE: Record<PendingPromptKind, string> = {
  permission: "permission",
  resume: "session",
  model: "model",
  effort: "effort",
};

// Header label: the full sentence, shown where the activity indicator would be
// if the agent were running a turn.
export const PENDING_PROMPT_LABEL: Record<PendingPromptKind, string> = {
  permission: "Waiting for permission",
  resume: "Waiting for a session pick",
  model: "Waiting for a model pick",
  effort: "Waiting for an effort pick",
};
