// Chats load when they open (task 9ebe887d slice 2), through the real App and
// store over a fake socket. A chat surface (here the Inbox's chat panel, one
// of the three that render a stream) sends one whole open_log, shows the log
// at log_open_done, cancels a load it leaves, and sends nothing when it comes
// back to a complete chat. A new socket re-opens the chat on screen and keeps
// showing it meanwhile. A server that does not load chats on open (its
// full_state does not say logsOnOpen) keeps the connect replay, and the
// client sends no open_log. The prefetch is in ui/App.chat-prefetch.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const {
  agentIn,
  boot,
  commands,
  deliver,
  entry,
  hydrate,
  openPanel,
  setAskAgents,
  setUpLazyChatTests,
  settle,
  sockets,
  switchPanel,
} = await import("./test-support/lazy-chat-fixture.tsx");
const { LOGS_ON_OPEN_WS_PARAM, LOGS_ON_OPEN_WS_VALUE } =
  await import("../shared/log-stream.ts");
const { TASKS_SUMMARY_WS_PARAM, TASKS_SUMMARY_WS_VALUE } =
  await import("../shared/task-board.ts");
type FakeSocket = import("./test-support/lazy-chat-fixture.tsx").FakeSocket;

setUpLazyChatTests();

const A = agentIn("a1", 0);
const B = agentIn("a2", 1);
const panelText = (view: { container: HTMLElement }) =>
  view.container.querySelector("[data-agent-chat-panel]")?.textContent ?? "";
// The chat's own opens: a background prefetch (prefetch: true) may run
// meanwhile. Since slice 3 an own open carries a tail too (the recent
// entries); ui/App.chat-recent.dom.test.tsx pins the levels.
const ownOpens = (socket: FakeSocket, agentId: string) =>
  commands(socket, "open_log").filter(
    (c) => c.agentId === agentId && c.prefetch === undefined,
  );

it("asks the server for chats on open, opens the chat on screen once, shows it at log_open_done, and sends nothing when it comes back", async () => {
  setAskAgents([A.id, B.id]);
  const { view, socket } = await boot("/inbox/asks", [A, B]);
  const url = new URL(socket.url);
  expect(url.searchParams.get(LOGS_ON_OPEN_WS_PARAM)).toBe(
    LOGS_ON_OPEN_WS_VALUE,
  );
  expect(url.searchParams.get(TASKS_SUMMARY_WS_PARAM)).toBe(
    TASKS_SUMMARY_WS_VALUE,
  );

  await openPanel(view, A.id);
  const opens = ownOpens(socket, A.id);
  expect(opens).toHaveLength(1);
  const { requestId } = opens[0];
  expect(typeof requestId).toBe("string");

  for (const id of ["e1", "e2"])
    await deliver(socket, {
      type: "log_entry",
      entry: entry(id, A.id),
      requestId,
    });
  // Buffered until the load ends.
  expect(panelText(view)).not.toContain("content-e1");
  await deliver(socket, { type: "log_open_done", agentId: A.id, requestId });
  await settle();
  expect(panelText(view)).toContain("content-e1");
  expect(panelText(view)).toContain("content-e2");

  await switchPanel(view, B.id);
  await switchPanel(view, A.id);
  expect(ownOpens(socket, A.id)).toHaveLength(1);
  expect(panelText(view)).toContain("content-e2");
});

it("leaving a chat while it loads cancels its load", async () => {
  setAskAgents([A.id, B.id]);
  const { view, socket } = await boot("/inbox/asks", [A, B]);
  await openPanel(view, A.id);
  expect(ownOpens(socket, A.id)).toHaveLength(1);
  const [open] = ownOpens(socket, A.id);
  await switchPanel(view, B.id);
  const closes = commands(socket, "close_log").filter(
    (c) => c.agentId === A.id,
  );
  expect(closes).toHaveLength(1);
  expect(closes[0].requestId).toBe(open.requestId);
  // The chat now on screen loads at once.
  expect(ownOpens(socket, B.id)).toHaveLength(1);
});

it("a new socket re-opens the chat on screen and shows its entries until the new load ends", async () => {
  setAskAgents([A.id]);
  const { view, socket } = await boot("/inbox/asks", [A]);
  await openPanel(view, A.id);
  expect(ownOpens(socket, A.id)).toHaveLength(1);
  const [first] = ownOpens(socket, A.id);
  await deliver(socket, {
    type: "log_entry",
    entry: entry("e1", A.id),
    requestId: first.requestId,
  });
  await deliver(socket, {
    type: "log_open_done",
    agentId: A.id,
    requestId: first.requestId,
  });
  await settle();
  expect(panelText(view)).toContain("content-e1");

  // The link drops; the network comes back.
  await act(async () => {
    socket.readyState = 3;
    socket.onclose?.();
  });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  const next = sockets.at(-1)!;
  // Enabling condition: a second socket.
  expect(next).not.toBe(socket);
  await hydrate(next, [A]);
  const reopen = ownOpens(next, A.id);
  expect(reopen).toHaveLength(1);
  expect(reopen[0].requestId).not.toBe(first.requestId);
  expect(panelText(view)).toContain("content-e1");

  await deliver(next, {
    type: "log_entry",
    entry: entry("e2", A.id),
    requestId: reopen[0].requestId,
  });
  await deliver(next, {
    type: "log_open_done",
    agentId: A.id,
    requestId: reopen[0].requestId,
  });
  await settle();
  // Replaced by the server's log.
  expect(panelText(view)).toContain("content-e2");
  expect(panelText(view)).not.toContain("content-e1");
});

it("with a server that keeps the connect replay, sends no open_log and shows the replay", async () => {
  setAskAgents([A.id]);
  const { view, socket } = await boot("/inbox/asks", [A], {
    lazy: false,
    replay: [entry("old1", A.id)],
  });
  await openPanel(view, A.id);
  expect(commands(socket, "open_log")).toHaveLength(0);
  expect(panelText(view)).toContain("content-old1");
});
