// One save footer for Settings > Storage (task f34cd766, after task f0d50877;
// AGENTS.md UI rules: one look per kind of control). Storage had a gray
// "Change backup settings" button that opened a form with its own Save and
// Cancel, and a gray cleanup Save that was enabled with nothing changed. Now
// the backup fields always show, and the one footer saves both blocks: only
// the block that changed is sent, and a block that fails stays unsaved while
// the other's save stands. One leave prompt, in the footer, guards both the
// unsaved edits and a running delete; an exit asked during a delete is
// dropped when the delete ends. The failures and the leave prompt are in
// ui/settings-save-footer.storage-fail.dom.test.tsx.
//
// The fields are found by data-testid (copy is not asserted):
//   backup-interval-hours    number input
//   backup-copies            number input
//   backup-folder            text input, disabled when the env sets it
//   retention-compress-days  number input
//   retention-delete-off     checkbox, checked = automatic deletes off
//   retention-delete-days    number input
// The footer is the f0d50877 contract (ui/test-support/save-footer-contract.ts).
//
// Seam: the Settings page on the storage section, over setApiShim.

import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type {
  BackupStatusWire,
  LogRetentionWire,
} from "../shared/contract-shapes.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent } = await import("@testing-library/react");
const { ApiError, setApiShim } = await import("./api.ts");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const { deferred } = await import("./test-support/held-shape.ts");
const {
  EDITED,
  OPENED,
  SAVED,
  expectFooterPlacement,
  expectSaveCycle,
  footer,
  footerButtons,
  footerState,
  mountSettingsAt,
  settle,
} = await import("./test-support/save-footer-contract.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");

const { t } = translatorFor("en");

afterEach(() => cleanup());
afterAll(() => setApiShim(null));

const OWNER = { ...selfUserRecord(null), id: "owner", name: "Owner" };

const BACKUP: BackupStatusWire = {
  lastRunAt: null,
  ok: false,
  error: null,
  retention: 7,
  intervalHours: 24,
  destDir: "/backups",
  destDirFromEnv: false,
};

const RETENTION: LogRetentionWire = {
  compressAfterDays: 30,
  deleteAfterDays: null,
  keepPerAgent: 2,
  lastRunAt: null,
  lastRun: null,
  lastError: null,
  running: false,
};

const PLAN = {
  target: "transcripts",
  policy: { olderThanDays: 90, keepPerAgent: 5 },
  candidates: [
    {
      path: "agent-1/session.jsonl",
      bytes: 100,
      agentId: "agent-1",
      sessionId: "session",
      ageDays: 100,
      mtimeMs: 0,
    },
  ],
  bytes: 100,
  skipped: [],
};

interface Write {
  method: string;
  path: string;
  body: unknown;
}

// A read answers the value, never ("wait"), or fails ("fail"). A write fails
// with `fail.<block>` as the server's message while it is set.
interface Server {
  backup: BackupStatusWire | "wait" | "fail";
  retention: LogRetentionWire | "wait" | "fail";
  fail: { backup: string | null; retention: string | null };
  // While set, a backup save answers only when it resolves.
  hold?: Promise<void>;
}

