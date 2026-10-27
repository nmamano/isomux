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
// This browser's last show or hide click.
const key = "isomux-members-chat-open";
// The saved choice builds before task a65bef42 wrote. Nothing reads it: an old
// "false" (shown) would open the chat over the door again.
const oldKey = "isomux-members-chat-hidden";
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
function Live({ office = true, mobile = false }) {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => {
    dispatch = send;
  }, [send]);
  return createElement(
    StateCtx.Provider,
    { value: { ...state, isMobile: mobile } },
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
const live = (props: { office?: boolean; mobile?: boolean } = {}) =>
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
const stored = () =>
  Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, i) => {
      const k = localStorage.key(i)!;
      return [k, localStorage.getItem(k)];
    }),
  );
const panel = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-members-chat-list]") !== null;
it("a load opens the chat only over this browser's saved open choice, never on a phone, and loading saves nothing", async () => {
  const cases: {
    saved: Record<string, string>;
    mobile?: boolean;
    open: boolean;
  }[] = [
    // Anchor: the saved choice is read at load.
    { saved: { [key]: "true" }, open: true },
    { saved: {}, open: false },
    { saved: { [oldKey]: "false" }, open: false },
    { saved: { [key]: "yes" }, open: false },
    // A phone's chat covers the whole lobby: it starts closed regardless.
    { saved: { [key]: "true" }, mobile: true, open: false },
  ];
  // One row per case, so a red run names every case that broke.
  const seen = [];
  for (const { saved, mobile } of cases) {
    localStorage.clear();
    for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v);
    const view = render(live({ mobile }));
    await boot(1);
    seen.push({
      saved,
      mobile,
      open: panel(view),
      // A phone's own chat is there, as a closed button.
      dialog: view.queryByRole("dialog") !== null,
      button: view.queryByRole("button", { name: /Members chat/ }) !== null,
      stored: stored(),
    });
    view.unmount();
  }
  expect(seen).toEqual(
    cases.map(({ saved, mobile, open }) => ({
      saved,
      mobile,
      open,
      dialog: false,
      button: !open,
      stored: saved,
    })),
  );
});
it("keeps the last show or hide click across a reload", async () => {
  const zoom = (view: ReturnType<typeof render>) =>
    view.getByRole("button", { name: "Zoom in" }).parentElement!;
  const view = render(live());
  await boot(1);
  expect(panel(view)).toBe(false);
  expect(zoom(view).style.right).toBe("12px");
  fireEvent.click(view.getByRole("button", { name: /Members chat/ }));
  expect(panel(view)).toBe(true);
  expect(zoom(view).style.right).toBe("532px");
  view.unmount();
  // A new store is a reload.
  const shown = render(live());
  await boot(1);
  expect(panel(shown)).toBe(true);
  expect(zoom(shown).style.right).toBe("532px");
  fireEvent.click(shown.getByRole("button", { name: "Hide chat" }));
  expect(panel(shown)).toBe(false);
  shown.unmount();
  const hidden = render(live());
  await boot(1);
  expect(panel(hidden)).toBe(false);
  expect(zoom(hidden).style.right).toBe("12px");
  hidden.unmount();
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
