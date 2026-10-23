import { describe, expect, it } from "bun:test";
import { applyRoomOrder } from "./pending-view.ts";

const rooms = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((r) => r.id);

describe("applyRoomOrder", () => {
  it("puts listed rooms first and keeps the others in their order", () => {
    expect(ids(applyRoomOrder(rooms("a", "b", "c", "d"), ["c", "a"]))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("skips unknown and repeated ids", () => {
    expect(ids(applyRoomOrder(rooms("a", "b"), ["x", "b", "b"]))).toEqual([
      "b",
      "a",
    ]);
  });
});
