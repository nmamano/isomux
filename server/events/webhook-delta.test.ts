import { describe, expect, it } from "bun:test";
import { webhookDeltaFor } from "./webhook-delta.ts";
import type {
  WebhookViewer,
  WebhookVisibilityFacts,
} from "../webhook-visibility.ts";
import type { WebhookWire } from "../../shared/types.ts";

const ROOM_A = "a1a1a1a1";
const ROOM_B = "b2b2b2b2";
const HOOK = { id: "wh_0000000000000001" } as WebhookWire;

const inA: WebhookVisibilityFacts = {
  ownerUserId: "u-owner",
  liveRoomId: ROOM_A,
};
const inB: WebhookVisibilityFacts = {
  ownerUserId: "u-owner",
  liveRoomId: ROOM_B,
};

const memberOf = (roomId: string): WebhookViewer => ({
  userId: `u-${roomId}`,
  participates: true,
  officeWide: false,
  hasRoomAccess: (id) => id === roomId,
});

describe("webhookDeltaFor", () => {
  it("a create reaches the room and not the outsider", () => {
    const change = {
      kind: "upserted",
      webhook: HOOK,
      facts: inA,
      before: null,
    } as const;
    expect(webhookDeltaFor(change, memberOf(ROOM_A))).toEqual({
      type: "webhook_upserted",
      webhook: HOOK,
    });
    expect(webhookDeltaFor(change, memberOf(ROOM_B))).toBeNull();
  });

  it("a target edit that moves the hook tells the old room it is gone and the new room it exists", () => {
    const change = {
      kind: "upserted",
      webhook: HOOK,
      facts: inB,
      before: inA,
    } as const;
    expect(webhookDeltaFor(change, memberOf(ROOM_A))).toEqual({
      type: "webhook_deleted",
      id: HOOK.id,
    });
    expect(webhookDeltaFor(change, memberOf(ROOM_B))).toEqual({
      type: "webhook_upserted",
      webhook: HOOK,
    });
    expect(webhookDeltaFor(change, memberOf("c3c3c3c3"))).toBeNull();
  });

  it("a delete reaches only those who could see the hook", () => {
    const change = { kind: "deleted", id: HOOK.id, before: inA } as const;
    expect(webhookDeltaFor(change, memberOf(ROOM_A))).toEqual({
      type: "webhook_deleted",
      id: HOOK.id,
    });
    expect(webhookDeltaFor(change, memberOf(ROOM_B))).toBeNull();
  });

  it("an audience change speaks only to a recipient whose sight changed", () => {
    const change = (wasVisible: boolean) =>
      ({
        kind: "audience_changed",
        webhook: HOOK,
        facts: inA,
        wasVisible,
      }) as const;
    expect(webhookDeltaFor(change(true), memberOf(ROOM_A))).toBeNull();
    expect(webhookDeltaFor(change(false), memberOf(ROOM_A))).toEqual({
      type: "webhook_upserted",
      webhook: HOOK,
    });
    expect(webhookDeltaFor(change(true), memberOf(ROOM_B))).toEqual({
      type: "webhook_deleted",
      id: HOOK.id,
    });
    expect(webhookDeltaFor(change(false), memberOf(ROOM_B))).toBeNull();
  });
});
