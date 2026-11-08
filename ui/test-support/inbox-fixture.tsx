// Shared by the Inbox tests through the real App and store
// (ui/App.inbox.dom.test.tsx, ui/App.inbox-ask-links.dom.test.tsx): one
// member with one agent, GET /api/asks answered from the list below, and
// GET /api/pager/<id> (an old page link, task 74e8fc07) from `pageAsks`. Two files because each case boots the real store, and seven
// boots ran past the 5 s DOM cap under load. Import it with `await import(...)`
// after setUpDomTestFile(), like every DOM module.

import { afterAll, afterEach, beforeEach, expect, spyOn } from "bun:test";
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("../App.tsx");
const { SceneDecorationContext } =
  await import("../office/scene-decoration.tsx");
const { FeaturesProvider, StoreProvider } = await import("../store.tsx");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");
const { ApiError, setApiShim } = await import("../api.ts");
const { connect, setShim, shimEmit } = await import("../ws.ts");
const { resetTaskLookupForTests } = await import("../task-lookup.ts");
const { en } = await import("../../shared/i18n/en.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AskEntry = import("../../shared/types.ts").AskEntry;
type AskMemberWire = import("../../shared/types.ts").AskMemberWire;

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

// A second agent in the same room, only in the tests that ask for it.
export const ranger: AgentInfo = {
  ...agent,
  id: "a2",
  name: "Ranger",
  desk: 1,
};

// Two agents in the same room's back room (desks 8+), only in the tests that
// ask for them.
export const builder: AgentInfo = {
  ...agent,
  id: "a8",
  name: "Builder",
  desk: 8,
};
export const checker: AgentInfo = {
  ...agent,
  id: "a9",
  name: "Checker",
  desk: 9,
};

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

// The ask each page id names, for GET /api/pager/<id>: a page id that is
// not here is a 404. Every read's id, in order.
let pageAsks: Record<string, string> = {};
export const pageReads: string[] = [];
export function setPageAsks(next: Record<string, string>) {
  pageAsks = next;
}
// The asks GET /api/asks returns; ASKS unless a test sets its own.
let asks: AskMemberWire[] = ASKS;
// The agents full_state carries: Scout, Ranger after addRanger(), and the
// back room's Builder and Checker after addBackRoom().
let agents: AgentInfo[] = [agent];
export function addRanger() {
  agents = [agent, ranger];
}
export function addBackRoom() {
  agents = [checker, agent, builder, ranger];
}
export function setAsks(next: AskMemberWire[]) {
  asks = next;
}
// The answers to GET /api/asks and GET /api/asks/others (task e2a2513b):
// the list above and an empty list unless a test sets its own, and how many
// reads each had.
const ownAsksGet = async (): Promise<unknown> => asks;
const noOthersAsks = async (): Promise<unknown> => [];
let asksGet: () => Promise<unknown> = ownAsksGet;
let othersAsksGet: () => Promise<unknown> = noOthersAsks;
export const asksGets = { own: 0, others: 0 };
export function setAsksGet(next: () => Promise<unknown>) {
  asksGet = next;
}
export function setOthersAsksGet(next: () => Promise<unknown>) {
  othersAsksGet = next;
}
// The member's role in session_context; "member" unless a test sets "owner".
let role: "member" | "owner" = "member";
export function setRole(next: "member" | "owner") {
  role = next;
}
// The answer to an ask's POST (reply, dismiss, file as a task); {} at once
// unless a test sets its own.
let answerPost: (path: string) => Promise<unknown> = async () => ({});
export function setAnswerPost(next: (path: string) => Promise<unknown>) {
  answerPost = next;
}
// The messages the member sent to an agent (POST /api/agents/<id>/messages),
// emptied for each test.
export const sentMessages: { path: string; body: Record<string, unknown> }[] =
  [];
// The answer to such a send; an ack at once unless a test sets its own.
let messagePost: () => Promise<unknown> = async () => ({
  messageId: "m",
  queued: false,
});
export function setMessagePost(next: () => Promise<unknown>) {
  messagePost = next;
}
// GET /api/asks/<id> (task 84aadfab): each read's id in order, and its
// answer, a 404 unless a test sets its own.
export const askReads: string[] = [];
const askNotFound = async (): Promise<unknown> => {
  throw new ApiError(404, "not_found", "No such ask.");
};
let askRead: (id: string) => Promise<unknown> = askNotFound;
export function setAskRead(next: (id: string) => Promise<unknown>) {
  askRead = next;
}
// GET /api/tasks (task 9ebe887d): the server's board, filtered by ids and
// status as the server filters it, and each read's ids and statuses in
// order. An empty board unless a test sets its own.
type TaskItem = import("../../shared/types.ts").TaskItem;
let taskBoard: TaskItem[] = [];
export const taskGets: { ids: string[] | null; statuses: string[] | null }[] =
  [];
export function setTaskBoard(next: TaskItem[]) {
  taskBoard = next;
}
function readTasks(path: string): TaskItem[] {
  const url = new URL(path, "http://office.test");
  const list = (name: string) => {
    const value = url.searchParams.get(name);
    return value === null ? null : value.split(",").filter(Boolean);
  };
  const get = { ids: list("ids"), statuses: list("status") };
  taskGets.push(get);
  return taskBoard.filter(
    (row) =>
      (get.ids === null || get.ids.includes(row.id)) &&
      (get.statuses === null || get.statuses.includes(row.status)),
  );
}
// Answers for the routes of a page this fixture does not serve (the Skills
// page's reads, task 3484f6c9); undefined passes the request on below. None
// unless a test sets one.
type ExtraApi = (method: string, path: string) => Promise<unknown> | undefined;
let extraApi: ExtraApi | null = null;
export function setExtraApi(next: ExtraApi) {
  extraApi = next;
}
// App's pushes, spied afresh for each test.
let pushState: ReturnType<typeof spyOn<History, "pushState">> | null = null;
export const pushCount = () => pushState?.mock.calls.length ?? 0;

export function setUpInboxTests() {
  setApiShim(async (method, path, body) => {
    const extra = extraApi?.(method, path);
    if (extra !== undefined) return extra;
    if (path === "/api/asks") {
      asksGets.own++;
      return asksGet();
    }
    if (path === "/api/asks/others") {
      asksGets.others++;
      return othersAsksGet();
    }
    const read = /^\/api\/asks\/([0-9a-f]{8,64})$/.exec(path);
    if (method === "GET" && read) {
      askReads.push(read[1]);
      return askRead(read[1]);
    }
    if (method === "POST" && path.startsWith("/api/asks/"))
      return answerPost(path);
    if (method === "POST" && /^\/api\/agents\/[^/]+\/messages$/.test(path)) {
      sentMessages.push({ path, body: body as Record<string, unknown> });
      return messagePost();
    }
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    const pageRead = /^\/api\/pager\/([^/?]+)$/.exec(path);
    if (method === "GET" && pageRead) {
      const id = decodeURIComponent(pageRead[1]);
      pageReads.push(id);
      const askId = pageAsks[id];
      if (askId === undefined)
        throw new ApiError(404, "not_found", "No such page.");
      return { id, askId };
    }
    if (path.startsWith("/api/pager"))
      throw new Error("no client reads the page list (task 74e8fc07)");
    if (path === "/api/apps") return [];
    if (method === "GET" && /^\/api\/tasks(\?|$)/.test(path))
      return readTasks(path);
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
    pageAsks = {};
    pageReads.length = 0;
    extraApi = null;
    asks = ASKS;
    asksGet = ownAsksGet;
    othersAsksGet = noOthersAsks;
    asksGets.own = 0;
    asksGets.others = 0;
    role = "member";
    agents = [agent];
    answerPost = async () => ({});
    askReads.length = 0;
    askRead = askNotFound;
    taskBoard = [];
    taskGets.length = 0;
    resetTaskLookupForTests();
    sentMessages.length = 0;
    messagePost = async () => ({ messageId: "m", queued: false });
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    pushState = spyOn(window.history, "pushState");
  });
  afterEach(() => pushState?.mockRestore());
}

// The office's full_state, as at boot. A second one is a reconnect: it bumps
// hydrationEpoch, and the asks are read again.
export function emitFullState() {
  shimEmit({
    type: "full_state",
    agents,
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
}

// `features` is the office the App runs in: production unless a test passes
// another, as the landing-page embed does.
export async function boot(path = "/", features = PRODUCTION_FEATURES) {
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
        context: { username: "member", userId: "u1", role },
      } as never);
      emitFullState();
      hydrated();
    },
  );
  const view = render(
    createElement(FeaturesProvider, {
      features,
      children: createElement(
        StoreProvider,
        null,
        createElement(
          SceneDecorationContext.Provider,
          { value: false },
          createElement(App),
        ),
      ),
    }),
  );
  await act(async () => {
    await hydration;
  });
  // Let GET /api/asks land.
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
// The Inbox (task 74e8fc07, slice 4): its view, marked data-inbox, holds the
// Asks view and no tab row. `selectedTab` is "asks" while the Inbox shows the
// Asks view, else null; its name is from the time of two tabs.
export const inboxOpen = (view: View) =>
  view.container.querySelector("[data-inbox]") !== null;
