// A sent message is on screen once, never twice (task 1ea5abb4). The server's
// queue frame (busy agent) or echo (idle agent) names the send attempt, and
// usually reaches the browser before the HTTP answer. The store drops the
// "Sending" row on that frame, so the row and the queued chip (or the chat
// bubble) are never on screen together, and never both gone. The frames go
// through the real StoreProvider connect handler, outside act(), the way a
// WebSocket delivers them; every commit of the chat is recorded. The server
// half is in server/test-support/send-attempt-id.test.ts.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

setUpDomTestFile();

const { act, render, waitFor } = await import("@testing-library/react");
const { Profiler } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { StoreProvider, useAppState } = await import("../store.tsx");
const { setShim, shimEmit } = await import("../ws.ts");
const { ApiError } = await import("../api.ts");
const {
  outboxFixture: fx,
  setupOutboxTests,
  rows,
  type,
  send,
} = await import("../test-support/outbox-fixture.tsx");
setupOutboxTests();
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type QueuedMessage = import("../../shared/types.ts").QueuedMessage;
type ServerMessage = import("../../shared/types.ts").ServerMessage;

const AGENT_ID = "a1";
// One word, so each place that shows the message holds it in one text node.
const TOKEN = "zqmsg7731";
const OTHER = "zqother4410";

function agentIn(state: string, queue: QueuedMessage[] = []): AgentInfo {
  return {
    id: AGENT_ID,
    name: "Tester",
    desk: 0,
    roomId: "r1",
    cwd: "~",
    state,
    agentType: "claude",
    modelFamily: "opus",
    topic: null,
    queue,
    capabilities: DEFAULT_AGENT_CAPABILITIES,
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
}

function fullState(agent: AgentInfo): ServerMessage {
  return {
    type: "full_state",
    agents: [agent],
    rooms: [{ id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true }],
    office: {},
    recentCwds: [],
    killedAgents: [],
    interactions: [],
  } as unknown as ServerMessage;
}

function queued(
  text: string,
  clientMessageId: string | undefined,
): QueuedMessage {
  return {
    id: `q-${text}`,
    sender: { kind: "user", username: "ricky" },
    text,
    queuedAt: Date.now(),
    ...(clientMessageId ? { clientMessageId } : {}),
  } as QueuedMessage;
}

// Where the message text shows: in an outbox row, or anywhere else in the chat
// (the queued chip or the bubble). The composer and the pinned bar are not
// counted.
type Placement = { row: number; other: number };
function placement(container: HTMLElement, text = TOKEN): Placement {
  const out = { row: 0, other: 0 };
  const walk = (node: Node, inRow: boolean) => {
    if (node.nodeType === 3) {
      if ((node.textContent ?? "").includes(text)) {
        if (inRow) out.row++;
        else out.other++;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (el.tagName === "TEXTAREA") return;
    // The pinned bar repeats the last user message when no bubble is in view.
    // happy-dom has no layout, so it always shows there; it is not a second
    // copy of the message in a browser.
    if (el.getAttribute("title") === text) return;
    const row = inRow || el.hasAttribute("data-outbox-attempt");
    for (const child of el.childNodes) walk(child, row);
  };
  walk(container, false);
  return out;
}

// Every commit of the chat, as the placement of the message right after it.
const commits: Placement[] = [];
let host: HTMLElement | null = null;

function Chat() {
  const state = useAppState();
  const agent = state.agents.find((a) => a.id === AGENT_ID);
  if (!agent) return null;
  return (
    <Profiler
      id="chat"
      onRender={() => {
        if (host) commits.push(placement(host));
      }}
    >
      <LogView
        agent={agent}
        logs={state.logs.get(AGENT_ID) ?? []}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </Profiler>
  );
}

async function boot(state: string) {
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: { username: "ricky", userId: "u1", role: "owner" },
      } as never);
      shimEmit(fullState(agentIn(state)));
    },
  );
  const view = render(
    <StoreProvider>
      <Chat />
    </StoreProvider>,
  );
  host = view.container;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return view;
}

