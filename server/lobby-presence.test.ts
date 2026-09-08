import { afterEach, expect, it } from "bun:test";
import {
  assignLobbySpot,
  pickLobbySpot,
} from "./lobby-presence.ts";
import {
  _testClearPresence,
  getPresence,
  listAllPresence,
  moveLobbyPresence,
  refreshPresenceForUser,
  setPresence,
} from "./presence.ts";
import { LOBBY_ROOM_ID, LOBBY_SPOT_IDS } from "../shared/types.ts";

const lobbySpotIds: readonly string[] = LOBBY_SPOT_IDS;
const row = (
  connectionId: string,
  lobbySpotId: string | null,
) => ({ connectionId, lobbySpotId });
afterEach(_testClearPresence);

it("a click changes only the caller and refuses taken, unknown, and absent callers", () => {
  const before = [row("a", "one"), row("b", "two")];
  const next = pickLobbySpot(
    before,
    ["one", "two", "three"],
    "a",
    "three",
  );
  expect(next[0]).toEqual(row("a", "three"));
  expect(next[1]).toBe(before[1]);
  for (const [caller, spot] of [
    ["a", "two"],
    ["a", "bad"],
    ["missing", "three"],
  ]) {
    expect(
      pickLobbySpot(
        before,
        ["one", "two", "three"],
        caller,
        spot,
      ),
    ).toEqual(before);
  }
});

it("presence retains lobby seats on repeats and grant changes, and reports a move as visible", () => {
  const p = {
    connectionId: "a",
    userId: "u",
    username: "Boss",
    device: null,
    avatarColor: "#123456",
    avatarVariant: "classic" as const,
    currentRoomId: LOBBY_ROOM_ID,
    focusedAgentId: null,
    viewMode: "office" as const,
    lastSeenAt: 0,
  };
  expect(setPresence(p)).toBe(true);
  const first = getPresence("a")!;
  expect(lobbySpotIds).toContain(first.lobbySpotId!);
  expect(setPresence({ ...p, lastSeenAt: 50 })).toBe(false);
  expect(getPresence("a")!.lobbySpotId).toBe(first.lobbySpotId);
  expect(
    refreshPresenceForUser(
      "u",
      { name: "Boss", avatarColor: "#123456", avatarVariant: "classic" },
      new Set(),
    ),
  ).toBe(false);
  expect(getPresence("a")!.currentRoomId).toBe(LOBBY_ROOM_ID);
  const free = LOBBY_SPOT_IDS.find((id) => id !== first.lobbySpotId)!;
  expect(moveLobbyPresence("a", free)).toBe(true);
  expect(getPresence("a")!.lobbySpotId).not.toBe(first.lobbySpotId);
  setPresence({ ...p, connectionId: "ordinary", currentRoomId: "closed-room" });
  refreshPresenceForUser(
    "u",
    { name: "Boss", avatarColor: "#123456", avatarVariant: "classic" },
    new Set(),
  );
  expect(getPresence("ordinary")!.currentRoomId).toBeNull();
  expect(
    listAllPresence().find((p) => p.connectionId === "a")!.currentRoomId,
  ).toBe(LOBBY_ROOM_ID);
});

it("assigns ten different seats on entry, queues overflow, and clears seats on exit", () => {
  for (let i = 0; i < 18; i++) {
    setPresence({
      connectionId: String(i),
      userId: "u",
      username: "Boss",
      device: null,
      avatarColor: "#123456",
      avatarVariant: "classic",
      currentRoomId: LOBBY_ROOM_ID,
      focusedAgentId: null,
      viewMode: "office",
      lastSeenAt: 0,
    });
  }
  const seated = listAllPresence().filter((p) => p.lobbySpotId !== null);
  expect(new Set(seated.map((p) => p.lobbySpotId)).size).toBe(10);
  expect(getPresence("10")!.lobbySpotId).toBeNull();
  expect(getPresence("11")!.lobbySpotId).toBeNull();
  const released = getPresence("0")!.lobbySpotId;
  setPresence({ ...getPresence("0")!, currentRoomId: null });
  expect(getPresence("0")!.lobbySpotId).toBeUndefined();
  expect(getPresence("10")!.lobbySpotId).toBeNull();
  expect(moveLobbyPresence("10", released!)).toBe(true);
  expect(getPresence("10")!.lobbySpotId).toBe(released);
  expect(getPresence("11")!.lobbySpotId).toBeNull();
});

it("assigns a random free entry seat without moving existing or overflow rows", () => {
  const before = [row("seated", "one"), row("waiting", null)];
  const choices = [0, 0.99].map((random) =>
    assignLobbySpot(before, ["one", "two", "three"], "new", () => random).lobbySpotId,
  );
  expect(choices).toEqual(["two", "three"]);
  expect(assignLobbySpot(before, ["one"], "new", () => 0)).toEqual(row("new", null));
  expect(before).toEqual([row("seated", "one"), row("waiting", null)]);
});

it("setPresence accepts entry randomness and returns true for a spot-only change", () => {
  const p = {
    connectionId: "a",
    userId: "u",
    username: "Boss",
    device: null,
    avatarColor: "#123456",
    avatarVariant: "classic" as const,
    currentRoomId: LOBBY_ROOM_ID,
    focusedAgentId: null,
    viewMode: "office" as const,
    lastSeenAt: 0,
  };
  setPresence(p, () => 0);
  expect(getPresence("a")!.lobbySpotId).toBe(LOBBY_SPOT_IDS[0]);
  expect(
    setPresence({ ...getPresence("a")!, lobbySpotId: LOBBY_SPOT_IDS[1] }),
  ).toBe(true);
  expect(setPresence({ ...getPresence("a")! })).toBe(false);
  setPresence({ ...getPresence("a")!, currentRoomId: null });
  expect(getPresence("a")!.lobbySpotId).toBeUndefined();
  setPresence(p, () => 0.99);
  expect(getPresence("a")!.lobbySpotId).toBe(LOBBY_SPOT_IDS.at(-1));
  expect(getPresence("a")!.lobbySpotId).not.toBe(LOBBY_SPOT_IDS[0]);
});
