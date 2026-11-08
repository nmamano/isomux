// The background prefetch of a room's chats (task 9ebe887d slice 2), through
// the real App and store over a fake socket: one open_log with the prefetch
// tail at a time, newest last entry first, none while a chat on screen loads,
// and a chat the member opens during a prefetch sends its whole load at once.
// The pure pick is in ui/log-prefetch.test.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  agentIn,
  boot,
  commands,
  deliver,
  openPanel,
  setAskAgents,
  setUpLazyChatTests,
  settle,
} = await import("./test-support/lazy-chat-fixture.tsx");
const { PREFETCH_TAIL } = await import("../shared/log-stream.ts");
const { en } = await import("../shared/i18n/en.ts");
const { saveView } = await import("./view-persistence.ts");
type FakeSocket = import("./test-support/lazy-chat-fixture.tsx").FakeSocket;

setUpLazyChatTests();

// The floor of room r1 on screen, not the lobby a fresh boot opens on.
const onFloor = () =>
  saveView("owner", { roomId: "r1", agentId: null, panel: null, lobby: false });

const OLD = agentIn("a1", 0, 100);
const NEWEST = agentIn("a2", 1, 300);
const MIDDLE = agentIn("a3", 2, 200);
const AGENTS = [OLD, NEWEST, MIDDLE];

const opens = (socket: FakeSocket) => commands(socket, "open_log");
const prefetches = (socket: FakeSocket) =>
  opens(socket).filter((c) => c.tail !== undefined);

async function finish(
  socket: FakeSocket,
  open: { agentId: string; requestId: string; tail?: number },
) {
  await deliver(socket, {
    type: "log_open_done",
    agentId: open.agentId,
    requestId: open.requestId,
    ...(open.tail !== undefined ? { tail: open.tail } : {}),
  });
  await settle();
}

it("prefetches the room's chats one at a time, newest last entry first, with the prefetch tail", async () => {
  onFloor();
  const { socket } = await boot("/", AGENTS);
  for (const next of [NEWEST, MIDDLE, OLD]) {
    const sent = prefetches(socket);
    expect(sent.map((c) => c.agentId).at(-1)).toBe(next.id);
    expect(sent.at(-1)!.tail).toBe(PREFETCH_TAIL);
    // One at a time: nothing else until this one ends.
    await settle();
    expect(opens(socket).at(-1)).toBe(sent.at(-1));
    await finish(socket, sent.at(-1)!);
  }
  expect(prefetches(socket)).toHaveLength(3);
  expect(opens(socket)).toHaveLength(3);
});

it("waits for the chat on screen to load before it prefetches", async () => {
  const { socket } = await boot(`/agents/${OLD.id}`, AGENTS);
  expect(opens(socket)).toHaveLength(1);
  const [own] = opens(socket);
  expect(own.agentId).toBe(OLD.id);
  expect(own.tail).toBeUndefined();
  await settle();
  expect(opens(socket)).toHaveLength(1);

  await finish(socket, own);
  expect(prefetches(socket).map((c) => c.agentId)).toEqual([NEWEST.id]);
});

it("a chat opened during a prefetch sends its whole load at once", async () => {
  setAskAgents([MIDDLE.id]);
  onFloor();
  const { view, socket } = await boot("/", AGENTS);
  // Enabling condition: a prefetch is in flight.
  expect(prefetches(socket).map((c) => c.agentId)).toEqual([NEWEST.id]);

  const inbox = [...view.container.querySelectorAll("button")].find(
    (b) =>
      b.querySelector(".nav-action-label")?.textContent === en["nav.inbox"],
  );
  expect(inbox).toBeDefined();
  await act(async () => fireEvent.click(inbox!));
  await settle();
  await openPanel(view, MIDDLE.id);
  const whole = opens(socket).filter(
    (c) => c.agentId === MIDDLE.id && c.tail === undefined,
  );
  expect(whole).toHaveLength(1);
  // The prefetch was not answered: the open did not wait for it.
  expect(prefetches(socket)).toHaveLength(1);
});
