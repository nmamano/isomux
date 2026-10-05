import { describe, expect, it } from "bun:test";
import {
  applyRoomOrder,
  roomsInOrder,
  settlePending,
  startPending,
  visiblePending,
  type PendingView,
} from "./pending-view.ts";

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

  it("reports whether the rooms already follow an order", () => {
    expect(roomsInOrder(rooms("b", "a"), ["b", "a"])).toBe(true);
    expect(roomsInOrder(rooms("a", "b"), ["b", "a"])).toBe(false);
  });
});

type Server = { id: string }[];

describe("pending view state machine", () => {
  const show = (
    pending: PendingView<Server, string[]> | null,
    server: Server,
  ) => visiblePending(pending, server, roomsInOrder);

  it("shows the written value while the write is in flight", () => {
    const server = rooms("a", "b");
    const pending = startPending<Server, string[]>(1, ["b", "a"]);
    expect(show(pending, server)).toEqual(["b", "a"]);
    // Server states that arrive before the write settles keep the overlay:
    // an unrelated push, and a late older state.
    expect(show(pending, rooms("a", "b", "c"))).toEqual(["b", "a"]);
  });

  it("drops the overlay at once when the newest write fails", () => {
    const server = rooms("a", "b");
    const pending = settlePending(
      startPending<Server, string[]>(1, ["b", "a"]),
      1,
      false,
      server,
    );
    expect(pending).toBeNull();
    expect(show(pending, server)).toBeNull();
  });

  it("ignores a response for an older write", () => {
    const server = rooms("a", "b", "c");
    const newer = startPending<Server, string[]>(2, ["c", "a", "b"]);
    expect(settlePending(newer, 1, false, server)).toBe(newer);
    expect(settlePending(newer, 1, true, server)).toBe(newer);
    expect(show(newer, server)).toEqual(["c", "a", "b"]);
  });

  it("drops on success when the server state already matches", () => {
    const confirmed = rooms("b", "a");
    const pending = settlePending(
      startPending<Server, string[]>(1, ["b", "a"]),
      1,
      true,
      confirmed,
    );
    expect(show(pending, confirmed)).toBeNull();
  });

  it("holds after success until the next server state, then drops", () => {
    const before = rooms("a", "b");
    const pending = settlePending(
      startPending<Server, string[]>(1, ["b", "a"]),
      1,
      true,
      before,
    );
    expect(show(pending, before)).toEqual(["b", "a"]);
    // Any later server state is the truth, even one that does not match
    // (the server clamped the order, or another device reordered).
    expect(show(pending, rooms("a", "b"))).toBeNull();
    expect(show(pending, rooms("b", "a"))).toBeNull();
  });
});
