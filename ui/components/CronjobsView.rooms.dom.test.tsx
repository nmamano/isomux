import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { CronjobsView } = await import("./CronjobsView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;
type RoomWire = import("../../shared/types.ts").RoomWire;

const ROOM_A = "a1a1a1a1";
const ROOM_B = "b2b2b2b2";
const rooms = [
  { id: ROOM_A, name: "Alpha" },
  { id: ROOM_B, name: "Beta" },
] as RoomWire[];

const base = {
  schedule: { type: "interval", minutes: 60 },
  enabled: true,
  agentType: "claude",
  createdBy: "Maker",
  userId: "u2",
  username: "Maker",
  createdAt: 0,
  lastFireAt: null,
  nextFireAt: Date.now() + 60_000,
} as const;

// Mine, in room A: the whole record. Someone else's, in room B: the room
// member's projection. Mine with no room.
const cronjobs = [
  {
    ...base,
    id: "mine0001",
    name: "Mine in Alpha",
    roomId: ROOM_A,
    userId: "u1",
    prompt: "p",
    cwd: "~",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    detail: true,
    canManage: true,
  },
  {
    ...base,
    id: "view0001",
    name: "Theirs in Beta",
    roomId: ROOM_B,
    detail: false,
    canManage: false,
    lastRun: { status: "failed", endedAt: 1 },
  },
  {
    ...base,
    id: "none0001",
    name: "Mine with no room",
    userId: "u1",
    prompt: "p",
    cwd: "~",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    detail: true,
    canManage: true,
  },
] as unknown as CronjobListWire[];

setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/cron-runs") return { jobs: [] };
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => localStorage.clear());

async function mount() {
  const view = render(
    onLanguage("en", <CronjobsView onClose={() => {}} />, {
      cronjobs,
      cronjobsLoaded: true,
      cronjobRunsLoaded: true,
      rooms,
    }),
  );
  await act(async () => {});
  await act(async () => view.getByText("schedules").click());
  const row = (id: string) =>
    view.container.querySelector<HTMLElement>(`tr[data-cronjob-row="${id}"]`);
  const listed = () =>
    cronjobs.map((c) => c.id).filter((id) => row(id) !== null);
  const filter = () =>
    view.container.querySelector<HTMLSelectElement>("select[data-room-filter]")!;
  return { view, row, listed, filter };
}

it("a room member's row shows the last run and no run or edit controls", async () => {
  const { view, row } = await mount();
  const viewer = row("view0001")!;
  expect(viewer.querySelectorAll("button")).toHaveLength(0);
  expect(
    viewer.querySelector("[data-cronjob-last-run]")?.getAttribute(
      "data-cronjob-last-run",
    ),
  ).toBe("failed");
  expect(row("mine0001")!.querySelectorAll("button").length).toBe(2);
  view.unmount();
});

it("filters by room, no room, and remembers the choice on this device", async () => {
  const first = await mount();
  expect(first.listed()).toEqual(["mine0001", "view0001", "none0001"]);
  await act(async () => {
    fireEvent.change(first.filter(), { target: { value: ROOM_B } });
  });
  expect(first.listed()).toEqual(["view0001"]);
  await act(async () => {
    fireEvent.change(first.filter(), { target: { value: "none" } });
  });
  expect(first.listed()).toEqual(["none0001"]);
  first.view.unmount();

  const again = await mount();
  expect(again.filter().value).toBe("none");
  expect(again.listed()).toEqual(["none0001"]);
  again.view.unmount();
});

it("a stored room the viewer no longer has falls back to all rooms", async () => {
  localStorage.setItem("isomux-schedules-room-filter", "c3c3c3c3");
  const { view, listed, filter } = await mount();
  expect(filter().value).toBe("all");
  expect(listed()).toHaveLength(3);
  view.unmount();
});
