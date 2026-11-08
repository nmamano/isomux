// The real App and store over a fake WebSocket, for the tests of chats that
// load when they open (task 9ebe887d slice 2): ui/App.chat-on-open.dom.test.tsx
// and ui/App.chat-prefetch.dom.test.tsx. Not the WS shim: the shim has no
// socket generation and no URL, and these tests read both. Each socket the
// client opens is recorded with its URL and every command it sent. Import it
// with `await import(...)` after setUpDomTestFile(), like every DOM module.

import { afterAll, beforeEach } from "bun:test";
import { stubGlobal } from "./dom.ts";
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("../App.tsx");
const { SceneDecorationContext } =
  await import("../office/scene-decoration.tsx");
const { FeaturesProvider, StoreProvider } = await import("../store.tsx");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");
const { setApiShim } = await import("../api.ts");
const { connect, setShim } = await import("../ws.ts");
const { resetAgentLogForTests } = await import("../agent-log.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type LogEntry = import("../../shared/types.ts").LogEntry;

export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: unknown }) => void;
  onclose?: (e?: unknown) => void;
  onerror?: () => void;
  constructor(public url: string) {
    sockets.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
}
export const sockets: FakeSocket[] = [];

// The asks GET /api/asks returns: one per agent a test names, so the Inbox
// lists the agent and its name opens the chat panel (AgentChatPanel).
let askAgents: string[] = [];
export function setAskAgents(agentIds: string[]) {
  askAgents = agentIds;
}

export function agentIn(
  id: string,
  desk: number,
  lastEntryAt?: number,
): AgentInfo {
  return {
    id,
    name: `Agent ${id}`,
    desk,
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
    ...(lastEntryAt !== undefined ? { lastEntryAt } : {}),
  } as unknown as AgentInfo;
}

export function entry(id: string, agentId: string): LogEntry {
  return {
    id,
    agentId,
    kind: "text",
    content: `content-${id}`,
    timestamp: 1_000,
  } as LogEntry;
}

export function setUpLazyChatTests() {
  stubGlobal("WebSocket", FakeSocket);
  setApiShim(async (_method, path) => {
    if (path === "/api/asks")
      return askAgents.map((agentId, i) => ({
        id: `ask${i}`,
        agentId,
        memberUserId: "u1",
        prompt: `Question from ${agentId}?`,
        createdAt: 1_000,
        updatedAt: 1_000,
      }));
    if (path === "/api/asks/others") return [];
    if (path === "/api/apps") return [];
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    if (path.startsWith("/api/tasks")) return [];
    return {};
  });
  // Out of shim mode: StoreProvider's connect() opens a (fake) socket.
  setShim(null);
  beforeEach(() => {
    sockets.length = 0;
    askAgents = [];
    resetAgentLogForTests();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
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
}

export async function settle() {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

export async function deliver(socket: FakeSocket, msg: unknown) {
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify(msg) });
  });
}

// Open the socket and hydrate it as the server does: session_context, then
// full_state (logsOnOpen when the server loads chats on open), then the
// connect replay's fence, which a lazy server sends empty.
export async function hydrate(
  socket: FakeSocket,
  agents: AgentInfo[],
  lazy = true,
  replay: LogEntry[] = [],
) {
  await act(async () => {
    socket.readyState = 1;
    socket.onopen?.();
  });
  await deliver(socket, {
    type: "session_context",
    context: { username: "owner", userId: "u1", role: "owner" },
  });
  await deliver(socket, {
    type: "full_state",
    agents,
    rooms: [
      { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
    ],
    office: { name: "Test Office" },
    recentCwds: [],
    killedAgents: [],
    interactions: [],
    ...(lazy ? { logsOnOpen: true } : {}),
  });
  for (const e of replay)
    await deliver(socket, { type: "log_entry", entry: e });
  await deliver(socket, { type: "log_replay_complete" });
  await settle();
}

export async function boot(
  path: string,
  agents: AgentInfo[],
  opts: { lazy?: boolean; replay?: LogEntry[] } = {},
) {
  window.history.replaceState(null, "", path);
  const view = render(
    createElement(FeaturesProvider, {
      features: PRODUCTION_FEATURES,
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
  await settle();
  const socket = sockets.at(-1);
  if (!socket) throw new Error("the store opened no socket");
  await hydrate(socket, agents, opts.lazy ?? true, opts.replay ?? []);
  return { view, socket };
}

export const commands = (socket: FakeSocket, type: string) =>
  socket.sent.filter((c) => c.type === type) as (Record<string, unknown> & {
    agentId: string;
    requestId: string;
    tail?: number;
  })[];

// The Inbox's chat panel: an ask's agent name opens it, its select moves it
// to another agent, its close button shuts it.
export async function openPanel(
  view: { container: HTMLElement },
  agentId: string,
) {
  const name = view.container.querySelector<HTMLButtonElement>(
    `[data-asks-agent="${agentId}"]`,
  );
  if (!name) throw new Error(`no ask from ${agentId} in the Inbox`);
  await act(async () => fireEvent.click(name));
  await settle();
}
export async function switchPanel(
  view: { container: HTMLElement },
  agentId: string,
) {
  const select = view.container.querySelector<HTMLSelectElement>(
    "[data-agent-chat-panel] select[data-agent-chat-select]",
  );
  if (!select) throw new Error("no chat panel select");
  await act(async () =>
    fireEvent.change(select, { target: { value: agentId } }),
  );
  await settle();
}
