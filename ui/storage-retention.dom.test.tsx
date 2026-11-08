// The automatic cleanup block of Settings > Housekeeping > Storage (task
// 3f8db20b): the two ages from GET /api/storage/retention, a Save that sends
// PUT with the delete age as a number or null (Off), and the last run with
// its error.
//
// The controls are found by data-testid (copy is not asserted):
//   retention-compress-days  number input
//   retention-delete-off     checkbox, checked = automatic deletes off
//   retention-delete-days    number input, disabled while deletes are off
//   retention-save           button
//   retention-last-run       shown only when the cleanup ran
//   retention-error          shown only when the last run recorded an error
//
// Seam: StoragePane over setApiShim. One render per test.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type {
  LogRetentionReq,
  LogRetentionWire,
} from "../shared/contract-shapes.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { StoragePane } = await import("./components/StoragePane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

const FRESH: LogRetentionWire = {
  compressAfterDays: 7,
  deleteAfterDays: null,
  keepPerAgent: 2,
  lastRunAt: null,
  lastRun: null,
  lastError: null,
  running: false,
};

let puts: LogRetentionReq[] = [];
let retention: LogRetentionWire = FRESH;

function shim(start: LogRetentionWire) {
  puts = [];
  retention = start;
  setApiShim(async (method, path, body) => {
    if (path === "/api/storage/usage")
      return {
        stateRoot: null,
        stateRootBytes: 0,
        categories: [],
        agents: [],
        measuredAt: Date.now(),
      };
    if (path === "/api/backup/status")
      return {
        lastRunAt: null,
        ok: false,
        error: null,
        retention: 3,
        intervalHours: 24,
        destDir: "/backups",
        destDirFromEnv: false,
      };
    if (path === "/api/storage/retention" && method === "GET") return retention;
    if (path === "/api/storage/retention" && method === "PUT") {
      const req = body as LogRetentionReq;
      puts.push(req);
      retention = { ...retention, ...req };
      return retention;
    }
    throw new Error(`no shim for ${method} ${path}`);
  });
}

afterEach(() => cleanup());
afterAll(() => setApiShim(null));

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(start: LogRetentionWire) {
  shim(start);
  render(onLanguage(null, createElement(StoragePane, {})));
  await settle();
  await settle();
  const body = within(document.body);
  return {
    compress: () =>
      body.getByTestId("retention-compress-days") as HTMLInputElement,
    off: () => body.getByTestId("retention-delete-off") as HTMLInputElement,
    days: () => body.getByTestId("retention-delete-days") as HTMLInputElement,
    save: () => body.getByTestId("retention-save") as HTMLButtonElement,
    query: (id: string) => body.queryByTestId(id),
  };
}

describe("the automatic cleanup block", () => {
  it("shows the stored ages, deletes off", async () => {
    const v = await mount(FRESH);
    expect(v.compress().value).toBe("7");
    expect(v.off().checked).toBe(true);
    expect(v.days().disabled).toBe(true);
    expect(v.query("retention-last-run")).toBeNull();
    expect(v.query("retention-error")).toBeNull();
  });

  it("shows a set delete age", async () => {
    const v = await mount({
      ...FRESH,
      compressAfterDays: 3,
      deleteAfterDays: 90,
    });
    expect(v.compress().value).toBe("3");
    expect(v.off().checked).toBe(false);
    expect(v.days().disabled).toBe(false);
    expect(v.days().value).toBe("90");
  });

  it("saves the compress age with deletes off as null, then a delete age as a number", async () => {
    const v = await mount(FRESH);
    fireEvent.change(v.compress(), { target: { value: "14" } });
    await act(async () => {
      fireEvent.click(v.save());
    });
    await settle();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ compressAfterDays: 14, deleteAfterDays: null });

    fireEvent.click(v.off());
    expect(v.days().disabled).toBe(false);
    fireEvent.change(v.days(), { target: { value: "90" } });
    await act(async () => {
      fireEvent.click(v.save());
    });
    await settle();
    expect(puts).toHaveLength(2);
    expect(puts[1]).toEqual({ compressAfterDays: 14, deleteAfterDays: 90 });

    // And back to off.
    fireEvent.click(v.off());
    await act(async () => {
      fireEvent.click(v.save());
    });
    await settle();
    expect(puts).toHaveLength(3);
    expect(puts[2]).toEqual({ compressAfterDays: 14, deleteAfterDays: null });
  });

  it("does not save an age out of range", async () => {
    const v = await mount({ ...FRESH, deleteAfterDays: 30 });
    for (const [field, value] of [
      ["compress", "0"],
      ["compress", "3651"],
      ["compress", "1.5"],
      ["days", "0"],
      ["days", ""],
    ] as const) {
      fireEvent.change(field === "compress" ? v.compress() : v.days(), {
        target: { value },
      });
      if (field === "compress")
        fireEvent.change(v.days(), { target: { value: "30" } });
      else fireEvent.change(v.compress(), { target: { value: "7" } });
      await act(async () => {
        fireEvent.click(v.save());
      });
      await settle();
      expect({ field, value, puts: puts.length }).toEqual({
        field,
        value,
        puts: 0,
      });
    }
  });

  it("shows the last run, and its error when it had one", async () => {
    const lastRun = {
      compressed: 5,
      compressBytesSaved: 4_000_000,
      transcriptsDeleted: 2,
      filesDeleted: 7,
      bytesDeleted: 9_000_000,
    };
    const v = await mount({
      ...FRESH,
      lastRunAt: Date.now() - 60_000,
      lastRun,
      lastError: "queue file unreadable",
    });
    expect(v.query("retention-last-run")).not.toBeNull();
    const error = v.query("retention-error");
    expect(error).not.toBeNull();
    // Server text, shown as it came.
    expect(error!.textContent).toContain("queue file unreadable");
  });

  it("a run without an error shows no error", async () => {
    const v = await mount({
      ...FRESH,
      lastRunAt: Date.now() - 60_000,
      lastRun: {
        compressed: 1,
        compressBytesSaved: 10,
        transcriptsDeleted: 0,
        filesDeleted: 0,
        bytesDeleted: 0,
      },
    });
    expect(v.query("retention-last-run")).not.toBeNull();
    expect(v.query("retention-error")).toBeNull();
  });
});
