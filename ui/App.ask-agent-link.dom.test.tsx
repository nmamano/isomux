// An ask's link to an agent's chat (task 9aaec0eb), through the real App and
// store: the card's button on the Inbox's Asks tab closes the Inbox, switches
// to the agent's room and opens its chat, over the back screen for a back-room
// agent. Links to office pages are covered in App.inbox.dom.test.tsx.

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
const { BACK_SEAT_BASE } = await import("../shared/desks.ts");
type AgentInfo = import("../shared/types.ts").AgentInfo;
type AskEntry = import("../shared/types.ts").AskEntry;

const scout = {
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
// The link targets, in a second room: one at a desk, one in its back room.
const faraway = { ...scout, id: "a2", name: "Faraway", roomId: "r2" };
const backbencher = {
  ...scout,
  id: "a3",
  name: "Backbencher",
  roomId: "r2",
  desk: BACK_SEAT_BASE,
};

const ask = (id: string, agentId: string, link?: string): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...(link ? { link } : {}),
});

// The asks GET /api/asks returns; each test sets its own.
let asks: AskEntry[] = [];

setApiShim(async (_method, path) => {
  if (path === "/api/asks") return asks;
  if (path.startsWith("/api/members-chat"))
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  if (path.startsWith("/api/pager")) return [];
  if (path === "/api/apps") return [];
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
        agents: [scout, faraway, backbencher],
        rooms: [
          {
            id: "r1",
            name: "First room",
            prompt: null,
            canCloseWhenEmpty: true,
          },
          {
            id: "r2",
            name: "Second room",
            prompt: null,
            canCloseWhenEmpty: true,
            backRoom: true,
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
  await act(async () => {});
  return view;
}

type View = ReturnType<typeof render>;

// Open the Inbox on its Asks tab and click the link on ask q1.
async function clickLink(view: View) {
  const inbox = [...view.container.querySelectorAll("button")].find(
    (b) =>
      b.querySelector(".nav-action-label")?.textContent === en["nav.inbox"],
  )!;
  await act(async () => fireEvent.click(inbox));
  expect(
    view.container
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-inbox-tab"),
  ).toBe("asks");
  const link = view.container.querySelector<HTMLButtonElement>(
    '[data-ask="q1"] [data-ask-office-link]',
  );
  expect(link).not.toBeNull();
  await act(async () => fireEvent.click(link!));
}

async function escape() {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

// The room the office shows once the chat closes.
const activeRoom = (view: View) =>
  view.container
    .querySelector("[data-active-room-tab] [data-room-tab-button]")
    ?.getAttribute("data-room-tab-button") ?? null;
const backScreen = (view: View) =>
  view.container.querySelector("[data-back-room]") !== null;

it("opens the chat of the agent an ask links to, in that agent's room, out of the Inbox", async () => {
  asks = [ask("q1", "a1", "/agents/a2"), ask("q2", "a2")];
  const view = await boot();
  // The office opens away from Faraway's room.
  expect(activeRoom(view)).not.toBe("r2");
  await clickLink(view);
  // The Inbox closed and Faraway's chat is open: its own stack shows its ask.
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();
  expect(document.title).toContain("Faraway");
  expect(
    view.container
      .querySelector("[data-asks-stack] [data-ask]")
      ?.getAttribute("data-ask"),
  ).toBe("q2");
  // Out of the chat, the office is on Faraway's room, at the front.
  await escape();
  expect(document.title).not.toContain("Faraway");
  expect(activeRoom(view)).toBe("r2");
  expect(backScreen(view)).toBe(false);
  view.unmount();
});

it("opens a back-room agent's chat over its room's back screen", async () => {
  asks = [ask("q1", "a1", "/agents/a3")];
  const view = await boot();
  expect(activeRoom(view)).not.toBe("r2");
  expect(backScreen(view)).toBe(false);
  await clickLink(view);
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();
  expect(document.title).toContain("Backbencher");
  // Out of the chat, the back screen of Backbencher's room is open.
  await escape();
  expect(document.title).not.toContain("Backbencher");
  expect(activeRoom(view)).toBe("r2");
  expect(backScreen(view)).toBe(true);
  view.unmount();
});

it("opens a front agent's chat at the front, from a back agent's chat over the back screen", async () => {
  asks = [ask("q1", "a1", "/agents/a3"), ask("q2", "a3", "/agents/a2")];
  const view = await boot();
  await clickLink(view);
  expect(document.title).toContain("Backbencher");
  // Backbencher's chat, over the back screen, has its own ask's link.
  const link = view.container.querySelector<HTMLButtonElement>(
    '[data-asks-stack] [data-ask="q2"] [data-ask-office-link]',
  );
  expect(link).not.toBeNull();
  await act(async () => fireEvent.click(link!));
  expect(document.title).toContain("Faraway");
  // Out of Faraway's chat, the office is on the front of its room.
  await escape();
  expect(document.title).not.toContain("Faraway");
  expect(activeRoom(view)).toBe("r2");
  expect(backScreen(view)).toBe(false);
  view.unmount();
});
