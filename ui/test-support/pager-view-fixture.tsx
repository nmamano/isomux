// Shared by the PagerView DOM tests (ui/components/PagerView*.dom.test.tsx):
// the view over a real reducer, with an api shim the tests steer through
// `shim`. Split across files to keep each under the DOM per-file cap.

import { afterAll, beforeEach } from "bun:test";
const { act, render } = await import("@testing-library/react");
const { useReducer, useState, createElement } = await import("react");
const { PagerView } = await import("../components/PagerView.tsx");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
type PagerEntry = import("../../shared/types.ts").PagerEntry;
type AppListWire = import("../../shared/types.ts").AppListWire;
type AppState = typeof initialState;

export const shim = {
  calls: [] as string[],
  apps: [] as AppListWire[],
  failActions: false,
  current: [] as PagerEntry[],
  // When set, each GET /api/apps waits here until the test settles it.
  heldApps: null as ((list: AppListWire[]) => void)[] | null,
};

// The reducer's latest state and dispatch, and the deep-link setter.
export const h = {
  latest: initialState,
  dispatch: (() => {}) as (action: Parameters<typeof reducer>[1]) => void,
  requestSelect: (() => {}) as (r: { id: string } | null) => void,
};

export function setupPagerViewTests() {
  setApiShim(async (method, path) => {
    shim.calls.push(`${method} ${path}`);
    if (path === "/api/apps") {
      const held = shim.heldApps;
      if (held) return new Promise((resolve) => held.push(resolve));
      return shim.apps;
    }
    const m = /^\/api\/pager\/([^/]+)\/(ack|resolve)$/.exec(path);
    if (m && method === "POST") {
      if (shim.failActions) throw new Error("refused");
      const entry = shim.current.find((e) => e.id === m[1])!;
      const at = { by: "Nil", at: 2_000 };
      return m[2] === "ack"
        ? { ...entry, state: "acked", acked: at }
        : { ...entry, state: "resolved", resolved: at };
    }
    return {};
  });
  afterAll(() => setApiShim(null));
  beforeEach(() => {
    shim.calls.length = 0;
    shim.apps = [];
    shim.failActions = false;
    shim.heldApps = null;
  });
}

export function page(id: string, patch: Partial<PagerEntry> = {}): PagerEntry {
  return {
    id,
    createdAt: 1_000,
    lastRaisedAt: 1_000,
    raiseCount: 1,
    source: { kind: "agent", agentId: "a1", name: "Scout", roomId: "r1" },
    targetUserId: "u1",
    title: `Title ${id}`,
    state: "open",
    delivery: { state: "delivered", sends: 1 },
    ...patch,
  };
}

export async function mount(
  entries: PagerEntry[],
  patch: Partial<AppState> = {},
) {
  shim.current = entries;
  const seeded: AppState = {
    ...initialState,
    pager: entries,
    pagerLoaded: true,
    rooms: [
      { id: "r1", name: "One" },
      { id: "r2", name: "Two" },
    ] as AppState["rooms"],
    agents: [{ id: "a1", name: "Scout" }] as AppState["agents"],
    ...patch,
  };
  const focused: string[] = [];
  function Harness() {
    const [state, dispatch] = useReducer(reducer, seeded);
    const [request, setRequest] = useState<{ id: string } | null>(null);
    h.latest = state;
    h.dispatch = dispatch;
    h.requestSelect = setRequest;
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(PagerView, {
          onClose: () => {},
          onFocusAgent: (id: string) => focused.push(id),
          selectRequest: request,
          onSelectRequestHandled: () => setRequest(null),
        }),
      ),
    );
  }
  const view = render(createElement(Harness));
  // Let the view's app read land inside act.
  await act(async () => {});
  return { view, focused };
}

export const rowIds = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll<HTMLElement>("[data-pager-id]")].map(
    (el) => el.dataset.pagerId,
  );
export const row = (view: ReturnType<typeof render>, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-pager-id="${id}"]`)!;
export const toggle = (view: ReturnType<typeof render>, id: string) =>
  row(view, id).querySelector<HTMLButtonElement>(".pager-row-toggle")!;
export const selects = (view: ReturnType<typeof render>) =>
  view.container.querySelectorAll<HTMLSelectElement>("select");
