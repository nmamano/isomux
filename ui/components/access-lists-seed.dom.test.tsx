import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

// Task 4860c373: session_context clears the loaded flag of each Settings
// list so the page requests it again. When a list's GET lands in the same
// render as that reset, the flag reads false before and after; the list must
// still be requested again, or its pane (and the pending member's sign-in
// link button) waits for good.
setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { reducer, initialState, StateCtx, DispatchCtx } =
  await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { useAccessListsSeed } = await import("./access-shared.tsx");
const { useRemovedMembersSeed } = await import("./RemovedMembersPane.tsx");
type AppState = import("../store.tsx").AppState;
type Action = Parameters<typeof reducer>[1];
type SessionContext = import("../../shared/types.ts").SessionContext;

afterAll(() => setApiShim(null));

const context = (connectionId: string): SessionContext => ({
  userId: "u1",
  username: "Tester",
  role: "owner",
  currentSessionPrefix: "00000000",
  connectionId,
});

// The page's seeds under the real reducer, as UserSettingsView mounts them.
function mount() {
  const live: { state: AppState; dispatch: (a: Action) => void } = {
    state: initialState,
    dispatch: () => {},
  };
  function Seeds() {
    useAccessListsSeed();
    useRemovedMembersSeed(true);
    return null;
  }
  function Store() {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      sessionContext: context("c1"),
    });
    live.state = state;
    live.dispatch = dispatch;
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(Seeds),
      ),
    );
  }
  render(createElement(Store));
  return live;
}

const LISTS = [
  {
    path: "/api/invites",
    loaded: (s: AppState) => s.invitesLoaded,
    landed: { type: "invites_list", invites: [] } as Action,
    reply: { invites: [] },
  },
  {
    path: "/api/sessions",
    loaded: (s: AppState) => s.activeSessionsLoaded,
    landed: { type: "sessions_active_list", sessions: [] } as Action,
    reply: { sessions: [] },
  },
  {
    path: "/api/removed-members",
    loaded: (s: AppState) => s.removedMembersLoaded,
    landed: { type: "removed_members", members: [] } as Action,
    reply: { members: [] },
  },
] as const;

it.each(LISTS.map((l) => [l.path, l] as const))(
  "a %s load that lands in one render with session_context is requested again",
  async (_, list) => {
    const gets: string[] = [];
    // Every GET waits until the test answers it.
    const pending: { path: string; resolve: (v: unknown) => void }[] = [];
    setApiShim(async (method, path) => {
      if (method === "GET") gets.push(path);
      return new Promise((resolve) => pending.push({ path, resolve }));
    });
    const live = mount();
    await act(async () => {});
    expect(gets.filter((p) => p === list.path)).toHaveLength(1);

    // The first GET's list and the reconnect's session_context, one render.
    act(() => {
      live.dispatch(list.landed);
      live.dispatch({ type: "session_context", context: context("c2") });
    });
    await act(async () => {});
    expect(list.loaded(live.state)).toBe(false);
    expect(gets.filter((p) => p === list.path)).toHaveLength(2);

    // The new GET's answer loads the list.
    await act(async () => {
      for (const get of pending.splice(0))
        if (get.path === list.path) get.resolve(list.reply);
    });
    expect(list.loaded(live.state)).toBe(true);
  },
);
