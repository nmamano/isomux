// The rooms /isomux-all-hands may list (task a37baee5). Its answer stays in
// the target agent's chat, so a room is listed only when the sender, within
// any rooms limit of their token, and every user who reads the target room
// may open it. The target room is always listed.

import { describe, expect, it } from "bun:test";
import { allHandsRoomIds } from "./all-hands-rooms.ts";
import type { UserRecord } from "../shared/types.ts";

const LOBBY = "lobby";
const ROOMS = [LOBBY, "a", "b", "c"];

function user(id: string, role: "owner" | "member", allowedRooms: string[]) {
  return { id, username: id, role, allowedRooms } as unknown as UserRecord;
}

// Morgan owns the office; Casey reads room a and c; Robin reads only b.
const morgan = user("morgan", "owner", []);
const casey = user("casey", "member", ["a", "c"]);
const robin = user("robin", "member", ["b"]);

// The office's rule (isomux-office.ts canAccess): the lobby is for everyone,
// an owner reaches every room, a member their grants.
const canAccess = (u: UserRecord, roomId: string) =>
  roomId === LOBBY || u.role === "owner" || u.allowedRooms.includes(roomId);

function listed(input: {
  targetRoomId: string;
  sender: UserRecord | undefined;
  senderRooms?: string[];
  users: UserRecord[];
}): string[] {
  return [
    ...allHandsRoomIds({
      roomIds: ROOMS,
      senderRooms: undefined,
      canAccess,
      isLobby: (roomId) => roomId === LOBBY,
      ...input,
    }),
  ].sort();
}

describe("allHandsRoomIds", () => {
  it("lists every room when the only reader of the target room is an owner with no limits", () => {
    expect(
      listed({ targetRoomId: "a", sender: morgan, users: [morgan] }),
    ).toEqual(["a", "b", "c", LOBBY].sort());
  });

  it("leaves out a room that another reader of the target room cannot open, whoever sends", () => {
    // Casey reads room a and lacks b. Robin lacks a and c but does not read
    // room a, so Robin does not narrow the list.
    const users = [morgan, casey, robin];
    for (const sender of [morgan, casey]) {
      expect({
        sender: sender.id,
        rooms: listed({ targetRoomId: "a", sender, users }),
      }).toEqual({ sender: sender.id, rooms: ["a", "c", LOBBY].sort() });
    }
  });

  it("lists only rooms that every user may open when the target is the lobby", () => {
    // Every user reads the lobby, so Robin (b only) and Casey (a, c) leave
    // no room but the lobby in common.
    expect(
      listed({
        targetRoomId: LOBBY,
        sender: morgan,
        users: [morgan, casey, robin],
      }),
    ).toEqual([LOBBY]);
    expect(
      listed({ targetRoomId: LOBBY, sender: morgan, users: [morgan, casey] }),
    ).toEqual(["a", "c", LOBBY].sort());
  });

  it("keeps a token limited to rooms inside its rooms, without the lobby unless it is the target", () => {
    expect(
      listed({
        targetRoomId: "a",
        sender: morgan,
        senderRooms: ["a", "b"],
        users: [morgan],
      }),
    ).toEqual(["a", "b"]);
    expect(
      listed({
        targetRoomId: "a",
        sender: morgan,
        senderRooms: ["a"],
        users: [morgan],
      }),
    ).toEqual(["a"]);
    expect(
      listed({
        targetRoomId: LOBBY,
        sender: morgan,
        senderRooms: ["a"],
        users: [morgan],
      }),
    ).toEqual(["a", LOBBY].sort());
  });

  it("lists only the target room when the sender has no user", () => {
    expect(
      listed({ targetRoomId: "b", sender: undefined, users: [morgan] }),
    ).toEqual(["b"]);
  });
});
