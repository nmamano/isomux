import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement, useEffect } = await import("react");
const { StateCtx, StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { connect, setShim } = await import("../ws.ts");
const { OfficeView } = await import("../office/OfficeView.tsx");
const { SceneDecorationContext } =
  await import("../office/scene-decoration.tsx");
const noop = () => {};
// No floor, seasonal art or lobby props: nothing here asserts on them.
const undecorated = (child: ReturnType<typeof createElement>) =>
  createElement(SceneDecorationContext.Provider, { value: false }, child);
const { setApiShim } = await import("../api.ts");
// The saved choice older builds wrote. Nothing reads it now.
const key = "isomux-members-chat-hidden";
let pages = 0;
setApiShim(async (method, path) => {
  if (method === "GET" && path.startsWith("/api/members-chat")) {
    pages++;
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  }
  return { readPointer: null, unread: 0 };
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
  pages = 0;
  window.history.replaceState(null, "", "/");
});
// The real store under the desktop lobby, driven by full_state frames.
// `office: false` unmounts OfficeView, as App does while an agent is focused.
let dispatch: ReturnType<typeof useDispatch>;
function Live({ office = true }) {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => {
    dispatch = send;
  }, [send]);
  return createElement(
    StateCtx.Provider,
    { value: { ...state, isMobile: false } },
    createElement(
      LanguageProvider,
      null,
      office
        ? undecorated(
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
          )
        : null,
    ),
  );
}
const live = (props: { office?: boolean } = {}) =>
  createElement(StoreProvider, null, createElement(Live, props));
const fullState = (unread: number) =>
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
      membersChat: { readPointer: null, unread },
    }),
  );
const settle = () => act(async () => {});
// The first full_state of a load, then the Lobby tab.
const boot = async (unread: number) => {
  fullState(unread);
  act(() => dispatch({ type: "set_lobby_open", open: true }));
  await settle();
};
const panel = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-members-chat-list]") !== null;
it("starts closed on every load, even over an old saved 'shown' choice and a chat with messages; one click shows it and Hide closes it, with nothing saved", async () => {
  localStorage.setItem(key, "false");
  const view = render(live());
  await boot(1);
  const zoom = () =>
    view.getByRole("button", { name: "Zoom in" }).parentElement!;
  expect(panel(view)).toBe(false);
  expect(zoom().style.right).toBe("12px");
  fireEvent.click(view.getByRole("button", { name: /Members chat/ }));
  expect(panel(view)).toBe(true);
  expect(zoom().style.right).toBe("532px");
  fireEvent.click(view.getByRole("button", { name: "Hide chat" }));
  expect(panel(view)).toBe(false);
  expect(zoom().style.right).toBe("12px");
  expect(localStorage.getItem(key)).toBe("false");
  // Open it again, then load the page again: a new store starts closed.
  fireEvent.click(view.getByRole("button", { name: /Members chat/ }));
  expect(panel(view)).toBe(true);
  view.unmount();
  expect(localStorage.length).toBe(1);
  expect(localStorage.getItem(key)).toBe("false");
  const reload = render(live());
  await boot(1);
  expect(panel(reload)).toBe(false);
  expect(localStorage.length).toBe(1);
});
it("an open chat stays open within the page load: across an agent focus and back, a room tab and back, and a reconnect", async () => {
  const view = render(live());
  await boot(1);
  fireEvent.click(view.getByRole("button", { name: /Members chat/ }));
  expect(panel(view)).toBe(true);
  // An agent is focused: OfficeView unmounts, then mounts again.
  view.rerender(live({ office: false }));
  expect(view.queryByRole("button", { name: "Zoom in" })).toBeNull();
  view.rerender(live());
  expect(panel(view)).toBe(true);
  // A room tab, then the Lobby tab again.
  act(() => dispatch({ type: "set_current_room", roomId: "r1" }));
  expect(panel(view)).toBe(false);
  act(() => dispatch({ type: "set_lobby_open", open: true }));
  expect(panel(view)).toBe(true);
  // A server reconnect sends a new full_state.
  fullState(1);
  await settle();
  expect(panel(view)).toBe(true);
});
it("fetches the page only while the desktop chat is shown", async () => {
  const view = render(live());
  await boot(1);
  expect(pages).toBe(0);
  const button = view.getByRole("button", { name: /Members chat/ });
  expect(button.querySelector("[data-lobby-unread]") !== null).toBe(true);
  fireEvent.click(button);
  await settle();
  expect(pages).toBe(1);
  fullState(1);
  await settle();
  expect(pages).toBe(2);
  fireEvent.click(view.getByRole("button", { name: "Hide chat" }));
  fullState(1);
  await settle();
  expect(pages).toBe(2);
});
