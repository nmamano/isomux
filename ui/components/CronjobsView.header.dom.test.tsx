// The Automations page (task fe0c21fd): tabs Schedules | Webhooks | Runs, a
// header that stays the same on every tab, each tab's own controls at the top
// of its content, and the room filter on the Webhooks tab too (a hook's room
// is its target's room).
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { CronjobsView } = await import("./CronjobsView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { hookWire } = await import("../test-support/webhook-fixture.ts");
type AppState = import("../store.tsx").AppState;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;
type RoomWire = import("../../shared/types.ts").RoomWire;

const ROOM_A = "a1a1a1a1";
const ROOM_B = "b2b2b2b2";
const rooms = [
  { id: ROOM_A, name: "Alpha" },
  { id: ROOM_B, name: "Beta" },
] as RoomWire[];

const job = {
  id: "job00001",
  name: "Nightly",
  schedule: { type: "none" },
  enabled: true,
  agentType: "claude",
  createdBy: "Tester",
  userId: "u1",
  username: "Tester",
  createdAt: 0,
  lastFireAt: null,
  nextFireAt: null,
  prompt: "p",
  cwd: "~",
  modelFamily: "opus",
  effort: "medium",
  permissionMode: "bypassPermissions",
  roomId: ROOM_B,
  canManage: true,
} as unknown as CronjobListWire;

const bot = { id: "agent-a", name: "Bot", roomId: ROOM_A } as AgentInfo;

// One hook per room, and one whose target this viewer cannot see.
const hookA = hookWire({
  id: "wh_aaaaaaaaaaaaaaaa",
  name: "in-alpha",
  target: { kind: "agent", agentId: bot.id },
});
const hookB = hookWire({
  id: "wh_bbbbbbbbbbbbbbbb",
  name: "in-beta",
  target: { kind: "cronjob", cronjobId: job.id },
});
const hookHidden = hookWire({
  id: "wh_cccccccccccccccc",
  name: "hidden-target",
  target: { kind: "agent", agentId: "agent-gone" },
});
const hooks = [hookA, hookB, hookHidden];

setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/cron-runs") return { jobs: [] };
  if (method === "GET" && path === "/api/webhooks") return hooks;
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));

function tree() {
  const base = stateWithSelfUser("en");
  const state: Partial<AppState> = {
    rooms,
    agents: [bot],
    cronjobs: [job],
    cronjobsLoaded: true,
    cronjobRunsLoaded: true,
    webhooks: hooks,
    webhooksLoaded: true,
    hydrationEpoch: 1,
    sessionContext: base.sessionContext,
  };
  return onLanguage("en", <CronjobsView onClose={() => {}} />, state);
}

type View = ReturnType<typeof render>;
const q = (view: View, selector: string) =>
  view.container.querySelector<HTMLElement>(selector);
const tabs = (view: View) =>
  [
    ...view.container.querySelectorAll<HTMLElement>("[data-schedules-tab]"),
  ].map((tab) => tab.dataset.schedulesTab);
// The header's controls, by what they are, not by their words.
const headerControls = (view: View) =>
  [
    ...q(view, "[data-automations-header]")!.querySelectorAll<HTMLElement>(
      "button, select",
    ),
  ].map(
    (el) =>
      el.dataset.schedulesTab ??
      (el.hasAttribute("data-room-filter") ? "room-filter" : el.tagName),
  );
const toolbar = (view: View) => {
  const bar = q(view, "[data-schedules-toolbar]");
  if (!bar) return null;
  return [...bar.querySelectorAll<HTMLElement>("button")].map((b) =>
    b.hasAttribute("data-schedules-settings")
      ? "settings"
      : b.hasAttribute("data-schedules-new")
        ? "new"
        : "other",
  );
};
const openTab = async (view: View, name: string) =>
  act(async () => q(view, `[data-schedules-tab="${name}"]`)!.click());

it("opens on Schedules, keeps one header on every tab, and puts each tab's controls in its content", async () => {
  const view = render(tree());
  await act(async () => {});
  expect(tabs(view)).toEqual(["cronjobs", "webhooks", "runs"]);
  // The first tab is the one showing.
  expect(q(view, `tr[data-cronjob-row="${job.id}"]`)).not.toBeNull();

  const header = headerControls(view);
  expect(header).toEqual([
    "BUTTON",
    "cronjobs",
    "webhooks",
    "runs",
    "room-filter",
  ]);
  expect(toolbar(view)).toEqual(["settings", "new"]);

  await openTab(view, "webhooks");
  expect(headerControls(view)).toEqual(header);
  expect(toolbar(view)).toEqual(["new"]);

  await openTab(view, "runs");
  expect(headerControls(view)).toEqual(header);
  expect(toolbar(view)).toBeNull();
  view.unmount();
});

it("the room filter narrows the Webhooks tab by the target's room; All keeps a hook whose target is hidden", async () => {
  const view = render(tree());
  await act(async () => {});
  await openTab(view, "webhooks");
  const shown = () =>
    [
      ...view.container.querySelectorAll<HTMLElement>("tr[data-webhook-row]"),
    ].map((row) => row.dataset.webhookRow);
  expect(shown()).toEqual(hooks.map((h) => h.id));
  const filter = q(view, "select[data-room-filter]") as HTMLSelectElement;
  const pick = async (value: string) =>
    act(async () => {
      fireEvent.change(filter, { target: { value } });
    });
  await pick(ROOM_A);
  expect(shown()).toEqual([hookA.id]);
  await pick(ROOM_B);
  expect(shown()).toEqual([hookB.id]);
  await pick("none");
  expect(shown()).toEqual([hookHidden.id]);
  view.unmount();
});
