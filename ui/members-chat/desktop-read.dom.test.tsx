import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
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
function lobby(
  id: string | null = null,
  mobile = false,
  language: "en" | "es" | "ca" = "en",
) {
  return onLanguage(
    language,
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
    {
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
                kind: "user",
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
    },
  );
}
const settleRead = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
it("keeps incoming unread visible while hidden and marks the same message read only after show", async () => {
  const view = render(lobby());
  fireEvent.click(view.getByRole("button", { name: "Hide chat" }));
  view.rerender(lobby("02"));
  expect(
    view
      .getByRole("button", { name: /Lobby/ })
      .querySelector("[data-lobby-unread]") !== null,
  ).toBe(true);
  expect(view.getAllByRole("img", { name: "Unread message: 1" }).length).toBe(
    2,
  );
  expect(
    view
      .getByRole("button", { name: "Members chat" })
      .querySelector("[data-lobby-unread]") !== null,
  ).toBe(true);
  await settleRead();
  expect(reads).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Members chat" }));
  await settleRead();
  expect(reads).toEqual(["02"]);
});
