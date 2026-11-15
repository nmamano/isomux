// Whether the chat folds messages between agents into one line per run (task
// d5c0f33d): the member's own preference. Absent showAgentMessages means
// folded, and so does a record that has not arrived yet.

import { useSelfUser } from "./useSelfUser.ts";

export function useHideAgentMessages(): boolean {
  return useSelfUser()?.showAgentMessages !== true;
}
