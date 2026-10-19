import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement, useEffect } = await import("react");
const { StateCtx, StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { connect, setShim } = await import("../ws.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { OfficeView } = await import("../office/OfficeView.tsx");
const noop = () => {};
const { setApiShim } = await import("../api.ts");
const key = "isomux-members-chat-hidden";
const reads: string[] = [];
let pages = 0;
setApiShim(async (method, path, body) => {
  if (method === "POST" && path === "/api/members-chat/read")
    reads.push((body as { lastReadId: string }).lastReadId);
  if (method === "GET" && path.startsWith("/api/members-chat")) {
    pages++;
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  }
  return { readPointer: reads.at(-1), unread: 0 };
});
setShim(
  () => {},
  () => {},
);
afterAll(() => {
  setApiShim(null);
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});
beforeEach(() => {
  localStorage.clear();
  reads.length = 0;
  pages = 0;
  window.history.replaceState(null, "", "/");
});
function lobby(
  id: string | null = null,
  mobile = false,
  language: "en" | "es" | "ca" = "en",
  // The full_state summary's newest id; absent means no summary yet.
  summary: { loaded?: boolean; latestId?: string | null } = {},
) {
  const { loaded = true } = summary;
  const latestId = "latestId" in summary ? summary.latestId : id;
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
        loaded,
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
        ...(latestId !== undefined ? { latestId } : {}),
      },
    },
  );
}
it("loads the saved choice and persists both showing and hiding the desktop chat", () => {
  localStorage.setItem(key, "true");
  const view = render(lobby());
  const zoom = () =>
    view.getByRole("button", { name: "Zoom in" }).parentElement!;
  expect(view.queryByPlaceholderText("Message the members…") === null).toBe(
    true,
  );
  expect(zoom().style.right).toBe("12px");
  fireEvent.click(view.getByRole("button", { name: "Members chat" }));
  expect(view.queryByPlaceholderText("Message the members…") !== null).toBe(
    true,
  );
  expect(localStorage.getItem(key)).toBe("false");
  expect(zoom().style.right).toBe("532px");
  fireEvent.click(view.getByRole("button", { name: "Hide chat" }));
  expect(view.queryByPlaceholderText("Message the members…") === null).toBe(
    true,
  );
  expect(localStorage.getItem(key)).toBe("true");
  expect(zoom().style.right).toBe("12px");
});
it("with no saved choice, starts minimized for an empty chat and stays so when a message arrives", () => {
  const view = render(lobby());
  expect(view.queryByPlaceholderText("Message the members…") === null).toBe(
    true,
  );
  view.rerender(lobby("01"));
  expect(view.queryByPlaceholderText("Message the members…") === null).toBe(
    true,
  );
  expect(localStorage.getItem(key)).toBe(null);
});
it("with no saved choice, stays minimized until the full_state summary arrives, then opens for a chat with messages", () => {
  const view = render(lobby("01", false, "en", { latestId: undefined }));
  expect(view.queryByPlaceholderText("Message the members…") === null).toBe(
    true,
  );
  // The summary decides, not the page: no page has loaded yet.
  view.rerender(lobby("01", false, "en", { loaded: false, latestId: "01" }));
  expect(view.queryByPlaceholderText("Message the members…") !== null).toBe(
    true,
  );
  expect(localStorage.getItem(key)).toBe(null);
});
it("with no saved choice, a summary of an empty chat starts minimized even when the page holds messages", () => {
  const view = render(lobby("01", false, "en", { latestId: null }));
  expect(view.queryByPlaceholderText("Message the members…") === null).toBe(
    true,
  );
});
it("a saved choice wins over the summary", () => {
  localStorage.setItem(key, "false");
  const shown = render(lobby(null, false, "en", { latestId: null }));
  expect(shown.queryByPlaceholderText("Message the members…") !== null).toBe(
    true,
  );
  shown.unmount();
  localStorage.setItem(key, "true");
  const hidden = render(lobby("01"));
  expect(hidden.queryByPlaceholderText("Message the members…") === null).toBe(
    true,
  );
});
it("with no saved choice, starts open when the chat has messages", () => {
  const view = render(lobby("01"));
  expect(view.queryByPlaceholderText("Message the members…") !== null).toBe(
    true,
  );
  expect(localStorage.getItem(key)).toBe(null);
});
// The real store under the desktop lobby, driven by full_state frames.
let dispatch: ReturnType<typeof useDispatch>;
function Live() {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => {
    dispatch = send;
  }, [send]);
  return createElement(
    StateCtx.Provider,
    { value: { ...state, lobbyOpen: true, isMobile: false } },
    createElement(
      LanguageProvider,
      null,
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
  );
}
const fullState = (latestId: string | null) =>
  act(() =>
    dispatch({
      type: "full_state",
      agents: [],
      recentCwds: [],
      office: { prompt: null, name: null },
      rooms: [
        { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
      ],
      killedAgents: [],
      membersChat: { readPointer: null, unread: latestId ? 1 : 0, latestId },
    }),
  );
const settle = () => act(async () => {});
it("fetches the page only while the desktop chat is shown", async () => {
  localStorage.setItem(key, "true");
  const view = render(createElement(StoreProvider, null, createElement(Live)));
  fullState("01");
  await settle();
  expect(pages).toBe(0);
  const button = view.getByRole("button", { name: /Members chat/ });
  expect(button.querySelector("[data-lobby-unread]") !== null).toBe(true);
  fireEvent.click(button);
  await settle();
  expect(pages).toBe(1);
  fullState("01");
  await settle();
  expect(pages).toBe(2);
  fireEvent.click(view.getByRole("button", { name: "Hide chat" }));
  fullState("01");
  await settle();
  expect(pages).toBe(2);
});
it("with no saved choice, the summary opens a chat with messages and its page loads; an empty one stays minimized with no fetch", async () => {
  const open = render(createElement(StoreProvider, null, createElement(Live)));
  fullState("01");
  await settle();
  expect(open.queryByRole("button", { name: "Hide chat" }) !== null).toBe(true);
  expect(pages).toBe(1);
  open.unmount();
  pages = 0;
  const empty = render(createElement(StoreProvider, null, createElement(Live)));
  fullState(null);
  await settle();
  expect(empty.queryByRole("button", { name: "Hide chat" }) === null).toBe(
    true,
  );
  expect(pages).toBe(0);
});