// Deliver a frame the way the socket does: from a plain task, not inside
// act(), so React schedules the updates as it does in the browser.
async function frame(msg: ServerMessage) {
  const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const before = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    setTimeout(() => shimEmit(msg), 0);
    for (let i = 0; i < 10; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    globals.IS_REACT_ACT_ENVIRONMENT = before;
  }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

// Every commit since the frame shows the message exactly once, and the last
// one shows it outside the outbox.
function expectShownOnceThroughout() {
  expect(commits.length).toBeGreaterThan(0);
  for (const c of commits) expect(c.row + c.other).toBe(1);
  expect(commits.at(-1)).toEqual({ row: 0, other: 1 });
}

it("a busy agent's queue frame replaces the Sending row in one commit, and the late answer changes nothing", async () => {
  let answered = false;
  let release: () => void = () => {};
  fx.answer = () =>
    new Promise((resolve) => {
      release = () => {
        answered = true;
        resolve({});
      };
    });
  const view = await boot("thinking");
  await type(view.container, TOKEN);
  await send(view.container);
  expect(rows(view.container, "pending")).toHaveLength(1);
  expect(placement(view.container)).toEqual({ row: 1, other: 0 });
  const id = fx.posts[0].clientMessageId;

  commits.length = 0;
  await frame({
    type: "agent_updated",
    agentId: AGENT_ID,
    changes: { queue: [queued(TOKEN, id)] },
  } as ServerMessage);
  // The HTTP answer is still open: only the frame can have done this.
  expect(answered).toBe(false);
  expectShownOnceThroughout();

  await act(async () => release());
  await settle();
  expect(answered).toBe(true);
  expect(rows(view.container)).toHaveLength(0);
  expect(placement(view.container)).toEqual({ row: 0, other: 1 });
  view.unmount();
});

it("an idle agent's echo replaces the Sending row in one commit, and a late refusal adds no failed row", async () => {
  let refused = false;
  let refuse: () => void = () => {};
  fx.answer = () =>
    new Promise((_resolve, reject) => {
      refuse = () => {
        refused = true;
        reject(new ApiError(500, "persist_failed", "persist_failed"));
      };
    });
  const view = await boot("waiting_for_response");
  await type(view.container, TOKEN);
  await send(view.container);
  expect(placement(view.container)).toEqual({ row: 1, other: 0 });
  const id = fx.posts[0].clientMessageId;

  commits.length = 0;
  await frame({
    type: "log_entry",
    entry: {
      id: "e-echo",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      kind: "user_message",
      content: TOKEN,
      metadata: { username: "ricky", clientMessageId: id },
    },
  } as ServerMessage);
  expect(refused).toBe(false);
  expectShownOnceThroughout();

  await act(async () => refuse());
  await settle();
  expect(refused).toBe(true);
  expect(rows(view.container)).toHaveLength(0);
  expect(placement(view.container)).toEqual({ row: 0, other: 1 });
  view.unmount();
});

it("a frame for another attempt leaves the Sending row alone", async () => {
  fx.answer = () => new Promise(() => {});
  const view = await boot("thinking");
  await type(view.container, TOKEN);
  await send(view.container);
  expect(rows(view.container, "pending")).toHaveLength(1);

  await frame({
    type: "agent_updated",
    agentId: AGENT_ID,
    changes: {
      queue: [queued(OTHER, "someone-elses-attempt"), queued("zqplain", "")],
    },
  } as ServerMessage);
  // The other items show, and this attempt is still sending.
  expect(placement(view.container, OTHER)).toEqual({ row: 0, other: 1 });
  expect(rows(view.container, "pending")).toHaveLength(1);
  expect(placement(view.container)).toEqual({ row: 1, other: 0 });
  view.unmount();
});

// The answer was lost, so the attempt shows as failed; the reconnect's
// full_state shows the message queued on the server. It landed: the failed row
// goes, or the message shows twice until the member discards it.
it("a reconnect's full_state that holds the attempt drops its failed row", async () => {
  fx.answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = await boot("thinking");
  await type(view.container, TOKEN);
  await send(view.container);
  await waitFor(() => expect(rows(view.container, "failed")).toHaveLength(1));
  const id = fx.posts[0].clientMessageId;

  await frame(fullState(agentIn("thinking", [queued(TOKEN, id)])));
  await settle();
  expect(rows(view.container)).toHaveLength(0);
  expect(placement(view.container)).toEqual({ row: 0, other: 1 });
  view.unmount();
});

// After a reload a failed row comes back from storage; the chat-open replay
// then holds the message, which the server echoed or flushed.
it("a chat-open replay entry that names the attempt drops its failed row", async () => {
  fx.answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = await boot("waiting_for_response");
  await type(view.container, TOKEN);
  await send(view.container);
  await waitFor(() => expect(rows(view.container, "failed")).toHaveLength(1));
  const id = fx.posts[0].clientMessageId;

  await frame({
    type: "log_entry",
    requestId: "open-1",
    entry: {
      id: "e-replayed",
      agentId: AGENT_ID,
      timestamp: Date.now(),
      kind: "user_message",
      content: TOKEN,
      metadata: { username: "ricky", clientMessageId: id },
    },
  } as ServerMessage);
  await settle();
  expect(rows(view.container)).toHaveLength(0);
  view.unmount();
});
