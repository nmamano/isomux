// The webhook slice: a list GET that a delta overtook cannot undo the delta.

import { describe, expect, it } from "bun:test";
import { initialState, reducer } from "./store.tsx";
import { hookWire } from "./test-support/webhook-fixture.ts";

const a = hookWire({ id: "wh_aaaaaaaaaaaaaaaa", name: "a" });
const b = hookWire({ id: "wh_bbbbbbbbbbbbbbbb", name: "b" });

describe("webhooks slice", () => {
  it("webhooks_loaded replaces the list when no delta moved the revision", () => {
    const next = reducer(initialState, {
      type: "webhooks_loaded",
      webhooks: [a, b],
      revision: initialState.webhooksRevision,
    });
    expect(next.webhooks.map((w) => w.id)).toEqual([a.id, b.id]);
    expect(next.webhooksLoaded).toBe(true);
  });

  it("a snapshot older than a delete is refused, and the slice still reads loaded", () => {
    const seeded = reducer(initialState, {
      type: "webhooks_loaded",
      webhooks: [a, b],
      revision: 0,
    });
    const asked = seeded.webhooksRevision;
    const deleted = reducer(seeded, { type: "webhook_deleted", id: a.id });
    const late = reducer(deleted, {
      type: "webhooks_loaded",
      webhooks: [a, b],
      revision: asked,
    });
    expect(late.webhooks.map((w) => w.id)).toEqual([b.id]);
    expect(late.webhooksLoaded).toBe(true);
  });

  it("a snapshot older than an edit is refused", () => {
    const asked = initialState.webhooksRevision;
    const edited = reducer(initialState, {
      type: "webhook_upserted",
      webhook: { ...a, enabled: false },
    });
    const late = reducer(edited, {
      type: "webhooks_loaded",
      webhooks: [a],
      revision: asked,
    });
    expect(late.webhooks).toHaveLength(1);
    expect(late.webhooks[0].enabled).toBe(false);
  });

  it("webhook_upserted replaces in place or appends", () => {
    const one = reducer(initialState, { type: "webhook_upserted", webhook: a });
    const two = reducer(one, { type: "webhook_upserted", webhook: b });
    const renamed = reducer(two, {
      type: "webhook_upserted",
      webhook: { ...a, name: "renamed" },
    });
    expect(renamed.webhooks.map((w) => w.name)).toEqual(["renamed", "b"]);
  });

  it("webhook_deleted of an unknown id still moves the revision", () => {
    const next = reducer(initialState, {
      type: "webhook_deleted",
      id: "wh_cccccccccccccccc",
    });
    expect(next.webhooksRevision).toBe(initialState.webhooksRevision + 1);
  });
});
