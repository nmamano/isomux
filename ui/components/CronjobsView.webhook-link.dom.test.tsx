// A webhook run on the Schedules page links to the delivery row that started
// it (design section 8).
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { CronjobsView } = await import("./CronjobsView.tsx");
const { setApiShim } = await import("../api.ts");
const { DispatchCtx } = await import("../store.tsx");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { hookWire, deliveryRow, HOOK_ID } =
  await import("../test-support/webhook-fixture.ts");
type AppState = import("../store.tsx").AppState;
type Action = Parameters<typeof import("../store.tsx").reducer>[1];
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;
type CronjobRun = import("../../shared/types.ts").CronjobRun;
type WebhookDelivery = import("../../shared/types.ts").WebhookDelivery;

const ROW_ID = "d_00000002";

const onDemandJob = {
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

const webhookRun = {
  id: "run00001",
  cronjobId: "job00001",
  cronjobName: "PR review",
  trigger: "webhook",
  status: "completed",
  startedAt: Date.now() - 2 * 3_600_000,
  endedAt: Date.now() - 2 * 3_600_000 + 1000,
  errorReason: null,
  promptSnapshot: "Review it.",
  agentTypeSnapshot: "claude",
  modelFamilySnapshot: "opus",
  effortSnapshot: "medium",
  cwdSnapshot: "/repo",
  permissionModeSnapshot: "bypassPermissions",
  rootSessionId: "s1",
  currentSessionId: "s1",
  previewText: "",
  webhook: {
    webhookId: HOOK_ID,
    webhookName: "pr-review",
    deliveryRowId: ROW_ID,
  },
} as unknown as CronjobRun;

let deliveries: WebhookDelivery[] = [];
let deliveryLimits: string[] = [];
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/cron-runs")
    return { jobs: [{ cronjobId: "job00001", runs: [webhookRun] }] };
  if (method === "GET" && path === "/api/cronjobs/job00001/runs/run00001")
    return { run: webhookRun, entries: [] };
  if (method === "GET" && path === "/api/webhooks") return [hookWire()];
  if (
    method === "GET" &&
    path.startsWith(`/api/webhooks/${HOOK_ID}/deliveries`)
  ) {
    deliveryLimits.push(new URLSearchParams(path.split("?")[1]).get("limit")!);
    return { deliveries };
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));
beforeEach(() => {
  deliveries = [];
  deliveryLimits = [];
  localStorage.clear();
});

const recordDispatch = (_action: Action) => {};

function tree(over: Partial<AppState>) {
  const base = stateWithSelfUser("en");
  const state: Partial<AppState> = {
    cronjobs: [onDemandJob],
    cronjobsLoaded: true,
    cronjobRunsByJob: new Map([["job00001", [webhookRun]]]),
    cronjobRunsLoaded: true,
    hydrationEpoch: 1,
    sessionContext: base.sessionContext,
    webhooks: [hookWire()],
    webhooksLoaded: true,
    ...over,
  };
  return (
    <DispatchCtx.Provider value={recordDispatch}>
      {onLanguage("en", <CronjobsView onClose={() => {}} />, state)}
    </DispatchCtx.Provider>
  );
}

it("a webhook run shows the hook glyph, and its link opens the hook at the delivery row", async () => {
  deliveries = [deliveryRow({ id: "d_00000003" }), deliveryRow({ id: ROW_ID })];
  const view = render(tree({}));
  await act(async () => {});
  const row = view.container.querySelector<HTMLElement>(
    'tr[data-cronjob-run-row="run00001"]',
  )!;
  expect(row.querySelector('[data-run-trigger="webhook"] svg')).not.toBeNull();
  await act(async () => row.click());
  const link = view.container.querySelector<HTMLElement>(
    "[data-run-webhook-link]",
  )!;
  expect(link).not.toBeNull();
  await act(async () => link.click());
  // The whole log is asked for, so a row past the first page is found.
  expect(deliveryLimits).toEqual(["500"]);
  const focused = view.container.querySelector<HTMLElement>(
    '[data-focused="true"]',
  )!;
  expect(focused.dataset.deliveryRow).toBe(ROW_ID);
  expect(view.container.querySelector("[data-delivery-missing]")).toBeNull();
  view.unmount();
});

it("a webhook run of a hook the viewer does not manage names it without a link", async () => {
  const view = render(tree({ webhooks: [] }));
  await act(async () => {});
  await act(async () =>
    view.container
      .querySelector<HTMLElement>('tr[data-cronjob-run-row="run00001"]')!
      .click(),
  );
  expect(view.container.querySelector("[data-run-webhook-link]")).toBeNull();
  expect(view.container.textContent).toContain("pr-review");
  view.unmount();
});
