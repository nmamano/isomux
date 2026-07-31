// Unit tests for the store reducer's `log_entries_batch` action (Phase 3d slice
// 2b). This is the first transport slice that changes transcript delivery from
// per-entry `log_entry` event replay to a single fetched batch, so the merge is
// the correctness core: a fetched historical batch and the live entries that
// arrive during an active run share ONE stream (keyed by `entry.agentId =
// cronjobRunStreamId(runId)`) and ONE id-dedupe map (`logEntryIds`). The batch
// must be equivalent to replaying each entry as a `log_entry` - append unseen
// ids, skip already-seen ones - so overlapping live entries are neither dropped
// nor duplicated. (cron.getRun's REST shape + 404 are covered server-side.)

import { describe, it, expect } from "bun:test";
import { reducer, initialState } from "./store.tsx";
import type { LogEntry, SlideRecord, TaskItem } from "../shared/types.ts";

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
        live, // same id as the live entry - must be deduped, not duplicated
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
    // Referential equality - a duplicate-only batch must not clone state.
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

describe("reducer: clear_logs", () => {
  it("clears the agent's unread (needsAttention) dot along with its logs", () => {
    // The dot is per-client state; the server-broadcast clear_logs (fired by
    // new-conversation and every other conversation boundary) is what makes
    // ALL clients drop it - task 8d763325. Seed dots for two agents; the
    // cleared one loses its dot, the other keeps it.
    const seeded = {
      ...reducer(initialState, {
        type: "log_entry",
        entry: entry("e1", "agent-1", 100),
      }),
      needsAttention: new Set(["agent-1", "agent-2"]),
    };
    const after = reducer(seeded, { type: "clear_logs", agentId: "agent-1" });
    expect(after.logs.get("agent-1")).toEqual([]);
    expect(after.needsAttention.has("agent-1")).toBe(false);
    expect(after.needsAttention.has("agent-2")).toBe(true);
  });

  it("keeps the dot on a rollback clear (failed edit-fork restores the prior timeline)", () => {
    const seeded = {
      ...reducer(initialState, {
        type: "log_entry",
        entry: entry("e1", "agent-1", 100),
      }),
      needsAttention: new Set(["agent-1"]),
    };
    const after = reducer(seeded, {
      type: "clear_logs",
      agentId: "agent-1",
      rollback: true,
    });
    // Logs still clear (the server replays the restored entries right after)…
    expect(after.logs.get("agent-1")).toEqual([]);
    // …but the unseen-result dot survives: nothing was semantically retired.
    expect(after.needsAttention.has("agent-1")).toBe(true);
  });
});

describe("reducer: slide_invalidate (compare-and-delete)", () => {
  const A = "agent-1";
  const rec = (html: string): SlideRecord => ({
    html,
    placeholder: false,
    errorText: null,
    promptText: "q",
    model: "sonnet",
    createdAt: 1,
    contentDigest: "abcd",
  });

  it("deletes the record when it is STILL the one seen at request time", () => {
    const old = rec("<div>old</div>");
    const seeded = reducer(initialState, {
      type: "slide_ready",
      agentId: A,
      sessionId: "",
      entryId: "u1",
      slide: old,
    });
    const after = reducer(seeded, {
      type: "slide_invalidate",
      agentId: A,
      entryId: "u1",
      prevSlide: old,
    });
    expect(after.slides.get(A)?.has("u1")).toBe(false);
  });

  it("KEEPS a fresher record a slide_ready installed before the invalidate landed", () => {
    // The WS-before-HTTP ordering race: a slide_ready replaced the stale record
    // before the (stale) pending-response invalidate arrives. Compare-and-delete
    // by reference must not clobber the newer slide.
    const old = rec("<div>old</div>");
    const fresh = rec("<div>fresh</div>");
    let s = reducer(initialState, {
      type: "slide_ready",
      agentId: A,
      sessionId: "",
      entryId: "u1",
      slide: old,
    });
    s = reducer(s, {
      type: "slide_ready",
      agentId: A,
      sessionId: "",
      entryId: "u1",
      slide: fresh,
    });
    const after = reducer(s, {
      type: "slide_invalidate",
      agentId: A,
      entryId: "u1",
      prevSlide: old,
    });
    expect(after.slides.get(A)?.get("u1")).toBe(fresh); // fresh survives
  });
});

