import { afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { OfficeView } = await import("../office/OfficeView.tsx");
const { SceneDecorationContext } =
  await import("../office/scene-decoration.tsx");
const { ChatWidthHandle } = await import("./ChatWidthHandle.tsx");
const { clampMembersChatWidth } = await import("../device-settings.ts");
const noop = () => {};
function office(mobile = false) {
  return onLanguage(
    "en",
    // No floor, seasonal art or lobby props: nothing here asserts on them.
    createElement(
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
    ),
    {
      lobbyOpen: true,
      isMobile: mobile,
      membersChat: {
        loaded: true,
        messages: [],
        hasMore: false,
        readPointer: null,
        unread: 0,
      },
    },
  );
}
beforeEach(() => localStorage.clear());
// Tests below move the window width; put it back even when one fails.
const initialWidth = window.innerWidth;
const setViewport = (value: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, value });
afterEach(() => setViewport(initialWidth));
it("keeps the panel and zoom inset together, remembers keyboard resizing, and clamps after a viewport resize", () => {
  localStorage.setItem("isomux-members-chat-hidden", "false");
  const view = render(office());
  const handle = view.getByRole("separator", { name: "Resize chat" });
  expect(handle.getAttribute("aria-valuenow")).toBe("520");
  act(() => {
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    setViewport(550);
    fireEvent(window, new Event("resize"));
  });
  expect(handle.parentElement!.style.width).toBe("502px");
  expect(
    view.getByRole("button", { name: "Zoom in" }).parentElement!.style.right,
  ).toBe("514px");
  expect(localStorage.getItem("isomux-members-chat-width")).toBe("540");
  expect(handle.getAttribute("aria-valuenow")).toBe("502");
});
it("gives a phone the full-width chat, never the desktop panel or its handle", () => {
  // A saved "shown" choice and a saved width would mount the side panel on a
  // desktop (the anchor); a phone ignores both.
  localStorage.setItem("isomux-members-chat-hidden", "false");
  localStorage.setItem("isomux-members-chat-width", "900");
  const desktop = render(office());
  expect(desktop.queryByRole("separator") !== null).toBe(true);
  desktop.unmount();
  setViewport(550);
  const view = render(office(true));
  expect(view.queryByRole("separator") === null).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Members chat" }));
  expect(view.queryByRole("separator") === null).toBe(true);
  expect(view.getByRole("dialog").style.width).toBe("100%");
  // The phone never read the saved width: had it read 900 at 550, it would
  // keep the narrow clamp after the window widens into a desktop.
  const wide = clampMembersChatWidth(900, 1440);
  expect(wide).not.toBe(clampMembersChatWidth(900, 550));
  act(() => {
    setViewport(1440);
    fireEvent(window, new Event("resize"));
  });
  view.rerender(office());
  expect(view.getByRole("separator").getAttribute("aria-valuenow")).toBe(
    String(wide),
  );
});
it("names the separator through the catalog", () => {
  const names = (["en", "es"] as const).map((language) => {
    const view = render(
      onLanguage(
        language,
        createElement(ChatWidthHandle, {
          width: 520,
          viewportWidth: 1440,
          onChange: () => {},
          onCommit: () => {},
        }),
      ),
    );
    const separator = view.getByRole("separator");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    const name = separator.getAttribute("aria-label") ?? "";
    view.unmount();
    return name;
  });
  expect(names[0].length > 0).toBe(true);
  expect(names[1].length > 0 && names[1] !== names[0]).toBe(true);
});
