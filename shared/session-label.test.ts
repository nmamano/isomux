import { describe, expect, it } from "bun:test";
import {
  UNTITLED_CONVERSATION_LABEL,
  sessionMessagePreview,
  sessionResumeLabel,
} from "./session-label.ts";

describe("session resume labels", () => {
  it("uses topic, then the first user message, then a neutral label", () => {
    expect(
      sessionResumeLabel({ topic: "Topic", firstUserMessage: "Hello" }),
    ).toBe("Topic");
    expect(sessionResumeLabel({ topic: null, firstUserMessage: "Hello" })).toBe(
      "Hello",
    );
    expect(sessionResumeLabel({ topic: null, firstUserMessage: null })).toBe(
      "Untitled conversation",
    );
  });

  it("normalizes a first message into a bounded single-line preview", () => {
    expect(sessionMessagePreview("  Plan\n\nthis   work  ")).toBe(
      "Plan this work",
    );
    expect(sessionMessagePreview("x".repeat(100))).toHaveLength(80);
  });

  it("bounds and normalizes a stored first-message fallback at read time", () => {
    expect(
      sessionResumeLabel({
        topic: `  ${"topic ".repeat(20)}\nlabel  `,
        firstUserMessage: "Fallback",
      }),
    ).toBe("topic ".repeat(14).slice(0, 80));
    expect(
      sessionResumeLabel({
        topic: null,
        firstUserMessage: `  ${"long ".repeat(30)}\nrequest  `,
      }),
    ).toBe("long ".repeat(16).slice(0, 80));
  });
});

// The fallback the UI supplies from its catalog (internal-docs/i18n-loop.md, S6).
// The default is what every server caller still gets, so this pins BOTH: that a
// supplied label reaches the empty case, and that no caller which passes
// nothing sees a byte change.
describe("the untitled fallback", () => {
  it("uses the supplied label only when there is nothing to preview", () => {
    expect(
      sessionResumeLabel(
        { topic: null, firstUserMessage: null },
        "Sense títol",
      ),
    ).toBe("Sense títol");
    expect(
      sessionResumeLabel(
        { topic: "Topic", firstUserMessage: null },
        "Sense títol",
      ),
    ).toBe("Topic");
    expect(
      sessionResumeLabel(
        { topic: "   ", firstUserMessage: "Hello" },
        "Sense títol",
      ),
    ).toBe("Hello");
  });

  it("still answers English to a caller that supplies nothing", () => {
    expect(sessionResumeLabel({ topic: null, firstUserMessage: null })).toBe(
      UNTITLED_CONVERSATION_LABEL,
    );
    expect(UNTITLED_CONVERSATION_LABEL).toBe("Untitled conversation");
  });
});