// The failure set is what the deck renders its raw-answer fallback from, so what
// puts an entry in and what takes it out is the whole contract (task 01a7327a).
describe("reducer: slide failure marks", () => {
  const A = "agent-1";
  const rec = (html: string): SlideRecord => ({
    html,
    placeholder: false,
    errorText: null,
    promptText: "q",
    model: "sonnet",
    createdAt: 1,
    contentDigest: "abcd",
  });
  // A stale record being reconciled - the invalidate path deletes these.
  const placeholderRec: SlideRecord = {
    html: null,
    placeholder: true,
    errorText: null,
    promptText: "q",
    model: "sonnet",
    createdAt: 1,
  };
  const fail = (state = initialState, entryId = "u1") =>
    reducer(state, {
      type: "slide_failed",
      agentId: A,
      sessionId: "",
      entryId,
      reason: "generation_failed",
    });

  it("records a reported failure per agent + turn", () => {
    const after = fail();
    expect(after.slideFailed.get(A)?.has("u1")).toBe(true);
    expect(after.slideFailed.get("agent-2")).toBeUndefined();
  });

  it("clears the mark when a slide finally lands for that turn", () => {
    const after = reducer(fail(), {
      type: "slide_ready",
      agentId: A,
      sessionId: "",
      entryId: "u1",
      slide: rec("<div>ok</div>"),
    });
    expect(after.slideFailed.get(A)?.has("u1")).toBe(false);
    expect(after.slides.get(A)?.get("u1")?.html).toBe("<div>ok</div>");
  });

  it("leaves OTHER turns' marks alone when one slide lands", () => {
    const after = reducer(fail(fail(), "u2"), {
      type: "slide_ready",
      agentId: A,
      sessionId: "",
      entryId: "u1",
      slide: rec("<div>ok</div>"),
    });
    expect(after.slideFailed.get(A)?.has("u2")).toBe(true);
  });

  it("IGNORES a failure for a turn that already has a RENDERED slide", () => {
    // A regenerate that failed: the standing slide beats the raw answer.
    const seeded = reducer(initialState, {
      type: "slide_ready",
      agentId: A,
      sessionId: "",
      entryId: "u1",
      slide: rec("<div>standing</div>"),
    });
    const after = fail(seeded);
    expect(after).toBe(seeded);
    expect(after.slideFailed.get(A)?.has("u1")).toBeFalsy();
  });

  it("RECORDS a failure that arrives while a placeholder is still in state", () => {
    // WS-before-HTTP (the ordering slide_invalidate already guards against): the
    // generation fails fast, so slide_failed lands while the stale placeholder is
    // still there, and only then does the pending ensure response invalidate it.
    // Treating a placeholder like a standing slide would drop the failure on the
    // floor, and the turn would spin and re-fail every watchdog window.
    const seeded = reducer(initialState, {
      type: "slide_ready",
      agentId: A,
      sessionId: "",
      entryId: "u1",
      slide: placeholderRec,
    });
    const failedFirst = fail(seeded);
    expect(failedFirst.slideFailed.get(A)?.has("u1")).toBe(true);
    // The placeholder still owns the screen while it is there…
    expect(failedFirst.slides.get(A)?.get("u1")).toBe(placeholderRec);
    // …and once the pending response drops it, the mark is what's left.
    const after = reducer(failedFirst, {
      type: "slide_invalidate",
      agentId: A,
      entryId: "u1",
      prevSlide: placeholderRec,
    });
    expect(after.slides.get(A)?.has("u1")).toBe(false);
    expect(after.slideFailed.get(A)?.has("u1")).toBe(true);
  });

  it("clears the mark on an explicit retry", () => {
    const after = reducer(fail(), {
      type: "slide_retry",
      agentId: A,
      entryId: "u1",
    });
    expect(after.slideFailed.get(A)?.has("u1")).toBe(false);
  });

  it("returns the SAME map when there is nothing to clear", () => {
    // A slide_ready for an unrelated turn must not hand every deck consumer a
    // new map to re-render on.
    const seeded = fail();
    const after = reducer(seeded, {
      type: "slide_retry",
      agentId: A,
      entryId: "u9",
    });
    expect(after.slideFailed).toBe(seeded.slideFailed);
  });

  it("drops the agent's marks on a conversation boundary", () => {
    const after = reducer(fail(), { type: "clear_logs", agentId: A });
    expect(after.slideFailed.get(A)).toBeUndefined();
  });

  it("KEEPS the marks on a rollback clear (not a new conversation)", () => {
    const after = reducer(fail(), {
      type: "clear_logs",
      agentId: A,
      rollback: true,
    });
    expect(after.slideFailed.get(A)?.has("u1")).toBe(true);
  });
});

// --- Task board deltas (task b13445e2) --------------------------------------
// A mutation used to re-send the whole board; it now arrives as one task. The
// reducer is where "one task" becomes "the row the user sees", so the two arms
// have to cover the cases the server can legitimately produce: an edit to a task
// we hold, a task becoming visible for the FIRST time (a re-file into a room we
// can access - there is no row to update yet), and a task going away.

function boardTask(id: string, title: string, roomId?: string): TaskItem {
  return {
    id,
    title,
    status: "open",
    createdBy: "Boss",
    createdAt: 1,
    ...(roomId ? { roomId } : {}),
  };
}

describe("reducer: task deltas", () => {
  const hydrated = () =>
    reducer(initialState, {
      type: "tasks",
      tasks: [boardTask("t1", "first"), boardTask("t2", "second")],
    });

  it("task_upserted REPLACES a task we already hold, in place", () => {
    const after = reducer(hydrated(), {
      type: "task_upserted",
      task: { ...boardTask("t1", "renamed"), status: "done" },
    });
    expect(after.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(after.tasks[0].title).toBe("renamed");
    expect(after.tasks[0].status).toBe("done");
  });

  it("task_upserted APPENDS a task we've never seen (first-time visibility)", () => {
    const after = reducer(hydrated(), {
      type: "task_upserted",
      task: boardTask("t3", "newly visible", "room-a"),
    });
    expect(after.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("task_deleted drops the row", () => {
    const after = reducer(hydrated(), { type: "task_deleted", taskId: "t1" });
    expect(after.tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("task_deleted for an id we don't hold is a no-op, same state object", () => {
    const before = hydrated();
    const after = reducer(before, { type: "task_deleted", taskId: "nope" });
    expect(after).toBe(before);
  });

  it("a whole-board `tasks` push still replaces everything (hydration/reconnect)", () => {
    const seeded = reducer(hydrated(), {
      type: "task_upserted",
      task: boardTask("t3", "delta-added"),
    });
    const rehydrated = reducer(seeded, {
      type: "tasks",
      tasks: [boardTask("t9", "only this")],
    });
    expect(rehydrated.tasks.map((t) => t.id)).toEqual(["t9"]);
    expect(rehydrated.tasksLoaded).toBe(true);
  });
});
