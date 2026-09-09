import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { createElement, useEffect } = await import("react");
const { StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { useMembersChatHydration } =
  await import("./useMembersChatHydration.ts");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
setShim(() => {});
afterAll(() => {
  setApiShim(null);
  setShim(() => {});
  connect(
    () => {},
    () => {},
  );
});
let snapshot: ReturnType<typeof useAppState>;
let dispatch: ReturnType<typeof useDispatch>;
function Harness() {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => {
    snapshot = state;
    dispatch = send;
  }, [state, send]);
  useMembersChatHydration(true);
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
      type: "members_chat_message",
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
  expect(snapshot.membersChat.messages.map((m) => m.id)).toEqual([
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
  expect(snapshot.membersChat.messages.map((m) => m.id)).toEqual([
    "202609-11111111",
  ]);
});
