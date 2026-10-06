// Per-recipient webhook delta: one webhook change becomes the one wire message
// a given socket should receive. Same truth table as cronjob-delta.ts:
//   visible now               → webhook_upserted. The client upserts by id, so
//                               a recipient who just gained sight of the hook
//                               learns it through the same message.
//   was visible, is not now   → webhook_deleted (a delete, or a move out of
//                               the recipient's rooms).
//   never visible             → null. A hook id the recipient could never see
//                               never reaches them.
// An audience change (the target moved, was killed or revived, its room
// closed) has no new hook content, so a recipient whose sight did not change
// hears nothing. Its `wasVisible` is the recipient's own, taken before the
// change: closing a room also ends the recipient's access to it, so facts
// judged after the change cannot say who saw the hook before.
//
// LEAF over the visibility module and types.

import type { WebhookWire } from "../../shared/types.ts";
import {
  webhookVisibleTo,
  type WebhookViewer,
  type WebhookVisibilityFacts,
} from "../webhook-visibility.ts";

export type WebhookDelta =
  | { type: "webhook_upserted"; webhook: WebhookWire }
  | { type: "webhook_deleted"; id: string };

export type WebhookChange =
  | {
      kind: "upserted";
      webhook: WebhookWire;
      facts: WebhookVisibilityFacts;
      // Who could see it before this change; null for a new hook.
      before: WebhookVisibilityFacts | null;
    }
  | { kind: "deleted"; id: string; before: WebhookVisibilityFacts }
  | {
      kind: "audience_changed";
      webhook: WebhookWire;
      facts: WebhookVisibilityFacts;
      wasVisible: boolean;
    };

export function webhookDeltaFor(
  change: WebhookChange,
  viewer: WebhookViewer,
): WebhookDelta | null {
  if (change.kind === "deleted") {
    return webhookVisibleTo(change.before, viewer)
      ? { type: "webhook_deleted", id: change.id }
      : null;
  }
  const visible = webhookVisibleTo(change.facts, viewer);
  const wasVisible =
    change.kind === "audience_changed"
      ? change.wasVisible
      : change.before !== null && webhookVisibleTo(change.before, viewer);
  if (change.kind === "audience_changed" && visible === wasVisible) {
    return null;
  }
  if (visible) {
    return { type: "webhook_upserted", webhook: change.webhook };
  }
  return wasVisible ? { type: "webhook_deleted", id: change.webhook.id } : null;
}
