import { describe, expect, test } from "bun:test";
import { roomsInMemberOrder } from "./UserSettingsView.tsx";

const rooms = ["a", "b", "c", "d"].map((id) => ({ id, name: id }));
const ids = (rs: { id: string }[]) => rs.map((r) => r.id);

describe("roomsInMemberOrder", () => {
  test("listed rooms first in the member's order, the rest in office order", () => {
    expect(ids(roomsInMemberOrder(rooms, ["c", "a"]))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  test("an empty order keeps the office order", () => {
    expect(ids(roomsInMemberOrder(rooms, []))).toEqual(["a", "b", "c", "d"]);
  });

  test("ids in the order that are not rooms are skipped", () => {
    expect(ids(roomsInMemberOrder(rooms, ["gone", "d"]))).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });
});
