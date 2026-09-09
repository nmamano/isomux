import { beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { OfficeView } = await import("../office/OfficeView.tsx");
const noop = () => {};
function office(mobile = false, language: "en" | "es" | "ca" = "en") {
  return onLanguage(language, createElement(OfficeView, { onSpawn: noop, onContextMenu: noop, onOpenSettings: noop, onEditOfficePrompt: noop, onOpenThemePicker: noop, onOpenTasks: noop, onOpenCronjobs: noop, onOpenApps: noop, onOpenUpdate: noop }), {
    lobbyOpen: true, isMobile: mobile,
    membersChat: { loaded: true, messages: [], hasMore: false, readPointer: null, unread: 0 },
  });
}
beforeEach(() => localStorage.clear());
it("keeps the panel and zoom inset together, remembers keyboard resizing, and clamps after a viewport resize", () => {
  const view = render(office());
  const handle = view.getByRole("separator", { name: "Resize chat" });
  expect(handle.getAttribute("aria-valuenow")).toBe("520");
  const initialWidth = window.innerWidth;
  act(() => {
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 550 });
    fireEvent(window, new Event("resize"));
  });
  expect(handle.parentElement!.style.width).toBe("502px");
  expect(view.getByRole("button", { name: "Zoom in" }).parentElement!.style.right).toBe("514px");
  expect(localStorage.getItem("isomux-members-chat-width")).toBe("540");
  expect(handle.getAttribute("aria-valuenow")).toBe("502");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWidth });
});
