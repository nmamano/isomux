// One member's view of one room as one ordered level (task 611c968e). The
// record keeps four room-id lists; the level is a read of them, and a level
// write changes only the one room.

import { describe, expect, it } from "bun:test";
import {
  ROOM_VIEW_LEVELS,
  normalizeRoomViewLists,
  roomViewLevel,
  withRoomViewLevel,
  type RoomViewLevel,
  type RoomViewListsIn,
} from "./room-view-level.ts";

const lists = (over: Partial<RoomViewListsIn> = {}): RoomViewListsIn => ({
  hidden: [],
  tucked: [],
  notifRooms: [],
  pushRooms: [],
  ...over,
});

// The migration table (hand-off and sign-off item): each stored combination
// for room "x", the level it reads as, and the lists after normalization.
// "y" is another room in every list, so a row also shows that normalization
// touches only the rooms that break the invariant.
const ROWS: {
  what: string;
  x: { hidden?: true; tucked?: true; notif?: true; push?: true };
  level: RoomViewLevel;
  after: { hidden: boolean; tucked: boolean; notif: boolean; push: boolean };
}[] = [
  {
    what: "hidden with every other flag",
    x: { hidden: true, tucked: true, notif: true, push: true },
    level: "hidden",
    // A hidden room keeps its tucked flag (it comes back tucked when shown).
    after: { hidden: true, tucked: true, notif: false, push: false },
  },
  {
    what: "hidden only",
    x: { hidden: true },
    level: "hidden",
    after: { hidden: true, tucked: false, notif: false, push: false },
  },
  {
    what: "tucked with notifications and push",
    x: { tucked: true, notif: true, push: true },
    level: "tucked",
    after: { hidden: false, tucked: true, notif: false, push: false },
  },
  {
    what: "tucked with push only",
    x: { tucked: true, push: true },
    level: "tucked",
    after: { hidden: false, tucked: true, notif: false, push: false },
  },
  {
    what: "shown, nothing else",
    x: {},
    level: "shown",
    after: { hidden: false, tucked: false, notif: false, push: false },
  },
  {
    what: "notifications only",
    x: { notif: true },
    level: "notify",
    after: { hidden: false, tucked: false, notif: true, push: false },
  },
  {
    what: "push only",
    x: { push: true },
    level: "push",
    // Push comes with notifications: the member gains the sound.
    after: { hidden: false, tucked: false, notif: true, push: true },
  },
  {
    what: "notifications and push",
    x: { notif: true, push: true },
    level: "push",
    after: { hidden: false, tucked: false, notif: true, push: true },
  },
];

const seeded = (x: (typeof ROWS)[number]["x"]): RoomViewListsIn =>
  lists({
    hidden: x.hidden ? ["y", "x"] : ["y"],
    tucked: x.tucked ? ["x", "y"] : ["y"],
    notifRooms: x.notif ? ["x", "z"] : ["z"],
    pushRooms: x.push ? ["z", "x"] : ["z"],
  });

describe("roomViewLevel", () => {
  it("lists the levels from least to most", () => {
    expect([...ROOM_VIEW_LEVELS]).toEqual([
      "hidden",
      "tucked",
      "shown",
      "notify",
      "push",
    ]);
  });

  for (const row of ROWS) {
    it(`${row.what} reads as ${row.level}`, () => {
      expect(roomViewLevel(seeded(row.x), "x")).toBe(row.level);
    });
  }

  it("reads a record from a server older than tucked and pushRooms", () => {
    expect(roomViewLevel({ hidden: [], notifRooms: ["x"] }, "x")).toBe(
      "notify",
    );
    expect(roomViewLevel({ hidden: [], notifRooms: [] }, "x")).toBe("shown");
  });
});

