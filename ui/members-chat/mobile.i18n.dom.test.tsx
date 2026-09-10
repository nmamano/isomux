import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { LobbyChat } = await import("./LobbyChat.tsx");
for (const [language, title, back, unread, singular, retry] of [
  [
    "en",
    "Members chat",
    "Back",
    "Unread messages: 2",
    "Unread message: 1",
    "Try again",
  ],
  [
    "es",
    "Chat de miembros",
    "Atrás",
    "Mensajes sin leer: 2",
    "Mensaje sin leer: 1",
    "Reintentar",
  ],
  [
    "ca",
    "Xat de membres",
    "Enrere",
    "Missatges sense llegir: 2",
    "Missatge sense llegir: 1",
    "Torna-ho a provar",
  ],
] as const) {
  it(`opens and closes members chat with ${language} labels`, () => {
    const bar = (count: number) =>
      onLanguage(
        language,
        createElement(LobbyChat, {
          loadFailed: true,
          onRetry: () => {},
        }),
        {
          isMobile: true,
          lobbyOpen: true,
          membersChat: {
            messages: [],
            loaded: true,
            hasMore: false,
            unread: count,
            readPointer: null,
          },
        },
      );
    const view = render(bar(2));
    const dot = view.getByRole("img", { name: unread });
    expect(dot.getAttribute("title")).toBe(unread);
    view.rerender(bar(1));
    expect(
      view.getByRole("img", { name: singular }).getAttribute("title"),
    ).toBe(singular);
    fireEvent.click(view.getByRole("button", { name: `${title} ${singular}` }));
    const panel = view.getByRole("dialog", { name: title });
    expect(panel).not.toBeNull();
    expect(document.activeElement?.textContent).toBe(back);
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(view.getByRole("button", { name: retry })).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: back }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    const entry = view.getByRole("button", { name: `${title} ${singular}` });
    expect(document.activeElement === entry).toBe(true);
    fireEvent.click(entry);
    entry.focus();
    expect(view.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );
    fireEvent.keyDown(document.activeElement!, {
      key: "Escape",
      bubbles: true,
    });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === entry).toBe(true);
  });
}
