import { describe, it, expect } from "bun:test";
import {
  createSlideMode,
  drainOnSettle,
  buildFormatterPrompt,
  extractSlideHtml,
  type SlideJobContext,
} from "../slide-mode.ts";
import { slideContentDigest, type DeckTurn } from "../../shared/slide-turns.ts";
import type { SlideRecord } from "../../shared/types.ts";

// A deferred we resolve by hand to hold a generation open.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function turn(overrides: Partial<DeckTurn> = {}): DeckTurn {
  return {
    entryId: "u1",
    promptText: "What is 2+2?",
    assistantText: "It is 4.",
    errorText: null,
    placeholder: false,
    ...overrides,
  };
}

interface Harness {
  ensureSlide: ReturnType<typeof createSlideMode>["ensureSlide"];
  onTurnSettled: ReturnType<typeof createSlideMode>["onTurnSettled"];
  deck: Map<string, SlideRecord>;
  ready: Array<{ entryId: string; slide: SlideRecord }>;
  failed: Array<{ entryId: string; reason: string }>;
  calls: string[]; // prompts passed to the backend, in order
  resolveNext: (html: string) => void;
  rejectNext: (message: string) => void;
  concurrentPeak: () => number;
  // null models an agent with NO current conversation (post-/clear), where
  // getRootSessionId returns null.
  setRoot: (root: string | null) => void;
  setJob: (entryId: string, job: SlideJobContext | null) => void;
  setTerminal: (entryId: string, terminal: boolean) => void;
}

function harness(): Harness {
  const deck = new Map<string, SlideRecord>();
  const ready: Array<{ entryId: string; slide: SlideRecord }> = [];
  const failed: Array<{ entryId: string; reason: string }> = [];
  const calls: string[] = [];
  let currentRoot: string | null = "root1";
  let concurrent = 0;
  let peak = 0;
  const pending: Array<{
    resolve: (v: string) => void;
    reject: (e: unknown) => void;
  }> = [];
  const jobs = new Map<string, SlideJobContext | null>();
  // Per-turn terminal flag (default true - most tests deal with settled turns).
  const terminalById = new Map<string, boolean>();

  // Mirrors resolveSlideJob: no current conversation root -> nothing to resolve.
  const defaultJob = (entryId: string): SlideJobContext | null =>
    currentRoot === null
      ? null
      : {
          agentType: "claude",
          modelFamily: "sonnet",
          cwd: "/tmp",
          rootSessionId: currentRoot,
          turn: turn({ entryId }),
          prevSlideHtml: null,
          terminal: terminalById.get(entryId) ?? true,
        };

  const slideMode = createSlideMode({
    resolveBackend: () => ({
      oneShotPrompt: (prompt: string) => {
        calls.push(prompt);
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        const d = deferred<string>();
        pending.push({
          resolve: (html: string) => {
            concurrent -= 1;
            d.resolve(html);
          },
          reject: (e: unknown) => {
            concurrent -= 1;
            d.reject(e);
          },
        });
        return d.promise;
      },
    }),
    resolveJob: (_agentId, entryId) => {
      if (jobs.has(entryId)) return jobs.get(entryId)!;
      const job = defaultJob(entryId);
      if (!job) return null;
      // A per-entry terminal override applies even to a preset job's turn.
      return { ...job, terminal: terminalById.get(entryId) ?? job.terminal };
    },
    // Same shape as the production guard in agent-manager: a rootless agent is
    // never current.
    isCurrent: (_agentId, rootSessionId) =>
      currentRoot !== null && currentRoot === rootSessionId,
    readSlide: (_a, _root, entryId) => deck.get(entryId) ?? null,
    writeSlide: (_a, _root, entryId, rec) => deck.set(entryId, rec),
    onSlideReady: (_a, _root, entryId, rec) =>
      ready.push({ entryId, slide: rec }),
    onSlideFailed: (_a, _root, entryId, reason) =>
      failed.push({ entryId, reason }),
    now: () => 1000,
  });

  return {
    ensureSlide: slideMode.ensureSlide,
    onTurnSettled: slideMode.onTurnSettled,
    deck,
    ready,
    failed,
    calls,
    resolveNext: (html) => pending.shift()?.resolve(html),
    rejectNext: (message) => pending.shift()?.reject(new Error(message)),
    concurrentPeak: () => peak,
    setRoot: (root) => {
      currentRoot = root;
    },
    setJob: (entryId, job) => jobs.set(entryId, job),
    setTerminal: (entryId, terminal) => terminalById.set(entryId, terminal),
  };
}

