// Spoken punctuation in voice input (task aaeebdb7). The recognizer hands back
// speech one segment at a time, so the two halves are tested together: the
// substitution inside a segment, and the joining of segments in the composer.
import { describe, expect, it } from "bun:test";
import {
  addFinalized,
  applySpokenPunctuation,
  dictationText,
  joinSpoken,
  startDictation,
  type Dictation,
} from "./spoken-punctuation.ts";

describe("applySpokenPunctuation", () => {
  it("converts sentence punctuation and hugs the preceding word", () => {
    expect(applySpokenPunctuation("is this on question mark")).toBe(
      "is this on?",
    );
    expect(applySpokenPunctuation("ship it period")).toBe("ship it.");
    expect(applySpokenPunctuation("ship it full stop")).toBe("ship it.");
    expect(applySpokenPunctuation("wait comma then go")).toBe("wait, then go");
    expect(applySpokenPunctuation("no exclamation mark")).toBe("no!");
    expect(applySpokenPunctuation("no exclamation point")).toBe("no!");
    expect(applySpokenPunctuation("note colon read this")).toBe(
      "note: read this",
    );
    expect(applySpokenPunctuation("one semicolon two")).toBe("one; two");
    expect(applySpokenPunctuation("one semi colon two")).toBe("one; two");
    expect(applySpokenPunctuation("hmm ellipsis maybe")).toBe("hmm... maybe");
  });

  it("hugs parentheses to the side they belong to", () => {
    expect(
      applySpokenPunctuation("run it open paren twice close paren today"),
    ).toBe("run it (twice) today");
    expect(
      applySpokenPunctuation(
        "run it open parenthesis twice close parenthesis today",
      ),
    ).toBe("run it (twice) today");
  });

  it("converts line breaks and trims the spaces around them", () => {
    expect(applySpokenPunctuation("first new line")).toBe("first\n");
    expect(applySpokenPunctuation("first newline")).toBe("first\n");
    expect(applySpokenPunctuation("first new paragraph")).toBe("first\n\n");
  });

  it("is case-insensitive and tolerates the recognizer's own spacing", () => {
    expect(applySpokenPunctuation("Question mark")).toBe("?");
    expect(applySpokenPunctuation("done PERIOD")).toBe("done.");
    expect(applySpokenPunctuation("done  question   mark")).toBe("done?");
  });

  it("matches whole words only", () => {
    expect(applySpokenPunctuation("periodic commacomma")).toBe(
      "periodic commacomma",
    );
    // "colon" inside "semicolon" must not be matched separately.
    expect(applySpokenPunctuation("a semicolon b")).toBe("a; b");
  });

  it("leaves ordinary text alone", () => {
    expect(applySpokenPunctuation("deploy the server now")).toBe(
      "deploy the server now",
    );
    expect(applySpokenPunctuation("")).toBe("");
  });

  // Sentence-terminal commands are gated on ending the fragment, so a spoken
  // sentence that merely contains one of these words comes out as prose.
  it("leaves a terminal command alone in the middle of a fragment", () => {
    expect(applySpokenPunctuation("a period of time")).toBe("a period of time");
    expect(applySpokenPunctuation("first new line second")).toBe(
      "first new line second",
    );
    expect(applySpokenPunctuation("a full stop sign")).toBe("a full stop sign");
    // Only the trailing one converts; the earlier one stays a word.
    expect(applySpokenPunctuation("a period of time period")).toBe(
      "a period of time.",
    );
  });

  // Unconditional marks keep the old behavior: they convert mid-fragment, and a
  // literal spoken use of one is collateral damage.
  it("converts an unconditional mark anywhere - the documented limitation", () => {
    expect(applySpokenPunctuation("put a comma there")).toBe("put a, there");
  });
});

