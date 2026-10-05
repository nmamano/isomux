// "Last run" counts runs of every trigger (PM ruling, webhooks loop S5): an On
// demand job, whose lastFireAt stays null, shows its newest run.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { CronjobsView } = await import("./CronjobsView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;
type CronjobRun = import("../../shared/types.ts").CronjobRun;

const job = {
  id: "job00001",
  name: "PR review",
  schedule: { type: "none" },
  prompt: "Review it.",
  cwd: "/repo",
  agentType: "claude",
  modelFamily: "opus",
  effort: "medium",
  permissionMode: "bypassPermissions",
  enabled: true,
  createdBy: "Tester",
  userId: "u1",
  username: "Tester",
  createdAt: 0,
  lastFireAt: null,
  nextFireAt: null,
  canManage: true,
} as unknown as CronjobListWire;

const run = {
  id: "run00001",
  cronjobId: "job00001",
  cronjobName: "PR review",
  trigger: "manual",
  status: "completed",
  startedAt: Date.now() - 2 * 3_600_000,
  endedAt: Date.now() - 2 * 3_600_000 + 1000,
} as unknown as CronjobRun;

setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/cron-runs")
    return { jobs: [{ cronjobId: "job00001", runs: [run] }] };
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));

it("Last run of an On demand job shows its run, though lastFireAt is null", async () => {
  const base = stateWithSelfUser("en");
  const view = render(
    onLanguage("en", <CronjobsView onClose={() => {}} />, {
      cronjobs: [job],
      cronjobsLoaded: true,
      cronjobRunsByJob: new Map([["job00001", [run]]]),
      cronjobRunsLoaded: true,
      hydrationEpoch: 1,
      sessionContext: base.sessionContext,
    }),
  );
  await act(async () => {});
  await act(async () =>
    view.container
      .querySelector<HTMLElement>('[data-schedules-tab="cronjobs"]')!
      .click(),
  );
  const cell = view.container.querySelector<HTMLElement>(
    '[data-last-run="job00001"]',
  )!;
  expect(cell.textContent.trim()).not.toBe("-");
  expect(cell.textContent.trim()).not.toBe("");
  view.unmount();
});
