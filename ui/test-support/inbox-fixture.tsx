// Shared by the Inbox tests through the real App and store
// (ui/App.inbox.dom.test.tsx, ui/App.inbox-ask-links.dom.test.tsx): one
// member with one agent, GET /api/asks and GET /api/pager answered from the
// lists below. Two files because each case boots the real store, and seven
// boots ran past the 5 s DOM cap under load. Import it with `await import(...)`
// after setUpDomTestFile(), like every DOM module.

import { afterAll, afterEach, beforeEach, spyOn } from "bun:test";
const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("../App.tsx");
const { SceneDecorationContext } =
  await import("../office/scene-decoration.tsx");
const { StoreProvider } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { connect, setShim, shimEmit } = await import("../ws.ts");
const { en } = await import("../../shared/i18n/en.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AskEntry = import("../../shared/types.ts").AskEntry;
type PagerEntry = import("../../shared/types.ts").PagerEntry;

const agent = {
  id: "a1",
  name: "Scout",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  capabilities: {},
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

export const ask = (id: string, agentId: string, link?: string): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...(link ? { link } : {}),
});

// Two asks from Scout, each with a link, and one from an agent in a room this
// member does not see: GET /api/asks carries it, the client has no such agent.
const ASKS = [
  ask("q1", "a1", "/integrations/mcp"),
  ask("q2", "a1", "/settings"),
  ask("q3", "hidden"),
];

export const page = (id: string, targetUserId: string): PagerEntry => ({
  id,
  createdAt: 1_000,
  lastRaisedAt: 1_000,
  raiseCount: 1,
  source: { kind: "agent", agentId: "a1", name: "Scout", roomId: "r1" },
  targetUserId,
  title: `Title ${id}`,
  state: "open",
  delivery: { state: "delivered", sends: 1 },
});

// The pages GET /api/pager returns; each test sets its own.
let pages: PagerEntry[] = [];
// The asks GET /api/asks returns; ASKS unless a test sets its own.
let asks: AskEntry[] = ASKS;
export function setPages(next: PagerEntry[]) {
  pages = next;
}
export function setAsks(next: AskEntry[]) {
  asks = next;
}
// App's pushes, spied afresh for each test.
let pushState: ReturnType<typeof spyOn<History, "pushState">> | null = null;
export const pushCount = () => pushState?.mock.calls.length ?? 0;

export function setUpInboxTests() {
  setApiShim(async (_method, path) => {
    if (path === "/api/asks") return asks;
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    if (path.startsWith("/api/pager")) return pages;
    if (path === "/api/apps") return [];
    // The pages an ask links to read their own lists; with no fixture they
    // show their error state rather than read a shape they do not expect.
    if (path.startsWith("/api/me/") || path === "/api/sessions")
      throw new Error("no fixture");
    return {};
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
    pages = [];
    asks = ASKS;
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    pushState = spyOn(window.history, "pushState");
  });
  afterEach(() => pushState?.mockRestore());
}

export async function boot(path = "/") {
  window.history.replaceState(null, "", path);
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
      shimEmit({
        type: "full_state",
        agents: [agent],
        rooms: [
          {
            id: "r1",
            name: "First room",
            prompt: null,
            canCloseWhenEmpty: true,
          },
        ],
        office: { name: "Test Office" },
        recentCwds: [],
        killedAgents: [],
        interactions: [],
      } as never);
      hydrated();
    },
  );
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
  // Let GET /api/asks and GET /api/pager land.
  await act(async () => {});
  await act(async () => {});
  return view;
}

export type View = ReturnType<typeof render>;

export const inboxButton = (view: View) =>
  [...view.container.querySelectorAll("button")].find(
    (b) =>
      b.querySelector(".nav-action-label")?.textContent === en["nav.inbox"],
  );
export const tab = (view: View, id: "pager" | "asks") =>
  view.container.querySelector<HTMLButtonElement>(`[data-inbox-tab="${id}"]`);
export const selectedTab = (view: View) =>
  view.container
    .querySelector('[role="tab"][aria-selected="true"]')
    ?.getAttribute("data-inbox-tab") ?? null;
export const tabCount = (view: View, id: "pager" | "asks") =>
  tab(view, id)?.querySelector("[data-inbox-count]")?.textContent ?? null;
export const pageRows = (view: View) =>
  view.container.querySelectorAll("[data-pager-id]").length;
export const askCards = (view: View) =>
  view.container.querySelectorAll("[data-ask]").length;

export async function go(move: "back" | "forward"): Promise<void> {
  await act(async () => {
    window.history[move]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export const officeLink = (view: View, ask: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `[data-ask="${ask}"] [data-ask-office-link]`,
  );
