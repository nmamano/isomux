import { describe, expect, it } from "bun:test";
import { sessionMessagePreview, sessionResumeLabel } from "./session-label.ts";

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
