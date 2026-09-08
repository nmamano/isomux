import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { OfficeView } = await import("../office/OfficeView.tsx");
const noop = () => {};
const { setApiShim } = await import("../api.ts");
const key = "isomux-members-chat-hidden";
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
function lobby(id: string | null = null, mobile = false, language: "en" | "es" | "ca" = "en") {
  return onLanguage(language, createElement(OfficeView, {
    onSpawn: noop, onContextMenu: noop, onOpenSettings: noop,
    onEditOfficePrompt: noop, onOpenThemePicker: noop, onOpenTasks: noop,
    onOpenCronjobs: noop, onOpenApps: noop, onOpenUpdate: noop,
  }), {
    lobbyOpen: true,
    isMobile: mobile,
    hasReceivedInitialState: true,
    connected: true,
    membersChat: {
      loaded: true,
      messages: id ? [{ id, kind: "user", userId: "other", userName: "Sam", content: id, attachments: [], timestamp: 1 }] : [],
      hasMore: false,
      unread: id ? 1 : 0,
      readPointer: null,
    },
  });
}
it("ignores the hidden desktop preference on phones", () => {
  localStorage.setItem(key, "true");
  const view = render(lobby(null, true));
  fireEvent.click(view.getByRole("button", { name: "Members chat" }));
  expect(view.getByRole("dialog", { name: "Members chat" })).not.toBeNull();
  expect(view.queryByRole("button", { name: "Hide chat" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  expect(view.queryByRole("dialog")).toBeNull();
  expect(localStorage.getItem(key)).toBe("true");
});
for (const [language, hide, show] of [["es", "Ocultar chat", "Chat de miembros"], ["ca", "Amaga el xat", "Xat de membres"]] as const) {
  it(`translates the desktop controls in ${language}`, () => {
    const view = render(lobby(null, false, language));
    fireEvent.click(view.getByRole("button", { name: hide }));
    fireEvent.click(view.getByRole("button", { name: show }));
    expect(view.getByRole("button", { name: hide })).not.toBeNull();
  });
}