describe("createSlideMode.ensureSlide", () => {
  it("returns a cached slide (digest matches) without calling the backend", async () => {
    const h = harness();
    h.deck.set("u1", {
      html: "<div>cached</div>",
      placeholder: false,
      errorText: null,
      promptText: "q",
      model: "sonnet",
      createdAt: 1,
      contentDigest: slideContentDigest(turn({ entryId: "u1" })),
    });
    const res = h.ensureSlide("a1", "u1");
    expect(res).toEqual({ status: "ready", slide: h.deck.get("u1")! });
    await flush();
    expect(h.calls).toHaveLength(0);
  });

  it("generates on a miss: pending → writes + broadcasts the slide", async () => {
    const h = harness();
    const res = h.ensureSlide("a1", "u1");
    expect(res).toEqual({ status: "pending" });
    await flush();
    expect(h.calls).toHaveLength(1);
    h.resolveNext("<div>slide</div>");
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>slide</div>");
    expect(h.ready).toHaveLength(1);
    expect(h.ready[0].entryId).toBe("u1");
  });

  it("dedupes concurrent requests for the same turn", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    h.ensureSlide("a1", "u1");
    const third = h.ensureSlide("a1", "u1");
    expect(third).toEqual({ status: "pending" });
    await flush();
    expect(h.calls).toHaveLength(1); // one generation, not three
  });

  it("writes a placeholder with no backend call for an empty turn", async () => {
    const h = harness();
    h.setJob("u1", {
      agentType: "claude",
      modelFamily: "sonnet",
      cwd: "/tmp",
      rootSessionId: "root1",
      turn: turn({ placeholder: true, assistantText: "", errorText: "boom" }),
      prevSlideHtml: null,
      terminal: true,
    });
    h.ensureSlide("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(h.deck.get("u1")).toMatchObject({
      html: null,
      placeholder: true,
      errorText: "boom",
    });
    expect(h.ready).toHaveLength(1);
  });

  it("drops a result whose conversation root moved on - stale guard", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    h.setRoot("root2"); // a /resume into another thread during generation
    h.resolveNext("<div>late</div>");
    await flush();
    expect(h.deck.has("u1")).toBe(false);
    expect(h.ready).toHaveLength(0);
  });

  it("drops an in-flight result after /clear leaves the agent rootless", async () => {
    // /clear nulls sessionId, so getRootSessionId returns null. The identity
    // guard must treat "no conversation at all" as not-current rather than
    // letting a null match anything.
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(1);
    h.setRoot(null);
    h.resolveNext("<div>late</div>");
    await flush();
    expect(h.deck.has("u1")).toBe(false);
    expect(h.ready).toHaveLength(0);
  });

  it("a topic rename does NOT drop in-flight slide work", async () => {
    // The topicGenToken counterexample. Slide Mode keys on the conversation ROOT
    // session id, which a manual topic rename doesn't touch, so an in-flight
    // generation still commits. Keying on topicGenToken (which setTopic bumps)
    // would have wrongly dropped it.
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(1);
    h.resolveNext("<div>kept</div>"); // root never changed
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>kept</div>");
    expect(h.ready).toHaveLength(1);
  });

  it("force regenerates even when cached, threading feedback into the prompt", async () => {
    const h = harness();
    h.deck.set("u1", {
      html: "<div>old</div>",
      placeholder: false,
      errorText: null,
      promptText: "q",
      model: "sonnet",
      createdAt: 1,
    });
    const res = h.ensureSlide("a1", "u1", {
      force: true,
      feedback: "bigger title",
    });
    expect(res).toEqual({ status: "pending" });
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain("bigger title");
    h.resolveNext("<div>new</div>");
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>new</div>"); // overwrote
  });

  it("returns unavailable when the turn cannot be resolved", () => {
    const h = harness();
    h.setJob("gone", null);
    expect(h.ensureSlide("a1", "gone")).toEqual({ status: "unavailable" });
  });

  it("a re-request after the conversation root changes starts a fresh job", async () => {
    // Regression: an old-root job in flight must not dedupe a new-root request
    // (the old job is dropped by the stale guard, so the turn would otherwise
    // never generate). Keying the in-flight map by root session id fixes it.
    const h = harness();
    h.ensureSlide("a1", "u1"); // key a1::root1::u1
    await flush();
    expect(h.calls).toHaveLength(1);
    h.setRoot("root2"); // /resume into another thread
    h.ensureSlide("a1", "u1"); // key a1::root2::u1 → NOT deduped
    await flush();
    expect(h.calls).toHaveLength(2); // a live job for the new conversation
    h.resolveNext("<div>old</div>"); // root1 job → dropped by stale guard
    h.resolveNext("<div>new</div>"); // root2 job → written
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>new</div>");
    expect(h.ready).toHaveLength(1);
  });

  it("an edit-fork of the in-flight turn leaves no orphan: the turn is gone", async () => {
    // The edit-fork case the root-session guard deliberately does NOT drop on
    // (a fork keeps the root). It doesn't need to: editMessage replays the
    // entries BEFORE the edited one and appends the new text under a NEW entry
    // id, so the forked turn's own id no longer resolves. The in-flight job's
    // commit re-resolves, finds nothing, and discards - no slide is written for
    // a turn that no longer exists, and earlier turns keep matching digests.
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(1);
    h.setJob("u1", null); // the fork removed this entry id
    h.resolveNext("<div>forked away</div>");
    await flush();
    expect(h.deck.has("u1")).toBe(false);
    expect(h.ready).toHaveLength(0);
  });

  it("coalesces rapid force regens into one rerun with the latest feedback", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1"); // initial, no feedback
    await flush();
    expect(h.calls).toHaveLength(1);
    h.ensureSlide("a1", "u1", { force: true, feedback: "A" }); // queued rerun
    h.ensureSlide("a1", "u1", { force: true, feedback: "B" }); // overwrites A
    await flush();
    expect(h.calls).toHaveLength(1); // no competing writer while gen1 runs
    h.resolveNext("<div>1</div>"); // gen1 done → rerun fires
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toContain("B");
    expect(h.calls[1]).not.toContain("A");
    h.resolveNext("<div>2</div>");
    await flush();
  });

  // --- Terminal gate + deferred fulfilment (the send-from-slide-mode fix) -----

  it("gates a non-terminal turn: pending, NO generation, NO placeholder written", async () => {
    const h = harness();
    h.setTerminal("u1", false); // the still-running newest turn
    const res = h.ensureSlide("a1", "u1");
    expect(res).toEqual({ status: "pending" });
    await flush();
    expect(h.calls).toHaveLength(0); // never formats a half-streamed answer
    expect(h.deck.has("u1")).toBe(false); // and never records a stale placeholder
    expect(h.ready).toHaveLength(0);
  });

  it("onTurnSettled fulfils a parked request: generates the settled slide", async () => {
    const h = harness();
    h.setTerminal("u1", false);
    h.ensureSlide("a1", "u1"); // parks a waiter, pending
    await flush();
    expect(h.calls).toHaveLength(0);
    // Turn completes with content.
    h.setTerminal("u1", true);
    h.onTurnSettled("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(1); // now it generates
    h.resolveNext("<div>answer</div>");
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>answer</div>");
    expect(h.ready).toHaveLength(1);
  });

  it("onTurnSettled on an empty turn commits a placeholder (deck stays 1:1)", async () => {
    const h = harness();
    h.setJob("u1", {
      agentType: "claude",
      modelFamily: "sonnet",
      cwd: "/tmp",
      rootSessionId: "root1",
      turn: turn({ placeholder: true, assistantText: "", errorText: null }),
      prevSlideHtml: null,
      terminal: false,
    });
    h.ensureSlide("a1", "u1"); // parked while in flight
    await flush();
    expect(h.deck.has("u1")).toBe(false);
    // Interrupted/tool-only -> terminal, still empty.
    h.setJob("u1", {
      agentType: "claude",
      modelFamily: "sonnet",
      cwd: "/tmp",
      rootSessionId: "root1",
      turn: turn({ placeholder: true, assistantText: "", errorText: null }),
      prevSlideHtml: null,
      terminal: true,
    });
    h.onTurnSettled("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(0); // placeholder needs no backend call
    expect(h.deck.get("u1")).toMatchObject({ html: null, placeholder: true });
    expect(h.ready).toHaveLength(1);
  });

  it("onTurnSettled without a parked request does nothing (view-driven cost)", async () => {
    const h = harness();
    h.onTurnSettled("a1", "u1"); // nobody asked while it was in flight
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(h.deck.has("u1")).toBe(false);
    expect(h.ready).toHaveLength(0);
  });

  it("preserves the latest feedback a client parked while the turn was gated", async () => {
    const h = harness();
    h.setTerminal("u1", false);
    h.ensureSlide("a1", "u1", { force: true, feedback: "make it teal" });
    h.ensureSlide("a1", "u1", { force: true, feedback: "bigger title" }); // latest wins
    await flush();
    expect(h.calls).toHaveLength(0); // still gated
    h.setTerminal("u1", true);
    h.onTurnSettled("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain("bigger title");
    expect(h.calls[0]).not.toContain("make it teal");
  });

  it("force parked while gated stays sticky; a later plain prefetch doesn't clobber it", async () => {
    const h = harness();
    h.setTerminal("u1", false);
    h.ensureSlide("a1", "u1", { force: true, feedback: "teal" }); // forced ↻
    h.ensureSlide("a1", "u1"); // plain neighbor prefetch - must NOT drop force/feedback
    await flush();
    h.setTerminal("u1", true);
    h.onTurnSettled("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain("teal"); // force + feedback survived
  });

  it("onTurnSettled drops the parked request when the turn is gone (e.g. /clear)", async () => {
    const h = harness();
    h.setTerminal("u1", false);
    h.ensureSlide("a1", "u1"); // parked
    await flush();
    h.setJob("u1", null); // conversation cleared: the turn no longer resolves
    h.onTurnSettled("a1", "u1");
    await flush();
    expect(h.calls).toHaveLength(0); // nothing to show; dropped, not orphaned
    expect(h.deck.has("u1")).toBe(false);
  });

  it("commit guard discards a result whose content changed under an UNCHANGED root (linked edit-fork)", async () => {
    // The complement of the identity guard, and the case a linked edit-fork
    // would present: the root session id is preserved across the fork, so the
    // identity guard passes it through - the content digest is what rejects it.
    // Identity is the cheap early-out; the digest is the guarantee.
    const h = harness();
    h.ensureSlide("a1", "u1"); // generates from the current turn ("It is 4.")
    await flush();
    expect(h.calls).toHaveLength(1);
    // The turn's content mutates mid-generation: the live digest no longer
    // matches what we generated from, under the SAME rootSessionId.
    h.setJob("u1", {
      agentType: "claude",
      modelFamily: "sonnet",
      cwd: "/tmp",
      rootSessionId: "root1",
      turn: turn({ assistantText: "It is FIVE." }),
      prevSlideHtml: null,
      terminal: true,
    });
    h.resolveNext("<div>four</div>"); // stale relative to the new content
    await flush();
    expect(h.deck.has("u1")).toBe(false); // discarded, not broadcast
    expect(h.ready).toHaveLength(0);
  });

  // --- Reconciliation against live content -----------------------------------

  it("regenerates a stale placeholder whose turn has since gained text", async () => {
    const h = harness();
    // A placeholder cached from before the fix (no digest), but the live turn
    // now has content (defaultJob's turn is "It is 4.").
    h.deck.set("u1", {
      html: null,
      placeholder: true,
      errorText: null,
      promptText: "q",
      model: "sonnet",
      createdAt: 1,
    });
    const res = h.ensureSlide("a1", "u1");
    expect(res).toEqual({ status: "pending" }); // stale -> regenerate, not served
    await flush();
    expect(h.calls).toHaveLength(1);
    h.resolveNext("<div>real</div>");
    await flush();
    expect(h.deck.get("u1")?.html).toBe("<div>real</div>");
    expect(h.deck.get("u1")?.placeholder).toBe(false);
  });

  it("serves a cached slide whose digest still matches, no regeneration", async () => {
    const h = harness();
    // Generate once so the record carries the current content digest.
    h.ensureSlide("a1", "u1");
    await flush();
    h.resolveNext("<div>v1</div>");
    await flush();
    expect(h.calls).toHaveLength(1);
    // A second ensure for the unchanged turn is served from cache.
    const res = h.ensureSlide("a1", "u1");
    expect(res.status).toBe("ready");
    await flush();
    expect(h.calls).toHaveLength(1); // no second generation
  });

  it("serves a genuine placeholder whose digest matches (no regeneration)", async () => {
    const h = harness();
    const emptyTurn = turn({
      placeholder: true,
      assistantText: "",
      errorText: null,
    });
    h.setJob("u1", {
      agentType: "claude",
      modelFamily: "sonnet",
      cwd: "/tmp",
      rootSessionId: "root1",
      turn: emptyTurn,
      prevSlideHtml: null,
      terminal: true,
    });
    h.deck.set("u1", {
      html: null,
      placeholder: true,
      errorText: null,
      promptText: emptyTurn.promptText,
      model: "sonnet",
      createdAt: 1,
      contentDigest: slideContentDigest(emptyTurn),
    });
    const res = h.ensureSlide("a1", "u1");
    expect(res.status).toBe("ready"); // digest matches -> served, not regenerated
    await flush();
    expect(h.calls).toHaveLength(0);
  });

  it("regenerates a DIGESTLESS legacy placeholder (unverifiable) with no LLM call", async () => {
    const h = harness();
    h.setJob("u1", {
      agentType: "claude",
      modelFamily: "sonnet",
      cwd: "/tmp",
      rootSessionId: "root1",
      turn: turn({ placeholder: true, assistantText: "", errorText: null }),
      prevSlideHtml: null,
      terminal: true,
    });
    // Pre-digest record: unverifiable, so it is re-committed (gaining a digest).
    h.deck.set("u1", {
      html: null,
      placeholder: true,
      errorText: null,
      promptText: "q",
      model: "sonnet",
      createdAt: 1,
    });
    const res = h.ensureSlide("a1", "u1");
    expect(res.status).toBe("pending"); // digestless -> reconcile
    await flush();
    expect(h.calls).toHaveLength(0); // placeholder re-commit needs no backend
    expect(h.deck.get("u1")?.contentDigest).toBeDefined(); // now verifiable
    expect(h.deck.get("u1")?.placeholder).toBe(true);
  });

  it("caps concurrency at 2 per agent", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    h.ensureSlide("a1", "u2");
    h.ensureSlide("a1", "u3");
    h.ensureSlide("a1", "u4");
    await flush();
    expect(h.concurrentPeak()).toBe(2);
    expect(h.calls).toHaveLength(2); // only 2 running; others queued
    h.resolveNext("<div>1</div>");
    await flush();
    expect(h.calls).toHaveLength(3); // a slot freed → the next starts
  });
});

// The client cannot tell a failed generation from a slow one, so the server has
// to say so - that is the whole reason this event exists (task 01a7327a).
describe("createSlideMode failure reporting", () => {
  // The reason crossing the wire is a CLOSED code, never the underlying error:
  // slide_failed reaches every session that can see the room, and backend
  // exception text / raw model output is neither stable nor ours to broadcast.
  it("reports a formatter error as generation_failed, with no slide written", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    h.rejectNext("backend exploded: /home/someone/.creds not readable");
    await flush();
    expect(h.deck.get("u1")).toBeUndefined();
    expect(h.ready).toHaveLength(0);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0].entryId).toBe("u1");
    expect(h.failed[0].reason).toBe("generation_failed");
  });

  it("reports output that violates the slide contract as invalid_output", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    h.resolveNext("<div><script>alert(1)</script></div>");
    await flush();
    expect(h.deck.get("u1")).toBeUndefined();
    expect(h.failed).toHaveLength(1);
    // Not the validator's message, which quotes the model's raw output.
    expect(h.failed[0].reason).toBe("invalid_output");
  });

  it("stays SILENT when the result was discarded, not failed", async () => {
    // /clear during generation: the write is dropped by the identity guard, and
    // the turn's deck position is gone too - so there is nothing to report a
    // failure about. Announcing one would show a fallback for a turn that no
    // longer exists.
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    h.setRoot(null);
    h.rejectNext("backend exploded");
    await flush();
    expect(h.failed).toHaveLength(0);
  });

  it("stays SILENT for a failed pass that has a rerun queued behind it", async () => {
    // The race Reviewer1 flagged: a ↻ arrives mid-generation and coalesces into
    // a rerun; then pass A fails and pass B succeeds. Reporting A would flash the
    // fallback on a slide already being retried - only the LAST pass's outcome is
    // terminal. Expect: no failure at all, and exactly one slide_ready.
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    h.ensureSlide("a1", "u1", { force: true }); // coalesced rerun
    h.rejectNext("first pass exploded");
    await flush();
    expect(h.failed).toHaveLength(0);
    expect(h.calls).toHaveLength(2); // the rerun ran
    h.resolveNext("<div>retry worked</div>");
    await flush();
    expect(h.failed).toHaveLength(0);
    expect(h.ready).toHaveLength(1);
    expect(h.deck.get("u1")?.html).toBe("<div>retry worked</div>");
  });

  it("reports the LAST pass's failure when the rerun fails too", async () => {
    const h = harness();
    h.ensureSlide("a1", "u1");
    await flush();
    h.ensureSlide("a1", "u1", { force: true });
    h.rejectNext("first pass exploded");
    await flush();
    h.rejectNext("rerun exploded too");
    await flush();
    expect(h.failed).toHaveLength(1); // once, not once per pass
    expect(h.failed[0].reason).toBe("generation_failed");
  });
});

