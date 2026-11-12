// The Recent list's bound (task 5dac6b9b). Ordering, the no-change rule and
// dead ids are proven through the route in
// test-support/sidebar-agents.test.ts; the bound needs more agents than a
// route test should spawn.

import { describe, expect, it } from "bun:test";
import { nextRecentAgents, RECENT_AGENTS_KEPT } from "./sidebar-agents.ts";

describe("nextRecentAgents", () => {
  it("keeps at most RECENT_AGENTS_KEPT ids and drops the oldest", () => {
    const ids = Array.from(
      { length: RECENT_AGENTS_KEPT + 1 },
      (_, i) => `a${i}`,
    );
    const live = new Set(ids);
    let list: string[] = [];
    for (const id of ids) list = nextRecentAgents(list, id, live) ?? list;
    expect(list.length).toBe(RECENT_AGENTS_KEPT);
    expect(list[0]).toBe(`a${RECENT_AGENTS_KEPT}`);
    // a0 was the oldest; a1 is now the last one kept.
    expect(list.includes("a0")).toBe(false);
    expect(list[RECENT_AGENTS_KEPT - 1]).toBe("a1");
  });

  it("an agent already first with a dead id behind it is still a change", () => {
    const live = new Set(["a", "c"]);
    expect(nextRecentAgents(["a", "b", "c"], "a", live)).toEqual(["a", "c"]);
    expect(nextRecentAgents(["a", "c"], "a", live)).toBeNull();
  });
});
