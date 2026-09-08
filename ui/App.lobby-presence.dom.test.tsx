import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { render, renderHook, fireEvent, act } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { setShim, connect } = await import("./ws.ts");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { LOBBY_SPOT_IDS } = await import("../shared/types.ts");
const { useGhostTransitions } = await import("./office/useGhostTransitions.ts");
const commands: import("../shared/types.ts").ClientCommand[] = [];
setShim((cmd) => commands.push(cmd));
setApiShim(async () => ({
  messages: [],
  hasMore: false,
  readPointer: null,
  unread: 0,
}));
afterAll(() => {
  setApiShim(null);
  setShim(() => {});
  connect(
    () => {},
    () => {},
  );
});
beforeEach(() => {
  commands.length = 0;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
const ghost = (
  connectionId: string,
  username: string,
  lobbySpotId: string,
): import("../shared/types.ts").PresenceInfo => ({
  connectionId,
  username,
  lobbySpotId,
  userId: connectionId,
  device: null,
  avatarColor: "#7c9cf5",
  avatarVariant: "classic",
  currentRoomId: "lobby",
  focusedAgentId: null,
  viewMode: "office",
});

it("reports lobby presence, draws self and a peer, and sends a free-seat click without optimistic movement", async () => {
  const presences = [
    ghost("c1", "Self", LOBBY_SPOT_IDS[0]),
    ghost("c2", "Peer", LOBBY_SPOT_IDS[1]),
  ];
  const view = render(
    onLanguage("en", createElement(App), {
      lobbyOpen: true,
      hasReceivedInitialState: true,
      connected: true,
      presences,
    }),
  );
  expect(commands.find((c) => c.type === "presence_update")).toMatchObject({
    currentRoomId: "lobby",
  });
  const self = view.container.querySelector<HTMLElement>('div[title="Self"]')!;
  expect(self).not.toBeNull();
  expect(view.container.querySelector('div[title="Peer"]')).not.toBeNull();
  expect(
    view.container.querySelector(`[data-lobby-spot="${LOBBY_SPOT_IDS[0]}"]`),
  ).toBeNull();
  const free = view.container.querySelector(
    `[data-lobby-spot="${LOBBY_SPOT_IDS[2]}"]`,
  )!;
  expect(free.getAttribute("aria-label")).toBe("Move here");
  const left = self.style.left;
  await act(async () => {
    fireEvent.click(free);
  });
  expect(commands.filter((c) => c.type === "lobby_move")).toEqual([
    { type: "lobby_move", spotId: LOBBY_SPOT_IDS[2] },
  ]);
  expect(self.style.left).toBe(left);
});

it("ordinary rooms still hide self and show a peer", () => {
  const { result } = renderHook(() =>
    useGhostTransitions(
      [ghost("self", "Self", ""), ghost("peer", "Peer", "")].map((p) => ({
        ...p,
        currentRoomId: "r1",
      })),
      [],
      "r1",
      [{ id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true }],
      "self",
      { left: 0, top: 0 },
      { left: 900, top: 0 },
    ),
  );
  expect(result.current.placements.map((p) => p.presence.connectionId)).toEqual(
    ["peer"],
  );
});
