import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../../test-support/language-fixture.tsx");
const { LOBBY_SPOT_IDS } = await import("../../../shared/types.ts");
const { LobbyScene } = await import("./LobbyScene.tsx");
const ghost = (
  connectionId: string,
  username: string,
  lobbySpotId: string,
): import("../../../shared/types.ts").PresenceInfo => ({
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

it("keeps ghost nodes mounted while authoritative seats change", () => {
  const p = ghost("c1", "Self", LOBBY_SPOT_IDS[0]);
  const scene = (spot: string) =>
    createElement(LobbyScene, {
      rooms: [],
      officeName: null,
      mode: "dark",
      layout: "nilo",
      presences: [{ ...p, lobbySpotId: spot }],
    });
  const view = render(scene(LOBBY_SPOT_IDS[0]));
  const body = view.container.querySelector<HTMLElement>('div[title="Self"]')!;
  const left = body.style.left;
  view.rerender(scene(LOBBY_SPOT_IDS[1]));
  expect(view.container.querySelector('div[title="Self"]')).toBe(body);
  expect(body.style.left).not.toBe(left);
  expect(body.style.transition).toContain("left 220ms");
});

for (const [lang, label] of [
  ["es", "Moverse aquí"],
  ["ca", "Mou-te aquí"],
] as const) {
  it(`labels free spots in ${lang}`, () => {
    const view = render(
      onLanguage(
        lang,
        createElement(LobbyScene, {
          rooms: [],
          officeName: null,
          mode: "dark",
          layout: "nilo",
          onMoveGhost: () => {},
        }),
      ),
    );
    expect(view.getAllByRole("button", { name: label })).toHaveLength(10);
  });
}

it("keeps overflow body identification while suppressing its name chip", () => {
  const p = { ...ghost("overflow", "Waiting viewer", ""), lobbySpotId: null };
  const view = render(
    createElement(LobbyScene, {
      rooms: [],
      officeName: null,
      mode: "dark",
      layout: "nilo",
      presences: [p],
    }),
  );
  expect(
    view.container.querySelectorAll('div[title="Waiting viewer"]'),
  ).toHaveLength(1);
  expect(view.queryByText("Waiting viewer")).toBeNull();
});

it("centres every occupied seat's tag within its ghost and keeps it above its head", () => {
  const presences = LOBBY_SPOT_IDS.map((id, i) =>
    ghost(`c${i}`, `Viewer ${i}`, id),
  );
  const view = render(
    createElement(LobbyScene, {
      rooms: [],
      officeName: null,
      mode: "dark",
      layout: "nilo",
      presences,
    }),
  );
  for (const p of presences) {
    const nodes = view.container.querySelectorAll<HTMLElement>(
      `div[title="${p.username}"]`,
    );
    expect(nodes.length).toBe(2);
    const [body, tag] = nodes;
    const left = parseFloat(body.style.left);
    const width = parseFloat(body.style.width);
    // happy-dom does not lay out text. The tag anchor plus translateX(-50%)
    // defines the chip centre; Chrome verification checks the painted bounds.
    const centre = parseFloat(tag.style.left);
    expect(tag.style.transform).toBe("translateX(-50%)");
    expect(centre).toBeGreaterThanOrEqual(left);
    expect(centre).toBeLessThanOrEqual(left + width);
    expect(centre).toBe(left + width / 2);
    expect(parseFloat(tag.style.top)).toBe(parseFloat(body.style.top) - 11);
  }
});
