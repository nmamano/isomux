import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement, useEffect, Fragment } = await import("react");
const { StateCtx, StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { LobbyChat } = await import("./LobbyChat.tsx");
const { RoomTabBar } = await import("../office/RoomTabBar.tsx");
const { setApiShim } = await import("../api.ts");
const { connect, setShim } = await import("../ws.ts");
const { LanguageProvider } = await import("../i18n.tsx");
let dispatch: ReturnType<typeof useDispatch>;
function Content() {
  const { lobbyOpen, isMobile } = useAppState();
  return createElement(
    Fragment,
    null,
    createElement(RoomTabBar),
    lobbyOpen && isMobile && createElement(LobbyChat),
  );
}
function Harness() {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => {
    dispatch = send;
  }, [send]);
  return createElement(
    StateCtx.Provider,
    { value: { ...state, isMobile: true } },
    createElement(LanguageProvider, null, createElement(Content)),
  );
}
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
const message = {
  id: "202609-00000001",
  kind: "user" as const,
  userId: "other",
  userName: "Sam",
  content: "Hello",
  attachments: [],
  timestamp: 1,
};
// A reconnect: full_state with the caller's summary, or without one (an older
// server). One room, so the reducer does not open the lobby by itself.
const fullState = (membersChat?: {
  readPointer: string | null;
  unread: number;
  latestId: string | null;
}) =>
  dispatch({
    type: "full_state",
    agents: [],
    recentCwds: [],
    office: { prompt: null, name: null },
    rooms: [{ id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true }],
    killedAgents: [],
    ...(membersChat ? { membersChat } : {}),
  });
it("shows the full_state unread on the closed chat, fetches the page only while the chat is open, and moves the dot to the mobile button", async () => {
  const reads: unknown[] = [];
  let pages = 0;
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path.startsWith("/api/members-chat")) {
      pages++;
      return {
        messages: [message],
        hasMore: false,
        readPointer: null,
        unread: 1,
      };
    }
    if (path === "/api/members-chat/read") {
      reads.push(body);
      return { readPointer: message.id, unread: 0 };
    }
    return {};
  });
  const view = render(
    createElement(StoreProvider, null, createElement(Harness)),
  );
  act(() => fullState({ readPointer: null, unread: 1, latestId: message.id }));
  await act(async () => {});
  expect(pages).toBe(0);
  const lobby = view.getByRole("button", { name: /Lobby/ });
  expect(lobby.querySelector("[data-lobby-unread]") !== null).toBe(true);
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.click(lobby);
  await act(async () => {});
  expect(pages).toBe(0);
  const entry = view.getByRole("button", { name: /Members chat/ });
  expect(entry.querySelector("[data-lobby-unread]") !== null).toBe(true);
  expect(lobby.querySelector("[data-lobby-unread]")).toBeNull();
  expect(view.container.querySelectorAll("[data-lobby-unread]").length).toBe(1);
  fireEvent.click(entry);
  await act(async () => {});
  expect(view.getByRole("dialog")).not.toBeNull();
  expect(pages).toBe(1);
  // A reconnect while open refetches: full_state leaves the page unloaded.
  act(() => fullState({ readPointer: null, unread: 1, latestId: message.id }));
  await act(async () => {});
  expect(pages).toBe(2);
  act(() =>
    dispatch({ type: "members_chat_read", readPointer: message.id, unread: 0 }),
  );
  expect(view.container.querySelector("[data-lobby-unread]") === null).toBe(
    true,
  );
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  expect(view.baseElement.querySelector('[role="dialog"]') === null).toBe(true);
  expect(document.activeElement === entry).toBe(true);
  // Closed again: a reconnect takes the count from full_state, no page.
  act(() => fullState({ readPointer: message.id, unread: 2, latestId: "x" }));
  await act(async () => {});
  expect(pages).toBe(2);
  expect(entry.querySelector("[data-lobby-unread]") !== null).toBe(true);
  // Reopening after that reconnect fetches the page it missed.
  fireEvent.click(entry);
  await act(async () => {});
  expect(pages).toBe(3);
  act(() => dispatch({ type: "set_lobby_open", open: false }));
  expect(view.queryByRole("dialog")).toBeNull();
  act(() => dispatch({ type: "set_lobby_open", open: true }));
  expect(view.queryByRole("dialog")).toBeNull();
  expect(reads).toEqual([]);
});
it("keeps the last unread when full_state carries no summary", async () => {
  setApiShim(async () => {
    throw new Error("no page fetch expected");
  });
  const view = render(
    createElement(StoreProvider, null, createElement(Harness)),
  );
  act(() => fullState({ readPointer: null, unread: 3, latestId: message.id }));
  act(() => fullState());
  await act(async () => {});
  expect(
    view
      .getByRole("button", { name: /Lobby/ })
      .querySelector("[data-lobby-unread]") !== null,
  ).toBe(true);
  act(() =>
    fullState({ readPointer: message.id, unread: 0, latestId: message.id }),
  );
  expect(view.container.querySelector("[data-lobby-unread]") === null).toBe(
    true,
  );
});
it("contains a load failure in the open chat and retries", async () => {
  let calls = 0;
  setApiShim(async () => {
    calls++;
    throw new Error("offline");
  });
  const view = render(
    createElement(StoreProvider, null, createElement(Harness)),
  );
  act(() => fullState({ readPointer: null, unread: 0, latestId: null }));
  await act(async () => {});
  expect(calls).toBe(0);
  fireEvent.click(view.getByRole("button", { name: "Lobby" }));
  fireEvent.click(view.getByRole("button", { name: "Members chat" }));
  await act(async () => {});
  expect(calls).toBe(1);
  expect(view.getByRole("alert")).not.toBeNull();
  setApiShim(async () => {
    calls++;
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  });
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await act(async () => {});
  expect(calls).toBe(2);
  expect(view.queryByRole("alert")).toBeNull();
});
