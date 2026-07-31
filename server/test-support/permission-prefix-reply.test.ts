// T0 unit tier: the permission prompt's option-4 reply parser.
//
// The prompt is answered in plain chat, and every reply that isn't a
// recognized option is treated as a DENIAL with that text as the reason. So
// the boundary here is load-bearing in both directions: "4 rg --files" must be
// read as an allow (denying it would be baffling), and near-misses like "42"
// or "4x" must NOT be, or a typo would silently widen what an agent may run.
import { describe, expect, it } from "bun:test";

import { parsePrefixAllowReply } from "../agent-manager.ts";

describe("parsePrefixAllowReply", () => {
  it("bare 4 means 'take the rule the backend proposed'", () => {
    expect(parsePrefixAllowReply("4")).toEqual({ prefixText: "" });
  });

  it("4 <prefix> carries the user's own choice as raw text", () => {
    expect(parsePrefixAllowReply("4 rg --files")).toEqual({
      prefixText: "rg --files",
    });
    // Ragged spacing is a human typing in a chat box, not a different intent.
    expect(parsePrefixAllowReply("4   cargo   test  ")).toEqual({
      prefixText: "cargo   test",
    });
  });

  it("anything that isn't option 4 is left to the other branches", () => {
    for (const reply of [
      "42",
      "4x",
      "-4",
      "44 rg",
      "3",
      "",
      "no",
      "please allow 4",
    ]) {
      expect(parsePrefixAllowReply(reply)).toBeNull();
    }
  });
});
