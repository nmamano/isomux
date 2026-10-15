// True while a desk is being dragged anywhere in the office. It follows
// drag-state rather than document drag events: a desk that unmounts mid-drag
// never gets its dragend, and DeskUnit clears the dragged desk on unmount.

import { useSyncExternalStore } from "react";
import { getDraggedDesk, subscribeDraggedDesk } from "./drag-state.ts";

export function useDeskDrag(): boolean {
  return useSyncExternalStore(
    subscribeDraggedDesk,
    () => getDraggedDesk() !== null,
  );
}
