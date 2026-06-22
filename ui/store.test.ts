// Unit tests for the store reducer's `log_entries_batch` action (Phase 3d slice
// 2b). This is the first transport slice that changes transcript delivery from
// per-entry `log_entry` event replay to a single fetched batch, so the merge is
// the correctness core: a fetched historical batch and the live entries that
// arrive during an active run share ONE stream (keyed by `entry.agentId =
// cronjobRunStreamId(runId)`) and ONE id-dedupe map (`logEntryIds`). The batch
// must be equivalent to replaying each entry as a `log_entry` — append unseen
// ids, skip already-seen ones — so overlapping live entries are neither dropped
// nor duplicated. (cron.getRun's REST shape + 404 are covered server-side.)

import { describe, it, expect } from "bun:test";
import { reducer, initialState } from "./store.tsx";
import type { LogEntry } from "../shared/types.ts";

function entry(id: string, agentId: string, timestamp: number): LogEntry {
  return { id, agentId, timestamp, kind: "text", content: `content-${id}` };
}

describe("reducer: log_entries_batch", () => {
  const S = "cronrun-run1";

  it("merges a historical batch into the live stream without dropping or duplicating", () => {
    // A live entry arrived first (the active-run `log_entry` compat bridge).
    const live = entry("live-1", S, 100);
    const seeded = reducer(initialState, { type: "log_entry", entry: live });

    // The fetched batch overlaps the live entry and adds two historical ones.
    const merged = reducer(seeded, {
      type: "log_entries_batch",
      entries: [
        entry("hist-1", S, 50),
        live, // same id as the live entry — must be deduped, not duplicated
        entry("hist-2", S, 75),
      ],
    });

    const stream = merged.logs.get(S) ?? [];
    // Unseen entries appended in batch order; the duplicate live id is skipped.
    expect(stream.map((e) => e.id)).toEqual(["live-1", "hist-1", "hist-2"]);
    // The live entry object is preserved by reference (not dropped/replaced).
    expect(stream.find((e) => e.id === "live-1")).toBe(live);
    // The dedupe set tracks every id now in the stream.
    const seen = merged.logEntryIds.get(S);
    expect(seen?.has("live-1")).toBe(true);
    expect(seen?.has("hist-1")).toBe(true);
    expect(seen?.has("hist-2")).toBe(true);
    expect(seen?.size).toBe(3);
  });

  it("is a no-op (returns the same state) when every entry is already seen", () => {
    const live = entry("live-1", S, 100);
    const seeded = reducer(initialState, { type: "log_entry", entry: live });
    const after = reducer(seeded, {
      type: "log_entries_batch",
      entries: [live],
    });
    // Referential equality — a duplicate-only batch must not clone state.
    expect(after).toBe(seeded);
  });

  it("returns the same state for an empty batch", () => {
    const after = reducer(initialState, {
      type: "log_entries_batch",
      entries: [],
    });
    expect(after).toBe(initialState);
  });

  it("routes entries to their own streams by agentId", () => {
    const T = "cronrun-run2";
    const merged = reducer(initialState, {
      type: "log_entries_batch",
      entries: [entry("a", S, 1), entry("b", T, 2), entry("c", S, 3)],
    });
    expect((merged.logs.get(S) ?? []).map((e) => e.id)).toEqual(["a", "c"]);
    expect((merged.logs.get(T) ?? []).map((e) => e.id)).toEqual(["b"]);
  });
});
