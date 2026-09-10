import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement, useEffect, Fragment } = await import("react");
const { StateCtx, StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { LobbyChat } = await import("./LobbyChat.tsx");
const { RoomTabBar } = await import("../office/RoomTabBar.tsx");
const { useMembersChatHydration } =
  await import("./useMembersChatHydration.ts");
const { setApiShim } = await import("../api.ts");
const { connect, setShim } = await import("../ws.ts");
const { LanguageProvider } = await import("../i18n.tsx");
let dispatch: ReturnType<typeof useDispatch>;
let mobile = true;
let enabled = true;
function Content() {
  const { loadFailed, retry } = useMembersChatHydration(enabled);
  const { lobbyOpen, isMobile } = useAppState();
  return createElement(Fragment, null, createElement(RoomTabBar),
    lobbyOpen && isMobile && createElement(LobbyChat, { loadFailed, onRetry: retry }));
}
function Harness() {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => {
    dispatch = send;
  }, [send]);
  return createElement(
    StateCtx.Provider,
    { value: { ...state, isMobile: mobile } },
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
it("hydrates the closed chat, moves its dot to the mobile entry, clears on a read pointer, and closes back to the scene", async () => {
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
  await act(async () => {});
  expect(pages).toBe(1);
  const lobby = view.getByRole("button", { name: /Lobby/ });
  expect(
    lobby.querySelector("[data-lobby-unread]")?.getAttribute("aria-label"),
  ).toBe("Unread message: 1");
  expect(view.queryByRole("dialog")).toBeNull();
  expect(reads).toEqual([]);
  fireEvent.click(lobby);
  const entry = view.getByRole("button", { name: /Members chat/ });
  expect(entry.querySelector("[data-lobby-unread]")).not.toBeNull();
  expect(lobby.querySelector("[data-lobby-unread]")).toBeNull();
  expect(view.container.querySelectorAll("[data-lobby-unread]").length).toBe(1);
  fireEvent.click(entry);
  expect(view.getByRole("dialog", { name: "Members chat" })).not.toBeNull();
  expect(view.getByPlaceholderText("Message the members…")).not.toBeNull();
  expect(pages).toBe(1);
  act(() =>
    dispatch({ type: "members_chat_read", readPointer: message.id, unread: 0 }),
  );
  expect(view.container.querySelector("[data-lobby-unread]") === null).toBe(
    true,
  );
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  expect(view.baseElement.querySelector('[role="dialog"]') === null).toBe(true);
  expect(document.activeElement === entry).toBe(true);
  fireEvent.click(entry);
  expect(view.getByRole("dialog")).not.toBeNull();
  act(() => dispatch({ type: "set_lobby_open", open: false }));
  expect(view.queryByRole("dialog")).toBeNull();
  act(() => dispatch({ type: "set_lobby_open", open: true }));
  expect(view.queryByRole("dialog")).toBeNull();
  act(() =>
    dispatch({
      type: "members_chat_message",
      message: { ...message, id: "202609-00000002" },
    }),
  );
  expect(view.getByRole("img", { name: "Unread message: 1" })).not.toBeNull();
  expect(reads).toEqual([]);
  act(() =>
    dispatch({
      type: "full_state",
      agents: [],
      recentCwds: [],
      office: { prompt: null, name: null },
      rooms: [],
      killedAgents: [],
    }),
  );
  await act(async () => {});
  expect(pages).toBe(2);
  expect(reads).toEqual([]);
});
it("does not hydrate when disabled, and contains a load failure", async () => {
  enabled = false;
  mobile = true;
  let calls = 0;
  setApiShim(async () => {
    calls++;
    throw new Error("offline");
  });
  const view = render(
    createElement(StoreProvider, null, createElement(Harness)),
  );
  await act(async () => {});
  expect(calls).toBe(0);
  enabled = true;
  view.rerender(createElement(StoreProvider, null, createElement(Harness)));
  await act(async () => {});
  expect(calls).toBe(1);
  fireEvent.click(view.getByRole("button", { name: "Lobby" }));
  fireEvent.click(view.getByRole("button", { name: "Members chat" }));
  expect(view.getByRole("alert").textContent).toContain(
    "Could not load the chat",
  );
  setApiShim(async () => {
    calls++;
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  });
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await act(async () => {});
  expect(calls).toBe(2);
  expect(view.queryByRole("alert")).toBeNull();
});
