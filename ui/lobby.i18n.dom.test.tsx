// Render in two non-English languages so missing catalog wiring cannot hide.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { LobbyScene } = await import("./office/lobby/LobbyScene.tsx");
const { MembersChatPanel } =
  await import("./members-chat/MembersChatPanel.tsx");

for (const [language, heading, welcome, directory, placeholder] of [
  [
    "es",
    "Chat de miembros",
    "BIENVENIDOS",
    "DIRECTORIO",
    "Escribe a los miembros…",
  ],
  ["ca", "Xat de membres", "BENVINGUTS", "DIRECTORI", "Escriu als membres…"],
] as const) {
  it(`renders lobby and members chat in ${language}`, () => {
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
        language,
        createElement(LobbyScene, {
          rooms: [],
          officeName: null,
          mode: "light",
          layout: "nilo",
        }),
        state,
      ),
    );
    expect(scene.container.textContent).toContain(welcome);
    expect(scene.container.textContent).toContain(directory);
    const chat = render(
      onLanguage(language, createElement(MembersChatPanel), state),
    );
    expect(chat.queryByText(heading)).not.toBeNull();
    expect(chat.queryByPlaceholderText(placeholder)).not.toBeNull();
    expect(chat.container.textContent).not.toContain(
      "Only people see this chat",
    );
  });
}
