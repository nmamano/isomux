import { afterAll, expect, it } from "bun:test";
import { lobbyChat, LOBBY_ROOM_ID } from "../test-support/room-chats.ts";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { createElement, useEffect } = await import("react");
const { StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { useRoomChatHydration } = await import("./useMembersChatHydration.ts");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
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
let snapshot: ReturnType<typeof useAppState>;
let dispatch: ReturnType<typeof useDispatch>;
// The real store with the hook enabled, as an open chat runs it.
function Harness() {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => {
    snapshot = state;
    dispatch = send;
  }, [state, send]);
  useRoomChatHydration(LOBBY_ROOM_ID);
  return null;
}
const message = (id: string) => ({
  id,
  kind: "user" as const,
  userId: "sam",
  userName: "Sam",
  content: id,
  timestamp: 1,
  attachments: [],
});
it("captures held IDs when a fresh request starts, retains live arrivals and ignores a superseded response", async () => {
  const replies: ((page: unknown) => void)[] = [];
  setApiShim(
    () =>
      new Promise((resolve) => {
        replies.push(resolve);
      }),
  );
  render(createElement(StoreProvider, null, createElement(Harness)));
  await act(async () => {
    replies[0]({
      messages: [message("202609-ffffffff")],
      unread: 0,
      readPointer: null,
      hasMore: true,
    });
  });
  const reconnect = () =>
    dispatch({
      type: "full_state",
      agents: [],
      rooms: [],
      recentCwds: [],
      office: { prompt: null, name: null },
      killedAgents: [],
    });
  act(reconnect);
  expect(replies.length).toBe(2);
  act(() =>
    dispatch({
      type: "room_chat_message",
      roomId: LOBBY_ROOM_ID,
      message: message("202609-00000001"),
    }),
  );
  await act(async () => {
    replies[1]({
      messages: [message("202609-eeeeeeee")],
      unread: 1,
      readPointer: null,
      hasMore: true,
    });
  });
  expect(lobbyChat(snapshot).messages.map((m) => m.id)).toEqual([
    "202609-eeeeeeee",
    "202609-00000001",
  ]);
  act(reconnect);
  act(reconnect);
  expect(replies.length).toBe(4);
  await act(async () => {
    replies[3]({
      messages: [message("202609-11111111")],
      unread: 0,
      readPointer: null,
      hasMore: false,
    });
  });
  await act(async () => {
    replies[2]({
      messages: [message("202609-aaaaaaaa")],
      unread: 9,
      readPointer: null,
      hasMore: false,
    });
  });
  expect(lobbyChat(snapshot).messages.map((m) => m.id)).toEqual([
    "202609-11111111",
  ]);
});
const pin = {
  id: "202608-00000001",
  kind: "user" as const,
  userId: "sam",
  userName: "Sam",
  content: "old pin",
  attachments: [],
  timestamp: 1,
  pinnedAt: 2,
};
const page = (pinned: (typeof pin)[]) => ({
  messages: [],
  pinned,
  hasMore: false,
  unread: 0,
  readPointer: null,
});
it("refreshes a removed pin from the capped history and ignores an older in-flight response", async () => {
  const resolve: ((value: unknown) => void)[] = [];
  setApiShim(async (method, path) => {
    expect(method).toBe("GET");
    expect(path.startsWith("/api/rooms/lobby/chat")).toBe(true);
    return new Promise((done) => resolve.push(done));
  });
  render(createElement(StoreProvider, null, createElement(Harness)));
  await act(async () => resolve[0](page([])));
  act(() =>
    dispatch({
      type: "room_chat_message",
      roomId: LOBBY_ROOM_ID,
      message: pin,
      updateOnly: true,
    }),
  );
  expect(lobbyChat(snapshot).pinned).toEqual([pin]);
  expect(resolve.length).toBe(2);
  act(() =>
    dispatch({ type: "room_chat_deleted", roomId: LOBBY_ROOM_ID, id: pin.id }),
  );
  expect(lobbyChat(snapshot).pinned).toEqual([]);
  expect(resolve.length).toBe(3);
  await act(async () => resolve[1](page([pin])));
  expect(lobbyChat(snapshot).pinned).toEqual([]);
  const next = { ...pin, id: "202608-00000002", pinnedAt: 1 };
  await act(async () => resolve[2](page([next])));
  expect(lobbyChat(snapshot).pinned).toEqual([next]);
  expect(lobbyChat(snapshot).pinsStale).toBe(false);
  expect(lobbyChat(snapshot).messages).toEqual([]);
  expect(lobbyChat(snapshot).unread).toBe(0);
});
