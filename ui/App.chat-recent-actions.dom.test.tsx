// Recent then complete (task 9ebe887d slice 3), through the real App and store
// over a fake socket: what loads the rest besides the row and the scroll. The
// Copy menu's whole-chat choices wait for the whole chat with a reason on
// screen; an answer's link to an ask card older than the window loads the
// rest and scrolls there; a window that starts on a tool result whose call is
// older shows it alone, then as a whole chat would. A server that keeps the
// connect replay shows no row. The levels: ui/App.chat-recent.dom.test.tsx.
// The Copy menu's reason is [data-chat-rest-note].

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  agentIn,
  boot,
  clickRestRow,
  deliver,
  entry,
  finishOpen,
  ownOpens,
  restLevel,
  setUpLazyChatTests,
  settle,
} = await import("./test-support/lazy-chat-fixture.tsx");
type LogEntry = import("../shared/types.ts").LogEntry;

setUpLazyChatTests();

const A = agentIn("a1", 0, 200);

// The Copy menu's whole-chat choices need the whole chat: opening the menu
// loads the rest, and those choices wait for it with a reason on screen.
// Last exchange needs only the window, when the window holds a message.
const WHOLE_SCOPES = ["messages", "myMessages", "everything"];
function copyMenu(view: { container: HTMLElement }) {
  const triggers = view.container.querySelectorAll<HTMLElement>(
    'button[aria-haspopup="menu"]',
  );
  // Copy is the chat bar's one action with a menu.
  expect(triggers).toHaveLength(1);
  const item = (id: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-nav-menu="copy"] [data-nav-menu-item="${id}"]`,
    );
  const note = () =>
    document.querySelector('[data-nav-menu="copy"] [data-chat-rest-note]');
  // The trigger toggles the menu.
  const close = async () => {
    if (document.querySelector('[data-nav-menu="copy"]'))
      await act(async () => fireEvent.click(triggers[0]));
    await settle();
    expect(document.querySelector('[data-nav-menu="copy"]')).toBeNull();
  };
  const open = async () => {
    if (!document.querySelector('[data-nav-menu="copy"]'))
      await act(async () => fireEvent.click(triggers[0]));
    await settle();
    expect(document.querySelector('[data-nav-menu="copy"]')).not.toBeNull();
  };
  return { item, note, open, close };
}

it("opening the Copy menu of a recent chat loads the rest; the whole-chat choices wait for it with a reason", async () => {
  const { view, socket } = await boot(`/agents/${A.id}`, [A]);
  await finishOpen(socket, ownOpens(socket, A.id)[0], ["x1", "x2"]);
  const menu = copyMenu(view);
  await menu.open();
  expect(ownOpens(socket, A.id)).toHaveLength(2);
  const whole = ownOpens(socket, A.id)[1];
  expect(whole.tail).toBeUndefined();
  // No member message in the window: last exchange waits too.
  for (const id of [...WHOLE_SCOPES, "lastExchange"])
    expect(menu.item(id)?.disabled).toBe(true);
  expect(menu.note()).not.toBeNull();

  await finishOpen(socket, whole, ["x0", "x1", "x2"]);
  await menu.open();
  for (const id of [...WHOLE_SCOPES, "lastExchange"])
    expect(menu.item(id)?.disabled).toBe(false);
  expect(menu.note()).toBeNull();
  // A whole chat's menu loads nothing more.
  await menu.close();
  await menu.open();
  expect(ownOpens(socket, A.id)).toHaveLength(2);
});

it("last exchange is ready at once when the recent window holds a member message", async () => {
  const { view, socket } = await boot(`/agents/${A.id}`, [A]);
  const ask: LogEntry = {
    id: "u1",
    agentId: A.id,
    kind: "user_message",
    content: "a question",
    timestamp: 1_000,
    metadata: { username: "owner" },
  } as LogEntry;
  await finishOpen(socket, ownOpens(socket, A.id)[0], [ask, "x1"]);
  const menu = copyMenu(view);
  await menu.open();
  expect(menu.item("lastExchange")?.disabled).toBe(false);
  for (const id of WHOLE_SCOPES) expect(menu.item(id)?.disabled).toBe(true);
});

// The answer to an ask links to the card that created it. When that card is
// older than the recent window, the link still shows; its click loads the
// rest and scrolls to the card once it is there.
const CREATE =
  "curl -s -X POST \"localhost:4000/api/agents/a1/asks\" -H 'Content-Type: text/plain' --data-binary @- <<'EOF'\nGo?\nEOF";
const askCall: LogEntry = {
  id: "call",
  agentId: A.id,
  timestamp: 1,
  kind: "tool_call",
  content: "Bash",
  metadata: { toolId: "t1", input: { command: CREATE } },
} as LogEntry;
const askResult: LogEntry = {
  id: "result",
  agentId: A.id,
  timestamp: 2,
  kind: "tool_result",
  content: '{"id":"abcd1234","agentId":"a1"}',
  metadata: { toolUseId: "t1" },
} as LogEntry;
const reply: LogEntry = {
  id: "reply",
  agentId: A.id,
  timestamp: 3,
  kind: "user_message",
  content: "yes",
  metadata: { username: "owner", ask: { id: "abcd1234", prompt: "Go?" } },
} as LogEntry;

// Record each scroll to an entry; restore the prototype after.
async function withScrolls(run: (scrolled: string[]) => Promise<void>) {
  const scrolled: string[] = [];
  const proto = HTMLElement.prototype as unknown as {
    scrollIntoView: (this: HTMLElement) => void;
  };
  const before = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  proto.scrollIntoView = function () {
    if (this.dataset.logEntryId) scrolled.push(this.dataset.logEntryId);
  };
  try {
    await run(scrolled);
  } finally {
    if (before) Object.defineProperty(proto, "scrollIntoView", before);
    else delete (proto as { scrollIntoView?: unknown }).scrollIntoView;
  }
}

it("the link of an answer whose ask card is older than the window loads the rest and scrolls to the card", async () => {
  await withScrolls(async (scrolled) => {
    const { view, socket } = await boot(`/agents/${A.id}`, [A]);
    await finishOpen(socket, ownOpens(socket, A.id)[0], [reply]);
    const link = view.container.querySelector<HTMLElement>(
      '[data-log-entry-id="reply"] [data-ask-link="abcd1234"] button',
    );
    expect(link).not.toBeNull();
    await act(async () => fireEvent.click(link!));
    await settle();
    expect(ownOpens(socket, A.id)).toHaveLength(2);
    const whole = ownOpens(socket, A.id)[1];
    expect(whole.tail).toBeUndefined();
    expect(scrolled).toEqual([]);
    await finishOpen(socket, whole, [askCall, askResult, reply]);
    expect(scrolled).toEqual(["call"]);
  });
});

it("a whole load without the ask card drops the jump: a card that comes later is not scrolled to", async () => {
  await withScrolls(async (scrolled) => {
    const { view, socket } = await boot(`/agents/${A.id}`, [A]);
    await finishOpen(socket, ownOpens(socket, A.id)[0], [reply]);
    const link = view.container.querySelector<HTMLElement>(
      '[data-ask-link="abcd1234"] button',
    );
    expect(link).not.toBeNull();
    await act(async () => fireEvent.click(link!));
    await settle();
    await finishOpen(socket, ownOpens(socket, A.id)[1], [reply]);
    for (const e of [askCall, askResult])
      await deliver(socket, { type: "log_entry", entry: e });
    await settle();
    // Enabling condition: the card is on screen now.
    expect(
      view.container.querySelector('[data-log-entry-id="call"]'),
    ).not.toBeNull();
    expect(scrolled).toEqual([]);
  });
});

it("a window that starts on a tool result whose call is older shows the result alone, and the whole chat shows it as it would have from the start", async () => {
  const { view, socket } = await boot(`/agents/${A.id}`, [A]);
  const user: LogEntry = {
    id: "u1",
    agentId: A.id,
    kind: "user_message",
    content: "run it",
    timestamp: 1,
    metadata: { username: "owner" },
  } as LogEntry;
  const call: LogEntry = {
    id: "c1",
    agentId: A.id,
    kind: "tool_call",
    content: "Bash",
    timestamp: 2,
    metadata: { toolId: "t1", input: { command: "echo CALL-INPUT" } },
  } as LogEntry;
  const result: LogEntry = {
    id: "r1",
    agentId: A.id,
    kind: "tool_result",
    content: "RESULT-OUTPUT",
    timestamp: 3,
    metadata: { toolUseId: "t1" },
  } as LogEntry;
  const count = (text: string) =>
    (view.container.querySelector(".chat-messages")?.textContent ?? "").split(
      text,
    ).length - 1;
  await finishOpen(socket, ownOpens(socket, A.id)[0], [result, "x1"]);
  expect(count("RESULT-OUTPUT")).toBe(1);
  expect(count("CALL-INPUT")).toBe(0);

  // Load the rest from the row, and swap in the whole chat.
  const log = view.container.querySelector<HTMLElement>(".chat-messages")!;
  await clickRestRow(log);
  await finishOpen(socket, ownOpens(socket, A.id).at(-1)!, [
    user,
    call,
    result,
    "x1",
  ]);
  expect(restLevel(log)).toBeNull();
  // As a chat loaded whole shows it: the call's card holds its folded result.
  expect(count("CALL-INPUT")).toBe(1);
  expect(count("RESULT-OUTPUT")).toBe(0);
  expect(
    [...log.querySelectorAll("[data-log-entry-id]")].map((e) =>
      e.getAttribute("data-log-entry-id"),
    ),
  ).toEqual(["u1", "c1", "r1", "x1"]);
});

it("with a server that keeps the connect replay, a chat shows no row and every Copy choice is ready", async () => {
  const { view } = await boot(`/agents/${A.id}`, [A], {
    lazy: false,
    replay: [entry("e1", A.id), entry("e2", A.id)],
  });
  const log = view.container.querySelector<HTMLElement>(".chat-messages")!;
  expect(log.textContent).toContain("content-e2");
  expect(restLevel(log)).toBeNull();
  const menu = copyMenu(view);
  await menu.open();
  for (const id of [...WHOLE_SCOPES, "lastExchange"])
    expect(menu.item(id)?.disabled).toBe(false);
  expect(menu.note()).toBeNull();
});
