// The lobby scene and the members chat read the member's language. Spanish,
// with every anchor distinct from English, so missing catalog wiring cannot
// hide behind English text.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFor,
} from "./test-support/i18n.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { LobbyScene } = await import("./office/lobby/LobbyScene.tsx");
const { MembersChatPanel } =
  await import("./members-chat/MembersChatPanel.tsx");

const ANCHOR = {
  welcome: translationsFor("lobby.welcome"),
  directory: translationsFor("lobby.directory"),
  heading: translationsFor("membersChat.title"),
  placeholder: translationsFor("membersChat.placeholder"),
  empty: translationsFor("membersChat.empty"),
};

it("resolves each anchor in every shipped language", () => {
  for (const [name, anchor] of Object.entries(ANCHOR))
    expect(new Set(Object.values(anchor)).size, name).toBe(
      SHIPPED_LANGUAGE_CODES.length,
    );
});

it("renders the lobby and the members chat in Spanish", () => {
  const state = {
    membersChat: {
      messages: [],
      hasMore: false,
      loaded: true,
      readPointer: null,
      unread: 0,
    },
  };
  const scene = render(
    onLanguage(
      "es",
      createElement(LobbyScene, {
        rooms: [],
        officeName: null,
        mode: "light",
        layout: "nilo",
      }),
      state,
    ),
  );
  expect(scene.container.textContent).toContain(ANCHOR.welcome.es);
  expect(scene.container.textContent).toContain(ANCHOR.directory.es);
  const chat = render(onLanguage("es", createElement(MembersChatPanel), state));
  expect(chat.queryByText(ANCHOR.heading.es)).not.toBeNull();
  expect(chat.queryByPlaceholderText(ANCHOR.placeholder.es)).not.toBeNull();
  expect(chat.container.textContent).toContain(ANCHOR.empty.es);
  expect(chat.container.textContent).not.toContain(ANCHOR.empty.en);
});
