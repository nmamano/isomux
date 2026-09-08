import { expect, it } from "bun:test";
import { LOBBY_SPOT_IDS, type PresenceInfo } from "../../../shared/types.ts";
import { LOBBY_LAYOUTS } from "./layouts.ts";
import { lobbyGhostPlacements, lobbyTagTops } from "./LobbyGhosts.tsx";
const ghost = (connectionId: string, lobbySpotId: string | null): PresenceInfo => ({ connectionId, lobbySpotId, currentRoomId: "lobby", userId: connectionId, username: connectionId, device: null, avatarVariant: "classic", avatarColor: "#123456", focusedAgentId: "receptionist", viewMode: "office" });
it("pins stable server ids to the saved layout", () => {
  expect(LOBBY_LAYOUTS.nilo.ghostSpots.map((s) => s.id)).toEqual([...LOBBY_SPOT_IDS]);
});
it("places self and peers at named seats regardless of focus, with unique overflow positions", () => {
  const spots = LOBBY_LAYOUTS.nilo.ghostSpots;
  const input = [ghost("a", LOBBY_SPOT_IDS[0]), ghost("b", LOBBY_SPOT_IDS[1]), ghost("c", null), ghost("d", null), { ...ghost("e", null), currentRoomId: "ordinary" }];
  const rows = lobbyGhostPlacements(input, spots);
  expect(rows.map((p) => p.presence.connectionId)).toEqual(["a", "b", "c", "d"]);
  expect(new Set(rows.map((p) => `${p.left}:${p.top}`)).size).toBe(4);
  expect(rows[0].left).toBeCloseTo(255.5);
  expect(rows[1].left).toBeCloseTo(307.75);
  expect(rows[2].left).toBe(600);
  expect(rows[3].left).toBe(652);
  const moved = lobbyGhostPlacements([{ ...input[0], lobbySpotId: LOBBY_SPOT_IDS[1] }], spots);
  expect(moved[0].left).toBe(rows[1].left);
});


it("wraps 18 viewers within the scene and keeps larger overflow lines within its bounds", () => {
  for (const count of [18, 40]) {
    const viewers = Array.from({ length: count }, (_, i) => ghost(String(i).padStart(2, "0"), LOBBY_SPOT_IDS[i] ?? null));
    const rows = lobbyGhostPlacements(viewers, LOBBY_LAYOUTS.nilo.ghostSpots);
    expect(rows).toHaveLength(count);
    expect(new Set(rows.map((p) => `${p.left}:${p.top}`)).size).toBe(Math.min(count, 18));
    for (const p of rows.slice(10)) {
      expect(p.left).toBeGreaterThanOrEqual(600);
      expect(p.left + 40).toBeLessThanOrEqual(840);
      expect(p.top + 52).toBeLessThanOrEqual(700);
    }
    expect(rows[14].left).toBe(600);
    expect(rows[14].top).toBeLessThan(rows[10].top);
  }
});


it("keeps overflow spacing fixed when later viewers join", () => {
  const viewers = Array.from({ length: 18 }, (_, i) => ghost(String(i).padStart(2, "0"), LOBBY_SPOT_IDS[i] ?? null));
  const before = lobbyGhostPlacements(viewers, LOBBY_LAYOUTS.nilo.ghostSpots);
  const after = lobbyGhostPlacements([...viewers, ...Array.from({ length: 22 }, (_, i) => ghost(String(i + 18), null))], LOBBY_LAYOUTS.nilo.ghostSpots);
  expect(after.slice(0, before.length)).toEqual(before);
});


it("staggers adjacent occupied seats independent of presence order and keeps their body coordinates", () => {
  const spots = LOBBY_LAYOUTS.nilo.ghostSpots;
  const [a, b] = LOBBY_SPOT_IDS;
  const first = lobbyTagTops(spots, new Set([a, b]));
  expect(first.get(a)).not.toBe(first.get(b));
  expect(lobbyTagTops(spots, new Set([b, a]))).toEqual(first);
  const people = [ghost("z", a), ghost("a", b)];
  const rows = lobbyGhostPlacements(people, spots);
  const reversed = lobbyGhostPlacements([...people].reverse(), spots);
  expect(reversed).toEqual(rows);
  const single = lobbyGhostPlacements([people[1]], spots)[0];
  const paired = rows.find((p) => p.presence.lobbySpotId === b)!;
  expect(paired.left).toBe(single.left);
  expect(paired.top).toBe(single.top);
  expect(paired.tagTop).not.toBe(single.tagTop);
});
