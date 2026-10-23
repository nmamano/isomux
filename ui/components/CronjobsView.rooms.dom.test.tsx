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
  prompt: "p",
  cwd: "~",
  modelFamily: "opus",
  effort: "medium",
  permissionMode: "bypassPermissions",
} as const;

// Mine, in room A. Someone else's, in room B, as a member of that room gets
// it. Mine with no room.
const cronjobs = [
  {
    ...base,
    id: "mine0001",
    name: "Mine in Alpha",
    roomId: ROOM_A,
    userId: "u1",
    canManage: true,
  },
  {
    ...base,
    id: "view0001",
    name: "Theirs in Beta",
    roomId: ROOM_B,
    canManage: false,
  },
  {
    ...base,
    id: "none0001",
    name: "Mine with no room",
    userId: "u1",
    canManage: true,
  },
] as unknown as CronjobListWire[];

let requests: string[] = [];
setApiShim(async (method, path) => {
  requests.push(`${method} ${path}`);
  if (method === "GET" && path === "/api/cron-runs") return { jobs: [] };
  if (method === "GET" && path === "/api/cronjobs/view0001/runs")
    return { runs: [] };
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  localStorage.clear();
  requests = [];
});

async function mount(currentRoomId: string | null = null, lobbyOpen = false) {
  const view = render(
    onLanguage("en", <CronjobsView onClose={() => {}} />, {
      cronjobs,
      cronjobsLoaded: true,
      cronjobRunsLoaded: true,
      rooms,
      currentRoomId,
      lobbyOpen,
    }),
  );
  await act(async () => {});
  const row = (id: string) =>
    view.container.querySelector<HTMLElement>(`tr[data-cronjob-row="${id}"]`);
  const listed = () =>
    cronjobs.map((c) => c.id).filter((id) => row(id) !== null);
  const filter = () =>
    view.container.querySelector<HTMLSelectElement>(
      "select[data-room-filter]",
    )!;
  return { view, row, listed, filter };
}

it("a room member's row has no run or edit controls and opens the job's runs", async () => {
  const { view, row } = await mount();
  const viewer = row("view0001")!;
  expect(viewer.querySelectorAll("button")).toHaveLength(0);
  expect(row("mine0001")!.querySelectorAll("button").length).toBe(2);
  await act(async () => viewer.click());
  expect(requests).toContain("GET /api/cronjobs/view0001/runs");
  view.unmount();
});

it("filters by room and no room, and the next open starts on the office's room, not the last choice", async () => {
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

  // The next open starts on the room the office shows, not on "none".
  const again = await mount(ROOM_A);
  expect(again.filter().value).toBe(ROOM_A);
  expect(again.listed()).toEqual(["mine0001"]);
  again.view.unmount();
});
