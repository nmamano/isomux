// Run now while the Enterprise Contract lock refuses it (task f1304a60): the
// row does not flash as started, and the refusal shows in the member's
// language until the next click. A Run the server takes flashes as before.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { CronjobsView } = await import("./CronjobsView.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { DispatchCtx } = await import("../store.tsx");
const { sendFailureText } = await import("../send-failure.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;

const { t } = translatorFor("en");

const job = {
  id: "job00001",
  name: "Nightly",
  schedule: { type: "interval", minutes: 60 },
  prompt: "p",
  cwd: "/dir",
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
  nextFireAt: Date.now() + 60_000,
  canManage: true,
} as unknown as CronjobListWire;

const SERVER_TEXT = "This office is marked as an Enterprise office.";
const locked = new ApiError(409, "enterprise_secret_needed", SERVER_TEXT);
let refuse = true;
const runs: string[] = [];
setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/cron-runs") return { jobs: [] };
  if (method === "POST" && path === "/api/cronjobs/job00001/runs") {
    runs.push(path);
    if (refuse) throw locked;
    return { runId: "run00001" };
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));

it("shows the lock instead of a started flash, and a Run the server takes clears it and flashes", async () => {
  const base = stateWithSelfUser("en");
  const view = render(
    <DispatchCtx.Provider value={() => {}}>
      {onLanguage("en", <CronjobsView onClose={() => {}} />, {
        cronjobsLoaded: true,
        cronjobRunsLoaded: true,
        hydrationEpoch: 1,
        sessionContext: { ...base.sessionContext!, role: "owner" },
        cronjobs: [job],
        cronjobRunsByJob: new Map(),
      })}
    </DispatchCtx.Provider>,
  );
  await act(async () => {});
  const button = view.container.querySelector<HTMLButtonElement>(
    `button[title="${t("schedules.runNow")}"]`,
  )!;
  expect(button).not.toBeNull();
  const alert = () =>
    view.container.querySelector("[role=alert]")?.textContent ?? null;
  // The started flash colours the button green (happy-dom mangles the
  // border shorthand, so read the text colour).
  const flashing = () => button.style.color.includes("--green");

  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(runs).toHaveLength(1);
  expect(alert()).toBe(sendFailureText(t, locked));
  expect(alert()).not.toBe(SERVER_TEXT);
  expect(flashing()).toBe(false);

  refuse = false;
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(runs).toHaveLength(2);
  expect(alert()).toBeNull();
  expect(flashing()).toBe(true);
  view.unmount();
});
