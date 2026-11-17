// One save footer for Settings > Storage (task f34cd766, after task f0d50877;
// AGENTS.md UI rules: one look per kind of control). Storage had a gray
// "Change backup settings" button that opened a form with its own Save and
// Cancel, and a gray cleanup Save that was enabled with nothing changed. Now
// the backup fields always show, and the one footer saves both blocks: only
// the block that changed is sent, and a block that fails stays unsaved while
// the other's save stands. One leave prompt, in the footer, guards both the
// unsaved edits and a running delete; an exit asked during a delete is
// dropped when the delete ends.
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

type View = Awaited<ReturnType<typeof mount>>;

/** The sidebar row that reads `label`. */
function sidebarRow(root: HTMLElement, label: string): HTMLButtonElement {
  const row = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label && !b.closest("[data-settings-footer]"),
  );
  if (!row) throw new Error(`no sidebar row ${label}`);
  return row;
}

const leave = (v: View) => v.click(sidebarRow(v.root, t("common.theme")));
const onStorage = (v: View) => v.field("backup-interval-hours") !== null;

/** The buttons of the footer's prompt that read `label`. */
const promptButtons = (v: View, label: string) =>
  [...footer(v.root).querySelectorAll("button")].filter(
    (b) => b.textContent === label,
  );

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

it("a block still loading, or unavailable, does not hold back a save of the other", async () => {
  for (const backup of ["wait", "fail"] as const) {
    const { writes } = serve({ backup });
    const v = await mount();
    const hours = v.field("backup-interval-hours");
    // Loading: drawn disabled; unavailable: not drawn.
    if (backup === "wait") expect(hours?.disabled).toBe(true);
    else expect(hours).toBeNull();
    await v.type("retention-compress-days", "10");
    expect({ backup, ...footerState(v.root) }).toEqual({ backup, ...EDITED });
    await v.save();
    expect({ backup, paths: writes.map((w) => w.path) }).toEqual({
      backup,
      paths: ["/api/storage/retention"],
    });
    v.view.unmount();
  }
  for (const retention of ["wait", "fail"] as const) {
    const { writes } = serve({ retention });
    const v = await mount();
    await v.type("backup-interval-hours", "12");
    expect({ retention, ...footerState(v.root) }).toEqual({
      retention,
      ...EDITED,
    });
    await v.save();
    expect({ retention, paths: writes.map((w) => w.path) }).toEqual({
      retention,
      paths: ["/api/backup/settings"],
    });
    v.view.unmount();
  }
});

it("a block whose save fails stays unsaved with its error in the footer, and the other block's save stands", async () => {
  const { server, writes } = serve();
  server.fail.backup = "backup folder is not writable";
  const v = await mount();
  await v.type("backup-folder", "/readonly");
  await v.type("retention-compress-days", "14");
  await v.save();
  expect(writes.map((w) => w.path).sort()).toEqual([
    "/api/backup/settings",
    "/api/storage/retention",
  ]);
  expect(v.error()).toContain("backup folder is not writable");
  expect(footerState(v.root)).toEqual(EDITED);
  expect(v.must("backup-folder").value).toBe("/readonly");
  expect(v.must("retention-compress-days").value).toBe("14");

  // The next Save sends only the block that is still unsaved.
  server.fail.backup = null;
  await v.save();
  expect(writes.slice(2)).toEqual([
    {
      method: "PUT",
      path: "/api/backup/settings",
      body: { dir: "/readonly" },
    },
  ]);
  expect(v.error()).toBe("");
  expect(footerState(v.root)).toEqual(SAVED);
});

it("Cancel after a partial failure puts back only the block that failed", async () => {
  // Each block in turn fails while the other saves: the page knows it saved.
  for (const failing of ["backup", "retention"] as const) {
    const { server } = serve();
    server.fail[failing] = `${failing} store is locked`;
    const v = await mount();
    await v.type("backup-copies", "4");
    await v.type("retention-compress-days", "9");
    await v.save();
    expect(v.error()).toContain(`${failing} store is locked`);
    await v.cancel();
    expect({
      failing,
      copies: v.must("backup-copies").value,
      compress: v.must("retention-compress-days").value,
      ...footerState(v.root),
    }).toEqual({
      failing,
      copies: failing === "backup" ? "7" : "4",
      compress: failing === "retention" ? "30" : "9",
      ...SAVED,
    });
    v.view.unmount();
  }
});

