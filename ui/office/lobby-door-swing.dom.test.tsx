import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { LOBBY_SPOT_IDS } = await import("../../shared/types.ts");
const { LOBBY_LAYOUTS } = await import("./lobby/layouts.ts");
const { floorXY } = await import("./lobby/geometry.ts");
const { VB_X, VB_Y } = await import("./grid.ts");
const { SVG_HEIGHT_RATIO } = await import("./Ghost.tsx");
const { mount, act, shimEmit } = fixture;
fixture.setupRoomDoorTests();

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
function body(container: HTMLElement, name = "peer") {
  const node = container.querySelector<HTMLElement>(`div[title="${name}"]`);
  expect(node).not.toBeNull();
  return node!;
}
function swing(node: Element) {
  return node.querySelector<SVGElement>(
    'g[style*="animation: isomuxDoorAjar"]',
  );
}

for (const lobby of [true, false]) {
  it(`walks through the ${lobby ? "lobby right" : "first room left"} door on seen exits and entries`, async () => {
    const view = mount();
    await act(async () => {});
    act(() => fixture.dispatch({ type: "set_lobby_open", open: lobby }));
    const here = lobby ? "lobby" : "first";
    const there = lobby ? "first" : "lobby";
    update(here);
    const doorNode = door(view.container, lobby);
    expect(swing(doorNode) === null).toBe(true); // Initial presence is not a crossing.
    const ghost = body(view.container);
    const naturalLeft = ghost.style.left;
    const naturalTop = ghost.style.top;
    if (lobby) {
      const seat = LOBBY_LAYOUTS.nilo.ghostSpots.find(
        (s) => s.id === LOBBY_SPOT_IDS[0],
      )!;
      const point = floorXY(seat.b, seat.a);
      expect(naturalLeft).toBe(`${point.x - VB_X - 40 / 2}px`);
      expect(naturalTop).toBe(
        `${point.y - VB_Y - Math.round(40 * SVG_HEIGHT_RATIO) + 8}px`,
      );
    }
    expect(ghost.querySelector('[style*="isomuxGhostTrail"]') === null).toBe(
      true,
    );
    expect(ghost.style.transition).toContain("left 220ms");
    update(there);
    expect(body(view.container) === ghost).toBe(true); // Keep the node, so CSS can walk it.
    expect(ghost.style.left).toBe(lobby ? "885px" : "25px");
    expect(ghost.style.top).toBe("270px");
    expect(ghost.style.left).not.toBe(naturalLeft);
    expect(ghost.style.top).not.toBe(naturalTop);
    const trail = ghost.querySelector<HTMLElement>(
      '[style*="isomuxGhostTrail"]',
    );
    expect(trail !== null).toBe(true);
    // The dust follows the move from the prior seat/idle position to this door.
    expect(
      Math.sign(parseFloat(trail!.style.getPropertyValue("--gt-dx"))),
    ).toBe(-Math.sign(parseFloat(ghost.style.left) - parseFloat(naturalLeft)));
    const exitSwing = swing(doorNode);
    expect(exitSwing !== null).toBe(true);
    expect(exitSwing!.style.animation).toContain(lobby ? "-right" : "-left");
    update(here);
    expect(body(view.container) === ghost).toBe(true);
    expect(ghost.style.left).toBe(lobby ? "885px" : "25px");
    expect(swing(doorNode) !== exitSwing).toBe(true); // Entry restarts the shared swing.
    expect(swing(doorNode) !== null).toBe(true);
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(body(view.container) === ghost).toBe(true);
    expect(ghost.style.left).toBe(naturalLeft);
    expect(ghost.style.top).toBe(naturalTop);
  });
}
