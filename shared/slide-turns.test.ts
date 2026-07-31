import { describe, it, expect } from "bun:test";
import {
  buildDeckTurns,
  findDeckTurn,
  nextDeckIndex,
  settledDeckPos,
  restoredDeckPos,
  shouldRequestSlide,
  slideContentDigest,
  turnIsTerminal,
} from "./slide-turns.ts";
import type { LogEntry } from "./types.ts";

let seq = 0;
function entry(
  kind: LogEntry["kind"],
  content: string,
  extra: Partial<LogEntry> = {},
): LogEntry {
  seq += 1;
  return {
    id: extra.id ?? `e${seq}`,
    agentId: "a1",
    timestamp: seq,
    kind,
    content,
    ...extra,
  };
}

describe("buildDeckTurns", () => {
  it("splits at user_message and concatenates text spans", () => {
    const turns = buildDeckTurns([
      entry("system", "boot"), // pre-first-turn: no anchor, dropped
      entry("user_message", "hello", { id: "u1" }),
      entry("thinking", "hmm"),
      entry("text", "part one"),
      entry("tool_call", "ls"),
      entry("text", "part two"),
      entry("user_message", "again", { id: "u2" }),
      entry("text", "second answer"),
    ]);
    expect(turns.map((t) => t.entryId)).toEqual(["u1", "u2"]);
    expect(turns[0].promptText).toBe("hello");
    expect(turns[0].assistantText).toBe("part one\n\npart two");
    expect(turns[0].placeholder).toBe(false);
    expect(turns[1].assistantText).toBe("second answer");
  });

  it("marks a tool-only / empty turn as a placeholder", () => {
    const turns = buildDeckTurns([
      entry("user_message", "do it", { id: "u1" }),
      entry("tool_call", "run"),
      entry("tool_result", "done"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].placeholder).toBe(true);
    expect(turns[0].assistantText).toBe("");
    expect(turns[0].errorText).toBeNull();
  });

  it("captures error text on a failed turn (still a placeholder if no text)", () => {
    const turns = buildDeckTurns([
      entry("user_message", "go", { id: "u1" }),
      entry("error", "it broke"),
    ]);
    expect(turns[0].placeholder).toBe(true);
    expect(turns[0].errorText).toBe("it broke");
  });

  it("ignores ephemeral UI markers", () => {
    const turns = buildDeckTurns([
      entry("user_message", "x", { id: "u1" }),
      entry("system", "Conversation cleared.", { ephemeral: true }),
      entry("text", "answer"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantText).toBe("answer");
  });

  it("findDeckTurn returns the matching anchor or null", () => {
    const logs = [
      entry("user_message", "a", { id: "u1" }),
      entry("text", "A"),
      entry("user_message", "b", { id: "u2" }),
      entry("text", "B"),
    ];
    expect(findDeckTurn(logs, "u2")?.assistantText).toBe("B");
    expect(findDeckTurn(logs, "nope")).toBeNull();
  });
});

describe("turnIsTerminal (settled/boot terminal boundary)", () => {
  it("the currently-running turn's anchor is NOT terminal", () => {
    expect(turnIsTerminal("u5", "u5")).toBe(false);
  });

  it("any other turn IS terminal while one is running", () => {
    expect(turnIsTerminal("u5", "u3")).toBe(true);
  });

  it("with NO running turn (post-boot pendingTurn=null), every turn is terminal", () => {
    // The boot terminal boundary: a restart restores pendingTurn=null, so a
    // persisted partial tail reads terminal and its slide is generated from the
    // persisted transcript rather than gated forever.
    expect(turnIsTerminal(null, "u9")).toBe(true);
    expect(turnIsTerminal(undefined, "u9")).toBe(true);
  });
});

describe("shouldRequestSlide (client request gating)", () => {
  const digested = { contentDigest: "abcd" };
  const digestless = { contentDigest: undefined };

  it("skips a verified (digested) cached slide", () => {
    expect(shouldRequestSlide(digested, false)).toBe(false);
    expect(shouldRequestSlide(digested, true)).toBe(false);
  });

  it("requests a miss or a digestless legacy record when nothing is in flight", () => {
    expect(shouldRequestSlide(undefined, false)).toBe(true); // gated newest / miss
    expect(shouldRequestSlide(digestless, false)).toBe(true); // legacy -> reconcile
  });

  it("dedupes while a request is in flight (pending)", () => {
    expect(shouldRequestSlide(undefined, true)).toBe(false);
    expect(shouldRequestSlide(digestless, true)).toBe(false);
  });

  it("doubles as the pending-CLOCK predicate: unverified means keep ticking", () => {
    // DeckView's clock effect runs while any VISIBLE turn lacks a verified
    // slide, expressed as shouldRequestSlide(cached, false) so the two
    // predicates can't drift. Absence alone would be wrong: a digestless
    // RENDERED record stays in the store while it is reconciled (only
    // placeholders are invalidated out of it), so if the clock ignored it,
    // nowTs would never advance, its in-flight marker would never expire, and
    // a silently-failed regeneration would never retry.
    expect(shouldRequestSlide(digestless, false)).toBe(true);
    expect(shouldRequestSlide(undefined, false)).toBe(true);
    expect(shouldRequestSlide(digested, false)).toBe(false);
  });

  it("can be re-requested after a terminal outcome clears the in-flight marker", () => {
    // A fetch rejection clears the marker with no cache -> requestable again (a
    // transport blip is not a verdict on the slide); a ready/slide_ready that
    // landed a digested slide -> skipped.
    expect(shouldRequestSlide(undefined, false)).toBe(true);
    expect(shouldRequestSlide(digested, false)).toBe(false);
  });

  // A REPORTED failure is terminal - the one outcome that stops the watchdog
  // (task 01a7327a). Without this, the 120s orphan retry would spend a model
  // call every two minutes on a turn the formatter just choked on.
  it("never re-requests a turn whose generation was reported failed", () => {
    expect(shouldRequestSlide(undefined, false, true)).toBe(false);
    expect(shouldRequestSlide(digestless, false, true)).toBe(false);
  });

  it("requests again once an explicit retry retires the failure mark", () => {
    // regen dispatches slide_retry before it POSTs, so by the time the request
    // effect runs the mark is gone and the turn is eligible again.
    expect(shouldRequestSlide(undefined, false, false)).toBe(true);
  });

  it("keeps the clock stopped for a failed turn (same predicate, no drift)", () => {
    // DeckView's tick effect is this predicate with inFlight=false. A failed
    // turn has nothing left to wait for, so the interval must not run for it.
    expect(shouldRequestSlide(undefined, false, true)).toBe(false);
  });

  // Task e9429ef3: a placeholder recorded for a turn that has since produced an
  // answer is provably stale, and the deck has no other way back from it - a
  // digest-bearing record was skipped unconditionally, so the "No answer to
  // show" card stuck until the viewer hit regenerate by hand.
  describe("stale placeholder", () => {
    const emptyTurn = { promptText: "q", assistantText: "", errorText: null };
    const answered = { ...emptyTurn, assistantText: "the answer" };
    const stalePlaceholder = {
      contentDigest: slideContentDigest(emptyTurn),
      placeholder: true,
    };

    it("re-requests a placeholder whose turn has since gained text", () => {
      expect(
        shouldRequestSlide(
          stalePlaceholder,
          false,
          false,
          slideContentDigest(answered),
        ),
      ).toBe(true);
    });

    it("keeps serving a placeholder that still matches its turn", () => {
      // A genuinely empty turn (interrupted / tool-only) is not stale.
      expect(
        shouldRequestSlide(
          stalePlaceholder,
          false,
          false,
          slideContentDigest(emptyTurn),
        ),
      ).toBe(false);
    });

    it("does not re-request a stale RENDERED slide (loop safety)", () => {
      // Deliberately narrow. A rendered slide is left alone even when the
      // digests disagree: were the client's log ever to differ from the
      // server's for a settled turn, a blanket mismatch rule would re-ask every
      // watchdog window forever. Restricted to placeholders, the re-ask happens
      // at most once - the regenerated record is no longer a placeholder.
      expect(
        shouldRequestSlide(
          { contentDigest: slideContentDigest(emptyTurn), placeholder: false },
          false,
          false,
          slideContentDigest(answered),
        ),
      ).toBe(false);
    });

    it("still dedupes while the re-request is in flight", () => {
      expect(
        shouldRequestSlide(
          stalePlaceholder,
          true,
          false,
          slideContentDigest(answered),
        ),
      ).toBe(false);
    });

    it("stops at a reported failure, stale or not", () => {
      expect(
        shouldRequestSlide(
          stalePlaceholder,
          false,
          true,
          slideContentDigest(answered),
        ),
      ).toBe(false);
    });
  });
});

describe("slideContentDigest (cache-validity fingerprint)", () => {
  it("changes when a placeholder turn gains assistant text", () => {
    // The reconciliation signal: a slide recorded while the turn was empty no
    // longer matches once the answer arrives.
    const empty = slideContentDigest({
      promptText: "q",
      assistantText: "",
      errorText: null,
    });
    const full = slideContentDigest({
      promptText: "q",
      assistantText: "the answer",
      errorText: null,
    });
    expect(empty).not.toBe(full);
  });

  it("is stable for identical content", () => {
    const t = { promptText: "q", assistantText: "hi", errorText: null };
    expect(slideContentDigest(t)).toBe(slideContentDigest({ ...t }));
  });

  it("distinguishes error text from assistant text", () => {
    expect(
      slideContentDigest({
        promptText: "q",
        assistantText: "x",
        errorText: null,
      }),
    ).not.toBe(
      slideContentDigest({
        promptText: "q",
        assistantText: "",
        errorText: "x",
      }),
    );
  });

  it("changes when the frozen prompt changes (every slide input covered)", () => {
    expect(
      slideContentDigest({
        promptText: "a",
        assistantText: "same",
        errorText: null,
      }),
    ).not.toBe(
      slideContentDigest({
        promptText: "b",
        assistantText: "same",
        errorText: null,
      }),
    );
  });

  it("length-prefix framing avoids field-boundary collisions", () => {
    // A naive `${prompt} ${answer}` join renders both of these as "a b c" and
    // collides; length-prefixing keeps the boundary unambiguous.
    expect(
      slideContentDigest({
        promptText: "a b",
        assistantText: "c",
        errorText: null,
      }),
    ).not.toBe(
      slideContentDigest({
        promptText: "a",
        assistantText: "b c",
        errorText: null,
      }),
    );
  });

  it("returns a 16-char (64-bit) hex string", () => {
    expect(
      slideContentDigest({
        promptText: "q",
        assistantText: "abc",
        errorText: null,
      }),
    ).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("nextDeckIndex", () => {
  it("follows the newest when the viewer was on the last slide as the deck grows", () => {
    // The bug this guards: index still points at the OLD last (4) while the deck
    // already grew to 6. Testing at-end against the grown length would read
    // false; against prevLen it correctly follows to the new last (5).
    expect(nextDeckIndex(4, 5, 6)).toBe(5);
    expect(nextDeckIndex(5, 6, 8)).toBe(7); // grew by more than one
  });

  it("stays put when the viewer was NOT on the last slide", () => {
    expect(nextDeckIndex(2, 5, 6)).toBe(2);
    expect(nextDeckIndex(0, 5, 9)).toBe(0);
  });

  it("clamps into range when the deck shrinks past the cursor", () => {
    expect(nextDeckIndex(4, 5, 3)).toBe(2); // /clear or edit-fork shrank it
    expect(nextDeckIndex(1, 5, 3)).toBe(1); // still in range, unchanged
  });

  it("handles empty / single-slide decks without going negative", () => {
    expect(nextDeckIndex(0, 0, 0)).toBe(0);
    expect(nextDeckIndex(0, 1, 1)).toBe(0);
  });
});

describe("settledDeckPos (what gets persisted on a length change)", () => {
  it("marks atEnd when a SHRINK makes the unchanged cursor the new last slide", () => {
    // The P2 case: viewer at index 1 of a 5-deck (not at end). An edit/fork
    // shrinks the deck to 2; index stays 1 but 1 is now the last slide, so the
    // persisted atEnd must flip to true - otherwise re-entry treats them as
    // intentionally behind and won't follow newest.
    expect(settledDeckPos(1, 5, 2)).toEqual({ index: 1, atEnd: true });
  });

  it("keeps atEnd true while following the newest as the deck grows", () => {
    expect(settledDeckPos(4, 5, 6)).toEqual({ index: 5, atEnd: true });
  });

  it("stays behind (atEnd false) when the viewer was not on the last slide", () => {
    expect(settledDeckPos(2, 5, 6)).toEqual({ index: 2, atEnd: false });
  });

  it("clamps and marks atEnd when a shrink lands the cursor on the last slide", () => {
    expect(settledDeckPos(4, 5, 3)).toEqual({ index: 2, atEnd: true });
  });
});

describe("restoredDeckPos (what gets shown + persisted on first open)", () => {
  it("no saved position → newest, atEnd", () => {
    expect(restoredDeckPos(null, 5)).toEqual({ index: 4, atEnd: true });
  });

  it("saved at-end → follows newest even if the deck grew since", () => {
    expect(restoredDeckPos({ index: 2, atEnd: true }, 6)).toEqual({
      index: 5,
      atEnd: true,
    });
  });

  it("saved behind → restores that slide, still behind", () => {
    expect(restoredDeckPos({ index: 1, atEnd: false }, 5)).toEqual({
      index: 1,
      atEnd: false,
    });
  });

  it("saved-behind index that clamps onto the (now shorter) last slide becomes atEnd", () => {
    // The first-load P2: {index:0, atEnd:false} but the deck is now one slide -
    // index 0 is at-end, so the persisted position must record atEnd:true, or
    // re-entry keeps treating the viewer as intentionally behind.
    expect(restoredDeckPos({ index: 0, atEnd: false }, 1)).toEqual({
      index: 0,
      atEnd: true,
    });
    // Any out-of-range saved index that clamps to the last slide, likewise.
    expect(restoredDeckPos({ index: 9, atEnd: false }, 3)).toEqual({
      index: 2,
      atEnd: true,
    });
  });
});
