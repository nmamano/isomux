// The Asks page through the real App and store: the office bar entry counts
// the asks the page lists, opens /asks, and an agent's name there opens its
// chat. An ask's link opens its office page over the page or chat it was
// clicked on, and Back returns there. The page itself is covered in
// ui/components/AsksView.dom.test.tsx.

import { afterAll, beforeEach, expect, it } from "bun:test";
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

setApiShim(async (_method, path) => {
  if (path === "/api/asks") return ASKS;
  if (path.startsWith("/api/members-chat"))
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  if (path === "/api/apps" || path.startsWith("/api/pager")) return [];
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
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

async function boot() {
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
  // Let GET /api/asks land.
  await act(async () => {});
  return view;
}

const asksButton = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll("button")].find(
    (b) =>
      b.querySelector(".nav-action-label")?.textContent === en["asks.title"],
  );

it("counts the asks the page lists, opens /asks, and opens a chat from it", async () => {
  const view = await boot();
  const button = asksButton(view)!;
  expect(button).toBeDefined();
  // The hidden-room ask is in the store but neither counted nor listed.
  expect(button.querySelector(".nav-action-badge")?.textContent).toBe("2");
  await act(async () => fireEvent.click(button));
  expect(window.location.pathname).toBe("/asks");
  expect(view.container.querySelectorAll("[data-ask]").length).toBe(2);
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

async function go(move: "back" | "forward"): Promise<void> {
  await act(async () => {
    window.history[move]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const officeLink = (view: ReturnType<typeof render>, ask: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `[data-ask="${ask}"] [data-ask-office-link]`,
  );

it("opens an ask's office page over the Asks page, and Back returns to the Asks page", async () => {
  const view = await boot();
  await act(async () => fireEvent.click(asksButton(view)!));
  expect(window.location.pathname).toBe("/asks");
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
  expect(window.location.pathname).toBe("/asks");
  expect(view.container.querySelectorAll("[data-asks-group]").length).toBe(1);
  expect(view.container.querySelector("[data-integrations-tab]")).toBeNull();
});

it("opens an ask's office page over the chat, and Back returns to the chat", async () => {
  const view = await boot();
  await act(async () => fireEvent.click(asksButton(view)!));
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
