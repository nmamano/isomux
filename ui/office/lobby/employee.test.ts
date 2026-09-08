import { expect, test } from "bun:test";
import { CROWN_HOLD_MS, crownHolder, employeeOfTheMinute } from "./employee.ts";

// Ported from git tag eotm-plaque (RoomProps.test.ts) with the room filter
// removed: the lobby plaque is office-wide.

const seat = (id: string, roomId: string, desk: number) => ({
  id,
  roomId,
  desk,
});

test("the plaque names the agent that acted last in any room", () => {
  const agents = [seat("a", "r1", 0), seat("b", "r1", 1), seat("c", "r2", 0)];
  const at = new Map([
    ["a", 100],
    ["b", 200],
    ["c", 900],
  ]);
  expect(employeeOfTheMinute(agents, at)?.id).toBe("c");
});

test("ties go to the lowest desk in the first room, not to arrival order", () => {
  const at = new Map([
    ["a", 500],
    ["b", 500],
    ["c", 500],
  ]);
  const agents = [seat("c", "r2", 0), seat("b", "r1", 3), seat("a", "r1", 1)];
  expect(employeeOfTheMinute(agents, at, ["r1", "r2"])?.id).toBe("a");
  expect(employeeOfTheMinute(agents, at, ["r2", "r1"])?.id).toBe("c");
  const none = new Map<string, number>();
  expect(
    employeeOfTheMinute([seat("b", "r1", 3), seat("a", "r1", 1)], none)?.id,
  ).toBe("a");
});

test("an empty office has no employee of the minute", () => {
  expect(employeeOfTheMinute([], new Map())).toBeNull();
});

test("an empty office crowns nobody, and any leader crowns an empty seat", () => {
  expect(crownHolder(null, null)).toBeNull();
  expect(crownHolder({ id: "a", at: 5 }, null)).toBeNull();
  expect(crownHolder(null, { id: "b", at: 5 })).toBe("b");
});

test("the holder keeps the crown while it is still the leader", () => {
  expect(crownHolder({ id: "a", at: 900 }, { id: "a", at: 900 })).toBe("a");
});

test("a livelier agent does not take the crown inside the hold", () => {
  const held = { id: "a", at: 1_000_000 };
  expect(
    crownHolder(held, { id: "b", at: 1_000_000 + CROWN_HOLD_MS - 1 }),
  ).toBe("a");
  expect(crownHolder(held, { id: "b", at: 1_000_000 + 1 })).toBe("a");
});

test("the crown moves once the holder has been out-acted by the hold", () => {
  const held = { id: "a", at: 1_000_000 };
  expect(crownHolder(held, { id: "b", at: 1_000_000 + CROWN_HOLD_MS })).toBe(
    "b",
  );
  expect(
    crownHolder(held, { id: "b", at: 1_000_000 + CROWN_HOLD_MS * 3 }),
  ).toBe("b");
});

test("a holder that acted later than the leader keeps the crown", () => {
  expect(crownHolder({ id: "a", at: 9_000 }, { id: "b", at: 1_000 })).toBe("a");
});
