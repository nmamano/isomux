// Whether the chat folds tool calls into "N steps" lines (task e7579473): the
// member's own preference, which follows them to every device. Absent
// showToolCalls means hidden, and so does a record that has not arrived yet,
// so a page load never flashes the tool cards before it folds them.

import { useSelfUser } from "./useSelfUser.ts";

export function useHideToolCalls(): boolean {
  return useSelfUser()?.showToolCalls !== true;
}