it("draws both blocks' fields disabled while a save runs", async () => {
  const { server } = serve();
  const v = await mount();
  const held = deferred<void>();
  server.hold = held.promise;
  await v.type("backup-copies", "4");
  await v.save();
  for (const id of [
    "backup-interval-hours",
    "backup-copies",
    "backup-folder",
    "retention-compress-days",
    "retention-delete-off",
  ])
    expect({ id, disabled: v.must(id).disabled }).toEqual({
      id,
      disabled: true,
    });
  await act(async () => held.resolve());
  await settle();
  expect(v.must("backup-copies").disabled).toBe(false);
  expect(v.must("retention-compress-days").disabled).toBe(false);
  expect(footerState(v.root)).toEqual(SAVED);
});

it("both saves failing shows both errors", async () => {
  const { server } = serve();
  server.fail.backup = "backup folder is not writable";
  server.fail.retention = "retention store is locked";
  const v = await mount();
  await v.type("backup-copies", "4");
  await v.type("retention-compress-days", "9");
  await v.save();
  expect(v.error()).toContain("backup folder is not writable");
  expect(v.error()).toContain("retention store is locked");
  expect(footerState(v.root)).toEqual(EDITED);
});

it("leaving with an edit in either block asks in the footer, and Discard leaves", async () => {
  for (const [id, value] of [
    ["backup-interval-hours", "12"],
    ["retention-compress-days", "12"],
  ] as const) {
    serve();
    const v = await mount();
    await v.type(id, value);
    await leave(v);
    expect({ id, stays: onStorage(v) }).toEqual({ id, stays: true });
    expect({
      id,
      discard: promptButtons(v, t("common.discard")).length,
    }).toEqual({ id, discard: 1 });
    // Cancel keeps the edit.
    const cancels = promptButtons(v, t("common.cancel"));
    await v.click(cancels[0]!);
    expect(v.must(id).value).toBe(value);
    expect(promptButtons(v, t("common.discard")).length).toBe(0);

    await leave(v);
    await v.click(promptButtons(v, t("common.discard"))[0]!);
    expect({ id, stays: onStorage(v) }).toEqual({ id, stays: false });
    v.view.unmount();
  }
});

it("leaving with nothing changed does not ask", async () => {
  serve();
  const v = await mount();
  await leave(v);
  expect(onStorage(v)).toBe(false);
});

it("leaving during a delete asks in the footer, and the delete's end drops the exit", async () => {
  const { apply } = serve();
  const v = await mount();
  const content = v.root;
  const button = (match: (text: string) => boolean) => {
    const all = [
      ...content.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((b) => match(b.textContent ?? ""));
    if (all.length !== 1) throw new Error(`expected one button, ${all.length}`);
    return all[0]!;
  };
  await v.click(button((s) => s === t("settings.storage.preview")));
  const deleteCountLead = t("settings.storage.deleteCount", {
    count: 1,
    target: "\u0000",
  }).split("\u0000")[0]!;
  await v.click(button((s) => s.startsWith(deleteCountLead)));
  const confirm = [...content.querySelectorAll<HTMLInputElement>("input")].find(
    (i) => i.placeholder === t("settings.storage.confirmPlaceholder"),
  );
  if (!confirm) throw new Error("no confirm field");
  await act(async () => {
    fireEvent.change(confirm, { target: { value: "DELETE" } });
  });
  await v.click(button((s) => s === t("settings.storage.deletePermanently")));
  // The delete runs.
  expect(button((s) => s === t("settings.storage.deleting")).disabled).toBe(
    true,
  );

  await leave(v);
  expect(onStorage(v)).toBe(true);
  expect(footer(v.root).textContent).toContain(
    t("settings.storage.leaveConfirm"),
  );
  expect(promptButtons(v, t("settings.storage.leave")).length).toBe(1);
  // One prompt on the page.
  expect(
    [...v.root.querySelectorAll("button")].filter(
      (b) => b.textContent === t("settings.storage.leave"),
    ).length,
  ).toBe(1);

  // The delete ends: the prompt closes and the exit asked during it is
  // dropped.
  await act(async () => {
    apply.resolve({
      plan: PLAN,
      applied: { deleted: 1, bytes: 100, refused: [] },
    });
  });
  await settle();
  await settle();
  expect(onStorage(v)).toBe(true);
  expect(promptButtons(v, t("settings.storage.leave")).length).toBe(0);
});
