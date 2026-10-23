import { afterAll, afterEach, expect, it, jest } from "bun:test";
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
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const en = translatorFor("en");
let dispatch: ReturnType<typeof useDispatch>;
// The mobile lobby as OfficeView mounts it: the chat only while the lobby is
// open on a phone.
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
afterEach(() => jest.useRealTimers());
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
// Well past the mark-read debounce, on a fake clock.
const settleRead = () =>
  act(async () => {
    jest.advanceTimersByTime(1000);
  });
it("shows the full_state unread on the closed chat, fetches the page only while the chat is open, marks it read there, and moves the dot to the mobile button", async () => {
  jest.useFakeTimers();
  const reads: unknown[] = [];
  let pages = 0;
  // A server that keeps the caller's pointer: a page reports it, a read moves it.
  let pointer: string | null = null;
  let held = [message];
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path.startsWith("/api/members-chat")) {
      pages++;
      return {
        messages: held,
        hasMore: false,
        readPointer: pointer,
        unread: held.at(-1)!.id === pointer ? 0 : 1,
      };
    }
    if (path === "/api/members-chat/read") {
      reads.push(body);
      pointer = (body as { lastReadId: string }).lastReadId;
      return { readPointer: pointer, unread: 0 };
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
  const entry = view.getByRole("button", {
    name: new RegExp(en.t("membersChat.title")),
  });
  expect(entry.querySelector("[data-lobby-unread]") !== null).toBe(true);
  expect(lobby.querySelector("[data-lobby-unread]")).toBeNull();
  expect(view.container.querySelectorAll("[data-lobby-unread]").length).toBe(1);
  // Closed, the chat never marks anything read.
  await settleRead();
  expect(reads).toEqual([]);
  fireEvent.click(entry);
  await act(async () => {});
  expect(view.getByRole("dialog")).not.toBeNull();
  expect(pages).toBe(1);
  // Open at the bottom of a visible page: the newest message is read, and the
  // server's answer clears the dot.
  await settleRead();
  expect(reads).toEqual([{ lastReadId: message.id }]);
  await act(async () => {});
  expect(view.container.querySelector("[data-lobby-unread]") === null).toBe(
    true,
  );
  // A reconnect while open refetches: full_state leaves the page unloaded.
  // The page already sits at the pointer, so nothing is read again.
  act(() =>
    fullState({ readPointer: message.id, unread: 0, latestId: message.id }),
  );
  await act(async () => {});
  expect(pages).toBe(2);
  await settleRead();
  expect(reads.length).toBe(1);
  fireEvent.click(view.getByRole("button", { name: en.t("common.back") }));
  expect(view.baseElement.querySelector('[role="dialog"]') === null).toBe(true);
  expect(document.activeElement === entry).toBe(true);
  // Closed again: a reconnect takes the count from full_state, no page.
  const later = { ...message, id: "202609-00000002", content: "Later" };
  held = [message, later];
  act(() =>
    fullState({ readPointer: message.id, unread: 1, latestId: later.id }),
  );
  await act(async () => {});
  expect(pages).toBe(2);
  expect(entry.querySelector("[data-lobby-unread]") !== null).toBe(true);
  // Reopening after that reconnect fetches the page it missed; leaving the
  // lobby before the debounce forgets the chat and its pending read.
  fireEvent.click(entry);
  await act(async () => {});
  expect(pages).toBe(3);
  expect(view.getByRole("dialog")).not.toBeNull();
  act(() => dispatch({ type: "set_lobby_open", open: false }));
  expect(view.queryByRole("dialog")).toBeNull();
  await settleRead();
  expect(reads.length).toBe(1);
  act(() => dispatch({ type: "set_lobby_open", open: true }));
  expect(view.queryByRole("dialog")).toBeNull();
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
  fireEvent.click(view.getByRole("button", { name: /Lobby/ }));
  fireEvent.click(
    view.getByRole("button", { name: en.t("membersChat.title") }),
  );
  await act(async () => {});
  expect(calls).toBe(1);
  expect(view.getByRole("alert")).not.toBeNull();
  setApiShim(async () => {
    calls++;
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  });
  fireEvent.click(
    view.getByRole("button", { name: en.t("membersChat.retry") }),
  );
  await act(async () => {});
  expect(calls).toBe(2);
  expect(view.queryByRole("alert")).toBeNull();
});

// The phone's chat on its own, as LobbyChat renders it in the lobby.
function bar(language: "en" | "es", count: number) {
  return onLanguage(language, createElement(LobbyChat), {
    isMobile: true,
    lobbyOpen: true,
    membersChat: {
      messages: [],
      loaded: false,
      hasMore: false,
      unread: count,
      readPointer: null,
    },
  });
}
const offline = async () => {
  throw new Error("offline");
};
it("opens and closes the phone chat as a modal: focus, scroll lock, trap, Escape", async () => {
  setApiShim(offline);
  const title = en.t("membersChat.title");
  const singular = en.tn("membersChat.unreadCount", 1);
  const plural = en.tn("membersChat.unreadCount", 2);
  expect(singular !== plural).toBe(true);
  const view = render(bar("en", 2));
  const dot = view.getByRole("img", { name: plural });
  expect(dot.getAttribute("title")).toBe(dot.getAttribute("aria-label"));
  view.rerender(bar("en", 1));
  expect(view.getByRole("img", { name: singular })).not.toBeNull();
  fireEvent.click(view.getByRole("button", { name: `${title} ${singular}` }));
  await act(async () => {});
  expect(view.getByRole("dialog", { name: title })).not.toBeNull();
  expect(document.activeElement?.textContent).toBe(en.t("common.back"));
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.documentElement.style.overflow).toBe("hidden");
  expect(
    view.getByRole("button", { name: en.t("membersChat.retry") }),
  ).not.toBeNull();
  fireEvent.click(view.getByRole("button", { name: en.t("common.back") }));
  expect(view.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  expect(document.documentElement.style.overflow).toBe("");
  const entry = view.getByRole("button", { name: `${title} ${singular}` });
  expect(document.activeElement === entry).toBe(true);
  fireEvent.click(entry);
  entry.focus();
  expect(view.getByRole("dialog").contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, {
    key: "Escape",
    bubbles: true,
  });
  expect(view.queryByRole("dialog")).toBeNull();
  expect(document.activeElement === entry).toBe(true);
});
it("renders the phone chat's button, unread dot, dialog and Back through the catalog", async () => {
  setApiShim(offline);
  async function labels(language: "en" | "es") {
    const view = render(bar(language, 1));
    const entry = view.container.querySelector("[data-lobby-chat-fab]")!;
    const button = entry.getAttribute("aria-label") ?? "";
    const dot =
      entry.querySelector("[data-lobby-unread]")?.getAttribute("aria-label") ??
      "";
    fireEvent.click(entry);
    await act(async () => {});
    const dialog = view.getByRole("dialog");
    const name = dialog.getAttribute("aria-label") ?? "";
    // The focused control on open is the Back button.
    const back = document.activeElement?.textContent ?? "";
    view.unmount();
    return [button, dot, name, back];
  }
  const english = await labels("en");
  for (const label of english) expect(label.length > 0).toBe(true);
  const spanish = await labels("es");
  spanish.forEach((label, index) => {
    expect(label.length > 0 && label !== english[index]).toBe(true);
  });
});
