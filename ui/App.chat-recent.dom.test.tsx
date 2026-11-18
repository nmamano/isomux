// Recent then complete (task 9ebe887d slice 3), through the real App and store
// over a fake socket: the levels. A chat opens with its last RECENT_TAIL
// entries and a row above them; the row or a scroll that moves up to the top
// loads the rest at once, and the chat is then whole with no row. After a
// reconnect a whole chat on screen reloads whole; a whole chat off screen
// comes back recent through the prefetch (the reconnect and the scroll are in
// ui/App.chat-recent-reload.dom.test.tsx). The Copy menu, the jump and a window
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
} = await import("./test-support/lazy-chat-fixture.tsx");
const { RECENT_TAIL } = await import("../shared/log-stream.ts");
const { saveView } = await import("./view-persistence.ts");

setUpLazyChatTests();

const A = agentIn("a1", 0, 200);
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
