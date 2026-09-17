import { describe, expect, it } from "bun:test";
import { citationBlock } from "./cite.ts";

describe("citationBlock", () => {
  it("fences the cited text and ends with a newline", () => {
    const block = citationBlock("one\ntwo");
    expect(block.startsWith('Cited text:\n"""\n')).toBe(true);
    expect(block.endsWith('\n"""\n')).toBe(true);
    expect(block).toContain("one\ntwo");
  });

  it("escapes every dollar so two of them never open inline math", () => {
    const block = citationBlock("GET localhost:$PORT/x with $TOKEN");
    expect(block).toContain("localhost:\\$PORT/x with \\$TOKEN");
    expect(block.match(/(?<!\\)\$/g)).toBeNull();
  });
});