describe("joinSpoken", () => {
  it("inserts a single separating space between words", () => {
    expect(joinSpoken("hello", "world")).toBe("hello world");
    expect(joinSpoken("hello ", "world")).toBe("hello world");
    expect(joinSpoken("hello", " world")).toBe("hello world");
    expect(joinSpoken("", "world")).toBe("world");
    expect(joinSpoken("hello", "")).toBe("hello");
  });

  it("hugs punctuation that arrives as its own segment", () => {
    expect(joinSpoken("hello", "?")).toBe("hello?");
    expect(joinSpoken("hello ", ".")).toBe("hello.");
    expect(joinSpoken("hello ", ", then")).toBe("hello, then");
    expect(joinSpoken("hello", "\nnext")).toBe("hello\nnext");
    expect(joinSpoken("hello ", "\nnext")).toBe("hello\nnext");
  });

  it("takes no space after an opening paren or a line break", () => {
    expect(joinSpoken("run it (", "twice")).toBe("run it (twice");
    expect(joinSpoken("first\n", "second")).toBe("first\nsecond");
  });
});

// The recognizer decides on its own where to end a result, so it is free to
// finalize "question" and "mark" as two separate results. These tests drive the
// session the way LogView's onresult handler does: fold finals in one at a
// time, pass the revisable interim guess separately.
describe("dictation session", () => {
  /** Replay a run of recognizer results. Strings are finals; the last entry may
   *  be an interim guess, which is passed through rather than folded in. */
  function replay(base: string, finals: string[], interim = ""): string {
    let d: Dictation = startDictation(base);
    for (const f of finals) d = addFinalized(d, f);
    return dictationText(d, interim);
  }

  it("recognizes an unconditional mark split across two finalized results", () => {
    expect(replay("", ["is this on", "question", "mark"])).toBe("is this on?");
    expect(replay("", ["no", "exclamation", "point"])).toBe("no!");
    expect(replay("", ["run it", "open", "paren", "twice"])).toBe(
      "run it (twice",
    );
  });

  it("recognizes an unconditional mark straddling the final/interim boundary", () => {
    expect(replay("", ["is this on", "question"], "mark")).toBe("is this on?");
  });

  it("converts a terminal command that ends its fragment", () => {
    expect(replay("", ["ship it period"])).toBe("ship it.");
    expect(replay("", ["first new line"])).toBe("first\n");
    // A later fragment continuing the dictation does not retract it: what
    // blocks the conversion is more text in the SAME fragment.
    expect(replay("", ["ship it period", "and go"])).toBe("ship it. and go");
    expect(replay("", ["first new line", "second"])).toBe("first\nsecond");
    expect(replay("", ["first new paragraph", "second"])).toBe(
      "first\n\nsecond",
    );
  });

  it("leaves a terminal command split across fragments alone", () => {
    // The gate is "ends the fragment it arrived in", so a phrase the recognizer
    // broke in two has no fragment to end. Deliberate: unlike the unconditional
    // marks, these are not assembled across the join.
    expect(replay("", ["say full", "stop"])).toBe("say full stop");
    expect(replay("", ["first new", "line", "second"])).toBe(
      "first new line second",
    );
  });

  it("converts a terminal command in the interim guess, and takes it back", () => {
    const d = startDictation("");
    // Fragment-final while the guess ends there...
    expect(dictationText(d, "ship it period")).toBe("ship it.");
    // ...and back to prose as the guess grows past it.
    expect(dictationText(d, "ship it period of")).toBe("ship it period of");
    expect(dictationText(d, "ship it period of time")).toBe(
      "ship it period of time",
    );
    // Same when the guess follows an already-finalized fragment.
    const withFinal = addFinalized(startDictation(""), "hello");
    expect(dictationText(withFinal, "new line")).toBe("hello\n");
    expect(dictationText(withFinal, "new lines of code")).toBe(
      "hello new lines of code",
    );
  });

  it("revises the interim guess without leaving anything behind", () => {
    const d = addFinalized(startDictation(""), "is this on");
    // The recognizer walks its hypothesis forward and may back out of it
    // entirely; each render recomputes from the finals plus the current guess.
    expect(dictationText(d, "question")).toBe("is this on question");
    expect(dictationText(d, "question mark")).toBe("is this on?");
    expect(dictationText(d, "quest")).toBe("is this on quest");
    expect(dictationText(d, "")).toBe("is this on");
  });

  it("never rewrites the text the user typed before opening the mic", () => {
    // "period" in the typed base stays a word; only speech is substituted.
    expect(replay("a period of time", ["is long", "period"])).toBe(
      "a period of time is long.",
    );
    expect(replay("typed draft", [], "hello")).toBe("typed draft hello");
    expect(replay("hello", ["question mark"])).toBe("hello?");
    expect(replay("", [])).toBe("");
  });
});
