import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { LOBBY_SPOT_IDS } = await import("../../shared/types.ts");
const { mount, act, shimEmit } = fixture;
fixture.setupRoomDoorTests({ decorations: false });

function presence(
  currentRoomId: string | null,
  connectionId = "peer",
): import("../../shared/types.ts").PresenceInfo {
  return {
    connectionId,
    userId: connectionId,
    username: connectionId,
    currentRoomId,
    lobbySpotId: LOBBY_SPOT_IDS[0],
    focusedAgentId: null,
    viewMode: "office",
    device: null,
    avatarColor: "#7c9cf5",
    avatarVariant: "classic",
  };
}
function update(currentRoomId: string | null, connectionId = "peer") {
  act(() =>
    shimEmit({
      type: "presence_list",
      entries: [presence(currentRoomId, connectionId)],
      totalOnlineUsers: 1,
      onlineUserIds: [connectionId],
    }),
  );
}
function door(container: HTMLElement, lobby: boolean) {
  const node = container.querySelector(
    `svg g[aria-label="${lobby ? "first" : "Lobby"}"]`,
  );
  expect(node).not.toBeNull();
  return node!;
}
function swing(node: Element) {
  return node.querySelector<SVGElement>(
    'g[style*="animation: isomuxDoorAjar"]',
  );
}

it("ignores self and unseen crossings on both sides of the Lobby door", async () => {
  const view = mount();
  await act(async () => {});
  for (const lobby of [false, true]) {
    // Clear presence before changing sides; each side observes a fresh arrival.
    act(() => shimEmit({ type: "presence_list", entries: [], totalOnlineUsers: 0, onlineUserIds: [] }));
    act(() => {
      shimEmit({
        type: "session_context",
        context: {
          userId: "self",
          username: "self",
          role: "owner",
          currentSessionPrefix: "session",
          connectionId: "self",
        },
      });
      fixture.dispatch({ type: "set_lobby_open", open: !lobby });
    });
    update(lobby ? "first" : "lobby", "self");
    act(() => fixture.dispatch({ type: "set_lobby_open", open: lobby }));
    const doorNode = door(view.container, lobby);
    const quiet = [swing(doorNode) === null];
    update(lobby ? "lobby" : "first", "self"); // Delayed server echo of own navigation.
    quiet.push(swing(doorNode) === null);
    update(lobby ? "first" : "lobby", "self");
    quiet.push(swing(doorNode) === null);
    update(null);
    update(lobby ? "lobby" : "first");
    quiet.push(swing(doorNode) === null); // Appearing from outside the projection.
    const beforePeer = swing(doorNode);
    update(lobby ? "first" : "lobby");
    const peerSwung =
      swing(doorNode) !== null && swing(doorNode) !== beforePeer;
    // Check the enabling event before reporting a self-exclusion failure.
    expect(peerSwung).toBe(true);
    expect(quiet).toEqual([true, true, true, true]);
  }
});
