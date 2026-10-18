// The Asks page through the real App and store: the office bar entry counts
// the asks the page lists, opens /asks, and an agent's name there opens its
// chat. The page itself is covered in ui/components/AsksView.dom.test.tsx.

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

const ask = (id: string, agentId: string): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: 1_000,
  updatedAt: 1_000,
});

// Two asks from Scout, and one from an agent in a room this member does not
// see: GET /api/asks carries it, the client has no such agent.
const ASKS = [ask("q1", "a1"), ask("q2", "a1"), ask("q3", "hidden")];

setApiShim(async (_method, path) => {
  if (path === "/api/asks") return ASKS;
  if (path.startsWith("/api/members-chat"))
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  if (path === "/api/apps" || path.startsWith("/api/pager")) return [];
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
