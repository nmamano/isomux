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
it("defaults to visible and remembers hiding the desktop chat", () => {
  let view = render(lobby());
  const zoom = () => view.getByRole("button", { name: "Zoom in" }).parentElement!;
  expect(zoom().style.right).toBe("392px");
  fireEvent.click(view.getByRole("button", { name: "Hide chat" }));
  expect(view.queryByPlaceholderText("Message the members…")).toBeNull();
  expect(zoom().style.right).toBe("12px");
  view.unmount();
  view = render(lobby());
  expect(view.queryByPlaceholderText("Message the members…")).toBeNull();
  expect(zoom().style.right).toBe("12px");
});
it("remembers showing the desktop chat again", () => {
  localStorage.setItem(key, "true");
  let view = render(lobby());
  const zoom = () => view.getByRole("button", { name: "Zoom in" }).parentElement!;
  fireEvent.click(view.getByRole("button", { name: "Members chat" }));
  expect(view.getByPlaceholderText("Message the members…")).not.toBeNull();
  expect(zoom().style.right).toBe("392px");
  view.unmount();
  view = render(lobby());
  expect(view.getByRole("button", { name: "Hide chat" })).not.toBeNull();
});
it("defaults an unknown stored value to visible", () => {
  localStorage.setItem(key, "broken");
  const view = render(lobby());
  expect(view.getByRole("button", { name: "Hide chat" })).not.toBeNull();
});
