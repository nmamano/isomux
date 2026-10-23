// A run's failure reason in the reader's language (task ef6b1c31): the runs
// table and the run view show errorReasonMessage worded for the reader, and a
// row written before it existed shows its stored errorReason as it is.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { CronjobsView } = await import("./CronjobsView.tsx");
const { CronjobRunView } = await import("./CronjobRunView.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { msg } = await import("../../shared/i18n/log-message.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;
type CronjobRun = import("../../shared/types.ts").CronjobRun;
type SupportedLanguageCode =
  import("../../shared/languages.ts").SupportedLanguageCode;

const KEY = "systemEntries.scheduleRun.jobDeleted";
const ENGLISH = translatorFor("en").t(KEY);
const CATALAN = translatorFor("ca").t(KEY);
const LEGACY = "server restarted during run";

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

function failedRun(
  id: string,
  reason: Pick<CronjobRun, "errorReason" | "errorReasonMessage">,
): CronjobRun {
  return {
    id,
    cronjobId: job.id,
    cronjobName: job.name,
    trigger: "manual",
    status: "failed",
    startedAt: Date.now() - 3_600_000,
    endedAt: Date.now() - 3_600_000 + 1000,
    promptSnapshot: "p",
    agentTypeSnapshot: "claude",
    modelFamilySnapshot: "opus",
    effortSnapshot: "medium",
    cwdSnapshot: "~",
    permissionModeSnapshot: "bypassPermissions",
    rootSessionId: `sess-${id}`,
    previewText: "",
    ...reason,
  } as unknown as CronjobRun;
}

const worded = failedRun("run00001", {
  errorReason: ENGLISH,
  errorReasonMessage: [msg(KEY)],
});
const legacy = failedRun("run00002", { errorReason: LEGACY });
const runs = [worded, legacy];

setApiShim(async (method, path) => {
  if (method === "GET" && path === "/api/cron-runs")
    return { jobs: [{ cronjobId: job.id, runs }] };
  if (method === "GET") {
    const run = runs.find((r) => path.includes(`/runs/${r.id}`));
    if (run) return { run, entries: [] };
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
afterAll(() => setApiShim(null));

const storeOver = (language: SupportedLanguageCode) => ({
  cronjobs: [job],
  cronjobsLoaded: true,
  cronjobRunsByJob: new Map([[job.id, runs]]),
  cronjobRunsLoaded: true,
  hydrationEpoch: 1,
  sessionContext: stateWithSelfUser(language).sessionContext,
});

async function runsTableRows(language: SupportedLanguageCode) {
  const view = render(
    onLanguage(
      language,
      <CronjobsView onClose={() => {}} />,
      storeOver(language),
    ),
  );
  await act(async () => {});
  await act(async () =>
    view.container
      .querySelector<HTMLElement>('[data-schedules-tab="runs"]')!
      .click(),
  );
  const row = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-cronjob-run-row="${id}"]`)
      ?.textContent ?? "";
  const texts = { worded: row(worded.id), legacy: row(legacy.id) };
  view.unmount();
  return texts;
}

async function runViewText(language: SupportedLanguageCode, run: CronjobRun) {
  const view = render(
    onLanguage(
      language,
      <CronjobRunView jobId={job.id} runId={run.id} onClose={() => {}} />,
      storeOver(language),
    ),
  );
  await act(async () => {});
  const text = view.container.textContent ?? "";
  view.unmount();
  return text;
}

it("the runs table words a reason for the reader and shows an older row's reason as stored", async () => {
  // The ENABLING CONDITION: the reason reads differently in Catalan.
  expect(CATALAN).not.toBe(ENGLISH);
  const english = await runsTableRows("en");
  expect(english.worded).toContain(ENGLISH);
  expect(english.legacy).toContain(LEGACY);

  const catalan = await runsTableRows("ca");
  expect(catalan.worded).toContain(CATALAN);
  expect(catalan.worded).not.toContain(ENGLISH);
  expect(catalan.legacy).toContain(LEGACY);
});

it("the run view words a reason for the reader and shows an older row's reason as stored", async () => {
  expect(CATALAN).not.toBe(ENGLISH);
  expect(await runViewText("en", worded)).toContain(ENGLISH);

  const catalan = await runViewText("ca", worded);
  expect(catalan).toContain(CATALAN);
  expect(catalan).not.toContain(ENGLISH);
  expect(await runViewText("ca", legacy)).toContain(LEGACY);
});
