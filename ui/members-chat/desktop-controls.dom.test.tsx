import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { DispatchCtx, StateCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { SceneDecorationContext } =
  await import("../office/scene-decoration.tsx");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { OfficeView } = await import("../office/OfficeView.tsx");
const noop = () => {};
const { setApiShim } = await import("../api.ts");
const reads: string[] = [];
setApiShim(async (method, path, body) => {
  if (method === "POST" && path === "/api/members-chat/read")
    reads.push((body as { lastReadId: string }).lastReadId);
  return { readPointer: reads.at(-1), unread: 0 };
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  localStorage.clear();
  reads.length = 0;
  window.history.replaceState(null, "", "/");
});
afterEach(() => jest.useRealTimers());
const office = createElement(
  SceneDecorationContext.Provider,
  { value: false },
  createElement(OfficeView, {
    onSpawn: noop,
    onContextMenu: noop,
    onOpenSettings: noop,
    onEditOfficePrompt: noop,
    onOpenThemePicker: noop,
    onOpenTasks: noop,
    onOpenCronjobs: noop,
    onOpenApps: noop,
    onOpenUpdate: noop,
  }),
);
function lobbyState(id: string | null, mobile: boolean) {
  return {
    lobbyOpen: true,
    isMobile: mobile,
    hasReceivedInitialState: true,
    connected: true,
    membersChat: {
      loaded: true,
      messages: id
        ? [
            {
              id,
              kind: "user" as const,
              userId: "other",
              userName: "Sam",
              content: id,
              attachments: [],
              timestamp: 1,
            },
          ]
        : [],
      hasMore: false,
      unread: id ? 1 : 0,
      readPointer: null,
    },
  };
}
// A fixed store state, with the chat shown or not.
function lobby(
  id: string | null = null,
  mobile = false,
  language: "en" | "es" = "en",
  shown = false,
) {
  return onLanguage(language, office, {
    ...lobbyState(id, mobile),
    membersChatShown: shown,
  });
}
// The same state, with the store reducer behind the show and hide buttons.
function Toggled(props: { id: string | null; language: "en" | "es" }) {
  const [shown, setShown] = useState(false);
  const state = stateWithSelfUser(props.language, {
    ...lobbyState(props.id, false),
    membersChatShown: shown,
  });
  return createElement(
    DispatchCtx.Provider,
    { value: (action) => setShown(reducer(state, action).membersChatShown) },
    createElement(
      StateCtx.Provider,
      { value: state },
      createElement(LanguageProvider, null, office),
    ),
  );
}
const toggled = (id: string | null = null, language: "en" | "es" = "en") =>
  createElement(Toggled, { id, language });
// Well past the mark-read debounce, on a fake clock.
const settleRead = () =>
  act(async () => {
    jest.advanceTimersByTime(1000);
  });

it("gives a phone its own chat, never the desktop panel, even when the store shows the desktop chat", () => {
  // Anchor: on a desktop, the shown state mounts the side panel.
  const desktop = render(lobby(null, false, "en", true));
  expect(desktop.queryByRole("separator") !== null).toBe(true);
  desktop.unmount();
  for (const shown of [true, false]) {
    const view = render(lobby(null, true, "en", shown));
    expect(view.queryByRole("separator") === null).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Members chat" }));
    expect(view.getByRole("dialog", { name: "Members chat" })).not.toBeNull();
    expect(view.queryByRole("button", { name: "Hide chat" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(view.queryByRole("dialog")).toBeNull();
    view.unmount();
  }
});

it("translates the desktop hide and show controls", () => {
  // The panel header's last button hides the chat; the floating button
  // shows it again. Each must render through the catalog.
  function controls(language: "en" | "es") {
    const view = render(toggled(null, language));
    fireEvent.click(view.container.querySelector("[data-lobby-chat-fab]")!);
    const header = view.container.querySelector(
      "[data-members-chat-list]",
    )!.previousElementSibling!;
    const hide = [...header.querySelectorAll("button")].at(-1)!;
    const hideText = hide.textContent ?? "";
    fireEvent.click(hide);
    expect(view.container.querySelector("[data-members-chat-list]")).toBeNull();
    const show = view.container.querySelector("[data-lobby-chat-fab]")!;
    const showName = show.getAttribute("aria-label") ?? "";
    fireEvent.click(show);
    expect(
      view.container.querySelector("[data-members-chat-list]") !== null,
    ).toBe(true);
    view.unmount();
    return { hideText, showName };
  }
  const en = controls("en");
  expect(en.hideText.length > 0 && en.showName.length > 0).toBe(true);
  const es = controls("es");
  expect(es.hideText.length > 0 && es.hideText !== en.hideText).toBe(true);
  expect(es.showName.length > 0 && es.showName !== en.showName).toBe(true);
});

it("keeps incoming unread visible while hidden and marks the same message read only after show", async () => {
  jest.useFakeTimers();
  const view = render(toggled());
  fireEvent.click(view.getByRole("button", { name: "Members chat" }));
  fireEvent.click(view.getByRole("button", { name: "Hide chat" }));
  view.rerender(toggled("02"));
  // One dot on the Lobby tab, one on the floating chat button.
  expect(view.container.querySelectorAll("[data-lobby-unread]").length).toBe(2);
  const button = view.container.querySelector<HTMLButtonElement>(
    "[data-lobby-chat-fab]",
  )!;
  expect(button.querySelectorAll("[data-lobby-unread]").length).toBe(1);
  await settleRead();
  expect(reads).toEqual([]);
  fireEvent.click(button);
  await settleRead();
  expect(reads).toEqual(["02"]);
});
