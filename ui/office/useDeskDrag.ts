// True while a desk or a back figure is being dragged anywhere in the office.
// It follows drag-state rather than document drag events: a desk or figure
// that unmounts mid-drag never gets its dragend, so it clears drag-state on
// unmount.

import { useSyncExternalStore } from "react";
import { getDraggedDesk, subscribeDraggedDesk } from "./drag-state.ts";

export function useDeskDrag(): boolean {
  return useDraggedDesk() !== null;
}

// The dragged desk itself, for a target that depends on where the drag
// started (a front desk or a back seat).
export function useDraggedDesk(): number | null {
  // The third argument serves renderToString (no drag on the server).
  return useSyncExternalStore(subscribeDraggedDesk, getDraggedDesk, () => null);
}
