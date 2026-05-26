// Tests for the strip-side of the plugin prefix wrap. The wrap itself is
// applied in `runAgentTurn` step 5 (see plugin-hooks.ts); these tests anchor
// the inverse operation so edit-message matching stays in sync with the
// wrap format if it ever changes.
//
// Regression for: a turn that lit up a `beforeTurn` plugin (e.g. mem0) got
// recorded into the SDK transcript as
// `--- begin plugin: <id> ---\n...\n--- end plugin: <id> ---\n\nUser message:\n<sdkText>`,
// but the isomux log entry only carried `<sdkText>` — agent-manager's
// editMessage matcher used strict equality and therefore failed every edit
// on a plugin-prefixed turn with "Cannot edit: could not locate message in
// backend session."

import { describe, expect, it } from "bun:test";

import { stripPluginPrefix } from "./plugin-hooks.ts";

describe("stripPluginPrefix", () => {
  it("returns text unchanged when no plugin wrap is present", () => {
    expect(stripPluginPrefix("[Nil] hello world")).toBe("[Nil] hello world");
    expect(stripPluginPrefix("")).toBe("");
  });

  it("strips a single-plugin wrap and returns the original sdkText", () => {
    const sdkText = "[Nil] what does mem0 do?";
    const wrapped =
      "--- begin plugin: mem0 ---\n" +
      "Relevant facts retrieved from memory:\n- fact one\n" +
      "--- end plugin: mem0 ---\n\n" +
      "User message:\n" +
      sdkText;
    expect(stripPluginPrefix(wrapped)).toBe(sdkText);
  });

  it("strips a multi-plugin wrap (blocks joined by blank lines)", () => {
    const sdkText = "[Nil] go";
    const wrapped =
      "--- begin plugin: alpha ---\nA-prefix\n--- end plugin: alpha ---\n\n" +
      "--- begin plugin: beta ---\nB-prefix\n--- end plugin: beta ---\n\n" +
      "User message:\n" +
      sdkText;
    expect(stripPluginPrefix(wrapped)).toBe(sdkText);
  });

  it("does not split on a literal '\\n\\nUser message:\\n' that appears inside the user's own text", () => {
    // User text itself contains the separator AFTER a non-`---` line.
    // The strip must anchor on the structural `--- end plugin: <id> ---`
    // boundary, not just any occurrence of the separator.
    const sdkText =
      "[Nil] I want to talk about\n\nUser message:\nthis literal block";
    const wrapped =
      "--- begin plugin: mem0 ---\nfact\n--- end plugin: mem0 ---\n\n" +
      "User message:\n" +
      sdkText;
    expect(stripPluginPrefix(wrapped)).toBe(sdkText);
  });

  it("does not split when a plugin prefix ends with '---' but isn't a real closing line", () => {
    // Reviewer5's edge case: a stored fact (or prefix body) that ends with
    // `---` and is followed by `\n\nUser message:\n` shouldn't fool the
    // matcher — only the real `--- end plugin: <id> ---` line counts.
    const sdkText = "[Nil] real payload";
    const wrapped =
      "--- begin plugin: mem0 ---\n" +
      // Prefix body whose last line is exactly `---` (three dashes).
      "ascii art divider:\n---\n" +
      // The real closing line.
      "--- end plugin: mem0 ---\n\n" +
      "User message:\n" +
      sdkText;
    expect(stripPluginPrefix(wrapped)).toBe(sdkText);
  });

  it("returns text unchanged when it starts with the wrap marker but lacks the separator", () => {
    // Defensive: a corrupt or partial wrap should not silently truncate.
    const malformed = "--- begin plugin: x ---\nbody\n--- end plugin: x ---";
    expect(stripPluginPrefix(malformed)).toBe(malformed);
  });

  it("does not strip when text doesn't start with a plugin marker, even if separator appears inside", () => {
    // A regular user message that happens to contain the separator pattern
    // is not a wrap. The startsWith guard prevents false-positive stripping.
    const sneaky =
      "[Nil] my code prints `--- end plugin: foo ---\n\nUser message:\nbar`";
    expect(stripPluginPrefix(sneaky)).toBe(sneaky);
  });
});