function serve(start: Partial<Omit<Server, "fail">> = {}) {
  const server: Server = {
    backup: BACKUP,
    retention: RETENTION,
    ...start,
    fail: { backup: null, retention: null },
  };
  const writes: Write[] = [];
  const apply = deferred<unknown>();
  const read = <T,>(value: T | "wait" | "fail"): Promise<T> =>
    value === "wait"
      ? new Promise<T>(() => {})
      : value === "fail"
        ? Promise.reject(new Error("unreachable"))
        : Promise.resolve(value);
  setApiShim(async (method, path, body) => {
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/storage/usage")
      return {
        stateRoot: "/state",
        measuredAt: Date.now(),
        stateRootBytes: 0,
        categories: [],
        agents: [],
      };
    if (method === "GET" && path === "/api/backup/status")
      return read(server.backup);
    if (method === "GET" && path === "/api/storage/retention")
      return read(server.retention);
    if (method === "POST" && path === "/api/storage/prune") {
      if ((body as { apply?: boolean } | undefined)?.apply)
        return apply.promise;
      return { plan: PLAN, applied: null };
    }
    if (method === "GET") return {};
    writes.push({ method, path, body });
    if (path === "/api/backup/settings") {
      if (server.hold) await server.hold;
      if (server.fail.backup)
        throw new ApiError(400, "invalid_request", server.fail.backup);
      const b = body as {
        intervalHours?: number;
        retention?: number;
        dir?: string | null;
      };
      const was = server.backup as BackupStatusWire;
      const next: BackupStatusWire = {
        ...was,
        ...(b.intervalHours !== undefined
          ? { intervalHours: b.intervalHours }
          : {}),
        ...(b.retention !== undefined ? { retention: b.retention } : {}),
        ...("dir" in b ? { destDir: b.dir ?? "/default-backups" } : {}),
      };
      server.backup = next;
      return {
        ...next,
        oldBackupsDir: next.destDir !== was.destDir ? was.destDir : null,
      };
    }
    if (path === "/api/storage/retention") {
      if (server.fail.retention)
        throw new ApiError(400, "invalid_request", server.fail.retention);
      server.retention = {
        ...(server.retention as LogRetentionWire),
        ...(body as object),
      };
      return server.retention;
    }
    return {};
  });
  return { server, writes, apply };
}

async function mount() {
  const { view } = mountSettingsAt(
    { kind: "section", section: "storage" },
    { users: [OWNER], agents: [] },
  );
  await settle();
  await settle();
  const root = view.container;
  const field = (id: string) =>
    root.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
  const must = (id: string) => {
    const el = field(id);
    if (!el) throw new Error(`no field ${id}`);
    return el;
  };
  const type = async (id: string, value: string) => {
    await act(async () => {
      fireEvent.change(must(id), { target: { value } });
    });
  };
  const click = async (el: HTMLElement) => {
    await act(async () => {
      fireEvent.click(el);
    });
    await settle();
  };
  return {
    view,
    root,
    field,
    must,
    type,
    click,
    save: () => click(footerButtons(root).save),
    cancel: () => click(footerButtons(root).cancel),
    // The footer's error line.
    error: () =>
      footer(root).querySelector('[role="alert"]')?.textContent ?? "",
  };
}

it("opens with nothing to save, one Save in the footer, and the backup fields shown without a click", async () => {
  serve();
  const v = await mount();
  expectFooterPlacement(v.root);
  expect(footerState(v.root)).toEqual(OPENED);
  // No Save of a block's own beside the footer's.
  const ownSaves = [...v.root.querySelectorAll("button")].filter(
    (b) =>
      !b.closest("[data-settings-footer]") &&
      [t("common.save"), t("common.saving"), t("common.saved")].includes(
        b.textContent ?? "",
      ),
  );
  expect(ownSaves.length).toBe(0);
  expect(v.must("backup-interval-hours").value).toBe("24");
  expect(v.must("backup-copies").value).toBe("7");
  expect(v.must("backup-folder").value).toBe("/backups");
  for (const id of ["backup-interval-hours", "backup-copies", "backup-folder"])
    expect({ id, disabled: v.must(id).disabled }).toEqual({
      id,
      disabled: false,
    });
  expect(v.must("retention-compress-days").value).toBe("30");
});

it("Backups: saves, edits and cancels like every part, and sends only the changed field", async () => {
  const { writes } = serve();
  const v = await mount();
  await expectSaveCycle({
    root: v.root,
    value: () => v.must("backup-interval-hours").value,
    edit: (step) => v.type("backup-interval-hours", step === 1 ? "48" : "12"),
  });
  expect(writes).toEqual([
    {
      method: "PUT",
      path: "/api/backup/settings",
      body: { intervalHours: 48 },
    },
  ]);
});

