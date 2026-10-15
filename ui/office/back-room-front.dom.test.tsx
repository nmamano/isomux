// The front view with a back room (task 5b503e32): back agents get no desk,
// the header counts only what the front draws, and the trap door carries the
// back room's attention.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, act, shimEmit } = fixture;
// The back room setting is on (task b16f1e6a) unless a case turns it off.
const room = (id: string, backRoom = true) => ({
  ...fixture.room(id),
  backRoom,
});
const { deskOfBackSeat, DESK_COUNT } = await import("../../shared/desks.ts");
const { fireEvent } = fixture;
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const EN = translatorFor("en");
fixture.setupRoomDoorTests({ decorations: false });

function agent(id: string, desk: number, state: string) {
  return {
    id,
    name: id,
    desk,
    roomId: "first",
    cwd: "~",
    state,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    topic: null,
    topicStale: false,
    customInstructions: null,
    customInstructionsVersion: "0",
    permissionMode: "default",
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: "none",
      hat: "none",
    },
  };
}

it("counts front agents in the header and shows back agents only through the trap door", async () => {
  const view = mount([room("first")]);
  await act(async () =>
    shimEmit({
      type: "full_state",
      agents: [
        agent("Front", 0, "waiting_for_response"),
        agent("BackA", deskOfBackSeat({ table: 0, stool: 0 }), "thinking"),
        agent("BackB", deskOfBackSeat({ table: 0, stool: 1 }), "error"),
      ],
      rooms: [room("first")],
      office: { name: "Back room test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  const text = view.container.textContent ?? "";
  // A desk and nameplate only for the front agent; the back agents have none.
  expect(text).toContain("Front");
  expect(text).not.toContain("BackA");
  expect(text).not.toContain("BackB");
  // The header's working and error counts would come only from back agents.
  const count = (n: number, key: Parameters<typeof EN.t>[0]) =>
    new RegExp(`${n}\\s*${EN.t(key as never)}`);
  expect(text).toMatch(count(1, "office.status.waiting"));
  expect(text).not.toMatch(count(1, "office.status.working"));
  // "1 error" shows once: the trap door's badge, not a header count.
  const errorText = EN.t("office.backRoom.error", { count: 1 });
  expect(text.split(errorText)).toHaveLength(2);
  // The trap door shows, with the back room's error.
  const hatch = view.container.querySelector("[data-trap-door]");
  expect(hatch).not.toBeNull();
  expect(hatch?.getAttribute("aria-label")).toContain("2");
});

it("draws no trap door in a room with the back room setting off", async () => {
  const view = mount([room("first", false)]);
  await act(async () =>
    shimEmit({
      type: "full_state",
      agents: [agent("Front", 0, "idle")],
      rooms: [room("first", false)],
      office: { name: "Back room test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  expect(view.container.textContent).toContain("Front");
  expect(view.container.querySelector("[data-trap-door]")).toBeNull();
  // The same room with the setting on draws it.
  await act(async () =>
    shimEmit({
      type: "room_back_room_updated",
      roomId: "first",
      backRoom: true,
    } as never),
  );
  expect(view.container.querySelector("[data-trap-door]")).not.toBeNull();
});

// A door refuses a room it cannot take at once, rather than accepting the
// drop and losing the server's 409: with the setting off, a full front is a
// full room; with it on, the back room still has seats.
it("a door refuses a next room with a full front and the setting off", async () => {
  const moves: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/move")) moves.push(body);
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
  const rooms = [room("first"), room("second", false)];
  const full = Array.from({ length: DESK_COUNT }, (_, d) => ({
    ...agent(`S${d}`, d, "idle"),
    roomId: "second",
  }));
  const view = mount(rooms);
  await act(async () =>
    shimEmit({
      type: "full_state",
      agents: [agent("Mover", 0, "idle"), ...full],
      rooms,
      office: { name: "Back room test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  const drop = async () =>
    act(async () => {
      fireEvent.drop(
        view.container.querySelector('[data-door-drop="right"]')!,
        {
          dataTransfer: { getData: () => "0" },
        },
      );
    });
  await drop();
  expect(moves).toEqual([]);
  // With the setting on, the same full front still takes the agent.
  await act(async () =>
    shimEmit({
      type: "room_back_room_updated",
      roomId: "second",
      backRoom: true,
    } as never),
  );
  await drop();
  expect(moves).toEqual([{ targetRoomId: "second" }]);
});
