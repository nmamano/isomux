import { expect, it } from "bun:test";
import { appendBlockToDraft } from "./draft-append.ts";

it("appends after a blank line and never replaces the draft", () => {
  expect(appendBlockToDraft("", "b")).toBe("b");
  expect(appendBlockToDraft("a", "b")).toBe("a\n\nb");
  expect(appendBlockToDraft("a\n", "b")).toBe("a\n\nb");
  expect(appendBlockToDraft("a\n\n", "b")).toBe("a\n\nb");
});
