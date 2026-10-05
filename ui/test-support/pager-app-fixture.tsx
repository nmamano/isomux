// Shared by the App-level pager tests (ui/App.pager-*.dom.test.tsx): the real
// App and store over a ws shim, with every GET /api/pager held until the test
// settles it. Split across files to keep each under the DOM per-file cap.

import { afterAll, beforeEach } from "bun:test";
const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("../App.tsx");
const { SceneDecorationContext } =
  await import("../office/scene-decoration.tsx");
const { StoreProvider } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { connect, setShim, shimEmit } = await import("../ws.ts");
const { en } = await import("../../shared/i18n/en.ts");
type PagerEntry = import("../../shared/types.ts").PagerEntry;

// Every GET /api/pager waits here until the test settles it.
export const pending: {
  path: string;
  resolve: (v: PagerEntry[]) => void;
  reject: (e: unknown) => void;
}[] = [];

export function setupPagerAppTests() {
  setApiShim((_method, path) => {
    if (path.startsWith("/api/pager")) {
      return new Promise((resolve, reject) => {
        pending.push({
          path,
          resolve,
          reject,
        });
      });
    }
    if (path.startsWith("/api/members-chat"))
      return Promise.resolve({
        messages: [],
        hasMore: false,
        readPointer: null,
        unread: 0,
      });
    if (path === "/api/apps") return Promise.resolve([]);
    return Promise.resolve({});
  });
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
    pending.length = 0;
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
}

const rooms = [
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
];

export const fullState = () =>
  shimEmit({
    type: "full_state",
    agents: [],
    rooms,
    office: { name: "Test Office" },
    recentCwds: [],
    killedAgents: [],
    interactions: [],
  } as never);

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

export async function boot(path: string) {
  window.history.replaceState(null, "", path);
  // ws.ts fires the shim's connect on a timer, so wait for it.
  let hydrated!: () => void;
  const hydration = new Promise<void>((resolve) => {
    hydrated = resolve;
  });
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: { username: "member", userId: "u1", role: "member" },
      } as never);
      fullState();
      hydrated();
    },
  );
  // No scene decorations: the office only has to carry the bar's badge.
  const view = render(
    createElement(
      StoreProvider,
      null,
      createElement(
        SceneDecorationContext.Provider,
        { value: false },
        createElement(App),
      ),
    ),
  );
  await act(async () => {
    await hydration;
  });
  return view;
}

export async function settle(index: number, entries: PagerEntry[]) {
  await act(async () => pending[index].resolve(entries));
}

export const badge = (view: ReturnType<typeof render>) =>
  view.container.querySelector(".nav-action-badge")?.textContent ?? null;
export const pagerButton = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll("button")].find(
    (b) =>
      b.querySelector(".nav-action-label")?.textContent === en["common.pager"],
  )!;
export const toggleOf = (view: ReturnType<typeof render>, id: string) =>
  view.container.querySelector<HTMLElement>(
    `[data-pager-id="${id}"] .pager-row-toggle`,
  );

export const rowIds = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll<HTMLElement>("[data-pager-id]")].map(
    (el) => el.dataset.pagerId,
  );

export { shimEmit, en };