describe("drainOnSettle (universal turn-settled drain)", () => {
  it("fires onSettled with the anchor when the turn promise RESOLVES", async () => {
    const seen: string[] = [];
    const d = deferred<void>();
    drainOnSettle(
      d.promise,
      () => "u1",
      (e) => seen.push(e),
    );
    d.resolve();
    await flush();
    expect(seen).toEqual(["u1"]);
  });

  it("fires onSettled when the turn promise REJECTS (error/swap/kill path)", async () => {
    const seen: string[] = [];
    const d = deferred<void>();
    drainOnSettle(
      d.promise,
      () => "u1",
      (e) => seen.push(e),
    );
    d.reject(new Error("session swapped"));
    await flush();
    expect(seen).toEqual(["u1"]); // reject still drains, no unhandled rejection
  });

  it("reads the anchor AT settle time and no-ops when it is null", async () => {
    const seen: string[] = [];
    let anchor: string | null = null;
    const d = deferred<void>();
    drainOnSettle(
      d.promise,
      () => anchor,
      (e) => seen.push(e),
    );
    anchor = "u9"; // stamped after wiring, before settle (as addLogEntry does)
    d.resolve();
    await flush();
    expect(seen).toEqual(["u9"]);

    const seen2: string[] = [];
    const d2 = deferred<void>();
    drainOnSettle(
      d2.promise,
      () => null, // a turn with no user_message anchor
      (e) => seen2.push(e),
    );
    d2.resolve();
    await flush();
    expect(seen2).toEqual([]);
  });

  it("drains a gated request end-to-end: gate -> settle -> generate once", async () => {
    // The real wiring: ensure while non-terminal parks a waiter and generates
    // nothing; settling the turn promise via drainOnSettle invokes onTurnSettled
    // which generates exactly once.
    const h = harness();
    h.setTerminal("u1", false);
    h.ensureSlide("a1", "u1"); // gated -> parked
    await flush();
    expect(h.calls).toHaveLength(0);

    const record = { anchorEntryId: "u1" as string | null };
    const d = deferred<void>();
    drainOnSettle(
      d.promise,
      () => record.anchorEntryId,
      (e) => {
        h.setTerminal("u1", true); // turn is now terminal at settle
        h.onTurnSettled("a1", e);
      },
    );
    d.resolve();
    await flush();
    expect(h.calls).toHaveLength(1); // generated exactly once on settle
  });
});

