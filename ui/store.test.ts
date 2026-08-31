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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { reducer, initialState } from "./store.tsx";
import { ChoiceInteractionCard } from "./log-view/LogView.tsx";
import {
  ProviderSignInCard,
  signOutButtonLabel,
} from "./components/ProviderSignInCard.tsx";
import type {
  AppWire,
  LogEntry,
  SlideRecord,
  TaskItem,
} from "../shared/types.ts";

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

describe("ProviderSignInCard", () => {
  const accounts = [
    {
      provider: "claude" as const,
      scope: "office" as const,
      accountStatus: "unavailable" as const,
      loginStatus: "idle" as const,
      shared: true,
      canBrowserLogin: true,
    },
    {
      provider: "claude" as const,
      scope: "personal" as const,
      accountStatus: "unavailable" as const,
      loginStatus: "idle" as const,
      shared: false,
      canBrowserLogin: true,
    },
  ];

  it("presents both account scopes without a selection toggle", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderSignInCard, { provider: "claude", accounts }),
    );
    expect(html).toContain("Option 1: Sign in for every agent in this office");
    expect(html).toContain("Option 2: Sign in for agents I spawn");
    expect(html).toContain(
      "This subscription is used for every agent in the office except for those spawned by an office member that has set up its own (via Option 2).",
    );
    expect(html).toContain("Use a separate account for your agents.");
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Who should use this account?");
    expect(html).not.toContain("sign in from the built-in terminal");
    expect(html).not.toContain("Set your Env File Path in User Settings.");
  });

  it("uses the generic waiting copy for the Claude code step", () => {
    const waiting = [
      {
        provider: "claude" as const,
        scope: "office" as const,
        accountStatus: "not_connected" as const,
        loginStatus: "waiting_external" as const,
        shared: false,
        canBrowserLogin: true,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ProviderSignInCard, {
        provider: "claude",
        accounts: waiting,
      }),
    );
    expect(html).toContain("Waiting for provider…");
    expect(html).not.toContain("Waiting for Claude");
    expect(html).not.toContain("Waiting for OpenAI");
  });

  it("does not call an account disconnected before its row loads", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderSignInCard, { provider: "claude", accounts: [] }),
    );
    expect(html).toContain("Checking connection…");
    expect(html).not.toContain("Not connected");
  });

  it("renders the provider error when a sign-in fails", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderSignInCard, {
        provider: "claude",
        accounts: [
          {
            provider: "claude",
            scope: "office",
            accountStatus: "not_connected",
            loginStatus: "failed",
            canBrowserLogin: true,
            error: "Claude rejected this sign-in.",
          },
        ],
      }),
    );
    expect(html).toContain("Claude rejected this sign-in.");
  });

  it("pins the shared CLI warning copy for both providers", () => {
    for (const provider of ["claude", "codex"] as const) {
      const title = provider === "claude" ? "Claude" : "Codex";
      const html = renderToStaticMarkup(
        createElement(ProviderSignInCard, {
          provider,
          accounts: [
            {
              provider,
              scope: "office",
              accountStatus: "connected",
              loginStatus: "idle",
              canBrowserLogin: true,
              externalCli: true,
            },
          ],
        }),
      );
      expect(html).toContain(
        `This signs out ${title} in this machine, even outside the office.`,
      );
    }
  });

  it("labels the slow confirm action while sign-out is pending", () => {
    expect(signOutButtonLabel(false)).toBe("Confirm sign out");
    expect(signOutButtonLabel(true)).toBe("Signing out…");
  });

  it("replaces a failed in-chat account wire with the successful push", () => {
    const failed = {
      provider: "codex" as const,
      scope: "office" as const,
      accountStatus: "not_connected" as const,
      loginStatus: "failed" as const,
      canBrowserLogin: true,
      error: "Codex did not report a connected account.",
    };
    const succeeded = {
      ...failed,
      accountStatus: "connected" as const,
      loginStatus: "succeeded" as const,
      accountLabel: "signed-in@example.com",
      error: undefined,
    };
    const before = reducer(initialState, {
      type: "provider_accounts_updated",
      accounts: [failed],
    });
    const after = reducer(before, {
      type: "provider_accounts_updated",
      accounts: [succeeded],
    });
    const html = renderToStaticMarkup(
      createElement(ProviderSignInCard, {
        provider: "codex",
        accounts: after.providerAccounts,
      }),
    );
    expect(html).toContain("Connected as signed-in@example.com");
    expect(html).not.toContain("Codex did not report a connected account.");
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

describe("reducer: reconnect replay window (full_state → log_replay_complete)", () => {
  const A = "agent-1";
  const B = "agent-2";

  function fullState(): Extract<
    Parameters<typeof reducer>[1],
    { type: "full_state" }
  > {
    return {
      type: "full_state",
      agents: [],
      recentCwds: [],
      office: { prompt: null, name: null },
      rooms: [],
      killedAgents: [],
      interactions: [],
    };
  }

  // Every WS reconnect sends full_state and then replays each visible agent's
  // cached transcript one log_entry frame at a time. Clearing `logs` on
  // full_state is what blanked the conversation on a mobile app switch.
  // Focused, because only the focused agent's transcript is on screen and so
  // only that one is held across the window.
  function seeded() {
    return {
      ...reducer(initialState, { type: "log_entry", entry: entry("e1", A, 1) }),
      focusedAgentId: A,
    };
  }

  it("keeps rendering the cached transcript instead of blanking it", () => {
    const after = reducer(seeded(), fullState());
    expect((after.logs.get(A) ?? []).map((e) => e.id)).toEqual(["e1"]);
    expect(after.logsReplay).not.toBeNull();
  });

  it("buffers the replay away from the rendered logs, then swaps atomically", () => {
    let s = reducer(seeded(), fullState());
    // The replay re-sends the entry we already have plus one that landed
    // while we were disconnected.
    s = reducer(s, { type: "log_entry", entry: entry("e1", A, 1) });
    s = reducer(s, { type: "log_entry", entry: entry("e2", A, 2) });
    // Mid-replay the view still shows exactly the pre-reconnect transcript.
    expect((s.logs.get(A) ?? []).map((e) => e.id)).toEqual(["e1"]);
    expect((s.logsReplay?.logs.get(A) ?? []).map((e) => e.id)).toEqual([
      "e1",
      "e2",
    ]);
    s = reducer(s, { type: "log_replay_complete" });
    expect((s.logs.get(A) ?? []).map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(s.logsReplay).toBeNull();
    // The dedupe map travels with the swap, so a later live entry with a
    // replayed id is still recognized as a duplicate.
    expect(s.logEntryIds.get(A)?.has("e2")).toBe(true);
  });

  it("REPLACES on commit, so entries the server no longer has are dropped", () => {
    // The case the old wipe existed for: the client was away across a /clear
    // and never saw the clear_logs, so a merge would concatenate the two
    // conversations. The replayed set is the server's and wins outright.
    let s = reducer(seeded(), fullState());
    s = reducer(s, { type: "log_entry", entry: entry("fresh", A, 9) });
    s = reducer(s, { type: "log_replay_complete" });
    expect((s.logs.get(A) ?? []).map((e) => e.id)).toEqual(["fresh"]);
    expect(s.logEntryIds.get(A)?.has("e1")).toBe(false);
  });

  it("commits an agent to empty when the replay carried nothing for it", () => {
    let s = reducer(seeded(), fullState());
    s = reducer(s, { type: "log_replay_complete" });
    expect(s.logs.get(A) ?? []).toEqual([]);
  });

  it("opens no window when no agent is open (nothing on screen to protect)", () => {
    const unfocused = {
      ...reducer(initialState, { type: "log_entry", entry: entry("e1", A, 1) }),
      focusedAgentId: null,
    };
    const after = reducer(unfocused, fullState());
    expect(after.logsReplay).toBeNull();
    expect(after.logs.size).toBe(0);
  });

  it("holds only the focused agent's transcript, not every visible agent's", () => {
    // Transcripts run to megabytes; nothing renders the other streams, so
    // holding them across the window would double the client's peak for free.
    let s = reducer(seeded(), { type: "log_entry", entry: entry("b1", B, 2) });
    s = reducer(s, fullState());
    expect([...s.logs.keys()]).toEqual([A]);
  });

  it("opens no window on a cold connect (nothing cached to protect)", () => {
    const after = reducer(initialState, fullState());
    expect(after.logsReplay).toBeNull();
    // …and entries then paint straight through, as before.
    const painted = reducer(after, {
      type: "log_entry",
      entry: entry("e1", A, 1),
    });
    expect((painted.logs.get(A) ?? []).map((e) => e.id)).toEqual(["e1"]);
  });

  it("lets a clear_logs mid-replay stick instead of being undone by the commit", () => {
    let s = reducer(seeded(), fullState());
    s = reducer(s, { type: "log_entry", entry: entry("e1", A, 1) });
    s = reducer(s, { type: "clear_logs", agentId: A });
    s = reducer(s, { type: "log_replay_complete" });
    expect(s.logs.get(A) ?? []).toEqual([]);
  });

  it("lets an agent_removed mid-replay stick instead of being undone", () => {
    let s = reducer(seeded(), fullState());
    s = reducer(s, { type: "log_entry", entry: entry("e1", A, 1) });
    s = reducer(s, { type: "agent_removed", agentId: A, roomId: "r1" });
    s = reducer(s, { type: "log_replay_complete" });
    expect(s.logs.has(A)).toBe(false);
  });

  it("buffers a log_entries_batch too, and keeps streams separate", () => {
    let s = reducer(seeded(), fullState());
    s = reducer(s, {
      type: "log_entries_batch",
      entries: [entry("e1", A, 1), entry("b1", B, 5)],
    });
    expect((s.logs.get(B) ?? []).map((e) => e.id)).toEqual([]);
    s = reducer(s, { type: "log_replay_complete" });
    expect((s.logs.get(A) ?? []).map((e) => e.id)).toEqual(["e1"]);
    expect((s.logs.get(B) ?? []).map((e) => e.id)).toEqual(["b1"]);
  });

  it("commit outside a window is a no-op, same state object", () => {
    const before = seeded();
    expect(reducer(before, { type: "log_replay_complete" })).toBe(before);
  });

  it("a second full_state mid-window starts a fresh buffer, not a merge", () => {
    // Two reconnects in quick succession (flaky link). The second must not
    // inherit the first's half-arrived replay, and must restart both deadlines
    // (seq bumps, tick resets to 0).
    let s = reducer(seeded(), fullState());
    s = reducer(s, { type: "log_entry", entry: entry("partial", A, 7) });
    const firstSeq = s.logsReplay?.seq ?? 0;
    s = reducer(s, fullState());
    expect(s.logsReplay?.logs.size).toBe(0);
    expect(s.logsReplay?.seq).toBe(firstSeq + 1);
    // The view still shows the pre-reconnect transcript, not the partial one.
    expect((s.logs.get(A) ?? []).map((e) => e.id)).toEqual(["e1"]);
  });

  it("keeps a live entry that lands right behind the replay burst", () => {
    // The server's send loop is synchronous, so a live emit follows the cached
    // replay rather than interleaving with it. Both must survive the swap.
    let s = reducer(seeded(), fullState());
    s = reducer(s, { type: "log_entry", entry: entry("e1", A, 1) });
    s = reducer(s, { type: "log_entry", entry: entry("live", A, 2) });
    s = reducer(s, { type: "log_replay_complete" });
    expect((s.logs.get(A) ?? []).map((e) => e.id)).toEqual(["e1", "live"]);
  });

  it("routes entries normally again once the window has closed", () => {
    // Anything arriving after the fence must append to the rendered logs, not
    // to a buffer that is no longer there.
    let s = reducer(seeded(), fullState());
    s = reducer(s, { type: "log_replay_complete" });
    s = reducer(s, { type: "log_entry", entry: entry("after", A, 3) });
    expect(s.logsReplay).toBeNull();
    expect((s.logs.get(A) ?? []).map((e) => e.id)).toEqual(["after"]);
    // A second commit can't resurrect the buffer it already consumed.
    const settled = s;
    expect(reducer(settled, { type: "log_replay_complete" })).toBe(settled);
  });

  it("drops a cron run transcript at commit, as full_state already did", () => {
    // The server's reconnect replay is agent-only, so an open cron run's
    // fetched transcript is never in the replayed set. The old full_state wipe
    // dropped it outright; this drops it at the same point (the hold keeps only
    // the focused agent's stream). Pinned so the drop stays deliberate: the
    // repair lives in CronjobRunView, which refetches the transcript on every
    // hydration (task 461fe250) rather than once per mount, so the run view
    // refills instead of staying blank. The bump it keys on is asserted below.
    const RUN = "cronrun-run1";
    let s = reducer(seeded(), {
      type: "log_entries_batch",
      entries: [entry("r1", RUN, 4)],
    });
    s = reducer(s, fullState());
    expect(s.logs.has(RUN)).toBe(false);
    s = reducer(s, { type: "log_entry", entry: entry("e1", A, 1) });
    s = reducer(s, { type: "log_replay_complete" });
    expect(s.logs.has(RUN)).toBe(false);
  });

  it("bumps hydrationEpoch on every full_state", () => {
    // The signal a view refetches on. It has to move on EVERY full_state, not
    // just the ones preceded by a disconnect: ws.ts's onVisible() reconnects a
    // frozen mobile socket without ever signalling `connected` false, so an
    // edge on that flag is not something every reconnect produces.
    let s = reducer(initialState, fullState());
    expect(s.hydrationEpoch).toBe(1);
    s = reducer(s, { type: "connected" });
    s = reducer(s, fullState());
    expect(s.hydrationEpoch).toBe(2);
    // Still connected the whole way through - the epoch moved anyway.
    expect(s.connected).toBe(true);
  });
});

describe("reducer: structured choice interactions", () => {
  const interaction = {
    id: "interaction-1",
    agentId: "agent-1",
    kind: "model" as const,
    title: "Switch model",
    instruction: "Choose or cancel.",
    choices: [{ value: "sonnet", label: "Sonnet" }],
  };

  it("hydrates and applies the add and remove lifecycle", () => {
    let state = reducer(initialState, {
      type: "interaction_added",
      interaction,
    });
    expect(state.interactions).toEqual([interaction]);
    state = reducer(state, {
      type: "interaction_removed",
      interactionId: interaction.id,
      agentId: interaction.agentId,
    });
    expect(state.interactions).toEqual([]);
  });

  it("falls back cleanly when an older server omits interactions", () => {
    const state = reducer(initialState, {
      type: "full_state",
      agents: [],
      recentCwds: [],
      office: { prompt: null, name: null },
      rooms: [],
      killedAgents: [],
      interactions: undefined as never,
    });
    expect(state.interactions).toEqual([]);
  });

  it("renders each received choice with its typed position", () => {
    const choices = [
      { value: "opus", label: "Opus" },
      { value: "fable", label: "Fable", current: true },
      { value: "sonnet", label: "Sonnet" },
    ];
    const html = renderToStaticMarkup(
      createElement(ChoiceInteractionCard, {
        interaction: { ...interaction, choices },
      }),
    );

    for (let index = 0; index < choices.length; index++) {
      expect(html).toContain(`${index + 1}. ${choices[index].label}`);
    }
  });
});

// --- Apps slice (S3) --------------------------------------------------------
// The Apps tab holds server data that full_state does NOT replay, so two
// invariants matter here: the deltas patch by NAME (an app has no other id),
// and a rehydrate must not silently empty the list - the tab re-fetches on
// hydrationEpoch instead.

function appWire(name: string, over: Partial<AppWire> = {}): AppWire {
  return {
    name,
    hostLabel: name,
    hostGen: 1,
    port: 21000,
    command: "bun run serve.ts",
    cwd: "/home/alice/app",
    dataDir: `/state/apps/data/${name}`,
    userId: "u-alice",
    username: "alice",
    createdBy: "Agent1",
    createdAt: 1,
    state: "running",
    restartCount: 0,
    ...over,
  };
}

describe("reducer: apps", () => {
  const seeded = reducer(initialState, {
    type: "apps_loaded",
    apps: [appWire("alpha"), appWire("beta")],
    revision: 0,
  });

  it("apps_loaded REPLACES the slice, so a vanished app does not linger", () => {
    // This is the poll result. A merge would keep showing an app somebody
    // deleted from another tab if its delta was missed.
    const next = reducer(seeded, {
      type: "apps_loaded",
      apps: [appWire("beta", { state: "stopped" })],
      revision: seeded.appsRevision,
    });
    expect(next.apps.map((a) => a.name)).toEqual(["beta"]);
    expect(next.apps[0].state).toBe("stopped");
    expect(next.appsLoaded).toBe(true);
  });

  it("app_upserted REPLACES a known app in place, keyed by name", () => {
    const next = reducer(seeded, {
      type: "app_upserted",
      app: appWire("alpha", { state: "failed", restartCount: 3 }),
    });
    expect(next.apps.map((a) => a.name)).toEqual(["alpha", "beta"]);
    expect(next.apps[0].state).toBe("failed");
    expect(next.apps[0].restartCount).toBe(3);
  });

  it("app_upserted APPENDS an app we have never seen", () => {
    const next = reducer(seeded, {
      type: "app_upserted",
      app: appWire("gamma"),
    });
    expect(next.apps.map((a) => a.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("app_upserted is idempotent - the same delta twice holds one row", () => {
    const app = appWire("alpha", { state: "stopped" });
    const once = reducer(seeded, { type: "app_upserted", app });
    const twice = reducer(once, { type: "app_upserted", app });
    expect(twice.apps.map((a) => a.name)).toEqual(["alpha", "beta"]);
  });

  it("app_deleted drops the app, and a repeat leaves the list alone", () => {
    const gone = reducer(seeded, { type: "app_deleted", name: "alpha" });
    expect(gone.apps.map((a) => a.name)).toEqual(["beta"]);
    // A delta racing the tab's first fetch must not throw or clear the list.
    // The rows are untouched, but the revision still moves - see the
    // do-not-hold case below for why that is not an accident.
    const again = reducer(gone, { type: "app_deleted", name: "alpha" });
    expect(again.apps).toBe(gone.apps);
    expect(again.appsRevision).toBe(gone.appsRevision + 1);
  });

  // THE RACE: a list GET is a snapshot of the moment it was issued. If a delta
  // lands while it is in flight, the snapshot is older than what we hold, and
  // applying it would undo the delta - resurrecting a deleted app or reverting
  // a stopped one until the next poll.
  it("refuses a list response that a delta overtook while it was in flight", () => {
    const revisionAtRequest = seeded.appsRevision;
    // The delta wins the race.
    const afterDelta = reducer(seeded, {
      type: "app_deleted",
      name: "alpha",
    });
    expect(afterDelta.apps.map((a) => a.name)).toEqual(["beta"]);
    // The older snapshot - which still lists alpha - now arrives.
    const afterStale = reducer(afterDelta, {
      type: "apps_loaded",
      apps: [appWire("alpha"), appWire("beta")],
      revision: revisionAtRequest,
    });
    expect(afterStale.apps.map((a) => a.name)).toEqual(["beta"]);
    // Still counts as loaded: the fetch succeeded, and pinning the tab to its
    // loading state over a won race would be its own bug.
    expect(afterStale.appsLoaded).toBe(true);
  });

  it("refuses a stale snapshot that would revert an upsert", () => {
    const revisionAtRequest = seeded.appsRevision;
    const afterDelta = reducer(seeded, {
      type: "app_upserted",
      app: appWire("alpha", { state: "stopped" }),
    });
    const afterStale = reducer(afterDelta, {
      type: "apps_loaded",
      apps: [appWire("alpha", { state: "running" }), appWire("beta")],
      revision: revisionAtRequest,
    });
    expect(afterStale.apps.find((a) => a.name === "alpha")!.state).toBe(
      "stopped",
    );
  });

  it("a delete for an app we do not hold still moves the revision", () => {
    // Otherwise an in-flight GET that DOES carry that app would be accepted and
    // resurrect it: the row is missing here, not everywhere.
    const after = reducer(seeded, { type: "app_deleted", name: "ghost" });
    expect(after.appsRevision).toBe(seeded.appsRevision + 1);
    expect(after.apps.map((a) => a.name)).toEqual(["alpha", "beta"]);
  });

  it("accepts the snapshot once its revision is current again", () => {
    const afterDelta = reducer(seeded, { type: "app_deleted", name: "alpha" });
    const fresh = reducer(afterDelta, {
      type: "apps_loaded",
      apps: [appWire("beta"), appWire("gamma")],
      revision: afterDelta.appsRevision,
    });
    expect(fresh.apps.map((a) => a.name)).toEqual(["beta", "gamma"]);
  });

  it("full_state leaves the apps slice untouched", () => {
    // The reconnect trap: full_state does not carry apps, so if it cleared
    // them the tab would go blank on a rehydrate. It re-fetches on
    // hydrationEpoch instead, which this proves is the bumped signal.
    const after = reducer(seeded, {
      type: "full_state",
      agents: [],
      recentCwds: [],
      office: { prompt: null, name: null },
      rooms: [],
      killedAgents: [],
    } as never);
    expect(after.apps.map((a) => a.name)).toEqual(["alpha", "beta"]);
    expect(after.hydrationEpoch).toBe(seeded.hydrationEpoch + 1);
  });
});