export const selectedTab = (view: View): "asks" | null =>
  inboxOpen(view) &&
  view.container.querySelector("[data-inbox] [data-asks-list]") !== null
    ? "asks"
    : null;
// The number in the Inbox entry's title: every open ask it counts.
export const inboxTitleCount = (view: View): number | null => {
  const m = /\d+/.exec(inboxButton(view)?.getAttribute("title") ?? "");
  return m ? Number(m[0]) : null;
};
export const askCards = (view: View) =>
  view.container.querySelectorAll("[data-ask]").length;

export async function go(move: "back" | "forward"): Promise<void> {
  await act(async () => {
    window.history[move]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The Inbox's chat panel (task e3c25581), its agent select, its composer and
// its way to the agent's full chat.
export const chatPanel = (view: View) =>
  view.container.querySelector<HTMLElement>("[data-agent-chat-panel]");
export const chatSelect = (view: View) =>
  chatPanel(view)?.querySelector<HTMLSelectElement>(
    "select[data-agent-chat-select]",
  ) ?? null;
export const chatComposer = (view: View) =>
  chatPanel(view)?.querySelector("textarea") ?? null;
export async function openFullChat(view: View): Promise<void> {
  const button =
    chatPanel(view)?.querySelector<HTMLButtonElement>(
      "button[data-agent-chat-full]",
    ) ?? null;
  expect(button).not.toBeNull();
  await act(async () => fireEvent.click(button!));
}

// Into an agent's full chat from the Asks tab: its name opens the panel, and
// the panel's "Open full chat" the chat.
export async function chatFromInbox(view: View, agentId: string) {
  const name = view.container.querySelector<HTMLButtonElement>(
    `[data-asks-agent="${agentId}"]`,
  );
  expect(name).not.toBeNull();
  await act(async () => fireEvent.click(name!));
  await openFullChat(view);
}

export const officeLink = (view: View, ask: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `[data-ask="${ask}"] [data-ask-office-link]`,
  );
