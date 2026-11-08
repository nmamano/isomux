// Recent then complete (task 9ebe887d slice 3), through the real App and store
// over a fake socket: the levels. A chat opens with its last RECENT_TAIL
// entries and a row above them; the row or a scroll that moves up to the top
// loads the rest at once, and the chat is then whole with no row. After a
// reconnect a whole chat on screen reloads whole; a whole chat off screen
// comes back recent through the prefetch. The Copy menu, the jump and a window
// that starts mid-turn are in ui/App.chat-recent-actions.dom.test.tsx; the
// lane order in office-ws-replay.test.ts; the marks in ui/store.test.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  agentIn,
  boot,
  chatPanel,
  clickRestRow,
  commands,
  deliver,
  entry,
  finishOpen,
  openPanel,
  ownOpens,
  prefetchOpens,
  reconnect,
  restLevel,
  scrollTo,
  setAskAgents,
  setUpLazyChatTests,
  settle,
  switchPanel,
} = await import("./test-support/lazy-chat-fixture.tsx");
const { RECENT_TAIL } = await import("../shared/log-stream.ts");
const { saveView } = await import("./view-persistence.ts");

setUpLazyChatTests();

const A = agentIn("a1", 0, 200);
const B = agentIn("a2", 1, 100);

// Room r1 is the current room and the Inbox is on screen, so the prefetch
// runs (a fresh boot opens on the lobby, where it does not).
const inRoom = () =>
  saveView("owner", {
    roomId: "r1",
    agentId: null,
    panel: "asks",
    lobby: false,
  });

it("a chat opens with its recent entries and the row; the row loads the rest, shows the load, and goes once the chat is whole", async () => {
  setAskAgents([A.id]);
  const { view, socket } = await boot("/inbox/asks", [A]);
  // Enabling condition: no prefetch on the lobby.
  expect(commands(socket, "open_log")).toHaveLength(0);
  await openPanel(view, A.id);
  expect(ownOpens(socket, A.id)).toHaveLength(1);
  const [recent] = ownOpens(socket, A.id);
  expect(recent.tail).toBe(RECENT_TAIL);
  await finishOpen(socket, recent, ["e2", "e3"]);
  expect(chatPanel(view).textContent).toContain("content-e3");
  expect(restLevel(chatPanel(view))).toBe("recent");

  await clickRestRow(chatPanel(view));
  expect(ownOpens(socket, A.id)).toHaveLength(2);
  const whole = ownOpens(socket, A.id)[1];
  expect(whole.tail).toBeUndefined();
  expect(restLevel(chatPanel(view))).toBe("loadingRest");
  expect(chatPanel(view).querySelector("[data-chat-rest] button")).toBeNull();
  // The recent entries stay on screen while the rest loads.
  expect(chatPanel(view).textContent).toContain("content-e3");

  await finishOpen(socket, whole, ["e1", "e2", "e3"]);
  expect(chatPanel(view).textContent).toContain("content-e1");
  expect(restLevel(chatPanel(view))).toBeNull();
  // A whole chat loads nothing more: a scroll to the top sends nothing.
  const log = chatPanel(view).querySelector<HTMLElement>(".app-widget-log")!;
  await scrollTo(log, 400);
  await scrollTo(log, 0);
  expect(ownOpens(socket, A.id)).toHaveLength(2);
});

it("a chat the prefetch loaded opens with no load of its own, and shows the row", async () => {
  inRoom();
  setAskAgents([A.id]);
  const { view, socket } = await boot("/", [A]);
  expect(prefetchOpens(socket).map((c) => c.agentId)).toEqual([A.id]);
  await finishOpen(socket, prefetchOpens(socket)[0], ["e5"]);
  await openPanel(view, A.id);
  expect(ownOpens(socket, A.id)).toHaveLength(0);
  expect(chatPanel(view).textContent).toContain("content-e5");
  expect(restLevel(chatPanel(view))).toBe("recent");
});

it("after a reconnect a whole chat on screen reloads whole, and a whole chat off screen comes back recent", async () => {
  inRoom();
  setAskAgents([A.id, B.id]);
  const { view, socket } = await boot("/", [A, B]);
  // The prefetch loads both, newest first.
  for (const agent of [A, B]) {
    const next = prefetchOpens(socket).at(-1)!;
    expect(next.agentId).toBe(agent.id);
    await finishOpen(socket, next, [`${agent.id}-old`]);
  }
  // Make both chats whole: A, then B, then back to A.
  await openPanel(view, A.id);
  await clickRestRow(chatPanel(view));
  await finishOpen(socket, ownOpens(socket, A.id).at(-1)!, ["a-1", "a-2"]);
  await switchPanel(view, B.id);
  await clickRestRow(chatPanel(view));
  await finishOpen(socket, ownOpens(socket, B.id).at(-1)!, ["b-1", "b-2"]);
  await switchPanel(view, A.id);
  // Enabling condition: both are whole, and coming back sent nothing.
  expect(restLevel(chatPanel(view))).toBeNull();
  expect(ownOpens(socket, A.id)).toHaveLength(1);

  const next = await reconnect(socket, [A, B]);
  expect(ownOpens(next, A.id)).toHaveLength(1);
  const reload = ownOpens(next, A.id)[0];
  expect(reload.tail).toBeUndefined();
  // The whole chat stays on screen meanwhile.
  expect(chatPanel(view).textContent).toContain("content-a-1");
  await finishOpen(next, reload, ["a-1", "a-2"]);
  expect(restLevel(chatPanel(view))).toBeNull();

  // B is off screen: the prefetch reloads its recent entries only.
  expect(prefetchOpens(next).map((c) => c.agentId)).toEqual([B.id]);
  await finishOpen(next, prefetchOpens(next)[0], ["b-2"]);
  await switchPanel(view, B.id);
  expect(ownOpens(next, B.id)).toHaveLength(0);
  expect(restLevel(chatPanel(view))).toBe("recent");
});