describe("normalizeRoomViewLists", () => {
  for (const row of ROWS) {
    it(`${row.what}: ${JSON.stringify(row.after)}, other rooms untouched`, () => {
      const out = normalizeRoomViewLists(seeded(row.x));
      expect({
        hidden: out.hidden.includes("x"),
        tucked: out.tucked.includes("x"),
        notif: out.notifRooms.includes("x"),
        push: out.pushRooms.includes("x"),
      }).toEqual(row.after);
      // "y" is hidden and tucked, "z" notifies and pushes: both are valid,
      // so they keep their places.
      expect(out.hidden.filter((id) => id !== "x")).toEqual(["y"]);
      expect(out.tucked.filter((id) => id !== "x")).toEqual(["y"]);
      expect(out.notifRooms.filter((id) => id !== "x")).toEqual(["z"]);
      expect(out.pushRooms.filter((id) => id !== "x")).toEqual(["z"]);
      // The normalized lists read as the same level.
      expect(roomViewLevel(out, "x")).toBe(row.level);
    });
  }

  it("leaves lists that already hold the invariant as they are, order included", () => {
    const valid = {
      hidden: ["h2", "h1"],
      tucked: ["t1", "h1"],
      notifRooms: ["n2", "p1", "n1"],
      pushRooms: ["p1"],
    };
    expect(normalizeRoomViewLists(valid)).toEqual(valid);
  });

  it("gives an old record its missing lists as empty", () => {
    expect(normalizeRoomViewLists({ hidden: [], notifRooms: ["x"] })).toEqual({
      hidden: [],
      tucked: [],
      notifRooms: ["x"],
      pushRooms: [],
    });
  });
});

describe("withRoomViewLevel", () => {
  // Every level from every starting row: the room lands on exactly the
  // level asked for, and every other room's entries keep their places.
  const others = {
    hidden: ["h1", "h2"],
    tucked: ["t1", "h2"],
    notifRooms: ["n1", "p1"],
    pushRooms: ["p1"],
  };
  const withX = (x: (typeof ROWS)[number]["x"]): RoomViewListsIn => {
    const at = (list: string[], on: boolean | undefined) =>
      on ? [list[0], "x", ...list.slice(1)] : [...list];
    return {
      hidden: at(others.hidden, x.hidden),
      tucked: at(others.tucked, x.tucked),
      notifRooms: at(others.notifRooms, x.notif || x.push),
      pushRooms: at(others.pushRooms, x.push),
    };
  };

  for (const row of ROWS) {
    for (const level of ROOM_VIEW_LEVELS) {
      it(`${row.what} -> ${level}`, () => {
        const before = withX(row.x);
        const out = withRoomViewLevel(before, "x", level);
        expect(roomViewLevel(out, "x")).toBe(level);
        expect(out.hidden.filter((id) => id !== "x")).toEqual(others.hidden);
        expect(out.tucked.filter((id) => id !== "x")).toEqual(others.tucked);
        expect(out.notifRooms.filter((id) => id !== "x")).toEqual(
          others.notifRooms,
        );
        expect(out.pushRooms.filter((id) => id !== "x")).toEqual(
          others.pushRooms,
        );
        // The result holds the stored-data invariant.
        expect(normalizeRoomViewLists(out)).toEqual(out);
        // Exactly the memberships the level stands for. Hidden leaves the
        // tucked flag as it was.
        const rank = ROOM_VIEW_LEVELS.indexOf(level);
        expect({
          hidden: out.hidden.includes("x"),
          tucked: out.tucked.includes("x"),
          notif: out.notifRooms.includes("x"),
          push: out.pushRooms.includes("x"),
        }).toEqual({
          hidden: level === "hidden",
          tucked:
            level === "hidden"
              ? before.tucked!.includes("x")
              : level === "tucked",
          notif: rank >= ROOM_VIEW_LEVELS.indexOf("notify"),
          push: level === "push",
        });
      });
    }
  }

  it("does not change its input", () => {
    const before = withX({ notif: true });
    const copy = structuredClone(before);
    withRoomViewLevel(before, "x", "hidden");
    withRoomViewLevel(before, "x", "push");
    expect(before).toEqual(copy);
  });

  it("an entry that already has the room keeps it in its place", () => {
    const before = withX({ notif: true, push: true });
    const out = withRoomViewLevel(before, "x", "push");
    expect(out.notifRooms).toEqual(before.notifRooms as string[]);
    expect(out.pushRooms).toEqual(before.pushRooms as string[]);
  });
});
