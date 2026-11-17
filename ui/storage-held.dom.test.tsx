// Settings > Housekeeping > Storage keeps its layout while its three reads
// load (task 3755fad4, the UI rule in AGENTS.md): the usage table with every
// category row, the Backups block and the automatic cleanup form are drawn,
// disabled, before GET /api/storage/usage, /api/backup/status and
// /api/storage/retention answer, so nothing below them moves when they do.
//
// happy-dom lays nothing out: blockShape compares the block and control tree
// drawn while the reads wait with the tree drawn once they answered.
//
// Seam: StoragePane over setApiShim.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  blockShape,
  deferred,
  heldControls,
} from "./test-support/held-shape.ts";
import { IN_ROOT_ORDER, OUT_OF_ROOT_ORDER } from "../shared/storage-labels.ts";
import type {
  BackupStatusWire,
  LogRetentionWire,
  StorageUsageWire,
} from "../shared/contract-shapes.ts";

setUpDomTestFile();

const { act, cleanup, render } = await import("@testing-library/react");
const { StoragePane } = await import("./components/StoragePane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

const NOW = Date.now();

// Every category measured, the backups outside the state root non-empty.
const USAGE: StorageUsageWire = {
  stateRoot: "/home/tester/.isomux",
  stateRootBytes: 11_000_000,
  measuredAt: NOW,
  categories: [...IN_ROOT_ORDER, ...OUT_OF_ROOT_ORDER].map((id) => ({
    id,
    path: `/home/tester/.isomux/${id}`,
    available: true,
    bytes: 1_000_000,
    files: 12,
  })),
  agents: [],
};

const BACKUP: BackupStatusWire = {
  lastRunAt: NOW - 3_600_000,
  ok: true,
  error: null,
  retention: 7,
  intervalHours: 24,
  destDir: "/home/tester/.isomux-backups",
  destDirFromEnv: false,
};

const RAN: LogRetentionWire = {
  compressAfterDays: 7,
  deleteAfterDays: 90,
  keepPerAgent: 2,
  lastRunAt: NOW - 60_000,
  lastRun: {
    compressed: 3,
    compressBytesSaved: 4_000_000,
    transcriptsDeleted: 1,
    filesDeleted: 2,
    bytesDeleted: 9_000_000,
  },
  lastError: null,
  running: false,
};
const NEVER_RAN: LogRetentionWire = { ...RAN, lastRunAt: null, lastRun: null };

// The three reads answer only when `answer` runs; with `now`, at once.
function serve(retention: LogRetentionWire, now = false) {
  const usage = deferred<StorageUsageWire>();
  const backup = deferred<BackupStatusWire>();
  const ret = deferred<LogRetentionWire>();
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/storage/usage")
      return now ? USAGE : usage.promise;
    if (method === "GET" && path === "/api/backup/status")
      return now ? BACKUP : backup.promise;
    if (method === "GET" && path === "/api/storage/retention")
      return now ? retention : ret.promise;
    throw new Error(`no shim for ${method} ${path}`);
  });
  return () => {
    usage.resolve(USAGE);
    backup.resolve(BACKUP);
    ret.resolve(retention);
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  const view = render(onLanguage(null, createElement(StoragePane, {})));
  await settle();
  await settle();
  return view;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());
afterAll(() => setApiShim(null));

const busy = (root: Element) =>
  root.querySelectorAll('[aria-busy="true"]').length;

describe("Storage while its reads load", () => {
  it("draws the layout of the answers on a device that never loaded it", async () => {
    const answer = serve(RAN);
    const view = await mount();
    // The usage table, the backup block and the cleanup form all wait.
    expect(busy(view.container)).toBeGreaterThanOrEqual(3);
    const controls = heldControls(view.container);
    expect(controls.length).toBeGreaterThan(0);
    expect(
      controls.filter((el) => !(el as HTMLInputElement).disabled),
    ).toHaveLength(0);
    // Every category row is drawn, measured or not.
    expect(view.container.querySelectorAll("tr").length).toBeGreaterThanOrEqual(
      IN_ROOT_ORDER.length + OUT_OF_ROOT_ORDER.length,
    );
    const held = blockShape(view.container);

    await act(async () => answer());
    await settle();
    expect(busy(view.container)).toBe(0);
    expect(
      view.container.querySelector('[data-testid="retention-last-run"]'),
    ).not.toBeNull();
    expect(blockShape(view.container)).toBe(held);
  });

  it("holds the cleanup form without a last run when the last answer had none", async () => {
    // A first visit shows an office whose cleanup never ran.
    serve(NEVER_RAN, true);
    (await mount()).unmount();

    const answer = serve(NEVER_RAN);
    const view = await mount();
    expect(busy(view.container)).toBeGreaterThanOrEqual(3);
    const held = blockShape(view.container);

    await act(async () => answer());
    await settle();
    expect(busy(view.container)).toBe(0);
    expect(
      view.container.querySelector('[data-testid="retention-last-run"]'),
    ).toBeNull();
    expect(blockShape(view.container)).toBe(held);
  });
});
