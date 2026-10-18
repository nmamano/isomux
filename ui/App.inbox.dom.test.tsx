// The Inbox through the real App and store: the office bar entry counts the
// open pages and asks, opens the tab that has work, the tabs switch in place,
// and the old /pager and /asks paths land on their tab. An ask's link opens its
// office page over the Inbox or the chat it was clicked on, and Back returns
// there. The tabs' own views are covered in ui/components/PagerView.dom.test.tsx
// and AsksView.dom.test.tsx.

import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { SceneDecorationContext } =
  await import("./office/scene-decoration.tsx");
const { StoreProvider } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { connect, setShim, shimEmit } = await import("./ws.ts");
const { en } = await import("../shared/i18n/en.ts");
type AgentInfo = import("../shared/types.ts").AgentInfo;
type AskEntry = import("../shared/types.ts").AskEntry;
type PagerEntry = import("../shared/types.ts").PagerEntry;

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

const ask = (id: string, agentId: string, link?: string): AskEntry => ({
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

const page = (id: string, targetUserId: string): PagerEntry => ({
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
let pushState: ReturnType<typeof spyOn>;
beforeEach(() => {
  pages = [];
  asks = ASKS;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  pushState = spyOn(window.history, "pushState");
});
afterEach(() => pushState.mockRestore());

async function boot(path = "/") {
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

type View = ReturnType<typeof render>;

const inboxButton = (view: View) =>
  [...view.container.querySelectorAll("button")].find(
    (b) => b.querySelector(".nav-action-label")?.textContent === en["nav.inbox"],
  );
const tab = (view: View, id: "pager" | "asks") =>
  view.container.querySelector<HTMLButtonElement>(`[data-inbox-tab="${id}"]`);
const selectedTab = (view: View) =>
  view.container
    .querySelector('[role="tab"][aria-selected="true"]')
    ?.getAttribute("data-inbox-tab") ?? null;
const tabCount = (view: View, id: "pager" | "asks") =>
  tab(view, id)?.querySelector("[data-inbox-count]")?.textContent ?? null;
const pageRows = (view: View) =>
  view.container.querySelectorAll("[data-pager-id]").length;
const askCards = (view: View) =>
  view.container.querySelectorAll("[data-ask]").length;

it("counts open pages plus open asks, and opens on Pages while the member has an open page", async () => {
  // One page for this member, one for someone else: only the first counts.
  pages = [page("p1", "u1"), page("p2", "u2")];
  const view = await boot();
  const button = inboxButton(view)!;
  expect(button).toBeDefined();
  // The hidden-room ask is in the store but neither counted nor listed.
  expect(button.querySelector(".nav-action-badge")?.textContent).toBe("3");
  await act(async () => fireEvent.click(button));
  expect(window.location.pathname).toBe("/inbox/pages");
  expect(selectedTab(view)).toBe("pager");
  expect(tabCount(view, "pager")).toBe("1");
  expect(tabCount(view, "asks")).toBe("2");
  expect(pageRows(view)).toBe(2);
  expect(askCards(view)).toBe(0);
  // The panel is labelled by the selected tab.
  const panel = view.container.querySelector('[role="tabpanel"]')!;
  expect(panel.getAttribute("aria-labelledby")).toBe(tab(view, "pager")!.id);
});

it("opens on Asks with no open page, and an agent's name there opens its chat", async () => {
  // Someone else's page is listed on Pages but does not pick the tab.
  pages = [page("p2", "u2")];
  const view = await boot();
  const button = inboxButton(view)!;
  expect(button.querySelector(".nav-action-badge")?.textContent).toBe("2");
  await act(async () => fireEvent.click(button));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(tabCount(view, "pager")).toBeNull();
  expect(askCards(view)).toBe(2);
  const name = view.container.querySelector<HTMLButtonElement>(
    '[data-asks-agent="a1"]',
  )!;
  await act(async () => fireEvent.click(name));
  // The page closed and the chat is open: the chat's own stack shows
  // Scout's asks, and the page's groups are gone.
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
});

it("switches tabs in place, and closes from either tab to what was under the Inbox", async () => {
  pages = [page("p2", "u2")];
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(selectedTab(view)).toBe("asks");
  const pushes = pushState.mock.calls.length;
  const entries = window.history.length;
  await act(async () => fireEvent.click(tab(view, "pager")!));
  expect(window.location.pathname).toBe("/inbox/pages");
  expect(selectedTab(view)).toBe("pager");
  expect(pageRows(view)).toBe(1);
  expect(askCards(view)).toBe(0);
  await act(async () => fireEvent.click(tab(view, "asks")!));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(askCards(view)).toBe(2);
  await act(async () => fireEvent.click(tab(view, "pager")!));
  // A tab switch adds no history entry.
  expect(pushState.mock.calls.length).toBe(pushes);
  expect(window.history.length).toBe(entries);
  // The close leaves the Inbox, not the tab the member came from.
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector('[role="tablist"]')).toBeNull();
  expect(inboxButton(view)).toBeDefined();
});

it("closes the Inbox with one Escape", async () => {
  const view = await boot("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  await act(async () => fireEvent.click(tab(view, "pager")!));
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector('[role="tablist"]')).toBeNull();
});

it("lands the old /pager and /asks paths, and a bare /inbox, on their tab", async () => {
  for (const [path, selected, canonical] of [
    ["/pager", "pager", "/inbox/pages"],
    ["/asks", "asks", "/inbox/asks"],
    ["/inbox", "pager", "/inbox/pages"],
  ] as const) {
    const view = await boot(path);
    expect(selectedTab(view)).toBe(selected);
    expect(window.location.pathname).toBe(canonical);
    view.unmount();
  }
});

async function go(move: "back" | "forward"): Promise<void> {
  await act(async () => {
    window.history[move]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const officeLink = (view: View, ask: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `[data-ask="${ask}"] [data-ask-office-link]`,
  );

it("opens an ask's office page over the Asks tab, and Back returns to the Asks tab", async () => {
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");
  // App provides the opener, so the card draws the link.
  expect(officeLink(view, "q1")).not.toBeNull();
  await act(async () => fireEvent.click(officeLink(view, "q1")!));
  // The Integrations page, on the MCP servers tab.
  expect(window.location.pathname).toBe("/integrations");
  expect(
    view.container
      .querySelector('[data-integrations-tab][aria-selected="true"]')
      ?.getAttribute("data-integrations-tab"),
  ).toBe("mcp");
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();

  await go("back");
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(view.container.querySelectorAll("[data-asks-group]").length).toBe(1);
  expect(view.container.querySelector("[data-integrations-tab]")).toBeNull();
});

it("opens an ask's office page over the chat, and Back returns to the chat", async () => {
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await act(async () =>
    fireEvent.click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-asks-agent="a1"]',
      )!,
    ),
  );
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
  expect(officeLink(view, "q2")).not.toBeNull();
  await act(async () => fireEvent.click(officeLink(view, "q2")!));
  expect(window.location.pathname).toBe("/settings");
  expect(view.container.querySelector("[data-asks-stack]")).toBeNull();

  await go("back");
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
});

it("switches to the Pages tab for an ask's link to it, and closes out of the Inbox", async () => {
  asks = [ask("q1", "a1", "/inbox/pages")];
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(selectedTab(view)).toBe("asks");
  await act(async () => fireEvent.click(officeLink(view, "q1")!));
  expect(window.location.pathname).toBe("/inbox/pages");
  expect(selectedTab(view)).toBe("pager");
  // The tabs do not stack: the close leaves the Inbox, not the Asks tab.
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector('[role="tablist"]')).toBeNull();
});
