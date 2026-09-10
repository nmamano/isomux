import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, act } = await import("@testing-library/react");
const { createElement, useEffect } = await import("react");
const { StoreProvider, useAppState, useDispatch } = await import("../store.tsx");
const { useMembersChatHydration } = await import("./useMembersChatHydration.ts");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
setShim(() => {}, () => {});
afterAll(() => { setApiShim(null); setShim(() => {}, () => {}); connect(() => {}, () => {}); });
let snapshot: ReturnType<typeof useAppState>;
let dispatch: ReturnType<typeof useDispatch>;
function Harness() {
  useMembersChatHydration(true);
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => { snapshot = state; dispatch = send; }, [state, send]);
  return null;
}
const pin = { id: "202608-00000001", kind: "user" as const, userId: "sam", userName: "Sam", content: "old pin", attachments: [], timestamp: 1, pinnedAt: 2 };
const page = (pinned: typeof pin[]) => ({ messages: [], pinned, hasMore: false, unread: 0, readPointer: null });
it("refreshes a removed pin from the capped history and ignores an older in-flight response", async () => {
  const resolve: ((value: unknown) => void)[] = [];
  setApiShim(async (method, path) => {
    expect(method).toBe('GET');
    expect(path.startsWith('/api/members-chat')).toBe(true);
    return new Promise((done) => resolve.push(done));
  });
  render(createElement(StoreProvider, null, createElement(Harness)));
  await act(async () => resolve[0](page([])));
  act(() => dispatch({ type: 'members_chat_message', message: pin, updateOnly: true }));
  expect(snapshot.membersChat.pinned).toEqual([pin]);
  expect(resolve.length).toBe(2);
  act(() => dispatch({ type: 'members_chat_deleted', id: pin.id }));
  expect(snapshot.membersChat.pinned).toEqual([]);
  expect(resolve.length).toBe(3);
  await act(async () => resolve[1](page([pin])));
  expect(snapshot.membersChat.pinned).toEqual([]);
  const next = { ...pin, id: '202608-00000002', pinnedAt: 1 };
  await act(async () => resolve[2](page([next])));
  expect(snapshot.membersChat.pinned).toEqual([next]);
  expect(snapshot.membersChat.pinsStale).toBe(false);
  expect(snapshot.membersChat.messages).toEqual([]);
  expect(snapshot.membersChat.unread).toBe(0);
});
