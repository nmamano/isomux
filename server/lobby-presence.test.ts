import { afterEach, expect, it } from "bun:test";
import { assignLobbySpot, pickLobbySpot, planLobbyMoves } from "./lobby-presence.ts";
import { _testClearPresence, getPresence, listAllPresence, moveLobbyPresences, refreshPresenceForUser, setPresence } from "./presence.ts";
import { LOBBY_ROOM_ID, LOBBY_SPOT_IDS } from "../shared/types.ts";

const lobbySpotIds: readonly string[] = LOBBY_SPOT_IDS;
const row = (connectionId: string, lobbySpotId: string | null, lobbyMoveAt = 100) => ({ connectionId, lobbySpotId, lobbyMoveAt });
afterEach(_testClearPresence);

it("moves due ghosts in sequence into distinct free spots, leaving other deadlines alone", () => {
  const before = [row("a", "one"), row("b", "two"), row("c", "three", 200)];
  expect(planLobbyMoves(before, ["one", "two", "three", "four"], 99, () => 0)).toEqual(before);
  const next = planLobbyMoves(before, ["one", "two", "three", "four"], 100, () => 0.99);
  expect(next.map((p) => p.lobbySpotId)).toEqual(["four", "one", "three"]);
  expect(new Set(next.map((p) => p.lobbySpotId)).size).toBe(3);
  expect(next[2]).toBe(before[2]);
  expect(next[0].lobbyMoveAt).toBe(25000);
  expect(before[0].lobbySpotId).toBe("one");
});

it("keeps a full lobby stable, promotes overflow first, and uses the supplied random source", () => {
  const full = [row("a", "one"), row("b", "two"), row("wait", null)];
  expect(planLobbyMoves(full, ["one", "two"], 100, () => 0).map((p) => p.lobbySpotId)).toEqual(["one", "two", null]);
  const next = planLobbyMoves(full.slice(1), ["one", "two"], 100, () => 0);
  expect(next.map((p) => p.lobbySpotId)).toEqual(["two", "one"]);
  expect(planLobbyMoves([row("a", null)], ["one", "two"], 0, () => 0.99)[0]).toEqual(row("a", "two", 24900));
});

it("a click changes only the caller and refuses taken, unknown, and absent callers", () => {
  const before = [row("a", "one"), row("b", "two")];
  const next = pickLobbySpot(before, ["one", "two", "three"], "a", "three", 100, () => 0);
  expect(next[0]).toEqual(row("a", "three", 15100));
  expect(next[1]).toBe(before[1]);
  for (const [caller, spot] of [["a", "two"], ["a", "bad"], ["missing", "three"]]) {
    expect(pickLobbySpot(before, ["one", "two", "three"], caller, spot, 100, () => 0)).toEqual(before);
  }
});

it("presence retains lobby seats on repeats and grant changes, and reports a move as visible", () => {
  const p = { connectionId: "a", userId: "u", username: "Boss", device: null, avatarColor: "#123456", avatarVariant: "classic" as const, currentRoomId: LOBBY_ROOM_ID, focusedAgentId: null, viewMode: "office" as const, lastSeenAt: 0 };
  expect(setPresence(p)).toBe(true);
  const first = getPresence("a")!;
  expect(lobbySpotIds).toContain(first.lobbySpotId!);
  expect(setPresence({ ...p, lastSeenAt: 50 })).toBe(false);
  expect(getPresence("a")!.lobbySpotId).toBe(first.lobbySpotId);
  expect(refreshPresenceForUser("u", { name: "Boss", avatarColor: "#123456", avatarVariant: "classic" }, new Set())).toBe(false);
  expect(getPresence("a")!.currentRoomId).toBe(LOBBY_ROOM_ID);
  expect(moveLobbyPresences(30000, () => 0)).toBe(true);
  expect(getPresence("a")!.lobbySpotId).not.toBe(first.lobbySpotId);
  setPresence({ ...p, connectionId: "ordinary", currentRoomId: "closed-room" });
  refreshPresenceForUser("u", { name: "Boss", avatarColor: "#123456", avatarVariant: "classic" }, new Set());
  expect(getPresence("ordinary")!.currentRoomId).toBeNull();
  expect(listAllPresence().find((p) => p.connectionId === "a")!.currentRoomId).toBe(LOBBY_ROOM_ID);
});

it("assigns ten different seats on entry, queues overflow, and clears seats on exit", () => {
  for (let i = 0; i < 18; i++) {
    setPresence({ connectionId: String(i), userId: "u", username: "Boss", device: null, avatarColor: "#123456", avatarVariant: "classic", currentRoomId: LOBBY_ROOM_ID, focusedAgentId: null, viewMode: "office", lastSeenAt: 0 });
  }
  const seated = listAllPresence().filter((p) => p.lobbySpotId !== null);
  expect(new Set(seated.map((p) => p.lobbySpotId)).size).toBe(10);
  expect(getPresence("10")!.lobbySpotId).toBeNull();
  expect(getPresence("11")!.lobbySpotId).toBeNull();
  const released = getPresence("0")!.lobbySpotId;
  setPresence({ ...getPresence("0")!, currentRoomId: null });
  expect(getPresence("0")!.lobbySpotId).toBeUndefined();
  expect(moveLobbyPresences(1, () => 0)).toBe(true);
  expect(getPresence("10")!.lobbySpotId).toBe(released);
  expect(getPresence("11")!.lobbySpotId).toBeNull();
});


it("assigns an entry with injected randomness without moving or dropping waiting rows", () => {
  const before = [row("seated", "one"), row("earliest", null), row("later", null)];
  expect(assignLobbySpot(before, ["one", "two", "three"], "new", 100, () => 0)).toEqual(row("new", null, 15100));
  expect(assignLobbySpot(before, ["one", "two", "three", "four"], "new", 100, () => 0.99)).toEqual(row("new", "four", 25000));
  expect(before).toEqual([row("seated", "one"), row("earliest", null), row("later", null)]);
  const promoted = planLobbyMoves(before, ["one", "two"], 100, () => 0);
  expect(promoted.map((p) => p.lobbySpotId)).toEqual(["one", "two", null]);
});

it("setPresence accepts entry randomness and returns true for a spot-only change", () => {
  const p = { connectionId: "a", userId: "u", username: "Boss", device: null, avatarColor: "#123456", avatarVariant: "classic" as const, currentRoomId: LOBBY_ROOM_ID, focusedAgentId: null, viewMode: "office" as const, lastSeenAt: 0 };
  setPresence(p, () => 0);
  expect(getPresence("a")!.lobbySpotId).toBe(LOBBY_SPOT_IDS[0]);
  expect(setPresence({ ...getPresence("a")!, lobbySpotId: LOBBY_SPOT_IDS[1] })).toBe(true);
  expect(setPresence({ ...getPresence("a")! })).toBe(false);
});
