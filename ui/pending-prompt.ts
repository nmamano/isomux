// Display labels for AgentInfo.pendingPrompt.
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
import type { MessageKey } from "../shared/i18n/translate.ts";

// Nameplate badge: sits next to the agent name on the office floor, where there
// is room for one word. A KEY, not a word, for the same reason as the header
// label below: DeskUnit renders it through the catalog.
export const PENDING_PROMPT_BADGE: Record<
  PendingPromptKind,
  Extract<MessageKey, `office.pendingPrompt.${string}`>
> = {
  permission: "office.pendingPrompt.permission",
  resume: "office.pendingPrompt.resume",
  model: "office.pendingPrompt.model",
  effort: "office.pendingPrompt.effort",
};

// Header label: the full sentence, shown where the activity indicator would be
// if the agent were running a turn. A KEY, not a word: LogView renders it
// through the catalog, and a table of finished text would freeze the language
// it was built in.
export const PENDING_PROMPT_LABEL: Record<
  PendingPromptKind,
  Extract<MessageKey, `logView.pendingPrompt.${string}`>
> = {
  permission: "logView.pendingPrompt.permission",
  resume: "logView.pendingPrompt.resume",
  model: "logView.pendingPrompt.model",
  effort: "logView.pendingPrompt.effort",
};