describe("slide prompt + output helpers", () => {
  it("buildFormatterPrompt includes prompt, answer, style ref, and feedback", () => {
    const p = buildFormatterPrompt(turn(), "<div>prev</div>", "make it teal");
    expect(p).toContain("What is 2+2?");
    expect(p).toContain("It is 4.");
    expect(p).toContain("<div>prev</div>");
    expect(p).toContain("make it teal");
  });

  it("extractSlideHtml strips a stray code fence", () => {
    expect(extractSlideHtml("```html\n<div>x</div>\n```")).toBe("<div>x</div>");
  });

  it("extractSlideHtml throws when the model didn't return a root div", () => {
    expect(() => extractSlideHtml("Sorry, I can't.")).toThrow();
    expect(() => extractSlideHtml("<span>x</span>")).toThrow();
    expect(() => extractSlideHtml("<div>a</div><div>b</div>")).toThrow(); // multi-root
  });

  it("extractSlideHtml rejects network-capable / scriptable markup", () => {
    expect(() => extractSlideHtml('<div><img src="x"></div>')).toThrow();
    expect(() =>
      extractSlideHtml('<div><a href="http://x">y</a></div>'),
    ).toThrow();
    expect(() => extractSlideHtml("<div><script>1</script></div>")).toThrow();
    expect(() =>
      extractSlideHtml('<div style="background:url(http://x)">y</div>'),
    ).toThrow();
    expect(() => extractSlideHtml('<div onclick="x()">y</div>')).toThrow();
    expect(() => extractSlideHtml("<div><svg></svg></div>")).toThrow();
  });

  it("extractSlideHtml accepts a clean inline-styled slide", () => {
    const good =
      '<div style="width:100%;height:100%"><h1 style="color:#6ea8fe">Hi</h1></div>';
    expect(extractSlideHtml(good)).toBe(good);
  });

  it("extractSlideHtml accepts code TEXT that merely mentions href/url()/data:", () => {
    // "copy code verbatim": these are text/code nodes, not real markup - the CSP
    // is the boundary, so the validator must not reject them.
    const cases = [
      "<div><pre>&lt;a href=&quot;/docs&quot;&gt;</pre></div>",
      "<div><pre>background: url(/hero.png)</pre></div>",
      "<div><code>data:text/plain,hi</code></div>",
      "<div><code>curl https://api.example/v1</code></div>",
    ];
    for (const c of cases) expect(extractSlideHtml(c)).toBe(c);
  });

  it("extractSlideHtml treats a '>' inside a quoted attribute as one root", () => {
    // The quote-aware tokenizer keeps the tag intact, so the single-root check
    // isn't fooled into seeing a sibling.
    const good = `<div style="content:'a>b'"><span style="color:#6ea8fe">x</span></div>`;
    expect(extractSlideHtml(good)).toBe(good);
  });
});
