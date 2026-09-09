import { beforeEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
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
it("does not read the desktop width on mobile and has no handle", () => {
  localStorage.setItem("isomux-members-chat-width", "900");
  const getter = spyOn(Storage.prototype, "getItem");
  try {
    const view = render(office(true));
    expect(getter.mock.calls.some(([key]) => key === "isomux-members-chat-width")).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Members chat" }));
    expect(view.queryByRole("separator") === null).toBe(true);
    expect(view.getByRole("dialog").style.width).toBe("100%");
  } finally { getter.mockRestore(); }
});
