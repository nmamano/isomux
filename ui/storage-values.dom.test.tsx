// Settings > Housekeeping > Storage, the Backups block (task b30036d9): after
// a save that moved the backup folder, the line that says where the earlier
// backups stay shows that folder as a value (AGENTS.md "UI rules"). A last
// backup that did not copy some members' agent spaces reads as partial, in
// the warning colour, with each member's name as a value (task 43aef77b).
//
// Seam: StoragePane over setApiShim.

import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  asData,
  linesWith,
  sentenceValues,
} from "./test-support/data-values.ts";
import type {
  BackupSettingsRes,
  BackupStatusWire,
  LogRetentionWire,
  StorageUsageWire,
} from "../shared/contract-shapes.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { StoragePane } = await import("./components/StoragePane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { footerButtons } =
  await import("./test-support/save-footer-contract.ts");
const { createElement } = await import("react");

const NOW = Date.now();
const DIR = "/srv/backups-here";
const NEW_DIR = "/srv/backups-moved";

const USAGE: StorageUsageWire = {
  stateRoot: "/home/tester/.isomux",
  stateRootBytes: 0,
  measuredAt: NOW,
  categories: [],
  agents: [],
};
const BACKUP: BackupStatusWire = {
  lastRunAt: NOW - 3_600_000,
  ok: true,
  error: null,
  retention: 7,
  intervalHours: 24,
  destDir: DIR,
  destDirFromEnv: false,
};
const RETENTION: LogRetentionWire = {
  compressAfterDays: 7,
  deleteAfterDays: 90,
  keepPerAgent: 2,
  lastRunAt: null,
  lastRun: null,
  lastError: null,
  running: false,
};

let puts: unknown[] = [];
let backup: BackupStatusWire = BACKUP;
setApiShim(async (method, path, body) => {
  if (method === "GET" && path === "/api/storage/usage") return USAGE;
  if (method === "GET" && path === "/api/backup/status") return backup;
  if (method === "GET" && path === "/api/storage/retention") return RETENTION;
  if (method === "PUT" && path === "/api/backup/settings") {
    puts.push(body);
    return {
      ...BACKUP,
      destDir: NEW_DIR,
      oldBackupsDir: DIR,
    } satisfies BackupSettingsRes;
  }
  throw new Error(`no shim for ${method} ${path}`);
});
afterEach(() => {
  cleanup();
  backup = BACKUP;
});
afterAll(() => setApiShim(null));

// The elements under root drawn in the warning colour.
const WARNING = "var(--orange-text)";
const warned = (root: Element) =>
  [root, ...root.querySelectorAll<HTMLElement>("*")].filter(
    (el) => (el as HTMLElement).style?.color === WARNING,
  );

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

it("after a save moves the backup folder, the earlier folder shows as a value where the earlier backups stay", async () => {
  puts = [];
  const view = render(onLanguage("en", createElement(StoragePane, {})));
  await settle();
  const folder = view.getByTestId("backup-folder") as HTMLInputElement;
  expect(folder.value).toBe(DIR);
  // The control of the partial case below, on the same render: a last
  // backup that copied everyone shows nothing in the warning colour.
  expect(warned(view.container).length).toBe(0);
  fireEvent.change(folder, { target: { value: NEW_DIR } });
  await act(async () => fireEvent.click(footerButtons(document.body).save));
  await settle();
  expect(puts).toEqual([{ dir: NEW_DIR }]);
  expect(sentenceValues(view.container, [DIR], "p")).toEqual(asData([DIR]));
});

it("a last backup that did not copy some members' spaces reads as partial, in the warning colour, each name a value", async () => {
  const names = ["Alice Example", "Bob"];
  backup = { ...BACKUP, membersSkipped: names };
  const view = render(onLanguage("en", createElement(StoragePane, {})));
  await settle();
  expect(sentenceValues(view.container, names, "p")).toEqual(asData(names));
  const [line] = linesWith(view.container, names[0], "p");
  expect(
    warned(line).filter((el) =>
      names.every((name) => (el.textContent ?? "").includes(name)),
    ).length,
  ).toBe(1);
});
