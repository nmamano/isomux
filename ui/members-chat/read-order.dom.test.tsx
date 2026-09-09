import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent, waitFor } = await import("@testing-library/react");
const { createElement, useEffect } = await import("react");
const { StoreProvider, useAppState, useDispatch } = await import("../store.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const { RoomTabBar } = await import("../office/RoomTabBar.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
setShim(() => {});
afterAll(() => { setApiShim(null); setShim(() => {}); connect(() => {}, () => {}); });
let snapshot: ReturnType<typeof useAppState>;
let dispatch: ReturnType<typeof useDispatch>;
function Harness() {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => { snapshot = state; dispatch = send; }, [state, send]);
  return createElement(LanguageProvider, null, createElement(RoomTabBar), createElement(MembersChatPanel));
}
it("clears the Lobby badge when the later message has a lower random ID", async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const newestId = "202609-00000001";
  const reads: string[] = [];
  setApiShim(async (_method, path, body) => {
    if (path !== "/api/members-chat/read") throw new Error(path);
    reads.push((body as { lastReadId: string }).lastReadId);
    return { readPointer: newestId, unread: 0 };
  });
  const view = render(createElement(StoreProvider, null, createElement(Harness)));
  const first = { id: "202609-ffffffff", kind: "user" as const, userId: "sam", userName: "Sam", content: "First", timestamp: 1, attachments: [] };
  act(() => dispatch({ type: "members_chat_page", prepend: false, messages: [first, { ...first, id: newestId, content: "Latest", timestamp: 2 }], hasMore: false, readPointer: first.id, unread: 1 }));
  const list = view.container.querySelector("[data-members-chat-list]") as HTMLDivElement;
  fireEvent.scroll(list);
  expect(snapshot.membersChat.loaded).toBe(true);
  expect(document.visibilityState).toBe("visible");
  expect(list.scrollHeight - list.scrollTop - list.clientHeight < 80).toBe(true);
  expect(view.getByRole("img", { name: "Unread message: 1" }).hasAttribute("data-lobby-unread")).toBe(true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
  expect(reads).toEqual([newestId]);
  await waitFor(() => expect(snapshot.membersChat.unread).toBe(0));
  expect(view.container.querySelector("[data-lobby-unread]") === null).toBe(true);
  delete (document as unknown as Record<string, unknown>).visibilityState;
});
