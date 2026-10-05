// Per-recipient cronjob delta: one cronjob change becomes the one wire message
// a given socket should receive, projected for that socket.
//
// Same truth table as task-delta.ts:
//   visible now               → cronjob_upserted-style message, projected
//                               (`cronjob_added` on a create, else
//                               `cronjob_updated`). The client upserts by id, so
//                               a recipient who just gained sight of the job
//                               learns it through the same message.
//   was visible, is not now   → cronjob_deleted (a delete, or a move out of the
//                               recipient's rooms).
//   never visible             → null. A job id the recipient could never see
//                               never reaches them.
//
// LEAF over the visibility module and types.

import type {
  Cronjob,
  CronjobLastRun,
  CronjobListWire,
} from "../../shared/types.ts";
import {
  cronjobVisibleTo,
  projectCronjob,
  type CronjobViewer,
  type CronjobVisibilityFacts,
} from "../cronjob-visibility.ts";

export type CronjobDelta =
  | { type: "cronjob_added"; cronjob: CronjobListWire }
  | { type: "cronjob_updated"; cronjob: CronjobListWire }
  | { type: "cronjob_deleted"; id: string };

export type CronjobChange =
  | { kind: "added"; cronjob: Cronjob; facts: CronjobVisibilityFacts }
  | {
      kind: "updated";
      cronjob: Cronjob;
      facts: CronjobVisibilityFacts;
      // Who could see it before this change (same as `facts` when the change
      // cannot move it).
      before: CronjobVisibilityFacts;
    }
  | { kind: "deleted"; id: string; before: CronjobVisibilityFacts };

export function cronjobDeltaFor(
  change: CronjobChange,
  viewer: CronjobViewer,
  lastRun: CronjobLastRun | null,
): CronjobDelta | null {
  if (change.kind === "deleted") {
    return cronjobVisibleTo(change.before, viewer)
      ? { type: "cronjob_deleted", id: change.id }
      : null;
  }
  const projected = projectCronjob(
    change.cronjob,
    change.facts,
    viewer,
    lastRun,
  );
  if (projected) {
    return change.kind === "added"
      ? { type: "cronjob_added", cronjob: projected }
      : { type: "cronjob_updated", cronjob: projected };
  }
  if (change.kind === "updated" && cronjobVisibleTo(change.before, viewer)) {
    return { type: "cronjob_deleted", id: change.cronjob.id };
  }
  return null;
}