it("Automatic cleanup: saves, edits and cancels like every part, and sends both ages", async () => {
  const { writes } = serve();
  const v = await mount();
  await expectSaveCycle({
    root: v.root,
    value: () => v.must("retention-compress-days").value,
    edit: (step) => v.type("retention-compress-days", step === 1 ? "14" : "3"),
  });
  expect(writes).toEqual([
    {
      method: "PUT",
      path: "/api/storage/retention",
      body: { compressAfterDays: 14, deleteAfterDays: null },
    },
  ]);
});

it("sends the copies and the folder the owner changed, and a cleared folder as null", async () => {
  const { writes } = serve();
  const v = await mount();
  await v.type("backup-copies", "5");
  await v.type("backup-folder", "/mnt/backups");
  await v.save();
  expect(writes.map((w) => w.body)).toEqual([
    { retention: 5, dir: "/mnt/backups" },
  ]);
  expect(footerState(v.root)).toEqual(SAVED);

  await v.type("backup-folder", "");
  await v.save();
  expect(writes.map((w) => w.body)).toEqual([
    { retention: 5, dir: "/mnt/backups" },
    { dir: null },
  ]);
  // The new baseline is the server's answer: the default folder.
  expect(v.must("backup-folder").value).toBe("/default-backups");
  expect(footerState(v.root)).toEqual(SAVED);
});

it("never sends a folder the environment sets", async () => {
  const { writes } = serve({ backup: { ...BACKUP, destDirFromEnv: true } });
  const v = await mount();
  expect(v.must("backup-folder").disabled).toBe(true);
  await v.type("backup-interval-hours", "6");
  await v.save();
  expect(writes.map((w) => w.body)).toEqual([{ intervalHours: 6 }]);
});

it("an edit in each block sends one request per block", async () => {
  const { writes } = serve();
  const v = await mount();
  await v.type("backup-copies", "3");
  await v.click(v.must("retention-delete-off"));
  await v.type("retention-delete-days", "90");
  await v.save();
  expect(
    writes
      .map((w) => [w.method, w.path, w.body])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  ).toEqual([
    ["PUT", "/api/backup/settings", { retention: 3 }],
    [
      "PUT",
      "/api/storage/retention",
      { compressAfterDays: 30, deleteAfterDays: 90 },
    ],
  ]);
  expect(footerState(v.root)).toEqual(SAVED);
});

it("keeps Save disabled while a changed number is out of the server's range", async () => {
  serve();
  const v = await mount();
  const cases: [string, string][] = [
    ["backup-interval-hours", "0"],
    ["backup-interval-hours", "721"],
    ["backup-interval-hours", "1.5"],
    ["backup-interval-hours", ""],
    ["backup-copies", "0"],
    ["backup-copies", "101"],
    ["retention-compress-days", "0"],
    ["retention-compress-days", "3651"],
    ["retention-compress-days", "1.5"],
  ];
  for (const [id, bad] of cases) {
    const was = v.must(id).value;
    await v.type(id, bad);
    expect({ id, bad, ...footerState(v.root) }).toEqual({
      id,
      bad,
      ...EDITED,
      save: "disabled",
    });
    await v.type(id, was);
  }
  // The edges are in range.
  for (const [id, good] of [
    ["backup-interval-hours", "720"],
    ["backup-copies", "100"],
    ["backup-copies", "1"],
  ] as const) {
    const was = v.must(id).value;
    await v.type(id, good);
    expect({ id, good, ...footerState(v.root) }).toEqual({
      id,
      good,
      ...EDITED,
    });
    await v.type(id, was);
  }
  // Deletes turned on with no age.
  await v.click(v.must("retention-delete-off"));
  expect(footerState(v.root)).toEqual({ ...EDITED, save: "disabled" });
});
