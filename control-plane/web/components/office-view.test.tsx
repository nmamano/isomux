import { expect, test } from "bun:test";
import { STATE_WORDS } from "./office-view";

test("waiting ladder steps say they have not started", () => {
  expect(STATE_WORDS.waiting).toBe("not started");
  expect(STATE_WORDS.active).toBe("in progress");
});
