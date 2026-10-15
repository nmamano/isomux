// Paging for GET /agents?killed=1 (task 9643a66a). Pure: no server, no disk.

import { describe, it, expect } from "bun:test";
import {
  parseKilledPageQuery,
  pageKilledAgents,
  KILLED_PAGE_DEFAULT,
  KILLED_PAGE_MAX,
} from "./killed-roster.ts";
import type { KilledAgentSummary } from "../shared/types.ts";

function killed(id: string, killedAt: number): KilledAgentSummary {
  return {
    id,
    name: id,
    agentType: "claude",
    lastRoomId: "r",
    lastRoomName: "R",
    topic: null,
    killedAt,
  };
}

const q = (s: string) => parseKilledPageQuery(new URLSearchParams(s));

describe("parseKilledPageQuery", () => {
  it("defaults to the first page of the default size", () => {
    expect(q("killed=1")).toEqual({
      ok: true,
      limit: KILLED_PAGE_DEFAULT,
      before: null,
    });
  });

  it("accepts limit at both bounds and a fractional before", () => {
    expect(q("limit=1")).toMatchObject({ ok: true, limit: 1 });
    expect(q(`limit=${KILLED_PAGE_MAX}`)).toMatchObject({
      ok: true,
      limit: KILLED_PAGE_MAX,
    });
    // A legacy entry's killedAt is a log dir mtime, with a fraction.
    expect(q("before=1700000000000.25")).toMatchObject({
      ok: true,
      before: 1700000000000.25,
    });
  });

  it("refuses a limit outside 1..max or not a whole number", () => {
    for (const bad of [
      "0",
      String(KILLED_PAGE_MAX + 1),
      "-1",
      "2.5",
      "1e2",
      "",
      " 5",
      "abc",
    ]) {
      expect(q(`limit=${encodeURIComponent(bad)}`).ok).toBe(false);
    }
  });

  it("refuses a before that is not a non-negative number", () => {
    for (const bad of ["", "-5", "1e12", "0x10", "abc", "1."]) {
      expect(q(`before=${encodeURIComponent(bad)}`).ok).toBe(false);
    }
  });
});

describe("pageKilledAgents", () => {
  const roster = [
    killed("e", 500),
    killed("d", 400),
    killed("c", 300),
    killed("b", 200),
    killed("a", 100),
  ];

  it("returns newest kill first, capped at limit", () => {
    expect(pageKilledAgents(roster, 2, null).map((k) => k.id)).toEqual([
      "e",
      "d",
    ]);
  });

  it("orders newest first even when the input is not sorted", () => {
    const shuffled = [roster[3], roster[0], roster[4], roster[2], roster[1]];
    expect(pageKilledAgents(shuffled, 5, null).map((k) => k.id)).toEqual([
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  it("walks every entry exactly once by passing the last killedAt as before", () => {
    const seen: string[] = [];
    let before: number | null = null;
    for (;;) {
      const page = pageKilledAgents(roster, 2, before);
      seen.push(...page.map((k) => k.id));
      if (page.length < 2) break;
      before = page[page.length - 1].killedAt;
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("is strict on before", () => {
    expect(pageKilledAgents(roster, 10, 300).map((k) => k.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("never splits equal kill times across two pages", () => {
    const tied = [
      killed("x", 300),
      killed("p", 200),
      killed("q", 200),
      killed("r", 200),
      killed("z", 100),
    ];
    const first = pageKilledAgents(tied, 2, null);
    // The page runs past limit to finish the 200 group.
    expect(first.map((k) => k.id)).toEqual(["x", "p", "q", "r"]);
    const second = pageKilledAgents(tied, 2, first[first.length - 1].killedAt);
    expect(second.map((k) => k.id)).toEqual(["z"]);
  });

  it("returns an empty page past the oldest kill", () => {
    expect(pageKilledAgents(roster, 2, 100)).toEqual([]);
  });
});
