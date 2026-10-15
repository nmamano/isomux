// Room tabs and the back room (task f0af4677): a tab click reports itself, so
// the back screen can close onto a front, and during a desk drag each tab
// takes the desk to that room's front or, where its setting is on (task
// b16f1e6a), to its back room.
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, cleanup } =
  await import("@testing-library/react");
const { RoomTabBar } = await import("./RoomTabBar.tsx");
const { StoreProvider, FeaturesProvider } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");
const { setDraggedDesk } = await import("./drag-state.ts");
const { DESK_COUNT, BACK_ROOM_SEATS, firstFreeBackSeat } =
  await import("../../shared/desks.ts");

type RoomWire = import("../../shared/types.ts").RoomWire;
const room = (id: string, backRoom = true): RoomWire => ({
  id,
  name: `Room ${id}`,
  prompt: null,
  canCloseWhenEmpty: false,
  backRoom,
});
const noop = () => {};

function agent(id: string, roomId: string, desk: number) {
  return {
    id,
    name: id,
    desk,
    roomId,
    cwd: "~",
    state: "idle",
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

let moves: { path: string; body: unknown }[] = [];

beforeEach(() => {
  window.localStorage.clear();
  moves = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/move")) moves.push({ path, body });
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
});
afterEach(() => {
  cleanup();
  setDraggedDesk(null);
});
afterAll(() => {
  setApiShim(null);
  setShim(noop);
  connect(noop, noop);
});

function mount(agents: ReturnType<typeof agent>[], onSelectRoom = noop) {
  setShim(noop);
  const view = render(
    <StoreProvider>
      <LanguageProvider>
        <FeaturesProvider features={PRODUCTION_FEATURES}>
          <RoomTabBar onSelectRoom={onSelectRoom} />
        </FeaturesProvider>
      </LanguageProvider>
    </StoreProvider>,
  );
  act(() =>
    shimEmit({
      type: "full_state",
      agents,
      // Room d has its back room setting off.
      rooms: [room("a"), room("b"), room("c"), room("d", false)],
      office: { name: "Tab test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  return view;
}

const startDeskDrag = (desk: number) =>
  act(() => {
    setDraggedDesk(desk);
    document.dispatchEvent(new Event("dragstart"));
  });

const target = (view: ReturnType<typeof mount>, key: string) =>
  view.container.querySelector(`[data-desk-drop="${key}"]`)!;

it("reports every tab click, the open room's included", () => {
  let selected = 0;
  const view = mount([], () => selected++);
  const tab = (name: string) =>
    [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === name,
    )!;
  expect(
    view.container.querySelector("[data-active-room-tab]")?.textContent,
  ).toContain("Room a");
  fireEvent.click(tab("Room a"));
  fireEvent.click(tab("Room b"));
  expect(selected).toBe(2);
});

it("offers each room's back room only while a desk is dragged", () => {
  const view = mount([agent("x", "a", 2)]);
  expect(view.container.querySelector("[data-desk-drop]")).toBeNull();
  startDeskDrag(2);
  for (const id of ["a", "b", "c"])
    expect(target(view, `${id}:back`)).not.toBeNull();
});

it("offers no back room target for a room with the setting off", () => {
  const view = mount([agent("x", "a", 2)]);
  startDeskDrag(2);
  expect(target(view, "d:front")).not.toBeNull();
  expect(target(view, "c:back")).not.toBeNull();
  expect(view.container.querySelector('[data-desk-drop="d:back"]')).toBeNull();
});

it("moves a dropped desk to a room's first free front desk or its back room", () => {
  const view = mount([agent("x", "a", 2), agent("y", "b", 0)]);
  startDeskDrag(2);
  fireEvent.drop(target(view, "b:front"));
  startDeskDrag(2);
  fireEvent.drop(target(view, "c:back"));
  startDeskDrag(2);
  fireEvent.drop(target(view, "a:back"));
  expect(moves).toEqual([
    { path: "/api/agents/x/move", body: { targetRoomId: "b", desk: 1 } },
    { path: "/api/agents/x/move", body: { targetRoomId: "c", desk: null } },
    { path: "/api/agents/x/move", body: { targetRoomId: "a", desk: null } },
  ]);
});

it("takes no drop on a full area or on the desk's own front", () => {
  const fullFront = Array.from({ length: DESK_COUNT }, (_, d) =>
    agent(`b${d}`, "b", d),
  );
  const taken: number[] = [];
  const fullBack = Array.from({ length: BACK_ROOM_SEATS }, (_, i) => {
    const seat = firstFreeBackSeat(taken)!;
    taken.push(seat);
    return agent(`c${i}`, "c", seat);
  });
  const view = mount([agent("x", "a", 2), ...fullFront, ...fullBack]);
  for (const key of ["b:front", "c:back", "a:front"]) {
    startDeskDrag(2);
    fireEvent.drop(target(view, key));
  }
  expect(moves).toEqual([]);
});
