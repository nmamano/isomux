import { afterAll, afterEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement, useEffect } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const { RoomTabBar } = await import("../office/RoomTabBar.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
setShim(() => {});
afterEach(() => {
  jest.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});
afterAll(() => {
  setApiShim(null);
  setShim(() => {});
  connect(
    () => {},
    () => {},
  );
});
const message = (id: string) => ({
  id,
  kind: "user" as const,
  userId: "other",
  userName: "Sam",
  content: id,
  attachments: [],
  timestamp: 1,
});
// Well past the mark-read debounce, on a fake clock: the step does not pin
// the debounce length, and no real time passes.
const settleRead = () =>
  act(async () => {
    jest.advanceTimersByTime(1000);
  });

it("marks a short visible list read, pauses in history and hidden tabs, and resumes at the bottom", async () => {
  jest.useFakeTimers();
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const reads: string[] = [];
  setApiShim(async (_method, path, body) => {
    if (path === "/api/members-chat/read")
      reads.push((body as { lastReadId: string }).lastReadId);
    return { readPointer: reads.at(-1), unread: 0 };
  });
  function panel(id: string, mobile = false) {
    return onLanguage("en", createElement(MembersChatPanel), {
      isMobile: mobile,
      membersChat: {
        loaded: true,
        messages: [message(id)],
        hasMore: false,
        unread: 1,
        readPointer: null,
      },
    });
  }
  const view = render(panel("01"));
  await settleRead();
  expect(reads).toEqual(["01"]);
  const list = view.container.querySelector(
    "[data-members-chat-list]",
  ) as HTMLDivElement;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 500 },
  });
  list.scrollTop = 100;
  fireEvent.scroll(list);
  view.rerender(panel("02"));
  await settleRead();
  expect(reads).toEqual(["01"]);
  expect(list.scrollTop).toBe(100);
  visibility = "hidden";
  fireEvent(document, new Event("visibilitychange"));
  list.scrollTop = 1500;
  fireEvent.scroll(list);
  await settleRead();
  expect(reads).toEqual(["01"]);
  visibility = "visible";
  fireEvent(document, new Event("visibilitychange"));
  await settleRead();
  expect(reads).toEqual(["01", "02"]);
  view.rerender(panel("03", true));
  await settleRead();
  expect(reads).toEqual(["01", "02", "03"]);
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
  return createElement(
    LanguageProvider,
    null,
    createElement(RoomTabBar),
    createElement(MembersChatPanel),
  );
}

it("clears the Lobby badge when the later message has a lower random ID", async () => {
  jest.useFakeTimers();
  const newestId = "202609-00000001";
  const reads: string[] = [];
  setApiShim(async (_method, path, body) => {
    if (path !== "/api/members-chat/read") throw new Error(path);
    reads.push((body as { lastReadId: string }).lastReadId);
    return { readPointer: newestId, unread: 0 };
  });
  const view = render(
    createElement(StoreProvider, null, createElement(Harness)),
  );
  const first = {
    id: "202609-ffffffff",
    kind: "user" as const,
    userId: "sam",
    userName: "Sam",
    content: "First",
    timestamp: 1,
    attachments: [],
  };
  act(() =>
    dispatch({
      type: "members_chat_page",
      prepend: false,
      messages: [
        first,
        { ...first, id: newestId, content: "Latest", timestamp: 2 },
      ],
      hasMore: false,
      readPointer: first.id,
      unread: 1,
    }),
  );
  const list = view.container.querySelector(
    "[data-members-chat-list]",
  ) as HTMLDivElement;
  fireEvent.scroll(list);
  expect(snapshot.membersChat.loaded).toBe(true);
  expect(document.visibilityState).toBe("visible");
  expect(list.scrollHeight - list.scrollTop - list.clientHeight < 80).toBe(
    true,
  );
  expect(view.container.querySelectorAll("[data-lobby-unread]").length).toBe(1);
  await settleRead();
  expect(reads).toEqual([newestId]);
  await act(async () => {});
  expect(snapshot.membersChat.unread).toBe(0);
  expect(view.container.querySelector("[data-lobby-unread]") === null).toBe(
    true,
  );
});