it("after a reconnect a recent chat on screen reloads recent, and the row loads the rest while that load runs", async () => {
  setAskAgents([A.id]);
  const { view, socket } = await boot("/inbox/asks", [A]);
  await openPanel(view, A.id);
  await finishOpen(socket, ownOpens(socket, A.id)[0], ["e2"]);

  const next = await reconnect(socket, [A]);
  expect(ownOpens(next, A.id)).toHaveLength(1);
  const reload = ownOpens(next, A.id)[0];
  expect(reload.tail).toBe(RECENT_TAIL);
  expect(chatPanel(view).textContent).toContain("content-e2");
  expect(restLevel(chatPanel(view))).toBe("recent");

  await clickRestRow(chatPanel(view));
  expect(ownOpens(next, A.id)).toHaveLength(2);
  const whole = ownOpens(next, A.id)[1];
  expect(whole.tail).toBeUndefined();
  // The recent reload ends late: it no longer counts.
  await finishOpen(next, reload, ["e2"]);
  expect(restLevel(chatPanel(view))).toBe("loadingRest");
  await finishOpen(next, whole, ["e1", "e2"]);
  expect(chatPanel(view).textContent).toContain("content-e1");
  expect(restLevel(chatPanel(view))).toBeNull();
});

it("a scroll that moves up to the top of a recent chat loads the rest; a move down near the top, or up but not to the top, does not (chat panel)", async () => {
  setAskAgents([A.id]);
  const { view, socket } = await boot("/inbox/asks", [A]);
  await openPanel(view, A.id);
  await finishOpen(socket, ownOpens(socket, A.id)[0], ["e2"]);
  const log = chatPanel(view).querySelector<HTMLElement>(".app-widget-log");
  expect(log).not.toBeNull();
  await scrollTo(log!, 20);
  await scrollTo(log!, 400);
  // A move up that stops above LOAD_REST_TOP_PX.
  await scrollTo(log!, 200);
  expect(ownOpens(socket, A.id)).toHaveLength(1);
  await scrollTo(log!, 30);
  expect(ownOpens(socket, A.id)).toHaveLength(2);
  expect(ownOpens(socket, A.id)[1].tail).toBeUndefined();
});

it("a scroll that moves up to the top of a recent chat loads the rest; a move down near the top, or up but not to the top, does not (chat view)", async () => {
  const { view, socket } = await boot(`/agents/${A.id}`, [A]);
  await finishOpen(socket, ownOpens(socket, A.id)[0], ["e2"]);
  const log = view.container.querySelector<HTMLElement>(".chat-messages");
  expect(log).not.toBeNull();
  expect(restLevel(log!)).toBe("recent");
  await scrollTo(log!, 20);
  await scrollTo(log!, 400);
  // A move up that stops above LOAD_REST_TOP_PX.
  await scrollTo(log!, 200);
  expect(ownOpens(socket, A.id)).toHaveLength(1);
  await scrollTo(log!, 30);
  expect(ownOpens(socket, A.id)).toHaveLength(2);
  expect(ownOpens(socket, A.id)[1].tail).toBeUndefined();
});

// A chat with fewer entries than the tail: the server says the replay began at
// its first entry (whole: true), so the chat is whole, with no row.
it("a chat whose recent load holds its whole log shows no row, and reopens whole after a reconnect", async () => {
  setAskAgents([A.id]);
  const { view, socket } = await boot("/inbox/asks", [A]);
  await openPanel(view, A.id);
  const [recent] = ownOpens(socket, A.id);
  expect(recent.tail).toBe(RECENT_TAIL);
  await deliver(socket, {
    type: "log_entry",
    entry: entry("e1", A.id),
    requestId: recent.requestId,
  });
  await deliver(socket, {
    type: "log_open_done",
    agentId: A.id,
    requestId: recent.requestId,
    tail: recent.tail,
    whole: true,
  });
  await settle();
  expect(chatPanel(view).textContent).toContain("content-e1");
  expect(restLevel(chatPanel(view))).toBeNull();

  const next = await reconnect(socket, [A]);
  expect(ownOpens(next, A.id)).toHaveLength(1);
  expect(ownOpens(next, A.id)[0].tail).toBeUndefined();
});
