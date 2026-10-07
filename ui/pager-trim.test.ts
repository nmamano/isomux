// The pager list's bound on resolved pages, through the real reducer (task
// af346c0c, PM ruling 2026-10-07): live resolves never grow it past what the
// view loaded. The view-level cases are in ui/App.pager-slices.dom.test.tsx.

import { expect, it } from "bun:test";
import { initialState, reducer } from "./store.tsx";
import { resolvedCursor } from "./pager-sync.ts";
import type { PagerEntry } from "../shared/types.ts";

function page(id: string, patch: Partial<PagerEntry> = {}): PagerEntry {
  return {
    id,
    createdAt: 1,
    lastRaisedAt: 1,
    raiseCount: 1,
    source: { kind: "agent", agentId: "a1", name: "Scout", roomId: "r1" },
    targetUserId: "u1",
    title: id,
    state: "open",
    delivery: { state: "delivered", sends: 1 },
    ...patch,
  };
}

it("a thousand live resolves leave the list at its loaded size, oldest dropped", () => {
  let state = reducer(initialState, {
    type: "pager_loaded",
    entries: [page("open1")],
    revision: 0,
    more: false,
  });
  for (let i = 0; i < 1000; i++) {
    state = reducer(state, {
      type: "pager_upserted",
      entry: page(`live${i}`, {
        state: "resolved",
        resolved: { by: "Boss", at: 300_000 + i },
      }),
    });
  }
  const ids = state.pager.map((e) => e.id);
  expect(ids).toHaveLength(51);
  expect(ids).toContain("open1");
  expect(ids).toContain("live999");
  expect(ids).not.toContain("live949");
  expect(state.pagerResolvedMore).toBe(true);
  expect(resolvedCursor(state.pager, state.pagerPinnedId)).toBe("live950");
});

it("Load more raises the bound by one slice, and a snapshot resets it", () => {
  const resolved = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) =>
      page(`r${from + i}`, {
        state: "resolved",
        resolved: { by: "Boss", at: 1_000 - (from + i) },
      }),
    );
  let state = reducer(initialState, {
    type: "pager_loaded",
    entries: resolved(0, 50),
    revision: 0,
    more: true,
  });
  state = reducer(state, {
    type: "pager_more_loaded",
    entries: resolved(50, 100),
    more: true,
    trimSeq: state.pagerTrimSeq,
  });
  state = reducer(state, {
    type: "pager_upserted",
    entry: page("n1", {
      state: "resolved",
      resolved: { by: "Boss", at: 5_000 },
    }),
  });
  expect(state.pager).toHaveLength(100);
  expect(state.pager.map((e) => e.id)).not.toContain("r99");
  state = reducer(state, {
    type: "pager_loaded",
    entries: resolved(0, 50),
    revision: state.pagerRevision,
    more: true,
  });
  state = reducer(state, {
    type: "pager_upserted",
    entry: page("n2", {
      state: "resolved",
      resolved: { by: "Boss", at: 6_000 },
    }),
  });
  expect(state.pager).toHaveLength(50);
});

it("a slice read before a drop is refused, so the dropped page is not skipped", () => {
  const resolved = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) =>
      page(`r${from + i}`, {
        state: "resolved",
        resolved: { by: "Boss", at: 1_000 - (from + i) },
      }),
    );
  let state = reducer(initialState, {
    type: "pager_loaded",
    entries: resolved(0, 50),
    revision: 0,
    more: true,
  });
  const seq = state.pagerTrimSeq;
  // The read asked for the slice after r49; a live resolve then drops r49.
  state = reducer(state, {
    type: "pager_upserted",
    entry: page("n1", {
      state: "resolved",
      resolved: { by: "Boss", at: 5_000 },
    }),
  });
  expect(state.pager.map((e) => e.id)).not.toContain("r49");
  const refused = reducer(state, {
    type: "pager_more_loaded",
    entries: resolved(50, 60),
    more: false,
    trimSeq: seq,
  });
  expect(refused).toBe(state);
  expect(resolvedCursor(state.pager, state.pagerPinnedId)).toBe("r48");
});
